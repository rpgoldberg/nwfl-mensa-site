// EDITOR E2: the officer editor's shared parts, rendered by Astro's container. Previews: "What the public
// sees" and "What members see", each in its own frame headed in words, with the item written by the
// same markup as Home and /news (ItemArticle); an audience that will not see the item is told so in
// words, never by an empty frame. ItemHeader: what the item is, whose it is, its status in words beside
// the chip, and the approver's note when it was sent back.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import ItemHeader from '../../src/components/ItemHeader.astro';
import Previews from '../../src/components/Previews.astro';
import type { EditorItem, EditorVersion, Preview } from '../../src/lib/api/editor';
import { MEMBERS_RULE, escapeHtml } from '../../src/lib/document';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const text = (t: string) => ({ kind: { case: 'text' as const, value: { text: t, bold: false, italic: false } } });
const para = (t: string) => ({ kind: { case: 'paragraph' as const, value: { inlines: [text(t)] } } });
const members = (t: string) => ({ kind: { case: 'members' as const, value: { blocks: [para(t)] } } });
const REDACTED = { kind: { case: 'redacted' as const, value: {} } };
const doc = (...blocks: unknown[]) => ({ blocks }) as unknown as NonNullable<Preview['publicBody']>;

const preview = (patch: Partial<Preview>): Preview => ({ title: 'Lunch <moves>', summary: 'To "Thursdays"', problems: [], ...patch });
const render = (props: Record<string, unknown>) => container.renderToString(Previews, { props });
/** The frame headed `heading`, as written. */
const frame = (html: string, heading: string) => {
  const at = html.indexOf(`>${heading}</h2>`);
  expect(at, heading).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<section', at), html.indexOf('</section>', at) + '</section>'.length);
};

describe('Previews', () => {
  it('shows each audience its own item, the public first, each frame headed in words', async () => {
    const html = await render({
      preview: preview({ publicBody: doc(para('Open to all.'), { kind: { case: 'redacted', value: {} } }), membersBody: doc(para('Open to all.'), members('The gate code is 4321.')) }),
      kind: 'announcement',
      visibility: 'public',
    });
    expect(html.indexOf('What the public sees')).toBeLessThan(html.indexOf('What members see'));
    const pub = frame(html, 'What the public sees');
    expect(pub).toContain('<h3>Lunch &lt;moves&gt;</h3>');
    expect(pub).toContain('<p>To &quot;Thursdays&quot;</p>');
    expect(pub).toContain('<p>Open to all.</p><p class="members-note">Members-only passage, sign in to read.</p>');
    expect(pub).not.toContain('4321');
    const mem = frame(html, 'What members see');
    expect(mem).toContain(`<aside class="members-passage" aria-label="Members only"><p class="members-rule">${escapeHtml(MEMBERS_RULE)}</p><p>The gate code is 4321.</p></aside>`);
    expect(html).toContain('aria-labelledby="preview-public"');
    expect(html).toContain('id="preview-members"');
  });

  it('says in words when an audience will not see the item, and why for an officers item', async () => {
    const html = await render({ preview: preview({}), kind: 'article', visibility: 'officers' });
    expect(frame(html, 'What the public sees')).toContain('<p>The public will not see this item. It is for officers only.</p>');
    expect(frame(html, 'What members see')).toContain('<p>Members will not see this item. It is for officers only.</p>');
    expect(html).not.toContain('<article');
    const hidden = await render({ preview: preview({ membersBody: doc(para('m')) }), kind: 'article', visibility: 'public' });
    expect(frame(hidden, 'What the public sees')).toContain('<p>The public will not see this item.</p>');
  });

  it('says in words when a body is set but empty (a new draft with no text yet), under the title and summary', async () => {
    const html = await render({ preview: preview({ publicBody: doc(), membersBody: doc() }), kind: 'announcement', visibility: 'public' });
    for (const heading of ['What the public sees', 'What members see']) {
      const f = frame(html, heading);
      expect(f, heading).toContain('<h3>Lunch &lt;moves&gt;</h3>');
      expect(f, heading).toContain('<p>There is no text yet: readers will see the title and summary only.</p>');
    }
    const some = await render({ preview: preview({ publicBody: doc(para('x')), membersBody: doc(para('x')) }), kind: 'announcement', visibility: 'public' });
    expect(some).not.toContain('There is no text yet');
  });

  it('shows the public a members item as /news does: title and summary, with the box alone', async () => {
    const html = await render({ preview: preview({ publicBody: doc(REDACTED), membersBody: doc(para('Members text.')) }), kind: 'article', visibility: 'members' });
    const pub = frame(html, 'What the public sees');
    expect(pub).toContain('<div class="prose"><p class="members-note">Members only.</p></div>');
    expect(pub).not.toContain(escapeHtml(MEMBERS_RULE));
    const mem = frame(html, 'What members see');
    expect(mem).toContain(`<p class="members-rule">${escapeHtml(MEMBERS_RULE)}</p>`);
    expect(mem).toContain('<p>Members text.</p>');
  });

  it("writes a President's report as Home does, without Home's label id", async () => {
    const html = await render({ preview: preview({ publicBody: doc(para('p')), membersBody: doc(para('p')) }), kind: 'president_report', visibility: 'public' });
    expect(html).toContain('<p class="eyebrow">From the President</p><h2>Lunch &lt;moves&gt;</h2><p class="lead">To &quot;Thursdays&quot;</p>');
    expect(html).not.toContain('president-title');
  });

  it('takes its own ids and heading level, so a page can show two', async () => {
    const html = await render({ preview: preview({}), kind: 'minutes', visibility: 'officers', idPrefix: 'live-now', headingLevel: 3 });
    expect(html).toContain('<h3 id="live-now-public">What the public sees</h3>');
    expect(html).toContain('<h3 id="live-now-members">What members see</h3>');
  });
});

