// The output gate re-run (UNTRUSTED-PDF-GATE): every copy an engine returns is checked again outside
// the engine and outside the worker (the gate sidecar, or the in-pod capped child), and stored only
// on a pass naming the copy's own sha256. The lift test (test/pdf/gate-rerun.test.ts) runs it over
// both transports and against the database.
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './engine-protocol.js';
import { RetryableEngineError, type Redact } from './regenerate.js';
import { type Gate, RERUN_REASONS, RERUN_REFUSAL, withGateRerun } from './rerun.js';

const COPY = Uint8Array.from([1, 2, 3]);
const SHA = sha256Hex(COPY);
const made = { kind: 'redacted' as const, pdf: COPY, boxes: [] };
const engine =
  (result: Awaited<ReturnType<Redact>>): Redact =>
  () =>
    Promise.resolve(result);
const answering =
  (outcome: Awaited<ReturnType<Gate>>): Gate =>
  () =>
    Promise.resolve(outcome);
const REQUEST = { quotes: ['Kestrel Ambry'], redactsAny: true };
// The gate's own writing of the copy (gate-rules.ts gateReply): the only bytes that may be stored (M1).
const WRITTEN = Uint8Array.from([4, 5, 6, 7]);
const CHECKED = { pdf: WRITTEN, sha256: sha256Hex(WRITTEN) };
const PASS = { verdict: { pass: true as const }, sha256: SHA, checked: CHECKED };

describe('withGateRerun', () => {
  it('on a pass naming the copy\'s own sha256, hands on the bytes the gate checked in place of the engine\'s (M1)', async () => {
    expect(await withGateRerun(engine(made), answering(PASS))(COPY, REQUEST)).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [] });
  });

  it('refuses a pass naming other bytes, or none (the gate checked something else)', async () => {
    for (const sha256 of [sha256Hex(Buffer.from('another copy')), null]) {
      expect(await withGateRerun(engine(made), answering({ ...PASS, sha256 }))(COPY, REQUEST), String(sha256)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
    }
  });

  it('refuses a pass with no checked bytes, or bytes that are not the ones its sha256 names (M1)', async () => {
    expect(await withGateRerun(engine(made), answering({ verdict: { pass: true }, sha256: SHA }))(COPY, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
    const swapped = { ...PASS, checked: { pdf: Uint8Array.from([9]), sha256: CHECKED.sha256 } };
    expect(await withGateRerun(engine(made), answering(swapped))(COPY, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.mismatch });
  });

  it('refuses each refusal with its own fixed reason, which quotes nothing from the copy or the gate', async () => {
    for (const code of ['withheld', 'rules', 'unfinished', 'mismatch'] as const) {
      expect(await withGateRerun(engine(made), answering({ verdict: { pass: false, code }, sha256: SHA }))(COPY, REQUEST), code).toEqual({ kind: 'refused', reason: RERUN_REASONS[code] });
      expect(RERUN_REASONS[code]).not.toMatch(/Kestrel|Ambry/);
    }
    expect(RERUN_REFUSAL).toBe(RERUN_REASONS.withheld);
    expect(RERUN_REASONS).toEqual({
      withheld: 'the output gate, re-run outside the engine, found withheld text in the copy or could not read all of it',
      rules: 'the output gate, re-run outside the engine, found active content, an attached file or a picture its policy forbids in the copy',
      unfinished: 'the output gate, re-run outside the engine, could not finish checking the copy',
      mismatch: 'the output gate checked other bytes than the copy',
    });
  });

  it('asks the gate with the copy, its sha256, the original (for its pictures), the image action and the quotes as the engine reads them', async () => {
    const gate = vi.fn<Gate>(() => Promise.resolve(PASS));
    const original = Uint8Array.from([8, 8]);
    await withGateRerun(engine(made), gate)(original, { quotes: ['  Kestrel ', '', '  ', 'Kestrel'], redactsAny: true, image: 'blur' });
    expect(gate).toHaveBeenCalledWith({ copy: COPY, original, quotes: ['Kestrel'], image: 'blur', sha256: SHA });
    await withGateRerun(engine(made), gate)(original, { quotes: [], redactsAny: true });
    // No quotes still means a check: the copy's structure and pictures (S3); "show" when no image action.
    expect(gate).toHaveBeenLastCalledWith({ copy: COPY, original, quotes: [], image: 'show', sha256: SHA });
  });

  it('lets a gate that cannot be asked fail the job retryably, and refuses on any other failure', async () => {
    const down: Gate = () => Promise.reject(new RetryableEngineError('the gate socket is missing'));
    await expect(withGateRerun(engine(made), down)(COPY, REQUEST)).rejects.toBeInstanceOf(RetryableEngineError);
    const broken: Gate = () => Promise.reject(new Error('Kestrel Ambry broke it'));
    expect(await withGateRerun(engine(made), broken)(COPY, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
  });

  it('passes a refusal, an original and an engine failure on untouched, without asking the gate', async () => {
    const gate = vi.fn<Gate>(() => Promise.resolve({ verdict: { pass: false, code: 'withheld' }, sha256: SHA }));
    expect(await withGateRerun(engine({ kind: 'refused', reason: 'page 1 is a scan' }), gate)(COPY, REQUEST)).toEqual({ kind: 'refused', reason: 'page 1 is a scan' });
    expect(await withGateRerun(engine({ kind: 'original' }), gate)(COPY, REQUEST)).toEqual({ kind: 'original' });
    await expect(withGateRerun(() => Promise.reject(new Error('down')), gate)(COPY, REQUEST)).rejects.toThrow('down');
    expect(gate).not.toHaveBeenCalled();
  });

  it('by default asks the in-pod capped child, which gives no pass when it cannot run (dist/pdf/gate-child.js is absent here)', async () => {
    expect(await withGateRerun(engine(made))(COPY, REQUEST)).toEqual({ kind: 'refused', reason: RERUN_REASONS.unfinished });
  });
});
