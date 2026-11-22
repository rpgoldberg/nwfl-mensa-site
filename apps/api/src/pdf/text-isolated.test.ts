// ARCHIVE-SEARCH S2: the "text" job in the gate's capped child (gate-isolated.ts isolatedText): the
// same child, flags, limits and watchdog as a check, and only a well-formed text reply is an answer.
// The children are stand-ins (test/pdf/gate-children) but for the last test, which runs the real
// gate-child.ts on a synthetic PDF. Every name is made up.
import { describe, expect, it } from 'vitest';
import { GATE_CHILD_SOURCE, NODE_FLAGS, gateStandIn } from '../../test/helpers/sidecar.js';
import { pagesPdf } from '../../test/search/synthetic.js';
import { sha256Hex } from './engine-protocol.js';
import { isolatedGate, isolatedText } from './gate-isolated.js';

const COPY = Uint8Array.from([1, 2, 3, 4]);
const SHA = sha256Hex(COPY);
const text = (name: string, options: Parameters<typeof isolatedText>[0] = {}) => isolatedText({ module: gateStandIn(name), ...options });
const unfinished = (cause: string) => ({ sha256: null, code: 'unfinished', cause });

describe('isolatedText', () => {
  it('sends the child a job of kind "text" with the copy and the quotes, and hands back its pages and the copy\'s sha256', async () => {
    expect(await text('text')({ copy: COPY, quotes: ['Kestrel Ambry', 'Ottoline Varga'] })).toEqual({ sha256: SHA, pages: [{ text: 'text:4', extra: 'Kestrel Ambry|Ottoline Varga' }] });
  });

  it('hands back a refusal by its code, and the hash the child names as it came (the caller compares it)', async () => {
    expect(await text('text')({ copy: COPY, quotes: ['refuse'] })).toEqual({ sha256: SHA, code: 'withheld' });
    expect(await text('text')({ copy: COPY, quotes: ['other'] })).toEqual({ sha256: sha256Hex(new TextEncoder().encode('other bytes')), pages: [{ text: 'other', extra: '' }] });
  });

  it('takes nothing but a text reply within the caps: a page over its cap, an unknown code, a check\'s verdict or garbage is "unfinished"', async () => {
    expect(await text('text')({ copy: COPY, quotes: ['big'] })).toEqual(unfinished('crash'));
    expect(await text('text')({ copy: COPY, quotes: ['code'] })).toEqual(unfinished('crash'));
    expect(await text('pass')({ copy: COPY, quotes: [] })).toEqual(unfinished('crash'));
    expect(await text('garbage')({ copy: COPY, quotes: [] })).toEqual(unfinished('crash'));
  });

  it('says why a child gave no text: it crashed, ran past its deadline, or was stopped by the signal', async () => {
    expect(await text('crash')({ copy: COPY, quotes: [] })).toEqual(unfinished('crash'));
    expect(await text('hang', { timeoutMs: 400 })({ copy: COPY, quotes: [] })).toEqual(unfinished('deadline'));
    const stop = new AbortController();
    stop.abort();
    expect(await text('text', { signal: stop.signal })({ copy: COPY, quotes: [] })).toEqual(unfinished('signal'));
  });

  it('leaves a check as it was: a text reply is no verdict', async () => {
    expect(await isolatedGate({ module: gateStandIn('text') })({ copy: COPY, original: Uint8Array.from([9]), quotes: [], image: 'show' })).toEqual({ verdict: { pass: false, code: 'unfinished' }, sha256: null, cause: 'crash' });
  });

  it('runs the real child: it reads a synthetic copy\'s pages, refuses one that holds a withheld passage, and still checks a copy', async () => {
    const real = isolatedText({ module: GATE_CHILD_SOURCE, nodeFlags: NODE_FLAGS });
    const copy = await pagesPdf([['Picnic at Ferry Park'], ['All mem-', 'bers welcome']]);
    expect(await real({ copy, quotes: ['Kestrel Ambry'] })).toEqual({ sha256: sha256Hex(copy), pages: [{ text: 'Picnic at Ferry Park', extra: '' }, { text: 'All members welcome', extra: 'mem-bers' }] });
    expect(await real({ copy, quotes: ['Ferry Park'] })).toEqual({ sha256: sha256Hex(copy), code: 'withheld' });
    // The same child, sent a check: a verdict, as before.
    const check = await isolatedGate({ module: GATE_CHILD_SOURCE, nodeFlags: NODE_FLAGS })({ copy, original: copy, quotes: ['Ferry Park'], image: 'show' });
    expect(check).toMatchObject({ verdict: { pass: false, code: 'withheld' }, sha256: sha256Hex(copy) });
  }, 60_000);
});
