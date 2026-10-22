// N2: the gRPC port serves ONLY the gRPC wire protocol. The Connect protocol
// (JSON or binary POST, and its GET form) and gRPC-Web are not gRPC on the
// wire, so a caller speaking them must be refused, while a real gRPC call
// succeeds. Each refusal also proves the handler never ran.
import { create, toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport, createGrpcTransport, createGrpcWebTransport } from '@connectrpc/connect-node';
import type http2 from 'node:http2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Health, HealthCheckRequestSchema, HealthCheckResponse_ServingStatus } from '../../src/gen/grpc/health/v1/health_pb.js';
import { healthRoutes } from '../../src/grpc/health.js';
import { GRPC_PROTOCOLS, READ_MAX_BYTES, createGrpcServer } from '../../src/grpc/server.js';
import { createReadiness } from '../../src/readiness.js';
import { grpcFrame, h2Request, http1Post } from '../helpers/h2.js';
import { closeHard, listen } from '../helpers/servers.js';

const CHECK_PATH = '/grpc.health.v1.Health/Check';

describe('gRPC port: gRPC wire protocol only (N2)', () => {
  let server: http2.Http2Server;
  let baseUrl: string;
  let handled = 0;

  beforeAll(async () => {
    const readiness = createReadiness({
      query: () => {
        handled += 1;
        return Promise.resolve({});
      },
    });
    server = createGrpcServer({ routes: healthRoutes(readiness) });
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await closeHard(server);
  });

  const handledDuring = async (fn: () => Promise<unknown>): Promise<number> => {
    const before = handled;
    await fn();
    return handled - before;
  };

  it('declares gRPC on and both other protocols off', () => {
    expect(GRPC_PROTOCOLS).toEqual({ grpc: true, grpcWeb: false, connect: false });
  });

  it('serves a real gRPC call', async () => {
    const client = createClient(Health, createGrpcTransport({ baseUrl }));
    let status: HealthCheckResponse_ServingStatus | undefined;
    const ran = await handledDuring(async () => {
      status = (await client.check({ service: '' })).status;
    });
    expect(status).toBe(HealthCheckResponse_ServingStatus.SERVING);
    expect(ran).toBe(1);
  });

  it('serves a hand-framed gRPC request with the bare application/grpc content type', async () => {
    const body = grpcFrame(toBinary(HealthCheckRequestSchema, create(HealthCheckRequestSchema, { service: '' })));
    const res = await h2Request(baseUrl, { ':method': 'POST', ':path': CHECK_PATH, 'content-type': 'application/grpc', te: 'trailers' }, body);
    expect(res.status).toBe(200);
    expect(res.trailers['grpc-status']).toBe('0');
  });

  it('refuses a Connect-protocol client (binary)', async () => {
    const client = createClient(Health, createConnectTransport({ baseUrl, httpVersion: '2' }));
    const ran = await handledDuring(async () => {
      const error = await client.check({ service: '' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConnectError);
    });
    expect(ran).toBe(0);
  });

  it('refuses a Connect-protocol client (JSON)', async () => {
    const client = createClient(Health, createConnectTransport({ baseUrl, httpVersion: '2', useBinaryFormat: false }));
    const ran = await handledDuring(async () => {
      await expect(client.check({ service: '' })).rejects.toBeInstanceOf(ConnectError);
    });
    expect(ran).toBe(0);
  });

  it('refuses a gRPC-Web client', async () => {
    const client = createClient(Health, createGrpcWebTransport({ baseUrl, httpVersion: '2' }));
    const ran = await handledDuring(async () => {
      await expect(client.check({ service: '' })).rejects.toBeInstanceOf(ConnectError);
    });
    expect(ran).toBe(0);
  });

  it.each([
    ['application/json', '{"service":""}'],
    ['application/proto', ''],
    ['application/connect+json', '{}'],
    ['application/connect+proto', ''],
    ['application/grpc-web', ''],
    ['application/grpc-web+proto', ''],
    ['application/grpc-web-text', ''],
    ['application/grpc-web+json', ''],
    ['text/plain', 'hello'],
  ])('answers a raw POST of %s with 415 and no gRPC success', async (contentType, body) => {
    const ran = await handledDuring(async () => {
      const res = await h2Request(
        baseUrl,
        { ':method': 'POST', ':path': CHECK_PATH, 'content-type': contentType, 'connect-protocol-version': '1' },
        body,
      );
      expect(res.status).toBe(415);
      expect(res.trailers['grpc-status']).toBeUndefined();
      expect(res.headers['grpc-status']).toBeUndefined();
      expect(res.body.toString()).not.toMatch(/SERVING/);
    });
    expect(ran).toBe(0);
  });

  it('refuses the Connect GET form', async () => {
    const ran = await handledDuring(async () => {
      const res = await h2Request(baseUrl, {
        ':method': 'GET',
        ':path': `${CHECK_PATH}?connect=v1&encoding=json&message=${encodeURIComponent('{"service":""}')}`,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.toString()).not.toMatch(/SERVING/);
    });
    expect(ran).toBe(0);
  });

  it('does not speak HTTP/1.1 at all (h2c prior knowledge only)', async () => {
    const ran = await handledDuring(async () => {
      await expect(http1Post(`${baseUrl}${CHECK_PATH}`, 'application/json', '{}')).rejects.toThrow();
    });
    expect(ran).toBe(0);
  });

  it('answers an unknown gRPC method with a trailers-only UNIMPLEMENTED, not a page', async () => {
    const res = await h2Request(
      baseUrl,
      { ':method': 'POST', ':path': '/nwfl.mensa.v1.NoSuchService/Get', 'content-type': 'application/grpc', te: 'trailers' },
      grpcFrame(new Uint8Array()),
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/grpc');
    expect(res.headers['grpc-status']).toBe(String(Code.Unimplemented));
    expect(res.body.length).toBe(0);
  });

  it('answers an unknown path in any other protocol, or none, with 415', async () => {
    const path = '/nwfl.mensa.v1.NoSuchService/Get';
    expect((await h2Request(baseUrl, { ':method': 'POST', ':path': path, 'content-type': 'application/json' }, '{}')).status).toBe(415);
    expect((await h2Request(baseUrl, { ':method': 'POST', ':path': path }, '{}')).status).toBe(415);
  });

  it('caps an inbound message at READ_MAX_BYTES, from the envelope header alone', async () => {
    // Only the 5-byte gRPC envelope is sent, announcing one byte over the cap.
    // The server must refuse on the announced length, before buffering a body.
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, READ_MAX_BYTES + 1);
    const ran = await handledDuring(async () => {
      const res = await h2Request(baseUrl, { ':method': 'POST', ':path': CHECK_PATH, 'content-type': 'application/grpc', te: 'trailers' }, header);
      const status = res.trailers['grpc-status'] ?? res.headers['grpc-status'];
      expect(status).toBe(String(Code.ResourceExhausted));
    });
    expect(ran).toBe(0);
  });

  it('accepts a message just under the cap', async () => {
    const client = createClient(Health, createGrpcTransport({ baseUrl }));
    await expect(client.check({ service: 'x'.repeat(READ_MAX_BYTES - 16) })).rejects.toMatchObject({ code: Code.NotFound });
  });
});
