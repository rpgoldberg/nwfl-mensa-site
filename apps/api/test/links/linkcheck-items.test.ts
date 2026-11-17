// L-ITEM item 4: the link checker's items mode (apps/linkcheck/src/items.ts), its own gRPC client and
// hand-written messages, against the REAL API server code (the production routes and caller gate over a
// migrated database) with a stand-in token. The check itself is a stand-in here (no network in a test);
// apps/linkcheck's own suite runs check.ts. Also the contract: the hand-written messages are the API's
// generated ones byte for byte. Every person, place and address here is made up.
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { Client } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CheckVerdict,
  MACHINE,
  MAX_RECORD_BYTES,
  decodeListResponse,
  decodeRecordResponse,
  encodeRecordRequest,
  grpcCall,
  recordRequests,
  runItems,
} from '../../../linkcheck/src/items.js';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, MachineVerdict, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { ListLinksAwaitingVerdictResponseSchema, RecordLinkVerdictsRequestSchema, RecordLinkVerdictsResponseSchema } from '../../src/gen/nwfl/mensa/v1/link_check_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { MAX_AWAITING_BYTES } from '../../src/content/link-check.js';
import { READ_MAX_BYTES } from '../../src/grpc/server.js';
import { live } from '../helpers/pg.js';

const PUB = as('pub-token');
const TREASURER = as('treasurer-token');
const FACEBOOK = 'https://www.facebook.com/groups/example-chess';

describe("the items mode's messages are the API's", () => {
  it('names the verdicts as the API numbers them', () => {
    expect(MACHINE).toEqual({ OK: MachineVerdict.OK, CONFIRM: MachineVerdict.CONFIRM, DROP: MachineVerdict.DROP });
  });

  it('writes RecordLinkVerdictsRequest as the generated code does', () => {
    const verdicts = [
      { url: 'https://a.example.org/', verdict: MACHINE.OK, reasons: [] },
      { url: `https://b.example.org/${'x'.repeat(300)}`, verdict: MACHINE.DROP, reasons: ['dead', 'nxdomain'] },
      { url: 'mailto:c@example.org', verdict: MACHINE.CONFIRM, reasons: ['no-mail'] },
    ];
    const ours = encodeRecordRequest(verdicts);
    expect(ours).toEqual(toBinary(RecordLinkVerdictsRequestSchema, create(RecordLinkVerdictsRequestSchema, { verdicts })));
    expect(fromBinary(RecordLinkVerdictsRequestSchema, ours).verdicts.map((v) => [v.url, v.verdict, v.reasons])).toEqual(verdicts.map((v) => [v.url, v.verdict, v.reasons]));
  });

  it('reads the answers the generated code writes', () => {
    const urls = ['https://a.example.org/', `https://b.example.org/${'é'.repeat(500)}`];
    expect(decodeListResponse(toBinary(ListLinksAwaitingVerdictResponseSchema, create(ListLinksAwaitingVerdictResponseSchema, { urls, more: true })))).toEqual({ urls, more: true });
    expect(decodeRecordResponse(toBinary(RecordLinkVerdictsResponseSchema, create(RecordLinkVerdictsResponseSchema, { recorded: 70000, notAwaiting: urls })))).toEqual({
      recorded: 70000,
      notAwaiting: urls,
    });
  });
});

