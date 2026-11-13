// The strict URL rule at save (EDITOR A3a, SPEC-v3 3.2): linkcheck's keep rules, plus https written
// and the address written plainly, each refusal with a reason in plain words.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type UrlRefusal, shownUrl, textUrlProblems, urlMessage, urlProblem, urlsInText } from '../../src/links/rule.js';

interface Case {
  in: string;
  answer: string;
}
const table = JSON.parse(readFileSync(new URL('../fixtures/url-rules.json', import.meta.url), 'utf8')) as Case[];
const contract = JSON.parse(readFileSync(new URL('../load/fixtures/links-contract.json', import.meta.url), 'utf8')) as Array<{ in: string; out: string | null }>;

describe('urlProblem: the shared table', () => {
  it.each(table.map((c) => [c.in, c.answer] as const))('%j: %s', (input, answer) => {
    expect(urlProblem(input)?.code ?? 'ok').toBe(answer);
  });

  it('never accepts a URL the links contract refuses, and accepts only https or mailto', () => {
    for (const c of contract) {
      const problem = urlProblem(c.in);
      if (c.out === null) expect(problem, c.in).not.toBeNull();
      if (problem === null) expect(c.in, c.in).toMatch(/^(https:\/\/|mailto:)/);
    }
  });
});

describe('urlProblem: reasons in plain words', () => {
  const reasons: Array<[string, UrlRefusal, RegExp]> = [
    ['http://example.org/', 'http', /^must start with https:\/\/, not http:\/\/$/],
    ['www.example.org/', 'http', /^must be written in full, starting with https:\/\/$/],
    ['HTTPS://example.org/', 'not-plain', /lower case/],
    ['javascript:alert(1)', 'scheme', /not a web address/],
    ['https://user:pw@example.org/', 'credentials', /user name or password/],
    ['https://example.org:8443/', 'port', /port/],
    ['https://192.0.2.10/', 'ip-literal', /IP address/],
    ['https://localhost/', 'local-name', /no dot/],
    ['https://exa_mple.org/', 'host-name', /site name/],
    [`https://example.org/${'a'.repeat(2048)}`, 'too-long', /2048/],
    ['https://example.org/​', 'control', /hidden characters/],
    ['https://', 'malformed', /cannot be read/],
  ];

  it.each(reasons)('%j: %s', (input, code, reason) => {
    const problem = urlProblem(input);
    expect(problem?.code).toBe(code);
    expect(problem?.reason).toMatch(reason);
    expect(problem?.reason).not.toMatch(/;/);
  });

  it('refuses an email address where a web address is wanted', () => {
    expect(urlProblem('mailto:editor@example.org', { mail: false })).toEqual({ code: 'not-web', reason: expect.stringMatching(/email address.*https:\/\//) as unknown });
    expect(urlProblem('https://example.org/', { mail: false })).toBeNull();
    expect(urlProblem('mailto:editor@example.org', { mail: true })).toBeNull();
  });

  it('names the URL in the message, shortened and with hidden characters shown', () => {
    const problem = urlProblem('http://example.org/') as NonNullable<ReturnType<typeof urlProblem>>;
    expect(urlMessage('the link', 'http://example.org/', problem)).toBe('the link "http://example.org/" must start with https://, not http://');
    expect(shownUrl('https://example.org/​x\u0000')).toBe('https://example.org/?x?');
    const long = `https://example.org/${'b'.repeat(100)}`;
    expect(shownUrl(long)).toBe(`${long.slice(0, 60)}...`);
    expect(shownUrl(long.slice(0, 60))).toBe(long.slice(0, 60));
  });
});

describe('urlsInText: bare URLs in text', () => {
  it('finds http, https and www. addresses with their place, sentence punctuation left off', () => {
    expect(urlsInText('See https://example.org/a. Or (www.example.net/b), or http://example.com/c?')).toEqual([
      { url: 'https://example.org/a', index: 4 },
      { url: 'www.example.net/b', index: 31 },
      { url: 'http://example.com/c', index: 54 },
    ]);
    expect(urlsInText('no addresses here, not even example.org')).toEqual([]);
  });

  it('keeps a balanced closing bracket', () => {
    expect(urlsInText('https://example.org/path_(x)')).toEqual([{ url: 'https://example.org/path_(x)', index: 0 }]);
  });

  it('does not trim an address far over the limit, and stays fast on a hostile one', () => {
    const hostile = `https://example.org/${')'.repeat(48 * 1024)}`;
    const text = `${hostile} ${hostile}`;
    const work = { steps: 0 };
    const started = performance.now();
    const found = urlsInText(text, work);
    // Counted steps are the bound (the text read once, nothing trimmed); the clock only catches a catastrophe.
    expect(work.steps).toBe(text.length);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(found).toHaveLength(2);
    expect(found[0]?.url).toBe(hostile);
    expect(urlProblem(found[0]?.url as string)?.code).toBe('too-long');
  });

  it('trims many hostile addresses just under the limit quickly', () => {
    const near = `https://example.org/${')'.repeat(2100)}`;
    const text = Array.from({ length: 23 }, () => near).join(' ');
    const work = { steps: 0 };
    const started = performance.now();
    expect(urlsInText(text, work)).toHaveLength(23);
    // The text read once, then each URL's brackets counted and its end trimmed: linear, at most 3x the text.
    expect(work.steps).toBeLessThanOrEqual(3 * text.length);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe('textUrlProblems: plain text, line by line', () => {
  it('gives each bad bare URL its line and reason, and passes good ones', () => {
    expect(textUrlProblems('Tickets at https://example.org/t.\r\nDirections: http://example.org/map\nOr www.example.net\n\nhttps://192.0.2.1/x')).toEqual([
      { line: 2, message: 'the address "http://example.org/map" must start with https://, not http://' },
      { line: 3, message: 'the address "www.example.net" must be written in full, starting with https://' },
      { line: 5, message: 'the address "https://192.0.2.1/x" uses a number (an IP address) instead of a site name' },
    ]);
    expect(textUrlProblems('')).toEqual([]);
    expect(textUrlProblems('Meet at the pavilion. Bring a dish.')).toEqual([]);
  });
});
