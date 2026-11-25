// ARCHIVE-SEARCH S1: the news-item rows of the search index. Written in recordSubjects, in the
// transaction of the change, from the very ContentItem the ledger hashed: so the public row never
// holds a redacted passage or a members-only one, and the members row holds what the lens gives
// members. Also the boot backfill. Real Postgres, the real workflow RPCs. Every person is made up.
import type { Client } from '@connectrpc/connect';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentKind, ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { MarkField, MarkSubjectKind, RedactionAction, RedactionAudience, RedactionCategory, RedactionPolicyService } from '../../src/gen/nwfl/mensa/v1/redaction_pb.js';
import { BACKFILL_LOCK, backfillItems, runBackfill, staleItemsSql } from '../../src/search/backfill.js';
import { type Api, OFFICER, as, insertId, startApi } from '../helpers/api.js';
import { paragraph, publishItem, text } from '../helpers/content.js';
import { live, url, urlFor } from '../helpers/pg.js';

const PUB = as('pub-token');
const WEBMASTER = as('webmaster-token');
const TREASURER = as('treasurer-token');
const PHONE = '850-555-0199';
const ADDRESS = '42 Wobblestone Lane';
// A word only members are given (a members-only passage), and one everyone is.
const SECRET = 'zephyrine';
const PLAIN = 'potluck';

interface ItemRow {
  item_id: string;
  version_id: string;
  rendered_sha256: Buffer;
  title: string;
  text: string;
}