describe.skipIf(!live)('the items mode against the real API server', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let office: string;
  let n = 0;

  const piece = async (body: string) => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `li-${(n += 1)}`, title: 'Chess night' }, PUB)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Chess night', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: body }, PUB);
    const ready = await content.markReady({ itemId: item.id }, PUB);
    return { itemId: item.id, hash: ready.item?.working?.contentHash as Uint8Array };
  };
  /** The check, stood in: these verdicts by address, else ok; the addresses it was given are kept. */
  const seen: string[][] = [];
  const check = (verdicts: Record<string, CheckVerdict>) => (urls: readonly string[]) => {
    seen.push([...urls]);
    return Promise.resolve(urls.map((url) => ({ url, verdict: verdicts[url] ?? ('ok' as const), reasons: verdicts[url] === 'drop' ? ['dead'] : verdicts[url] === 'confirm' ? ['login-walled'] : [] })));
  };

  beforeAll(async () => {
    api = await startApi('nwfl_linkcheck_items');
    content = api.client(ContentService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('lists, checks and records through the real service, and the gate then reads its verdicts', async () => {
    const { itemId, hash } = await piece(`Play at https://club.example.org/chess, see [the old page](https://gone.example.org/), or [our group](${FACEBOOK}).`);
    const totals = await runItems({ api: new URL(api.baseUrl), token: 'linkcheck-token', check: check({ 'https://gone.example.org/': 'drop', [FACEBOOK]: 'confirm' }) });
    expect(totals).toEqual({ checked: 3, ok: 1, confirm: 1, drop: 1, recorded: 3, notAwaiting: 0, more: false });
    expect(seen.at(-1)).toEqual(['https://club.example.org/chess', 'https://gone.example.org/', FACEBOOK]);
    const links = (await content.getItemLinks({ itemId }, TREASURER)).links;
    expect(links.map((l) => [l.url, l.machineVerdict, l.reasons, l.accepted])).toEqual([
      ['https://club.example.org/chess', MachineVerdict.OK, [], true],
      ['https://gone.example.org/', MachineVerdict.DROP, ['dead'], false],
      [FACEBOOK, MachineVerdict.CONFIRM, ['login-walled'], false],
    ]);
    // A second run has nothing to do for a day.
    expect(await runItems({ api: new URL(api.baseUrl), token: 'linkcheck-token', check: check({}) })).toMatchObject({ checked: 0, recorded: 0 });
    // A reviewer does the rest: a yes on the sign-in link, and a yes with a note over the DROP.
    const { linksSha256 } = await content.getItemLinks({ itemId }, TREASURER);
    await content.confirmLinks({ itemId, linksSha256, answers: [{ url: FACEBOOK, yes: true }, { url: 'https://gone.example.org/', yes: true, note: 'It moved; the old address still forwards.' }] }, TREASURER);
    expect((await content.approve({ itemId, contentHash: hash }, TREASURER)).item?.working?.status).toBe(VersionStatus.CLEARED);
  });

  it('is refused with any other token, in plain words, and records nothing', async () => {
    const { itemId } = await piece('See https://refused.example.org/.');
    for (const [token, code] of [
      ['agent-token', 'PERMISSION_DENIED'],
      ['treasurer-token', 'PERMISSION_DENIED'],
      ['no-such-token', 'UNAUTHENTICATED'],
    ] as const) {
      await expect(runItems({ api: new URL(api.baseUrl), token, check: check({}) })).rejects.toThrow(`the API refused the call: ${code}`);
    }
    expect((await api.pool.query(`SELECT 1 FROM content_link_check WHERE item_id = $1`, [itemId])).rows).toEqual([]);
  });
});

// Fix round 1 (GATE-1): 155 addresses, 154 of them about 2 KB, are more than one message the API reads
// (READ_MAX_BYTES). The list is capped by bytes and the run records in requests under MAX_RECORD_BYTES,
// so the short address that sorts last gets its verdict on the first run.
describe.skipIf(!live)('long addresses against the real API server', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let office: string;
  let n = 0;
  const bytesOf = (urls: readonly string[]): number => urls.reduce((sum, url) => sum + Buffer.byteLength(url), 0);
  const piece = async (body: string) => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `ll-${(n += 1)}`, title: 'Long' }, PUB)).item as ContentItem;
    await content.saveDraft({ itemId: item.id, title: 'Long', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: body }, PUB);
    await content.markReady({ itemId: item.id }, PUB);
    return item.id;
  };
  const machineRows = async (itemId: string) => (await api.pool.query<{ url: string; answer: string }>(`SELECT url, answer FROM content_link_check WHERE item_id = $1 AND source = 'machine' ORDER BY id`, [itemId])).rows;

  beforeAll(async () => {
    api = await startApi('nwfl_linkcheck_long');
    content = api.client(ContentService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('hands out and records one address of 2,048 characters', async () => {
    const longest = `https://one.example.org/${'q'.repeat(2048 - 'https://one.example.org/'.length)}`;
    expect(longest).toHaveLength(2048);
    const itemId = await piece(`See ${longest} now.`);
    const lists: string[][] = [];
    const totals = await runItems({
      api: new URL(api.baseUrl),
      token: 'linkcheck-token',
      check: (urls) => {
        lists.push([...urls]);
        return Promise.resolve(urls.map((url) => ({ url, verdict: 'ok' as const, reasons: [] })));
      },
    });
    expect(lists).toEqual([[longest]]);
    expect(totals).toEqual({ checked: 1, ok: 1, confirm: 0, drop: 0, recorded: 1, notAwaiting: 0, more: false });
    expect(await machineRows(itemId)).toEqual([{ url: longest, answer: 'ok' }]);
  });

  it('gives every address a verdict on the first run, the short one that sorts last included', async () => {
    const victim = await piece('Lunch at https://zz-lunch.example.org/menu.');
    const long: string[] = [];
    for (let p = 0; p < 7; p += 1) {
      const urls = Array.from({ length: 22 }, (_, i) => `https://a${p}.example.org/${String(i).padStart(3, '0')}${'q'.repeat(2000)}`);
      long.push(...urls);
      await piece(urls.join(' '));
    }
    // Together they are more than one message the API reads.
    expect(bytesOf(long)).toBeGreaterThan(READ_MAX_BYTES);
    const lists: string[][] = [];
    const totals = await runItems({
      api: new URL(api.baseUrl),
      token: 'linkcheck-token',
      check: (urls) => {
        lists.push([...urls]);
        return Promise.resolve(urls.map((url) => ({ url, verdict: 'ok' as const, reasons: [] })));
      },
    });
    expect(totals).toEqual({ checked: 155, ok: 155, confirm: 0, drop: 0, recorded: 155, notAwaiting: 0, more: false });
    expect(await machineRows(victim)).toEqual([{ url: 'https://zz-lunch.example.org/menu', answer: 'ok' }]);
    // Each list is under the byte cap, in order, and none is handed out twice.
    expect(lists.length).toBeGreaterThan(1);
    for (const urls of lists) expect(bytesOf(urls)).toBeLessThanOrEqual(MAX_AWAITING_BYTES);
    expect(lists.flat()).toEqual([...long, 'https://zz-lunch.example.org/menu']);
    // Each list handed out is audited with its own count, and says whether more wait.
    const audits = (await api.pool.query<{ payload: { urls: number; more: boolean } }>(`SELECT payload FROM audit_event WHERE action = 'links_read' ORDER BY id`)).rows.slice(-lists.length);
    expect(audits.map((row) => [row.payload.urls, row.payload.more])).toEqual(lists.map((urls, i) => [urls.length, i < lists.length - 1]));
  });

  it('the largest request the run writes is one the API reads; a message over the API limit is refused', async () => {
    // Not waiting anywhere, so nothing is kept: only the size is under test. CONFIRM, since the last address is
    // over 2048 and an OK on an address nobody can read is refused (fix round 2); the bytes are the same.
    const verdict = (i: number, length: number) => ({ url: `https://n${String(i).padStart(3, '0')}.example.org/${'x'.repeat(length)}`, verdict: MACHINE.CONFIRM, reasons: [] });
    const one = encodeRecordRequest([verdict(0, 1960)]).length;
    const count = Math.floor(MAX_RECORD_BYTES / one);
    const verdicts = Array.from({ length: count }, (_, i) => verdict(i, 1960));
    // The last one is stretched so the whole request is the cap exactly.
    verdicts[count - 1] = verdict(count - 1, 1960 + MAX_RECORD_BYTES - count * one);
    const requests = recordRequests(verdicts);
    expect(requests.map((r) => r.length)).toEqual([MAX_RECORD_BYTES]);
    const reply = decodeRecordResponse(await grpcCall(new URL(api.baseUrl), 'RecordLinkVerdicts', 'linkcheck-token', requests[0] as Uint8Array));
    expect(reply).toEqual({ recorded: 0, notAwaiting: verdicts.map((v) => v.url) });
    expect(MAX_RECORD_BYTES).toBeLessThan(READ_MAX_BYTES);
    const tooBig = encodeRecordRequest(Array.from({ length: 140 }, (_, i) => verdict(i, 1960)));
    expect(tooBig.length).toBeGreaterThan(READ_MAX_BYTES);
    await expect(grpcCall(new URL(api.baseUrl), 'RecordLinkVerdicts', 'linkcheck-token', tooBig)).rejects.toThrow('the API refused the call: RESOURCE_EXHAUSTED');
  });
});
