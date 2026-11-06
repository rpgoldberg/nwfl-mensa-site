// The issue read inside the site (PDFVIEW, /read/<id>): pdf.js's core API, never its viewer.html (whose
// ?file= opens any URL). The page names one file, the same-origin /documents/<id>.pdf for its id, and
// the worker and library it was built with (data-pdf, data-worker, data-pdfjs); nothing here reads the
// query, and nothing but a same-origin path is ever loaded. The browser fetches the file with the
// reader's cookies, so the copy is whichever the site serves this reader.
//
// Accessibility first: every control is a visible button or the page box, 48 px, in the tab order, in
// the page's own text size and theme; no gesture is needed (pinch and scroll still work, as the
// browser's own). A computer opens at Fit page, a phone at Fit width. Each page is a canvas for the eye
// (hidden from screen readers), pdf.js's text layer over it for screen readers and selection, and its
// links (the copy's link annotations, and nothing else from the annotation layer: no forms, no files,
// no scripts). A link to /out/<id> goes to this site's leaving page in the same tab, whatever origin the
// copy names; an original's own https or mail link stays as it is; anything else is no link. Pages are
// drawn only as they come within a screen of the window, one at a time, and let go when they move
// away, so a long issue does not exhaust a phone. "Loading page N" and the page reached are said
// politely through the status line. Without this file the page says the reader needs JavaScript and
// offers Open in another app and Download, which are always there.
//
// pdf.js options: no eval (isEvalSupported false; 6.4.299 has no eval path left, the option is kept for
// a version that might), no WebAssembly (the CSP has no 'wasm-unsafe-eval'), no XFA forms, errors only
// in the console. The worker is a same-origin module (CSP worker-src 'self'), so pdf.js needs no blob:.

export const CSS_UNITS = 96 / 72;
export const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Below the site's nav breakpoint: a phone, which opens at Fit width. */
export const PHONE = '(max-width: 899px)';
/** The most pixels one page's canvas may hold (a 4096 x 4096 square): phones refuse more. */
export const MAX_PIXELS = 16_777_216;
/** A page within a screen of the window is drawn; one further away is let go. */
export const NEAR = '100% 0px';
/** Space kept below the bar when a whole page is fitted. */
const GAP = 16;

export const OPENING = 'Opening the issue';
export const FAILED = 'The issue could not be shown here. Use Open in another app, or Download.';
/** @param {number} n */
export const loading = (n) => `Loading page ${n}`;
/** @param {number} n */
const pageFailed = (n) => `Page ${n} could not be shown. Use Open in another app, or Download.`;

const FILE = /^\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const LEAVING = /^\/out\/([a-z2-7]{26})$/;
const EPSILON = 1e-6;

/** @param {number} scale */
export const zoomIn = (scale) => ZOOMS.find((z) => z > scale + EPSILON) ?? /** @type {number} */ (ZOOMS.at(-1));
/** @param {number} scale */
export const zoomOut = (scale) => [...ZOOMS].reverse().find((z) => z < scale - EPSILON) ?? /** @type {number} */ (ZOOMS[0]);
/** @param {number} scale */
export const percent = (scale) => `${Math.round(scale * 100)}\u00a0%`;

/**
 * The zoom at which a page fits the room: its width, or the whole page; within the zoom steps' ends.
 *
 * @param {'width' | 'page'} mode
 * @param {{ width: number, height: number }} size the page at 100 %, in CSS px
 * @param {{ width: number, height: number }} room
 */
export function fitScale(mode, size, room) {
  const across = room.width / size.width;
  const scale = mode === 'width' ? across : Math.min(across, room.height / size.height);
  return Math.min(Math.max(scale, /** @type {number} */ (ZOOMS[0])), /** @type {number} */ (ZOOMS.at(-1)));
}

/**
 * A page of the issue from what was typed: a whole number, held to the first and last page; else none.
 *
 * @param {string} value
 * @param {number} count
 */
export function clampPage(value, count) {
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) return undefined;
  return Math.min(Math.max(Number(text), 1), count);
}

