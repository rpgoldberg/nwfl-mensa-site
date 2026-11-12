// EDITOR A3a: the markup scans its text for bare URLs once, after it has parsed it, so a stretch the
// parser reads more than once (a "[" or "*" that never closes) is not scanned again each time.
import { describe, expect, it, vi } from 'vitest';
import * as rule from '../links/rule.js';
import { parseMarkup } from './markup.js';

vi.mock('../links/rule.js', async (original) => {
  const actual = await original<typeof rule>();
  return { ...actual, urlsInText: vi.fn(actual.urlsInText), urlProblem: vi.fn(actual.urlProblem) };
});

describe('parseMarkup scans for bare URLs once per run of final text', () => {
  it('scans a paragraph of unclosed brackets once, and checks each URL in it once', () => {
    vi.mocked(rule.urlsInText).mockClear();
    vi.mocked(rule.urlProblem).mockClear();
    const src = '[http://a.example '.repeat(12);
    expect(parseMarkup(src).problems).toHaveLength(12);
    expect(rule.urlsInText).toHaveBeenCalledTimes(1);
    expect(rule.urlProblem).toHaveBeenCalledTimes(12);
  });

  it('scans the same for unclosed emphasis', () => {
    vi.mocked(rule.urlsInText).mockClear();
    vi.mocked(rule.urlProblem).mockClear();
    expect(parseMarkup('*http://a.example '.repeat(12)).problems).toHaveLength(12);
    expect(rule.urlsInText).toHaveBeenCalledTimes(1);
    expect(rule.urlProblem).toHaveBeenCalledTimes(12);
  });

  it('checks a link href once, however often its label is read', () => {
    vi.mocked(rule.urlProblem).mockClear();
    expect(parseMarkup('[a [b](http://a.example/x) c [d [e').problems).toHaveLength(1);
    expect(rule.urlProblem).toHaveBeenCalledTimes(1);
    vi.mocked(rule.urlProblem).mockClear();
    expect(parseMarkup('[a [b](https://a.example/x) c [d [e').problems).toEqual([]);
    expect(rule.urlProblem).toHaveBeenCalledTimes(1);
  });
});
