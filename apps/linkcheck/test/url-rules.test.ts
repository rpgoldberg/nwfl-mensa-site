// The URL rules shared with the API (EDITOR A3a): one table of cases, committed byte for byte at
// apps/linkcheck/test/fixtures/url-rules.json and apps/api/test/fixtures/url-rules.json, the same sha256
// pinned in both suites. Each case is { in, answer }. The API refuses at save whatever this checker would
// not keep, and is stricter in two ways only: it wants https written (this checker upgrades http), and it
// wants the address written plainly (https:// or mailto: in lower case, no spaces). So:
//   ok         kept here, as https or mailto;      the API accepts it
//   http       kept here, as http (upgraded);      the API asks for https://
//   not-plain  kept here, as https or mailto;      the API asks for it written plainly
//   any other  refused here, for that very reason; the API refuses it for the same reason
// The API's own suite checks its answers against this table and checks that its copy of src/urls.ts is
// this file byte for byte (apps/api/test/links/shared.test.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseKept } from '../src/urls.js';

/** The sha256 of the fixture; the same constant in the API's suite. */
export const URL_RULES_SHA256 = '23307908ee644f7198f0033a973a687afb97317a61d7bc8aae269cfbaa78b445';

interface Case {
  in: string;
  answer: string;
}

const bytes = readFileSync(new URL('./fixtures/url-rules.json', import.meta.url));
const cases = JSON.parse(bytes.toString('utf8')) as Case[];
/** The one serialisation: two-space JSON, everything outside printable ASCII written as \uXXXX. */
const serialised = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`.replace(/[^\n\x20-\x7e]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

describe('the shared URL rules table', () => {
  it('is the pinned file, in its one serialisation, sorted by "in" with no repeats', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(URL_RULES_SHA256);
    expect(bytes.toString('utf8')).toBe(serialised(cases));
    const ins = cases.map((c) => c.in);
    expect(ins).toEqual([...ins].sort());
    expect(new Set(ins).size).toBe(ins.length);
  });

  it.each(cases.filter((c) => c.answer === 'ok' || c.answer === 'not-plain').map((c) => [c.in, c.answer] as const))('%j is kept as https or mailto (%s)', (input) => {
    const parsed = parseKept(input);
    expect(parsed.ok && parsed.link.scheme).toMatch(/^(https|mailto)$/);
  });

  it.each(cases.filter((c) => c.answer === 'http').map((c) => c.in))('%j is kept as http, which the check upgrades', (input) => {
    const parsed = parseKept(input);
    expect(parsed.ok && parsed.link.scheme).toBe('http');
  });

  it.each(cases.filter((c) => !['ok', 'http', 'not-plain'].includes(c.answer)).map((c) => [c.in, c.answer] as const))('%j is refused (%s)', (input, answer) => {
    expect(parseKept(input)).toEqual({ ok: false, reason: answer });
  });
});
