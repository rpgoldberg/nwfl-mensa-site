// Small stand-ins for the browser and pdf.js, for public/scripts/viewer.js (test/viewer-script.test.ts).
// Only what the viewer touches: elements by their data attributes, canvases, an IntersectionObserver
// the test drives by hand, and a pdf.js whose pages draw at once (or when the test lets them).

export class FakeStyle {
  readonly props = new Map<string, string>();
  width = '';
  height = '';
  left = '';
  top = '';
  setProperty(name: string, value: string) {
    this.props.set(name, value);
  }
}

export class FakeEl extends EventTarget {
  children: FakeEl[] = [];
  parent: FakeEl | undefined;
  readonly attrs = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = new FakeStyle();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    contains: (n: string) => this.classes.has(n),
    toggle: (n: string, on: boolean) => {
      if (on) this.classes.add(n);
      else this.classes.delete(n);
      return on;
    },
  };
  hidden = false;
  #text = '';
  value = '';
  id = '';
  href = '';
  rel = '';
  width = 0;
  height = 0;
  rect = { top: 0, height: 100, width: 600 };
  scrolled = 0;
  scrolledInto: unknown[] = [];
  scrollLeft = 0;
  scrollWidth = 0;
  focused = false;
  /** What a canvas's context drew: drawImage's arguments. */
  drawn: unknown[][] = [];
  captured: number[] = [];
  onclick: (() => boolean) | null = null;
  constructor(readonly tag: string) {
    super();
  }
  get tagName() {
    return this.tag.toUpperCase();
  }
  selected = false;
  select() {
    this.selected = true;
  }
  set className(name: string) {
    for (const n of name.split(' ')) this.classes.add(n);
  }
  get className() {
    return [...this.classes].join(' ');
  }
  /** A text node is a FakeEl of tag #text. */
  get textContent(): string {
    return this.children.length > 0 ? this.children.map((k) => k.textContent).join('') : this.#text;
  }
  set textContent(text: string) {
    this.children = [];
    this.#text = text;
  }
  append(...kids: (FakeEl | string)[]) {
    for (const k of kids) {
      const kid = typeof k === 'string' ? Object.assign(new FakeEl('#text'), { textContent: k }) : k;
      kid.parent = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids: (FakeEl | string)[]) {
    this.children = [];
    this.append(...kids);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this);
    this.parent = undefined;
  }
  setAttribute(name: string, value: string) {
    this.attrs.set(name, String(value));
    if (name === 'href') this.href = String(value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attrs.has(name);
  }
  removeAttribute(name: string) {
    this.attrs.delete(name);
  }
  contains(other: unknown): boolean {
    return other === this || [...this.all()].includes(other as FakeEl);
  }
  *all(): Generator<FakeEl> {
    for (const kid of this.children) {
      yield kid;
      yield* kid.all();
    }
  }
  /** `[data-x]`, or a tag name. */
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel: string): FakeEl[] {
    const attr = /^\[([\w-]+)\]$/.exec(sel)?.[1];
    return [...this.all()].filter((el) => (attr ? el.attrs.has(attr) : el.tag === sel));
  }
  closest(tag: string): FakeEl | null {
    let at: FakeEl | undefined = this.parent;
    while (at && at.tag !== tag) at = at.parent;
    return at ?? null;
  }
  getBoundingClientRect() {
    return { top: this.rect.top, bottom: this.rect.top + this.rect.height, height: this.rect.height, width: this.rect.width };
  }
  get clientWidth() {
    return this.rect.width;
  }
  get offsetHeight() {
    return this.rect.height;
  }
  /** A layout a test gives a bar control: whether it is shown, and its top (the row it sits on). */
  layout: { shown: () => boolean; top: () => number } | undefined;
  getClientRects() {
    return this.layout && !this.layout.shown() ? [] : [this.getBoundingClientRect()];
  }
  get offsetTop() {
    return this.layout?.top() ?? 0;
  }
  scrollIntoView(options?: unknown) {
    this.scrolled++;
    this.scrolledInto.push(options);
  }
  /** False for an element the browser will not focus (display: none, as a More item the bar shows). */
  focusable = true;
  focus() {
    if (!this.focusable) return;
    const doc = FakeDoc.current;
    if (doc?.activeElement && doc.activeElement !== this) doc.activeElement.focused = false;
    this.focused = true;
    if (doc) doc.activeElement = this;
  }
  blur() {
    this.focused = false;
    if (FakeDoc.current?.activeElement === this) FakeDoc.current.activeElement = null;
  }
  setPointerCapture(id: number) {
    this.captured.push(id);
  }
  getContext() {
    return { canvas: this, drawImage: (...args: unknown[]) => this.drawn.push(args) };
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
}

