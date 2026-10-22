// Every file under src/pages/ is a route: a test file there would be built and
// served (as /prefs.test did), with the test runner bundled into the server.
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('src/pages/', () => {
  it('holds routes only, no test files', () => {
    const files = readdirSync('src/pages', { recursive: true }).map(String);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((f) => /\.test\./.test(f))).toEqual([]);
  });
});
