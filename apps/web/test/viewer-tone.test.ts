// public/scripts/viewer-tone.js (DARKPDF, the editor's decision (a)): the pages follow the site's theme. Dark
// recolours the drawing (light text on a dark page) while every picture keeps its own colours, so a photo
// never shows as a negative; high contrast tints the paper to the theme's; light shows the page as printed.
// pdf.js 6.4.299's pageColors would grey every picture too (its filter covers the whole canvas), so the
// page is drawn as printed and pdf.js records where its pictures are (recordImages); those boxes are copied
// out of the drawing, unfiltered, over the recoloured page (site.css). A theme change is CSS alone.
import { describe, expect, it } from 'vitest';
import { PICTURE_SHARE, addPhotos, pageTone, photoBoxes } from '../public/scripts/viewer-tone.js';
import { FakeDoc, FakeEl } from './viewer-fakes';

describe('pageTone', () => {
  it("follows the theme the reader chose: light as printed, dark recoloured, high contrast tinted", () => {
    expect(pageTone('light', true, true)).toBe('light');
    expect(pageTone('dark', false, false)).toBe('dark');
    expect(pageTone('contrast-yellow', true, false)).toBe('tint');
    expect(pageTone('contrast-white', false, false)).toBe('tint');
  });

  it("with no choice (the device's theme), follows the device as the site's tokens do: more contrast first, then dark", () => {
    expect(pageTone(null, false, false)).toBe('light');
    expect(pageTone(null, true, false)).toBe('dark');
    expect(pageTone(null, true, true)).toBe('tint');
    expect(pageTone('system', true, false)).toBe('dark');
    expect(pageTone('something-new', false, false)).toBe('light');
  });
});

describe('photoBoxes', () => {
  it("turns pdf.js's image corners (three points, as fractions of the canvas) into whole-pixel boxes on the canvas", () => {
    // Upright: top left, bottom left, top right.
    const upright = [0.1, 0.2, 0.1, 0.5, 0.6, 0.2];
    expect(photoBoxes(upright, 1000, 2000)).toEqual([{ x: 100, y: 400, w: 500, h: 600 }]);
    // Turned: the box holds all four corners; one past the canvas is held to it.
    const turned = [0.5, 0, 0, 0.5, 1.2, 0.5];
    expect(photoBoxes(turned, 100, 100)).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it('keeps to the whole pixels inside a picture, so no edge pixel of paper is left unrecoloured', () => {
    // 10.4 to 59.6 across, 20.5 to 70.5 down: pixels 11 to 59 and 21 to 70.
    expect(photoBoxes([0.104, 0.205, 0.104, 0.705, 0.596, 0.205], 100, 100)).toEqual([{ x: 11, y: 21, w: 48, h: 49 }]);
  });

  it('leaves out a picture of less than two pixels either way, and none is no box', () => {
    expect(photoBoxes([0, 0, 0, 0.001, 0.5, 0], 1000, 1000)).toEqual([]);
    expect(photoBoxes(undefined, 1000, 1000)).toEqual([]);
    expect(photoBoxes(new Float32Array(0), 1000, 1000)).toEqual([]);
  });
});

describe('addPhotos', () => {
  const canvas = () => Object.assign(new FakeEl('canvas'), { width: 1000, height: 2000 });

  it('copies each box out of the drawing into a canvas of its own, placed over it in percent', () => {
    const doc = new FakeDoc(new FakeEl('body'));
    const sheet = canvas();
    const out = addPhotos(doc, sheet, [{ x: 100, y: 400, w: 500, h: 600 }]);
    expect(out.picture).toBe(false);
    expect(out.photos).toHaveLength(1);
    const [photo] = out.photos as FakeEl[];
    expect(photo!.classes.has('viewer-photo')).toBe(true);
    expect(photo!.getAttribute('aria-hidden')).toBe('true');
    expect([photo!.width, photo!.height]).toEqual([500, 600]);
    expect([photo!.style.left, photo!.style.top, photo!.style.width, photo!.style.height]).toEqual(['10%', '20%', '50%', '30%']);
    expect(photo!.drawn).toEqual([[sheet, 100, 400, 500, 600, 0, 0, 500, 600]]);
  });

  it('a picture that fills the page (a scanned page) is no copy: the whole page stays as printed', () => {
    const doc = new FakeDoc(new FakeEl('body'));
    const big = Math.ceil(Math.sqrt(PICTURE_SHARE) * 1000);
    const out = addPhotos(doc, canvas(), [{ x: 0, y: 0, w: big, h: big * 2 }, { x: 0, y: 0, w: 10, h: 10 }]);
    expect(out).toEqual({ picture: true, photos: [] });
    expect(addPhotos(doc, canvas(), [])).toEqual({ picture: false, photos: [] });
  });
});
