// ============================================================================
// REDACT R3b: the background job that makes the redacted copies (store.ts,
// 0015_pdf_store.sql). Never run on a read: the output gate can take seconds.
//
// One run claims one queued file with a lease, works out every audience's
// inputs, and makes a copy for each distinct input that has none yet (one
// shared copy per input). A refusal is stored with its reason, for officers;
// so is an engine failure, and an engine that hands back the original for an
// audience that redacts (fail closed). Finishing marks stale the copies no
// audience uses, keeps those the ledger records as served (0018: a past row is
// checked against its own bytes) and drops the rest. Runs are safe to race: a file is claimed by one run at a time, a copy
// is written once per input, a run whose lease ran out can no longer write,
// and a file queued again mid-run stays queued for the next run.
//
// UNTRUSTED-PDF-GATE: an engine or gate that cannot be reached at all (a
// sidecar's socket missing, the sidecar dead or answering garbage,
// socket-engine.ts, socket-gate.ts) is not an answer about the file. It
// throws a RetryableEngineError, which the run does not store: no copy is
// put, the file stays queued, and the next run after the lease takes it again
// (startRegenerator's onError logs the code). Retries end (fix round 1, S1):
// a retryable failure on a file's MAX_ENGINE_ATTEMPTS-th attempt stores the
// copies refused with a fixed reason (GAVE_UP) and finishes the file. The
// count is in the database (0021, fix round 3, S2): pdf_regen_claim counts
// every claim, before any engine reads the file, so neither a worker restart
// nor a run that never finishes (a check child of the worker's uid can kill
// the worker in the in-pod mode) starts it again. A file claimed more than
// MAX_ENGINE_ATTEMPTS times without finishing is given up on as soon as it
// is claimed, without asking the engine again. Finishing sets it back.
//
// LINKS L3: a copy is put with the ids of the links it holds (the engine's
// "kept", checked by the gate, 0025). The worker's boot sweep (sweepCopies)
// queues every file with a stored original that has no copy for an
// audience's current input hash: an ENGINE_VERSION bump or a new LINK_ORIGIN
// changes every hash, and no trigger queues a file for either. A refused copy
// counts as made, so it is not queued again at every boot.
// ============================================================================
import type { Db } from '../db/pool.js';
import { AUDIENCES } from '../redaction/policy.js';
import { type RedactRequest, type RedactResult, redactPdf } from './redact.js';
import { linkOrigin } from './link-annots.js';
import { ENGINE_VERSION, inputsFor } from './store.js';
import { recordClaimedFile } from '../ledger/ledger.js';

type Query = Pick<Db, 'query'>;

export type Redact = (original: Uint8Array, request: RedactRequest) => Promise<RedactResult>;

/** The engine could not be asked (UNTRUSTED-PDF-GATE): the run stores nothing for the file and fails, and the file is retried. */
export class RetryableEngineError extends Error {
  override readonly name = 'RetryableEngineError';
  readonly code = 'PDF_ENGINE_UNAVAILABLE';
}

/** A file whose engine could not be reached this many times running is given refused copies. */
export const MAX_ENGINE_ATTEMPTS = 5;
export const GAVE_UP = `the engine could not be reached in ${MAX_ENGINE_ATTEMPTS} attempts`;

export interface RegenerateOptions {
  redact?: Redact;
  /** How long a run holds its file before another run may take it over. */
  leaseSeconds?: number;
  /** What the copies' links point to (LINK_ORIGIN's, or the site's, when absent). */
  origin?: string;
}

interface Made {
  pdf: Buffer | null;
  reason: string | null;
  /** The ids of the links the copy holds (none for a refusal). */
  kept: string[];
}

/** A copy's bytes and the links it holds, or why there is none. */
async function make(redact: Redact, original: Uint8Array, request: RedactRequest): Promise<Made> {
  try {
    const result = await redact(original, request);
    if (result.kind === 'redacted') return { pdf: Buffer.from(result.pdf), reason: null, kept: result.kept ?? [] };
    if (result.kind === 'refused') return { pdf: null, reason: result.reason, kept: [] };
    return { pdf: null, reason: 'the engine returned the original for an audience that redacts', kept: [] };
  } catch (error) {
    if (error instanceof RetryableEngineError) throw error;
    return { pdf: null, reason: `the engine failed: ${error instanceof Error ? error.message : String(error)}`, kept: [] };
  }
}

/** Each copy the file's audiences are given now, by its input hash (hex): one per distinct inputs. */
async function currentCopies(db: Query, fileId: string, origin: string): Promise<Map<string, { hash: Buffer; request: RedactRequest }>> {
  const targets = new Map<string, { hash: Buffer; request: RedactRequest }>();
  for (const audience of AUDIENCES) {
    const inputs = await inputsFor(db, fileId, audience, undefined, origin);
    if (inputs?.kind === 'copy') targets.set(inputs.hash.toString('hex'), inputs);
  }
  return targets;
}

/**
 * The boot sweep: queues (pdf_regen_request_files, 0025) every file with a stored original that has no copy, made or
 * refused, for one of its audiences' current input hashes, and returns them. A file with only originals or hidden
 * audiences needs no copy.
 */
