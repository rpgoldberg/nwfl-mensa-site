// @ts-check
// EDITOR E2: the publishing workflow of the stand-in API (e2e/api.mjs), for the editor's screen units:
// a model with state, kept in memory for the run, that answers the ContentService workflow RPCs as
// the API's (apps/api/src/content/workflow.ts and E1's additions) answers them: who may do what, each
// state change and its refusal code, the approve hash, the editors of a version (caller_edited), the
// send-back note, the history with each actor's role label, and the preview as the public and members
// will get it. Its markup is a small part of the API's (headings, lists, links, :members[..] and
// ::: members blocks) with the API's problem words, enough to tell the audiences apart.
//
// EDITOR E3: two things the API on main does not do yet, kept here behind the stand-in until they land:
// A3a's strict URL words at save (its markup does: apps/api/src/links/rule.ts, a part of it here), and
// A1's version approved but not yet published (cleared, VERSION_STATUS_CLEARED = 6, sent by number until
// A1's proto lands): a seed can be cleared, the list holds it with drafts and ready ones, and an edit
// takes it back to a draft with an approval_voided step first.
//
// Items are shared by everyone, as in the API (a writer and an approver are two people). The seeded
// items (SEEDED) are for reading: a test that changes an item creates its own, with a title of its
// own, so tests in parallel never disturb each other.
import { Code, ConnectError } from '@connectrpc/connect';
import { createHash, randomUUID } from 'node:crypto';
import { ContentKind, ItemState, ItemVisibility, VersionStatus } from '../src/gen/nwfl/mensa/v1/content_pb.js';

/** @typedef {{ sub: string, groups: string[] }} Caller */
/** @typedef {{ id: string, slug: string, title: string }} Office */
/** @typedef {{ website: boolean, newsletter: boolean, email: boolean }} Targets */
/**
 * @typedef {{ id: string, number: number, status: 'draft' | 'ready' | 'cleared' | 'approved' | 'superseded', title: string, summary: string,
 *   visibility: 'public' | 'members' | 'officers', markup: string, targets: Targets, editionId: string, printAsIs: boolean,
 *   onBehalfOf: string, readyAt?: Date, approvedAt?: Date, hash?: Uint8Array, editors: Set<string>, sendBackNote: string }} Version
 */
/**
 * @typedef {{ id: string, slug: string, kind: string, officeId: string, state: 'draft' | 'ready' | 'published' | 'withdrawn',
 *   live?: Version, working?: Version, withdrawnAt?: Date, updatedAt: Date, withheld: boolean, history: Entry[] }} Item
 */
/** @typedef {{ at: Date, action: string, actorSubject: string, actorLabel: string, actingOfficeId: string, versionNumber: number, fromState: string, toState: string, note: string }} Entry */

