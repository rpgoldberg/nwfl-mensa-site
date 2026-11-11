// The issue read inside the site (PDFVIEW, /read/<id>): pdf.js's core API, never its viewer.html (whose
// ?file= opens any URL). The page names one file, the same-origin /documents/<id>.pdf for its id, and
// the worker and library it was built with (data-pdf, data-worker, data-pdfjs); nothing here reads the
// query, and nothing but a same-origin path is ever loaded. The browser fetches the file with the
// reader's cookies, so the copy is whichever the site serves this reader.
//
// Accessibility first: every control is a visible button, link or text box, 44 px at least, in the tab
// order, in the page's own theme, each with a spoken name and a tooltip; no gesture is needed (pinch and
// scroll still work, as the browser's own). W-LOOK3, after Ross's mockup: one slim row on the frame's top
// edge. READER2: first, back, the page number in a box ("3 of 12": type one, then Enter, or just leave the
// box, as an iPhone's number pad has no Enter) and next and last; search; zoom out, a zoom picker of the
// steps and zoom in, and on a computer a hand tool; Fit width and Fit page, the one in force pressed;
// Light pages where the theme recolours them; then Download and Open in another app, plain links that
// need no script. Where a phone has no room, the later of these move, in that order, into a More menu
// (site.css), which holds a copy of each. Every device opens at Fit width, so the page fills the frame.
// The zoom picker is a button that opens a list of buttons, never a native select: WebKit raises a
// style-src-attr violation for a select's own inner style under the site's CSP (no 'unsafe-inline'),
// and the CSP stays as it is. Search (public/scripts/viewer-find.js) reads only the text of the file
// shown, the copy this reader is served, and marks its matches in the text layer. The pages follow the
// site's theme (public/scripts/viewer-tone.js): data-tone on the viewer, kept in step live; pictures are
// laid over the drawing unrecoloured. Zoomed wider than the frame, the pages scroll sideways: a
// scrollbar kept at the foot of the window, Shift and the wheel, a trackpad, the keyboard on the focused
// pages, and the hand tool (a drag with the mouse; a press without a drag still follows a link, and text
// can be selected again once it is off). Each page is a canvas for the eye
// (hidden from screen readers), pdf.js's text layer over it for screen readers and selection, and its
// links (the copy's link annotations, and nothing else from the annotation layer: no forms, no files,
// no scripts). Only two kinds of link are ever made: an /out/<id> goes to this site's leaving page in
// the same tab, whatever origin the copy names, and a place in the issue goes to its page. Every other
// address is no link at all: https, http and mail links, and whatever pdf.js makes of a Launch, a GoToR
// or a script's app.launchURL; an approved copy only ever carries /out links, and an original (as an
// officer is served it) must not skip the leaving page. Pages are drawn only as they come within a
// screen of the window, one at a time, and let go when they move away, so a long issue does not exhaust
// a phone; a file of more than MAX_PAGES is not drawn at all, and the reader says it is too long to show
// here. The bar stays at the top while reading only while it takes at most a third of the window (a
// large text size on a phone held sideways would leave no room for the page); otherwise it scrolls away
// with the page. "Loading page N" and the page reached are said politely through the status line.
// Without this file the page says the reader needs JavaScript and offers Open in another app and
// Download, which are always there.
//
// The window, not the frame, scrolls up and down, so the bar can stay at the top while reading.
//
// pdf.js options: no eval (isEvalSupported false; 6.4.299 has no eval path left, the option is kept for
// a version that might), no WebAssembly (the CSP has no 'wasm-unsafe-eval'), no XFA forms, no decoded
// image larger than MAX_IMAGE_PIXELS, errors only in the console. The worker is a same-origin module
// (CSP worker-src 'self'), so pdf.js needs no blob:.

import { NO_TEXT, findIn, hasText, indexText, matchLabel, paintHits, queryOf, rangesOf } from './viewer-find.js';
import { addPhotos, pageTone, photoBoxes } from './viewer-tone.js';