export async function sweepCopies(db: Query, options: { origin?: string } = {}): Promise<string[]> {
  const origin = options.origin ?? linkOrigin();
  const files = await db.query<{ file_id: string }>(`SELECT file_id FROM pdf_original ORDER BY file_id`);
  const lacking: string[] = [];
  for (const { file_id: fileId } of files.rows) {
    const targets = await currentCopies(db, fileId, origin);
    if (targets.size === 0) continue;
    const made = await db.query<{ input_hash: Buffer }>(`SELECT input_hash FROM pdf_copy WHERE file_id = $1 AND input_hash = ANY($2::bytea[])`, [fileId, [...targets.values()].map((target) => target.hash)]);
    if (made.rows.length < targets.size) lacking.push(fileId);
  }
  // At most 10000 a call (0025).
  for (let at = 0; at < lacking.length; at += 10_000) await db.query(`SELECT pdf_regen_request_files($1::uuid[])`, [lacking.slice(at, at + 10_000)]);
  return lacking;
}

/** One run: null when nothing is queued; `done` is false when the run lost its claim or the file was queued again meanwhile. */
export async function regenerateOne(db: Query, options: RegenerateOptions = {}): Promise<{ fileId: string; done: boolean } | null> {
  const redact = options.redact ?? redactPdf;
  const claimed = await db.query<{ file_id: string; claim: string; attempts: number }>(`SELECT file_id, claim, attempts FROM pdf_regen_claim($1)`, [options.leaseSeconds ?? 600]);
  const row = claimed.rows[0];
  if (row === undefined) return null;
  // attempts counts this claim too (0021).
  const { file_id: fileId, claim, attempts } = row;
  const targets = await currentCopies(db, fileId, options.origin ?? linkOrigin());
  const existing = await db.query<{ input_hash: Buffer }>(`SELECT input_hash FROM pdf_copy WHERE file_id = $1`, [fileId]);
  const made = new Set(existing.rows.map((copy) => copy.input_hash.toString('hex')));
  const missing = [...targets].filter(([hex]) => !made.has(hex)).map(([, target]) => target);
  try {
    if (missing.length > 0) {
      const original = await db.query<{ bytes: Buffer }>(`SELECT pdf_regen_original($1, $2) AS bytes`, [fileId, claim]);
      const bytes = new Uint8Array((original.rows[0] as { bytes: Buffer }).bytes);
      for (const target of missing) {
        let copy: Made = { pdf: null, reason: GAVE_UP, kept: [] };
        // Past the cap, earlier runs died before they finished: the engine is not asked again.
        if (attempts <= MAX_ENGINE_ATTEMPTS) {
          try {
            copy = await make(redact, bytes, target.request);
          } catch (error) {
            if (attempts < MAX_ENGINE_ATTEMPTS) throw error;
          }
        }
        await db.query(`SELECT pdf_copy_put($1, $2, $3, $4, $5, $6, $7)`, [fileId, claim, target.hash, ENGINE_VERSION, copy.pdf, copy.reason, copy.kept]);
      }
    }
    // The ledger records what each audience is given now (R-LEDGER), under the claim, and the run
    // finishes in the same transaction (0019: the worker appends only for the file it holds).
    const done = await recordClaimedFile(db, fileId, claim, async (client) => {
      const finished = await client.query<{ done: boolean }>(`SELECT pdf_regen_finish($1, $2, $3::bytea[]) AS done`, [
        fileId,
        claim,
        [...targets.values()].map((target) => target.hash),
      ]);
      return finished.rows[0]?.done === true;
    });
    return { fileId, done };
  } catch (error) {
    // The lease ran out and another run holds the file now.
    if ((error as { code?: string }).code === '42501') return { fileId, done: false };
    throw error;
  }
}

/** Runs until nothing is queued (at most `max` runs); returns how many ran. */
export async function drain(db: Query, options: RegenerateOptions & { max?: number } = {}): Promise<number> {
  let runs = 0;
  while (runs < (options.max ?? 1000) && (await regenerateOne(db, options)) !== null) runs++;
  return runs;
}

/** Drains the queue every `intervalMs` until stopped, after `before` once. `onError` hears a failed drain; the next one still runs. */
export function startRegenerator(
  options: RegenerateOptions & { db: Query; intervalMs?: number; onError?: (error: unknown) => void; before?: () => Promise<unknown> },
): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 5_000;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  // Run once, before the first drain (the worker's boot sweep); a failure is heard and the drain still runs.
  let first = options.before;
  const schedule = (): void => {
    timer = setTimeout(tick, interval);
    timer.unref();
  };
  function tick(): void {
    const before = first;
    first = undefined;
    current = (before === undefined ? Promise.resolve() : before().then(() => undefined, (error: unknown) => options.onError?.(error))).then(() => drain(options.db, options)).then(
      () => undefined,
      (error: unknown) => options.onError?.(error),
    );
    void current.then(() => {
      if (!stopped) schedule();
    });
  }
  schedule();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await current;
    },
  };
}
