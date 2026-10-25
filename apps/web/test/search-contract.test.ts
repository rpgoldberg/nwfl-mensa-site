// The search contract (REDACT R2b; search itself is R29, not built yet). When
// the archive search arrives it may query only the API, which searches its own
// per-audience index built from that audience's redacted copy. The site must
// never build an index of its own: not from its bundled content, not from a
// page it rendered, not in a search library or an outside search service. Any
// of those would hold text the API withholds, and show it in a snippet.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync('src/pages/search.astro', 'utf8');
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(page)?.[1] ?? '';
const imports = [...frontmatter.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

// What the search page may read: the layout and page list, and, once built, the API (src/data's liveData, over src/lib/api/client.ts).
const ALLOWED_IMPORTS = ['../layouts/Base.astro', '../lib/site', '../data', '../lib/api/client', '../lib/api/page'];
// Index builders and outside search services: each would index the site's own copy, never the API's per-audience one.
const INDEXERS = /^(pagefind|astro-pagefind|lunr|elasticlunr|minisearch|flexsearch|fuse\.js|@orama\/.*|algoliasearch|@algolia\/.*|meilisearch|typesense|@docsearch\/.*)$/;

describe('the search contract', () => {
  it('is written at the top of the search page', () => {
    expect(frontmatter).toMatch(/SEARCH CONTRACT \(REDACT R2b\)/);
    expect(frontmatter).toMatch(/only the API/);
  });

  it('lets the search page import only the layout, the page list and the API reads', () => {
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((m) => !ALLOWED_IMPORTS.includes(m!))).toEqual([]);
  });

  it('never reads the bundled content, the file system or a fetched page from the search page', () => {
    expect(page).not.toMatch(/astro:content|getCollection|getEntry|import\.meta\.glob|data\/fixtures|siteData|node:fs|\bfetch\(/);
  });

  it('adds no search index library or service to the site', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = [...Object.keys(pkg['dependencies'] ?? {}), ...Object.keys(pkg['devDependencies'] ?? {})];
    expect(deps.filter((d) => INDEXERS.test(d))).toEqual([]);
    const config = readFileSync('astro.config.mjs', 'utf8');
    expect(config).not.toMatch(/pagefind|lunr|minisearch|flexsearch|orama|algolia/i);
  });

  it('ships no prebuilt search index', () => {
    const files = readdirSync('public', { recursive: true }).map(String);
    expect(files.filter((f) => /pagefind|search[-_.]?index|lunr|\.idx$/i.test(f))).toEqual([]);
  });
});
