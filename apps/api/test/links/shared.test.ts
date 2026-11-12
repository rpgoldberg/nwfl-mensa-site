// The URL rules are linkcheck's, copied (EDITOR A3a, SPEC-v3 3.2 N3): this suite fails the moment the
// copy and the original differ, so the API and the checker can never give different answers.
//   - src/links/urls.ts is apps/linkcheck/src/urls.ts byte for byte, and test/links/urls.test.ts is
//     linkcheck's test/urls.test.ts with only its import path changed;
//   - the shared table is the same file in both apps, its sha256 pinned in both suites;
//   - the bare-URL pattern is the one linkcheck's extract.ts reads printed URLs with;
//   - both apps pin the same tldts, and their lockfiles resolve the same tldts and tldts-core.
// api.yml runs this suite when any of those linkcheck files changes.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { URL_IN_TEXT } from '../../src/links/rule.js';

/** The sha256 of the shared table; the same constant in linkcheck's test/url-rules.test.ts. */
export const URL_RULES_SHA256 = '23307908ee644f7198f0033a973a687afb97317a61d7bc8aae269cfbaa78b445';

const api = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const linkcheck = (path: string): string => readFileSync(new URL(`../../../linkcheck/${path}`, import.meta.url), 'utf8');

interface Lock {
  packages: Record<string, { version?: string }>;
}
const resolved = (lock: string, name: string): string | undefined => {
  const { packages } = JSON.parse(lock) as Lock;
  return packages[`node_modules/${name}`]?.version ?? packages[`node_modules/tldts/node_modules/${name}`]?.version;
};

describe('the URL rules shared with linkcheck', () => {
  it('src/links/urls.ts is linkcheck src/urls.ts, byte for byte', () => {
    expect(api('src/links/urls.ts')).toBe(linkcheck('src/urls.ts'));
  });

  it("test/links/urls.test.ts is linkcheck's test/urls.test.ts with only its import path changed", () => {
    const original = linkcheck('test/urls.test.ts');
    expect(original).toContain("from '../src/urls.js';");
    expect(api('test/links/urls.test.ts')).toBe(original.replace("from '../src/urls.js';", "from '../../src/links/urls.js';"));
  });

  it('the shared table is the same file in both apps, with the pinned sha256', () => {
    const table = api('test/fixtures/url-rules.json');
    expect(createHash('sha256').update(table).digest('hex')).toBe(URL_RULES_SHA256);
    expect(table).toBe(linkcheck('test/fixtures/url-rules.json'));
    expect(linkcheck('test/url-rules.test.ts')).toContain(`export const URL_RULES_SHA256 = '${URL_RULES_SHA256}';`);
  });

  it("finds bare URLs with linkcheck extract.ts's own pattern", () => {
    expect(linkcheck('src/extract.ts')).toContain(`const URL_IN_TEXT = ${String(URL_IN_TEXT)};`);
  });

  it('both apps pin the same tldts, and resolve the same tldts and tldts-core', () => {
    const pinned = (text: string): unknown => (JSON.parse(text) as { dependencies: Record<string, string> }).dependencies['tldts'];
    expect(pinned(api('package.json'))).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned(api('package.json'))).toBe(pinned(linkcheck('package.json')));
    for (const name of ['tldts', 'tldts-core']) {
      expect(resolved(api('package-lock.json'), name)).toBe(pinned(api('package.json')));
      expect(resolved(linkcheck('package-lock.json'), name)).toBe(pinned(api('package.json')));
    }
  });
});
