import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Astro's virtual modules do not exist outside its build; unit tests see a full build.
  resolve: { alias: { 'astro:env/server': new URL('./test/stubs/astro-env-server.ts', import.meta.url).pathname } },
  test: {
    include: ['server/**/*.test.{ts,mjs}', 'src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['server/**/*.mjs', 'src/lib/**/*.ts', 'src/middleware.ts', 'src/pages/**/*.ts', 'public/scripts/**/*.js'],
      exclude: ['**/*.test.*'],
      reporter: ['text', 'lcov'],
      // The 85 % line AND branch gate, here so CI and a local run fail alike.
      thresholds: { lines: 85, branches: 85 },
    },
  },
});
