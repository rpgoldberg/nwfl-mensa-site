// EDITOR E1, rewritten for EDITOR A1: the authorization matrix of the publishing workflow. Every workflow
// RPC, and PreviewWorkingItem, called by every made-up persona, each on an item freshly brought to the
// state the RPC needs (so "allow" means the call went through), and the answer compared with the table:
// allow, UNAUTHENTICATED, PERMISSION_DENIED or NOT_FOUND. A write that a non-officer cannot see the item
// for is NOT_FOUND (loadItemAs), so the answer gives nothing away. A1: every officer (and the Admin and
// the Webmaster) reviews: approves or sends back, the item's own writer too for a send-back but never
// for an approval; only the Webmaster, or the Admin as backup, publishes; an affiliate does neither; a
// token naming a system subject is refused everywhere. The rows "on cleared" act on a version approved
// and waiting to be published.
import { type Client, Code, ConnectError } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { type Api, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const PERSONAS = ['anonymous', 'member', 'officer', 'pub', 'treasurer', 'admin', 'lone-admin', 'webmaster', 'stray-admin', 'agent', 'lone-webmaster', 'affiliate', 'system'] as const;
type Persona = (typeof PERSONAS)[number];
const options = (persona: Persona): { headers?: Record<string, string> } => (persona === 'anonymous' ? {} : as(`${persona}-token`));

const A = 'allow';
const U = Code.Unauthenticated;
const D = Code.PermissionDenied;
const N = Code.NotFound;
type Outcome = typeof A | Code;

// One row per case, one column per persona, in the order of PERSONAS. A case is its RPC, then what it acts on.
//                                    anon member officer pub treasurer admin lone-admin webmaster stray agent lone-webmaster affiliate system
const TABLE: Record<string, Outcome[]> = {
  CreateItem: /*                    */ [U, D, D, A, D, A, A, D, D, D, D, D, U],
  SaveDraft: /*                     */ [U, N, D, A, D, A, A, D, D, D, D, N, U],
  'SaveDraft on cleared': /*        */ [U, N, D, A, D, A, A, D, D, D, D, N, U],
  MarkReady: /*                     */ [U, N, D, A, D, A, A, D, D, D, D, N, U],
  SendBack: /*                      */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  'SendBack on cleared': /*         */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  Approve: /*                       */ [U, D, A, D, A, A, A, A, A, D, A, D, U],
  Publish: /*                       */ [U, D, D, D, D, A, A, A, D, D, A, D, U],
  Withdraw: /*                      */ [U, N, D, A, D, A, A, A, D, D, A, N, U],
  'Withdraw with cleared': /*       */ [U, N, D, A, D, A, A, A, D, D, A, N, U],
  Restore: /*                       */ [U, N, D, A, D, A, A, D, D, D, D, N, U],
  ListWorkingItems: /*              */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  GetWorkingItem: /*                */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  ListItemHistory: /*               */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  PreviewWorkingItem: /*            */ [U, D, A, A, A, A, A, A, A, D, A, D, U],
  // EDITOR A3b: the links are read by a reviewer or the item's own office; answered by a reviewer who did not edit it.
  GetItemLinks: /*                  */ [U, N, A, A, A, A, A, A, A, D, A, N, U],
  ConfirmLinks: /*                  */ [U, D, A, D, A, A, A, A, A, D, A, D, U],
};
const rpcOf = (name: string): string => name.split(' ')[0] as string;

describe.skipIf(!live)('EDITOR E1: the workflow authorization matrix', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let office: string;
  let n = 0;

  beforeAll(async () => {
    api = await startApi('nwfl_authz_matrix');
    content = api.client(ContentService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
  });

  afterAll(async () => {
    await api?.close();
  });

  const PUB = as('pub-token');
  const TREASURER = as('treasurer-token');
  const WEBMASTER = as('webmaster-token');
  const slug = (): string => `matrix-${(n += 1)}`;
  /** An item in the state each RPC needs, written by the Publications Officer, approved by the Treasurer, published by the Webmaster. */
  const draft = async (): Promise<string> => {
    const created = await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: slug(), title: 'Fall picnic' }, PUB);
    const itemId = created.item?.id as string;
    await content.saveDraft({ itemId, title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Noon at the pier.' }, PUB);
    return itemId;
  };
  const ready = async (): Promise<{ itemId: string; hash: Uint8Array }> => {
    const itemId = await draft();
    const marked = await content.markReady({ itemId }, PUB);
    return { itemId, hash: marked.item?.working?.contentHash as Uint8Array };
  };
  const cleared = async (): Promise<{ itemId: string; hash: Uint8Array }> => {
    const made = await ready();
    await content.approve({ itemId: made.itemId, contentHash: made.hash }, TREASURER);
    return made;
  };
  const published = async (): Promise<string> => {
    const { itemId, hash } = await cleared();
    await content.publish({ itemId, contentHash: hash }, WEBMASTER);
    return itemId;
  };
  /** A published item whose revision is approved and waiting to be published. */
  const revisionCleared = async (): Promise<string> => {
    const itemId = await published();
    await content.saveDraft({ itemId, title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Noon at the pier, with chairs.' }, PUB);
    const hash = (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId, contentHash: hash }, TREASURER);
    return itemId;
  };
  const withdrawn = async (): Promise<string> => {
    const itemId = await published();
    await content.withdraw({ itemId }, PUB);
    return itemId;
  };

  const CALLS: Record<string, (who: ReturnType<typeof options>) => Promise<unknown>> = {
    CreateItem: (who) => content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: slug(), title: 'Fall picnic' }, who),
    SaveDraft: async (who) => content.saveDraft({ itemId: await draft(), title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Changed.' }, who),
    'SaveDraft on cleared': async (who) =>
      content.saveDraft({ itemId: (await cleared()).itemId, title: 'Fall picnic', summary: '', visibility: ItemVisibility.PUBLIC, bodyMarkup: 'Changed.' }, who),
    MarkReady: async (who) => content.markReady({ itemId: await draft() }, who),
    SendBack: async (who) => content.sendBack({ itemId: (await ready()).itemId, note: 'The time is wrong.' }, who),
    'SendBack on cleared': async (who) => content.sendBack({ itemId: (await cleared()).itemId, note: 'The time is wrong.' }, who),
    Approve: async (who) => {
      const { itemId, hash } = await ready();
      return content.approve({ itemId, contentHash: hash }, who);
    },
    Publish: async (who) => {
      const { itemId, hash } = await cleared();
      return content.publish({ itemId, contentHash: hash }, who);
    },
    Withdraw: async (who) => content.withdraw({ itemId: await published() }, who),
    'Withdraw with cleared': async (who) => content.withdraw({ itemId: await revisionCleared() }, who),
    Restore: async (who) => content.restore({ itemId: await withdrawn() }, who),
    ListWorkingItems: (who) => content.listWorkingItems({}, who),
    GetWorkingItem: async (who) => content.getWorkingItem({ itemId: await draft() }, who),
    ListItemHistory: async (who) => content.listItemHistory({ itemId: await draft() }, who),
    PreviewWorkingItem: async (who) => content.previewWorkingItem({ itemId: await draft() }, who),
    GetItemLinks: async (who) => content.getItemLinks({ itemId: await draft() }, who),
    ConfirmLinks: async (who) => {
      const { itemId } = await ready();
      const { linksSha256 } = await content.getItemLinks({ itemId }, as('treasurer-token'));
      return content.confirmLinks({ itemId, linksSha256, answers: [{ url: 'https://example.org/', yes: true }] }, who);
    },
  };

  it('covers every workflow RPC of ContentService, and PreviewWorkingItem', () => {
    const workflow = ContentService.methods
      .map((method) => method.name)
      .filter((name) => !['ListPublishedItems', 'GetPublishedItem', 'GetRoster', 'ListPublishedEditions', 'SaveOfficeTerm', 'SaveEdition', 'FreezeEdition', 'ReadFile', 'GetLinkTarget'].includes(name));
    expect([...new Set(Object.keys(TABLE).map(rpcOf))].sort()).toEqual(workflow.sort());
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(TABLE).sort());
    for (const row of Object.values(TABLE)) expect(row).toHaveLength(PERSONAS.length);
  });

  const word = (outcome: Outcome): string => (outcome === A ? A : Code[outcome]);
  const cells = Object.entries(TABLE).flatMap(([rpc, row]) => PERSONAS.map((persona, column) => [rpc, persona, word(row[column] as Outcome)] as const));

  it.each(cells)('%s by %s: %s', async (rpc, persona, expected) => {
    const call = CALLS[rpc] as (who: ReturnType<typeof options>) => Promise<unknown>;
    let got: Outcome;
    try {
      await call(options(persona));
      got = A;
    } catch (error) {
      got = ConnectError.from(error).code;
    }
    expect(word(got), `${rpc} by ${persona}`).toBe(expected);
  });
});
