// LOGO-UNIT: the footer of every page carries the Mensa logo once, on its tile, beside the group's
// name, rendered by Astro's container.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOGO } from '../../scripts/make-logo.mjs';
import NotFound from '../../src/pages/404.astro';
import ServerError from '../../src/pages/500.astro';
import Privacy from '../../src/pages/privacy.astro';

let pages: string[] = [];
beforeAll(async () => {
  const container = await AstroContainer.create();
  const render = (page: Parameters<AstroContainer['renderToString']>[0], path: string) => container.renderToString(page, { request: new Request(`https://nwflorida.us${path}`) });
  pages = [await render(NotFound, '/no-such-page'), await render(Privacy, '/privacy'), await render(ServerError, '/500')];
});

const footerOf = (html: string) => /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

describe('the footer of every page', () => {
  it('shows the Mensa logo once on the page, and it is in the footer', () => {
    for (const html of pages) {
      expect(html.split('<img').filter((tag) => tag.includes('mensa-logo'))).toHaveLength(1);
      expect(footerOf(html).match(/<img\b[^>]*>/g)).toHaveLength(1);
    }
  });

  it('names it Mensa, with its size given so nothing moves as it loads', () => {
    for (const html of pages) {
      const img = /<img\b[^>]*>/.exec(footerOf(html))![0];
      expect(attr(img, 'class')).toBe('foot-logo');
      expect(attr(img, 'alt')).toBe('Mensa');
      expect(attr(img, 'src')).toBe('/icons/mensa-logo.png');
      expect(attr(img, 'srcset')).toBe('/icons/mensa-logo.png 1x, /icons/mensa-logo-2x.png 2x, /icons/mensa-logo-3x.png 3x');
      expect([attr(img, 'width'), attr(img, 'height')]).toEqual([String(LOGO.width), String(LOGO.height)]);
      expect([attr(img, 'width'), attr(img, 'height')]).toEqual(['238', '77']);
      // Upright and unstretched: no inline style to turn or squeeze it.
      expect(img).not.toMatch(/\sstyle=/);
    }
  });

  it('puts it beside the group’s name, as words, and neither is a link', () => {
    for (const html of pages) {
      const brand = /<div class="foot-brand">([\s\S]*?)<\/div>/.exec(footerOf(html))?.[1] ?? '';
      expect(brand.replace(/\s+/g, ' ').trim()).toMatch(/^<img\b[^>]*> ?<p>Northwest Florida Mensa, a local group of American Mensa for the Florida Panhandle, west of the Apalachicola River\.<\/p>$/);
      expect(brand).not.toContain('<a');
    }
  });

  it('keeps the links first, and hides nothing', () => {
    for (const html of pages) {
      const footer = footerOf(html);
      expect(footer.indexOf('class="foot-links"')).toBeLessThan(footer.indexOf('class="foot-brand"'));
      expect(footer).toContain('<a href="/privacy">Privacy</a>');
      expect(footer).not.toMatch(/\bhidden\b|display:\s*none|visually-hidden/);
    }
  });

  it('leaves the header its NWFL monogram', () => {
    for (const html of pages) {
      const header = /<header[\s\S]*<\/header>/.exec(html)?.[0] ?? '';
      expect(header).toContain('<img class="monogram" src="/icons/icon-192.png" alt="" width="40" height="40"');
      expect(header).not.toContain('mensa-logo');
    }
  });
});
