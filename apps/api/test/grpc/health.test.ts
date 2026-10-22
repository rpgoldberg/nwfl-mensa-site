import { Code, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import type http2 from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health, HealthCheckResponse_ServingStatus as Status } from '../../src/gen/grpc/health/v1/health_pb.js';
import { healthRoutes } from '../../src/grpc/health.js';
import { createGrpcServer } from '../../src/grpc/server.js';
import { createReadiness, type Readiness } from '../../src/readiness.js';
import { closeHard, listen } from '../helpers/servers.js';

describe('grpc.health.v1.Health', () => {
  let dbUp = true;
  let readiness: Readiness;
  let server: http2.Http2Server;
  let baseUrl: string;

  beforeAll(async () => {
    readiness = createReadiness({ query: () => (dbUp ? Promise.resolve({}) : Promise.reject(new Error('down'))) });
    server = createGrpcServer({ routes: healthRoutes(readiness) });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
  });

  const client = () => createClient(Health, createGrpcTransport({ baseUrl }));

  it('reports the whole server SERVING or NOT_SERVING from readiness', async () => {
    dbUp = true;
    expect((await client().check({ service: '' })).status).toBe(Status.SERVING);
    dbUp = false;
    expect((await client().check({ service: '' })).status).toBe(Status.NOT_SERVING);
    dbUp = true;
  });

  it('answers NOT_FOUND for a service it does not know', async () => {
    await expect(client().check({ service: 'nwfl.mensa.v1.Nope' })).rejects.toMatchObject({ code: Code.NotFound });
  });

  it('lists the overall status under the empty name', async () => {
    const res = await client().list({});
    expect(Object.keys(res.statuses)).toEqual(['']);
    expect(res.statuses['']?.status).toBe(Status.SERVING);
  });

  it('leaves Watch unimplemented, which tells clients not to retry it', async () => {
    const stream = client().watch({ service: '' });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.Unimplemented });
  });
});
