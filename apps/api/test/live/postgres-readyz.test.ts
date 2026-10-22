// /readyz against a REAL Postgres. The database is a throwaway container the
// caller starts and names by URL (see README, "Testing"); CI starts one per
// run. Locally the suite skips without it; in CI a missing database fails.
import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';
import { buildHealthApp } from '../../src/health/app.js';
import { createReadiness } from '../../src/readiness.js';

const url = process.env['NWFL_TEST_DATABASE_URL'];

describe('live Postgres', () => {
  it.runIf(process.env['CI'] === 'true')('is provided in CI', () => {
    expect(url, 'NWFL_TEST_DATABASE_URL must be set in CI').toBeTruthy();
  });

  describe.skipIf(url === undefined)('readyz', () => {
    it('reports ready against the real database', async () => {
      const pool = createPool({ DATABASE_URL: url });
      const app = buildHealthApp({ readiness: createReadiness(pool) });
      try {
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: 'ready', db: 'ok' });
      } finally {
        await app.close();
        await pool.end();
      }
    });

    it('reports not ready, quickly, when the database refuses the credentials', async () => {
      const wrong = new URL(url as string);
      wrong.password = 'not-the-password';
      const pool = createPool({ DATABASE_URL: wrong.toString() });
      const app = buildHealthApp({ readiness: createReadiness(pool) });
      try {
        const res = await app.inject({ method: 'GET', url: '/readyz' });
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ status: 'not_ready', db: 'down' });
      } finally {
        await app.close();
        await pool.end();
      }
    });
  });
});
