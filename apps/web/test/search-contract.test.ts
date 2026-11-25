// The search contract (REDACT R2b; the archive search, R29). The search page
// may query only the API, which searches its own per-audience index built from
// that audience's redacted copy. The site must never build an index of its
// own: not from its bundled content, not from a page it rendered, not in a
// search library or an outside search service. Any of those would hold text
// the API withholds, and show it in a snippet. The page sends a signed-in
// reader's token as /read does; auth only picks the token, and the API decides
// the audience. What the page shows is shaped in src/lib/search.ts, held to
// the same rule here.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every module a source names at the top level: `import ... from`, a side-effect `import '...'`, and the
// re-exports `export * from` and `export { ... } from`, in either quote.
const moduleNames = (source: string) =>
  [...source.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s*(["'])([^"']+)\1|^\s*import\s*(["'])([^"']+)\3/gm)].map((m) => m[2] ?? m[4]);

const page = readFileSync('src/pages/search.astro', 'utf8');
const frontmatter = /^---\n([\s\S]*?)\n---/.exec(page)?.[1] ?? '';
const imports = moduleNames(frontmatter);

// What the search page may read: the layout and page list, the API (src/data's liveData, over src/lib/api/client.ts),
// the reader whose token goes with the read (as src/pages/read/[id].astro), and the shaping of the API's answer; for a
// lapsed sign-in, the way to sign in again (PUBLIC_ONLY and the password note, as on /news); for a refused token, /news's note.
const ALLOWED_IMPORTS = ['astro:env/server', '../components/PasswordNote.astro', '../components/TokenRefusedNote.astro', '../layouts/Base.astro', '../lib/site', '../data', '../lib/api/client', '../lib/api/page', '../lib/auth/bearer', '../lib/auth/flow', '../lib/search'];

const shaping = readFileSync('src/lib/search.ts', 'utf8');
const shapingImports = moduleNames(shaping);
// What the shaping may read: the API's answer and its types, the date format, and node's address check for the visitor limit.
const SHAPING_IMPORTS = ['node:net', '../data/format', '../data/live', '../gen/nwfl/mensa/v1/content_pb.js', '../gen/nwfl/mensa/v1/search_pb.js', './api/client'];
const READS_ITS_OWN_COPY = /astro:content|getCollection|getEntry|import\.meta\.glob|data\/fixtures|siteData|site-data|lib\/content|\.\/content\b|node:fs|["']fs(?:\/promises)?["']|\bfetch\(/;
// A module loaded at run time, which the import lists above never see: none is allowed in either source.
const LOADS_AT_RUN_TIME = /\bimport\s*\(|\brequire\s*\(|createRequire/;
// Index builders and outside search services: each would index the site's own copy, never the API's per-audience one.
const INDEXERS = /^(pagefind|astro-pagefind|lunr|elasticlunr|minisearch|flexsearch|fuse\.js|@orama\/.*|algoliasearch|@algolia\/.*|meilisearch|typesense|@docsearch\/.*)$/;

describe('the search contract', () => {
  it('is written at the top of the search page', () => {
    expect(frontmatter).toMatch(/SEARCH CONTRACT \(REDACT R2b\)/);
    expect(frontmatter).toMatch(/only the API/);
    expect(frontmatter).toContain('auth only picks the token; the API decides the audience');
  });

  it("sends the reader's token as /read does, and decides nothing about the audience itself", () => {
    const read = readFileSync('src/pages/read/[id].astro', 'utf8');
    for (const line of ['const auth = runtimeDeps();', 'readerFor(Astro.locals.session, auth);']) {
      expect(read).toContain(line);
      expect(frontmatter).toContain(line);
    }
    expect(read).toContain('const { reader } = readerFor(Astro.locals.session, auth);');
    // Besides the token, the page reads only whether the sign-in has lapsed, as /news does, to say only the public copies were searched.
    expect(frontmatter).toContain('const { reader, lapsed } = readerFor(Astro.locals.session, auth);');
    // The session is read for the token alone: never its groups, its name or whether it is a member's.
    expect(page.match(/Astro\.locals\.\w+(\.\w+)?/g)).toEqual(['Astro.locals.session']);
    const code = page.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
    expect(code).not.toMatch(/enrolee|groups|audience|members?\b/i);
    expect(shaping).not.toMatch(/enrolee|groups|session/i);
  });

  it('holds the shaping of the answer to the same rule: it reads the API\'s answer and nothing of the site\'s own', () => {
    expect(shapingImports.length).toBeGreaterThan(0);
    expect(shapingImports.filter((m) => !SHAPING_IMPORTS.includes(m!))).toEqual([]);
    expect(shaping).not.toMatch(READS_ITS_OWN_COPY);
  });

  it('needs no script: a plain GET form, and no script of its own', () => {
    expect(page).toMatch(/<form class="search-form" role="search" method="get" action="\/search">/);
    expect(page).not.toMatch(/<script/i);
  });

  it('writes HTML it did not escape in one place only: a snippet, escaped in src/lib/search.ts before its marks are made', () => {
    expect(page.match(/set:html=\{[^}]*\}/g)).toEqual(['set:html={hit.snippetHtml}']);
    expect(shaping).toMatch(/snippetHtml: snippetHtml\(/);
  });

  it('never logs: neither the page nor the shaping writes a line, so the query reaches no log of the site\'s', () => {
    for (const source of [page, shaping]) expect(source).not.toMatch(/console\.|apiLog|logEntry|\blog\(/);
  });

  it('loads no module at run time: no import(), require() or createRequire in the page or the shaping', () => {
    for (const [name, source] of [['src/pages/search.astro', page], ['src/lib/search.ts', shaping]] as const) expect(source, name).not.toMatch(LOADS_AT_RUN_TIME);
    // The checks have teeth: each way of loading the site's own copy at run time is caught.
    for (const loader of ["await import('../data/site-data')", "await import ('./content')", "require('../lib/content')", 'createRequire(import.meta.url)']) expect(loader).toMatch(LOADS_AT_RUN_TIME);
    for (const own of ["'../data/site-data'", "'../lib/content'", "'./content'"]) expect(own).toMatch(READS_ITS_OWN_COPY);
  });

  it('lets the search page import only the layout, the page list and the API reads', () => {
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((m) => !ALLOWED_IMPORTS.includes(m!))).toEqual([]);
  });

  it('sees every way a source names a module: either quote, a side-effect import and both re-exports', () => {
    const forms = [
      ['import EventList from "../components/EventList.astro";', '../components/EventList.astro'],
      ['import * as reader from "./reader";', './reader'],
      ['import { readFileSync } from "fs";', 'fs'],
      ["import type { X } from './x';", './x'],
      ['import {\n  a,\n  b,\n} from "./multi";', './multi'],
      ["import './side-effect';", './side-effect'],
      ['import "./side-effect-2";', './side-effect-2'],
      ["export * from './reader';", './reader'],
      ['export * as all from "./all";', './all'],
      ["export { a, b as c } from './some';", './some'],
      ['export type { T } from "./types";', './types'],
    ] as const;
    for (const [line, name] of forms) expect(moduleNames(line), line).toEqual([name]);
    // A local export names no module.
    expect(moduleNames("export const from = 'x';\nexport function f() {}")).toEqual([]);
    // And reading the file system by its bare name is the site's own copy too.
    for (const fs of ["'fs'", '"fs"', "'fs/promises'", "'node:fs/promises'"]) expect(fs).toMatch(READS_ITS_OWN_COPY);
  });

  it('never reads the bundled content, the file system or a fetched page from the search page', () => {
    expect(page).not.toMatch(READS_ITS_OWN_COPY);
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
