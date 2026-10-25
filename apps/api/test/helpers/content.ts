// Publishing a content item the way approval will (A4b): a numbered version,
// ready with its hash, approved with the derived public tree and both search
// indexes, then made the item's live version. Used to seed read tests.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { deriveForApproval } from '../../src/content/tree.js';

export interface PublishOptions {
  slug: string;
  officeId: string;
  kind?: string;
  visibility?: 'public' | 'members' | 'officers';
  title: string;
  summary?: string | null;
  body: unknown;
  approvedAt?: string;
  /** Overrides the derived public tree, to prove which column a read loads. */
  publicAst?: unknown;
  /** Files attached to the version before it is approved: an approved version's files are frozen (0011). */
  files?: Array<{ objectKey: string; audience: 'public' | 'members' | 'officers'; mimeType?: string; role?: string }>;
  onBehalfOf?: string;
  editionId?: string;
}

export async function publishItem(pool: pg.Pool, options: PublishOptions): Promise<{ itemId: string; versionId: string }> {
  const visibility = options.visibility ?? 'public';
  const derived = deriveForApproval({ title: options.title, summary: options.summary ?? null, visibility, body: options.body });
  const item = await pool.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, $2, $3) RETURNING id`, [
    options.slug,
    options.kind ?? 'article',
    options.officeId,
  ]);
  const itemId = (item.rows[0] as { id: string }).id;
  const distributed = visibility !== 'officers';
  const version = await pool.query<{ id: string }>(
    `INSERT INTO content_version (item_id, n, title, summary, visibility, body_ast, created_by_sub, acting_office_id, target_newsletter, on_behalf_of, edition_id)
     VALUES ($1, 1, $2, $3, $4, $5, 'sub-author', $6, $7, $8, $9) RETURNING id`,
    [itemId, options.title, options.summary ?? null, visibility, JSON.stringify(options.body), options.officeId, distributed, options.onBehalfOf ?? null, options.editionId ?? null],
  );
  const versionId = (version.rows[0] as { id: string }).id;
  for (const file of options.files ?? []) {
    await pool.query(
      `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience, role) VALUES ($1, $2, $2, $3, 10, $4, $5, $6)`,
      [versionId, file.objectKey, file.mimeType ?? 'application/pdf', createHash('sha256').update(file.objectKey).digest(), file.audience, file.role ?? 'primary'],
    );
  }
  const hash = createHash('sha256').update(JSON.stringify(options.body)).digest();
  await pool.query(`UPDATE content_version SET status = 'ready', content_hash = $2, ready_at = now() WHERE id = $1`, [versionId, hash]);
  await pool.query(
    `UPDATE content_version SET status = 'approved', approved_at = $2, approved_by_sub = 'sub-webmaster', approval_kind = 'normal',
       public_ast = $3, search_public = to_tsvector('english', $4), search_members = to_tsvector('english', $5) WHERE id = $1`,
    [versionId, options.approvedAt ?? '2026-10-01T12:00:00Z', JSON.stringify(options.publicAst ?? derived.publicAst), derived.publicText, derived.membersText],
  );
  await pool.query(`UPDATE content_item SET state = 'ready' WHERE id = $1`, [itemId]);
  await pool.query(`UPDATE content_item SET state = 'published', live_version_id = $2 WHERE id = $1`, [itemId, versionId]);
  return { itemId, versionId };
}

export const paragraph = (...children: unknown[]): unknown => ({ type: 'paragraph', children });
export const text = (value: string): unknown => ({ type: 'text', text: value });
export const membersSpan = (value: string): unknown => ({ type: 'members', children: [text(value)] });
