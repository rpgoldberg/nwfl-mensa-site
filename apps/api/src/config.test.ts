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
    });
  });

  it('reads the chapter it serves from TENANT (CF-ISO-0), and refuses a malformed one', () => {
    expect(readConfig({ TENANT: 'mensa-other' }).tenant).toBe('mensa-other');
    expect(() => readConfig({ TENANT: 'Bad Tenant' })).toThrow(/TENANT/);
  });

  it('reads overrides', () => {
    expect(
      readConfig({ HOST: '127.0.0.1', GRPC_PORT: '6000', HEALTH_PORT: '6001', LOG_LEVEL: 'debug', DRAIN_TIMEOUT_MS: '500' }),
    ).toEqual({ host: '127.0.0.1', grpcPort: 6000, healthPort: 6001, logLevel: 'debug', drainTimeoutMs: 500, tenant: 'nwflorida' });
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
