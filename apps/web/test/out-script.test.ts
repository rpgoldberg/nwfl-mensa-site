// public/scripts/out.js, the leaving page's countdown (LINKS L4, D3b "countdown"): progressive
// enhancement only. Without it the countdown box stays hidden and the page waits for a press, as
// the guard does. With it the box shows, Stop takes focus, the countdown is announced once (never
// every second), and when it ends the same tab goes on with location.replace (a browser blocks a
// new tab no press opened). Stop, Continue, or anything else the reader does on the page (a focus, an
// input, a press or a key that is not on Stop: the radio, the form, Back, anywhere) ends it, and the
// stop is said once. Here it runs against small stand-ins.
import { describe, expect, it } from 'vitest';
import { SECONDS, wireCountdown } from '../public/scripts/out.js';

class FakeElement extends EventTarget {
  hidden = true;
  focused = false;
  textContent = '';
  constructor(readonly attrs: Record<string, string> = {}) {
    super();
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  get href() {
    return this.attrs['href'] ?? '';
  }
  focus() {
    this.focused = true;
  }
  contains(other: unknown) {
    return other === this;
  }
}

/** Whatever the reader does on the page: the capture listeners the script puts on the document. */
class FakeDoc {
  readonly listeners = new Map<string, Set<(event: { type: string; target: unknown }) => void>>();
  readonly captures: boolean[] = [];
  constructor(readonly found: Record<string, FakeElement | null>) {}
  querySelector(sel: string) {
    return this.found[sel] ?? null;
  }
  addEventListener(type: string, fn: (event: { type: string; target: unknown }) => void, capture?: boolean) {
    this.captures.push(capture === true);
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: { type: string; target: unknown }) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, target: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target });
  }
  get count() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

/** The status region, keeping every text the script gives it. */
class FakeStatus extends FakeElement {
  readonly said: string[] = [];
  constructor() {
    super();
    // In place of the field FakeElement defines on each instance.
    Object.defineProperty(this, 'textContent', { get: () => this.said.at(-1) ?? '', set: (text: string) => void this.said.push(text) });
  }
}

const STOPPED = 'Stopped. You are still on our site. Choose Continue when you are ready.';

