// public/scripts/error-summary.js is progressive enhancement (W-SIGNUP fix 1, NOTE-6): without it a form
// with problems still opens with its summary at the top, each problem a link to its field. With it the
// summary takes focus as the page opens, so a screen reader reads it first, and each link puts the
// cursor in its field. Here it runs against small stand-ins for the document.
import { describe, expect, it } from 'vitest';
import { wireErrorSummary } from '../public/scripts/error-summary.js';

class FakeElement extends EventTarget {
  focused = false;
  scrolled = false;
  constructor(readonly attrs: Record<string, string> = {}) {
    super();
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  focus() {
    this.focused = true;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
}

class FakeSummary extends FakeElement {
  constructor(readonly links: FakeElement[]) {
    super();
  }
  querySelectorAll(sel: string) {
    return sel === 'a[href^="#"]' ? this.links : [];
  }
}

function setup(withSummary = true) {
  const lastName = new FakeElement({ id: 'lastName' });
  const links = [new FakeElement({ href: '#lastName' }), new FakeElement({ href: '#gone' }), new FakeElement()];
  const summary = new FakeSummary(links);
  const doc = {
    querySelector: (sel: string) => (sel === '[data-error-summary]' && withSummary ? summary : null),
    getElementById: (id: string) => (id === 'lastName' ? lastName : null),
  };
  wireErrorSummary(doc as never);
  return { summary, links, lastName };
}

describe('the error summary', () => {
  it('takes focus as the page opens', () => {
    expect(setup().summary.focused).toBe(true);
  });

  it('puts the cursor in the field a link names, instead of only scrolling to it', () => {
    const { links, lastName } = setup();
    const click = new Event('click', { cancelable: true });
    links[0]!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(lastName.focused).toBe(true);
    expect(lastName.scrolled).toBe(true);
  });

  it('leaves a link to a field that is not there, or a link with no address, to the browser', () => {
    const { links } = setup();
    for (const link of [links[1]!, links[2]!]) {
      const click = new Event('click', { cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
  });

  it('does nothing on a page with no summary', () => {
    expect(() => setup(false)).not.toThrow();
  });
});
