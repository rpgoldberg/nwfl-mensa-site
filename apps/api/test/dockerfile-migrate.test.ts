// The migration image contract, read from Dockerfile.migrate itself: a digest-
// pinned postgres base (it carries psql), a numeric non-root user, only
// scripts/migrate.sh and migrations/ copied in, and no secret baked in. CI's
// migrate job proves the same at run time, read-only, against a real Postgres.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(REPO, 'Dockerfile.migrate'), 'utf8');
// A backslash continuation is one instruction.
const lines = dockerfile.replace(/\\\n\s*/g, ' ').split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

const args = new Map(
  lines.flatMap((line) => {
    const match = /^ARG\s+(\w+)=(\S+)/.exec(line);
    return match ? [[match[1] as string, match[2] as string] as const] : [];
  }),
);

function bases(): string[] {
  return lines.flatMap((line) => {
    const match = /^FROM\s+(\S+)/.exec(line);
    if (!match) return [];
    const ref = match[1] as string;
    const arg = /^\$\{(\w+)\}$/.exec(ref);
    return [arg ? (args.get(arg[1] as string) ?? ref) : ref];
  });
}

describe('Dockerfile.migrate', () => {
  it('builds on one official postgres 17 alpine base, pinned by tag and sha256 digest', () => {
    expect(bases()).toHaveLength(1);
    expect(bases()[0]).toMatch(/^postgres:17\.\d+-alpine\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it('pins the Dockerfile frontend by version and digest', () => {
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  it('runs as a numeric, non-root user', () => {
    const user = lines.flatMap((line) => /^USER\s+(\S+)/.exec(line)?.[1] ?? []).at(-1);
    expect(user).toMatch(/^[1-9]\d*:[1-9]\d*$/);
  });

  it('copies only scripts/migrate.sh and migrations/, owned by root', () => {
    const copies = lines.filter((line) => /^(COPY|ADD)\s/.test(line));
    expect(copies.map((line) => line.replace(/^COPY\s+--chown=root:root\s+/, ''))).toEqual([
      'scripts/migrate.sh /app/scripts/migrate.sh',
      'migrations /app/migrations',
    ]);
    for (const copy of copies) expect(copy, copy).toMatch(/^COPY --chown=root:root /);
  });

  it('makes the copied files read-only (0444) and folders read-and-search only (0555)', () => {
    expect(lines).toContain(
      'RUN find /app -type d -exec chmod 0555 {} + && find /app -type f -exec chmod 0444 {} +',
    );
  });

  it('runs migrate.sh on the baked-in migrations, replacing the postgres server entrypoint', () => {
    expect(lines).toContain('ENTRYPOINT ["sh", "/app/scripts/migrate.sh", "/app/migrations"]');
    expect(lines).toContain('CMD []');
  });

  it('points HOME and TMPDIR at /tmp, so a read-only root filesystem still works', () => {
    const env = lines.filter((line) => /^ENV\s/.test(line)).join(' ');
    expect(env).toMatch(/\bHOME=\/tmp\b/);
    expect(env).toMatch(/\bTMPDIR=\/tmp\b/);
  });

  it('bakes in no secret or connection setting: the Job supplies the PG* environment', () => {
    const env = lines.filter((line) => /^(ENV|ARG)\s/.test(line)).join('\n');
    expect(env).not.toMatch(/PASS|SECRET|TOKEN|KEY|CRED|PGUSER|PGDATABASE|PGHOST|PGSSL/i);
    expect(lines.some((line) => /^(EXPOSE|VOLUME|HEALTHCHECK)\s/.test(line))).toBe(false);
  });

  it('runs no server and installs nothing', () => {
    expect(dockerfile).not.toMatch(/\b(apk|apt-get|curl|wget|npm)\b/);
  });
});
