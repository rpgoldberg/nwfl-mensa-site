// BOXLABEL fix round 3 (R3-1): a name read one way by pdf-lib and another by pdf.js and PDFium. pdf-lib's parser
// decodes a name's #XX twice (in either case, then PDFName.of again in upper case); the readers decode once. So the
// raw key "/FXF#2332" is FXF#32 to the readers and FXF2 to pdf-lib, and "/FXF#232332", which pdf-lib reads as FXF#32,
// comes out of the gate's own writing as "/FXF#2332". The gate refuses, as "rules", any copy holding a name that
// still holds '#' once decoded, or a dictionary with a key twice; the engine gives no such copy. Every name is made
// up. These PDFs are adversarial in shape: run this file only in the capped container.
import { type PDFContext, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef, decodePDFRawStream } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { labelMarks, unlabelled } from '../../src/pdf/gate-labels.js';
import { copyRulesBreak, gateReply, gateVerdict, rewrite } from '../../src/pdf/gate-rules.js';
import { nameBreak } from '../../src/pdf/pdf-structure.js';
import { redactPdf } from '../../src/pdf/redact.js';
import { twoMarksFixture } from './fixtures.js';

const load = (pdf: Uint8Array): Promise<PDFDocument> => PDFDocument.load(pdf, { updateMetadata: false });
const LABEL_OP = /q 1 1 1 rg 0 G 1 0 0 1 \S+ \S+ cm BT 1 0 0 1 0 0 Tm \/(\S+) \S+ Tf 0 Tr <[0-9A-F]+> Tj ET Q/;
const HELVETICA = { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } as const;
const RULES = { pass: false, code: 'rules' };
const byte = (code: number): string => code.toString(16).toUpperCase().padStart(2, '0');

/** The engine's copy of two lines, "Quillon" withheld by members too, so its box says "Private". */
async function quillon(): Promise<{ original: Uint8Array; pdf: Uint8Array }> {
  const original = await twoMarksFixture();
  const result = await redactPdf(original, { quotes: ['Quillon'], membersWithhold: [true], redactsAny: true });
  if (result.kind !== 'redacted') throw new Error(JSON.stringify(result));
  return { original, pdf: result.pdf };
}
const job = (copy: Uint8Array, original: Uint8Array, image: 'show' | 'blur' | 'hide' = 'show') => ({ copy, original, quotes: ['Quillon'], image });

function contentRef(doc: PDFDocument): PDFRef {
  return doc.getPage(0).node.get(PDFName.of('Contents')) as PDFRef;
}
const contentText = (doc: PDFDocument): string => Buffer.from(decodePDFRawStream(doc.context.lookup(contentRef(doc)) as PDFRawStream).decode()).toString('latin1');
const resources = (doc: PDFDocument): PDFDict => doc.getPage(0).node.Resources() as PDFDict;
const kind = (doc: PDFDocument, key: string): PDFDict => {
  const found = resources(doc).lookupMaybe(PDFName.of(key), PDFDict);
  if (found !== undefined) return found;
  const made = doc.context.obj({});
  resources(doc).set(PDFName.of(key), made);
  return made;
};

/** The copy as `edit` leaves it (and its page's content as `content` writes it), saved by pdf-lib. */
async function edited(pdf: Uint8Array, edit: (doc: PDFDocument, label: string) => void, content?: (text: string) => string, labelled = true): Promise<Uint8Array> {
  const doc = await load(pdf);
  const text = labelled ? contentText(doc) : '';
  edit(doc, labelled ? ((LABEL_OP.exec(text) as RegExpExecArray)[1] as string) : '');
  if (content !== undefined) doc.context.assign(contentRef(doc), doc.context.flateStream(Buffer.from(content(text), 'latin1')));
  return doc.save({ useObjectStreams: false });
}

/** The bytes with `from` (once in them) turned to `to`, of the same length, so every xref offset still lands. */
function rawPatch(pdf: Uint8Array, from: string, to: string): Uint8Array {
  const text = Buffer.from(pdf).toString('latin1');
  if (from.length !== to.length || text.split(from).length !== 2) throw new Error(`cannot patch ${from}`);
  return new Uint8Array(Buffer.from(text.replace(from, to), 'latin1'));
}

