import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { type Block, type Document, DocumentSchema, type Inline } from '../gen/nwfl/mensa/v1/content_pb.js';
import { MEMBERS_PASSAGE, documentHtml, escapeHtml } from './document';

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
