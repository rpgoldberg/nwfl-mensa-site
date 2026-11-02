// A throwaway self-signed certificate for the test identity provider on
// 127.0.0.1 (A14): the API takes an https issuer only. Made once, in
// Playwright's main process, by openssl in a private temp folder. The key and
// certificate go to the provider in its environment; the certificate stays in
// the folder for NODE_EXTRA_CA_CERTS (the API and the site trust it), and the
// folder is removed when the run ends. Never part of the image.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface IdpCertificate {
  key: string;
  cert: string;
  /** The certificate's file, for NODE_EXTRA_CA_CERTS. */
  caFile: string;
}

export function idpCertificate(): IdpCertificate {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-redact-idp-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
    { stdio: 'ignore' },
  );
  const out = { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8'), caFile: cert };
  rmSync(key);
  return out;
}
