import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

describe('readConfig', () => {
  it('defaults to gRPC on 50051 and health on 8081, all interfaces', () => {
    expect(readConfig({})).toEqual({
      host: '0.0.0.0',
      grpcPort: 50051,
      healthPort: 8081,
      logLevel: 'info',
      drainTimeoutMs: 20_000,
      tenant: 'nwflorida',
      linkOrigin: 'https://nwflorida.us',
    });
  });

  it('reads LINK_ORIGIN at boot (LINKS L3 fix 1, N5): a bad one stops the server; production takes no localhost', () => {
    expect(readConfig({ LINK_ORIGIN: 'https://nwflmensa.us' }).linkOrigin).toBe('https://nwflmensa.us');
    expect(readConfig({ LINK_ORIGIN: 'https://localhost:4321' }).linkOrigin).toBe('https://localhost:4321');
    for (const bad of ['http://nwflorida.us', 'https://nwflorida.us/out', '']) expect(() => readConfig({ LINK_ORIGIN: bad }), bad).toThrow(/LINK_ORIGIN/);
    expect(() => readConfig({ NODE_ENV: 'production', LINK_ORIGIN: 'https://localhost:4321' })).toThrow(/LINK_ORIGIN/);
    expect(readConfig({ NODE_ENV: 'production' }).linkOrigin).toBe('https://nwflorida.us');
  });

  it('reads the chapter it serves from TENANT (CF-ISO-0), and refuses a malformed one', () => {
    expect(readConfig({ TENANT: 'mensa-other' }).tenant).toBe('mensa-other');
    expect(() => readConfig({ TENANT: 'Bad Tenant' })).toThrow(/TENANT/);
  });

  it('reads overrides', () => {
    expect(
      readConfig({ HOST: '127.0.0.1', GRPC_PORT: '6000', HEALTH_PORT: '6001', LOG_LEVEL: 'debug', DRAIN_TIMEOUT_MS: '500' }),
    ).toEqual({ host: '127.0.0.1', grpcPort: 6000, healthPort: 6001, logLevel: 'debug', drainTimeoutMs: 500, tenant: 'nwflorida', linkOrigin: 'https://nwflorida.us' });
  });

  it.each([
    [{ GRPC_PORT: 'abc' }, /GRPC_PORT/],
    [{ GRPC_PORT: '70000' }, /GRPC_PORT/],
    [{ HEALTH_PORT: '0' }, /HEALTH_PORT/],
    [{ GRPC_PORT: '7000', HEALTH_PORT: '7000' }, /must differ/],
    [{ LOG_LEVEL: 'loud' }, /LOG_LEVEL/],
    [{ DRAIN_TIMEOUT_MS: '-5' }, /DRAIN_TIMEOUT_MS/],
  ])('refuses %o', (env, message) => {
    expect(() => readConfig(env)).toThrow(message);
  });
});
