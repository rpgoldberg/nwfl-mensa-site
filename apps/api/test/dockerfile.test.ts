// The image contract, read from the Dockerfile itself: every base pinned by
// digest, the runtime stage non-root by number, and dumb-init as PID 1 so
// SIGTERM reaches the graceful drain. CI's image job proves the same at run
// time (non-root user, read-only root filesystem, /healthz answering).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
const lines = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#'));

const args = new Map(
  lines.flatMap((line) => {
    const match = /^ARG\s+(\w+)=(\S+)/.exec(line);
    return match ? [[match[1] as string, match[2] as string] as const] : [];
  }),
);

/** `FROM ${NODE_IMAGE} AS x` -> the image the ARG names. */
function baseImages(): string[] {
  return lines.flatMap((line) => {
    const match = /^FROM\s+(\S+)/.exec(line);
    if (!match) return [];
    const ref = match[1] as string;
    const arg = /^\$\{(\w+)\}$/.exec(ref);
    return [arg ? (args.get(arg[1] as string) ?? ref) : ref];
  });
}

function finalStage(): string[] {
  const starts = lines.flatMap((line, index) => (/^FROM\s/.test(line) ? [index] : []));
  return lines.slice(starts.at(-1));
}

describe('Dockerfile', () => {
  it('pins every external base image by sha256 digest', () => {
    const stages = new Set(lines.flatMap((line) => /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line)?.[1] ?? []));
    const external = baseImages().filter((image) => !stages.has(image));
    expect(external.length).toBeGreaterThan(0);
    for (const image of external) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('runs the final stage as a numeric, non-root user', () => {
    const user = finalStage().flatMap((line) => /^USER\s+(\S+)/.exec(line)?.[1] ?? []).at(-1);
    expect(user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
  });

  it('makes dumb-init PID 1, so SIGTERM reaches the drain', () => {
    expect(finalStage().find((line) => line.startsWith('ENTRYPOINT'))).toBe('ENTRYPOINT ["dumb-init", "--"]');
  });

  it('declares no VOLUME, so a read-only root filesystem needs no writable mount', () => {
    expect(lines.some((line) => /^VOLUME\s/.test(line))).toBe(false);
  });
});