export const CSS_UNITS = 96 / 72;
export const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** The most pixels one page's canvas may hold (a 4096 x 4096 square): phones refuse more. */
export const MAX_PIXELS = 16_777_216;
/**
 * The most a recoloured page's canvas may hold (DARKPDF): the CSS filter or blend that recolours it costs
 * the browser a second buffer of the same size, and WebKit ran out of memory with both at MAX_PIXELS.
 * A phone's page is far below either.
 */
export const TONED_PIXELS = MAX_PIXELS / 2;
/** A page within a screen of the window is drawn; one further away is let go. */
export const NEAR = '100% 0px';
/** Space kept below the bar when a whole page is fitted. */
const GAP = 16;

export const OPENING = 'Opening the issue';
export const FAILED = 'The issue could not be shown here. Use Open in another app, or Download.';
/** The most pages drawn here: each is a box and a watched element, made at once as the file opens. */
export const MAX_PAGES = 1000;
export const TOO_LONG = 'This issue is too long to show here. You can open it in another app, or download it.';
/**
 * The largest image pdf.js decodes, in pixels; a larger one is left out of the drawing (Open in another
 * app still shows it). 40 million: a 600 dpi scan of a whole Letter page (5100 x 6600, 33.7 million)
 * still shows, while one picture costs at most about 160 MB decoded (4 bytes a pixel), which a phone
 * survives one page at a time. pdf.js's default is no limit, so a crafted 60000 x 60000 image would ask
 * for some 14 GB and take the tab down.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** @param {number} n */
export const loading = (n) => `Loading page ${n}`;
/** @param {number} n */
const pageFailed = (n) => `Page ${n} could not be shown. Use Open in another app, or Download.`;

