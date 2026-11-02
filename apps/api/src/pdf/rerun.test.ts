// The output gate re-run in the worker (UNTRUSTED-PDF-GATE): every copy an engine returns is checked
// again, outside the engine, before it can be stored. The lift test (test/pdf/gate-rerun.test.ts)
// runs it over both transports and against the database.
import { describe, expect, it, vi } from 'vitest';
import { linesPdf } from '../../test/pdf/fixtures.js';
import type { Redact } from './regenerate.js';
import { RERUN_REFUSAL, withGateRerun } from './rerun.js';

const engine =
  (result: Awaited<ReturnType<Redact>>): Redact =>
  () =>
    Promise.resolve(result);

describe('withGateRerun', () => {
  it('refuses a copy that still holds a marked passage, with a fixed reason', async () => {
    const leaky = await linesPdf(['Rides: call Kestrel Ambry.']);
    const result = await withGateRerun(engine({ kind: 'redacted', pdf: leaky, boxes: [] }))(leaky, { quotes: ['Kestrel Ambry'], redactsAny: true });
    expect(result).toEqual({ kind: 'refused', reason: RERUN_REFUSAL });
    expect(RERUN_REFUSAL).toBe('the output gate, re-run in the worker, found withheld text in the copy');
  });

  it('passes a clean copy as the engine returned it', async () => {
    const clean = await linesPdf(['Picnic flyer']);
    const made = { kind: 'redacted' as const, pdf: clean, boxes: [] };
    expect(await withGateRerun(engine(made))(clean, { quotes: ['Kestrel Ambry'], redactsAny: true })).toBe(made);
  });

  it('checks the quotes as the engine reads them: trimmed, blank ones dropped', async () => {
    const gate = vi.fn<(pdf: Uint8Array, quotes: readonly string[]) => Promise<string | null>>(() => Promise.resolve(null));
    await withGateRerun(engine({ kind: 'redacted', pdf: Uint8Array.from([1]), boxes: [] }), gate)(Uint8Array.from([1]), { quotes: ['  Kestrel ', '', '  ', 'Kestrel'], redactsAny: true });
    expect(gate).toHaveBeenCalledWith(Uint8Array.from([1]), ['Kestrel']);
  });

  it('refuses, with the same reason, when the gate itself fails', async () => {
    const gate = (): Promise<string | null> => Promise.reject(new Error('pdf.js threw on Kestrel Ambry'));
    expect(await withGateRerun(engine({ kind: 'redacted', pdf: Uint8Array.from([1]), boxes: [] }), gate)(Uint8Array.from([1]), { quotes: ['Kestrel Ambry'], redactsAny: true })).toEqual({
      kind: 'refused',
      reason: RERUN_REFUSAL,
    });
  });

  it('passes a refusal, an original and an engine failure on untouched', async () => {
    const gate = vi.fn(() => Promise.resolve('found'));
    const request = { quotes: ['Kestrel'], redactsAny: true };
    expect(await withGateRerun(engine({ kind: 'refused', reason: 'page 1 is a scan' }), gate)(Uint8Array.from([1]), request)).toEqual({ kind: 'refused', reason: 'page 1 is a scan' });
    expect(await withGateRerun(engine({ kind: 'original' }), gate)(Uint8Array.from([1]), request)).toEqual({ kind: 'original' });
    await expect(withGateRerun(() => Promise.reject(new Error('down')), gate)(Uint8Array.from([1]), request)).rejects.toThrow('down');
    expect(gate).not.toHaveBeenCalled();
  });
});
