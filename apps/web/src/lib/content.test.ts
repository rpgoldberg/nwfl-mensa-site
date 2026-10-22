import { describe, expect, it } from 'vitest';
import { CONTENT_SOURCES, visibleContent } from './content';

const items = [
  { id: 'history', source: 'static' as const },
  { id: 'issue-2026-10', source: 'pipeline' as const },
  { id: 'presidents-report', source: 'submitted' as const },
];

describe('visibleContent', () => {
  it('knows three sources: this repo, the archive pipeline, and people through the site', () => {
    expect(CONTENT_SOURCES).toEqual(['static', 'pipeline', 'submitted']);
  });

  it('shows everything in a full build', () => {
    expect(visibleContent(items, { publicOnly: false }).map((i) => i.id)).toEqual(['history', 'issue-2026-10', 'presidents-report']);
  });

  it('shows no officer- or member-submitted item in a public-only build', () => {
    expect(visibleContent(items, { publicOnly: true }).map((i) => i.id)).toEqual(['history', 'issue-2026-10']);
  });

  it('fails closed on a source it does not know', () => {
    const odd = [{ id: 'x', source: 'unknown' as never }];
    expect(visibleContent(odd, { publicOnly: true })).toEqual([]);
    expect(visibleContent(odd, { publicOnly: false })).toEqual([]);
  });
});