describe.skipIf(!live)('search: the news-item rows', () => {
  let api: Api;
  let content: Client<typeof ContentService>;
  let redaction: Client<typeof RedactionPolicyService>;
  let office: string;
  let owner: pg.Client;

  const row = async (table: 'search_item_public' | 'search_item_members', itemId: string): Promise<ItemRow | undefined> =>
    (await api.pool.query<ItemRow>(`SELECT item_id, version_id, rendered_sha256, title, text FROM ${table} WHERE item_id = $1`, [itemId])).rows[0];
  const hit = async (table: 'search_item_public' | 'search_item_members', itemId: string, typed: string): Promise<boolean> =>
    ((await api.pool.query(`SELECT 1 FROM ${table} WHERE item_id = $1 AND tsv @@ websearch_to_tsquery('english', $2)`, [itemId, typed])).rowCount ?? 0) > 0;
  const ledger = async (versionId: string, audience: string): Promise<Buffer | null | undefined> =>
    (await api.pool.query<{ output_sha256: Buffer | null }>(`SELECT output_sha256 FROM publication_ledger WHERE subject_id = $1 AND audience = $2 AND current_to IS NULL`, [versionId, audience]))
      .rows[0]?.output_sha256;
  const draft = async (itemId: string, title: string, body: string): Promise<string> => {
    await content.saveDraft({ itemId, title, bodyMarkup: body }, PUB);
    const hash = (await content.markReady({ itemId, targets: { website: true, newsletter: false, email: false } }, PUB)).item?.working?.contentHash as Uint8Array;
    await content.approve({ itemId, contentHash: hash }, TREASURER);
    return (await content.publish({ itemId, contentHash: hash }, WEBMASTER)).item?.live?.id as string;
  };
  /** An item published through the workflow, so the publication writes its ledger rows and its search rows. */
  const publish = async (slug: string, title: string, body: string): Promise<{ itemId: string; versionId: string }> => {
    const item = (await content.createItem({ kind: ContentKind.ARTICLE, officeId: office, slug, title }, PUB)).item!;
    return { itemId: item.id, versionId: await draft(item.id, title, body) };
  };

  beforeAll(async () => {
    api = await startApi('nwfl_searchitems');
    content = api.client(ContentService);
    redaction = api.client(RedactionPolicyService);
    office = await insertId(api.pool, `INSERT INTO office (slug, title, kind) VALUES ('publications', 'Publications Officer', 'appointed') RETURNING id`);
    const database = (await api.pool.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]!.db;
    owner = new pg.Client({ connectionString: urlFor('postgres', new URL(url as string).password, database) });
    await owner.connect();
  });

  afterAll(async () => {
    await owner?.end();
    await api?.close();
  });

  describe('one item, through its life', () => {
    let itemId: string;
    let versionId: string;

    beforeAll(async () => {
      ({ itemId, versionId } = await publish(
        'search-picnic',
        'Spring picnic',
        `Bring a ${PLAIN} dish. Call Quillon Brask at ${PHONE} or come to ${ADDRESS}. :members[The gate code is ${SECRET}.]`,
      ));
    });

    it('writes a public and a members row on publish, each for the output the ledger recorded, and none for officers', async () => {
      const open = (await row('search_item_public', itemId))!;
      const members = (await row('search_item_members', itemId))!;
      expect(open.version_id).toBe(versionId);
      expect(open.title).toBe('Spring picnic');
      expect(open.rendered_sha256).toEqual(await ledger(versionId, 'public'));
      expect(members.rendered_sha256).toEqual(await ledger(versionId, 'members'));
      expect(open.rendered_sha256).not.toEqual(members.rendered_sha256);
      // Positive controls: the plain word is in both, and nothing is marked yet, so the phone is too.
      for (const table of ['search_item_public', 'search_item_members'] as const) {
        expect(await hit(table, itemId, PLAIN), table).toBe(true);
        expect(await hit(table, itemId, 'picnic'), table).toBe(true);
        expect((await row(table, itemId))!.text, table).toContain(PHONE);
      }
      const tables = await owner.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'search\\_item\\_%' ORDER BY 1`);
      expect(tables.rows.map((entry) => entry.tablename)).toEqual(['search_item_members', 'search_item_public']);
    });

    it('never puts a members-only passage in the public row, and does put it in the members row', async () => {
      expect((await row('search_item_public', itemId))!.text).not.toContain(SECRET);
      expect((await row('search_item_public', itemId))!.text).not.toMatch(/gate code/);
      expect(await hit('search_item_public', itemId, SECRET)).toBe(false);
      expect((await row('search_item_members', itemId))!.text).toContain(`The gate code is ${SECRET}.`);
      expect(await hit('search_item_members', itemId, SECRET)).toBe(true);
    });

    it('takes a marked phone and a marked address out of the public row in the mark\'s own transaction; members keep what their lens shows', async () => {
      await redaction.addRedactionMark(
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote: PHONE, category: RedactionCategory.MEMBER_PHONE },
        OFFICER,
      );
      await redaction.addRedactionMark(
        { subjectKind: MarkSubjectKind.CONTENT_ITEM, subjectId: itemId, field: MarkField.BODY, quote: ADDRESS, category: RedactionCategory.PRIVATE_VENUE },
        OFFICER,
      );
      const open = (await row('search_item_public', itemId))!;
      expect(open.text).not.toContain(PHONE);
      expect(open.text).not.toContain('0199');
      expect(open.text).not.toContain(ADDRESS);
      expect(open.text).not.toContain('Wobblestone');
      expect(await hit('search_item_public', itemId, PHONE)).toBe(false);
      expect(await hit('search_item_public', itemId, 'Wobblestone')).toBe(false);
      expect(open.rendered_sha256).toEqual(await ledger(versionId, 'public'));
      // The rest of the public row is still there.
      expect(await hit('search_item_public', itemId, PLAIN)).toBe(true);
      // Members are shown phones and private venues (the policy's defaults): their row keeps both.
      const members = (await row('search_item_members', itemId))!;
      expect(members.text).toContain(PHONE);
      expect(members.text).toContain(ADDRESS);
      expect(await hit('search_item_members', itemId, 'Wobblestone')).toBe(true);
      expect(members.rendered_sha256).toEqual(await ledger(versionId, 'members'));
    });

    it('follows the lens when the policy changes: members stop being given phones, and their row loses it', async () => {
      await redaction.proposeRedactionChange({ audience: RedactionAudience.MEMBERS, category: RedactionCategory.MEMBER_PHONE, action: RedactionAction.REDACT }, OFFICER);
      const members = (await row('search_item_members', itemId))!;
      expect(members.text).not.toContain(PHONE);
      expect(members.text).toContain(ADDRESS);
      expect(members.text).toContain(SECRET);
      expect(members.rendered_sha256).toEqual(await ledger(versionId, 'members'));
      expect((await row('search_item_public', itemId))!.text).not.toContain(PHONE);
    });

    it('moves the one row to the new version when one is published, and takes the old text out', async () => {
      const next = await draft(itemId, 'Spring picnic, moved', `The picnic moved to the pavilion. Call ${PHONE} or come to ${ADDRESS}. :members[The new gate code is quorvane.]`);
      expect(next).not.toBe(versionId);
      for (const table of ['search_item_public', 'search_item_members'] as const) {
        const rows = (await api.pool.query<ItemRow>(`SELECT version_id, title FROM ${table} WHERE item_id = $1`, [itemId])).rows;
        expect(rows, table).toEqual([{ version_id: next, title: 'Spring picnic, moved' }]);
        expect(await hit(table, itemId, PLAIN), table).toBe(false);
        expect(await hit(table, itemId, 'pavilion'), table).toBe(true);
      }
      // The marks still stand on the item: the new version's public row never held the phone or the address.
      expect((await row('search_item_public', itemId))!.text).not.toContain(PHONE);
      expect((await row('search_item_public', itemId))!.text).not.toContain('Wobblestone');
      expect(await hit('search_item_public', itemId, 'quorvane')).toBe(false);
      expect(await hit('search_item_members', itemId, 'quorvane')).toBe(true);
      versionId = next;
    });

    it('deletes both rows when the item is withdrawn', async () => {
      await content.withdraw({ itemId }, WEBMASTER);
      expect(await row('search_item_public', itemId)).toBeUndefined();
      expect(await row('search_item_members', itemId)).toBeUndefined();
      // The ledger still records the withdrawn stub: a row is deleted for having nothing to index, not for a null output.
      expect(await ledger(versionId, 'public')).not.toBeNull();
    });
  });

  it('indexes a members-only item for the public by its title and summary alone, and an officers item for no one', async () => {
    // The workflow publishes public items, so these two are seeded; a seeded item has no ledger row until the next
    // change that records everything, which here is a policy change that applies at once (a tightening).
    const hidden = await publishItem(api.pool, { slug: 'search-officers-item', officeId: office, title: 'Officers only', visibility: 'officers', body: { blocks: [paragraph(text('Board notes.'))] } });
    const inner = await publishItem(api.pool, {
      slug: 'search-members-only',
      officeId: office,
      title: 'Members night',
      summary: 'A night for members.',
      visibility: 'members',
      body: { blocks: [paragraph(text(`The door code is ${SECRET}.`))] },
    });
    await redaction.proposeRedactionChange({ audience: RedactionAudience.MEMBERS, category: RedactionCategory.MEMBER_EMAIL, action: RedactionAction.REDACT }, OFFICER);
    expect(await row('search_item_public', hidden.itemId)).toBeUndefined();
    expect(await row('search_item_members', hidden.itemId)).toBeUndefined();
    const open = (await row('search_item_public', inner.itemId))!;
    expect(open.title).toBe('Members night');
    expect(open.text).toBe('A night for members.');
    expect(await hit('search_item_public', inner.itemId, SECRET)).toBe(false);
    expect((await row('search_item_members', inner.itemId))!.text).toContain(SECRET);
  });

  describe('the boot backfill', () => {
    let itemId: string;
    let versionId: string;

    beforeAll(async () => {
      ({ itemId, versionId } = await publish('search-backfill', 'Game night', `Board games at the library. :members[Bring the ${SECRET} deck.]`));
    });

    it('builds the public SQL from the public table alone, and the members SQL from the members table alone', () => {
      expect(staleItemsSql('public')).toContain('search_item_public');
      expect(staleItemsSql('public')).not.toMatch(/_members/);
      expect(staleItemsSql('members')).toContain('search_item_members');
      expect(staleItemsSql('members')).not.toMatch(/search_item_public/);
    });

    it('puts back a live version\'s missing rows, lens applied, and leaves a second run nothing to do', async () => {
      const before = { open: await row('search_item_public', itemId), members: await row('search_item_members', itemId) };
      await owner.query(`DELETE FROM search_item_public WHERE item_id = $1`, [itemId]);
      await owner.query(`DELETE FROM search_item_members WHERE item_id = $1`, [itemId]);
      const first = await backfillItems(api.pool);
      expect(first).toEqual({ ran: true, written: 2, skipped: 0, rerecorded: 0, requeued: 0 });
      expect(await row('search_item_public', itemId)).toEqual(before.open);
      expect(await row('search_item_members', itemId)).toEqual(before.members);
      expect((await row('search_item_public', itemId))!.text).not.toContain(SECRET);
      expect(await backfillItems(api.pool)).toEqual({ ran: true, written: 0, skipped: 0, rerecorded: 0, requeued: 0 });
    });

    it('rewrites a row that is not the ledger\'s current output, and deletes one whose version is given nothing', async () => {
      const good = (await row('search_item_public', itemId))!;
      await owner.query(`UPDATE search_item_public SET rendered_sha256 = sha256('stale'), text = 'stale text ' || $2 WHERE item_id = $1`, [itemId, SECRET]);
      // A row left for a version the ledger says is given nothing (an officers item's).
      const hidden = await publishItem(api.pool, { slug: 'search-backfill-hidden', officeId: office, title: 'Hidden', visibility: 'officers', body: { blocks: [paragraph(text('x'))] } });
      await owner.query(`INSERT INTO search_item_members (item_id, version_id, rendered_sha256, title, text) VALUES ($1, $2, sha256('x'), 'Hidden', 'left behind')`, [
        hidden.itemId,
        hidden.versionId,
      ]);
      const result = await backfillItems(api.pool);
      // Changed by ARCHIVE-SEARCH S3 (challenge S3-2, S1): the backfill now also re-records each published item never
      // re-recorded since the last policy change, marked or not, since the search read refuses its row until then. The
      // officers item above was published by SQL with no re-record: it is the one (rerecorded 1).
      expect(result).toEqual({ ran: true, written: 2, skipped: 0, rerecorded: 1, requeued: 0 });
      const confirmed = await owner.query(`SELECT audience FROM version_rerecorded WHERE version_id = $1 ORDER BY audience`, [hidden.versionId]);
      expect(confirmed.rows).toEqual([{ audience: 'members' }, { audience: 'public' }]);
      expect(await row('search_item_public', itemId)).toEqual(good);
      expect(await row('search_item_members', hidden.itemId)).toBeUndefined();
    });

    it('skips a version whose render is no longer what the ledger holds, and writes nothing for it', async () => {
      await owner.query(`DELETE FROM search_item_public WHERE item_id = $1`, [itemId]);
      // The ledger is made to hold another output than a render gives now (as after a renderer change with no ledger write).
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('elsewhere'), '{"v":1}', 0)`, [versionId]);
      // Changed by ARCHIVE-SEARCH S3 (challenge S3-1, S1): the put still skips it (skipped 1, written 0), and no row is put
      // from a render the ledger does not hold; the same run then re-records the item, since its render is not the
      // ledger's output, and the re-record appends the render and writes its row (rerecorded 1).
      expect(await backfillItems(api.pool)).toEqual({ ran: true, written: 0, skipped: 1, rerecorded: 1, requeued: 0 });
      const now = await owner.query<{ same: boolean }>(
        `SELECT l.output_sha256 = s.rendered_sha256 AND l.output_sha256 <> sha256('elsewhere') AS same FROM publication_ledger l JOIN search_item_public s ON s.version_id = l.subject_id
          WHERE l.subject_kind = 'content_version' AND l.subject_id = $1 AND l.audience = 'public' AND l.current_to IS NULL`,
        [versionId],
      );
      expect(now.rows).toEqual([{ same: true }]);
      expect((await row('search_item_public', itemId))!.text).not.toContain(SECRET);
    });

    it('does not run while another process holds the backfill lock', async () => {
      await owner.query(`SELECT pg_advisory_lock(hashtext($1))`, [BACKFILL_LOCK]);
      try {
        expect(await backfillItems(api.pool)).toEqual({ ran: false, written: 0, skipped: 0, rerecorded: 0, requeued: 0 });
      } finally {
        await owner.query(`SELECT pg_advisory_unlock(hashtext($1))`, [BACKFILL_LOCK]);
      }
      expect((await backfillItems(api.pool)).ran).toBe(true);
    });

    it('logs counts at boot, never a title or text, and a failure is a warning that does not throw', async () => {
      const lines: Array<{ level: string; fields: Record<string, unknown>; message: string }> = [];
      const logger = {
        info: (fields: Record<string, unknown>, message: string) => lines.push({ level: 'info', fields, message }),
        warn: (fields: Record<string, unknown>, message: string) => lines.push({ level: 'warn', fields, message }),
      };
      // The state the test above leaves, made again (ARCHIVE-SEARCH S3: that test's backfill now re-records the item).
      await owner.query(`DELETE FROM search_item_public WHERE item_id = $1`, [itemId]);
      await owner.query(`SELECT publication_ledger_record('content_version', $1, 'public', sha256('elsewhere'), '{"v":1}', 0)`, [versionId]);
      await runBackfill(api.pool, logger);
      expect(lines).toEqual([{ level: 'info', fields: { ran: true, written: 0, skipped: 1, rerecorded: 1, requeued: 0 }, message: 'search backfill' }]);
      const broken = { connect: () => Promise.reject(Object.assign(new Error(`could not reach ${SECRET}`), { code: '08006' })) };
      await runBackfill(broken as unknown as pg.Pool, logger);
      expect(lines[1]).toEqual({ level: 'warn', fields: { code: '08006' }, message: 'search backfill failed' });
      await runBackfill({ connect: () => Promise.reject(new Error('no code')) } as unknown as pg.Pool, logger);
      expect(lines[2]).toEqual({ level: 'warn', fields: { code: 'unknown' }, message: 'search backfill failed' });
      expect(JSON.stringify(lines)).not.toContain(SECRET);
    });
  });
});
