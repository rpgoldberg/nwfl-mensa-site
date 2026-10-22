import { describe, expect, it } from 'vitest';
import { buildHealthApp } from '../src/health/app.js';
import { createStructuredLogger } from '../src/platform/logger.js';
import { createReadiness } from '../src/readiness.js';
import { captureLogs } from './helpers/servers.js';

const up = { query: () => Promise.resolve({}) };
const down = { query: () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED db:5432'), { code: 'ECONNREFUSED' })) };

describe('health port', () => {
  it('answers /healthz 200 without touching the database (liveness)', async () => {
    let queries = 0;
    const app = buildHealthApp({ readiness: createReadiness({ query: () => ((queries += 1), Promise.resolve({})) }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    expect(queries).toBe(0);
    await app.close();
  });

  it('answers /readyz 200 when Postgres answers', async () => {
    const app = buildHealthApp({ readiness: createReadiness(up) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', db: 'ok' });
    await app.close();
  });

  it('answers /readyz 503 when Postgres is down, naming no host and no error text', async () => {
    const app = buildHealthApp({ readiness: createReadiness(down) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', db: 'down' });
    expect(res.body).not.toMatch(/ECONNREFUSED|db:5432/);
    await app.close();
  });

  it('answers /readyz 503 draining once shutdown has begun', async () => {
    const readiness = createReadiness(up);
    readiness.startDraining();
    const app = buildHealthApp({ readiness });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'draining', db: 'ok' });
    await app.close();
  });

  it('serves nothing else, and no write method', async () => {
    const app = buildHealthApp({ readiness: createReadiness(up) });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/readyz', payload: { a: 1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/grpc.health.v1.Health/Check' })).statusCode).toBe(404);
    await app.close();
  });

  it('does not log every probe, and logs JSON through the structured logger', async () => {
    const { lines, sink } = captureLogs();
    const app = buildHealthApp({ readiness: createReadiness(up), logger: createStructuredLogger({ sink }) });
    await app.inject({ method: 'GET', url: '/readyz' });
    await app.inject({ method: 'GET', url: '/healthz' });
    expect(lines.filter((l) => /request/.test(String(l['msg'])))).toEqual([]);
    app.log.info('through fastify');
    expect(lines.at(-1)).toMatchObject({ msg: 'through fastify', level: 'info' });
    await app.close();
  });
});
