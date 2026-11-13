// EDITOR E4 round 4, on the real API: a reviewer who sees only part of a piece (the lone Webmaster, at the
// public's audience, where the redaction lens withholds a marked phone number) gets no hash from the API,
// so the review page offers only Send back; and posts forged from that view (same origin, with the list hash
// and row key the API would accept, and an officer's content hash, the worst case) are refused by the site
// before any call to the API: nothing is saved, approved or published. The API learns to refuse them too
// (A3B-HARDEN); this is the site's own guard.
import { createHash } from 'node:crypto';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { expect, request, test } from '@playwright/test';
import { MarkField, MarkSubjectKind, RedactionCategory, RedactionPolicyService } from '../../../api/src/gen/nwfl/mensa/v1/redaction_pb';
import { ContentKind, ItemVisibility, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { as, content, tokenFor } from './api';
import { marker, person } from './helpers';
import { EDITOR_REAL } from './servers';

/**
 * The one redaction call this spec makes, typed here: the site generates no redaction client, and apps/api's
 * generated one imports its own @bufbuild/protobuf, which a site-only install (CI's Typecheck) cannot
 * resolve, so its methods would be typed loosely.
 */
interface Marks {
  addRedactionMark(
    mark: { subjectKind: MarkSubjectKind; subjectId: string; field: MarkField; quote: string; category: RedactionCategory },
    options: ReturnType<typeof as>,
  ): Promise<unknown>;
}
const marks = createClient(RedactionPolicyService, createGrpcTransport({ baseUrl: EDITOR_REAL.apiUrl, defaultTimeoutMs: 10_000 })) as unknown as Marks;
// Made up: the 555-01xx range is set aside for fiction.
const PHONE = '850-555-0142';
const FINE = 'https://example.org/fine';
const REFUSED = 'Nothing was changed: parts of this piece are hidden from you, so an officer who can see all of it must check its links and approve it.';
const NOT_PUBLISHED = 'It was not published: parts of this piece are hidden from you, so someone who can see all of it must publish it.';
/** The page's row key (src/lib/editor/review.ts rowKey). */
const rowKey = (url: string, where: string) => createHash('sha256').update(JSON.stringify([url, where])).digest('hex').slice(0, 12);

/** A President's piece with a marked phone number, sent for approval; approved too when `approve`. */
async function partialPiece(president: string, ids: Record<string, string>, approve: string | undefined): Promise<string> {
  const title = `Part hidden ${marker('p')}`;
  const made = await content.createItem({ kind: ContentKind.ANNOUNCEMENT, officeId: ids['president']!, slug: marker('ph-'), title }, as(president));
  const id = made.item!.id;
  await content.saveDraft({ itemId: id, title, summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: `Call ${PHONE}, or see ${FINE}.` }, as(president));
  await marks.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: id, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE }, as(president));
  await content.markReady({ itemId: id, targets: { website: true, newsletter: false, email: false } }, as(president));
  if (approve !== undefined) {
    const hash = (await content.getWorkingItem({ itemId: id }, as(approve))).item!.working!.contentHash;
    await content.approve({ itemId: id, contentHash: hash }, as(approve));
  }
  return id;
}

test('posts forged from a view with part of the piece hidden are refused before the API, and nothing changes', async ({ browser }) => {
  const ctx = await request.newContext();
  const { ids } = (await (await ctx.get(`${EDITOR_REAL.stackUrl}/fixture`)).json()) as { ids: Record<string, string> };
  await ctx.dispose();
  const president = await tokenFor('officer');
  const treasurer = await tokenFor('treasurer');
  const lone = await tokenFor('lone-webmaster');
  const waiting = await partialPiece(president, ids, undefined);
  const approved = await partialPiece(president, ids, treasurer);

  // The API: no hash and no markup to the lone Webmaster; the officer sees it whole.
  const part = (await content.getWorkingItem({ itemId: waiting }, as(lone))).item!.working!;
  expect(part.contentHash).toHaveLength(0);
  expect(part.bodyMarkupWithheld).toBe(true);
  const officerHash = Buffer.from((await content.getWorkingItem({ itemId: waiting }, as(treasurer))).item!.working!.contentHash).toString('hex');
  const approvedHash = Buffer.from((await content.getWorkingItem({ itemId: approved }, as(treasurer))).item!.working!.contentHash).toString('hex');
  expect(officerHash).toMatch(/^[0-9a-f]{64}$/);
  // What the API would accept from the lone Webmaster's own list: its hash and the row of the fine link.
  const listed = await content.getItemLinks({ itemId: waiting }, as(lone));
  const fine = listed.links.findIndex((l) => l.url === FINE);
  expect(fine).toBeGreaterThanOrEqual(0);
  const rows = Object.fromEntries(listed.links.slice(0, fine + 1).map((l, i) => [`row-${i}`, rowKey(l.url, l.where)]));
  const linksHash = Buffer.from(listed.linksSha256).toString('hex');

  const { context, page } = await person(browser, 'lone-webmaster');
  const S7 = `/officer-area/approvals/${waiting}`;
  await page.goto(S7);
  await expect(page.getByText('Parts of this piece are hidden from you')).toBeVisible();
  await expect(page.locator('input[name="hash"], input[name="links_hash"], input[name^="row-"], input[name^="answer-"]')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Check the links' }).getByRole('link')).toHaveCount(0);
  expect(await page.content()).not.toContain(PHONE);

  const forged: [string, string, Record<string, string>, string][] = [
    ['links', S7, { step: 'links', links_hash: linksHash, ...rows, [`answer-${fine}`]: 'yes' }, REFUSED],
    ['approve', S7, { step: 'approve', hash: officerHash }, REFUSED],
    ['break-glass', S7, { step: 'break-glass', hash: officerHash, reason: 'Forged' }, REFUSED],
    ['publish', `/officer-area/approvals/${approved}/publish`, { hash: approvedHash }, NOT_PUBLISHED],
  ];
  for (const [name, path, form, words] of forged) {
    const res = await page.request.post(path, { form, headers: { Origin: EDITOR_REAL.siteUrl }, maxRedirects: 0 });
    expect(res.status(), name).toBe(409);
    expect(await res.text(), name).toContain(words);
  }
  await context.close();

  // Nothing changed: no answer kept, still waiting, still approved and not published.
  const after = await content.getItemLinks({ itemId: waiting }, as(treasurer));
  expect(after.links.filter((l) => l.answeredByLabel !== '')).toEqual([]);
  expect((await content.getWorkingItem({ itemId: waiting }, as(treasurer))).item!.working!.status).toBe(VersionStatus.READY);
  const still = (await content.getWorkingItem({ itemId: approved }, as(treasurer))).item!;
  expect(still.working?.status).toBe(VersionStatus.CLEARED);
  expect(still.live).toBeUndefined();
});
