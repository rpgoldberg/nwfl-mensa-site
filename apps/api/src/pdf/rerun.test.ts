// The output gate re-run (UNTRUSTED-PDF-GATE): every copy an engine returns is checked again outside
// the engine and outside the worker (the gate sidecar, or the in-pod capped child), and stored only
// on a pass naming the copy's own sha256. The lift test (test/pdf/gate-rerun.test.ts) runs it over
// both transports and against the database.
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './engine-protocol.js';
import { RetryableEngineError, type Redact } from './regenerate.js';
import { type Gate, LINKED_ENGINE_FAILED, RERUN_REASONS, RERUN_REFUSAL, withGateRerun, withLinkFallback } from './rerun.js';

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
    expect(gate).toHaveBeenCalledWith({ copy: COPY, original, quotes: ['Kestrel'], image: 'blur', sha256: SHA, links: [], kept: [] });
    await withGateRerun(engine(made), gate)(original, { quotes: [], redactsAny: true });
    // No quotes still means a check: the copy's structure and pictures (S3); "show" when no image action.
    expect(gate).toHaveBeenLastCalledWith({ copy: COPY, original, quotes: [], image: 'show', sha256: SHA, links: [], kept: [] });
  });

  it('asks the gate with the links and their origin (LINKS L3) and the ids the engine kept, and keeps the kept ids on a pass', async () => {
    const gate = vi.fn<Gate>(() => Promise.resolve(PASS));
    const links = [{ id: 'a'.repeat(26), page: 1, rect: [1, 2, 3, 4] as const, label: 'Link to site.example' }, { id: 'b'.repeat(26), page: 2, rect: [1, 2, 3, 4] as const, label: 'Link to site.example' }];
    const request = { ...REQUEST, origin: 'https://nwflorida.us', links };
    expect(await withGateRerun(engine({ ...made, kept: ['b'.repeat(26)] }), gate)(COPY, request)).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [], kept: ['b'.repeat(26)] });
    expect(gate).toHaveBeenCalledWith({ copy: COPY, original: COPY, quotes: ['Kestrel Ambry'], image: 'show', sha256: SHA, origin: 'https://nwflorida.us', links, kept: ['b'.repeat(26)] });
  });

  it('refuses, without asking the gate, an engine that says it kept a link it was not given, or one twice', async () => {
    const gate = vi.fn<Gate>(() => Promise.resolve(PASS));
    const links = [{ id: 'a'.repeat(26), page: 1, rect: [1, 2, 3, 4] as const, label: 'Link to site.example' }];
    const request = { ...REQUEST, origin: 'https://nwflorida.us', links };
    for (const kept of [['c'.repeat(26)], ['a'.repeat(26), 'a'.repeat(26)]]) {
      expect(await withGateRerun(engine({ ...made, kept }), gate)(COPY, request), kept.join()).toEqual({ kind: 'refused', reason: RERUN_REASONS.rules });
    }
    expect(gate).not.toHaveBeenCalled();
  });

  describe('links fail safe (LINKS L3 fix 1, N9): a copy refused with its links is made again with none', () => {
    const LINKS = [{ id: 'a'.repeat(26), page: 1, rect: [1, 2, 3, 4] as const, label: 'Link to site.example' }];
    const LINKED = { ...REQUEST, origin: 'https://nwflorida.us', links: LINKS };
    /** An engine that answers `withLinks` when it is given links and `without` when it is given none, and records each request. */
    const twoWay = (withLinks: Awaited<ReturnType<Redact>>, without: Awaited<ReturnType<Redact>>) => vi.fn<Redact>((_original, request) => Promise.resolve((request.links ?? []).length > 0 ? withLinks : without));

    it('stores the copy with no links when the gate refuses the one with them, and names why, for the logs', async () => {
      const redact = twoWay({ ...made, kept: ['a'.repeat(26)] }, { ...made, kept: [] });
      const gate = vi.fn<Gate>((job) => Promise.resolve((job.kept ?? []).length > 0 ? { verdict: { pass: false, code: 'rules' }, sha256: SHA } : PASS));
      expect(await withGateRerun(redact, gate)(COPY, LINKED)).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [], kept: [], linksDropped: RERUN_REASONS.rules });
      expect(redact).toHaveBeenCalledTimes(2);
      expect(redact.mock.calls[1]?.[1]).toEqual({ ...LINKED, links: [] });
      expect(gate).toHaveBeenLastCalledWith(expect.objectContaining({ links: [], kept: [] }));
    });

    it('stores the copy with no links when the engine refuses the one with them, or keeps a link it was not given', async () => {
      const refused = twoWay({ kind: 'refused', reason: 'the links could not be written' }, made);
      expect(await withGateRerun(refused, answering(PASS))(COPY, LINKED)).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [], linksDropped: 'the links could not be written' });
      const stray = twoWay({ ...made, kept: ['c'.repeat(26)] }, made);
      expect(await withGateRerun(stray, answering(PASS))(COPY, LINKED)).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [], linksDropped: RERUN_REASONS.rules });
    });

    it('gives the refusal of the copy with no links when that one is refused too: the links were not the cause', async () => {
      const redact = twoWay({ kind: 'refused', reason: 'page 1 is a scan' }, { kind: 'refused', reason: 'page 1 is a scan, again' });
      expect(await withGateRerun(redact, answering(PASS))(COPY, LINKED)).toEqual({ kind: 'refused', reason: 'page 1 is a scan, again' });
      const withheld = vi.fn<Gate>(() => Promise.resolve({ verdict: { pass: false, code: 'withheld' }, sha256: SHA }));
      expect(await withGateRerun(twoWay({ ...made, kept: ['a'.repeat(26)] }, made), withheld)(COPY, LINKED)).toEqual({ kind: 'refused', reason: RERUN_REASONS.withheld });
      expect(withheld).toHaveBeenCalledTimes(2);
    });

    it('asks once when there are no links, and lets a retryable failure of the second run through', async () => {
      const redact = vi.fn<Redact>(() => Promise.resolve({ kind: 'refused', reason: 'page 1 is a scan' }));
      expect(await withGateRerun(redact, answering(PASS))(COPY, { ...REQUEST, links: [] })).toEqual({ kind: 'refused', reason: 'page 1 is a scan' });
      expect(redact).toHaveBeenCalledTimes(1);
      const flaky = vi.fn<Redact>((_original, request) => ((request.links ?? []).length > 0 ? Promise.resolve({ kind: 'refused', reason: 'no' }) : Promise.reject(new RetryableEngineError('the engine socket is missing'))));
      await expect(withGateRerun(flaky, answering(PASS))(COPY, LINKED)).rejects.toBeInstanceOf(RetryableEngineError);
    });
  });

  describe('links fail safe when the engine fails (LINKS L3 fix 2, N2): an error, a timeout or a cap on the run with links', () => {
    const LINKS = [{ id: 'a'.repeat(26), page: 1, rect: [1, 2, 3, 4] as const, label: 'Link to site.example' }];
    const LINKED = { ...REQUEST, origin: 'https://nwflorida.us', links: LINKS };

    it('asks once more with no links when the run with links fails, and names a fixed reason that echoes nothing of the failure', async () => {
      for (const failure of ['the engine took longer than 300000 ms', 'the engine ran out of memory', 'the engine child exited (signal SIGKILL)']) {
        const redact = vi.fn<Redact>((_original, request) => ((request.links ?? []).length > 0 ? Promise.reject(new Error(`${failure}: Kestrel Ambry`)) : Promise.resolve(made)));
        const gate = vi.fn<Gate>(() => Promise.resolve(PASS));
        const result = await withGateRerun(redact, gate)(COPY, LINKED);
        expect(result, failure).toEqual({ kind: 'redacted', pdf: WRITTEN, boxes: [], linksDropped: LINKED_ENGINE_FAILED });
        expect(JSON.stringify(result)).not.toContain('Kestrel');
        expect(redact.mock.calls.map(([, request]) => request.links), failure).toEqual([LINKS, []]);
        expect(gate, failure).toHaveBeenCalledTimes(1);
      }
    });

    it('lets a second failure, with no links, stand as it does today, and a retryable failure of the first through untouched', async () => {
      const both = vi.fn<Redact>(() => Promise.reject(new Error('the engine ran out of memory')));
      await expect(withGateRerun(both, answering(PASS))(COPY, LINKED)).rejects.toThrow('the engine ran out of memory');
      expect(both).toHaveBeenCalledTimes(2);
      const unreachable = vi.fn<Redact>(() => Promise.reject(new RetryableEngineError('the engine socket is missing')));
      await expect(withGateRerun(unreachable, answering(PASS))(COPY, LINKED)).rejects.toBeInstanceOf(RetryableEngineError);
      expect(unreachable).toHaveBeenCalledTimes(1);
      const plain = vi.fn<Redact>(() => Promise.reject(new Error('down')));
      await expect(withGateRerun(plain, answering(PASS))(COPY, REQUEST)).rejects.toThrow('down');
      expect(plain).toHaveBeenCalledTimes(1);
    });

    it('is the one fallback, withLinkFallback, also for an engine with no gate (the ledger\'s remake)', async () => {
      const redact = vi.fn<Redact>((_original, request) => ((request.links ?? []).length > 0 ? Promise.resolve({ kind: 'refused', reason: 'the links could not be written' }) : Promise.resolve(made)));
      expect(await withLinkFallback(redact)(COPY, LINKED)).toEqual({ ...made, linksDropped: 'the links could not be written' });
      const original = vi.fn<Redact>(() => Promise.resolve({ kind: 'original' }));
      expect(await withLinkFallback(original)(COPY, LINKED)).toEqual({ kind: 'original' });
      expect(original).toHaveBeenCalledTimes(1);
    });
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
