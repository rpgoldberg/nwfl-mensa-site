import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync('Dockerfile', 'utf8');
const code = dockerfile.replace(/^\s*#.*$/gm, '').replace(/\\\n\s*/g, ' ');
const stages = code.split(/^FROM /m).slice(1);
const runtime = stages.at(-1) ?? '';

describe('Dockerfile', () => {
  it('pins every base image by digest', () => {
    const args = Object.fromEntries([...code.matchAll(/^ARG (\w+)=(\S+)$/gm)].map((m) => [m[1], m[2]]));
    const froms = [...code.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!.replace(/^\$\{(\w+)\}$/, (_, name: string) => args[name] ?? ''));
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const image of froms) expect(image).toMatch(/^node:24\.\d+\.\d+-[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('runs as a numeric non-root user', () => {
    const user = [...runtime.matchAll(/^USER (\S+)$/gm)].at(-1)?.[1];
    expect(user).toMatch(/^[1-9]\d{3,}:[1-9]\d{3,}$/);
  });

  it('starts the site server under an init that forwards SIGTERM', () => {
    expect(runtime).toMatch(/^ENTRYPOINT \["dumb-init", "--"\]$/m);
    expect(runtime).toMatch(/^CMD \["node", "server\/serve\.mjs"\]$/m);
    expect(runtime).toMatch(/^EXPOSE 8080$/m);
    expect(runtime).toMatch(/^HEALTHCHECK .*\/healthz/m);
  });

  it('ships production dependencies and the build, owned by root, and no package manager', () => {
    expect(runtime).toMatch(/npm ci --omit=dev|--from=deps/);
    expect(runtime).toMatch(/^COPY --from=build --chown=root:root \/app\/dist \.\/dist$/m);
    expect(runtime).toMatch(/rm -rf .*\/usr\/local\/lib\/node_modules\/npm/);
    // Host files keep their mode in COPY; a 0600 checkout would be unreadable to uid 10001.
    for (const line of runtime.match(/^COPY (?!--from).*$/gm) ?? []) expect(line).toMatch(/^COPY --chown=root:root --chmod=0644 /);
    expect(stages[0]).toMatch(/^RUN chmod -R a\+rX dist server$/m);
    expect(runtime).toMatch(/^COPY --from=build --chown=root:root \/app\/server \.\/server$/m);
  });

  it("gives the build everything the site is made from, the site's own texts included", () => {
    for (const dir of ['public', 'src', 'content', 'server']) expect(stages[0], dir).toMatch(new RegExp(`^COPY ${dir} \\./${dir}$`, 'm'));
  });

  it('builds a public-only image when asked, and a full one by default', () => {
    expect(stages[0]).toMatch(/^ARG PUBLIC_ONLY=false$/m);
    expect(stages[0]).toMatch(/^RUN PUBLIC_ONLY=\$\{PUBLIC_ONLY\} npx astro build$/m);
  });

  it('keeps the build context small and secret-free', () => {
    const ignore = readFileSync('.dockerignore', 'utf8').split('\n').map((l) => l.trim());
    for (const entry of ['node_modules', 'dist', '.git', '.env', 'coverage', 'test-results', '.astro']) {
      expect(ignore, entry).toContain(entry);
    }
  });
});

describe('astro.config.mjs', () => {
  it('caps every request body Astro reads at 64 KiB (its default is 1 GB)', () => {
    expect(readFileSync('astro.config.mjs', 'utf8')).toMatch(/node\(\{ mode: 'standalone', bodySizeLimit: 64 \* 1024 \}\)/);
  });
});