/**
 * The page in #page=N, as the leaving page's Back to the newsletter gives it.
 *
 * @param {string} hash
 * @param {number} count
 */
export function hashPage(hash, count) {
  const n = /^#page=(\d+)$/.exec(hash)?.[1];
  return n === undefined ? undefined : clampPage(n, count);
}

/**
 * The page being read: the last whose top has reached the reading line.
 *
 * @param {number[]} tops each page's top, in order
 * @param {number} line
 */
export function pageAt(tops, line) {
  let at = 1;
  tops.forEach((top, i) => {
    if (top <= line) at = i + 1;
  });
  return at;
}

/**
 * The canvas pixels per CSS px: the screen's ratio, less where the page would pass MAX_PIXELS.
 *
 * @param {number} ratio devicePixelRatio
 * @param {number} width
 * @param {number} height
 */
export function outputScale(ratio, width, height, max = MAX_PIXELS) {
  const screen = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return Math.min(screen, Math.sqrt(max / (width * height)));
}

/**
 * Where a link in the PDF goes from here: this site's leaving page for a copy's /out/<id> on any
 * origin, an https or mail link as it is, and nothing for anything else (a relative URL included).
 *
 * @param {string} url
 */
export function linkHref(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const out = LEAVING.exec(parsed.pathname);
  if (out && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.search === '' && parsed.hash === '') return `/out/${out[1]}`;
  return parsed.protocol === 'https:' || parsed.protocol === 'mailto:' ? parsed.href : undefined;
}

/**
 * A link's name for a screen reader: what the copy says it is (its /Contents), its text, or its place.
 *
 * @param {{ contentsObj?: { str?: string }, overlaidText?: string }} data
 * @param {number} page
 * @param {number} k the link's place on the page
 */
export function linkName(data, page, k) {
  const said = (data.contentsObj?.str ?? data.overlaidText ?? '').trim();
  return said === '' ? `Link ${k} on page ${page}` : said;
}

/**
 * A path on this site: never another origin, a protocol-relative address, a blob or a data URL.
 *
 * @param {string} url
 * @param {string} origin
 */
export function sameOriginPath(url, origin) {
  return url.startsWith('/') && !url.startsWith('//') && new URL(url, origin).origin === origin;
}

/**
 * What the viewer uses of the page and the window (a browser's document and window, or stand-ins).
 *
 * @typedef {{ querySelector(selector: string): any, createElement(tag: string): any, activeElement: unknown }} ViewerDocument
 * @typedef {{ devicePixelRatio: number, innerHeight: number, location: { hash: string, origin: string },
 *   matchMedia(query: string): { matches: boolean },
 *   IntersectionObserver: new (callback: (entries: { target: any, isIntersecting: boolean }[]) => void, options: { rootMargin: string }) => { observe(el: any): void },
 *   requestAnimationFrame(fn: () => void): unknown, scrollBy(x: number, y: number): void,
 *   addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void }} ViewerWindow
 */

/**
 * @typedef {{ n: number, el: HTMLElement, layer: HTMLElement, size: { width: number, height: number } | undefined,
 *   proxy: any, near: boolean, state: 'idle' | 'queued' | 'drawing' | 'drawn', task: any, token: object | undefined }} Page
 */

/**
 * Wires the viewer in the page's [data-viewer] section; resolves once the PDF is open (undefined when
 * the markup is missing, its addresses are not this site's, or the PDF cannot be opened).
 *
 * @param {ViewerDocument} doc
 * @param {ViewerWindow} win
 * @param {any} pdfjs pdf.js's core module
 */
