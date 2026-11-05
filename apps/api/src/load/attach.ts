// ============================================================================
// LINKS D5b: the links command, for an issue already loaded.
//
//   node dist/load/links-cli.js -      the bundle on stdin; DATABASE_URL (or PG*) as for the service
//
// The bundle (nwfl-links/1) names the issue by its slug and both files by
// sha256, and carries the files' approved links (links.ts) with
// approval: { reference, linksSha256, publicInputHash }. In one transaction,
// written as system:issue-loader through pdf_links_attach (0024), which audits
// each file, it attaches the links and nothing else: no content version, file,
// mark or approval reason changes, so "the loader never revises an issue"
// still holds. Then it checks the public input hash in the database (store.ts
// inputHash, which names the links from L3 on).
//
// Refused, with nothing applied:
//   - before the database: anything the issue loader refuses of its stdin
//     (input.ts), a bundle over 4 MiB, an unknown field, a link links.ts
//     refuses, links other than the approved hash, and a bundle with no links;
//   - in it: a slug that is not loaded, or that the loader did not write; an
//     issue edited or withdrawn after loading; files other than the bundle's
//     (the stored originals' sha256, which the links hash names, so links
//     approved for one issue never attach to another); a link whose target
//     holds one of the issue's withheld quotes (links.ts targetHolds);
//     a file that already has links, unless they are exactly the bundle's,
//     under the same approval (then it reports "unchanged"); a public input
//     hash other than the approved one.
// It prints ids and counts only, never a URL, and a driver error by its code only.
// ============================================================================
import { type Db, type Env, createPool } from '../db/pool.js';
import { inTransaction } from '../db/tx.js';
import { HEX64, LoadError, REFERENCE, type Stdin, known, matching, object, own, readBundleJson } from './input.js';
import { type IssueLinks, LINK_FILES, attachLinks, hasLinks, linksSha256, parseLinks, refuseWithheldTargets, storedLinks, withheldQuotes } from './links.js';
import { LOADER, approvedFiles, checkPublicInputs, findIssue } from './load.js';

export const LINKS_FORMAT = 'nwfl-links/1';
/** 1000 links of 2 KiB fit well inside this. */
export const MAX_LINKS_BUNDLE_BYTES = 4 * 1024 * 1024;
const SLUG = /^pensa-mensa-[0-9]{4}-(0[1-9]|1[0-2])$/;

export interface LinksBundle {
  slug: string;
  sha256: { public: string; members: string };
  links: IssueLinks;
  approval: { reference: string; linksSha256: string; publicInputHash: string };
}

export interface AttachResult {
  status: 'attached' | 'unchanged';
  itemId: string;
  publicFileId: string;
  membersFileId: string;
  links: { public: number; members: number };
}

/** A links bundle, checked whole before anything touches the database. */
export function parseLinksBundle(input: unknown): LinksBundle {
  const json = object(input, 'the links bundle');
  known(json, 'the links bundle', ['format', 'issue', 'sha256', 'links', 'approval']);
  if (own(json, 'format') !== LINKS_FORMAT) throw new LoadError(`the links bundle's format must be ${LINKS_FORMAT}`);
  const slug = matching(own(json, 'issue'), SLUG, 'issue', "an issue's slug, pensa-mensa-YYYY-MM");

  const shaJson = object(own(json, 'sha256'), 'sha256');
  known(shaJson, 'sha256', LINK_FILES);
  const sha256 = {
    public: matching(own(shaJson, 'public'), HEX64, 'sha256.public', '64 lower-case hex digits'),
    members: matching(own(shaJson, 'members'), HEX64, 'sha256.members', '64 lower-case hex digits'),
  };

  const approvalJson = object(own(json, 'approval'), 'approval');
  known(approvalJson, 'approval', ['reference', 'linksSha256', 'publicInputHash']);
  const approval = {
    reference: matching(own(approvalJson, 'reference'), REFERENCE, 'approval.reference', 'a reply tag: capital letters, digits and hyphens'),
    linksSha256: matching(own(approvalJson, 'linksSha256'), HEX64, 'approval.linksSha256', '64 lower-case hex digits'),
    publicInputHash: matching(own(approvalJson, 'publicInputHash'), HEX64, 'approval.publicInputHash', '64 lower-case hex digits'),
  };

  const links = parseLinks(own(json, 'links'));
  if (links.public.length + links.members.length === 0) throw new LoadError('the links bundle has no links: there is nothing to attach');
  // The hash names both files (CONTRACT item 4): links approved for one issue's files are not another's.
  const computed = linksSha256(sha256, links);
  if (computed !== approval.linksSha256) throw new LoadError(`the links are not the approved ones: their sha256 is ${computed}`);
  return { slug, sha256, links, approval };
}

