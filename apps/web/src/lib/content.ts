// Where each piece of rendered content comes from (MT-50, condition 3). Pages
// that render items from the API pass them through visibleContent, and mark
// each with data-source, so a test can see what a page shows.
//   static     written into this repository (content/site/)
//   pipeline   made by the archive ingest job from the published newsletters
//   submitted  written by an officer or a member through the site
export const CONTENT_SOURCES = ['static', 'pipeline', 'submitted'] as const;
export type ContentSource = (typeof CONTENT_SOURCES)[number];

/** A public-only build shows no submitted item; an unknown source is never shown. */
export function visibleContent<T extends { source: ContentSource }>(items: readonly T[], { publicOnly }: { publicOnly: boolean }): T[] {
  return items.filter((item) => CONTENT_SOURCES.includes(item.source) && !(publicOnly && item.source === 'submitted'));
}