/** The challenger's lying font: Helvetica whose /Differences draw `glyphs` under the label's codes, read as the label. */
function lyingFont(context: PDFContext, label: string, glyphs: string): PDFRef {
  const byCode = new Map([...label].map((ch, i) => [ch.charCodeAt(0), glyphs[i] ?? ' ']));
  const differences = [...byCode].sort((a, b) => a[0] - b[0]).flatMap(([code, glyph]) => [code, glyph === ' ' ? 'space' : glyph]);
  const pairs = [...byCode.keys()].map((code) => `<${byte(code)}> <00${byte(code)}>`);
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Lie def /CIDSystemInfo << /Registry (L) /Ordering (L) /Supplement 0 >> def 1 begincodespacerange <00> <FF> endcodespacerange ${pairs.length} beginbfchar ${pairs.join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  return context.register(context.obj({ ...HELVETICA, Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: differences }, ToUnicode: context.register(context.flateStream(cmap)) }));
}

/**
 * The copy with `first` under the key `key` and then `second` under a key written raw as `rawKey` in the same list of
 * `kind`, which pdf-lib (or its own writing) reads as `key` too: the last wins in pdf-lib, the first for the readers.
 */
async function collided(pdf: Uint8Array, list: string, key: (label: string) => string, rawKey: string, first: (c: PDFContext) => PDFObject, second: (c: PDFContext) => PDFObject, content?: (text: string) => string): Promise<Uint8Array> {
  const placeholder = `Q${'q'.repeat(rawKey.length - 1)}`;
  const bytes = await edited(
    pdf,
    (doc, label) => {
      const dict = kind(doc, list);
      dict.delete(PDFName.of(key(label)));
      dict.set(PDFName.of(key(label)), first(doc.context));
      dict.set(PDFName.of(placeholder), second(doc.context));
    },
    content,
  );
  return rawPatch(bytes, `/${placeholder} `, `/${rawKey} `);
}

/** Forms nested `depth` deep, each drawing the next by the name N; the outermost by reference. */
function nestedForms(context: PDFContext, depth: number): PDFRef {
  let inner = context.register(context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));
  for (let level = 1; level < depth; level++) inner = context.register(context.flateStream('/N Do', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], Resources: { XObject: { N: inner } } }));
  return inner;
}
const emptyForm = (context: PDFContext): PDFRef => context.register(context.flateStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }));

const HASH = 'a name holds "#" once decoded, so pdf-lib reads it apart from pdf.js and PDFium';
const NESTED = 'the names cannot all be read: dictionaries and arrays nest too deep';
const UNREAD = 'the names cannot all be read';

/** One indirect object written raw as `deep` (a placeholder name of its length, patched after saving). */
function deepObject(doc: PDFDocument, deep: string): string {
  const filler = `D${'d'.repeat(deep.length - 2)}`;
  doc.context.register(PDFName.of(filler));
  return `/${filler}`;
}

/** A one-page PDF as `edit` leaves it, with `from` patched to `to` and, if given, a deep object patched in. */
async function placed(edit: (doc: PDFDocument) => void, from?: string, to?: string, deep?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([612, 792]);
  edit(doc);
  let bytes: Uint8Array = await doc.save({ useObjectStreams: false });
  if (from !== undefined && to !== undefined) bytes = rawPatch(bytes, from, to);
  if (deep !== undefined) bytes = rawPatch(bytes, `/D${'d'.repeat(deep.length - 2)}`, deep);
  return bytes;
}

/** As collided, with `deep` written raw in an object before the list, which is written again last. */
async function deepCollided(pdf: Uint8Array, list: string, key: (label: string) => string, rawKey: string, first: (c: PDFContext) => PDFObject, second: (c: PDFContext) => PDFObject, deep: string, content?: (text: string) => string): Promise<Uint8Array> {
  const placeholder = `Q${'q'.repeat(rawKey.length - 1)}`;
  let filler = '';
  const bytes = await edited(
    pdf,
    (doc, label) => {
      filler = deepObject(doc, deep);
      const fresh = doc.context.obj({});
      for (const [name, value] of kind(doc, list).entries()) fresh.set(name, value);
      fresh.delete(PDFName.of(key(label)));
      fresh.set(PDFName.of(key(label)), first(doc.context));
      fresh.set(PDFName.of(placeholder), second(doc.context));
      resources(doc).set(PDFName.of(list), doc.context.register(fresh));
    },
    content,
  );
  const text = Buffer.from(bytes).toString('latin1');
  if (!(text.indexOf(filler) < text.indexOf(`/${placeholder} `))) throw new Error('the deep object is not before the list');
  return rawPatch(rawPatch(bytes, `/${placeholder} `, `/${rawKey} `), filler, deep);
}

