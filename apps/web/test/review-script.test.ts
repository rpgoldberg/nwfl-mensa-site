// public/scripts/review.js is progressive enhancement for the review page (EDITOR E4, S7). Without it the
// page is a plain form. With it: each note typed (a link's, the note for the writer, the break-glass
// reason) is kept in the tab's sessionStorage (never localStorage), keyed by the item and the version it
// was typed on, and put back into an empty field when the page opens again (a sign-in that ran out, a
// reload); once the answers are saved, the notes of the links now answered are dropped; and the sign-in
// line turns to "Save now" for its last five minutes. Here it runs against small stand-ins.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOON_MS, wireReview } from '../public/scripts/review.js';

class Field extends EventTarget {
  value = '';
  readonly dataset: Record<string, string>;
  constructor(keep: string, extra: Record<string, string> = {}) {
    super();
    this.dataset = { keep, ...extra };
  }
  type(text: string) {
    this.value = text;
    this.dispatchEvent(new Event('input'));
  }
}

class Line {
  textContent = 'Your sign-in lasts until 3:00 pm Central time. Save before then.';
  constructor(readonly dataset: Record<string, string>) {}
}

class Storage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** A Yes or No radio button of one link's row, keyed by the row (N3). */
class Radio extends EventTarget {
  checked = false;
  readonly dataset: Record<string, string>;
  constructor(
    keep: string,
    readonly value: string,
    extra: Record<string, string> = {},
  ) {
    super();
    this.dataset = { keepChoice: keep, ...extra };
  }
  choose() {
    this.checked = true;
    this.dispatchEvent(new Event('change'));
  }
}

function page(fields: Field[], dataset: Record<string, string> = {}, line?: Line, radios: Radio[] = []) {
  const form = { dataset: { reviewKey: 'nwfl-review:item:abc', ...dataset }, querySelectorAll: (selector: string) => (selector === '[data-keep-choice]' ? radios : fields) };
  return { querySelector: (selector: string) => (selector === 'form[data-review]' ? form : selector === '[data-sign-in]' ? (line ?? null) : null) };
}