export class FakeDoc extends EventTarget {
  /** The document focus() reports to: the last one made. */
  static current: FakeDoc | undefined;
  readonly created: FakeEl[] = [];
  activeElement: FakeEl | null = null;
  readonly documentElement = new FakeEl('html');
  constructor(readonly body: FakeEl) {
    super();
    FakeDoc.current = this;
  }
  querySelector(sel: string) {
    return this.body.querySelector(sel);
  }
  createElement(tag: string) {
    const el = new FakeEl(tag);
    this.created.push(el);
    return el;
  }
}

export class FakeObserver {
  static last: FakeObserver | undefined;
  readonly watched: FakeEl[] = [];
  constructor(
    readonly callback: (entries: { target: FakeEl; isIntersecting: boolean }[]) => void,
    readonly options: unknown,
  ) {
    FakeObserver.last = this;
  }
  observe(el: FakeEl) {
    this.watched.push(el);
  }
  disconnect() {}
  /** Pages `near` come close; every other watched page is far. */
  near(...near: number[]) {
    this.callback(this.watched.map((target, i) => ({ target, isIntersecting: near.includes(i + 1) })));
  }
}

/** The browser's ResizeObserver, driven by hand: `resized()` says each watched element changed size. */
export class FakeResizeObserver {
  static last: FakeResizeObserver | undefined;
  readonly watched: FakeEl[] = [];
  constructor(readonly callback: () => void) {
    FakeResizeObserver.last = this;
  }
  observe(el: FakeEl) {
    this.watched.push(el);
  }
  resized() {
    this.callback();
  }
}

/** A media query's answer, which the test changes (FakeWin.setMedia), telling its listeners. */
export class FakeMedia extends EventTarget {
  constructor(
    readonly media: string,
    public matches: boolean,
  ) {
    super();
  }
}

/** The browser's MutationObserver, driven by hand: `changed()` calls back as an attribute change would. */
export class FakeMutationObserver {
  static last: FakeMutationObserver | undefined;
  readonly watched: { el: FakeEl; options: unknown }[] = [];
  constructor(readonly callback: () => void) {
    FakeMutationObserver.last = this;
  }
  observe(el: FakeEl, options: unknown) {
    this.watched.push({ el, options });
  }
  changed() {
    this.callback();
  }
}

export class FakeWin extends EventTarget {
  devicePixelRatio = 2;
  innerHeight = 800;
  phone = false;
  scrolledBy = 0;
  scrolledX = 0;
  readonly location = { hash: '', origin: 'https://site.example' };
  readonly IntersectionObserver = FakeObserver;
  MutationObserver: typeof FakeMutationObserver | undefined = FakeMutationObserver;
  readonly medias = new Map<string, FakeMedia>();
  matchMedia(query: string) {
    let media = this.medias.get(query);
    if (!media) {
      media = new FakeMedia(query, false);
      this.medias.set(query, media);
    }
    return media;
  }
  setMedia(query: string, matches: boolean) {
    const media = this.matchMedia(query);
    media.matches = matches;
    media.dispatchEvent(new Event('change'));
  }
  requestAnimationFrame(fn: () => void) {
    fn();
    return 1;
  }
  scrollBy(x: number, y: number) {
    this.scrolledX += x;
    this.scrolledBy += y;
  }
}

export interface FakeAnnotation {
  id: string;
  annotationType: number;
  url?: string;
  dest?: unknown;
  contentsObj?: { str: string };
}

