// EDITOR E2: the .astro components' tests (test/components), in Astro's own Vite setup, so Astro's
// container (astro/container) can render them and the pages they are checked against. Run as one
// of the projects in vitest.config.ts.
import { getViteConfig } from 'astro/config';

export default getViteConfig({
  test: { name: 'components', include: ['test/components/**/*.test.ts'] },
});
