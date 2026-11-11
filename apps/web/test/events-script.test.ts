// public/scripts/events.js is progressive enhancement for /events (EVENTS2): every link works without
// it. With it, a day tile or grid day selects that day in place (its events marked, or the month's day
// panel shown; the URL and the view links keep the date; a screen reader hears which day), a swipe on
// the week strip steps the week, Copy copies the feed address, and on Android the Android steps come
// first and the computer-only Google link goes. Here it runs against small stand-ins.
import { describe, expect, it, vi } from 'vitest';
import { ANDROID, wireEvents } from '../public/scripts/events.js';

class El extends EventTarget {
  hidden = false;
  value = '';
  textContent = '';
  selected = false;
  scrolled: unknown[] = [];
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)),
  };
  readonly kids: El[] = [];
  constructor(readonly attrs: Record<string, string> = {}) {
    super();
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  removeAttribute(name: string) {
    delete this.attrs[name];
  }
  get href() {
    return new URL(this.attrs['href'] ?? '', 'https://nwflorida.us/events').href;
  }
  scrollIntoView(options: unknown) {
    this.scrolled.push(options);
  }
  select() {
    this.selected = true;
  }
  prepend(el: El) {
    this.kids.unshift(el);
  }
}

interface Page {
  root?: El | null;
  days?: El[];
  cards?: El[];
  panels?: El[];
  views?: El[];
  steps?: El[];
  strip?: El | null;
  status?: El | null;
  copy?: El[];
  ids?: Record<string, El>;
  panel?: El | null;
  android?: El | null;
  notAndroid?: El[];
}