const FILE = /^\/documents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;
const LEAVING = /^\/out\/([a-z2-7]{26})$/;
/** The only addresses a drawn link may keep: this site's leaving page, or a place in the issue. */
const KEPT = /^(?:\/out\/[a-z2-7]{26}|#)$/;
/** On the viewer while its bar is too tall to stay at the top: it scrolls with the page (site.css). */
export const UNPINNED = 'viewer--unpinned';
/** On the viewer once the script has wired it. */
export const JS = 'viewer--js';
/** On the viewer while the pages are wider than the frame, and while the hand tool is on and dragging. */
export const WIDE = 'viewer--wide';
export const HAND = 'viewer--hand';
export const DRAGGING = 'viewer--dragging';
/** On the viewer while Light pages shows the pages as printed whatever the theme. */
export const LIGHT_PAGES = 'viewer--light-pages';
/** How far a press must move to be a drag, not a click, in CSS px. */
const DRAG = 4;
/** Pixels in a line of a wheel that counts in lines (deltaMode 1). */
const LINE = 40;
const EPSILON = 1e-6;

/**
 * The zoom picker's choices: every step, and a fitted size that is no step in its place among them;
 * and which is chosen.
 *
 * @param {number} scale
 * @returns {{ options: { value: string, label: string }[], selected: string }}
 */
export function zoomOptions(scale) {
  const step = ZOOMS.find((z) => Math.abs(z - scale) < EPSILON);
  const values = step === undefined ? [...ZOOMS, scale].sort((a, b) => a - b) : ZOOMS;
  return { options: values.map((z) => ({ value: String(z), label: percent(z) })), selected: String(step ?? scale) };
}

/**
 * A page typed in the page box: a whole number from 1 to the last page; anything else is none.
 *
 * @param {string} value
 * @param {number} count
 */
export function pageInput(value, count) {
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= count ? n : undefined;
}
/** @param {number} count */
export const noPage = (count) => `Type a page number from 1 to ${count}.`;

/** @param {number} scale */
export const zoomIn = (scale) => ZOOMS.find((z) => z > scale + EPSILON) ?? /** @type {number} */ (ZOOMS.at(-1));
/** @param {number} scale */
export const zoomOut = (scale) => [...ZOOMS].reverse().find((z) => z < scale - EPSILON) ?? /** @type {number} */ (ZOOMS[0]);
/** @param {number} scale */
export const percent = (scale) => `${Math.round(scale * 100)}%`;

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
 * Where a link in the PDF goes from here: this site's leaving page for an /out/<id> on any origin, and
 * nowhere for anything else. An https, http or mail link, or the address pdf.js makes of a Launch, a
 * GoToR or app.launchURL, is no link, so nothing in a PDF reaches another site without the leaving page.
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
  return out && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.search === '' && parsed.hash === '' ? `/out/${out[1]}` : undefined;
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
 * @typedef {{ querySelector(selector: string): any, createElement(tag: string): any, activeElement: any, documentElement: any }} ViewerDocument
 * @typedef {{ devicePixelRatio: number, innerHeight: number, location: { hash: string, origin: string },
 *   ResizeObserver?: new (callback: () => void) => { observe(el: any): void },
 *   MutationObserver?: (new (callback: () => void) => { observe(el: any, options: object): void }) | undefined,
 *   matchMedia(query: string): { matches: boolean, addEventListener(type: string, listener: () => void): void },
 *   IntersectionObserver: new (callback: (entries: { target: any, isIntersecting: boolean }[]) => void, options: { rootMargin: string }) => { observe(el: any): void },
 *   requestAnimationFrame(fn: () => void): unknown, scrollBy(x: number, y: number): void,
 *   addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void }} ViewerWindow
 */

/**
 * @typedef {{ n: number, el: HTMLElement, layer: HTMLElement, size: { width: number, height: number } | undefined,
 *   proxy: any, near: boolean, state: 'idle' | 'queued' | 'drawing' | 'drawn', task: any, token: object | undefined,
 *   find: { divs: any[], strs: string[], painted: Set<number> } | undefined }} Page
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
  const names = [
    'nojs', 'bar', 'zoom-out', 'zoom', 'zoom-list', 'zoom-in', 'hand', 'fit-width', 'fit-page', 'tone', 'first', 'prev', 'page', 'count', 'next', 'last',
    'find', 'find-bar', 'find-input', 'find-count', 'find-note', 'find-prev', 'find-next', 'find-close', 'more', 'more-list', 'zoom-now', 'status', 'pages', 'pan', 'pan-track',
  ];
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
    // useWasm false: the CSP has no 'wasm-unsafe-eval', so pdf.js uses its JavaScript decoders, and a
    // page with JPEG 2000 or JBIG2 images may show those images poorly here (Open in another app and
    // Download still have them as they are).
    const task = pdfjs.getDocument({ url, isEvalSupported: false, useWasm: false, enableXfa: false, maxImageSize: MAX_IMAGE_PIXELS, verbosity: 0 });
    pdf = await task.promise;
    if (pdf.numPages > MAX_PAGES) {
      // Let the file go: the worker keeps nothing of it.
      void task.destroy().catch(() => undefined);
      say(TOO_LONG);
      return undefined;
    }
    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: CSS_UNITS });
    size = { width: base.width, height: base.height };
  } catch {
    say(FAILED);
    return undefined;
  }
  const count = /** @type {number} */ (pdf.numPages);
  const bar = ui['bar'];
  const pagesEl = ui['pages'];
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-viewer-js]'))) el.hidden = false;
  pagesEl.hidden = false;
  // What moves into the More menu on a narrow bar moves only once the menu works (site.css).
  root.classList.toggle(JS, true);
  /** The More menu's copy of each control, by what it does (data-viewer-act). */
  const menuItems = /** @type {any[]} */ ([...root.querySelectorAll('[data-viewer-act]')]);
  /** A control on the bar and its copy in the More menu. @param {string} act */
  const copies = (act) => [ui[act], ...menuItems.filter((el) => el.getAttribute('data-viewer-act') === act)];
  /** @param {string} act @param {string} name @param {string} value */
  const setAll = (act, name, value) => {
    for (const el of copies(act)) el.setAttribute(name, value);
  };
  /**
   * A picker: its button opens and closes its list; a choice in the list acts, closes it and gives the
   * focus back to the button.
   *
   * @param {string} name
   * @param {(value: string) => void} act
   */
  const picker = (name, act) => {
    const button = ui[name];
    const list = ui[`${name}-list`];
    /** @param {boolean} open */
    const set = (open) => {
      list.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
    };
    /** @param {string} value @param {string} label */
    const choice = (value, label) => {
      const el = doc.createElement('button');
      el.type = 'button';
      el.className = 'vpick__choice';
      el.value = value;
      el.textContent = label;
      el.addEventListener('click', () => {
        set(false);
        button.focus();
        act(value);
      });
      return el;
    };
    /** @param {string} value */
    const mark = (value) => {
      for (const el of list.children) el.setAttribute('aria-current', String(el.value === value));
    };
    button.addEventListener('click', () => {
      const open = list.hidden;
      for (const other of pickers) other.set(false);
      set(open);
      if (!open) return;
      // The marked choice, else the first that can take the focus (an item the bar shows is not in the menu).
      const marked = [...list.children].find((el) => el.getAttribute('aria-current') === 'true');
      for (const el of marked ? [marked] : [...list.children]) {
        el.focus();
        if (doc.activeElement === el) break;
      }
    });
    set(false);
    return { button, list, set, choice, mark };
  };
  /** @type {ReturnType<typeof picker>[]} */
  const pickers = [];
  const zoomPick = picker('zoom', (value) => {
    const chosen = ZOOMS.find((z) => String(z) === value);
    if (chosen === undefined) return;
    mode = 'custom';
    rescale(chosen);
  });
  const morePick = picker('more', () => undefined);
  pickers.push(zoomPick, morePick);
  // Download and Open in another app, in the More menu: the menu closes as they go.
  for (const a of ui['more-list'].querySelectorAll('a')) a.addEventListener('click', () => morePick.set(false));
  ui['count'].textContent = String(count);
  // The box as wide as the last page's number (site.css).
  ui['page'].style.setProperty('--digits', String(String(count).length));
  ui['page'].setAttribute('aria-label', `Page number, 1 to ${count}`);
  root.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Escape') return;
    let closed = false;
    for (const p of pickers) {
      if (p.list.hidden) continue;
      p.set(false);
      p.button.focus();
      closed = true;
    }
    if (!closed && finding) closeFind();
  });
  win.addEventListener('pointerdown', (/** @type {Event} */ event) => {
    for (const p of pickers) if (!p.list.hidden && event.target !== p.button && !p.list.contains(event.target)) p.set(false);
  });

  /** @type {'width' | 'page' | 'custom'} */
  let mode = 'width';
  /** The scale the zoom select lists, so its choices are made again only when the scale changes. */
  let listed = NaN;
  let scale = 1;
  let current = 1;
  /** Where the reader is: a page, and how far down it the bar's edge is. */
  let anchor = { n: 1, frac: 0 };
  /** Whether the bar stays at the top: only while it takes at most a third of the window. */
  let pinned = true;
  /** The top of what is left to read: under the bar while it shows, else the window's own top. */
  const barBottom = () => Math.max(0, bar.getBoundingClientRect().bottom);
  const room = () => ({ width: pagesEl.clientWidth, height: win.innerHeight - (pinned ? bar.offsetHeight : 0) - GAP });

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
    pagesEl.append(el);
    /** @type {Page} */
    const page = { n, el, layer, size: n === 1 ? size : undefined, proxy: undefined, near: false, state: 'idle', task: undefined, token: undefined, find: undefined };
    pages.push(page);
    byEl.set(el, page);
  }

  const show = () => {
    if (scale !== listed) {
      listed = scale;
      const { options, selected } = zoomOptions(scale);
      ui['zoom-list'].replaceChildren(...options.map((o) => zoomPick.choice(o.value, o.label)));
      zoomPick.mark(selected);
      ui['zoom'].value = selected;
      ui['zoom'].textContent = percent(scale);
      ui['zoom'].setAttribute('aria-label', `Zoom ${percent(scale)}`);
      ui['zoom-now'].textContent = `Zoom ${percent(scale)}`;
    }
    // Never under the reader's fingers while they type a page.
    if (doc.activeElement !== ui['page']) ui['page'].value = String(current);
    setAll('fit-width', 'aria-pressed', String(mode === 'width'));
    setAll('fit-page', 'aria-pressed', String(mode === 'page'));
    setAll('zoom-out', 'aria-disabled', String(scale <= /** @type {number} */ (ZOOMS[0]) + EPSILON));
    setAll('zoom-in', 'aria-disabled', String(scale >= /** @type {number} */ (ZOOMS.at(-1)) - EPSILON));
    for (const name of ['first', 'prev']) ui[name].setAttribute('aria-disabled', String(current <= 1));
    for (const name of ['next', 'last']) ui[name].setAttribute('aria-disabled', String(current >= count));
    if (finding) note();
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
    page.find = undefined;
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
      const toned = root.dataset['tone'] !== 'light' && !root.classList.contains(LIGHT_PAGES);
      const ratio = outputScale(win.devicePixelRatio, viewport.width, viewport.height, toned ? TONED_PIXELS : MAX_PIXELS);
      const canvas = doc.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.setAttribute('aria-hidden', 'true');
      // Drawn as printed; pdf.js records where its pictures are, so a recoloured page leaves them be.
      page.task = proxy.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, recordImages: true, ...(ratio === 1 ? {} : { transform: [ratio, 0, 0, ratio, 0, 0] }) });
      await page.task.promise;
      page.task = undefined;
      if (stale()) return;
      const { picture, photos } = addPhotos(doc, canvas, photoBoxes(proxy.imageCoordinates, canvas.width, canvas.height));
      canvas.className = picture ? 'viewer-sheet viewer-sheet--picture' : 'viewer-sheet';
      const text = doc.createElement('div');
      text.className = 'textLayer';
      const textLayer = new pdfjs.TextLayer({ textContentSource: proxy.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport });
      await textLayer.render();
      const annotations = /** @type {any[]} */ (await proxy.getAnnotations({ intent: 'display' })).filter((a) => a.annotationType === pdfjs.AnnotationType.LINK && (a.url || a.dest));
      const linkLayer = doc.createElement('div');
      linkLayer.className = 'annotationLayer';
      const flat = viewport.clone({ dontFlip: true });
      await new pdfjs.AnnotationLayer({ div: linkLayer, page: proxy, viewport: flat, linkService: links, accessibilityManager: null, annotationCanvasMap: null, annotationEditorUIManager: null, structTreeLayer: null, commentManager: null, annotationStorage: null }).render({ annotations, viewport: flat, div: linkLayer, page: proxy, linkService: links, renderForms: false });
      const byId = new Map(annotations.map((a) => [a.id, a]));
      let k = 0;
      for (const a of linkLayer.querySelectorAll('a')) {
        // However pdf.js came to give it, a link to anywhere but the leaving page or the issue is dropped.
        if (!KEPT.test(a.getAttribute('href') ?? a.href)) {
          (a.closest('section') ?? a).remove();
          continue;
        }
        a.setAttribute('aria-label', linkName(byId.get(a.getAttribute('data-element-id')) ?? {}, page.n, ++k));
      }
      if (stale()) return;
      page.layer.replaceChildren(canvas, ...photos, text, linkLayer);
      page.state = 'drawn';
      // The text layer's spans, one for each text item, as search reads them (viewer-find.js).
      page.find = { divs: textLayer.textDivs, strs: textLayer.textContentItemsStr, painted: new Set() };
      const mark = paint(page);
      if (pending === page.n) {
        pending = undefined;
        mark?.scrollIntoView({ block: 'center', inline: 'center' });
      }
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
  /**
   * The bar stays at the top only while it takes at most a third of the window; a page gone to stops
   * below it (CSS scroll-margin-top), however many rows it wraps to, or at the window's top once the bar
   * scrolls with the page.
   */
  const fitBar = () => {
    pinned = bar.offsetHeight <= win.innerHeight / 3;
    root.classList.toggle(UNPINNED, !pinned);
    pagesEl.style.setProperty('--viewer-bar', `${pinned ? bar.offsetHeight : 0}px`);
  };

  // Sideways: the pages' own scroll, with a copy of its scrollbar kept at the foot of the window (site.css),
  // as wide as the pages and in step with them both ways, so a computer always shows one.
  let wide = false;
  const sizePan = () => {
    wide = pagesEl.scrollWidth > pagesEl.clientWidth + 1;
    root.classList.toggle(WIDE, wide);
    ui['pan'].hidden = !wide;
    ui['pan-track'].style.width = `${pagesEl.scrollWidth}px`;
    ui['pan'].scrollLeft = pagesEl.scrollLeft;
  };
  // The scrollbar's scroll event comes a frame later: one that only echoes what the pages gave it is let
  // be, else during a drag it would pull the pages back to where they were.
  let echo = NaN;
  ui['pan'].addEventListener('scroll', () => {
    if (Math.abs(ui['pan'].scrollLeft - echo) < 1) return;
    echo = NaN;
    if (pagesEl.scrollLeft !== ui['pan'].scrollLeft) pagesEl.scrollLeft = ui['pan'].scrollLeft;
  }, { passive: true });
  pagesEl.addEventListener('scroll', () => {
    if (ui['pan'].scrollLeft === pagesEl.scrollLeft) return;
    echo = pagesEl.scrollLeft;
    ui['pan'].scrollLeft = pagesEl.scrollLeft;
  }, { passive: true });
  // Shift and the wheel, where the browser has not made it sideways already (it then gives deltaX).
  pagesEl.addEventListener('wheel', (/** @type {WheelEvent} */ event) => {
    if (!wide || !event.shiftKey || event.deltaX !== 0 || event.deltaY === 0) return;
    pagesEl.scrollLeft += event.deltaY * (event.deltaMode === 1 ? LINE : 1);
    event.preventDefault();
  }, { passive: false });
  // The hand tool: a drag with the mouse moves the pages both ways. Only a press that moves is a drag:
  // the pointer is captured once it has, so a press without a drag still follows a link.
  let hand = false;
  /** @type {{ x: number, y: number, moved: boolean } | undefined} */
  let drag;
  let swallow = false;
  pagesEl.addEventListener('pointerdown', (/** @type {PointerEvent} */ event) => {
    if (!hand || !wide || event.button !== 0 || event.pointerType !== 'mouse') return;
    drag = { x: event.clientX, y: event.clientY, moved: false };
  });
  pagesEl.addEventListener('pointermove', (/** @type {PointerEvent} */ event) => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG) return;
      drag.moved = true;
      pagesEl.setPointerCapture(event.pointerId);
      root.classList.toggle(DRAGGING, true);
    }
    pagesEl.scrollLeft -= event.clientX - drag.x;
    win.scrollBy(0, drag.y - event.clientY);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  const endDrag = () => {
    swallow = drag?.moved ?? false;
    drag = undefined;
    root.classList.toggle(DRAGGING, false);
  };
  pagesEl.addEventListener('pointerup', endDrag);
  pagesEl.addEventListener('pointercancel', endDrag);
  // The click that ends a drag follows no link.
  pagesEl.addEventListener('click', (/** @type {Event} */ event) => {
    if (!swallow) return;
    swallow = false;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true });
  pagesEl.addEventListener('dragstart', (/** @type {Event} */ event) => {
    if (hand) event.preventDefault();
  });

  /** @param {number} next */
  const rescale = (next) => {
    if (Math.abs(next - scale) < EPSILON) return show();
    scale = next;
    for (const page of pages) {
      release(page);
      lay(page);
    }
    sizePan();
    show();
    restore();
    for (const page of pages) queue(page);
  };
  const fit = () => {
    fitBar();
    if (mode !== 'custom') rescale(fitScale(mode, size, room()));
    sizePan();
  };

  /** Scrolls a page to the top of what is left to read. @param {number} n */
  const reach = (n) => {
    current = n;
    anchor = { n, frac: 0 };
    /** @type {Page} */ (pages[n - 1]).el.scrollIntoView({ block: 'start' });
    show();
  };
  /** @param {number} n */
  const goTo = (n) => {
    reach(n);
    say(`Page ${n} of ${count}`);
  };

  const track = () => {
    const line = barBottom() + (win.innerHeight - barBottom()) / 3;
    current = pageAt(pages.map((p) => p.el.getBoundingClientRect().top), line);
    const box = /** @type {Page} */ (pages[current - 1]).el.getBoundingClientRect();
    anchor = { n: current, frac: box.height > 0 ? Math.min(Math.max((barBottom() - box.top) / box.height, 0), 1) : 0 };
    show();
  };

  // Search within the issue (viewer-find.js): the text of every page of this file, read once.
  let finding = false;
  /** @type {{ items: { str: string, hasEOL?: boolean }[], index: ReturnType<typeof indexText> }[] | undefined} */
  let texts;
  /** @type {Promise<NonNullable<typeof texts>> | undefined} */
  let reading;
  /** @type {{ n: number, start: number, length: number }[]} */
  let matches = [];
  let hit = -1;
  /** The page whose current match waits for it to be drawn, to scroll to. @type {number | undefined} */
  let pending;
  /** Where the focus goes back when search closes. @type {any} */
  let opener;
  let asked = 0;
  const readTexts = () =>
    (reading ??= (async () => {
      const out = [];
      for (const page of pages) {
        let items = [];
        try {
          page.proxy ??= await pdf.getPage(page.n);
          const content = await page.proxy.getTextContent({ includeMarkedContent: true, disableNormalization: true });
          // As pdf.js's text layer makes its spans: one for each item that has text, in order.
          items = content.items.filter((/** @type {{ str?: string }} */ item) => item.str !== undefined);
        } catch {
          // A page whose text cannot be read has none to search.
        }
        out.push({ items, index: indexText(items) });
      }
      texts = out;
      return out;
    })());
  const note = () => {
    const t = texts?.[current - 1];
    ui['find-note'].textContent = t && !hasText(t.items) ? NO_TEXT : '';
  };
  /** @param {Page} page */
  const paint = (page) => {
    if (!page.find || !texts) return undefined;
    const index = /** @type {NonNullable<typeof texts>[number]} */ (texts[page.n - 1]).index;
    const hits = matches.flatMap((m, i) => (m.n === page.n ? [{ ranges: rangesOf(index, m.start, m.length), current: i === hit }] : []));
    return paintHits(doc, page.find, hits);
  };
  /** Shows the current match: painted and scrolled to where its page is drawn, else once it is. */
  const reveal = () => {
    ui['find-count'].textContent = queryOf(ui['find-input'].value) === '' ? '' : matchLabel(hit + 1, matches.length);
    let mark;
    for (const page of pages) {
      const m = paint(page);
      if (matches[hit]?.n === page.n) mark = m;
    }
    const m = matches[hit];
    if (!m) return;
    if (mark) {
      pending = undefined;
      current = m.n;
      mark.scrollIntoView({ block: 'center', inline: 'center' });
      show();
    } else {
      pending = m.n;
      reach(m.n);
    }
  };
  const search = async () => {
    const ask = ++asked;
    const list = await readTexts();
    if (ask !== asked || !finding) return;
    const query = queryOf(ui['find-input'].value);
    matches = [];
    list.forEach((t, i) => {
      for (const start of findIn(t.index, query)) matches.push({ n: i + 1, start, length: query.length });
    });
    const after = matches.findIndex((m) => m.n >= current);
    hit = matches.length === 0 ? -1 : Math.max(after, 0);
    note();
    reveal();
  };
  /** @param {number} step */
  const step = (step) => {
    if (matches.length === 0) return;
    hit = (hit + step + matches.length) % matches.length;
    reveal();
  };
  /** @param {any} from where the focus goes back to */
  const openFind = (from) => {
    opener = from;
    finding = true;
    ui['find-bar'].hidden = false;
    setAll('find', 'aria-expanded', 'true');
    ui['find-input'].focus();
    void search();
  };
  const closeFind = () => {
    finding = false;
    ui['find-bar'].hidden = true;
    setAll('find', 'aria-expanded', 'false');
    matches = [];
    hit = -1;
    pending = undefined;
    for (const page of pages) paint(page);
    opener?.focus?.();
  };
  ui['find-input'].addEventListener('input', () => void search());
  ui['find-input'].addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  });
  ui['find-next'].addEventListener('click', () => step(1));
  ui['find-prev'].addEventListener('click', () => step(-1));
  ui['find-close'].addEventListener('click', closeFind);
  // "/" opens search, as on many sites; Ctrl+F stays the browser's own. Never from a field, or with a modifier.
  win.addEventListener('keydown', (/** @type {Event} */ e) => {
    const event = /** @type {KeyboardEvent} */ (e);
    const target = /** @type {any} */ (event.target);
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || finding) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? '') || target?.isContentEditable) return;
    event.preventDefault();
    openFind(doc.activeElement);
  });

  // The page box: Enter (a phone's Go), or leaving the box changed, goes to the page typed.
  const pageBox = ui['page'];
  const commit = () => {
    const n = pageInput(pageBox.value, count);
    if (n === undefined) {
      pageBox.setAttribute('aria-invalid', 'true');
      pageBox.value = String(current);
      say(noPage(count));
      return;
    }
    pageBox.removeAttribute('aria-invalid');
    goTo(n);
    pageBox.value = String(n);
  };
  // The first thing typed replaces the page shown, wherever the caret was (WebKit puts it at the start
  // after a tap, so a "2" typed over "1" would be "21"); a deletion or a move of the caret first edits it.
  let fresh = false;
  pageBox.addEventListener('focus', () => {
    fresh = true;
    pageBox.select();
  });
  pageBox.addEventListener('input', (/** @type {InputEvent} */ event) => {
    if (fresh && event.inputType === 'insertText' && event.data) pageBox.value = event.data;
    fresh = false;
  });
  pageBox.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
    if (/^(Arrow|Home|End)/.test(event.key)) fresh = false;
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
    fresh = true;
  });
  pageBox.addEventListener('change', () => {
    if (pageBox.value.trim() !== String(current)) commit();
  });

  /** What each control does, on the bar and in the More menu alike. @type {Record<string, () => void>} */
  const acts = {
    'zoom-in': () => {
      mode = 'custom';
      rescale(zoomIn(scale));
    },
    'zoom-out': () => {
      mode = 'custom';
      rescale(zoomOut(scale));
    },
    'fit-width': () => {
      mode = 'width';
      fit();
    },
    'fit-page': () => {
      mode = 'page';
      fit();
    },
    tone: () => {
      const on = !root.classList.contains(LIGHT_PAGES);
      root.classList.toggle(LIGHT_PAGES, on);
      setAll('tone', 'aria-pressed', String(on));
    },
  };
  for (const [act, run] of Object.entries(acts)) {
    for (const el of copies(act)) {
      el.addEventListener('click', () => {
        if (el.getAttribute('aria-disabled') === 'true') return;
        if (el !== ui[act]) {
          morePick.set(false);
          ui['more'].focus();
        }
        run();
      });
    }
  }
  for (const el of copies('find')) {
    el.addEventListener('click', () => {
      if (el === ui['find']) {
        if (finding) closeFind();
        else openFind(el);
        return;
      }
      morePick.set(false);
      openFind(ui['more']);
    });
  }
  setAll('find', 'aria-expanded', 'false');
  setAll('tone', 'aria-pressed', 'false');
  ui['hand'].setAttribute('aria-pressed', 'false');
  ui['hand'].addEventListener('click', () => {
    hand = !hand;
    root.classList.toggle(HAND, hand);
    ui['hand'].setAttribute('aria-pressed', String(hand));
  });

  /** @param {HTMLElement} button @param {() => void} act */
  const onPress = (button, act) =>
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') !== 'true') act();
    });
  onPress(ui['first'], () => goTo(1));
  onPress(ui['prev'], () => goTo(current - 1));
  onPress(ui['next'], () => goTo(current + 1));
  onPress(ui['last'], () => goTo(count));

  // The pages follow the theme (viewer-tone.js): the reader's in Aa (html data-theme), else the device's.
  const html = doc.documentElement;
  const dark = win.matchMedia('(prefers-color-scheme: dark)');
  const more = win.matchMedia('(prefers-contrast: more)');
  const tone = () => {
    root.dataset['tone'] = pageTone(html.getAttribute('data-theme'), dark.matches, more.matches);
  };
  dark.addEventListener('change', tone);
  more.addEventListener('change', tone);
  if (win.MutationObserver) new win.MutationObserver(tone).observe(html, { attributes: true, attributeFilter: ['data-theme'] });
  tone();

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
  // The bar changes size without the window when the reader picks another text size.
  if (win.ResizeObserver) new win.ResizeObserver(() => win.requestAnimationFrame(fit)).observe(bar);
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
  fitBar();
  scale = fitScale(mode, size, room());
  for (const page of pages) {
    lay(page);
    observer.observe(page.el);
  }
  sizePan();
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