/** The API's MAX_NOTE. */
export const MAX_NOTE = 2000;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MARKER = /:members\[|^\s*:::/m;

const KINDS = new Map([
  [ContentKind.ARTICLE, 'article'],
  [ContentKind.PRESIDENT_REPORT, 'president_report'],
  [ContentKind.ANNOUNCEMENT, 'announcement'],
  [ContentKind.MINUTES, 'minutes'],
  [ContentKind.TREASURER_SUMMARY, 'treasurer_summary'],
]);
/** @type {Record<string, ContentKind>} */
const KIND_OUT = Object.fromEntries([...KINDS].map(([k, v]) => [v, k]));
const VISIBILITY = new Map([
  [ItemVisibility.PUBLIC, 'public'],
  [ItemVisibility.MEMBERS, 'members'],
  [ItemVisibility.OFFICERS, 'officers'],
]);
/** @type {Record<string, ItemVisibility>} */
const VISIBILITY_OUT = Object.fromEntries([...VISIBILITY].map(([k, v]) => [v, k]));
const STATE_OUT = { draft: ItemState.DRAFT, ready: ItemState.READY, published: ItemState.PUBLISHED, withdrawn: ItemState.WITHDRAWN };
const STATE_IN = new Map([
  [ItemState.DRAFT, 'draft'],
  [ItemState.READY, 'ready'],
  [ItemState.PUBLISHED, 'published'],
  [ItemState.WITHDRAWN, 'withdrawn'],
]);
/** A1's VERSION_STATUS_CLEARED, by number until its proto lands. */
const CLEARED = /** @type {VersionStatus} */ (6);
const STATUS_OUT = { draft: VersionStatus.DRAFT, ready: VersionStatus.READY, cleared: CLEARED, approved: VersionStatus.APPROVED, superseded: VersionStatus.SUPERSEDED };

const invalid = (/** @type {string} */ message) => new ConnectError(message, Code.InvalidArgument);
const precondition = (/** @type {string} */ message) => new ConnectError(message, Code.FailedPrecondition);
const denied = () => new ConnectError('not permitted', Code.PermissionDenied);

// ---------------------------------------------------------------------------------------------
// Markup: a small part of the API's (apps/api/src/content/markup.ts), with its problem words.
// ---------------------------------------------------------------------------------------------

// A3a's strict URL rule (apps/api/src/links/rule.ts), the part the editor's tests need, in its words.
const REASONS = {
  http: 'must start with https://, not http://',
  www: 'must be written in full, starting with https://',
  plain: 'must be written plainly: https:// or mailto: in lower case, and no spaces',
  scheme: 'is not a web address starting with https:// or an email address starting with mailto:',
};

/** Why a URL may not be saved, or undefined. @param {string} url */
function urlReason(url) {
  if (/^http:\/\//i.test(url)) return REASONS.http;
  if (/^www\./i.test(url)) return REASONS.www;
  if (/^(https:\/\/|mailto:)\S+$/.test(url)) return undefined;
  if (/^(https:\/\/|mailto:)/i.test(url)) return REASONS.plain;
  return REASONS.scheme;
}

/** The bare URLs in a run of text (linkcheck's pattern), each without the sentence punctuation after it. @param {string} run */
const bareUrls = (run) => [...run.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'`]+/giu)].map((m) => m[0].replace(/[.,;:!?)]+$/, ''));

const text = (/** @type {string} */ t, bold = false) => ({ kind: { case: /** @type {const} */ ('text'), value: { text: t, bold, italic: false } } });
const REDACTED_INLINE = { kind: { case: /** @type {const} */ ('redacted'), value: {} } };
const REDACTED_BLOCK = { kind: { case: /** @type {const} */ ('redacted'), value: {} } };

/** One line's inlines: **bold**, [text](href), :members[..]; an unclosed :members[ takes the rest of the line (fail closed). */
function inlines(/** @type {string} */ line, /** @type {number} */ number, /** @type {{ line: number, message: string }[]} */ problems) {
  /** @type {any[]} */
  const out = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]*)\]\(([^)\s]*)\)|:members\[([^\]]*)(\]?)/g;
  /** Text as it is kept, with a problem for each bad bare URL in it. @param {string} run */
  const plain = (run) => {
    for (const url of bareUrls(run)) {
      const reason = urlReason(url);
      if (reason) problems.push({ line: number, message: `the address "${url}" ${reason}` });
    }
    return text(run);
  };
  let at = 0;
  for (const m of line.matchAll(pattern)) {
    if (m.index > at) out.push(plain(line.slice(at, m.index)));
    if (m[1] !== undefined) out.push(text(m[1], true));
    else if (m[2] !== undefined) {
      const href = m[3] ?? '';
      const reason = urlReason(href);
      if (reason === undefined) out.push({ kind: { case: 'link', value: { href, inlines: [text(m[2])] } } });
      else {
        problems.push({ line: number, message: `the link "${href}" ${reason}` });
        out.push(text(m[2]));
      }
    } else {
      if (m[5] !== ']') problems.push({ line: number, message: 'unclosed :members[' });
      out.push({ kind: { case: 'members', value: { inlines: [text(m[4] ?? '')] } } });
    }
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push(plain(line.slice(at)));
  return out;
}