function setup(page: Page, opts: { ua?: string; reduce?: boolean; clipboard?: (text: string) => Promise<void> } = {}) {
  const doc = {
    querySelector: (sel: string) =>
      ({ '[data-cal]': page.root ?? null, '[data-swipe]': page.strip ?? null, '[data-cal-status]': page.status ?? null, '[data-addcal-panel]': page.panel ?? null, '[data-android]': page.android ?? null })[sel] ?? null,
    querySelectorAll: (sel: string) =>
      ({ 'a[data-day]': page.days, '[data-card-day]': page.cards, '[data-panel]': page.panels, 'a[data-view]': page.views, 'a[data-step]': page.steps, '[data-copy]': page.copy, '[data-not-android]': page.notAndroid })[sel] ?? [],
    getElementById: (id: string) => page.ids?.[id] ?? null,
  };
  const replaced: string[] = [];
  const assigned: string[] = [];
  const clipboard = opts.clipboard ?? (() => Promise.resolve());
  const win = {
    navigator: { userAgent: opts.ua ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', clipboard: { writeText: vi.fn(clipboard) } },
    matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' && !!opts.reduce }),
    history: { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    location: { assign: (url: string) => assigned.push(url) },
  };
  wireEvents(win as never, doc as never);
  return { win, replaced, assigned };
}

type ClickInit = { button?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };
/** Node has no MouseEvent: a click is an Event with the fields the script reads. */
const clickEvent = (init: ClickInit = {}) => Object.assign(new Event('click', { cancelable: true }), { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init });
const click = (el: El, init: ClickInit = {}) => {
  const event = clickEvent(init);
  el.dispatchEvent(event);
  return event;
};

describe('selecting a day in place', () => {
  const listPage = () => {
    const days = [new El({ href: '/events?view=list&d=2026-11-11#day-2026-11-11', 'data-day': '2026-11-11', 'aria-label': 'Wednesday, 11 November, 1 event: Lunch or meal', 'aria-current': 'true' }), new El({ href: '/events?view=list&d=2026-11-13#day-2026-11-13', 'data-day': '2026-11-13', 'aria-label': 'Friday, 13 November, 1 event: Happy hour or social' })];
    const cards = [new El({ 'data-card-day': '2026-11-11' }), new El({ 'data-card-day': '2026-11-13' }), new El({ 'data-card-day': '2026-11-13' })];
    cards[0]!.classes.add('is-sel');
    const views = [new El({ href: '/events', 'data-view': 'list' }), new El({ href: '/events?view=week&d=2026-11-11', 'data-view': 'week' })];
    const status = new El();
    const target = cards[1]!;
    return { root: new El({ 'data-cal': 'list' }), days, cards, views, status, ids: { 'day-2026-11-13': target } };
  };

  it('list: marks the day and its events, scrolls to them, keeps the date in the URL and the view links, and says which day', () => {
    const page = listPage();
    const { replaced } = setup(page);
    const event = click(page.days[1]!);
    expect(event.defaultPrevented).toBe(true);
    expect(page.days.map((d) => d.getAttribute('aria-current'))).toEqual([null, 'true']);
    expect(page.cards.map((c) => c.classes.has('is-sel'))).toEqual([false, true, true]);
    expect(page.ids['day-2026-11-13']!.scrolled).toEqual([{ block: 'start', behavior: 'smooth' }]);
    expect(replaced).toEqual(['/events?view=list&d=2026-11-13']);
    expect(page.views.map((v) => v.getAttribute('href'))).toEqual(['/events?d=2026-11-13', '/events?view=week&d=2026-11-13']);
    expect(page.status.textContent).toBe('Friday, 13 November, 1 event: Happy hour or social');
  });

  it('scrolls without motion when the reader asks for less', () => {
    const page = listPage();
    setup(page, { reduce: true });
    click(page.days[1]!);
    expect(page.ids['day-2026-11-13']!.scrolled).toEqual([{ block: 'start', behavior: 'auto' }]);
  });

  it('leaves a modified click, another button or a click already handled to the browser', () => {
    const page = listPage();
    const { replaced } = setup(page);
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) expect(click(page.days[1]!, init).defaultPrevented).toBe(false);
    const handled = clickEvent();
    handled.preventDefault();
    page.days[1]!.dispatchEvent(handled);
    expect(replaced).toEqual([]);
    expect(page.days[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('month: shows the chosen day panel only, scrolled into view if need be', () => {
    const days = [new El({ href: '/events?view=month&d=2026-11-04#day-2026-11-04', 'data-day': '2026-11-04' }), new El({ href: '/events?view=month&d=2026-11-11#day-2026-11-11', 'data-day': '2026-11-11', 'aria-current': 'true' })];
    const panels = [new El({ 'data-panel': '2026-11-10' }), new El({ 'data-panel': '2026-11-04' }), new El({ 'data-panel': '2026-11-11' })];
    panels[1]!.hidden = true;
    const cards = [new El({ 'data-card-day': '2026-11-04' })];
    const { replaced } = setup({ root: new El({ 'data-cal': 'month' }), days, panels, cards, ids: { 'day-2026-11-04': panels[1]! } });
    click(days[0]!);
    expect(panels.map((p) => p.hidden)).toEqual([true, false, true]);
    expect(cards[0]!.classes.has('is-sel')).toBe(false);
    expect(panels[1]!.scrolled).toEqual([{ block: 'nearest', behavior: 'smooth' }]);
    expect(replaced).toEqual(['/events?view=month&d=2026-11-04']);
  });

  it('does nothing off the events page, or without its status line', () => {
    const day = new El({ href: '/events?d=2026-11-11', 'data-day': '2026-11-11' });
    setup({ root: null, days: [day] });
    expect(click(day).defaultPrevented).toBe(false);
    const page = listPage();
    setup({ ...page, status: null, ids: {} });
    expect(click(page.days[1]!).defaultPrevented).toBe(true);
  });
});

describe('a swipe on the week strip', () => {
  const page = () => {
    const strip = new El();
    const steps = [new El({ href: '/events?view=week&d=2026-11-04', 'data-step': 'prev' }), new El({ href: '/events?view=week&d=2026-11-18', 'data-step': 'next' })];
    return { root: new El({ 'data-cal': 'week' }), strip, steps };
  };
  const swipe = (strip: El, from: [number, number], to: [number, number]) => {
    strip.dispatchEvent(Object.assign(new Event('touchstart'), { touches: [{ clientX: from[0], clientY: from[1] }] }));
    strip.dispatchEvent(Object.assign(new Event('touchend'), { changedTouches: [{ clientX: to[0], clientY: to[1] }] }));
  };

  it('to the left goes to the next week, to the right the previous one', () => {
    const p = page();
    const { assigned } = setup(p);
    swipe(p.strip, [300, 100], [180, 110]);
    swipe(p.strip, [100, 100], [220, 95]);
    expect(assigned).toEqual(['https://nwflorida.us/events?view=week&d=2026-11-18', 'https://nwflorida.us/events?view=week&d=2026-11-04']);
  });

  it('ignores a short or mostly vertical move, a touch with no start, and a strip with no arrows', () => {
    const p = page();
    const { assigned } = setup(p);
    swipe(p.strip, [300, 100], [270, 100]);
    swipe(p.strip, [300, 100], [200, 260]);
    p.strip.dispatchEvent(Object.assign(new Event('touchend'), { changedTouches: [{ clientX: 0, clientY: 0 }] }));
    expect(assigned).toEqual([]);
    const bare = { ...page(), steps: [] };
    const second = setup(bare);
    swipe(bare.strip, [300, 100], [100, 100]);
    expect(second.assigned).toEqual([]);
  });
});

describe('Copy, for the feed address', () => {
  const page = () => {
    const field = new El();
    field.value = 'https://nwflorida.us/calendar.ics?v=2';
    const status = new El();
    const button = new El({ 'data-copy': 'feed-address', 'data-copy-status': 'feed-copied' });
    button.hidden = true;
    return { field, status, button, ids: { 'feed-address': field, 'feed-copied': status } };
  };

  it('shows the button, copies the address and says so', async () => {
    const p = page();
    const { win } = setup({ copy: [p.button], ids: p.ids });
    expect(p.button.hidden).toBe(false);
    click(p.button);
    await vi.waitFor(() => expect(p.status.textContent).toBe('Copied the calendar address.'));
    expect(win.navigator.clipboard.writeText).toHaveBeenCalledWith('https://nwflorida.us/calendar.ics?v=2');
  });

  it('where the browser will not copy, selects the address and asks the reader to copy it', async () => {
    const p = page();
    setup({ copy: [p.button], ids: p.ids }, { clipboard: () => Promise.reject(new Error('denied')) });
    click(p.button);
    await vi.waitFor(() => expect(p.status.textContent).toBe('Select the address and copy it.'));
    expect(p.field.selected).toBe(true);
  });

  it('stays hidden with no field to copy', () => {
    const p = page();
    setup({ copy: [p.button], ids: {} });
    expect(p.button.hidden).toBe(true);
  });
});

describe('on Android', () => {
  const page = () => ({ panel: new El(), android: new El(), notAndroid: [new El()] });
  it('recognises Android browsers only', () => {
    expect(ANDROID.test('Mozilla/5.0 (Linux; Android 15; SM-F956U) Chrome/141.0 Mobile Safari/537.36')).toBe(true);
    expect(ANDROID.test('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(false);
  });

  it('puts the Android steps first and hides the computer-only Google link', () => {
    const p = page();
    setup(p, { ua: 'Mozilla/5.0 (Linux; Android 15; SM-F956U) Chrome/141.0 Mobile Safari/537.36' });
    expect(p.panel.kids).toEqual([p.android]);
    expect(p.notAndroid[0]!.hidden).toBe(true);
  });

  it('leaves the order alone elsewhere, and copes with no panel', () => {
    const p = page();
    setup(p);
    expect(p.panel.kids).toEqual([]);
    expect(p.notAndroid[0]!.hidden).toBe(false);
    setup({ panel: null, android: null }, { ua: 'Android' });
  });
});
