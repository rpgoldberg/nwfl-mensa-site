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
  OPENING,
  TOO_LONG,
  ZOOMS,
  clampPage,
  fitScale,
  hashPage,
  linkHref,
  linkName,
  loading,
  outputScale,
  pageAt,
  pageLabel,
  percent,
  sameOriginPath,
  boot,
  wireViewer,
  zoomIn,
  zoomOptions,
  zoomOut,
} from '../public/scripts/viewer.js';
import { FakeEl, FakeObserver, FakeResizeObserver, FakeWin, chosen, fakePdfjs, viewerPage } from './viewer-fakes';

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

describe('pageLabel', () => {
  it('reads as the mockup writes it: the page, a slash, and how many', () => {
    expect(pageLabel(1, 12)).toBe('1 / 12');
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
      const { opened, parts, viewer } = await open({}, page);
      expect(viewer, JSON.stringify(page)).toBeUndefined();
      expect(opened).toEqual([]);
      expect(parts['status']!.textContent).toBe(FAILED);
      expect(parts['nojs']!.hidden).toBe(true);
      expect(parts['js']!.hidden).toBe(true);
    }
  });

  it('opens the PDF without eval, wasm or XFA, and shows the controls, the page count and one box per page', async () => {
    const { opened, pdfjs, parts, pages } = await open();
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe('/_astro/pdf.worker.min.abc.mjs');
    expect(opened).toEqual([{ url: '/documents/3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7.pdf', isEvalSupported: false, useWasm: false, enableXfa: false, maxImageSize: MAX_IMAGE_PIXELS, verbosity: 0 }]);
    expect(parts['nojs']!.hidden).toBe(true);
    expect(parts['js']!.hidden).toBe(false);
    expect(parts['pages']!.hidden).toBe(false);
    // W-LOOK3: the page is a select, "1 / 3" and so on.
    expect(parts['page']!.children.map((o) => [o.value, o.textContent])).toEqual([
      ['1', '1 / 3'],
      ['2', '2 / 3'],
      ['3', '3 / 3'],
    ]);
    expect(parts['page']!.value).toBe('1');
    expect(chosen(parts['page'])).toBe('1 / 3');
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
  it('zooms to the step chosen in the zoom select, and ignores a value that is no step', async () => {
    const { parts, pages } = await open();
    const choose = async (value: string) => {
      parts['zoom']!.value = value;
      parts['zoom']!.dispatchEvent(new Event('change'));
      await flush();
    };
    const fitted = parts['zoom']!.value;
    expect(parts['zoom']!.children.map((o) => o.textContent)).toContain(percent(600 / PAGE.width));
    await choose('2');
    expect(chosen(parts['zoom'])).toBe('200%');
    expect(pages[0]!.style.width).toBe(`${PAGE.width * 2}px`);
    expect(parts['fit-width']!.getAttribute('aria-pressed')).toBe('false');
    // At a step, no other size is listed.
    expect(parts['zoom']!.children.map((o) => o.value)).toEqual(ZOOMS.map(String));
    await choose(fitted);
    expect(chosen(parts['zoom'])).toBe('200%');
    await choose('x');
    expect(chosen(parts['zoom'])).toBe('200%');
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

  it('goes to the page chosen in the page select, the nearest when out of range, and puts back a value that is no page', async () => {
    const { parts, pages } = await open();
    const go = async (value: string) => {
      parts['page']!.value = value;
      parts['page']!.dispatchEvent(new Event('change'));
      await flush();
    };
    await go('3');
    expect(pages[2]!.scrolled).toBe(1);
    await go('9');
    expect(pages[2]!.scrolled).toBe(2);
    await go('two');
    expect(parts['page']!.value).toBe('3');
  });

  it('never overwrites a page number the reader is typing, and goes there once it is entered', async () => {
    const { doc, pages, parts } = await open();
    doc.activeElement = parts['page']!;
    parts['page']!.value = '3';
    pages[0]!.rect = { top: 100, height: 1000, width: 600 };
    pages[1]!.rect = { top: 1100, height: 1000, width: 600 };
    pages[2]!.rect = { top: 2100, height: 1000, width: 600 };
    win.dispatchEvent(new Event('scroll'));
    expect(parts['page']!.value).toBe('3');
    expect(parts['prev']!.getAttribute('aria-disabled')).toBe('true');
    parts['page']!.dispatchEvent(new Event('change'));
    expect(pages[2]!.scrolled).toBe(1);
    expect(parts['page']!.value).toBe('3');
    parts['page']!.value = 'x';
    parts['page']!.dispatchEvent(new Event('change'));
    expect(parts['page']!.value).toBe('3');
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
    expect(parts['page']!.children).toHaveLength(0);
    expect(parts['js']!.hidden).toBe(true);
    expect(parts['pages']!.hidden).toBe(true);
    expect(parts['nojs']!.hidden).toBe(true);
    // pdf.js lets the file go: nothing of it is kept.
    expect(log).toEqual(['destroy']);
  });

  it('a file of exactly MAX_PAGES is drawn', async () => {
    const { parts, pages, viewer } = await open({ pages: MAX_PAGES });
    expect(viewer).toBeDefined();
    expect(parts['page']!.children).toHaveLength(MAX_PAGES);
    expect(parts['page']!.children.at(-1)!.textContent).toBe('1000 / 1000');
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