describe('R3-1: a font key pdf-lib decodes twice (the challenger\'s chal3-dd cases)', () => {
  // The label's own font (FXF2, PDFium's name) is made the lying font; a raw key holding PDFium's honest Helvetica,
  // written after it, reads as FXF2 to pdf-lib. The label op is exactly as PDFium wrote it.
  it.each([
    ['FXF#232332', 'pdf-lib reads FXF#32; the gate\'s own writing, "/FXF#2332", reads as FXF2 to pdf-lib'],
    ['FXF#2332', 'pdf-lib reads FXF2, the readers FXF#32'],
  ])('refuses the copy whose raw key %s holds PDFium\'s font after the lying one (%s): "rules", and nothing stored', async (rawKey) => {
    const { original, pdf } = await quillon();
    const bad = await collided(pdf, 'Font', (label) => label, rawKey, (c) => lyingFont(c, 'Private', 'Quillon'), (c) => c.register(c.obj({ ...HELVETICA })));
    expect((LABEL_OP.exec(contentText(await load(bad))) as RegExpExecArray)[1]).toBe('FXF2');
    expect.soft(await gateVerdict(job(bad, original))).toEqual(RULES);
    const reply = await gateReply(job(bad, original));
    expect.soft(reply.verdict).toEqual(RULES);
    expect.soft(reply.checked).toBeUndefined();
    expect(await nameBreak(bad)).not.toBeNull();
    expect(await copyRulesBreak(bad, 'show')).toMatch(/^the structure: /);
    // What the gate's writing would have been: the first case's carries the collision into the bytes, and is refused too.
    const written = await rewrite(bad);
    expect(await gateVerdict(job(written, original))).toEqual(rawKey === 'FXF#232332' ? RULES : { pass: true });
  });

  it('leaves the engine\'s copy alone: it passes, and the bytes stored are the gate\'s own writing', async () => {
    const { original, pdf } = await quillon();
    expect(await copyRulesBreak(pdf, 'show')).toBeNull();
    const reply = await gateReply(job(pdf, original));
    expect(reply.verdict).toEqual({ pass: true });
    expect(reply.checked?.pdf).toEqual(await rewrite(pdf));
    expect(await nameBreak(pdf)).toBeNull();
  });
});

