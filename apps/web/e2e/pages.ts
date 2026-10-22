import { SECTIONS, sectionFor } from '../src/lib/site';

/** Every page the site serves today: the nine sections and the pages around them. */
export const ALL_PAGES = [...SECTIONS.map((s) => s.path), '/search', '/more', '/help', '/home-screen', '/signed-out'];

export const PRERENDERED = SECTIONS.filter((s) => s.prerender).map((s) => s.path);

export function titleOf(path: string): string {
  const page = sectionFor(path);
  if (!page) throw new Error(`no page at ${path}`);
  return page.title;
}
