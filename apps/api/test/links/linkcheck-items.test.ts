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
  decodeListResponse,
  decodeRecordResponse,
  encodeRecordRequest,
  runItems,
} from '../../../linkcheck/src/items.js';
import { ContentKind, ContentService, type ContentItem, ItemVisibility, MachineVerdict, VersionStatus } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { ListLinksAwaitingVerdictResponseSchema, RecordLinkVerdictsRequestSchema, RecordLinkVerdictsResponseSchema } from '../../src/gen/nwfl/mensa/v1/link_check_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
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
