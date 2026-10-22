// public/scripts/install.js is progressive enhancement: the page works without
// it. Here it runs against small stand-ins for window and document.
import { describe, expect, it, vi } from 'vitest';
import { IN_APP_BROWSER, wire } from '../public/scripts/install.js';

class FakeElement extends EventTarget {
  hidden = true;
  constructor(readonly role: string) {
    super();
  }
}

function setup(userAgent = 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36') {
  const win = new EventTarget() as EventTarget & { navigator: { userAgent: string } };
  win.navigator = { userAgent };
  const buttons = [new FakeElement('install'), new FakeElement('install')];
  const hint = new FakeElement('hint');
  const close = new FakeElement('close');
  const doc = {
    querySelectorAll: (sel: string) => (sel === '[data-install]' ? buttons : []),
    querySelector: (sel: string) => (sel === '[data-in-app-hint]' ? hint : sel === '[data-in-app-hint-close]' ? close : null),
  };
  wire(win as never, doc as never);
  return { win, buttons, hint, close };
}

function offer(win: EventTarget, outcome: 'accepted' | 'dismissed') {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
  event.prompt = vi.fn(async () => {});
  event.userChoice = Promise.resolve({ outcome });
  win.dispatchEvent(event);
  return event;
}

describe('the Android install button', () => {
  it('stays hidden until the browser offers installation', () => {
    const { buttons } = setup();
    expect(buttons.every((b) => b.hidden)).toBe(true);
  });

  it("appears when the browser offers it, and replaces the browser's own banner", () => {
    const { win, buttons } = setup();
    const event = offer(win, 'dismissed');
    expect(event.defaultPrevented).toBe(true);
    expect(buttons.every((b) => !b.hidden)).toBe(true);
  });

  it("opens the browser's install dialog on a press, then hides once used", async () => {
    const { win, buttons } = setup();
    const event = offer(win, 'accepted');
    buttons[0]!.dispatchEvent(new Event('click'));
    expect(event.prompt).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(buttons.every((b) => b.hidden)).toBe(true));
    buttons[1]!.dispatchEvent(new Event('click'));
    expect(event.prompt).toHaveBeenCalledTimes(1);
  });

  it('hides once the app is installed some other way', () => {
    const { win, buttons } = setup();
    offer(win, 'dismissed');
    win.dispatchEvent(new Event('appinstalled'));
    expect(buttons.every((b) => b.hidden)).toBe(true);
  });

  it('does nothing on a press before any offer', () => {
    const { buttons } = setup();
    buttons[0]!.dispatchEvent(new Event('click'));
    expect(buttons.every((b) => b.hidden)).toBe(true);
  });
});

describe('the in-app browser hint', () => {
  it("knows Facebook's, Messenger's and Instagram's browsers, and not Chrome or Safari", () => {
    for (const ua of ['… [FBAN/FBIOS;FBAV/450.0]', '… FB_IAB/FB4A;FBAV/450.0', '… Instagram 320.0 Android']) expect(IN_APP_BROWSER.test(ua), ua).toBe(true);
    for (const ua of ['Mozilla/5.0 (Linux; Android 15) Chrome/141.0 Mobile Safari/537.36', 'Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1']) {
      expect(IN_APP_BROWSER.test(ua), ua).toBe(false);
    }
  });

  it('shows inside Facebook, and closes when asked', () => {
    const { hint, close } = setup('Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/450.0]');
    expect(hint.hidden).toBe(false);
    close.dispatchEvent(new Event('click'));
    expect(hint.hidden).toBe(true);
  });

  it('stays hidden in an ordinary browser', () => {
    expect(setup().hint.hidden).toBe(true);
  });
});
