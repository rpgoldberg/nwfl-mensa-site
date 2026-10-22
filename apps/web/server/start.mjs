// @ts-check
// Boot: load Astro's standalone handler without its own server, read the
// prerendered pages, put the site policy in front of both, listen, and drain
// on SIGTERM or SIGINT.
import { readFile, readdir } from 'node:fs/promises';
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
 * Every .html file Astro prerendered into `clientDir`, by the paths it answers:
 * `about.html` is /about and /about.html, `index.html` is / and /index.html.
 *
 * @param {URL} clientDir
 * @returns {Promise<Map<string, string>>}
 */
export async function loadPrerendered(clientDir) {
  /** @type {Map<string, string>} */
  const pages = new Map();
  /** @type {string[]} */
  let files;
  try {
    files = await readdir(clientDir, { recursive: true });
  } catch {
    return pages;
  }
  for (const file of files.filter((f) => f.endsWith('.html'))) {
    const html = await readFile(new URL(file, clientDir), 'utf8');
    const path = `/${file}`;
    const clean = path.replace(/(?:\/index)?\.html$/, '') || '/';
    pages.set(clean, html);
    pages.set(path, html);
  }
  return pages;
}

/**
 * @param {{
 *   env: Env,
 *   loadHandler: () => Promise<{ handler: Handler }>,
 *   proc: Proc,
 *   clientDir?: URL,
 *   log?: (line: string) => void,
 *   graceMs?: number,
 * }} opts
 */
export async function start({ env, loadHandler, proc, clientDir, log = console.log, graceMs = 10_000 }) {
  // Astro's entry starts its own server on import unless told not to.
  env['ASTRO_NODE_AUTOSTART'] = 'disabled';
  const { handler } = await loadHandler();
  const { port, host } = listenOptions(env);
  const pages = clientDir ? await loadPrerendered(clientDir) : new Map();
  const server = createSiteServer(handler, { pages });
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
