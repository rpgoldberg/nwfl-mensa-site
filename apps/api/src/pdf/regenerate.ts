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
// ============================================================================
import type { Db } from '../db/pool.js';
import { AUDIENCES } from '../redaction/policy.js';
import { type RedactRequest, type RedactResult, redactPdf } from './redact.js';
import { ENGINE_VERSION, inputsFor } from './store.js';
import { recordFiles } from '../ledger/ledger.js';

type Query = Pick<Db, 'query'>;

export type Redact = (original: Uint8Array, request: RedactRequest) => Promise<RedactResult>;

export interface RegenerateOptions {
  redact?: Redact;
  /** How long a run holds its file before another run may take it over. */
  leaseSeconds?: number;
}

/** A copy's bytes, or why there is none. */
async function make(redact: Redact, original: Uint8Array, request: RedactRequest): Promise<{ pdf: Buffer | null; reason: string | null }> {
  try {
    const result = await redact(original, request);
    if (result.kind === 'redacted') return { pdf: Buffer.from(result.pdf), reason: null };
    if (result.kind === 'refused') return { pdf: null, reason: result.reason };
    return { pdf: null, reason: 'the engine returned the original for an audience that redacts' };
  } catch (error) {
    return { pdf: null, reason: `the engine failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One run: null when nothing is queued; `done` is false when the run lost its claim or the file was queued again meanwhile. */
export async function regenerateOne(db: Query, options: RegenerateOptions = {}): Promise<{ fileId: string; done: boolean } | null> {
  const redact = options.redact ?? redactPdf;
  const claimed = await db.query<{ file_id: string; claim: string }>(`SELECT file_id, claim FROM pdf_regen_claim($1)`, [options.leaseSeconds ?? 600]);
  const row = claimed.rows[0];
  if (row === undefined) return null;
  const { file_id: fileId, claim } = row;
  const targets = new Map<string, { hash: Buffer; request: RedactRequest }>();
  for (const audience of AUDIENCES) {
    const inputs = await inputsFor(db, fileId, audience);
    if (inputs?.kind === 'copy') targets.set(inputs.hash.toString('hex'), inputs);
  }
  const existing = await db.query<{ input_hash: Buffer }>(`SELECT input_hash FROM pdf_copy WHERE file_id = $1`, [fileId]);
  const made = new Set(existing.rows.map((copy) => copy.input_hash.toString('hex')));
  const missing = [...targets].filter(([hex]) => !made.has(hex)).map(([, target]) => target);
  try {
    if (missing.length > 0) {
      const original = await db.query<{ bytes: Buffer }>(`SELECT pdf_regen_original($1, $2) AS bytes`, [fileId, claim]);
      const bytes = new Uint8Array((original.rows[0] as { bytes: Buffer }).bytes);
      for (const target of missing) {
        const copy = await make(redact, bytes, target.request);
        await db.query(`SELECT pdf_copy_put($1, $2, $3, $4, $5, $6)`, [fileId, claim, target.hash, ENGINE_VERSION, copy.pdf, copy.reason]);
      }
    }
  } catch (error) {
    // The lease ran out and another run holds the file now.
    if ((error as { code?: string }).code === '42501') return { fileId, done: false };
    throw error;
  }
  const finished = await db.query<{ done: boolean }>(`SELECT pdf_regen_finish($1, $2, $3::bytea[]) AS done`, [
    fileId,
    claim,
    [...targets.values()].map((target) => target.hash),
  ]);
  const done = finished.rows[0]?.done === true;
  // Its copies are current: the ledger records what each audience is given now (R-LEDGER).
  if (done) await recordFiles(db, [fileId]);
  return { fileId, done };
}

/** Runs until nothing is queued (at most `max` runs); returns how many ran. */
export async function drain(db: Query, options: RegenerateOptions & { max?: number } = {}): Promise<number> {
  let runs = 0;
  while (runs < (options.max ?? 1000) && (await regenerateOne(db, options)) !== null) runs++;
  return runs;
}

/** Drains the queue every `intervalMs` until stopped. `onError` hears a failed drain; the next one still runs. */
export function startRegenerator(
  options: RegenerateOptions & { db: Query; intervalMs?: number; onError?: (error: unknown) => void },
): { stop(): Promise<void> } {
  const interval = options.intervalMs ?? 5_000;
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    timer = setTimeout(tick, interval);
    timer.unref();
  };
  function tick(): void {
    current = drain(options.db, options).then(
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