/** The markup as a body tree, and what the API would refuse in it. */
export function parseMarkup(/** @type {string} */ markup) {
  /** @type {{ line: number, message: string }[]} */
  const problems = [];
  const lines = markup.split('\n');
  /** @type {any[]} */
  const root = [];
  /** @type {any[] | undefined} */
  let members;
  let membersFrom = 0;
  /** @type {any} */
  let list;
  lines.forEach((raw, i) => {
    const number = i + 1;
    const line = raw.trim();
    const into = members ?? root;
    if (line === '::: members') {
      list = undefined;
      if (members === undefined) {
        members = [];
        membersFrom = number;
      }
      return;
    }
    if (line === ':::') {
      list = undefined;
      if (members === undefined) problems.push({ line: number, message: 'closing ::: without an opening ::: members' });
      else {
        root.push({ kind: { case: 'members', value: { blocks: members } } });
        members = undefined;
      }
      return;
    }
    if (line === '') {
      list = undefined;
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      list = undefined;
      const level = (heading[1] ?? '').length;
      if (level > 2) problems.push({ line: number, message: 'only two heading levels (# and ##)' });
      into.push({ kind: { case: 'heading', value: { level: Math.min(level, 2), inlines: inlines(heading[2] ?? '', number, problems) } } });
      return;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (list === undefined) {
        list = { kind: { case: 'list', value: { ordered: false, items: [] } } };
        into.push(list);
      }
      list.kind.value.items.push({ blocks: [{ kind: { case: 'paragraph', value: { inlines: inlines(item[1] ?? '', number, problems) } } }] });
      return;
    }
    list = undefined;
    into.push({ kind: { case: 'paragraph', value: { inlines: inlines(line, number, problems) } } });
  });
  // Never closed: the rest of the document stays members-only (fail closed), and it is a problem.
  if (members !== undefined) {
    problems.push({ line: membersFrom, message: 'unclosed ::: members block' });
    root.push({ kind: { case: 'members', value: { blocks: members } } });
  }
  return { tree: { blocks: root }, problems };
}