function setup(parts: { box?: boolean; go?: boolean; status?: boolean; seconds?: boolean; stop?: boolean; host?: boolean } = {}) {
  const box = new FakeElement(parts.host === false ? {} : { 'data-host': 'club.example' });
  const go = new FakeElement({ href: 'https://club.example/picnic?day=sat' });
  const status = new FakeStatus();
  const seconds = new FakeElement();
  const stop = new FakeElement();
  const found: Record<string, FakeElement | null> = {
    '[data-out-countdown]': parts.box === false ? null : box,
    'a[data-out-continue]': parts.go === false ? null : go,
    '[data-out-status]': parts.status === false ? null : status,
    '[data-out-seconds]': parts.seconds === false ? null : seconds,
    '[data-out-stop]': parts.stop === false ? null : stop,
  };
  const doc = new FakeDoc(found);
  const timers = new Map<number, { fn: () => void; every?: number; at: number }>();
  let now = 0;
  let next = 1;
  const replaced: string[] = [];
  const win = {
    setTimeout: (fn: () => void, ms: number) => (timers.set(next, { fn, at: now + ms }), next++),
    setInterval: (fn: () => void, ms: number) => (timers.set(next, { fn, every: ms, at: now + ms }), next++),
    clearTimeout: (id: number) => void timers.delete(id),
    clearInterval: (id: number) => void timers.delete(id),
    location: { replace: (url: string) => void replaced.push(url) },
  };
  /** Moves the clock on, running each timer due on the way, in order. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every;
      else timers.delete(id);
      timer.fn();
    }
    now = end;
  };
  const announcements: string[] = [];
  const watched = { box, go, status, seconds, stop, doc };
  wireCountdown(doc as never, win as never);
  announcements.push(status.textContent);
  return { ...watched, timers, replaced, advance, announcements };
}

describe('the countdown', () => {
  it('is five seconds', () => {
    expect(SECONDS).toBe(5);
  });

  it('shows its box, puts the focus on Stop, and is announced once with the host and the way to stay', () => {
    const { box, stop, status, seconds } = setup();
    expect(box.hidden).toBe(false);
    expect(stop.focused).toBe(true);
    expect(status.textContent).toBe('Going to club.example in 5 seconds. Press Stop to stay on this page.');
    expect(seconds.textContent).toBe('5');
  });

  it('says "the other site" when the page names no host', () => {
    expect(setup({ host: false }).status.textContent).toBe('Going to the other site in 5 seconds. Press Stop to stay on this page.');
  });

  it('counts down on screen each second, never in the announcement, then goes on in the same tab with location.replace', () => {
    const { status, seconds, advance, replaced } = setup();
    const announced = status.textContent;
    advance(1000);
    expect(seconds.textContent).toBe('4');
    advance(3000);
    expect(seconds.textContent).toBe('1');
    expect(replaced).toEqual([]);
    advance(1000);
    expect(replaced).toEqual(['https://club.example/picnic?day=sat']);
    expect(status.textContent).toBe(announced);
  });

  it('stops for good on Stop: nothing more happens, the box goes, the stop is said, and the focus goes to Continue', () => {
    const { box, go, stop, status, advance, replaced, timers } = setup();
    advance(2000);
    stop.dispatchEvent(new Event('click'));
    advance(10_000);
    expect(replaced).toEqual([]);
    expect(timers.size).toBe(0);
    expect(box.hidden).toBe(true);
    expect(go.focused).toBe(true);
    expect(status.textContent).toBe('Stopped. You are still on our site. Choose Continue when you are ready.');
  });

  it('stops when the reader presses Continue, which opens its own new tab, so this tab stays', () => {
    const { box, go, advance, replaced, timers } = setup();
    go.dispatchEvent(new Event('click'));
    advance(10_000);
    expect(replaced).toEqual([]);
    expect(timers.size).toBe(0);
    expect(box.hidden).toBe(true);
  });

  for (const type of ['focusin', 'input', 'pointerdown', 'keydown']) {
    it(`stops, as Stop does, on a ${type} anywhere but Stop (the radio, the form, Back), and leaves the focus where the reader put it`, () => {
      const { box, go, status, advance, replaced, timers, doc } = setup();
      const radio = new FakeElement();
      advance(2000);
      doc.fire(type, radio);
      if (type === 'pointerdown') doc.fire('pointerup', radio);
      advance(10_000);
      expect(replaced).toEqual([]);
      expect(timers.size).toBe(0);
      expect(box.hidden).toBe(true);
      expect(status.textContent).toBe(STOPPED);
      expect(go.focused).toBe(false);
    });
  }

  for (const over of ['pointerup', 'pointercancel']) {
    it(`on a press, stops at once, and takes its box away only once the press is over (${over}), so nothing moves under the pointer`, () => {
      const { box, status, advance, replaced, timers, doc } = setup();
      const radio = new FakeElement();
      doc.fire('pointerdown', radio);
      expect(timers.size).toBe(0);
      advance(10_000);
      expect(replaced).toEqual([]);
      expect(box.hidden).toBe(false);
      doc.fire(over, radio);
      expect(box.hidden).toBe(false);
      advance(0);
      expect(box.hidden).toBe(true);
      expect(status.said).toEqual(['Going to club.example in 5 seconds. Press Stop to stay on this page.', STOPPED]);
      expect(doc.count).toBe(0);
    });
  }

  it('says the stop at once when Stop is pressed while a press elsewhere is still held', () => {
    const { box, go, stop, status, doc } = setup();
    doc.fire('pointerdown', new FakeElement());
    stop.dispatchEvent(new Event('click'));
    expect(box.hidden).toBe(true);
    expect(go.focused).toBe(true);
    expect(status.said).toEqual(['Going to club.example in 5 seconds. Press Stop to stay on this page.', STOPPED]);
  });

  it('listens on the whole page, in the capture phase, so a control that stops its events still stops the countdown', () => {
    const { doc } = setup();
    expect([...doc.listeners.keys()].sort()).toEqual(['focusin', 'input', 'keydown', 'pointerdown']);
    expect(doc.captures).toEqual([true, true, true, true]);
  });

  it('goes on when the focus, a press or a key is on Stop itself, which only its own press ends', () => {
    const { stop, advance, replaced, doc } = setup();
    for (const type of ['focusin', 'input', 'pointerdown', 'keydown']) doc.fire(type, stop);
    advance(5000);
    expect(replaced).toEqual(['https://club.example/picnic?day=sat']);
  });

  it('says the stop once, however much more the reader does, and stops listening', () => {
    const { stop, status, advance, doc } = setup();
    const radio = new FakeElement();
    doc.fire('pointerdown', radio);
    doc.fire('focusin', radio);
    doc.fire('input', radio);
    doc.fire('pointerup', radio);
    stop.dispatchEvent(new Event('click'));
    advance(10_000);
    expect(status.said).toEqual(['Going to club.example in 5 seconds. Press Stop to stay on this page.', STOPPED]);
    expect(doc.count).toBe(0);
  });

  it('says the stop once when Stop is pressed after Continue ended it', () => {
    const { go, stop, status } = setup();
    go.dispatchEvent(new Event('click'));
    stop.dispatchEvent(new Event('click'));
    expect(status.said).toEqual(['Going to club.example in 5 seconds. Press Stop to stay on this page.', STOPPED]);
  });

  it('does nothing on a page without a countdown, or with any part of it missing', () => {
    for (const missing of ['box', 'go', 'status', 'seconds', 'stop'] as const) {
      const { timers, stop, box } = setup({ [missing]: false });
      expect(timers.size, missing).toBe(0);
      expect(stop.focused, missing).toBe(false);
      expect(box.hidden, missing).toBe(true);
      expect(setup({ [missing]: false }).doc.count, missing).toBe(0);
    }
  });
});
