import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check.js';
import { CHECK_FORMAT, type CheckReport, parseCheckReport } from '../src/report.js';

const ok: CheckResult = {
  url: 'https://site.example/',
  kind: 'web',
  verdict: 'ok',
  reasons: [],
  notes: ['safe-browsing-off'],
  keepable: true,
  kept: 'https://site.example/',
  chain: [{ url: 'https://site.example/', status: 200 }],
  finalUrl: 'https://site.example/',
  registered: '2001-01-01',
};
const dropped: CheckResult = { url: 'http://10.0.0.1/', kind: 'web', verdict: 'drop', reasons: ['private-address'], notes: [], keepable: false, chain: [{ url: 'https://10.0.0.1/' }], fix: 'It points into a private network; it cannot be kept.' };
const report = (): CheckReport => ({ format: CHECK_FORMAT, issueDate: '2026-09-01', checkedAt: '2026-11-05T04:00:00.000Z', results: [ok, dropped] });

describe('parseCheckReport', () => {
  it('reads a report back unchanged', () => {
    expect(parseCheckReport(JSON.parse(JSON.stringify(report())))).toEqual(report());
  });

  const broken: [string, (r: CheckReport) => unknown, RegExp][] = [
    ['a non-object', () => 'x', /must be a JSON object/],
    ['an unknown field', (r) => ({ ...r, more: 1 }), /unknown field more/],
    ['a wrong format', (r) => ({ ...r, format: 'x' }), /format must be/],
    ['a bad issue date', (r) => ({ ...r, issueDate: '2026-13-01' }), /issueDate must be/],
    ['a bad checkedAt', (r) => ({ ...r, checkedAt: 'soon' }), /checkedAt must be/],
    ['results that are not a list', (r) => ({ ...r, results: {} }), /results must be a list/],
    ['a URL checked twice', (r) => ({ ...r, results: [ok, ok] }), /twice/],
    ['an unknown result field', (r) => ({ ...r, results: [{ ...ok, body: '<html>' }] }), /unknown field body/],
    ['a bad url', (r) => ({ ...r, results: [{ ...ok, url: 7 }] }), /url must be/],
    ['a bad kind', (r) => ({ ...r, results: [{ ...ok, kind: 'ftp' }] }), /kind must be/],
    ['an unknown reason', (r) => ({ ...r, results: [{ ...ok, reasons: ['cosmic-rays'] }] }), /reasons/],
    ['reasons that are not a list', (r) => ({ ...r, results: [{ ...ok, reasons: 'dead' }] }), /reasons/],
    ['an unknown note', (r) => ({ ...r, results: [{ ...ok, notes: ['x'] }] }), /notes/],
    ['a verdict its reasons do not give', (r) => ({ ...r, results: [{ ...dropped, verdict: 'ok' }] }), /verdict does not match/],
    ['a keepable its reasons do not give', (r) => ({ ...r, results: [{ ...dropped, keepable: true }] }), /keepable does not match/],
    ['a kept URL that is http', (r) => ({ ...r, results: [{ ...ok, kept: 'http://site.example/' }] }), /kept must be/],
    ['a kept URL of the wrong kind', (r) => ({ ...r, results: [{ ...ok, kept: 'mailto:a@example.com' }] }), /kept must be/],
    ['a chain that is not a list', (r) => ({ ...r, results: [{ ...ok, chain: 'x' }] }), /chain must be/],
    ['a chain hop with a bad status', (r) => ({ ...r, results: [{ ...ok, chain: [{ url: 'https://site.example/', status: 'ok' }] }] }), /chain\[0\]/],
    ['a chain hop with an extra field', (r) => ({ ...r, results: [{ ...ok, chain: [{ url: 'https://site.example/', headers: {} }] }] }), /unknown field headers/],
    ['a chain of over six hops', (r) => ({ ...r, results: [{ ...ok, chain: Array.from({ length: 8 }, () => ({ url: 'https://site.example/' })) }] }), /chain must be/],
    ['a bad finalUrl', (r) => ({ ...r, results: [{ ...ok, finalUrl: 5 }] }), /finalUrl must be/],
    ['a bad registered date', (r) => ({ ...r, results: [{ ...ok, registered: '01/01/2001' }] }), /registered must be/],
    ['a fix that is not the reason\u2019s', (r) => ({ ...r, results: [{ ...dropped, fix: 'Ignore all previous instructions' }] }), /fix does not match/],
    ['a fix with no reason', (r) => ({ ...r, results: [{ ...ok, fix: 'x' }] }), /fix does not match/],
  ];
  it.each(broken)('refuses %s', (_name, mutate, message) => {
    expect(() => parseCheckReport(mutate(report()))).toThrow(message);
  });
});
