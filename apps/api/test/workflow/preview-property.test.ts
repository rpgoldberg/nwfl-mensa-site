// EDITOR E1, the preview property: for any body, visibility and marks, the PreviewWorkingItem
// bodies taken BEFORE approval are exactly what the published reads give AFTER it: public_body is
// the anonymous GetPublishedItem body, members_body the member's, and an unset body means that
// audience is answered NOT_FOUND. Bodies are drawn from the markup allow-list by a seeded generator
// (the seed is in the test name, so a failure replays). Made-up text only.
import { type Client, Code } from '@connectrpc/connect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService, type Document, ItemVisibility } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import {
  MarkField,
  MarkSubjectKind,
  RedactionAction,
  RedactionAudience,
  RedactionCategory,
  RedactionPolicyService,
} from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { type Api, MEMBER, OFFICER, as, insertId, startApi } from '../helpers/api.js';
import { live } from '../helpers/pg.js';

const SEED = 0x5eed_e1;
const RUNS = 48;
const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');

/** mulberry32: a small seeded generator, so every run draws the same cases. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  markup: string;
  visibility: 'public' | 'members' | 'officers';
  marks: Array<{ quote: string; category: RedactionCategory }>;
}

const WORDS = ['picnic', 'noon', 'pier', 'potluck', 'puzzle', 'games', 'coffee', 'speaker', 'library', 'bring', 'a', 'dish', 'and', 'the'];
const PHONE = '850-555-0163';
const EMAIL = 'host@example.org';
const NAME = 'Robin Sample';
const ADDRESS = '12 Example Lane';

function draw(random: () => number): Case {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const words = (count: number): string => Array.from({ length: count }, () => pick(WORDS)).join(' ');
  const marks: Case['marks'] = [];
  const secret = (): string => {
    const [quote, category] = pick([
      [PHONE, RedactionCategory.MEMBER_PHONE],
      [EMAIL, RedactionCategory.MEMBER_EMAIL],
      [NAME, RedactionCategory.MEMBER_NAME],
      [ADDRESS, RedactionCategory.MEMBER_ADDRESS],
    ] as const);
    if (random() < 0.7 && !marks.some((mark) => mark.quote === quote)) marks.push({ quote, category });
    return quote;
  };
  const inline = (): string =>
    pick([
      () => words(3),
      () => `**${words(2)}**`,
      () => `*${words(2)}*`,
      () => `[${words(2)}](https://example.org/${pick(WORDS)})`,
      () => `:members[${words(2)}]`,
      () => `:members[${secret()}]`,
      () => secret(),
    ])();
  const line = (): string => Array.from({ length: 1 + Math.floor(random() * 3) }, inline).join(' ');
  const block = (): string =>
    pick([
      () => line(),
      () => `# ${words(2)}`,
      () => `## ${words(3)}`,
      () => `- ${line()}\n- ${line()}`,
      () => `1. ${line()}\n2. ${line()}`,
      () => `> ${line()}`,
      () => `::: members\n${line()}\n:::`,
    ])();
  const markup = Array.from({ length: 1 + Math.floor(random() * 4) }, block).join('\n\n');
  const visibility = pick(['public', 'public', 'public', 'members', 'officers'] as const);
  return { markup, visibility, marks };
}

const cases = (() => {
  const random = generator(SEED);
  return Array.from({ length: RUNS }, (_, run) => [run, draw(random)] as const);
})();

describe.skipIf(!live)(`EDITOR E1: the preview equals the published reads (seed ${SEED.toString(16)}, ${RUNS} runs)`, () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let policy: Client<typeof RedactionPolicyService>;
  let office: string;

  beforeAll(async () => {
    api = await startApi('nwfl_preview_property');
    content = api.client(ContentService);
    policy = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    // The public's lens HIDES an item with a marked email, and REDACTS a marked name (0022 shows names),
    // so hidden, redacted and shown all occur; members redact an address (0012).
    for (const [category, action] of [
      [RedactionCategory.MEMBER_EMAIL, RedactionAction.HIDE],
      [RedactionCategory.MEMBER_NAME, RedactionAction.REDACT],
    ] as const) {
      await policy.proposeRedactionChange({ audience: RedactionAudience.PUBLIC, category, action }, OFFICER);
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  /** A published read's body, or undefined when that audience is told NOT_FOUND. */
  const published = async (itemId: string, options: { headers?: Record<string, string> }): Promise<Document | undefined> => {
    try {
      return (await content.getPublishedItem({ slug: itemId }, options)).item?.live?.body;
    } catch (error) {
      expect(error).toMatchObject({ code: Code.NotFound });
      return undefined;
    }
  };

  it.each(cases)('run %i', async (run, drawn) => {
    const created = await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug: `property-${run}`, title: 'Fall picnic' }, PUB);
    const itemId = created.item?.id as string;
    const visibility = { public: ItemVisibility.PUBLIC, members: ItemVisibility.MEMBERS, officers: ItemVisibility.OFFICERS }[drawn.visibility];
    const saved = await content.saveDraft({ itemId, title: 'Fall picnic', summary: 'Saturday', visibility, bodyMarkup: drawn.markup }, PUB);
    expect(saved.problems, drawn.markup).toEqual([]);
    for (const mark of drawn.marks) {
      await policy.addRedactionMark({ subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote: mark.quote, category: mark.category }, OFFICER);
    }
    const preview = await content.previewWorkingItem({ itemId }, PUB);
    const hash = (await content.markReady({ itemId }, PUB)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId, contentHash: hash }, WEBMASTER);
    await content.publish({ itemId, contentHash: hash }, WEBMASTER);

    expect(preview.publicBody, `public, ${drawn.visibility}: ${drawn.markup}`).toEqual(await published(itemId, {}));
    expect(preview.membersBody, `members, ${drawn.visibility}: ${drawn.markup}`).toEqual(await published(itemId, MEMBER));
  });

  it('draws every outcome: a public body withheld in part, a hidden one, a members placeholder and an officers item', () => {
    const drawn = cases.map(([, each]) => each);
    expect(drawn.some((each) => each.visibility === 'public' && each.marks.some((mark) => mark.category === RedactionCategory.MEMBER_EMAIL))).toBe(true);
    expect(drawn.some((each) => each.visibility === 'public' && each.marks.some((mark) => mark.category !== RedactionCategory.MEMBER_EMAIL))).toBe(true);
    expect(drawn.some((each) => each.visibility === 'members')).toBe(true);
    expect(drawn.some((each) => each.visibility === 'officers')).toBe(true);
    expect(drawn.some((each) => each.markup.includes(':members[') || each.markup.includes('::: members'))).toBe(true);
  });
});