/** Attaches the links in one transaction, or finds them attached exactly so. A LoadError leaves nothing behind. */
export function applyLinksBundle(db: Db, bundle: LinksBundle): Promise<AttachResult> {
  const { slug } = bundle;
  return inTransaction(db, async (client): Promise<AttachResult> => {
    const existing = await findIssue(client, slug);
    if (existing === undefined) throw new LoadError(`${slug} is not loaded: links are attached only to a loaded issue`);
    if (existing.kind !== 'document' || !existing.loaded) throw new LoadError(`${slug} was not written by the loader: it is never touched`);
    if (existing.created_by_sub !== LOADER || existing.working_version_id !== null || existing.state !== 'published') {
      throw new LoadError(`${slug} was edited or withdrawn after loading: links are attached only to an issue as loaded`);
    }
    const files = await approvedFiles(client, existing.live_version_id as string, bundle.sha256, `${slug}'s files are not the bundle's`);
    const ids = { public: files.public.id, members: files.members.id };
    refuseWithheldTargets(bundle.links, await withheldQuotes(client, existing.id));
    const result = (status: AttachResult['status']): AttachResult => ({
      status,
      itemId: existing.id,
      publicFileId: ids.public,
      membersFileId: ids.members,
      links: { public: bundle.links.public.length, members: bundle.links.members.length },
    });

    const stored = await storedLinks(client, ids);
    if (hasLinks(stored)) {
      const same =
        linksSha256(bundle.sha256, stored.links) === bundle.approval.linksSha256 &&
        stored.approvals.length === 1 &&
        stored.approvals[0]?.reference === bundle.approval.reference &&
        stored.approvals[0].linksSha256 === bundle.approval.linksSha256;
      if (!same) throw new LoadError(`${slug} already has other links: a file's links are attached once`);
      return result('unchanged');
    }
    for (const audience of LINK_FILES) {
      if (bundle.links[audience].length > 0) {
        await attachLinks(client, { fileId: ids[audience], links: bundle.links[audience], reference: bundle.approval.reference, linksSha256: bundle.approval.linksSha256, sub: LOADER });
      }
    }
    await checkPublicInputs(client, ids.public, bundle.approval.publicInputHash);
    return result('attached');
  });
}

/** The command: exit 0 attached or unchanged, 2 refused before the database, 1 refused or failed in it (nothing applied). */
export async function runAttach(argv: string[], env: Env, stdin: Stdin, say: (line: string) => void): Promise<number> {
  if (argv.length !== 1 || argv[0] !== '-') {
    say('usage: node dist/load/links-cli.js -   (the links bundle is read from stdin only: never a path, URL or mounted file)');
    return 2;
  }
  let bundle: LinksBundle;
  try {
    bundle = parseLinksBundle(await readBundleJson(env, stdin, MAX_LINKS_BUNDLE_BYTES));
  } catch (error) {
    say(`links: ${(error as Error).message}`);
    return 2;
  }
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    pool = createPool(env);
    const result = await applyLinksBundle(pool, bundle);
    say(
      `${result.status}: item ${result.itemId}, public file ${result.publicFileId} (${result.links.public} links), members file ${result.membersFileId} (${result.links.members} links)`,
    );
    return 0;
  } catch (error) {
    if (error instanceof LoadError) {
      say(`links refused, nothing applied: ${error.message}`);
      return 1;
    }
    // The driver's code only: its message can echo a value it refused.
    const code = (error as { code?: unknown }).code;
    say(`links failed, nothing applied: ${typeof code === 'string' ? code : 'error'}`);
    return 1;
  } finally {
    await pool?.end();
  }
}
