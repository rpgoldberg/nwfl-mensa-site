// A live Postgres for the migration suites: the throwaway container from
// scripts/test-db.sh (see README, "Testing"). Each suite gets its own database
// owned by the migrator role, so suites running in parallel never share
// state. migrate.sh runs INSIDE the container (docker exec), with the
// container's own psql, against the repo mounted read-only at /repo.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { onIdleError } from '../../src/db/pool.js';

export const url = process.env['NWFL_TEST_DATABASE_URL'];
export const container = process.env['NWFL_TEST_PG_CONTAINER'];
export const live = url !== undefined && container !== undefined;

export const MIGRATOR = 'nwfl_migrator';
export const MIGRATOR_PW = 'migrator-pw';
// The application role. 0000_grants.sql names it literally: it is the role the
// deployed DSN connects as.
export const APP = 'nwfl';
export const APP_PW = 'app-pw';
// The PDF regeneration worker's role (0017). fc creates it in production; the harness creates it in
// every suite, so every suite sees the same grants (roles are cluster-wide, suites run in parallel).
// Its attributes are those of ~/tmp/mensa-site/pdf-worker/role-spec.md, but a higher connection limit:
// parallel suites share it.
export const WORKER = 'nwfl_worker';
export const WORKER_PW = 'worker-pw';
export const WORKER_ATTRIBUTES = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function dockerExec(args: string[], env: Record<string, string> = {}): Promise<ExecResult> {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return new Promise((resolve) => {
    execFile('docker', ['exec', ...envArgs, container as string, ...args], (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

/** sh /repo/scripts/migrate.sh <dir> as the migrator (or as `env` overrides it). */
export function migrate(database: string, dir = '/repo/migrations', env: Record<string, string> = {}): Promise<ExecResult> {
  return dockerExec(['sh', '/repo/scripts/migrate.sh', dir], {
    PGHOST: '127.0.0.1',
    PGUSER: MIGRATOR,
    PGPASSWORD: MIGRATOR_PW,
    PGDATABASE: database,
    ...env,
  });
}

export function urlFor(user: string, password: string, database: string): string {
  const target = new URL(url as string);
  target.username = user;
  target.password = password;
  target.pathname = `/${database}`;
  return target.toString();
}

export async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const asSuper = <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => withClient(url as string, fn);

const IGNORABLE = new Set(['42710', '23505']); // role exists; a parallel suite created it first

async function ensureRole(client: pg.Client, name: string, password: string, attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'): Promise<void> {
  try {
    await client.query(`CREATE ROLE ${name} ${attributes} PASSWORD '${password}'`);
  } catch (error) {
    if (!IGNORABLE.has((error as { code?: string }).code ?? '')) throw error;
  }
}

/** A fresh database owned by the migrator, plus the three roles. */
export async function freshDatabase(prefix: string): Promise<string> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  await asSuper(async (client) => {
    await ensureRole(client, MIGRATOR, MIGRATOR_PW);
    await ensureRole(client, APP, APP_PW);
    await ensureRole(client, WORKER, WORKER_PW, WORKER_ATTRIBUTES);
    await client.query(`CREATE DATABASE ${name} OWNER ${MIGRATOR}`);
  });
  return name;
}

export async function dropDatabase(name: string): Promise<void> {
  await asSuper((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}

/** The SQLSTATE a statement fails with, or 'ok'. */
export async function sqlstate(client: pg.Client, text: string, values: unknown[] = []): Promise<string> {
  try {
    await client.query(text, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
}

/** The error message a statement fails with, or 'ok'. */
export async function failure(client: pg.Client, text: string, values: unknown[] = []): Promise<string> {
  try {
    await client.query(text, values);
    return 'ok';
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * A pool for a test's database. Dropping the database (WITH FORCE) ends any connection still idle in
 * it, and without a listener that 'error' would surface as an unhandled error and fail the run.
 */
export const testPool = (config: pg.PoolConfig): pg.Pool => onIdleError(new pg.Pool(config));
