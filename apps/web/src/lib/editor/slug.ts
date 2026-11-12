// EDITOR E2: an item's slug, made by the site from the title (officers never see or type it), within
// the API's check on content_item.slug (^[a-z0-9][a-z0-9-]{0,99}$). A slug taken already (ALREADY_EXISTS,
// SlugTaken) is tried again as -2, -3 and on.
import { SlugTaken } from '../api/editor';

/** The API's longest slug. */
export const SLUG_MAX = 100;
/** Room kept at the end of a slug from a title for "-99". */
const SUFFIX_ROOM = 4;
/** How many slugs CreateItem is tried with before giving up. */
export const SLUG_TRIES = 20;

/** Letters NFKD leaves alone, in their usual Latin spelling. */
const SPELLED: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th', ð: 'd', ı: 'i' };

const trimDashes = (text: string) => text.replace(/^-+|-+$/g, '');

/** A slug from a title: lower case, accents dropped, anything else a single dash; "item" when nothing is left. */
export function slugFromTitle(title: string): string {
  const latin = title
    .toLowerCase()
    .replace(/[ßæœøđłþðı]/g, (c) => SPELLED[c] as string)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '');
  const slug = trimDashes(trimDashes(latin.replace(/[^a-z0-9]+/g, '-')).slice(0, SLUG_MAX - SUFFIX_ROOM));
  return slug === '' ? 'item' : slug;
}

/** The `n`th slug to try: the slug itself, then slug-2, slug-3, cut so that it still fits. */
export function slugCandidate(slug: string, n: number): string {
  if (n <= 1) return slug;
  const suffix = `-${n}`;
  return `${trimDashes(slug.slice(0, SLUG_MAX - suffix.length))}${suffix}`;
}

/** Creates with the title's slug, then the next while it is taken; gives up with SlugTaken after `tries`. */
export async function createWithSlug<T>(title: string, create: (slug: string) => Promise<T>, tries = SLUG_TRIES): Promise<T> {
  const slug = slugFromTitle(title);
  for (let n = 1; ; n++) {
    try {
      return await create(slugCandidate(slug, n));
    } catch (error) {
      if (!(error instanceof SlugTaken) || n >= tries) throw error;
    }
  }
}
