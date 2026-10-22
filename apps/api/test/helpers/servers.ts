import type http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

const sessionsOf = new WeakMap<http2.Http2Server, Set<http2.ServerHttp2Session>>();

/** Listen on an ephemeral loopback port and remember every session, so the test can tear down hard. */
export async function listen(server: http2.Http2Server): Promise<string> {
  const sessions = new Set<http2.ServerHttp2Session>();
  sessionsOf.set(server, sessions);
  server.on('session', (session: http2.ServerHttp2Session) => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Close a test server now. Connect clients keep idle sessions open, and a test has nothing to drain. */
export function closeHard(server: http2.Http2Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    for (const session of sessionsOf.get(server) ?? []) session.destroy();
  });
}

export function captureLogs(): { lines: Record<string, unknown>[]; sink: (line: string) => void } {
  const lines: Record<string, unknown>[] = [];
  return { lines, sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) };
}
