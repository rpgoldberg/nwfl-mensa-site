// Numbered-SQL doctrine, carried over from fc-coordinator: raw SQL applied by
// scripts/migrate.sh under psql -1, so the files never hold their own
// transaction control and never build an index CONCURRENTLY.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(REPO, 'migrations');

function files(): string[] {
  try {
    return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

// Executable SQL outside function bodies: comments and $tag$ bodies removed,
// as migrate.sh's own scan does, so a plpgsql BEGIN is not read as a
// transaction.
const executable = (file: string): string =>
  readFileSync(path.join(MIGRATIONS, file), 'utf8')
    .replace(/--[^\n]*/g, '')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, '');

describe('migrations: numbered-SQL doctrine', () => {
  it('starts with the grants file and numbers the rest NNNN_ without gaps', () => {
    const names = files();
    expect(names[0]).toBe('0000_grants.sql');
    names.forEach((name, index) => expect(name).toMatch(new RegExp(`^${String(index).padStart(4, '0')}_[a-z0-9_]+\\.sql$`)));
  });

  it('holds no transaction control: the runner owns the boundary (psql -1)', () => {
    for (const file of files()) {
      expect(executable(file), file).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION)\b/im);
    }
  });

  it('never builds an index CONCURRENTLY, which cannot run inside psql -1', () => {
    for (const file of files()) expect(executable(file), file).not.toMatch(/CONCURRENTLY/i);
  });

  it('ships the runner the migration Job wraps', () => {
    const runner = readFileSync(path.join(REPO, 'scripts', 'migrate.sh'), 'utf8');
    expect(runner).toMatch(/psql -X -q -v ON_ERROR_STOP=1/);
    expect(runner).toMatch(/pg_advisory_lock/);
  });
});
