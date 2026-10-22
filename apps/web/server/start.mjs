// @ts-check
// Boot: load Astro's standalone handler without its own server, put the site
// policy in front of it, listen, and drain on SIGTERM or SIGINT.
import { createSiteServer } from './siteServer.mjs';

/** @typedef {Record<string, string | undefined>} Env */
/** @typedef {import('./siteServer.mjs').Handler} Handler */
/** @typedef {{ once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown, exit(code: number): void }} Proc */

/**
 * @param {Env} env
 * @returns {{ port: number, host: string }}
 */
export function listenOptions(env) {
  const raw = env['PORT'] ?? '8080';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) throw new Error(`PORT must be a port number, got "${raw}"`);
  return { port, host: env['HOST'] ?? '0.0.0.0' };
}

/**
 * @param {{
 *   env: Env,
 *   loadHandler: () => Promise<{ handler: Handler }>,
 *   proc: Proc,
 *   log?: (line: string) => void,
 *   graceMs?: number,
 * }} opts
 */
export async function start({ env, loadHandler, proc, log = console.log, graceMs = 10_000 }) {
  // Astro's entry starts its own server on import unless told not to.
  env['ASTRO_NODE_AUTOSTART'] = 'disabled';
  const { handler } = await loadHandler();
  const { port, host } = listenOptions(env);
  const server = createSiteServer(handler);
  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  log(JSON.stringify({ level: 'info', msg: 'listening', host, port: address.port }));

  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    proc.once(signal, () => {
      server.close(() => proc.exit(0));
      // Keep-alive sockets would hold close() open; the mesh drains first anyway.
      server.closeIdleConnections();
      setTimeout(() => proc.exit(0), graceMs).unref();
    });
  }
  return server;
}
