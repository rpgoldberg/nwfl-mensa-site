// public/scripts/account-menu.js is progressive enhancement (W-LOOK2): without it the header's Account
// menu is a plain <details>, opened and closed by its button, the keyboard's Enter and Space included.
// With it Escape closes the menu and puts the focus back on its button, and a tap or a focus anywhere
// else closes it, so an open menu never sits over the page. Here it runs against small stand-ins.
import { describe, expect, it } from 'vitest';
import { wireAccountMenu } from '../public/scripts/account-menu.js';

class FakeNode extends EventTarget {
  focused = false;
  constructor(readonly parent: FakeNode | null = null) {
    super();
  }
  focus() {
    this.focused = true;
  }
}

class FakeDetails extends FakeNode {
  open = false;
  readonly summary = new FakeNode(this);
  readonly link = new FakeNode(this);
  contains(node: unknown) {
    for (let n = node as FakeNode | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  querySelector(sel: string) {
    return sel === 'summary' ? this.summary : null;
  }
}

function setup(withMenu = true) {
  const menu = new FakeDetails();
  const doc = new (class extends EventTarget {
    querySelector(sel: string) {
      return sel === '[data-account-menu]' && withMenu ? menu : null;
    }
  })();
  const elsewhere = new FakeNode();
  const wired = wireAccountMenu(doc as never);
  return { menu, doc, elsewhere, wired };
}

/** An event as the browser sends it: from `target`, bubbling to the menu, then to the document. */
function send(doc: EventTarget, menu: FakeDetails, type: string, target: FakeNode, extra: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), extra);
  Object.defineProperty(event, 'target', { value: target });
  if (menu.contains(target)) menu.dispatchEvent(event);
  doc.dispatchEvent(event);
  return event;
}

describe('the Account menu', () => {
  it('does nothing on a page with no menu (signed out)', () => {
    expect(setup(false).wired).toBe(false);
  });

  it('Escape closes the open menu and puts the focus back on its button', () => {
    const { menu, doc } = setup();
    menu.open = true;
    const event = send(doc, menu, 'keydown', menu.link, { key: 'Escape' });
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('Escape closes it when the focus is elsewhere, as after opening it by tap in Safari, which does not focus the button', () => {
    const { menu, doc, elsewhere } = setup();
    menu.open = true;
    const event = send(doc, menu, 'keydown', elsewhere, { key: 'Escape' });
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves other keys, and Escape on a closed menu, to the browser', () => {
    const { menu, doc } = setup();
    menu.open = true;
    expect(send(doc, menu, 'keydown', menu.link, { key: 'Enter' }).defaultPrevented).toBe(false);
    expect(menu.open).toBe(true);
    menu.open = false;
    expect(send(doc, menu, 'keydown', menu.summary, { key: 'Escape' }).defaultPrevented).toBe(false);
    expect(menu.summary.focused).toBe(false);
  });

  it('a tap elsewhere on the page closes it, without taking the focus; a tap inside keeps it open', () => {
    const { menu, doc, elsewhere } = setup();
    menu.open = true;
    send(doc, menu, 'click', menu.link);
    expect(menu.open).toBe(true);
    send(doc, menu, 'click', elsewhere);
    expect(menu.open).toBe(false);
    expect(menu.summary.focused).toBe(false);
  });

  it('closes once the focus moves on past it, as when tabbing through the page; not while it stays inside', () => {
    const { menu, doc, elsewhere } = setup();
    menu.open = true;
    send(doc, menu, 'focusin', menu.link);
    expect(menu.open).toBe(true);
    send(doc, menu, 'focusin', elsewhere);
    expect(menu.open).toBe(false);
  });
});
