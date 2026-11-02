import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { type Block, type Document, DocumentSchema, type Inline } from '../gen/nwfl/mensa/v1/content_pb.js';
import { MEMBERS_PASSAGE, MEMBERS_RULE, NOT_SHOWN, NO_MEMBER_ACCESS, documentHtml, escapeHtml, hasMembers, hasRedacted, withheldHtml } from './document';

const text = (value: string, style: { bold?: boolean; italic?: boolean } = {}): Inline => ({ $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'text', value: { $typeName: 'nwfl.mensa.v1.Text', text: value, bold: false, italic: false, ...style } } });
const para = (...inlines: Inline[]): Block => ({ $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'paragraph', value: { $typeName: 'nwfl.mensa.v1.Paragraph', inlines } } });
const doc = (...blocks: Block[]): Document => create(DocumentSchema, { blocks });
const link = (href: string, ...inlines: Inline[]): Inline => ({ $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'link', value: { $typeName: 'nwfl.mensa.v1.Link', href, inlines } } });

describe('documentHtml', () => {
  it('renders paragraphs, bold and italic, escaping every character HTML treats specially', () => {
    expect(documentHtml(doc(para(text('Fish & chips <script>alert("x")</script> '), text('bold', { bold: true }), text(' '), text('it', { italic: true }), text('both', { bold: true, italic: true }))))).toBe(
      '<p>Fish &amp; chips &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; <strong>bold</strong> <em>it</em><strong><em>both</em></strong></p>',
    );
  });

  it('puts headings under the level it is given', () => {
    const d = create(DocumentSchema, {
      blocks: [
        { kind: { case: 'heading', value: { level: 1, inlines: [text('Top')] } } },
        { kind: { case: 'heading', value: { level: 2, inlines: [text('Next')] } } },
        { kind: { case: 'heading', value: { level: 7, inlines: [text('Odd')] } } },
      ],
    });
    expect(documentHtml(d, { headingLevel: 3 })).toBe('<h3>Top</h3><h4>Next</h4><h4>Odd</h4>');
    expect(documentHtml(d, { headingLevel: 6 })).toBe('<h6>Top</h6><h6>Next</h6><h6>Odd</h6>');
  });

  it('renders lists and quotes with their blocks', () => {
    const d = create(DocumentSchema, {
      blocks: [
        { kind: { case: 'list', value: { ordered: false, items: [{ blocks: [para(text('one'))] }, { blocks: [para(text('two'))] }] } } },
        { kind: { case: 'list', value: { ordered: true, items: [{ blocks: [para(text('first'))] }] } } },
        { kind: { case: 'quote', value: { blocks: [para(text('said'))] } } },
      ],
    });
    expect(documentHtml(d)).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul><ol><li><p>first</p></li></ol><blockquote><p>said</p></blockquote>');
  });

  it('links https and mailto addresses only; anything else stays plain text', () => {
    expect(documentHtml(doc(para(link('https://www.us.mensa.org/join/', text('Join')))))).toBe('<p><a href="https://www.us.mensa.org/join/">Join</a></p>');
    expect(documentHtml(doc(para(link('mailto:president@nwflorida.us', text('Write')))))).toBe('<p><a href="mailto:president@nwflorida.us">Write</a></p>');
    for (const href of ['javascript:alert(1)', 'http://example.org/', 'data:text/html,x', '/relative', 'not a url', ' javascript:alert(1)']) {
      expect(documentHtml(doc(para(link(href, text('x'))))), href).toBe('<p>x</p>');
    }
    expect(documentHtml(doc(para(link('https://example.org/"onmouseover="x', text('q')))))).toBe('<p><a href="https://example.org/%22onmouseover=%22x">q</a></p>');
  });

  it('shows where a members-only passage was, and never what it held, even if the API sent it', () => {
    const d = create(DocumentSchema, {
      blocks: [
        { kind: { case: 'redacted', value: {} } },
        { kind: { case: 'members', value: { blocks: [para(text('the gate code is 1234'))] } } },
        para(text('Public '), { kind: { case: 'members', value: { inlines: [text('secret words')] } } } as Inline, text(' and '), { kind: { case: 'redacted', value: {} } } as Inline),
      ],
    });
    const html = documentHtml(d);
    expect(html).not.toContain('1234');
    expect(html).not.toContain('secret');
    expect(html).toBe(`<p class="members-note">${MEMBERS_PASSAGE}</p><p class="members-note">${MEMBERS_PASSAGE}</p><p>Public <span class="members-note">(members only)</span> and <span class="members-note">(members only)</span></p>`);
  });

  it('names a picture by its description until pictures are served', () => {
    const d = create(DocumentSchema, { blocks: [{ kind: { case: 'image', value: { fileId: 'f1', alt: 'The group at the <picnic>' } } }] });
    expect(documentHtml(d)).toBe('<p class="picture-note">Picture: The group at the &lt;picnic&gt;</p>');
  });

  it('renders nothing for a block or inline it does not know, or nesting past any sensible depth', () => {
    const empty = create(DocumentSchema, { blocks: [{ kind: { case: undefined } }, para({ kind: { case: undefined } } as Inline)] });
    expect(documentHtml(empty)).toBe('<p></p>');
    let deep: Block = para(text('bottom'));
    for (let i = 0; i < 40; i++) deep = { $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [deep] } } };
    expect(documentHtml(doc(deep))).not.toContain('bottom');
    expect(documentHtml(undefined)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

// A14 (S5b): a members-only passage as a member reads it, and the box for everyone else.
describe('documentHtml views', () => {
  const membersInline = (...inlines: Inline[]): Inline => ({ $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersInline', inlines } } });
  const redactedInline: Inline = { $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const membersBlock = (...blocks: Block[]): Block => ({ $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersBlock', blocks } } });
  const redactedBlock: Block = { $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const tree = doc(
    para(text('Open & '), membersInline(text('gate <code> 1234')), text(' then '), redactedInline),
    membersBlock(para(text('Ring "Pat" at <5>')), { $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'heading', value: { $typeName: 'nwfl.mensa.v1.Heading', level: 2, inlines: [text('Inside')] } } }),
    redactedBlock,
  );
  const PUBLIC_HTML = `<p>Open &amp; <span class="members-note">(members only)</span> then <span class="members-note">(members only)</span></p><p class="members-note">${MEMBERS_PASSAGE}</p><p class="members-note">${MEMBERS_PASSAGE}</p>`;

  it("is today's public output, byte for byte, by default and as 'public'", () => {
    expect(documentHtml(tree)).toBe(PUBLIC_HTML);
    expect(documentHtml(tree, { view: 'public' })).toBe(PUBLIC_HTML);
    expect(documentHtml(tree, { headingLevel: 3, view: 'public', signIn: undefined })).toBe(PUBLIC_HTML);
  });

  it('shows a member the passage, escaped, in a labelled box that says not to forward it; a redacted node says only that something is not shown', () => {
    expect(MEMBERS_RULE).toBe("Members only, please don't forward");
    expect(NOT_SHOWN).toBe('Part of this text is not shown.');
    const html = documentHtml(tree, { view: 'members' });
    expect(html).toBe(
      '<p>Open &amp; gate &lt;code&gt; 1234 <span class="members-note">(members only)</span> then <span class="members-note">(not shown)</span></p>' +
        `<aside class="members-passage" aria-label="Members only"><p class="members-rule">Members only, please don&#39;t forward</p><p>Ring &quot;Pat&quot; at &lt;5&gt;</p><h4>Inside</h4></aside>` +
        `<p class="members-note">${NOT_SHOWN}</p>`,
    );
    // Nothing about the reader's access, and no sign-in: the API read them as a member (A14 round 2).
    expect(documentHtml(tree, { view: 'members', signIn: '/sign-in' })).toBe(html);
    expect(html).not.toMatch(/sign in|member access|Members-only passage/i);
  });

  it('keeps the depth cap in the members view: a passage nested past it renders nothing', () => {
    let deep: Block = membersBlock(para(text('bottom')));
    for (let i = 0; i < 40; i++) deep = membersBlock(deep);
    const html = documentHtml(doc(deep), { view: 'members' });
    expect(html).not.toContain('bottom');
    let deepInline: Inline = membersInline(text('bottom'));
    for (let i = 0; i < 40; i++) deepInline = membersInline(deepInline);
    expect(documentHtml(doc(para(deepInline)), { view: 'members' })).not.toContain('bottom');
  });

  it('tells a signed-in reader without member access why, with a way to ask, and never shows the passage, even if the API sent it', () => {
    expect(NO_MEMBER_ACCESS).toBe('Members-only passage. Your account does not have member access yet.');
    const html = documentHtml(tree, { view: 'signed-in-public' });
    const box = `<p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`;
    expect(html).toBe(`<p>Open &amp; <span class="members-note">(members only)</span> then <span class="members-note">(members only)</span></p>${box}${box}`);
    expect(html).not.toMatch(/1234|Ring|Inside/);
  });

  it('links "sign in" in the public box only when given where sign-in is; the passage stays hidden', () => {
    const html = documentHtml(tree, { view: 'public', signIn: '/sign-in?return=%2Fnews' });
    const box = '<p class="members-note">Members-only passage, <a href="/sign-in?return=%2Fnews">sign in</a> to read.</p>';
    expect(html).toBe(`<p>Open &amp; <span class="members-note">(members only)</span> then <span class="members-note">(members only)</span></p>${box}${box}`);
    expect(documentHtml(doc(redactedBlock), { signIn: '/x?a="b"&c' })).toBe('<p class="members-note">Members-only passage, <a href="/x?a=&quot;b&quot;&amp;c">sign in</a> to read.</p>');
    expect(html).not.toMatch(/1234|Ring|Inside/);
  });
});

// A14: the API sends a redacted node only to a caller it reads as the public: that decides the view.
describe('withheldHtml (a teaser, D1)', () => {
  it("is the box a redacted node gets, for each reader, and nothing else", () => {
    const redacted = create(DocumentSchema, { blocks: [{ kind: { case: 'redacted', value: {} } }] });
    expect(withheldHtml()).toBe(`<p class="members-note">${MEMBERS_PASSAGE}</p>`);
    expect(withheldHtml()).toBe(documentHtml(redacted));
    expect(withheldHtml({ signIn: '/sign-in?a=1&b=2' })).toBe(documentHtml(redacted, { signIn: '/sign-in?a=1&b=2' }));
    expect(withheldHtml({ view: 'signed-in-public' })).toBe(`<p class="members-note">${NO_MEMBER_ACCESS} <a href="/help">Ask for help</a></p>`);
  });
});

describe('hasRedacted', () => {
  const R: Inline = { $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const RB: Block = { $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const wrap = (kind: Block['kind']): Block => ({ $typeName: 'nwfl.mensa.v1.Block', kind });
  const inline = (kind: Inline['kind']): Inline => ({ $typeName: 'nwfl.mensa.v1.Inline', kind });

  it('finds one anywhere: a block, an inline, in a heading, a list, a quote, a members passage, a link or a members inline', () => {
    const cases: Block[] = [
      RB,
      para(text('a'), R),
      wrap({ case: 'heading', value: { $typeName: 'nwfl.mensa.v1.Heading', level: 1, inlines: [R] } }),
      wrap({ case: 'list', value: { $typeName: 'nwfl.mensa.v1.ListBlock', ordered: false, items: [{ $typeName: 'nwfl.mensa.v1.ListItem', blocks: [para(text('x'))] }, { $typeName: 'nwfl.mensa.v1.ListItem', blocks: [RB] }] } }),
      wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [RB] } }),
      wrap({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersBlock', blocks: [RB] } }),
      para(inline({ case: 'link', value: { $typeName: 'nwfl.mensa.v1.Link', href: 'https://example.org/', inlines: [R] } })),
      para(inline({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersInline', inlines: [R] } })),
    ];
    for (const [n, block] of cases.entries()) expect(hasRedacted(doc(para(text('first')), block)), String(n)).toBe(true);
  });

  it('finds none in a tree without one, nor in no body', () => {
    const clean = doc(
      para(text('a'), link('https://example.org/', text('b')), inline({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersInline', inlines: [text('m')] } }), inline({ case: undefined })),
      wrap({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersBlock', blocks: [para(text('m'))] } }),
      wrap({ case: 'image', value: { $typeName: 'nwfl.mensa.v1.Image', fileId: 'f', alt: 'x' } }),
      wrap({ case: 'list', value: { $typeName: 'nwfl.mensa.v1.ListBlock', ordered: true, items: [{ $typeName: 'nwfl.mensa.v1.ListItem', blocks: [para(text('i'))] }] } }),
      wrap({ case: undefined }),
    );
    expect(hasRedacted(clean)).toBe(false);
    expect(hasRedacted(undefined)).toBe(false);
    expect(hasRedacted(doc())).toBe(false);
  });

  it('reads a tree nested past the depth cap as the public\'s: it fails closed', () => {
    let deep: Block = para(text('bottom'));
    for (let i = 0; i < 40; i++) deep = wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [deep] } });
    expect(hasRedacted(doc(deep))).toBe(true);
    let deepInline: Inline = text('bottom');
    for (let i = 0; i < 40; i++) deepInline = inline({ case: 'link', value: { $typeName: 'nwfl.mensa.v1.Link', href: 'https://example.org/', inlines: [deepInline] } });
    expect(hasRedacted(doc(para(deepInline)))).toBe(true);
    let emptyDeep: Block = wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [] } });
    for (let i = 0; i < 40; i++) emptyDeep = wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [emptyDeep] } });
    expect(hasRedacted(doc(emptyDeep))).toBe(true);
  });
});

// A14 round 2: a members node in any body proves the API read the caller as a member (filterForPublic never emits one).
describe('hasMembers', () => {
  const R: Inline = { $typeName: 'nwfl.mensa.v1.Inline', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const RB: Block = { $typeName: 'nwfl.mensa.v1.Block', kind: { case: 'redacted', value: { $typeName: 'nwfl.mensa.v1.Redacted' } } };
  const wrap = (kind: Block['kind']): Block => ({ $typeName: 'nwfl.mensa.v1.Block', kind });
  const inline = (kind: Inline['kind']): Inline => ({ $typeName: 'nwfl.mensa.v1.Inline', kind });
  const MB = wrap({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersBlock', blocks: [para(text('m'))] } });
  const MI = inline({ case: 'members', value: { $typeName: 'nwfl.mensa.v1.MembersInline', inlines: [text('m')] } });

  it('finds one anywhere: a block, an inline, in a heading, a list, a quote, a link, or beside a redacted node', () => {
    const cases: Block[] = [
      MB,
      para(text('a'), MI),
      wrap({ case: 'heading', value: { $typeName: 'nwfl.mensa.v1.Heading', level: 1, inlines: [MI] } }),
      wrap({ case: 'list', value: { $typeName: 'nwfl.mensa.v1.ListBlock', ordered: false, items: [{ $typeName: 'nwfl.mensa.v1.ListItem', blocks: [para(text('x'))] }, { $typeName: 'nwfl.mensa.v1.ListItem', blocks: [MB] }] } }),
      wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [MB] } }),
      para(inline({ case: 'link', value: { $typeName: 'nwfl.mensa.v1.Link', href: 'https://example.org/', inlines: [MI] } })),
    ];
    for (const [n, block] of cases.entries()) expect(hasMembers(doc(RB, para(text('first'), R), block)), String(n)).toBe(true);
  });

  it('finds none in a public tree, a redacted one, nor in no body', () => {
    const publicTree = doc(
      para(text('a'), link('https://example.org/', text('b')), R, inline({ case: undefined })),
      RB,
      wrap({ case: 'image', value: { $typeName: 'nwfl.mensa.v1.Image', fileId: 'f', alt: 'x' } }),
      wrap({ case: 'list', value: { $typeName: 'nwfl.mensa.v1.ListBlock', ordered: true, items: [{ $typeName: 'nwfl.mensa.v1.ListItem', blocks: [para(text('i'))] }] } }),
      wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [RB] } }),
      wrap({ case: 'heading', value: { $typeName: 'nwfl.mensa.v1.Heading', level: 2, inlines: [text('h')] } }),
      wrap({ case: undefined }),
    );
    expect(hasMembers(publicTree)).toBe(false);
    expect(hasMembers(undefined)).toBe(false);
    expect(hasMembers(doc())).toBe(false);
  });

  it('counts nothing nested past the depth cap: a tree too deep to read proves nothing (fails closed)', () => {
    let deep: Block = MB;
    for (let i = 0; i < 40; i++) deep = wrap({ case: 'quote', value: { $typeName: 'nwfl.mensa.v1.Quote', blocks: [deep] } });
    expect(hasMembers(doc(deep))).toBe(false);
    let deepInline: Inline = MI;
    for (let i = 0; i < 40; i++) deepInline = inline({ case: 'link', value: { $typeName: 'nwfl.mensa.v1.Link', href: 'https://example.org/', inlines: [deepInline] } });
    expect(hasMembers(doc(para(deepInline)))).toBe(false);
  });
});
