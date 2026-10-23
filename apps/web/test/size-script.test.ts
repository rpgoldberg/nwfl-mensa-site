// public/scripts/size.js is progressive enhancement: without it the slider sits
// in the Aa panel's form with a Use this size button, and A− and A+ post the
// form. Here it runs against small stand-ins for the document and the form.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postSize, wireSize } from '../public/scripts/size.js';

class FakeElement extends EventTarget {
  hidden = false;
  rendered = true;
  focused = false;
  readonly attrs = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getClientRects() {
    return this.rendered ? [{}] : [];
  }
  focus() {
    this.focused = true;
  }
}

class FakeSlider extends FakeElement {
  value = '3';
  dataset = { sizes: '75 80 90 100 125 150 175' };
  constructor(readonly form: FakeForm | null) {
    super();
  }
}

class FakeForm extends EventTarget {
  readonly useThis = new FakeElement();
  readonly smaller = new FakeElement();
  readonly larger = new FakeElement();
  submitted: unknown[] = [];
  querySelector(sel: string) {
    return ({ '[data-size-set]': this.useThis, '[data-size-step="-1"]': this.smaller, '[data-size-step="1"]': this.larger } as Record<string, FakeElement>)[sel] ?? null;
  }
  requestSubmit(submitter: unknown) {
    this.submitted.push(submitter);
  }
}

function setup(save = vi.fn<(step: number) => Promise<void>>(async () => {}), withForm = true) {
  const form = withForm ? new FakeForm() : null;
  const slider = new FakeSlider(form);
  const root = { dataset: { size: '100' } as Record<string, string> };
  const doc = { documentElement: root, getElementById: (id: string) => (id === 'text-size' ? slider : null) };
  wireSize(doc as never, save);
  return { form, slider, root, save };
}

const click = (el: EventTarget) => {
  const event = new Event('click', { cancelable: true });
  el.dispatchEvent(event);
  return event;
};

describe('the text size slider, with JavaScript', () => {
  it('does nothing on a page without the slider, or with a slider that names no sizes', () => {
    const save = vi.fn();
    expect(() => wireSize({ getElementById: () => null } as never, save)).not.toThrow();
    const form = new FakeForm();
    const bare = Object.assign(new FakeSlider(form), { dataset: {} });
    wireSize({ documentElement: { dataset: {} }, getElementById: () => bare } as never, save);
    bare.dispatchEvent(new Event('change'));
    expect(form.useThis.hidden).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('hides Use this size, as each change is saved by itself', () => {
    const { form } = setup();
    expect(form!.useThis.hidden).toBe(true);
  });

  it('shows the size at once while sliding, and tells a screen reader, without saving yet', () => {
    const { slider, root, save } = setup();
    slider.value = '5';
    slider.dispatchEvent(new Event('input'));
    expect(root.dataset['size']).toBe('150');
    expect(slider.attrs.get('aria-valuetext')).toBe('150 percent');
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the notch the reader lets go on', () => {
    const { slider, root, save } = setup();
    slider.value = '0';
    slider.dispatchEvent(new Event('change'));
    expect(root.dataset['size']).toBe('75');
    expect(save).toHaveBeenCalledWith(0);
  });

  it('turns A− and A+ into one step of the slider, saved, with no page load', () => {
    const { form, slider, root, save } = setup();
    expect(click(form!.larger).defaultPrevented).toBe(true);
    expect([slider.value, root.dataset['size'], slider.attrs.get('aria-valuetext')]).toEqual(['4', '125', '125 percent']);
    expect(click(form!.smaller).defaultPrevented).toBe(true);
    click(form!.smaller);
    expect([slider.value, root.dataset['size']]).toEqual(['2', '90']);
    expect(save.mock.calls.map(([step]) => step)).toEqual([4, 3, 2]);
  });

  it('stops at each end', () => {
    const { form, slider, save } = setup();
    slider.value = '6';
    click(form!.larger);
    expect(slider.value).toBe('6');
    slider.value = '0';
    click(form!.smaller);
    expect(slider.value).toBe('0');
    expect(save.mock.calls.map(([step]) => step)).toEqual([6, 0]);
  });

  it('keeps keyboard focus in the panel when the button pressed gives way to its disabled twin', () => {
    const { form, slider } = setup();
    slider.value = '5';
    form!.larger.rendered = false; // at 175 % CSS shows "Largest size for this screen" instead
    click(form!.larger);
    expect(slider.focused).toBe(true);
    click(form!.smaller);
    expect(slider.focused).toBe(true);
    form!.smaller.rendered = true;
    slider.focused = false;
    click(form!.smaller);
    expect(slider.focused).toBe(false);
  });

  it('falls back to posting the form with Use this size when saving fails', async () => {
    const { form, slider } = setup(vi.fn(async () => Promise.reject(new Error('offline'))));
    slider.value = '6';
    slider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(form!.submitted).toEqual([form!.useThis]));
    expect(form!.useThis.hidden).toBe(false);
  });

  it('copes with a slider outside a form: it still shows and saves the size', () => {
    const { slider, root, save } = setup(undefined, false);
    slider.value = '1';
    slider.dispatchEvent(new Event('change'));
    expect(root.dataset['size']).toBe('80');
    expect(save).toHaveBeenCalledWith(1);
  });

  it('outside a form, a failed save leaves the size shown, with nothing to post', async () => {
    const save = vi.fn(async () => Promise.reject(new Error('offline')));
    const { slider, root } = setup(save, false);
    slider.value = '2';
    slider.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(2));
    expect(root.dataset['size']).toBe('90');
  });

  it('wires itself up when a page loads it', async () => {
    const form = new FakeForm();
    const slider = new FakeSlider(form);
    vi.stubGlobal('document', { documentElement: { dataset: {} }, getElementById: () => slider });
    vi.resetModules();
    await import('../public/scripts/size.js');
    vi.unstubAllGlobals();
    expect(form.useThis.hidden).toBe(true);
  });
});

describe('postSize', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the notch to /prefs as Use this size would, and does not follow the redirect back', async () => {
    const fetch = vi.fn(async () => ({ type: 'opaqueredirect', ok: false, status: 0 }));
    vi.stubGlobal('fetch', fetch);
    await postSize(6);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/prefs');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(String(init.body)).toBe('size=set&step=6');
  });

  it('fails on any answer but the redirect, so the form is posted instead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'basic', ok: false, status: 403 })));
    await expect(postSize(2)).rejects.toThrow('403');
    vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'basic', ok: true, status: 200 })));
    await expect(postSize(2)).resolves.toBeUndefined();
  });
});