/** pdf.js: pages of 612 x 792 pt; `hold` keeps every drawing pending until the test lets it go. */
export function fakePdfjs({
  pages = 3,
  annotations = {} as Record<number, FakeAnnotation[]>,
  fail = false,
  hold = false,
  sizes = {} as Record<number, [number, number]>,
  texts = {} as Record<number, { str: string; hasEOL?: boolean }[] | 'fail'>,
  images = {} as Record<number, number[]>,
  ops = {} as Record<number, number[] | 'fail' | 'hold'>,
} = {}) {
  const log: string[] = [];
  const renders: Record<string, unknown>[] = [];
  /** Pages whose drawing list was read, in order. */
  const lists: number[] = [];
  /** Drawing lists held back (ops 'hold'): each lets its list go, with no pictures. */
  const heldLists: (() => void)[] = [];
  const itemsOf = (n: number) => {
    const t = texts[n];
    return t === 'fail' ? [] : (t ?? [{ str: `text of ${n}`, hasEOL: false }]);
  };
  const pending: (() => void)[] = [];
  const opened: unknown[] = [];
  const page = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => {
      const [w, h] = sizes[n] ?? [612, 792];
      const viewport = { width: w * scale, height: h * scale, scale, clone: () => viewport };
      return viewport;
    },
    getOperatorList: () => {
      lists.push(n);
      const o = ops[n];
      // By default, one image drawn for each picture recorded.
      const drawn = o ?? Array.from({ length: (images[n]?.length ?? 0) / 6 }, () => 85);
      if (drawn === 'hold') return new Promise((resolve) => heldLists.push(() => resolve({ fnArray: [], argsArray: [] })));
      return drawn === 'fail' ? Promise.reject(new Error('no list')) : Promise.resolve({ fnArray: drawn, argsArray: [] });
    },
    get imageCoordinates() {
      return images[n] === undefined ? undefined : new Float32Array(images[n]);
    },
    render: (params: { canvas: FakeEl; transform?: number[] }) => {
      renders.push(params);
      log.push(`draw ${n} ${params.canvas.width}x${params.canvas.height}${params.transform ? ` x${params.transform[0]}` : ''}`);
      let cancel = () => {};
      const promise = new Promise<void>((resolve, reject) => {
        cancel = () => reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
        if (hold) pending.push(resolve);
        else resolve();
      });
      return {
        promise,
        cancel: () => {
          log.push(`cancel ${n}`);
          cancel();
        },
      };
    },
    streamTextContent: () => itemsOf(n),
    getTextContent: (options: unknown) => {
      log.push(`text ${n} ${JSON.stringify(options)}`);
      return texts[n] === 'fail' ? Promise.reject(new Error('no text')) : Promise.resolve({ items: [{ type: 'beginMarkedContent' }, ...itemsOf(n), { type: 'endMarkedContent' }] });
    },
    getAnnotations: () => Promise.resolve(annotations[n] ?? []),
    cleanup: () => log.push(`cleanup ${n}`),
  });
  const doc = {
    numPages: pages,
    getPage: (n: number) => Promise.resolve(page(n)),
    getDestination: (name: string) => Promise.resolve(name === 'third' ? [{ num: 3, gen: 0 }, { name: 'XYZ' }] : null),
    getPageIndex: (ref: { num: number }) => Promise.resolve(ref.num - 1),
  };
  const pdfjs = {
    GlobalWorkerOptions: { workerSrc: '' },
    AnnotationType: { LINK: 2, WIDGET: 20 },
    OPS: { paintImageXObject: 85, paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88 },
    getDocument: (options: unknown) => {
      opened.push(options);
      // pdf.js 6: the loading task, not the document, is what lets a file go (destroy).
      return {
        promise: fail ? Promise.reject(new Error('Invalid PDF structure')) : Promise.resolve(doc),
        destroy: () => {
          log.push('destroy');
          return Promise.resolve();
        },
      };
    },
    // As pdf.js's: one span for each text item, and each item's text, in order (textDivs, textContentItemsStr).
    TextLayer: class {
      textDivs: FakeEl[] = [];
      textContentItemsStr: string[] = [];
      constructor(readonly o: { textContentSource: { str: string }[]; container: FakeEl }) {}
      render() {
        for (const item of this.o.textContentSource) {
          const span = new FakeEl('span');
          span.textContent = item.str;
          this.textDivs.push(span);
          this.textContentItemsStr.push(item.str);
          this.o.container.append(span);
        }
        return Promise.resolve();
      }
    },
    AnnotationLayer: class {
      constructor(readonly o: { div: FakeEl }) {}
      render(params: { annotations: FakeAnnotation[]; linkService: { addLinkAttributes(a: FakeEl, url: string): void; getDestinationHash(d: unknown): string; goToDestination(d: unknown): Promise<void> } }) {
        for (const data of params.annotations) {
          const section = new FakeEl('section');
          const a = new FakeEl('a');
          a.setAttribute('data-element-id', data.id);
          if (data.url) params.linkService.addLinkAttributes(a, data.url);
          else {
            a.setAttribute('href', params.linkService.getDestinationHash(data.dest));
            a.onclick = () => {
              void params.linkService.goToDestination(data.dest);
              return false;
            };
          }
          section.append(a);
          this.o.div.append(section);
        }
        return Promise.resolve();
      }
    },
  };
  return { pdfjs, log, pending, opened, renders, lists, heldLists };
}

