// @ts-check
import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', '.astro/', 'coverage/', 'test-results/', 'playwright-report/', 'blob-report/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  // Astro's accessibility rules on top of axe in the e2e suite.
  ...astro.configs['jsx-a11y-strict'],
  { languageOptions: { globals: { ...globals.node } } },
  // A labelled region that scrolls sideways must take keyboard focus (axe
  // scrollable-region-focusable), so a region may carry tabindex="0".
  { rules: { 'astro/jsx-a11y/no-noninteractive-tabindex': ['error', { roles: ['tabpanel', 'region'] }] } },
  // Code that runs in a browser: the site's script, and the icon maker's page callbacks.
  { files: ['public/scripts/**/*.js', 'scripts/make-icons.mjs'], languageOptions: { globals: { ...globals.browser } } },
);
