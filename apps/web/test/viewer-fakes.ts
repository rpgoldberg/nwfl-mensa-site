// Small stand-ins for the browser and pdf.js, for public/scripts/viewer.js (test/viewer-script.test.ts).
// Only what the viewer touches: elements by their data attributes, canvases, an IntersectionObserver
// the test drives by hand, and a pdf.js whose pages draw at once (or when the test lets them).

export class FakeStyle {
  readonly props = new Map<string, string>();
  width = '';
  height = '';
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
  readonly classList = { add: (...names: string[]) => names.forEach((n) => this.classes.add(n)), contains: (n: string) => this.classes.has(n) };
  hidden = false;
  textContent = '';
  value = '';
  id = '';
  href = '';
  rel = '';
  width = 0;
  height = 0;
  rect = { top: 0, height: 100, width: 600 };
  scrolled = 0;
  focused = false;
  onclick: (() => boolean) | null = null;
  constructor(readonly tag: string) {
    super();
  }
  set className(name: string) {
    for (const n of name.split(' ')) this.classes.add(n);
  }
  get className() {
    return [...this.classes].join(' ');
  }
  append(...kids: FakeEl[]) {
    for (const kid of kids) {
      kid.parent = this;
      this.children.push(kid);
    }
  }
  replaceChildren(...kids: FakeEl[]) {
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
  scrollIntoView() {
    this.scrolled++;
  }
  focus() {
    this.focused = true;
  }
  getContext() {
    return { canvas: this };
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
}

export class FakeDoc {
  readonly created: FakeEl[] = [];
  activeElement: FakeEl | null = null;
  constructor(readonly body: FakeEl) {}
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

export class FakeWin extends EventTarget {
  devicePixelRatio = 2;
  innerHeight = 800;
  phone = false;
  scrolledBy = 0;
  readonly location = { hash: '', origin: 'https://site.example' };
  readonly IntersectionObserver = FakeObserver;
  matchMedia(query: string) {
    return { matches: this.phone, media: query };
  }
  requestAnimationFrame(fn: () => void) {
    fn();
    return 1;
  }
  scrollBy(_x: number, y: number) {
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
export function fakePdfjs({ pages = 3, annotations = {} as Record<number, FakeAnnotation[]>, fail = false, hold = false, sizes = {} as Record<number, [number, number]> } = {}) {
  const log: string[] = [];
  const pending: (() => void)[] = [];
  const opened: unknown[] = [];
  const page = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => {
      const [w, h] = sizes[n] ?? [612, 792];
      const viewport = { width: w * scale, height: h * scale, scale, clone: () => viewport };
      return viewport;
    },
    render: (params: { canvas: FakeEl; transform?: number[] }) => {
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
    streamTextContent: () => `text of ${n}`,
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
    getDocument: (options: unknown) => {
      opened.push(options);
      return { promise: fail ? Promise.reject(new Error('Invalid PDF structure')) : Promise.resolve(doc) };
    },
    TextLayer: class {
      constructor(readonly o: { textContentSource: string; container: FakeEl }) {}
      render() {
        const span = new FakeEl('span');
        span.textContent = this.o.textContentSource;
        this.o.container.append(span);
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
  return { pdfjs, log, pending, opened };
}

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
    ['zoom-out', 'button'],
    ['zoom', 'output'],
    ['zoom-in', 'button'],
    ['fit-width', 'button'],
    ['fit-page', 'button'],
    ['prev', 'button'],
    ['goto', 'form'],
    ['page', 'input'],
    ['count', 'span'],
    ['next', 'button'],
    ['status', 'p'],
    ['pages', 'div'],
  ] as const) {
    if (name === drop) continue;
    const el = new FakeEl(tag);
    el.setAttribute(`data-viewer-${name}`, '');
    parts[name] = el;
    root.append(el);
  }
  parts['bar']!.hidden = true;
  parts['pages']!.hidden = true;
  parts['pages']!.rect = { top: 0, height: 0, width: 600 };
  parts['bar']!.rect = { top: 0, height: 60, width: 600 };
  body.append(root);
  return { doc: new FakeDoc(body), root, parts };
}
