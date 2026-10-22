import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool, describeTarget, poolConfigFromEnv, probeDatabase, sslFromEnv } from './pool.js';

describe('sslFromEnv', () => {
  it('is plaintext when PGSSLMODE is unset, empty or disable', () => {
    expect(sslFromEnv({})).toBeUndefined();
    expect(sslFromEnv({ PGSSLMODE: '' })).toBeUndefined();
    expect(sslFromEnv({ PGSSLMODE: 'disable' })).toBeUndefined();
  });

  it('encrypts without verifying on require', () => {
    expect(sslFromEnv({ PGSSLMODE: 'require' })).toEqual({ rejectUnauthorized: false });
  });

  it('verifies against the CA file CONTENTS on verify-full', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-ca-'));
    const ca = path.join(dir, 'ca.crt');
    writeFileSync(ca, 'PEM BYTES');
    expect(sslFromEnv({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: ca })).toEqual({ rejectUnauthorized: true, ca: 'PEM BYTES' });
    expect(sslFromEnv({ PGSSLMODE: 'verify-full' })).toEqual({ rejectUnauthorized: true });
  });

  it('refuses a mode it does not implement rather than downgrading', () => {
    expect(() => sslFromEnv({ PGSSLMODE: 'prefer' })).toThrow(/unsupported PGSSLMODE/);
  });
});

describe('poolConfigFromEnv', () => {
  it('uses DATABASE_URL when present and lets PGSSLMODE win', () => {
    const config = poolConfigFromEnv({ DATABASE_URL: 'postgres://u:p@h:5/d?sslmode=disable', PGSSLMODE: 'require' });
    expect(config.connectionString).toBe('postgres://u:p@h:5/d?sslmode=disable');
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('falls back to discrete PG* variables with local defaults', () => {
    expect(poolConfigFromEnv({})).toMatchObject({ host: '127.0.0.1', port: 5432, user: 'nwfl', database: 'nwfl' });
    expect(poolConfigFromEnv({ PGHOST: 'db', PGPORT: '6543', PGUSER: 'a', PGPASSWORD: 'b', PGDATABASE: 'c' })).toMatchObject({
      host: 'db',
      port: 6543,
      user: 'a',
      password: 'b',
      database: 'c',
    });
  });

  it('bounds the pool and the connect wait', () => {
    expect(poolConfigFromEnv({}).max).toBe(10);
    expect(poolConfigFromEnv({ PG_POOL_MAX: '3' }).max).toBe(3);
    expect(poolConfigFromEnv({ PG_POOL_MAX: 'zero' }).max).toBe(10);
    expect(poolConfigFromEnv({ PG_POOL_MAX: '-1' }).max).toBe(10);
    expect(poolConfigFromEnv({}).connectionTimeoutMillis).toBe(5000);
  });
});

describe('describeTarget', () => {
  it('drops the userinfo from a DATABASE_URL', () => {
    expect(describeTarget({ DATABASE_URL: 'postgres://user:hunter2@db:5432/nwfl' })).toBe('db:5432/nwfl');
    expect(describeTarget({ DATABASE_URL: 'not a url' })).toBe('<unparseable>');
  });

  it('describes discrete variables and admits when it knows nothing', () => {
    expect(describeTarget({ PGHOST: 'db' })).toBe('db:5432/nwfl');
    expect(describeTarget({ PGHOST: 'db', PGPORT: '6', PGDATABASE: 'x' })).toBe('db:6/x');
    expect(describeTarget({})).toBe('unknown');
  });
});

describe('createPool', () => {
  it('builds a pool that absorbs idle-client errors instead of crashing the process', async () => {
    const pool = createPool({ PGHOST: '127.0.0.1' });
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', new Error('idle client dropped'));
    await pool.end();
  });
});

describe('probeDatabase', () => {
  it('reports reachable when SELECT 1 answers', async () => {
    const probe = await probeDatabase({ query: () => Promise.resolve({}) });
    expect(probe.reachable).toBe(true);
    expect(probe.code).toBeUndefined();
  });

  it('reports the driver code only, never the message', async () => {
    const error = Object.assign(new Error('password authentication failed for user "nwfl"'), { code: '28P01' });
    const probe = await probeDatabase({ query: () => Promise.reject(error) });
    expect(probe).toMatchObject({ reachable: false, code: '28P01' });
    expect(JSON.stringify(probe)).not.toContain('password');
  });

  it('reports UNKNOWN for an error without a code', async () => {
    const probe = await probeDatabase({ query: () => Promise.reject(new Error('x')) });
    expect(probe).toMatchObject({ reachable: false, code: 'UNKNOWN' });
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const odd = await probeDatabase({ query: () => Promise.reject('not an error') });
    expect(odd.code).toBe('UNKNOWN');
  });

  it('gives up after the timeout so a hung database cannot hang the probe', async () => {
    const started = Date.now();
    const probe = await probeDatabase({ query: () => new Promise(() => {}) }, 50);
    expect(probe).toMatchObject({ reachable: false, code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