const version = (patch: Partial<EditorVersion>): EditorVersion => ({
  id: 'v',
  number: 2,
  status: 'draft',
  title: 'Lunch <moves>',
  summary: '',
  visibility: 'public',
  markup: '',
  markupWithheld: false,
  contentHash: new Uint8Array(0),
  targets: { website: true, newsletter: false, email: false },
  editionId: '',
  printAsIs: false,
  onBehalfOf: '',
  sendBackNote: '',
  callerEdited: false,
  callerMayApprove: false,
  callerMayPublish: false,
  approvedAsLabel: '',
  approvalKindSelf: false,
  ...patch,
});
const item = (patch: Partial<EditorItem>): EditorItem => ({ id: 'i', slug: 's', kind: 'president_report', officeId: 'o', state: 'draft', working: version({}), ...patch });
const header = (props: Record<string, unknown>) => container.renderToString(ItemHeader, { props });

describe('ItemHeader', () => {
  it('says what the item is and whose, its title, and its status in words beside the chip', async () => {
    const html = await header({ item: item({}), officeName: 'President' });
    expect(html).toContain('<p class="eyebrow">President&#39;s report · President</p>');
    expect(html).toContain('<h1>Lunch &lt;moves&gt;</h1>');
    expect(html).toContain('<p class="status"><span class="chip past">Draft – only officers can see it</span></p>');
    expect(html).not.toContain('role="note"');
  });

  it("shows the approver's note in a box when it was sent back", async () => {
    const html = await header({ item: item({ working: version({ sendBackNote: 'Please add the <time>.' }) }), officeName: 'Publications' });
    expect(html).toContain('<span class="chip stop">Sent back – please read the note</span>');
    expect(html).toContain(`<div class="notice" role="note"><p><strong>The approver's note:</strong></p><blockquote><p>Please add the &lt;time&gt;.</p></blockquote></div>`);
  });

  it('takes the live title when there is no working version, and names each kind in words', async () => {
    const live = await header({ item: { id: 'i', slug: 's', kind: 'announcement', officeId: 'o', state: 'published', live: version({ status: 'approved', title: 'Live title' }) }, officeName: 'Social' });
    expect(live).toContain('<p class="eyebrow">Announcement · Social</p>');
    expect(live).toContain('<h1>Live title</h1>');
    expect(live).toContain('<span class="chip ok">Published</span>');
    expect(await header({ item: item({ kind: 'article' }), officeName: 'X' })).toContain('News article · X');
  });

  it('says so when a ready version is marked "print as is"', async () => {
    const html = await header({ item: item({ state: 'ready', working: version({ status: 'ready', printAsIs: true }) }), officeName: 'Editor' });
    expect(html).toContain('<p class="notice">This version is marked &quot;print as is&quot;: it can be approved or sent back, but no longer edited.</p>');
  });
});
