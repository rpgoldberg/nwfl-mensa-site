// public/scripts/viewer.js, the issue read inside the site (PDFVIEW). It draws the same-origin PDF the
// page names with pdf.js's core API (never its viewer.html), page by page as each comes near, with a
// text layer and links; its controls are visible buttons and a page box. Here it runs against small
// stand-ins (test/viewer-fakes.ts): the browser's part is in e2e/read.spec.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CSS_UNITS,
  FAILED,
  MAX_IMAGE_PIXELS,
  MAX_PAGES,
  MAX_PIXELS,
  OPENING,
  TONED_PIXELS,
  TOO_LONG,
  ZOOMS,
  clampPage,
  fitScale,
  hashPage,
  linkHref,
  linkName,
  loading,
  outputScale,
  noPage,
  pageAt,
  pageInput,
  percent,
  sameOriginPath,
  boot,
  wireViewer,
  zoomIn,
  zoomOptions,
  zoomOut,
} from '../public/scripts/viewer.js';
import { NO_TEXT } from '../public/scripts/viewer-find.js';
import { FakeEl, FakeMutationObserver, FakeObserver, FakeResizeObserver, FakeWin, chosen, fakePdfjs, pick, viewerPage } from './viewer-fakes';

const PAGE = { width: 612 * CSS_UNITS, height: 792 * CSS_UNITS };
const ID = 'outwebaaaaaaaaaaaaaaaaaaaa';
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('the zoom steps', () => {
  it('step in and out from wherever the scale is, and stop at the ends', () => {
    expect(ZOOMS).toEqual([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
    expect(zoomIn(1)).toBe(1.25);
    expect(zoomIn(0.6)).toBe(0.75);
    expect(zoomIn(4)).toBe(4);
    expect(zoomOut(1)).toBe(0.75);
    expect(zoomOut(0.6)).toBe(0.5);
    expect(zoomOut(0.25)).toBe(0.25);
    expect(zoomOut(0.1)).toBe(0.25);
  });

  // W-LOOK3: as Ross's mockup writes it, "100%".
  it('show as a whole percentage', () => {
    expect(percent(1)).toBe('100%');
    expect(percent(0.7354)).toBe('74%');
  });
});

// W-LOOK3: the zoom is a select of the steps; a fitted size that is no step is shown in its place among them.
describe('zoomOptions', () => {
  it('lists every step, and chooses the one the scale is at', () => {
    const { options, selected } = zoomOptions(1);
    expect(options).toEqual(ZOOMS.map((z) => ({ value: String(z), label: percent(z) })));
    expect(selected).toBe('1');
    expect(zoomOptions(1.25 + 1e-9).selected).toBe('1.25');
  });

  it('puts a fitted size that is no step in its place, chosen', () => {
    const { options, selected } = zoomOptions(1.3712);
    expect(options.map((o) => o.label)).toEqual(['25%', '50%', '75%', '100%', '125%', '137%', '150%', '200%', '300%', '400%']);
    expect(selected).toBe('1.3712');
    expect(zoomOptions(0.1).options[0]).toEqual({ value: '0.1', label: '10%' });
    expect(zoomOptions(5).options.at(-1)).toEqual({ value: '5', label: '500%' });
  });
});

describe('pageInput', () => {
  it('is a page of the issue typed as a whole number, 1 to the last; anything else is none', () => {
    expect(pageInput('3', 12)).toBe(3);
    expect(pageInput(' 12 ', 12)).toBe(12);
    expect(pageInput('1', 12)).toBe(1);
    for (const typed of ['0', '13', '-1', '2.5', 'x', '', '1e1', '٣']) expect(pageInput(typed, 12), typed).toBeUndefined();
    expect(noPage(12)).toBe('Type a page number from 1 to 12.');
  });
});

describe('fitScale', () => {
  it('fits the width, or the whole page, within the limits', () => {
    expect(fitScale('width', PAGE, { width: 600, height: 700 })).toBeCloseTo(600 / PAGE.width);
    expect(fitScale('page', PAGE, { width: 600, height: 700 })).toBeCloseTo(700 / PAGE.height);
    expect(fitScale('page', PAGE, { width: 300, height: 2000 })).toBeCloseTo(300 / PAGE.width);
    expect(fitScale('width', PAGE, { width: 10, height: 10 })).toBe(0.25);
    expect(fitScale('width', PAGE, { width: 99_999, height: 10 })).toBe(4);
    expect(fitScale('width', PAGE, { width: 0, height: 0 })).toBe(0.25);
  });
});

describe('the page number', () => {
  it('is a whole page of the issue, the nearest one when out of range, or none', () => {
    expect(clampPage('2', 3)).toBe(2);
    expect(clampPage(' 3 ', 3)).toBe(3);
    expect(clampPage('9', 3)).toBe(3);
    expect(clampPage('0', 3)).toBe(1);
    expect(clampPage('-4', 3)).toBe(1);
    for (const value of ['', 'two', '1.5', '1e2', '0x2']) expect(clampPage(value, 3), value).toBeUndefined();
  });

  it('comes from #page=N, as the leaving page links back', () => {
    expect(hashPage('#page=2', 3)).toBe(2);
    expect(hashPage('#page=7', 3)).toBe(3);
    for (const hash of ['', '#', '#page=', '#page=x', '#p=2', '#page=2&x']) expect(hashPage(hash, 3), hash).toBeUndefined();
  });

  it('is the last page whose top has reached the reading line', () => {
    expect(pageAt([-900, -10, 900], 300)).toBe(2);
    expect(pageAt([100, 1000], 300)).toBe(1);
    expect(pageAt([400, 1000], 300)).toBe(1);
    expect(pageAt([-2000, -1000, -10], 300)).toBe(3);
    expect(pageAt([], 300)).toBe(1);
  });
});

describe('outputScale', () => {
  it("is the screen's pixel ratio, less for a page so large it would exhaust a phone", () => {
    expect(outputScale(2, 600, 800)).toBe(2);
    expect(outputScale(0, 600, 800)).toBe(1);
    expect(outputScale(Number.NaN, 600, 800)).toBe(1);
    expect(outputScale(3, 4000, 5000)).toBeCloseTo(Math.sqrt(16_777_216 / 20_000_000));
  });
});

describe('the links in a copy', () => {
  it("lead to this site's leaving page in the same tab, from whatever origin the copy names", () => {
    expect(linkHref(`https://nwflmensa.us/out/${ID}`)).toBe(`/out/${ID}`);
    expect(linkHref(`https://canary.nwflmensa.us/out/${ID}`)).toBe(`/out/${ID}`);
    expect(linkHref(`http://localhost:8443/out/${ID}`)).toBe(`/out/${ID}`);
  });

  // PDFVIEW fix 1 (B1): an original, as an officer is served it, keeps its own links; none of them may
  // skip the leaving page. Only /out/<id> and a place in the issue are ever a link.
  it('are no link at all for any other address: https, http, mail, script, data, or what pdf.js makes of Launch, GoToR and app.launchURL', () => {
    for (const url of [
      'https://club.example/picnic',
      'https://evil.example/phish',
      'mailto:events@example.org',
      'mailto:x@example.com?subject=hi',
      'javascript:alert(1)',
      'data:text/html,x',
      'http://club.example/',
      'ftp://x.example/',
      'tel:5551234',
      'not a url',
      '//evil.example/proto',
      'https://evil.example/launch.exe',
      'https://evil.example/remote.pdf#[0,{"name":"Fit"}]',
      'https://xn--nwflmnsa-r1a.us/x',
      'file:///C:/Windows/System32/cmd.exe',
      `https://nwflmensa.us/out/${ID}?x=1`,
      `https://nwflmensa.us/out/${ID}#x`,
      `https://nwflmensa.us/out/${ID}/x`,
      'https://nwflmensa.us/out/SHORT',
      `https://nwflmensa.us/out/${ID.toUpperCase()}`,
      `blob:https://nwflmensa.us/out/${ID}`,
    ])
      expect(linkHref(url), url).toBeUndefined();
  });

  it("an /out/<id> on another origin, or behind a user name, is still only this site's leaving page", () => {
    expect(linkHref(`https://evil.example/out/${ID}`)).toBe(`/out/${ID}`);
    expect(linkHref(`https://nwflmensa.us@example.com/out/${ID}`)).toBe(`/out/${ID}`);
  });

  it('are named by what the copy says they are, or by their place', () => {
    expect(linkName({ contentsObj: { str: ' Link to club.example ' } }, 2, 1)).toBe('Link to club.example');
    expect(linkName({ overlaidText: 'the picnic' }, 2, 1)).toBe('the picnic');
    expect(linkName({}, 2, 3)).toBe('Link 3 on page 2');
  });
});

describe('sameOriginPath', () => {
  it('is a path on this site only', () => {
    expect(sameOriginPath('/_astro/pdf.worker.min.abc.mjs', 'https://site.example')).toBe(true);
    for (const url of ['https://cdn.example/pdf.worker.mjs', '//cdn.example/w.mjs', 'blob:https://site.example/x', 'data:text/javascript,1', '']) expect(sameOriginPath(url, 'https://site.example'), url).toBe(false);
  });
});

describe('wireViewer', () => {
  let win: FakeWin;
  beforeEach(() => {
    win = new FakeWin();
    FakeObserver.last = undefined;
  });

  async function open(options: Parameters<typeof fakePdfjs>[0] = {}, page: Parameters<typeof viewerPage>[0] = {}) {
    const fake = fakePdfjs(options);
    const view = viewerPage(page);
    const viewer = await wireViewer(view.doc, win, fake.pdfjs);
    const pages = view.parts['pages']!.children;
    return { ...fake, ...view, viewer, pages, io: FakeObserver.last! };
  }
  const press = async (el: FakeEl | undefined) => {
    el!.click();
    await flush();
  };

  it('does nothing without its markup, and leaves the no-script line', async () => {
    const { parts, opened, viewer } = await open({}, { drop: 'status' });
    expect(viewer).toBeUndefined();
    expect(opened).toEqual([]);
    expect(parts['nojs']!.hidden).toBe(false);
    expect(parts['js']!.hidden).toBe(true);
  });

  it('opens nothing but a same-origin /documents/<id>.pdf, with a same-origin worker', async () => {
    for (const page of [{ pdf: 'https://evil.example/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf' }, { pdf: '/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf?file=x' }, { pdf: '/documents/../x.pdf' }, { worker: 'https://cdn.example/pdf.worker.mjs' }]) {
      const { opened, parts, viewer, root } = await open({}, page);
      expect(viewer, JSON.stringify(page)).toBeUndefined();
      expect(opened).toEqual([]);
      expect(parts['status']!.textContent).toBe(FAILED);
      expect(root.classes.has('viewer--js')).toBe(false);
      expect(parts['nojs']!.hidden).toBe(true);
      expect(parts['js']!.hidden).toBe(true);
    }
  });

  it('opens the PDF without eval, wasm or XFA, and shows the controls, the page count and one box per page', async () => {
    const { opened, pdfjs, parts, pages, root } = await open();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/_astro/pdf.worker.min.abc.mjs');
    expect(opened).toEqual([{ url: '/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf', isEvalSupported: false, useWasm: false, enableXfa: false, maxImageSize: MAX_IMAGE_PIXELS, verbosity: 0 }]);
    expect(parts['nojs']!.hidden).toBe(true);
    expect(parts['js']!.hidden).toBe(false);
    expect(parts['pages']!.hidden).toBe(false);
    // READER2: the page is a box to type in, "1", then "of 3"; its spoken name says what to type.
    expect(parts['page']!.value).toBe('1');
    expect(parts['count']!.textContent).toBe('3');
    expect(parts['page']!.style.props.get('--digits')).toBe('1');
    expect(root.classes.has('viewer--js')).toBe(true);
    expect(parts['page']!.getAttribute('aria-label')).toBe('Page number, 1 to 3');
    expect(parts['zoom']!.getAttribute('aria-label')).toBe(`Zoom ${chosen(parts['zoom'])}`);
    expect(pages.map((p) => p.id)).toEqual(['page-1', 'page-2', 'page-3']);
    expect(pages.map((p) => p.querySelector('h2')?.textContent)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(parts['status']!.textContent).toBe('');
    expect(OPENING).toBe('Opening the issue');
  });

  // W-LOOK3 (Ross's mockup): the page fills the frame's width, on a computer as on a phone; Fit width shows pressed.
  it('opens at Fit width on a computer and a phone alike, with Fit width pressed', async () => {
    for (const phone of [false, true]) {
      win.phone = phone;
      const { parts, pages } = await open();
      const fit = 600 / PAGE.width;
      expect(chosen(parts['zoom'])).toBe(percent(fit));
      expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('true');
      expect(parts['fit-page']!.getAttribute('aria-pressed')).toBe('false');
      expect(pages[0]!.style.width).toBe(`${PAGE.width * fit}px`);
      expect(pages[0]!.style.props.get('--scale-factor')).toBe(String(fit * CSS_UNITS));
    }
  });

  it('draws only the pages that come near, with their text and links, and lets go of those that move away', async () => {
    const { io, log, pages, parts } = await open();
    expect(log).toEqual([]);
    expect((io.options as { rootMargin: string }).rootMargin).toBe('100% 0px');
    io.near(1);
    await flush();
    const scale = (600 / PAGE.width) * CSS_UNITS;
    expect(log).toEqual([`draw 1 ${Math.floor(612 * scale * 2)}x${Math.floor(792 * scale * 2)} x2`]);
    const layer = pages[0]!.querySelector('[data-viewer-layer]')!;
    expect(layer.children.map((c) => c.tag)).toEqual(['canvas', 'div', 'div']);
    expect(layer.children[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(layer.children[1]!.className).toBe('textLayer');
    expect(layer.children[1]!.children[0]!.textContent).toBe('text of 1');
    expect(layer.children[2]!.className).toBe('annotationLayer');
    expect(parts['status']!.textContent).toBe('');
    io.near(2);
    await flush();
    expect(log.slice(1)).toEqual(['cleanup 1', expect.stringMatching(/^draw 2 /)]);
    expect(layer.children).toEqual([]);
  });

  it('says politely which page it is loading, and that one could not be shown', async () => {
    const held = await open({ hold: true });
    held.io.near(1);
    await flush();
    expect(held.parts['status']!.textContent).toBe(loading(1));
    expect(loading(1)).toBe('Loading page 1');
    held.pending.shift()!();
    await flush();
    expect(held.parts['status']!.textContent).toBe('');
    const broken = await open();
    broken.pdfjs.TextLayer = class {
      render() {
        return Promise.reject(new Error('bad text'));
      }
    } as unknown as typeof broken.pdfjs.TextLayer;
    broken.io.near(1);
    await flush();
    expect(broken.parts['status']!.textContent).toBe('Page 1 could not be shown. Use Open in another app, or Download.');
  });

  it('zooms in and out by steps, redrawing near pages at the new size, and stops at the ends', async () => {
    const { io, log, parts, pages } = await open();
    io.near(1);
    await flush();
    await press(parts['zoom-in']);
    const fit = 600 / PAGE.width;
    expect(chosen(parts['zoom'])).toBe(percent(zoomIn(fit)));
    // Zoomed: neither fit is pressed.
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('false');
    expect(parts['fit-page']!.getAttribute('aria-pressed')).toBe('false');
    expect(pages[1]!.style.width).toBe(`${PAGE.width * zoomIn(fit)}px`);
    expect(log.filter((l) => l.startsWith('draw 1'))).toHaveLength(2);
    for (let i = 0; i < 12; i++) await press(parts['zoom-in']);
    expect(chosen(parts['zoom'])).toBe(percent(4));
    expect(parts['zoom-in']!.getAttribute('aria-disabled')).toBe('true');
    expect(parts['zoom-out']!.getAttribute('aria-disabled')).toBe('false');
    for (let i = 0; i < 12; i++) await press(parts['zoom-out']);
    expect(chosen(parts['zoom'])).toBe(percent(0.25));
    expect(parts['zoom-out']!.getAttribute('aria-disabled')).toBe('true');
    await press(parts['fit-page']);
    expect(chosen(parts['zoom'])).toBe(percent(fitScale('page', PAGE, { width: 600, height: 724 })));
    expect(parts['fit-page']!.getAttribute('aria-pressed')).toBe('true');
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('false');
    await press(parts['fit-width']);
    expect(chosen(parts['zoom'])).toBe(percent(fit));
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('true');
  });

  // W-LOOK3: the zoom select, as Ross's mockup has it, beside the steps.
  it('zooms to the step chosen in the zoom picker, and a choice of the size it is at changes nothing', async () => {
    const { parts, pages } = await open();
    const choose = async (value: string) => {
      parts['zoom']!.click();
      pick(parts['zoom-list'], value);
      await flush();
    };
    const fitted = parts['zoom']!.value;
    expect(parts['zoom-list']!.children.map((o) => o.textContent)).toContain(percent(600 / PAGE.width));
    await choose('2');
    expect(chosen(parts['zoom'])).toBe('200%');
    expect(parts['zoom-list']!.hidden).toBe(true);
    expect(parts['zoom']!.focused).toBe(true);
    expect(pages[0]!.style.width).toBe(`${PAGE.width * 2}px`);
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('false');
    // At a step, no other size is listed, and the step it is at is marked.
    expect(parts['zoom-list']!.children.map((o) => o.value)).toEqual(ZOOMS.map(String));
    expect(parts['zoom-list']!.children.filter((o) => o.getAttribute('aria-current') === 'true').map((o) => o.value)).toEqual(['2']);
    await press(parts['fit-width']);
    expect(parts['zoom']!.value).toBe(fitted);
    await choose(fitted);
    expect(parts['zoom']!.value).toBe(fitted);
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the place being read when the size changes', async () => {
    const { parts, pages } = await open();
    pages[0]!.rect = { top: -1050, height: 1000, width: 600 };
    pages[1]!.rect = { top: -50, height: 1000, width: 600 };
    pages[2]!.rect = { top: 950, height: 1000, width: 600 };
    win.dispatchEvent(new Event('scroll'));
    expect(parts['page']!.value).toBe('2');
    // The bar ends at 60 px: 110 px of page 2's 1000 are above it. At the new size, as much of it again.
    pages[1]!.rect = { top: -50, height: 500, width: 600 };
    await press(parts['zoom-out']);
    expect(win.scrolledBy).toBeCloseTo(-50 + 0.11 * 500 - 60);
  });

  it('leaves the window where it is when the size changes before the reader has reached the pages', async () => {
    const { parts, pages } = await open();
    pages[0]!.rect = { top: 500, height: 1000, width: 600 };
    await press(parts['zoom-in']);
    await press(parts['fit-page']);
    expect(win.scrolledBy).toBe(0);
  });

  it('keeps the space under the bar for a page it goes to, as tall as the bar is', async () => {
    const { parts } = await open();
    expect(parts['pages']!.style.props.get('--viewer-bar')).toBe('60px');
    parts['bar']!.rect = { top: 0, height: 150, width: 300 };
    win.dispatchEvent(new Event('resize'));
    expect(parts['pages']!.style.props.get('--viewer-bar')).toBe('150px');
  });

  // PDFVIEW fix 1 (B2): pinned at the top, a bar of several rows at a large text size would leave a
  // landscape phone no room for the issue. It stays pinned only while it takes at most a third of the
  // window; otherwise it scrolls away with the page, and a page gone to stops at the window's top.
  it('keeps the bar at the top only while it takes at most a third of the window, and the space under it in step', async () => {
    const { root, parts } = await open();
    expect(root.classes.has('viewer--unpinned')).toBe(false);
    expect(parts['pages']!.style.props.get('--viewer-bar')).toBe('60px');
    parts['bar']!.rect = { top: 0, height: 300, width: 600 };
    win.dispatchEvent(new Event('resize'));
    expect(root.classes.has('viewer--unpinned')).toBe(true);
    expect(parts['pages']!.style.props.get('--viewer-bar')).toBe('0px');
    win.innerHeight = 900;
    win.dispatchEvent(new Event('resize'));
    expect(root.classes.has('viewer--unpinned')).toBe(false);
    expect(parts['pages']!.style.props.get('--viewer-bar')).toBe('300px');
  });

  it('decides as it opens, from the start', async () => {
    win.innerHeight = 375;
    const view = viewerPage();
    view.parts['bar']!.rect = { top: 0, height: 200, width: 600 };
    await wireViewer(view.doc, win, fakePdfjs().pdfjs);
    expect(view.root.classes.has('viewer--unpinned')).toBe(true);
    expect(view.parts['pages']!.style.props.get('--viewer-bar')).toBe('0px');
  });

  it('with the bar in the flow, Fit page uses the whole window, and the place read is measured from the top of the window', async () => {
    win.innerHeight = 600;
    const view = viewerPage();
    view.parts['bar']!.rect = { top: 0, height: 250, width: 600 };
    await wireViewer(view.doc, win, fakePdfjs().pdfjs);
    view.parts['fit-page']!.click();
    // The fake's first page sits at the window's top, under the bar: what the fit scrolled is not this test's.
    win.scrolledBy = 0;
    expect(chosen(view.parts['zoom'])).toBe(percent(fitScale('page', PAGE, { width: 600, height: 600 - 16 })));
    // The bar has scrolled away above the window: the reading line is a third down the window itself.
    view.parts['bar']!.rect = { top: -900, height: 250, width: 600 };
    const pages = view.parts['pages']!.children;
    pages[0]!.rect = { top: -700, height: 500, width: 600 };
    pages[1]!.rect = { top: -100, height: 500, width: 600 };
    pages[2]!.rect = { top: 400, height: 500, width: 600 };
    win.dispatchEvent(new Event('scroll'));
    expect(view.parts['page']!.value).toBe('2');
    // And a new size keeps that place, a fifth of the way down page 2, from the window's top.
    pages[1]!.rect = { top: -100, height: 400, width: 600 };
    view.parts['zoom-out']!.click();
    await flush();
    expect(win.scrolledBy).toBeCloseTo(-100 + 0.2 * 400);
  });

  it('decides again when the bar itself changes size, as when the reader picks a larger text size', async () => {
    const withObserver = win as FakeWin & { ResizeObserver?: typeof FakeResizeObserver };
    withObserver.ResizeObserver = FakeResizeObserver;
    const { root, parts } = await open();
    expect(FakeResizeObserver.last!.watched).toEqual([parts['bar']]);
    parts['bar']!.rect = { top: 0, height: 400, width: 600 };
    FakeResizeObserver.last!.resized();
    expect(root.classes.has('viewer--unpinned')).toBe(true);
  });

  it('a drawing that is no longer wanted is cancelled and drawn again at the new size', async () => {
    const { io, log, parts, pending } = await open({ hold: true });
    io.near(1);
    await flush();
    await press(parts['zoom-in']);
    expect(log.filter((l) => l.startsWith('cancel 1'))).toHaveLength(1);
    while (pending.length) {
      pending.shift()!();
      await flush();
    }
    expect(log.filter((l) => l.startsWith('draw 1'))).toHaveLength(2);
    expect(parts['status']!.textContent).toBe('');
  });

  it('goes to the next and previous page, says which, and never past the ends', async () => {
    const { parts, pages } = await open();
    expect(parts['prev']!.getAttribute('aria-disabled')).toBe('true');
    await press(parts['next']);
    expect(pages[1]!.scrolled).toBe(1);
    expect(parts['page']!.value).toBe('2');
    await press(parts['next']);
    expect(parts['next']!.getAttribute('aria-disabled')).toBe('true');
    await press(parts['next']);
    expect(pages[2]!.scrolled).toBe(1);
    await press(parts['prev']);
    expect(pages[1]!.scrolled).toBe(2);
    expect(parts['status']!.textContent).toBe('Page 2 of 3');
    await press(parts['prev']);
    await press(parts['prev']);
    expect(pages[0]!.scrolled).toBe(1);
    expect(parts['page']!.value).toBe('1');
  });

  // READER2: |<< < [n] of N > >>|, the page typed and Enter (a phone's Go), or the box left (iOS's number pad has no Enter).
  it('goes to the page typed in the box on Enter, or when the box is left; says so, and never leaves a wrong one', async () => {
    const { parts, pages } = await open();
    const box = parts['page']!;
    const key = (k: string, more: object = {}) => {
      const event = Object.assign(new Event('keydown', { cancelable: true }), { key: k, ...more });
      box.dispatchEvent(event);
      return event;
    };
    box.focus();
    expect(box.selected).toBe(false);
    box.dispatchEvent(new Event('focus'));
    // The page shown is chosen, and the first thing typed replaces it, wherever the caret is: WebKit puts
    // its caret at the start after a tap, so "2" typed over "1" would be "21".
    expect(box.selected).toBe(true);
    /** The browser's input event, after it has changed the box to `value`. */
    const input = (value: string, inputType: string, data: string | null) => {
      box.value = value;
      box.dispatchEvent(Object.assign(new Event('input'), { inputType, data }));
    };
    input('21', 'insertText', '2');
    expect(box.value).toBe('2');
    input('23', 'insertText', '3');
    expect(box.value).toBe('23');
    // What the browser could not say it typed (a paste) is kept as it is.
    box.dispatchEvent(new Event('focus'));
    input('112', 'insertFromPaste', null);
    expect(box.value).toBe('112');
    // A deletion, or a move of the caret, first, and it is edited as usual.
    box.dispatchEvent(new Event('focus'));
    input('', 'deleteContentBackward', null);
    input('2', 'insertText', '2');
    input('12', 'insertText', '1');
    expect(box.value).toBe('12');
    box.dispatchEvent(new Event('focus'));
    key('ArrowLeft');
    input('312', 'insertText', '3');
    expect(box.value).toBe('312');
    box.value = '3';
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(pages[2]!.scrolled).toBe(1);
    expect(parts['status']!.textContent).toBe('Page 3 of 3');
    // After a page is gone to, what is typed next replaces it again.
    input('32', 'insertText', '2');
    expect(box.value).toBe('2');
    box.value = '3';
    // What the box shows is not changed under the reader's fingers while they type.
    box.value = '2';
    parts['next']!.click();
    expect(box.value).toBe('2');
    box.blur();
    // Left with a page typed, it goes there; left as it was, nothing more happens.
    box.dispatchEvent(new Event('change'));
    expect(pages[1]!.scrolled).toBe(1);
    expect(box.value).toBe('2');
    box.dispatchEvent(new Event('change'));
    expect(pages[1]!.scrolled).toBe(1);
    // A page that is not in the issue: said plainly, the box marked, then given back the page being read.
    box.focus();
    for (const typed of ['9', '0', 'two']) {
      box.value = typed;
      key('Enter');
      expect(parts['status']!.textContent).toBe(noPage(3));
      expect(box.getAttribute('aria-invalid')).toBe('true');
      expect(box.value).toBe('2');
    }
    box.value = '1';
    box.dispatchEvent(new Event('change'));
    expect(pages[0]!.scrolled).toBe(1);
    expect(box.hasAttribute('aria-invalid')).toBe(false);
    // Another key is the box's own.
    expect(key('5').defaultPrevented).toBe(false);
  });

  it('goes to the first and last page, each turned off where it would change nothing', async () => {
    const { parts, pages } = await open();
    expect(parts['first']!.getAttribute('aria-disabled')).toBe('true');
    expect(parts['last']!.getAttribute('aria-disabled')).toBe('false');
    await press(parts['last']);
    expect(pages[2]!.scrolled).toBe(1);
    expect(parts['page']!.value).toBe('3');
    expect(parts['last']!.getAttribute('aria-disabled')).toBe('true');
    await press(parts['last']);
    expect(pages[2]!.scrolled).toBe(1);
    await press(parts['first']);
    expect(pages[0]!.scrolled).toBe(1);
    expect(parts['first']!.getAttribute('aria-disabled')).toBe('true');
  });

  // W-LOOK3: WebKit raises a style-src-attr violation for any native select under the site's CSP, so the
  // page and zoom are pickers: a button that opens a list of buttons, closed by Escape or a press elsewhere.
  it('a picker opens on a press with the focus on its marked choice, and closes by Escape, a press elsewhere, or the other picker', async () => {
    const { root, parts } = await open();
    const [button, list] = [parts['zoom']!, parts['zoom-list']!];
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.click();
    expect(list.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(list.children.find((o) => o.getAttribute('aria-current') === 'true')!.focused).toBe(true);
    button.focused = false;
    root.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(list.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.focused).toBe(true);
    // Another key, or Escape with nothing open, changes nothing.
    root.dispatchEvent(Object.assign(new Event('keydown'), { key: 'a' }));
    root.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(list.hidden).toBe(true);
    button.click();
    // A press inside the list, or on its button, leaves it to its own handlers; anywhere else closes it.
    const pointer = (target: FakeEl | undefined) => {
      const event = new Event('pointerdown');
      Object.defineProperty(event, 'target', { value: target });
      win.dispatchEvent(event);
    };
    pointer(list.children[1]);
    pointer(button);
    expect(list.hidden).toBe(false);
    pointer(parts['pages']);
    expect(list.hidden).toBe(true);
    // A second press closes it; opening one picker closes the other.
    button.click();
    button.click();
    expect(list.hidden).toBe(true);
    button.click();
    parts['more']!.click();
    expect(list.hidden).toBe(true);
    expect(parts['more-list']!.hidden).toBe(false);
  });

  it('follows the page being read as the reader scrolls', async () => {
    const { pages, parts } = await open();
    pages[0]!.rect = { top: -2000, height: 1000, width: 600 };
    pages[1]!.rect = { top: -1000, height: 1000, width: 600 };
    pages[2]!.rect = { top: 100, height: 1000, width: 600 };
    win.dispatchEvent(new Event('scroll'));
    expect(parts['page']!.value).toBe('3');
    expect(parts['next']!.getAttribute('aria-disabled')).toBe('true');
  });

  it('opens at #page=N, and goes there when the address changes', async () => {
    win.location.hash = '#page=2';
    const { pages } = await open();
    expect(pages[1]!.scrolled).toBe(1);
    win.location.hash = '#page=3';
    win.dispatchEvent(new Event('hashchange'));
    await flush();
    expect(pages[2]!.scrolled).toBe(1);
  });

  it('fits again when the window changes, unless the reader chose a zoom', async () => {
    const { parts } = await open();
    parts['pages']!.rect = { top: 0, height: 0, width: 300 };
    win.innerHeight = 400;
    win.dispatchEvent(new Event('resize'));
    expect(chosen(parts['zoom'])).toBe(percent(fitScale('width', PAGE, { width: 300, height: 324 })));
    await press(parts['zoom-in']);
    const picked = chosen(parts['zoom']);
    parts['pages']!.rect = { top: 0, height: 0, width: 900 };
    win.dispatchEvent(new Event('resize'));
    expect(chosen(parts['zoom'])).toBe(picked);
  });

  it("draws the copy's links only: the leaving page in the same tab, named; a link within the issue goes to its page", async () => {
    const annotations = {
      1: [
        { id: '1R', annotationType: 2, url: `https://nwflmensa.us/out/${ID}`, contentsObj: { str: 'Link to club.example' } },
        { id: '2R', annotationType: 2, url: 'mailto:events@example.org' },
        { id: '3R', annotationType: 2, url: 'javascript:alert(1)' },
        { id: '4R', annotationType: 2, dest: 'third' },
        { id: '5R', annotationType: 20, url: `https://nwflmensa.us/out/${ID}` },
        { id: '6R', annotationType: 2 },
        // An original's own links, and the URLs pdf.js makes of a Launch, a GoToR and app.launchURL (B1).
        { id: '7R', annotationType: 2, url: 'https://club.example/picnic' },
        { id: '8R', annotationType: 2, url: 'https://evil.example/launch.exe' },
        { id: '9R', annotationType: 2, url: 'https://evil.example/remote.pdf#[0,{"name":"Fit"}]' },
        { id: '10R', annotationType: 2, url: 'http://evil.example/plain' },
      ],
    };
    const { io, pages } = await open({ annotations });
    io.near(1);
    await flush();
    const links = pages[0]!.querySelectorAll('a');
    expect(links.map((a) => a.getAttribute('data-element-id'))).toEqual(['1R', '4R']);
    expect(links.map((a) => a.href)).toEqual([`/out/${ID}`, '#']);
    expect(links.map((a) => a.rel)).toEqual(['', '']);
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Link to club.example', 'Link 2 on page 1']);
    // No box is left for a link refused: nothing to tap, nothing for the keyboard to reach.
    expect(pages[0]!.querySelectorAll('section')).toHaveLength(2);
    expect(links[1]!.onclick!()).toBe(false);
    await flush();
    expect(pages[2]!.scrolled).toBe(1);
  });

  it('a link within the issue to nowhere goes nowhere', async () => {
    const { io, pages } = await open({ annotations: { 1: [{ id: '1R', annotationType: 2, dest: 'missing' }, { id: '2R', annotationType: 2, dest: [5] }] } });
    io.near(1);
    await flush();
    for (const a of pages[0]!.querySelectorAll('a')) a.onclick!();
    await flush();
    expect(pages.map((p) => p.scrolled)).toEqual([0, 0, 0]);
  });

  it('a page of another size is laid out at its own size once drawn', async () => {
    const { io, pages } = await open({ sizes: { 2: [792, 612] } });
    io.near(2);
    await flush();
    const fit = 600 / PAGE.width;
    expect(pages[1]!.style.width).toBe(`${792 * CSS_UNITS * fit}px`);
    expect(pages[2]!.style.width).toBe(`${PAGE.width * fit}px`);
  });

  // PDFVIEW fix 1 (S1): one box and one watched element per page, made at once; a file of 200,000
  // pages hung the tab. Past MAX_PAGES the reader says so and leaves the other ways to read it.
  it('a file longer than MAX_PAGES is not drawn: it says, in plain words, that it is too long to show here', async () => {
    expect(MAX_PAGES).toBe(1000);
    expect(TOO_LONG).toBe('This issue is too long to show here. You can open it in another app, or download it.');
    const { parts, pages, viewer, log } = await open({ pages: MAX_PAGES + 1 });
    expect(viewer).toBeUndefined();
    expect(parts['status']!.textContent).toBe(TOO_LONG);
    expect(pages).toHaveLength(0);
    expect(parts['count']!.textContent).toBe('');
    expect(parts['js']!.hidden).toBe(true);
    expect(parts['pages']!.hidden).toBe(true);
    expect(parts['nojs']!.hidden).toBe(true);
    // pdf.js lets the file go: nothing of it is kept.
    expect(log).toEqual(['destroy']);
  });

  it('a file of exactly MAX_PAGES is drawn', async () => {
    const { parts, pages, viewer } = await open({ pages: MAX_PAGES });
    expect(viewer).toBeDefined();
    expect(parts['count']!.textContent).toBe('1000');
    expect(parts['page']!.style.props.get('--digits')).toBe('4');
    expect(pages).toHaveLength(MAX_PAGES);
  });

  it('bounds each image pdf.js decodes, so one huge picture cannot exhaust a phone, yet a 600 dpi Letter scan still shows', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
    expect(5100 * 6600).toBeLessThan(MAX_IMAGE_PIXELS);
  });

  it('says so in plain words, and offers the other ways, when the PDF cannot be opened', async () => {
    const { parts, viewer } = await open({ fail: true });
    expect(viewer).toBeUndefined();
    expect(parts['status']!.textContent).toBe(FAILED);
    expect(FAILED).toBe('The issue could not be shown here. Use Open in another app, or Download.');
    expect(parts['js']!.hidden).toBe(true);
    expect(parts['pages']!.hidden).toBe(true);
    expect(parts['nojs']!.hidden).toBe(true);
  });
});

describe('the edges of wireViewer', () => {
  let win: FakeWin;
  beforeEach(() => {
    win = new FakeWin();
  });

  it('a page with no viewer, or one that names no file, opens nothing', async () => {
    const fake = fakePdfjs();
    const empty = viewerPage();
    empty.root.removeAttribute('data-viewer');
    expect(await wireViewer(empty.doc, win, fake.pdfjs)).toBeUndefined();
    const nameless = viewerPage();
    delete nameless.root.dataset['pdf'];
    delete nameless.root.dataset['worker'];
    expect(await wireViewer(nameless.doc, win, fake.pdfjs)).toBeUndefined();
    expect(fake.opened).toEqual([]);
  });

  it('draws at one pixel per CSS px on a screen of ratio 1, with no transform', async () => {
    win.devicePixelRatio = 1;
    const fake = fakePdfjs();
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    FakeObserver.last!.near(1);
    await flush();
    expect(fake.log[0]).toMatch(/^draw 1 \d+x\d+$/);
  });

  it('a page that moves away while it waits its turn is never drawn', async () => {
    const fake = fakePdfjs({ hold: true });
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    FakeObserver.last!.near(1, 2);
    await flush();
    FakeObserver.last!.near(3);
    await flush();
    while (fake.pending.length) {
      fake.pending.shift()!();
      await flush();
    }
    expect(fake.log.filter((l) => l.startsWith('draw')).map((l) => l.split(' ')[1])).toEqual(['1', '3']);
  });

  it('a page let go before pdf.js has it is never drawn', async () => {
    const fake = fakePdfjs();
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    FakeObserver.last!.near(1);
    FakeObserver.last!.near();
    await flush();
    expect(fake.log).toEqual([]);
  });

  it('a link to a page before the first, the same fit again, a page of no height, an unknown hash, and a scroll mid-frame change nothing', async () => {
    const fake = fakePdfjs({ annotations: { 1: [{ id: '1R', annotationType: 2, dest: [-1] }] } });
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    const pages = view.parts['pages']!.children;
    FakeObserver.last!.near(1);
    await flush();
    pages[0]!.querySelector('a')!.onclick!();
    await flush();
    expect(pages.map((p) => p.scrolled)).toEqual([0, 0, 0]);
    const before = chosen(view.parts['zoom']);
    win.dispatchEvent(new Event('resize'));
    expect(chosen(view.parts['zoom'])).toBe(before);
    expect(fake.log.filter((l) => l.startsWith('draw'))).toHaveLength(1);
    pages[0]!.rect = { top: 0, height: 0, width: 600 };
    pages[1]!.rect = { top: 1000, height: 1000, width: 600 };
    pages[2]!.rect = { top: 2000, height: 1000, width: 600 };
    win.dispatchEvent(new Event('scroll'));
    expect(view.parts['page']!.value).toBe('1');
    win.location.hash = '#nothing';
    win.dispatchEvent(new Event('hashchange'));
    expect(pages.map((p) => p.scrolled)).toEqual([0, 0, 0]);
    const frames: (() => void)[] = [];
    win.requestAnimationFrame = (fn: () => void) => frames.push(fn);
    win.dispatchEvent(new Event('scroll'));
    win.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
  });

  it("names a link pdf.js drew without the copy's id, and drops a refused or outside link that has no section", async () => {
    const fake = fakePdfjs({ annotations: { 1: [{ id: '1R', annotationType: 2, url: 'https://club.example/' }] } });
    fake.pdfjs.AnnotationLayer = class {
      constructor(readonly o: { div: FakeEl }) {}
      render() {
        const named = new FakeEl('a');
        named.setAttribute('href', `/out/${ID}`);
        const bare = new FakeEl('a');
        // However pdf.js came to give it, an address that is not /out/<id> or a place in the issue is dropped.
        const outside = new FakeEl('a');
        outside.setAttribute('href', 'https://club.example/');
        const absolute = new FakeEl('a');
        absolute.href = `https://site.example/out/${ID}`;
        this.o.div.append(named, bare, outside, absolute);
        return Promise.resolve();
      }
    } as unknown as typeof fake.pdfjs.AnnotationLayer;
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    FakeObserver.last!.near(1);
    await flush();
    const links = view.parts['pages']!.children[0]!.querySelectorAll('a');
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual(['Link 1 on page 1']);
  });

  it('a drawing pdf.js itself cancelled says nothing', async () => {
    const fake = fakePdfjs();
    fake.pdfjs.TextLayer = class {
      render() {
        return Promise.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' }));
      }
    } as unknown as typeof fake.pdfjs.TextLayer;
    const view = viewerPage();
    await wireViewer(view.doc, win, fake.pdfjs);
    FakeObserver.last!.near(1);
    await flush();
    expect(view.parts['status']!.textContent).toBe('');
  });
});

describe('READER2', () => {
  let win: FakeWin;
  beforeEach(() => {
    win = new FakeWin();
    FakeObserver.last = undefined;
    FakeMutationObserver.last = undefined;
  });
  async function open(options: Parameters<typeof fakePdfjs>[0] = {}, setup: (view: ReturnType<typeof viewerPage>) => void = () => {}) {
    const fake = fakePdfjs(options);
    const view = viewerPage();
    setup(view);
    const viewer = await wireViewer(view.doc, win, fake.pdfjs);
    const pages = view.parts['pages']!.children;
    return { ...fake, ...view, viewer, pages, io: FakeObserver.last! };
  }
  const key = (target: EventTarget, k: string, more: object = {}) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key: k, ...more });
    target.dispatchEvent(event);
    return event;
  };
  const DARK = '(prefers-color-scheme: dark)';
  const MORE = '(prefers-contrast: more)';

  describe('DARKPDF: the pages follow the theme', () => {
    it("takes the tone from the reader's theme, else the device's, and follows either as it changes, with nothing redrawn", async () => {
      const { root, doc, log } = await open({}, (view) => view.doc.documentElement.setAttribute('data-theme', 'dark'));
      expect(root.dataset['tone']).toBe('dark');
      const watch = FakeMutationObserver.last!.watched[0]!;
      expect(watch.el).toBe(doc.documentElement);
      expect(watch.options).toEqual({ attributes: true, attributeFilter: ['data-theme'] });
      doc.documentElement.setAttribute('data-theme', 'contrast-yellow');
      FakeMutationObserver.last!.changed();
      expect(root.dataset['tone']).toBe('tint');
      doc.documentElement.removeAttribute('data-theme');
      FakeMutationObserver.last!.changed();
      expect(root.dataset['tone']).toBe('light');
      win.setMedia(DARK, true);
      expect(root.dataset['tone']).toBe('dark');
      win.setMedia(MORE, true);
      expect(root.dataset['tone']).toBe('tint');
      expect(log.filter((l) => l.startsWith('draw'))).toEqual([]);
    });

    it('without MutationObserver it still takes the tone as it opens', async () => {
      win.MutationObserver = undefined;
      win.setMedia(DARK, true);
      const { root } = await open();
      expect(root.dataset['tone']).toBe('dark');
    });

    it('Light pages shows the pages as printed, pressed, on the bar and in the More menu alike', async () => {
      const { root, parts, menu } = await open();
      expect(parts['tone']!.getAttribute('aria-pressed')).toBe('false');
      parts['tone']!.click();
      expect(root.classes.has('viewer--light-pages')).toBe(true);
      expect(parts['tone']!.getAttribute('aria-pressed')).toBe('true');
      expect(menu['tone']!.getAttribute('aria-pressed')).toBe('true');
      menu['tone']!.click();
      expect(root.classes.has('viewer--light-pages')).toBe(false);
      expect(parts['tone']!.getAttribute('aria-pressed')).toBe('false');
    });

    // A recoloured page (a CSS filter or blend) costs the browser a second buffer as large as its canvas;
    // WebKit ran out of memory with both at full size, so such a page is drawn at half the pixels.
    it('draws a recoloured page at no more than TONED_PIXELS, and a page as printed at up to MAX_PIXELS', async () => {
      expect(TONED_PIXELS).toBe(MAX_PIXELS / 2);
      const area = (el: FakeEl) => el.width * el.height;
      for (const [theme, light, max] of [['dark', false, TONED_PIXELS], ['contrast-white', false, TONED_PIXELS], ['light', false, MAX_PIXELS], ['dark', true, MAX_PIXELS]] as const) {
        win.devicePixelRatio = 3;
        const { io, pages, parts } = await open({}, (view) => view.doc.documentElement.setAttribute('data-theme', theme));
        if (light) parts['tone']!.click();
        for (let i = 0; i < 9; i++) parts['zoom-in']!.click();
        io.near(1);
        await flush();
        const sheet = pages[0]!.querySelector('canvas')!;
        expect(area(sheet), `${theme} ${light}`).toBeLessThanOrEqual(max);
        expect(area(sheet), `${theme} ${light}`).toBeGreaterThan(max * 0.98);
      }
    });

    it('draws each page as printed, asks pdf.js where its pictures are, and lays each picture over the drawing unrecoloured', async () => {
      const { io, pages, renders } = await open({ images: { 1: [0.1, 0.2, 0.1, 0.5, 0.6, 0.2], 2: [0, 0, 0, 1, 1, 0] } });
      io.near(1, 2, 3);
      await flush();
      expect(renders.map((r) => r['recordImages'])).toEqual([true, true, true]);
      expect(renders.every((r) => r['pageColors'] === undefined)).toBe(true);
      const layer = (n: number) => pages[n]!.querySelector('[data-viewer-layer]')!.children;
      const [sheet, photo] = layer(0);
      expect(sheet!.classes.has('viewer-sheet')).toBe(true);
      expect(sheet!.classes.has('viewer-sheet--picture')).toBe(false);
      expect(photo!.classes.has('viewer-photo')).toBe(true);
      expect(photo!.drawn[0]![0]).toBe(sheet);
      // A page that is one picture (a scan) stays as printed, with no copy; a page with none has none.
      expect(layer(1)[0]!.classes.has('viewer-sheet--picture')).toBe(true);
      expect(layer(1).filter((el) => el.classes.has('viewer-photo'))).toEqual([]);
      expect(layer(2).filter((el) => el.classes.has('viewer-photo'))).toEqual([]);
    });
  });

  describe('search within the issue', () => {
    const TEXTS = {
      1: [{ str: 'Pensa Mensa', hasEOL: true }, { str: 'The picnic' }],
      2: [],
      3: [{ str: 'Picnic on Saturday.', hasEOL: true }, { str: 'Bring a picnic' }],
    };
    const typed = async (parts: Record<string, FakeEl>, text: string) => {
      parts['find-input']!.value = text;
      parts['find-input']!.dispatchEvent(new Event('input'));
      await flush();
    };

    it('the magnifier opens the search row, focused; a query finds every match in the served file only, says which of how many, and goes to the first', async () => {
      const { parts, pages, io, log } = await open({ texts: TEXTS });
      expect(parts['find']!.getAttribute('aria-expanded')).toBe('false');
      parts['find']!.click();
      await flush();
      expect(parts['find-bar']!.hidden).toBe(false);
      expect(parts['find']!.getAttribute('aria-expanded')).toBe('true');
      expect(parts['find-input']!.focused).toBe(true);
      // The text of every page, read once, from the file the viewer opened.
      expect(log.filter((l) => l.startsWith('text'))).toEqual([1, 2, 3].map((n) => `text ${n} {"includeMarkedContent":true,"disableNormalization":true}`));
      await typed(parts, '  PICNIC ');
      expect(parts['find-count']!.textContent).toBe('1 of 3');
      expect(pages[0]!.scrolled).toBe(1);
      // Painted where the page is drawn, the current match apart, and scrolled to.
      io.near(1);
      await flush();
      const hits = pages[0]!.querySelectorAll('mark').filter((el) => el.classes.has('viewer-hit'));
      expect(hits.map((h) => [h.textContent, h.classes.has('viewer-hit--current')])).toEqual([['picnic', true]]);
      expect(hits[0]!.scrolledInto).toEqual([{ block: 'center', inline: 'center' }]);
      // Next and previous, round the ends; Enter and Shift+Enter in the field do the same.
      parts['find-next']!.click();
      expect(parts['find-count']!.textContent).toBe('2 of 3');
      expect(pages[2]!.scrolled).toBe(1);
      key(parts['find-input']!, 'Enter');
      expect(parts['find-count']!.textContent).toBe('3 of 3');
      key(parts['find-input']!, 'Enter');
      expect(parts['find-count']!.textContent).toBe('1 of 3');
      const again = pages[0]!.querySelectorAll('mark').filter((el) => el.classes.has('viewer-hit--current'));
      expect(again[0]!.scrolledInto).toEqual([{ block: 'center', inline: 'center' }]);
      key(parts['find-input']!, 'Enter', { shiftKey: true });
      expect(parts['find-count']!.textContent).toBe('3 of 3');
      parts['find-prev']!.click();
      expect(parts['find-count']!.textContent).toBe('2 of 3');
      // Another key is the field's own.
      expect(key(parts['find-input']!, 'a').defaultPrevented).toBe(false);
    });

    it('starts from the page being read, says when nothing matches, and an empty query clears it', async () => {
      const { parts, io, pages } = await open({ texts: TEXTS });
      parts['next']!.click();
      parts['next']!.click();
      io.near(3);
      await flush();
      parts['find']!.click();
      await typed(parts, 'picnic');
      expect(parts['find-count']!.textContent).toBe('2 of 3');
      const painted = () => pages[2]!.querySelectorAll('mark').filter((el) => el.classes.has('viewer-hit')).map((h) => h.textContent);
      expect(painted()).toEqual(['Picnic', 'picnic']);
      await typed(parts, 'members only canary');
      expect(parts['find-count']!.textContent).toBe('No matches');
      expect(painted()).toEqual([]);
      parts['find-next']!.click();
      parts['find-prev']!.click();
      expect(parts['find-count']!.textContent).toBe('No matches');
      await typed(parts, '   ');
      expect(parts['find-count']!.textContent).toBe('');
    });

    it('says when the page being read has no searchable text (a scanned page), and a page whose text cannot be read is one', async () => {
      const { parts } = await open({ texts: { ...TEXTS, 3: 'fail' } });
      parts['find']!.click();
      await flush();
      expect(parts['find-note']!.textContent).toBe('');
      parts['next']!.click();
      expect(parts['find-note']!.textContent).toBe(NO_TEXT);
      parts['next']!.click();
      expect(parts['find-note']!.textContent).toBe(NO_TEXT);
      await typed(parts, 'picnic');
      expect(parts['find-count']!.textContent).toBe('1 of 1');
    });

    it('Escape closes it, takes the marks away and gives the focus back; "/" opens it, but never from a field or with a modifier', async () => {
      const { root, doc, parts, io, pages } = await open({ texts: TEXTS });
      io.near(1);
      await flush();
      parts['find']!.focus();
      parts['find']!.click();
      await typed(parts, 'picnic');
      key(root, 'Escape');
      expect(parts['find-bar']!.hidden).toBe(true);
      expect(parts['find']!.getAttribute('aria-expanded')).toBe('false');
      expect(parts['find']!.focused).toBe(true);
      expect(pages[0]!.querySelectorAll('mark').filter((el) => el.classes.has('viewer-hit'))).toEqual([]);
      // Escape again changes nothing.
      key(root, 'Escape');
      expect(parts['find-bar']!.hidden).toBe(true);
      for (const [target, more] of [
        [parts['page']!, {}],
        [Object.assign(new FakeEl('div'), { isContentEditable: true }), {}],
        [doc.body, { ctrlKey: true }],
        [doc.body, { metaKey: true }],
        [doc.body, { altKey: true }],
      ] as const) {
        const event = Object.assign(new Event('keydown', { cancelable: true }), { key: '/', ...more });
        Object.defineProperty(event, 'target', { value: target });
        win.dispatchEvent(event);
        expect(parts['find-bar']!.hidden).toBe(true);
      }
      const slash = Object.assign(new Event('keydown', { cancelable: true }), { key: '/' });
      Object.defineProperty(slash, 'target', { value: doc.body });
      win.dispatchEvent(slash);
      await flush();
      expect(slash.defaultPrevented).toBe(true);
      expect(parts['find-bar']!.hidden).toBe(false);
      expect(parts['find-input']!.focused).toBe(true);
      // Its query is kept: open again, its matches are found again.
      expect(parts['find-count']!.textContent).toBe('1 of 3');
      parts['find-close']!.click();
      expect(parts['find-bar']!.hidden).toBe(true);
      // The magnifier closes it as well as opening it.
      parts['find']!.click();
      await flush();
      parts['find']!.click();
      expect(parts['find-bar']!.hidden).toBe(true);
      // A "/" from no element at all (the window) opens it too.
      win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: '/' }));
      expect(parts['find-bar']!.hidden).toBe(false);
    });

    it('from the More menu, the menu closes and the focus comes back to its button', async () => {
      const { parts, menu } = await open({ texts: TEXTS });
      parts['more']!.click();
      menu['find']!.click();
      await flush();
      expect(parts['more-list']!.hidden).toBe(true);
      expect(parts['find-bar']!.hidden).toBe(false);
      parts['find-close']!.click();
      expect(parts['more']!.focused).toBe(true);
    });

    it('a query typed while the text is still being read waits for it, and only the last query counts', async () => {
      const { parts } = await open({ texts: TEXTS });
      parts['find']!.click();
      parts['find-input']!.value = 'pensa';
      parts['find-input']!.dispatchEvent(new Event('input'));
      parts['find-input']!.value = 'saturday';
      parts['find-input']!.dispatchEvent(new Event('input'));
      await flush();
      expect(parts['find-count']!.textContent).toBe('1 of 1');
    });

    it('a match on a page let go is painted again when it is drawn again', async () => {
      const { parts, io, pages } = await open({ texts: TEXTS });
      parts['find']!.click();
      await typed(parts, 'pensa');
      io.near(1);
      await flush();
      io.near(3);
      await flush();
      io.near(1);
      await flush();
      expect(pages[0]!.querySelectorAll('mark').filter((el) => el.classes.has('viewer-hit')).map((h) => h.textContent)).toEqual(['Pensa']);
    });
  });

  describe('panning sideways, zoomed wider than the frame', () => {
    const wide = async () => {
      const view = await open();
      view.parts['pages']!.scrollWidth = 1800;
      view.parts['zoom-in']!.click();
      await flush();
      return view;
    };

    it('shows a scrollbar kept at the foot of the window, as wide as the pages, in step with them both ways', async () => {
      const { root, parts } = await open();
      parts['pages']!.scrollWidth = 600;
      win.dispatchEvent(new Event('resize'));
      expect(parts['pan']!.hidden).toBe(true);
      expect(root.classes.has('viewer--wide')).toBe(false);
      parts['pages']!.scrollWidth = 1800;
      parts['zoom-in']!.click();
      expect(parts['pan']!.hidden).toBe(false);
      expect(root.classes.has('viewer--wide')).toBe(true);
      expect(parts['pan-track']!.style.width).toBe('1800px');
      parts['pan']!.scrollLeft = 300;
      parts['pan']!.dispatchEvent(new Event('scroll'));
      expect(parts['pages']!.scrollLeft).toBe(300);
      parts['pages']!.scrollLeft = 120;
      parts['pages']!.dispatchEvent(new Event('scroll'));
      expect(parts['pan']!.scrollLeft).toBe(120);
      // In step already: nothing is set.
      parts['pan']!.dispatchEvent(new Event('scroll'));
      parts['pages']!.dispatchEvent(new Event('scroll'));
      expect([parts['pan']!.scrollLeft, parts['pages']!.scrollLeft]).toEqual([120, 120]);
      // The scrollbar's own echo of a value the pages gave it, arriving after the pages moved on (a drag),
      // never pulls them back.
      parts['pages']!.scrollLeft = 150;
      parts['pan']!.dispatchEvent(new Event('scroll'));
      expect(parts['pages']!.scrollLeft).toBe(150);
      parts['pages']!.dispatchEvent(new Event('scroll'));
      expect(parts['pan']!.scrollLeft).toBe(150);
      // The reader's own move of the scrollbar still moves the pages; once in step, nothing more is set.
      parts['pan']!.scrollLeft = 40;
      parts['pan']!.dispatchEvent(new Event('scroll'));
      expect(parts['pages']!.scrollLeft).toBe(40);
      parts['pan']!.dispatchEvent(new Event('scroll'));
      expect(parts['pages']!.scrollLeft).toBe(40);
    });

    it('a page wider than the first (a landscape spread), once drawn, brings the scrollbar and the hand tool (S2)', async () => {
      const { root, parts, io } = await open({ sizes: { 2: [1584, 612] } });
      parts['pages']!.scrollWidth = 600;
      win.dispatchEvent(new Event('resize'));
      expect(root.classes.has('viewer--wide')).toBe(false);
      // Laid out at its own size as it is drawn, the pages grow wider than the frame.
      parts['pages']!.scrollWidth = 1584;
      io.near(2);
      await flush();
      expect(root.classes.has('viewer--wide')).toBe(true);
      expect(parts['pan']!.hidden).toBe(false);
      expect(parts['pan-track']!.style.width).toBe('1584px');
    });

    it("the pages' own echo of a move of the scrollbar, arriving after the scrollbar moved on, never pulls it back (S3)", async () => {
      const { parts } = await wide();
      for (let x = 24; x <= 600; x += 24) {
        parts['pan']!.scrollLeft = x;
        parts['pan']!.dispatchEvent(new Event('scroll'));
        // The pages' scroll event for the last value comes a frame late, after the next move of the bar.
        parts['pan']!.scrollLeft = x + 24;
        parts['pages']!.dispatchEvent(new Event('scroll'));
        expect(parts['pan']!.scrollLeft, String(x)).toBe(x + 24);
        parts['pan']!.scrollLeft = x;
      }
      expect(parts['pages']!.scrollLeft).toBe(600);
      // A move of the pages themselves (the wheel) still moves the bar.
      parts['pages']!.scrollLeft = 30;
      parts['pages']!.dispatchEvent(new Event('scroll'));
      expect(parts['pan']!.scrollLeft).toBe(30);
    });

    it('Shift and the wheel pan sideways where the browser does not, in lines or pixels; a sideways wheel is left to the browser', async () => {
      const { parts } = await wide();
      const wheel = (more: object) => {
        const event = Object.assign(new Event('wheel', { cancelable: true }), { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ...more });
        parts['pages']!.dispatchEvent(event);
        return event;
      };
      expect(wheel({ shiftKey: true, deltaY: 100 }).defaultPrevented).toBe(true);
      expect(parts['pages']!.scrollLeft).toBe(100);
      wheel({ shiftKey: true, deltaY: 2, deltaMode: 1 });
      expect(parts['pages']!.scrollLeft).toBe(180);
      for (const more of [{ deltaY: 100 }, { shiftKey: true, deltaX: 50, deltaY: 50 }, { shiftKey: true }]) expect(wheel(more).defaultPrevented).toBe(false);
      expect(parts['pages']!.scrollLeft).toBe(180);
    });

    it('the hand tool drags the pages both ways with a mouse; a press without a drag still follows a link', async () => {
      const { root, parts } = await wide();
      const pointer = (type: string, x: number, y: number, more: object = {}) => {
        const event = Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button: 0, pointerType: 'mouse', pointerId: 7, ...more });
        parts['pages']!.dispatchEvent(event);
        return event;
      };
      const click = () => {
        const event = new Event('click', { cancelable: true });
        parts['pages']!.dispatchEvent(event);
        return event;
      };
      // Off: a press and a move are the browser's (selecting text).
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 50, 50);
      expect(parts['pages']!.scrollLeft).toBe(0);
      parts['hand']!.click();
      // What the zoom scrolled to keep the place is not this test's.
      win.scrolledBy = 0;
      expect(parts['hand']!.getAttribute('aria-pressed')).toBe('true');
      expect(root.classes.has('viewer--hand')).toBe(true);
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 102, 101);
      expect(parts['pages']!.captured).toEqual([]);
      pointer('pointerup', 102, 101);
      expect(click().defaultPrevented).toBe(false);
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 60, 70);
      expect(parts['pages']!.captured).toEqual([7]);
      expect(root.classes.has('viewer--dragging')).toBe(true);
      pointer('pointermove', 40, 80);
      expect(parts['pages']!.scrollLeft).toBe(60);
      expect(win.scrolledBy).toBe(20);
      pointer('pointerup', 40, 80);
      expect(root.classes.has('viewer--dragging')).toBe(false);
      // The click that ends a drag follows nothing; the next one does.
      expect(click().defaultPrevented).toBe(true);
      expect(click().defaultPrevented).toBe(false);
      // A touch, a pen, another button, or a move with no press: the browser's own.
      pointer('pointerdown', 100, 100, { pointerType: 'touch' });
      pointer('pointerdown', 100, 100, { button: 2 });
      pointer('pointermove', 0, 0);
      pointer('pointercancel', 0, 0);
      expect(parts['pages']!.scrollLeft).toBe(60);
      // A link is never dragged away while the hand is on.
      const drag = new Event('dragstart', { cancelable: true });
      parts['pages']!.dispatchEvent(drag);
      expect(drag.defaultPrevented).toBe(true);
      parts['hand']!.click();
      const plain = new Event('dragstart', { cancelable: true });
      parts['pages']!.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
    });
  });

  describe('the More menu, on the narrowest screens', () => {
    it("opens on a press with the focus on its first item; each item does what the bar's own does, then the menu closes", async () => {
      const { parts, menu } = await open();
      // An item the bar shows itself is not in the menu, and takes no focus: the next one does.
      menu['find']!.focusable = false;
      parts['more']!.click();
      expect(parts['more-list']!.hidden).toBe(false);
      expect(menu['find']!.focused).toBe(false);
      expect(menu['zoom-out']!.focused).toBe(true);
      parts['more']!.click();
      menu['find']!.focusable = true;
      parts['more']!.click();
      expect(menu['find']!.focused).toBe(true);
      const before = parts['zoom-now']!.textContent;
      expect(before).toMatch(/^Zoom \d+%$/);
      menu['zoom-in']!.click();
      expect(parts['more-list']!.hidden).toBe(true);
      expect(parts['more']!.focused).toBe(true);
      expect(parts['zoom-now']!.textContent).not.toBe(before);
      expect(menu['fit-width']!.getAttribute('aria-pressed')).toBe('false');
      menu['fit-page']!.click();
      expect(menu['fit-page']!.getAttribute('aria-pressed')).toBe('true');
      expect(parts['fit-page']!.getAttribute('aria-pressed')).toBe('true');
      menu['zoom-out']!.click();
      menu['fit-width']!.click();
      expect(menu['fit-width']!.getAttribute('aria-pressed')).toBe('true');
      // A press that is not on an item (between them) leaves it open.
      parts['more']!.click();
      parts['more-list']!.dispatchEvent(new Event('click'));
      expect(parts['more-list']!.hidden).toBe(false);
    });

    it('a turned-off item does nothing', async () => {
      const { parts, menu } = await open();
      for (let i = 0; i < 12; i++) parts['zoom-in']!.click();
      expect(menu['zoom-in']!.getAttribute('aria-disabled')).toBe('true');
      const now = parts['zoom-now']!.textContent;
      menu['zoom-in']!.click();
      expect(parts['zoom-now']!.textContent).toBe(now);
    });
  });
});

describe('boot', () => {
  it('loads pdf.js from the same-origin path the page names, and nothing from anywhere else', async () => {
    const win = new FakeWin();
    const loaded: string[] = [];
    const fake = fakePdfjs();
    const load = (url: string) => {
      loaded.push(url);
      return Promise.resolve(fake.pdfjs);
    };
    const view = viewerPage();
    view.root.dataset['pdfjs'] = '/_astro/pdf.min.abc.mjs';
    expect(await boot(view.doc, win, load)).toBeDefined();
    for (const pdfjs of ['https://cdn.example/pdf.mjs', '//cdn.example/pdf.mjs', undefined]) {
      const other = viewerPage();
      if (pdfjs) other.root.dataset['pdfjs'] = pdfjs;
      expect(await boot(other.doc, win, load)).toBeUndefined();
    }
    const none = viewerPage();
    none.root.removeAttribute('data-viewer');
    expect(await boot(none.doc, win, load)).toBeUndefined();
    expect(loaded).toEqual(['/_astro/pdf.min.abc.mjs']);
  });
});