/** The tree as the public gets it: every members node a placeholder with nothing in it (R26). */
function forPublic(/** @type {any[]} */ blocks) {
  /** @type {(list: any[]) => any[]} */
  const inl = (list) => list.map((n) => (n.kind.case === 'members' ? REDACTED_INLINE : n.kind.case === 'link' ? { kind: { case: 'link', value: { ...n.kind.value, inlines: inl(n.kind.value.inlines) } } } : n));
  return blocks.map((b) => {
    switch (b.kind.case) {
      case 'members':
        return REDACTED_BLOCK;
      case 'paragraph':
      case 'heading':
        return { kind: { case: b.kind.case, value: { ...b.kind.value, inlines: inl(b.kind.value.inlines) } } };
      case 'list':
        return { kind: { case: 'list', value: { ...b.kind.value, items: b.kind.value.items.map((/** @type {any} */ it) => ({ blocks: forPublic(it.blocks) })) } } };
      default:
        return b;
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Who the caller is, as the API reads the groups (apps/api/src/auth/roles.ts).
// ---------------------------------------------------------------------------------------------

function rolesOf(/** @type {Caller} */ caller) {
  return {
    admin: caller.groups.includes('nwfl-admin'),
    webmaster: caller.groups.includes('nwfl-webmaster'),
    officer: caller.groups.includes('nwfl-officers'),
    offices: caller.groups.filter((g) => g.startsWith('nwfl-office-')).map((g) => g.slice('nwfl-office-'.length)),
  };
}

/**
 * The publishing workflow, with state.
 * @param {{ offices: Office[], now?: () => Date, ruleFor?: (sub: string) => 'two_person' | 'one_approver' }} options
 */
export function createWorkflow({ offices, now = () => new Date(), ruleFor = () => 'two_person' }) {
  /** @type {Map<string, Item>} */
  const items = new Map();
  const officeById = (/** @type {string} */ id) => offices.find((o) => o.id === id);

  /** The office's holder, or the Admin; anyone else is refused. @param {Caller} caller @param {Item} item */
  const requireOffice = (caller, item) => {
    const roles = rolesOf(caller);
    if (!roles.admin && !roles.offices.includes(officeById(item.officeId)?.slug ?? '')) throw denied();
  };
  const requireApprover = (/** @type {Caller} */ caller) => {
    const roles = rolesOf(caller);
    if (!roles.admin && !roles.webmaster) throw denied();
  };
  /** E1: the queue's reads are for an officer, the Admin or the Webmaster. */
  const requireReader = (/** @type {Caller} */ caller) => {
    const roles = rolesOf(caller);
    if (!roles.officer && !roles.admin && !roles.webmaster) throw denied();
  };
  const load = (/** @type {string} */ id) => {
    const item = items.get(id);
    if (item === undefined) throw new ConnectError('item not found', Code.NotFound);
    return item;
  };

  /** Who acted, by role: the office for an office holder's own step, else Admin, Webmaster or Officer. @param {Caller} caller @param {Item} item @param {boolean} approving */
  const labelOf = (caller, item, approving) => {
    const roles = rolesOf(caller);
    const office = officeById(item.officeId);
    if (!approving && office && roles.offices.includes(office.slug)) return office.title;
    if (roles.admin) return 'Admin';
    if (roles.webmaster) return 'Webmaster';
    return 'Officer';
  };

  /** @param {Item} item @param {Caller} caller @param {Partial<Entry> & { action: string }} entry @param {boolean} [approving] */
  const record = (item, caller, entry, approving = false) => {
    const at = now();
    item.updatedAt = at;
    item.history.push({ at, actorSubject: caller.sub, actorLabel: labelOf(caller, item, approving), actingOfficeId: item.officeId, versionNumber: 0, fromState: '', toState: '', note: '', ...entry });
  };

  /** @param {Version} v @param {Targets} targets @param {string} editionId */
  const hashOf = (v, targets, editionId) => new Uint8Array(createHash('sha256').update(JSON.stringify([v.title, v.summary, v.visibility, v.markup, targets, editionId])).digest());

  /** A version as an officer reads it. @param {Version} v @param {Caller} caller @param {boolean} withheld */
  const versionMessage = (v, caller, withheld) =>
    ({
          id: v.id,
          number: v.number,
          status: STATUS_OUT[v.status],
          title: v.title,
          summary: v.summary,
          visibility: /** @type {ItemVisibility} */ (VISIBILITY_OUT[v.visibility]),
          body: withheld ? { blocks: forPublic(parseMarkup(v.markup).tree.blocks) } : parseMarkup(v.markup).tree,
          // E1: withheld, the markup is empty and there is no hash.
          bodyMarkup: withheld ? '' : v.markup,
          ...(v.hash && !withheld ? { contentHash: v.hash } : {}),
          targets: v.targets,
          editionId: v.editionId,
          printAsIs: v.printAsIs,
          onBehalfOf: v.onBehalfOf,
          ...(v.readyAt ? { readyAt: timestamp(v.readyAt) } : {}),
          ...(v.approvedAt ? { approvedAt: timestamp(v.approvedAt) } : {}),
          bodyMarkupWithheld: withheld,
          sendBackNote: v.sendBackNote,
          callerEdited: v.editors.has(caller.sub),
        });

  /** @param {Item} item @param {Caller} caller */
  const itemMessage = (item, caller) => ({
    id: item.id,
    slug: item.slug,
    kind: /** @type {ContentKind} */ (KIND_OUT[item.kind]),
    officeId: item.officeId,
    state: STATE_OUT[item.state],
    ...(item.live ? { live: versionMessage(item.live, caller, item.withheld) } : {}),
    ...(item.working ? { working: versionMessage(item.working, caller, item.withheld) } : {}),
    ...(item.withdrawnAt ? { withdrawnAt: timestamp(item.withdrawnAt) } : {}),
    // E3 fix 1: when it last changed.
    lastChangedAt: timestamp(item.updatedAt),
  });

  /** @param {string} title */
  const publicLine = (title) => {
    if (MARKER.test(title)) throw invalid('a title or summary is always public: put members-only words in the body');
    return title;
  };

  /** A new draft version from the live one, for an edit of a published item. @param {Item} item */
  const newVersion = (item) => {
    const from = /** @type {Version} */ (item.live);
    /** @type {Version} */
    const version = { ...from, id: randomUUID(), number: from.number + 1, status: 'draft', editors: new Set(), sendBackNote: '' };
    delete version.hash;
    delete version.readyAt;
    delete version.approvedAt;
    item.working = version;
    return version;
  };

  /**
   * Adds an item straight into a state, for the seeds (no history check, no caller).
   * @param {{ id?: string, slug: string, kind: string, officeId: string, state: Item['state'], title: string, summary?: string,
   *   visibility?: Version['visibility'], markup?: string, withheld?: boolean, working?: boolean, sendBackNote?: string, editors?: string[],
   *   cleared?: boolean, change?: 'draft' | 'ready' }} seed
   */
  const seed = (seed) => {
    const at = now();
    /** @type {Version} */
    const version = {
      id: randomUUID(),
      number: 1,
      status: seed.state === 'published' || seed.state === 'withdrawn' ? 'approved' : seed.state === 'ready' ? (seed.cleared ? 'cleared' : 'ready') : 'draft',
      title: seed.title,
      summary: seed.summary ?? '',
      visibility: seed.visibility ?? 'public',
      markup: seed.markup ?? '',
      targets: { website: true, newsletter: false, email: false },
      editionId: '',
      printAsIs: false,
      onBehalfOf: '',
      editors: new Set(seed.editors ?? []),
      sendBackNote: seed.sendBackNote ?? '',
    };
    if (version.status !== 'draft') version.hash = hashOf(version, version.targets, '');
    if (version.status === 'ready' || version.status === 'cleared') version.readyAt = at;
    if (version.status === 'approved') version.approvedAt = at;
    /** @type {Item} */
    const item = { id: seed.id ?? randomUUID(), slug: seed.slug, kind: seed.kind, officeId: seed.officeId, state: seed.state, updatedAt: at, withheld: seed.withheld ?? false, history: [] };
    if (version.status === 'approved') item.live = version;
    else item.working = version;
    // E3 fix 1: a published item with a change being written (a draft) or waiting for approval.
    if (seed.change && item.live) {
      const change = newVersion(item);
      change.title = `${seed.title}, changed`;
      if (seed.change === 'ready') Object.assign(change, { status: 'ready', readyAt: at, hash: hashOf(change, change.targets, '') });
    }
    if (seed.state === 'withdrawn') item.withdrawnAt = at;
    items.set(item.id, item);
    return item;
  };

  /**
   * The ContentService workflow handlers, each answering as `callerOf(ctx)` (the verified token).
   * @param {(ctx: import('@connectrpc/connect').HandlerContext) => Promise<Caller> | Caller} callerOf
   */
  const handlers = (callerOf) => ({
    createItem: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const kind = KINDS.get(req.kind);
      if (kind === undefined) throw invalid('kind is required');
      const title = publicLine(req.title.trim());
      if (title === '') throw invalid('title is required');
      const office = officeById(req.officeId);
      if (office === undefined) throw invalid('unknown office');
      const roles = rolesOf(caller);
      if (!roles.admin && !roles.offices.includes(office.slug)) throw denied();
      if (!SLUG.test(req.slug)) throw invalid('a value is not allowed');
      if ([...items.values()].some((i) => i.slug === req.slug)) throw new ConnectError('already exists', Code.AlreadyExists);
      if ([...title].length > 200) throw invalid('a value is not allowed');
      /** @type {Item} */
      const item = { id: randomUUID(), slug: req.slug, kind, officeId: office.id, state: 'draft', updatedAt: now(), withheld: false, history: [] };
      item.working = {
        id: randomUUID(),
        number: 1,
        status: 'draft',
        title,
        summary: '',
        visibility: 'public',
        markup: '',
        targets: { website: true, newsletter: true, email: false },
        editionId: '',
        printAsIs: false,
        onBehalfOf: req.onBehalfOf.trim(),
        editors: new Set([caller.sub]),
        sendBackNote: '',
      };
      items.set(item.id, item);
      record(item, caller, { action: 'create', versionNumber: 1, toState: 'draft' });
      return { item: itemMessage(item, caller) };
    },

    saveDraft: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const item = load(req.itemId);
      requireOffice(caller, item);
      const version = item.working ?? newVersion(item);
      const from = version.status;
      if (version.status === 'ready' || version.status === 'cleared') {
        if (version.printAsIs) throw precondition('a print-as-is version can be approved or sent back, never edited');
        // A1: an edit after approval voids it, and says so in the history first.
        if (version.status === 'cleared') record(item, caller, { action: 'approval_voided', versionNumber: version.number, fromState: 'cleared', toState: 'draft' });
        version.status = 'draft';
        delete version.hash;
        if (item.state === 'ready') item.state = 'draft';
      }
      const title = publicLine(req.title.trim());
      if (title === '') throw invalid('title is required');
      publicLine(req.summary);
      version.title = title;
      version.summary = req.summary.trim();
      version.visibility = /** @type {Version['visibility']} */ (VISIBILITY.get(req.visibility) ?? version.visibility);
      version.markup = req.bodyMarkup;
      if (version.visibility === 'officers') version.targets = { ...version.targets, newsletter: false, email: false };
      version.editors.add(caller.sub);
      record(item, caller, { action: 'save', versionNumber: version.number, fromState: from, toState: 'draft' });
      return { item: itemMessage(item, caller), problems: parseMarkup(version.markup).problems };
    },

    markReady: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const item = load(req.itemId);
      requireOffice(caller, item);
      const version = item.working;
      if (version === undefined) throw precondition('there is no draft to mark ready');
      if (version.status !== 'draft') throw precondition('only a draft can be marked ready');
      const problems = parseMarkup(version.markup).problems;
      if (problems.length > 0) throw precondition(`the markup has ${problems.length} problem(s); fix them first`);
      /** @type {Targets} */
      const targets = req.targets ? { website: req.targets.website, newsletter: req.targets.newsletter, email: req.targets.email } : { website: true, newsletter: version.visibility !== 'officers', email: false };
      if (version.visibility === 'officers' && (targets.newsletter || targets.email)) throw invalid('an officers-only item cannot go to the newsletter or email');
      Object.assign(version, { status: 'ready', targets, editionId: req.editionId, printAsIs: req.printAsIs, readyAt: now(), sendBackNote: '' });
      version.hash = hashOf(version, targets, req.editionId);
      if (item.state === 'draft') item.state = 'ready';
      record(item, caller, { action: 'ready', versionNumber: version.number, fromState: 'draft', toState: 'ready' });
      return { item: itemMessage(item, caller) };
    },

    sendBack: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireApprover(caller);
      const note = req.note.trim();
      if (note === '' || note.length > MAX_NOTE) throw invalid('a note for the author is required');
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'ready') throw precondition('only a ready version can be sent back');
      version.status = 'draft';
      version.sendBackNote = note;
      delete version.hash;
      if (item.state === 'ready') item.state = 'draft';
      record(item, caller, { action: 'send_back', versionNumber: version.number, fromState: 'ready', toState: 'draft', note }, true);
      return { item: itemMessage(item, caller) };
    },

    approve: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireApprover(caller);
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'ready') throw precondition('only a ready version can be approved');
      if (version.hash === undefined || Buffer.compare(Buffer.from(req.contentHash), Buffer.from(version.hash)) !== 0) {
        throw new ConnectError('the version changed since it was opened; reload it', Code.Aborted);
      }
      let action = 'approve';
      let note = '';
      if (version.editors.has(caller.sub)) {
        if (req.breakGlass) {
          if (!rolesOf(caller).admin) throw new ConnectError('only the Admin may approve their own edit', Code.PermissionDenied);
          note = req.breakGlassReason.trim();
          if (note === '' || note.length > MAX_NOTE) throw invalid('a break-glass approval needs a written reason');
          action = 'approve_self';
        } else if (ruleFor(caller.sub) === 'one_approver') action = 'approve_single';
        else throw new ConnectError('you edited this version; a second officer must approve it', Code.PermissionDenied);
      }
      const targets = req.targets ? { website: req.targets.website, newsletter: req.targets.newsletter, email: req.targets.email } : version.targets;
      if (version.visibility === 'officers' && (targets.newsletter || targets.email)) throw invalid('an officers-only item cannot go to the newsletter or email');
      const editionId = req.editionId === '' ? version.editionId : req.editionId;
      if (JSON.stringify(targets) !== JSON.stringify(version.targets)) record(item, caller, { action: 'targets_changed', versionNumber: version.number }, true);
      if (editionId !== version.editionId) record(item, caller, { action: 'edition_changed', versionNumber: version.number }, true);
      if (item.live) item.live.status = 'superseded';
      Object.assign(version, { status: 'approved', targets, editionId, approvedAt: now() });
      item.live = version;
      delete item.working;
      const from = item.state;
      item.state = 'published';
      record(item, caller, { action, versionNumber: version.number, fromState: from, toState: 'published', note }, true);
      return { item: itemMessage(item, caller) };
    },

    withdraw: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const item = load(req.itemId);
      const roles = rolesOf(caller);
      if (!roles.admin && !roles.webmaster && !roles.offices.includes(officeById(item.officeId)?.slug ?? '')) throw denied();
      if (item.state !== 'published') throw precondition('only a published item can be withdrawn');
      item.state = 'withdrawn';
      item.withdrawnAt = now();
      record(item, caller, { action: 'withdraw', fromState: 'published', toState: 'withdrawn' });
      return { item: itemMessage(item, caller) };
    },

    listWorkingItems: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReader(caller);
      /** @type {string[]} */
      // A1: empty means draft, ready and cleared. E3 fix 1: published and withdrawn name the item's state.
      const named = req.states.map((/** @type {number} */ s) => STATE_IN.get(s));
      const states = req.states.length === 0 ? ['draft', 'ready', 'cleared'] : named.filter((s) => s === 'draft' || s === 'ready');
      /** @type {string[]} */
      const itemStates = named.filter((s) => s === 'published' || s === 'withdrawn');
      const byStatus = (/** @type {Item} */ i) => i.working !== undefined && states.includes(i.working.status);
      const listed = [...items.values()]
        .filter((i) => (byStatus(i) || itemStates.includes(i.state)) && (req.officeId === '' || i.officeId === req.officeId) && (req.editionId === '' || (byStatus(i) ? i.working?.editionId : i.live?.editionId) === req.editionId))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id));
      return { items: listed.map((i) => itemMessage(i, caller)) };
    },

    getWorkingItem: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReader(caller);
      return { item: itemMessage(load(req.itemId), caller) };
    },

    listItemHistory: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReader(caller);
      return { entries: load(req.itemId).history.map((e) => ({ ...e, at: timestamp(e.at) })) };
    },

    previewWorkingItem: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReader(caller);
      const item = load(req.itemId);
      const version = item.working ?? item.live;
      if (version === undefined) throw new ConnectError('item not found', Code.NotFound);
      const { tree, problems } = parseMarkup(version.markup);
      // E1: a public body unless the item is for officers; a members item's is the one placeholder.
      const publicBody = version.visibility === 'officers' ? undefined : version.visibility === 'members' ? { blocks: [REDACTED_BLOCK] } : { blocks: forPublic(tree.blocks) };
      // Never wider than the caller's lens: a withheld item's members body is the public's.
      const membersBody = version.visibility === 'officers' ? undefined : item.withheld ? { blocks: forPublic(tree.blocks) } : tree;
      return { title: version.title, summary: version.summary, ...(publicBody ? { publicBody } : {}), ...(membersBody ? { membersBody } : {}), problems };
    },
  });

  return { items, seed, handlers };
}

/** A google.protobuf.Timestamp from a date. @param {Date} at */
function timestamp(at) {
  const ms = at.getTime();
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}