describe('wireReview', () => {
  it('keeps a Yes or No chosen and not saved, by row, and puts it back when the page opens again (N3)', () => {
    const storage = new Storage();
    const rows = () => [new Radio('answer:k0', 'yes'), new Radio('answer:k0', 'no'), new Radio('answer:k1', 'yes'), new Radio('answer:k1', 'no')];
    const first = rows();
    wireReview(page([], {}, undefined, first), { storage, now: () => 0, every: () => {} });
    first[1]!.choose();
    first[2]!.choose();
    // A change that leaves a button unchecked (the other of the pair) keeps nothing for it.
    first[0]!.dispatchEvent(new Event('change'));
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ 'answer:k0': 'no', 'answer:k1': 'yes' });

    // The server shows the answer saved before (yes on k0): the choice not yet saved wins.
    const again = rows();
    again[0]!.checked = true;
    wireReview(page([], {}, undefined, again), { storage, now: () => 0, every: () => {} });
    expect(again.map((r) => r.checked)).toEqual([false, true, true, false]);
  });

  it('drops every choice kept once answers are saved, or once the list came again; notes stay but for the answered rows (N3)', () => {
    const storage = new Storage();
    const stored = { 'answer:k0': 'no', 'answer:gone': 'yes', 'link:k0': 'saved with it', 'link:k1': 'not answered', note: 'for the writer' };
    storage.setItem('nwfl-review:item:abc', JSON.stringify(stored));
    const radios = [new Radio('answer:k0', 'yes', { answered: 'yes' }), new Radio('answer:k0', 'no', { answered: 'yes' })];
    wireReview(page([new Field('link:k0', { answered: 'yes' }), new Field('link:k1'), new Field('note')], { saved: 'yes' }, undefined, radios), { storage, now: () => 0, every: () => {} });
    expect(radios.map((r) => r.checked)).toEqual([false, false]);
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ 'link:k1': 'not answered', note: 'for the writer' });

    storage.setItem('nwfl-review:item:abc', JSON.stringify(stored));
    const relisted = [new Radio('answer:k0', 'yes'), new Radio('answer:k0', 'no')];
    const fields = [new Field('link:k0'), new Field('link:k1')];
    wireReview(page(fields, { relisted: 'yes' }, undefined, relisted), { storage, now: () => 0, every: () => {} });
    expect(relisted.map((r) => r.checked)).toEqual([false, false]);
    expect(fields.map((f) => f.value)).toEqual(['saved with it', 'not answered']);
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ 'link:k0': 'saved with it', 'link:k1': 'not answered', note: 'for the writer' });
  });

  it('keeps each note as it is typed, by the item and version, and puts it back into an empty field', () => {
    const storage = new Storage();
    const first = [new Field('link:https://club.example/a'), new Field('note')];
    wireReview(page(first), { storage, now: () => 0, every: () => {} });
    first[0]!.type('It shows the old park.');
    first[1]!.type('Please add the time.');
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ 'link:https://club.example/a': 'It shows the old park.', note: 'Please add the time.' });

    const again = [new Field('link:https://club.example/a'), new Field('note'), new Field('reason')];
    again[1]!.value = 'Typed on the server';
    wireReview(page(again), { storage, now: () => 0, every: () => {} });
    expect(again.map((f) => f.value)).toEqual(['It shows the old park.', 'Typed on the server', '']);
  });

  it('drops the notes of the links answered once the answers are saved, and keeps the rest', () => {
    const storage = new Storage();
    storage.setItem('nwfl-review:item:abc', JSON.stringify({ 'link:https://club.example/a': 'saved with its answer', 'link:https://club.example/b': 'no answer yet', note: 'for the writer' }));
    const fields = [new Field('link:https://club.example/a', { answered: 'yes' }), new Field('link:https://club.example/b'), new Field('note')];
    wireReview(page(fields, { saved: 'yes' }), { storage, now: () => 0, every: () => {} });
    expect(fields.map((f) => f.value)).toEqual(['', 'no answer yet', 'for the writer']);
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ 'link:https://club.example/b': 'no answer yet', note: 'for the writer' });
  });

  it('lives without storage, and without a form', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    const fields = [new Field('note')];
    wireReview(page(fields), { storage: broken, now: () => 0, every: () => {} });
    fields[0]!.type('Still typed');
    expect(fields[0]!.value).toBe('Still typed');
    const storage = new Storage();
    storage.setItem('nwfl-review:item:abc', 'not json');
    wireReview(page([new Field('note')]), { storage, now: () => 0, every: () => {} });
    expect(() => wireReview({ querySelector: () => null }, { storage, now: () => 0, every: () => {} })).not.toThrow();
  });

  it('turns the sign-in line to "Save now" for its last five minutes', () => {
    const line = new Line({ expires: '3600', soon: 'Your sign-in ends at 3:00 pm Central time. Save now.' });
    let tick: () => void = () => {};
    let now = 3600 * 1000 - SOON_MS - 1000;
    wireReview(page([], {}, line), { storage: new Storage(), now: () => now, every: (fn) => (tick = fn) });
    expect(line.dataset['state']).toBeUndefined();
    now += 2000;
    tick();
    expect(line.textContent).toBe('Your sign-in ends at 3:00 pm Central time. Save now.');
    expect(line.dataset['state']).toBe('soon');
  });

  it('forgets a note emptied, reads a stored copy that is no object as none, and says "Save now" with no words given as nothing', () => {
    const storage = new Storage();
    const fields = [new Field('note'), new Field('reason')];
    wireReview(page(fields), { storage, now: () => 0, every: () => {} });
    fields[0]!.type('Typed');
    fields[1]!.type('Why');
    fields[0]!.type('');
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ reason: 'Why' });
    fields[1]!.type('');
    expect(storage.getItem('nwfl-review:item:abc')).toBeNull();
    storage.setItem('nwfl-review:item:abc', 'null');
    const again = [new Field('note')];
    wireReview(page(again), { storage, now: () => 0, every: () => {} });
    expect(again[0]!.value).toBe('');
    const line = new Line({ expires: '1' });
    wireReview(page([], {}, line), { storage, now: () => 5000, every: () => {} });
    expect(line.textContent).toBe('');
    // A form with no key and a field with no name keep under the empty name, harmlessly.
    const bare = { querySelector: (sel: string) => (sel === 'form[data-review]' ? { dataset: { saved: 'yes' }, querySelectorAll: () => [Object.assign(new Field(''), { dataset: { answered: 'yes' } })] } : null) };
    expect(() => wireReview(bare, { storage, now: () => 0, every: () => {} })).not.toThrow();
  });
});

/** The script as a fresh module each time (a query makes it one), so it wires the page as it loads. */
const boot = (n: string) => new URL(`../public/scripts/review.js?boot=${n}`, import.meta.url).href;

describe('the script as the page loads it', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wires the page with the tab's sessionStorage and a timer, or with nothing kept when the browser refuses storage", async () => {
    const storage = new Storage();
    const field = new Field('note');
    const timers: number[] = [];
    vi.stubGlobal('document', page([field]));
    vi.stubGlobal('window', { sessionStorage: storage, setInterval: (_fn: () => void, ms: number) => timers.push(ms) });
    await import(/* @vite-ignore */ boot('1'));
    field.type('Kept in the tab');
    expect(JSON.parse(storage.getItem('nwfl-review:item:abc')!)).toEqual({ note: 'Kept in the tab' });
    vi.stubGlobal('window', {
      get sessionStorage() {
        throw new Error('denied');
      },
      setInterval: () => 0,
    });
    const other = new Field('note');
    vi.stubGlobal('document', page([other]));
    await import(/* @vite-ignore */ boot('2'));
    other.type('Not kept');
    expect(other.value).toBe('Not kept');
  });
});
