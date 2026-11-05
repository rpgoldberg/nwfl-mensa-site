import { defineConfig } from 'vitest/config';

// The suite runs only inside a capped container with no network (scripts/test-contained.sh): it parses
// PDFs and drives hostile inputs, and no test may reach a real outside site. The coverage gate is
// 85 % line AND branch, PER FILE, as in apps/api.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src'],
      exclude: [
        // The process entrypoint: argv, stdio and exit wiring only (cli.ts main is tested).
        'src/bin.ts',
        // extract()'s worker thread: workerData in, one message out (readPdf is tested in-process, and
        // test/extract-isolated.test.ts runs this very file in a worker, where coverage cannot see it).
        'src/extract-worker.ts',
      ],
      thresholds: {
        perFile: true,
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
      },
    },
  },
});
