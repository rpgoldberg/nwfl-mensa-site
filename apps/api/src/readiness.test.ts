import { describe, expect, it } from 'vitest';
import { createReadiness } from './readiness.js';

describe('createReadiness', () => {
  it('is ready when the database answers', async () => {
    const readiness = createReadiness({ query: () => Promise.resolve({}) });
    expect(await readiness.check()).toEqual({ ready: true, db: 'ok', draining: false });
  });

  it('is not ready when the database is down', async () => {
    const readiness = createReadiness({ query: () => Promise.reject(new Error('down')) });
    expect(await readiness.check()).toEqual({ ready: false, db: 'down', draining: false });
  });

  it('is never ready once draining, even with a healthy database', async () => {
    const readiness = createReadiness({ query: () => Promise.resolve({}) });
    readiness.startDraining();
    expect(readiness.draining).toBe(true);
    expect(await readiness.check()).toEqual({ ready: false, db: 'ok', draining: true });
  });

  it('passes the probe timeout through', async () => {
    const readiness = createReadiness({ query: () => new Promise(() => {}) }, { probeTimeoutMs: 20 });
    expect(await readiness.check()).toEqual({ ready: false, db: 'down', draining: false });
  });
});
