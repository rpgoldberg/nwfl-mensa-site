// @ts-check
// A test-only TLS edge for the e2e suite, doing what Cloudflare does in
// production: it terminates TLS with a throwaway self-signed certificate made
// at start, and forwards each request to the site server over http with
// X-Forwarded-Proto: https. The browsers then apply the production cookie
// rules: a __Host- cookie needs a secure origin, and WebKit refuses one over
// http even on loopback. Never part of the image.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env['TLS_PORT'] ?? 8443);
const upstream = new URL(process.env['UPSTREAM'] ?? 'http://127.0.0.1:8087');

// The key lives only in this process: written by openssl to a private temp
// folder, read back, and the folder removed before the first request.
const dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-e2e-tls-'));
let tls;
try {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert],
    { stdio: 'ignore' },
  );
  tls = { key: readFileSync(key), cert: readFileSync(cert) };
} finally {
  rmSync(dir, { recursive: true, force: true });
}

https
  .createServer(tls, (req, res) => {
    const forward = http.request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, 'x-forwarded-proto': 'https' },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.rawHeaders);
        answer.pipe(res);
      },
    );
    forward.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  })
  .listen(port, '127.0.0.1');