export async function wireViewer(doc, win, pdfjs) {
  const root = /** @type {HTMLElement | null} */ (doc.querySelector('[data-viewer]'));
  if (!root) return undefined;
  /** @param {string} name */
  const part = (name) => /** @type {any} */ (root.querySelector(`[data-viewer-${name}]`));
  const names = ['nojs', 'bar', 'zoom-out', 'zoom', 'zoom-in', 'fit-width', 'fit-page', 'prev', 'goto', 'page', 'count', 'next', 'status', 'pages'];
  const ui = Object.fromEntries(names.map((name) => [name, part(name)]));
  if (names.some((name) => !ui[name])) return undefined;
  const origin = win.location.origin;
  /** @param {string} text */
  const say = (text) => {
    ui['status'].textContent = text;
  };
  const url = root.dataset['pdf'] ?? '';
  const worker = root.dataset['worker'] ?? '';
  ui['nojs'].hidden = true;
  if (!FILE.test(url) || !sameOriginPath(worker, origin)) {
    say(FAILED);
    return undefined;
  }
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  say(OPENING);
  let pdf;
  let size;
  try {
    pdf = await pdfjs.getDocument({ url, isEvalSupported: false, useWasm: false, enableXfa: false, verbosity: 0 }).promise;
    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: CSS_UNITS });
    size = { width: base.width, height: base.height };
  } catch {
    say(FAILED);
    return undefined;
  }
  const count = /** @type {number} */ (pdf.numPages);
  const bar = ui['bar'];
  bar.hidden = false;
  ui['pages'].hidden = false;
  ui['count'].textContent = String(count);
  ui['page'].setAttribute('max', String(count));

  /** @type {'width' | 'page' | 'custom'} */
  let mode = win.matchMedia(PHONE).matches ? 'width' : 'page';
  let scale = 1;
  let current = 1;
  /** Where the reader is: a page, and how far down it the bar's edge is. */
  let anchor = { n: 1, frac: 0 };
  const barBottom = () => bar.getBoundingClientRect().bottom;
  const room = () => ({ width: ui['pages'].clientWidth, height: win.innerHeight - bar.offsetHeight - GAP });

  /** @type {Page[]} */
  const pages = [];
  const byEl = new Map();
  for (let n = 1; n <= count; n++) {
    const el = doc.createElement('div');
    el.className = 'viewer-page';
    el.id = `page-${n}`;
    const heading = doc.createElement('h2');
    heading.className = 'visually-hidden';
    heading.textContent = `Page ${n}`;
    const layer = doc.createElement('div');
    layer.className = 'viewer-layer';
    layer.setAttribute('data-viewer-layer', '');
    el.append(heading, layer);
    ui['pages'].append(el);
    /** @type {Page} */
    const page = { n, el, layer, size: n === 1 ? size : undefined, proxy: undefined, near: false, state: 'idle', task: undefined, token: undefined };
    pages.push(page);
    byEl.set(el, page);
  }

  /** @param {{ box?: boolean }} [options] box: write the page box even while the reader is in it */
  const show = ({ box = false } = {}) => {
    ui['zoom'].textContent = percent(scale);
    // Never under the reader's fingers: a number being typed stays until it is entered.
    if (box || doc.activeElement !== ui['page']) ui['page'].value = String(current);
    ui['fit-width'].setAttribute('aria-pressed', String(mode === 'width'));
    ui['fit-page'].setAttribute('aria-pressed', String(mode === 'page'));
    ui['zoom-out'].setAttribute('aria-disabled', String(scale <= /** @type {number} */ (ZOOMS[0]) + EPSILON));
    ui['zoom-in'].setAttribute('aria-disabled', String(scale >= /** @type {number} */ (ZOOMS.at(-1)) - EPSILON));
    ui['prev'].setAttribute('aria-disabled', String(current <= 1));
    ui['next'].setAttribute('aria-disabled', String(current >= count));
  };

  /** @param {Page} page */
  const lay = (page) => {
    const { width, height } = page.size ?? size;
    page.el.style.width = `${width * scale}px`;
    page.el.style.height = `${height * scale}px`;
    page.el.style.setProperty('--scale-factor', String(scale * CSS_UNITS));
  };

  /** @param {Page} page */
  const release = (page) => {
    page.token = undefined;
    page.task?.cancel();
    page.task = undefined;
    if (page.state === 'drawn') page.proxy.cleanup();
    page.layer.replaceChildren();
    page.state = 'idle';
  };

  /** @type {Page[]} */
  const wanted = [];
  let busy = false;
  /** @param {Page} page */
  const queue = (page) => {
    if (page.state !== 'idle' || !page.near) return;
    page.state = 'queued';
    wanted.push(page);
    void pump();
  };
  const pump = async () => {
    if (busy) return;
    wanted.sort((a, b) => Math.abs(a.n - current) - Math.abs(b.n - current));
    // A page let go while it waited is no longer queued: it is skipped.
    let page = wanted.shift();
    while (page && page.state !== 'queued') page = wanted.shift();
    if (!page) return;
    busy = true;
    try {
      await draw(page);
    } finally {
      busy = false;
      void pump();
    }
  };

  const links = {
    /** @param {HTMLAnchorElement} a @param {string} target */
    addLinkAttributes(a, target) {
      const href = linkHref(target);
      if (href === undefined) return;
      a.href = href;
      if (!href.startsWith('/')) a.rel = 'noopener noreferrer';
    },
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    /** @param {unknown} dest */
    async goToDestination(dest) {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const [ref] = explicit;
      const index = Number.isInteger(ref) ? ref : await pdf.getPageIndex(ref);
      if (index >= 0 && index < count) goTo(index + 1);
    },
    executeNamedAction() {},
    executeSetOCGState() {},
  };

  /** @param {Page} page */
  const draw = async (page) => {
    const token = {};
    page.token = token;
    page.state = 'drawing';
    const at = scale;
    if (page.n === current) say(loading(page.n));
    const stale = () => page.token !== token;
    try {
      page.proxy ??= await pdf.getPage(page.n);
      const proxy = page.proxy;
      if (stale()) return;
      if (!page.size) {
        const base = proxy.getViewport({ scale: CSS_UNITS });
        page.size = { width: base.width, height: base.height };
        lay(page);
      }
      const viewport = proxy.getViewport({ scale: at * CSS_UNITS });
      const ratio = outputScale(win.devicePixelRatio, viewport.width, viewport.height);
      const canvas = doc.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.setAttribute('aria-hidden', 'true');
      page.task = proxy.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }) });
      await page.task.promise;
      page.task = undefined;
      if (stale()) return;
      const text = doc.createElement('div');
      text.className = 'textLayer';
      await new pdfjs.TextLayer({ textContentSource: proxy.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport }).render();
      const annotations = /** @type {any[]} */ (await proxy.getAnnotations({ intent: 'display' })).filter((a) => a.annotationType === pdfjs.AnnotationType.LINK && (a.url || a.dest));
      const linkLayer = doc.createElement('div');
      linkLayer.className = 'annotationLayer';
      const flat = viewport.clone({ dontFlip: true });
      await new pdfjs.AnnotationLayer({ div: linkLayer, page: proxy, viewport: flat, linkService: links, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null, commentManager: null, annotationStorage: null }).render({ annotations, viewport: flat, div: linkLayer, page: proxy, linkService: links, renderForms: false });
      const byId = new Map(annotations.map((a) => [a.id, a]));
      let k = 0;
      for (const a of linkLayer.querySelectorAll('a')) {
        if (!a.getAttribute('href') && !a.href) {
          (a.closest('section') ?? a).remove();
          continue;
        }
        a.setAttribute('aria-label', linkName(byId.get(a.getAttribute('data-element-id')) ?? {}, page.n, ++k));
      }
      if (stale()) return;
      page.layer.replaceChildren(canvas, text, linkLayer);
      page.state = 'drawn';
      if (ui['status'].textContent === loading(page.n)) say('');
    } catch (error) {
      if (stale()) return;
      page.state = 'idle';
      page.task = undefined;
      if (/** @type {Error} */ (error).name !== 'RenderingCancelledException') say(pageFailed(page.n));
      else if (ui['status'].textContent === loading(page.n)) say('');
    }
  };

  /** The reader's place again after a new size; none to keep while the pages are still below the bar. */
  const restore = () => {
    const box = /** @type {Page} */ (pages[anchor.n - 1]).el.getBoundingClientRect();
    const shift = box.top + anchor.frac * box.height - barBottom();
    if (anchor.frac > 0 || shift < 0) win.scrollBy(0, shift);
  };
  /** A page gone to stops below the bar (CSS scroll-margin-top), however many rows the bar wraps to. */
  const fitBar = () => ui['pages'].style.setProperty('--viewer-bar', `${bar.offsetHeight}px`);

  /** @param {number} next */
  const rescale = (next) => {
    if (Math.abs(next - scale) < EPSILON) return show();
    scale = next;
    for (const page of pages) {
      release(page);
      lay(page);
    }
    show();
    restore();
    for (const page of pages) queue(page);
  };
  const fit = () => {
    fitBar();
    if (mode !== 'custom') rescale(fitScale(mode, size, room()));
  };

  /** @param {number} n */
  const goTo = (n) => {
    current = n;
    anchor = { n, frac: 0 };
    /** @type {Page} */ (pages[n - 1]).el.scrollIntoView({ block: 'start' });
    show({ box: true });
    say(`Page ${n} of ${count}`);
  };

  const track = () => {
    const line = barBottom() + (win.innerHeight - barBottom()) / 3;
    current = pageAt(pages.map((p) => p.el.getBoundingClientRect().top), line);
    const box = /** @type {Page} */ (pages[current - 1]).el.getBoundingClientRect();
    anchor = { n: current, frac: box.height > 0 ? Math.min(Math.max((barBottom() - box.top) / box.height, 0), 1) : 0 };
    show();
  };

  /** @param {HTMLElement} button @param {() => void} act */
  const onPress = (button, act) =>
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') !== 'true') act();
    });
  onPress(ui['zoom-in'], () => {
    mode = 'custom';
    rescale(zoomIn(scale));
  });
  onPress(ui['zoom-out'], () => {
    mode = 'custom';
    rescale(zoomOut(scale));
  });
  onPress(ui['fit-width'], () => {
    mode = 'width';
    fit();
  });
  onPress(ui['fit-page'], () => {
    mode = 'page';
    fit();
  });
  onPress(ui['prev'], () => goTo(current - 1));
  onPress(ui['next'], () => goTo(current + 1));
  const typed = () => {
    const n = clampPage(ui['page'].value, count);
    if (n === undefined) show({ box: true });
    else goTo(n);
  };
  ui['goto'].addEventListener('submit', (/** @type {Event} */ event) => {
    event.preventDefault();
    typed();
  });
  ui['page'].addEventListener('change', typed);

  let framed = false;
  win.addEventListener(
    'scroll',
    () => {
      if (framed) return;
      framed = true;
      win.requestAnimationFrame(() => {
        framed = false;
        track();
      });
    },
    { passive: true },
  );
  win.addEventListener('resize', () => win.requestAnimationFrame(fit));
  win.addEventListener('hashchange', () => {
    const n = hashPage(win.location.hash, count);
    if (n !== undefined) goTo(n);
  });

  const observer = new win.IntersectionObserver(
    (/** @type {{ target: unknown, isIntersecting: boolean }[]} */ entries) => {
      for (const entry of entries) {
        const page = byEl.get(entry.target);
        page.near = entry.isIntersecting;
        if (page.near) queue(page);
        else release(page);
      }
    },
    { rootMargin: NEAR },
  );
  scale = fitScale(mode, size, room());
  fitBar();
  for (const page of pages) {
    lay(page);
    observer.observe(page.el);
  }
  show();
  say('');
  const start = hashPage(win.location.hash, count);
  if (start !== undefined) goTo(start);
  return { pages, observer };
}

/**
 * Loads pdf.js from the same-origin path the page names (data-pdfjs), then wires the viewer; a page
 * with no viewer, or naming any other address, loads nothing.
 *
 * @param {ViewerDocument} doc
 * @param {ViewerWindow} win
 * @param {(url: string) => Promise<any>} load
 */
export async function boot(doc, win, load) {
  const root = /** @type {HTMLElement | null} */ (doc.querySelector('[data-viewer]'));
  const library = root?.dataset['pdfjs'] ?? '';
  if (!sameOriginPath(library, win.location.origin)) return undefined;
  return wireViewer(doc, win, await load(library));
}

if (typeof document !== 'undefined') void boot(document, window, (url) => import(url));