describe('R3-1: every name, not only fonts', () => {
  it('refuses an ExtGState key pdf-lib reads twice, which hid a graphics state that is not a dictionary (F4) from the gate\'s writing', async () => {
    const { original, pdf } = await quillon();
    const bad = await collided(pdf, 'ExtGState', () => 'GS1', 'GS#232331', (c) => c.register(c.flateStream('', { Type: 'ExtGState' })), (c) => c.obj({ Type: 'ExtGState' }));
    expect(await gateVerdict(job(bad, original))).toEqual(RULES);
    const reply = await gateReply(job(bad, original));
    expect(reply.verdict).toEqual(RULES);
    expect(reply.checked).toBeUndefined();
  });

  it('refuses an XObject key pdf-lib reads twice, which hid forms nested past the cap from the gate\'s writing', async () => {
    const { original, pdf } = await quillon();
    const bad = await collided(pdf, 'XObject', () => 'Fm1', 'Fm#232331', (c) => nestedForms(c, 40), emptyForm, (text) => `${text}\nq /Fm1 Do Q\n`);
    expect(await gateVerdict(job(bad, original))).toEqual(RULES);
    const reply = await gateReply(job(bad, original));
    expect(reply.verdict).toEqual(RULES);
    expect(reply.checked).toBeUndefined();
    // Under its plain name the nesting alone is refused, as before.
    const plain = await edited(pdf, (doc) => kind(doc, 'XObject').set(PDFName.of('Fm1'), nestedForms(doc.context, 40)), (text) => `${text}\nq /Fm1 Do Q\n`);
    expect(await gateVerdict(job(plain, original))).toEqual(RULES);
  });

  it('refuses a name value that holds "#" once decoded, and a key written twice in one dictionary', async () => {
    const { original, pdf } = await quillon();
    const value = await edited(pdf, (doc) => doc.getPage(0).node.set(PDFName.of('PZ'), PDFName.of('a#b')));
    expect(Buffer.from(value).toString('latin1')).toContain('/a#23b');
    expect((await gateReply(job(value, original))).verdict).toEqual(RULES);
    // The page's fonts are FXF1 and FXF2; FXF1 written as FXF2 is a key twice, which every reader takes the last of.
    const twice = rawPatch(pdf, '/FXF1 ', '/FXF2 ');
    expect(await gateVerdict(job(twice, original))).toEqual(RULES);
    expect((await gateReply(job(twice, original))).verdict).toEqual(RULES);
    expect(await nameBreak(value)).toMatch(/#/);
    expect(await nameBreak(twice)).toMatch(/twice/);
    expect(await copyRulesBreak(value, 'show')).toBe('the structure: a name holds "#" once decoded, so pdf-lib reads it apart from pdf.js and PDFium');
    expect(await copyRulesBreak(twice, 'show')).toBe('the structure: a dictionary has a key twice');
  });

  it('refuses a name in a content stream that holds "#" once decoded, under every policy, but not "#" in a string', async () => {
    const { original, pdf } = await quillon();
    const named = await edited(pdf, () => undefined, (text) => `${text}\nq /GS#2331 gs Q\n`);
    for (const image of ['show', 'blur', 'hide'] as const) expect(await gateVerdict(job(named, original, image))).toEqual(RULES);
    expect(await copyRulesBreak(named, 'show')).toMatch(/name/);
    const string = await edited(pdf, () => undefined, (text) => `${text}\nBT /FXF1 10 Tf 72 100 Td (see example.org/a#top and /b#23c) Tj ET\n`);
    expect(await copyRulesBreak(string, 'show')).toBeNull();
    expect(await gateVerdict(job(string, original))).toEqual({ pass: true });
  });

  it('refuses such a copy as "rules" before anything else, even one whose text shows a quote', async () => {
    const { original } = await quillon();
    const shown = await edited(original, (doc) => doc.getPage(0).node.set(PDFName.of('PZ'), PDFName.of('a#b')), undefined, false);
    expect(await gateVerdict(job(shown, original))).toEqual(RULES);
  });

  it('keeps a name break found before the point pdf-lib stops parsing; refuses what it cannot read to the end', async () => {
    const cut = Buffer.from('%PDF-1.7\n1 0 obj\n<< /A /a#23b >>\nendobj\n2 0 obj\n<< /B (never closed', 'latin1');
    expect(await nameBreak(new Uint8Array(cut))).toMatch(/#/);
    // Fail closed (round 4, B1): a copy whose names cannot all be read is refused, never passed as holding none.
    const unclosed = Buffer.from('%PDF-1.7\n1 0 obj\n<< /A /a >>\nendobj\n2 0 obj\n<< /B (never closed', 'latin1');
    expect(await nameBreak(new Uint8Array(unclosed))).toBe(UNREAD);
    expect(await nameBreak(new Uint8Array(Buffer.from('not a pdf', 'latin1')))).toBe(UNREAD);
  });

  // N1 (round 4): one name each, with no other break beside it.
  it('refuses a lone key whose pdf-lib value holds no "#" but whose once-decoded form does, and a value that starts with "#"', async () => {
    const key = await placed((doc) => doc.getPage(0).node.set(PDFName.of('Xqqqqq'), PDFName.of('Plain')), '/Xqqqqq ', '/X#2341 ');
    expect(await nameBreak(key)).toBe(HASH);
    const value = await placed((doc) => doc.getPage(0).node.set(PDFName.of('PZ'), PDFName.of('Vqqqq')), '/Vqqqq', '/#2323');
    expect(await nameBreak(value)).toBe(HASH);
    expect(await nameBreak(await placed(() => undefined))).toBeNull();
  });
});

describe('B1 (round 4): nameBreak fails closed on nesting, whatever the stack', () => {
  const dicts = (depth: number): string => `${'<</A'.repeat(depth - 1)}<<>>${'>>'.repeat(depth - 1)}`;
  const arrays = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

  it('reads 256 levels of dictionaries or arrays, and refuses 257, counted together', async () => {
    const at = async (deep: string): Promise<string | null> => nameBreak(await placed((doc) => void deepObject(doc, deep), undefined, undefined, deep));
    expect(await at(dicts(256))).toBeNull();
    expect(await at(arrays(256))).toBeNull();
    expect(await at(dicts(257))).toBe(NESTED);
    expect(await at(arrays(257))).toBe(NESTED);
    expect(await at(`${'<</A['.repeat(128)}<<>>${']>>'.repeat(128)}`)).toBe(NESTED);
    expect(await at(`${'<</A['.repeat(127)}<</A<<>>>>${']>>'.repeat(127)}`)).toBeNull();
  });

  // The challenger's chal4-deep2 cases: one object nested deep, written before the resource list that holds a key
  // pdf-lib reads twice. On f50b495 the parser behind nameBreak ran out of stack where pdf-lib's own load does not,
  // and the copy passed and was stored.
  const CASES: Array<[string, string, (label: string) => string, string, (c: PDFContext) => PDFObject, (c: PDFContext) => PDFObject, ((text: string) => string) | undefined]> = [
    ['Font', 'FXF#2332', (label) => label, 'FXF#2332', (c) => lyingFont(c, 'Private', 'Quillon'), (c) => c.register(c.obj({ ...HELVETICA })), undefined],
    ['XObject', 'Fm#232331', () => 'Fm1', 'Fm#232331', (c) => nestedForms(c, 40), emptyForm, (text) => `${text}\nq /Fm1 Do Q\n`],
    ['ExtGState', 'GS#232331', () => 'GS1', 'GS#232331', (c) => c.register(c.flateStream('', { Type: 'ExtGState' })), (c) => c.obj({ Type: 'ExtGState' }), undefined],
  ];
  const DEPTHS: Array<[string, string]> = [
    ['a dictionary 300 deep', dicts(300)],
    ['a dictionary 1600 deep', dicts(1600)],
    ['a dictionary 1800 deep', dicts(1800)],
    ['a dictionary 2100 deep', dicts(2100)],
    ['an array 3000 deep', arrays(3000)],
  ];
  it.each(CASES.flatMap(([list, tag, key, rawKey, first, second, content]) => DEPTHS.map(([what, deep]) => [what, tag, list, key, rawKey, first, second, content, deep] as const)))(
    'refuses %s before a %s collision: "rules" at the verdict and the reply, and nothing stored',
    async (_what, _tag, list, key, rawKey, first, second, content, deep) => {
      const { original, pdf } = await quillon();
      const bad = await deepCollided(pdf, list, key, rawKey, first, second, deep, content);
      expect.soft(await nameBreak(bad)).toBe(NESTED);
      expect.soft(await gateVerdict(job(bad, original))).toEqual(RULES);
      const reply = await gateReply(job(bad, original));
      expect.soft(reply.verdict).toEqual(RULES);
      expect(reply.checked).toBeUndefined();
    },
    120_000,
  );
});

describe('B1 (round 4): the other reader that recurses fails closed', () => {
  // gate-labels.ts contentRefs, which reads a page's content streams for its labels, recurses into a list of them. It
  // is read only when the text check finds a quote; on a list that holds itself it runs out of stack, and every caller
  // takes the throw as no copy ("unfinished"). A quote that is a label's own text makes the gate read it.
  it('refuses, and stores nothing of, a copy whose page lists its content streams in a list that holds itself, when it reads the labels', async () => {
    const { original, pdf } = await quillon();
    const marks = await labelMarks(pdf);
    if (typeof marks === 'string') throw new Error(marks);
    const cyclic = await edited(pdf, (doc) => {
      const list = doc.context.obj([contentRef(doc)]);
      const ref = doc.context.register(list);
      list.push(ref);
      doc.getPage(0).node.set(PDFName.of('Contents'), ref);
    });
    await expect(unlabelled(cyclic, marks)).rejects.toThrow(RangeError);
    const labelled = (copy: Uint8Array) => ({ ...job(copy, original), quotes: ['Private'] });
    expect(await gateVerdict(labelled(pdf))).toEqual({ pass: true });
    expect(await gateVerdict(labelled(cyclic))).toEqual({ pass: false, code: 'unfinished' });
    const reply = await gateReply(labelled(cyclic));
    expect(reply.verdict).toEqual({ pass: false, code: 'unfinished' });
    expect(reply.checked).toBeUndefined();
  });
});

describe('R3-1: the engine gives no copy whose names pdf-lib reads apart from the readers', () => {
  it('refuses a copy whose page keeps a font named with "#" (pdf-lib would read the key apart from the content)', async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const { context } = doc;
    const marked = doc.addPage([612, 792]);
    marked.node.setFontDictionary(PDFName.of('F1'), context.register(context.obj(HELVETICA)));
    marked.node.set(PDFName.of('Contents'), context.register(context.flateStream('BT /F1 12 Tf 72 700 Td (Phone Quillon now about the picnic.) Tj ET')));
    const other = doc.addPage([612, 792]);
    other.node.setFontDictionary(PDFName.of('F#1'), context.register(context.obj(HELVETICA)));
    other.node.set(PDFName.of('Contents'), context.register(context.flateStream('BT /F#231 12 Tf 72 700 Td (Nothing withheld here.) Tj ET')));
    const original = await doc.save({ useObjectStreams: false });
    const result = await redactPdf(original, { quotes: ['Quillon'], membersWithhold: [true], redactsAny: true });
    expect(result.kind).toBe('refused');
    expect(result.kind === 'refused' ? result.reason : '').toBe('a name holds "#" once decoded, so pdf-lib reads it apart from pdf.js and PDFium');
  });

  it('labels are found and taken out of the engine\'s copy as before', async () => {
    const { pdf } = await quillon();
    const marks = await labelMarks(pdf);
    if (typeof marks === 'string') throw new Error(marks);
    expect(await unlabelled(pdf, marks)).toBeInstanceOf(Uint8Array);
  });
});
