// EDITOR E2: the e2e stand-in API (e2e/api.mjs) serves the publishing workflow (e2e/workflow.mjs) to a
// verified token, as the screen units' e2e runs will use it: started as Playwright starts it, with a
// signing key of the test's own standing in for the test identity provider's, and driven by the site's
// own editor client. Its seeds read as e2e/stand-in.ts says, and the officer-area RPCs it served before
// answer as before.
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKFLOW } from '../e2e/stand-in';
import { ApprovalRuleService } from '../src/gen/nwfl/mensa/v1/approval_pb.js';
import { createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { NotAllowed, SignInAgain, grpcEditor } from '../src/lib/api/editor';
import { editFormFor } from '../src/lib/editor/form';
import { statusOf } from '../src/lib/editor/status';

const OFFICER = { sub: '00000000-0000-4000-8000-0000000000a1', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] };
const WEBMASTER = { sub: '00000000-0000-4000-8000-0000000000eb', groups: ['nwfl-members', 'nwfl-officers', 'nwfl-webmaster'] };
const MEMBER = { sub: '00000000-0000-4000-8000-0000000000b2', groups: ['nwfl-members'] };

let child: ChildProcess | undefined;
let jwksServer: http.Server | undefined;
let apiUrl = '';
let token: (person: { sub: string; groups: string[] }) => Promise<string>;

/** A port nothing listens on just now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listening(port: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nothing listening on ${port}`);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer!.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}`;
  token = (person) =>
    new SignJWT({ groups: person.groups }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(person.sub).setIssuer(issuer).setAudience('nwfl-site').setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const [port, silent, noIssues] = [await freePort(), await freePort(), await freePort()];
  child = spawn(process.execPath, ['e2e/api.mjs'], {
    env: { PATH: process.env['PATH'], API_PORT: String(port), SILENT_API_PORT: String(silent), NO_ISSUES_API_PORT: String(noIssues), IDP_ISSUER: issuer, IDP_JWKS_URL: `${issuer}/jwks` },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  apiUrl = `http://127.0.0.1:${port}`;
  await listening(port, Date.now() + 15_000);
}, 30_000);

afterAll(async () => {
  // Only the stand-in this test started, by its own handle.
  child?.kill();
  await new Promise<void>((resolve) => (jwksServer ? jwksServer.close(() => resolve()) : resolve()));
});

describe('the stand-in API serves the publishing workflow', () => {
  it('reads its seeds as e2e/stand-in.ts describes them', async () => {
    const api = grpcEditor({ baseUrl: apiUrl, timeoutMs: 5000 }, () => {});
    const as = { bearer: await token(OFFICER) };
    const withheld = await api.getWorkingItem(as, WORKFLOW.withheld.id);
    expect(withheld.working).toMatchObject({ title: WORKFLOW.withheld.title, markup: '', markupWithheld: true });
    expect(editFormFor(withheld)).toMatchObject({ ok: false, reason: 'withheld' });
    expect(JSON.stringify(withheld)).not.toContain(WORKFLOW.withheld.canary);
    const waiting = await api.getWorkingItem(as, WORKFLOW.waiting.id);
    expect(statusOf(waiting).label).toBe('Waiting for approval');
    expect(waiting.working?.title).toBe(WORKFLOW.waiting.title);
    const preview = await api.previewWorkingItem(as, WORKFLOW.waiting.id);
    expect(JSON.stringify(preview.publicBody)).not.toContain(WORKFLOW.waiting.membersPassage);
    expect(JSON.stringify(preview.membersBody)).toContain(WORKFLOW.waiting.membersPassage);
    const published = await api.getWorkingItem(as, WORKFLOW.published.id);
    expect(statusOf(published).label).toBe('Published');
    expect(published.live?.title).toBe(WORKFLOW.published.title);
  });

  it('takes an item from a draft to published between two people, by verified tokens only', async () => {
    const api = grpcEditor({ baseUrl: apiUrl, timeoutMs: 5000 }, () => {});
    const writer = { bearer: await token(OFFICER) };
    const approver = { bearer: await token(WEBMASTER) };
    const item = await api.createItem(writer, { kind: 'announcement', officeId: '11111111-1111-4111-8111-111111111111', slug: `stand-in-api-${Date.now()}`, title: 'Over the stand-in' });
    await api.saveDraft(writer, { itemId: item.id, title: 'Over the stand-in', summary: '', visibility: 'public', markup: 'Hello.' });
    const ready = await api.markReady(writer, { itemId: item.id, targets: { website: true, newsletter: false, email: false } });
    const published = await api.approve(approver, { itemId: item.id, contentHash: ready.working!.contentHash });
    expect(statusOf(published).label).toBe('Published');
    await expect(api.listWorkingItems({ bearer: await token(MEMBER) })).rejects.toBeInstanceOf(NotAllowed);
    await expect(api.listWorkingItems({ bearer: 'not.a-token' })).rejects.toBeInstanceOf(SignInAgain);
  });

  it('still answers the approval rule to an officer as before', async () => {
    const rules = createClient(ApprovalRuleService, createGrpcTransport({ baseUrl: apiUrl }));
    const answer = await rules.getApprovalRules({}, { headers: { authorization: `Bearer ${await token(OFFICER)}` } });
    expect(answer.settings).toHaveLength(2);
  });
});
