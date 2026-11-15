// LG-N3: every API client sends the request's W3C traceparent on each call made while serving it,
// and every client's production log callback writes stamped JSON lines.
import { connectNodeAdapter } from '@connectrpc/connect-node';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTrace, runWithTrace, traceparent } from '../../../server/trace.mjs';
import { grpcReads } from './client';
import { grpcEditor } from './editor';
import { grpcMembership } from './membership';
import { grpcOfficer } from './officer';
import { grpcOfficerEvents } from './officer-events';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A gRPC server with no services: every call is answered Unimplemented, and its headers are kept. */
async function headersServer(): Promise<{ url: string; seen: http2.IncomingHttpHeaders[] }> {
  const seen: http2.IncomingHttpHeaders[] = [];
  const adapter = connectNodeAdapter({ routes: () => {}, grpc: true, grpcWeb: false, connect: false });
  const sessions = new Set<http2.ServerHttp2Session>();
  const server = http2.createServer((req, res) => {
    seen.push({ ...req.headers });
    void adapter(req, res);
  });
  server.on('session', (s) => sessions.add(s));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => {
    server.close(() => resolve());
    for (const s of sessions) s.destroy();
  }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const AS = { bearer: 'reader.tok-en' };
const calls: [string, (config: { baseUrl: string; timeoutMs: number }, log: (line: string) => void) => Promise<unknown>][] = [
  ['reads', (c, log) => grpcReads(c, log).listSeries()],
  ['editor', (c, log) => grpcEditor(c, log).createItem(AS, { kind: 'news', officeId: 'o', slug: 's', title: 't' } as never)],
  ['membership', (c, log) => grpcMembership(c, log).getMyAccount(AS)],
  ['officer', (c, log) => grpcOfficer(c, log).getApprovalRules(AS)],
  ['officer events', (c, log) => grpcOfficerEvents(c, log).occurrences(AS, '2026-01-01', '2026-01-31')],
];

describe.each(calls)('the %s client', (_name, call) => {
  it('sends the request’s traceparent on a call made while serving it, and none outside one', async () => {
    const { url, seen } = await headersServer();
    const config = { baseUrl: url, timeoutMs: 2000 };
    const trace = newTrace();
    await runWithTrace(trace, () => call(config, () => {}).catch(() => {}));
    await call(config, () => {}).catch(() => {});
    expect(seen).toHaveLength(2);
    expect(seen[0]?.['traceparent']).toBe(traceparent(trace));
    expect(seen[1]?.['traceparent']).toBeUndefined();
  });
});

describe('the clients’ production log callbacks', () => {
  it('write stamped JSON lines (time, service) to stderr', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { apiLog } = await import('../../../server/log.mjs');
      apiLog(JSON.stringify({ level: 'error', msg: 'api call failed', rpc: 'x' }));
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({ level: 'error', msg: 'api call failed', rpc: 'x', service: 'nwfl-web', time: expect.any(String) });
    } finally {
      error.mockRestore();
    }
  });

  it('are the one stamped callback in every client module', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['../../data/index.ts', './editor.ts', './membership.ts', './officer.ts', './officer-events.ts']) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toMatch(/log: apiLog\b/);
      expect(source, file).not.toMatch(/console\.(log|error|warn)/);
    }
  });
});