/** What a picker's button shows (W-LOOK3: the page and zoom pickers). */
export const chosen = (button: FakeEl | undefined) => button!.textContent;
/** Presses the choice of this value in a picker's list. */
export const pick = (list: FakeEl | undefined, value: string) => list!.children.find((o) => o.value === value)!.click();

/** The More menu's copies of the bar's controls, by what each does (data-viewer-act). */
export const MENU_ACTS = ['find', 'zoom-out', 'zoom-in', 'fit-width', 'fit-page', 'tone'] as const;

/** The page's markup, as src/pages/read/[id].astro writes it. */
export function viewerPage({ pdf = '/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf', worker = '/_astro/pdf.worker.min.abc.mjs', drop = '' } = {}) {
  const body = new FakeEl('body');
  const root = new FakeEl('section');
  root.setAttribute('data-viewer', '');
  Object.assign(root.dataset, { pdf, worker });
  const parts: Record<string, FakeEl> = {};
  for (const [name, tag] of [
    ['nojs', 'p'],
    ['bar', 'div'],
    ['js', 'div'],
    ['first', 'button'],
    ['prev', 'button'],
    ['page', 'input'],
    ['count', 'span'],
    ['next', 'button'],
    ['last', 'button'],
    ['find', 'button'],
    ['zoom-out', 'button'],
    ['zoom', 'button'],
    ['zoom-list', 'div'],
    ['zoom-in', 'button'],
    ['hand', 'button'],
    ['fit-width', 'button'],
    ['fit-page', 'button'],
    ['tone', 'button'],
    ['more', 'button'],
    ['more-list', 'div'],
    ['zoom-now', 'p'],
    ['find-bar', 'div'],
    ['find-input', 'input'],
    ['find-count', 'p'],
    ['find-note', 'p'],
    ['find-prev', 'button'],
    ['find-next', 'button'],
    ['find-close', 'button'],
    ['status', 'p'],
    ['pages', 'div'],
    ['pan', 'div'],
    ['pan-track', 'div'],
  ] as const) {
    if (name === drop) continue;
    const el = new FakeEl(tag);
    el.setAttribute(`data-viewer-${name}`, '');
    parts[name] = el;
    root.append(el);
  }
  // The More menu holds a copy of each control a narrow bar has no room for (site.css shows the one that fits).
  const menu: Record<string, FakeEl> = {};
  for (const act of MENU_ACTS) {
    const el = new FakeEl('button');
    el.setAttribute('data-viewer-act', act);
    menu[act] = el;
    parts['more-list']?.append(el);
  }
  // W-LOOK3: the bar always shows (Download and Open in another app); its controls wait for the script.
  if (parts['js']) parts['js'].hidden = true;
  parts['pages']!.hidden = true;
  for (const name of ['zoom-list', 'more-list', 'find-bar', 'pan']) if (parts[name]) parts[name].hidden = true;
  parts['pages']!.rect = { top: 0, height: 0, width: 600 };
  parts['bar']!.rect = { top: 0, height: 60, width: 600 };
  body.append(root);
  return { doc: new FakeDoc(body), root, parts, menu };
}
