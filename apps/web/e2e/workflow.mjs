// @ts-check
// EDITOR E2: the publishing workflow of the stand-in API (e2e/api.mjs), for the editor's screen units:
// a model with state, kept in memory for the run, that answers the ContentService workflow RPCs as
// the API's (apps/api/src/content/workflow.ts and E1's additions) answers them: who may do what, each
// state change and its refusal code, the approve hash, the editors of a version (caller_edited), the
// send-back note, the history with each actor's role label, and the preview as the public and members
// will get it. Its markup is a small part of the API's (headings, lists, links, :members[..] and
// ::: members blocks) with the API's problem words, enough to tell the audiences apart.
//
// EDITOR E3: A3a's strict URL words at save, which the API on main does not do yet (its markup does:
// apps/api/src/links/rule.ts, a part of it here); and A1's version approved but not yet published
// (VERSION_STATUS_CLEARED): a seed can be cleared, the list holds it with drafts and ready ones (or
// lists by version_statuses), and an edit takes it back to a draft with an approval_voided step first.
//
// EDITOR E4: A1's two steps, as apps/api/src/content/workflow.ts answers them. Any reviewer (an officer,
// the Admin, the Webmaster) who did not edit a version approves it: CLEARED, "approved, ready to publish",
// and nothing goes live; Publish, for the Webmaster or the Admin as backup, makes it live. A self-approval
// (the Admin's break-glass; a publisher's own edit under one approver) is published by someone else, and a
// one-approver approval not at all once the rule is back to two people. Approve, Send back and
// ConfirmLinks act for an office the reviewer holds (acting_as_office_id; none named: their one office).
// Send back works from ready or cleared; a take-down voids an approval waiting to be published; Publish
// puts a taken-down item back only when told. An edition frozen for print (frozenEditions) refuses both.
// And A3b's link gate (apps/api/src/content/link-gate.ts, item-links.ts): GetItemLinks lists the links and
// printed addresses of the text, sorted, with the hash of the list; ConfirmLinks keeps each answer of a
// reviewer who did not edit a waiting version, for its ready time; Approve waits while any answer is no,
// or a link that needs a sign-in has no yes. Its refusals are the API's, word for word. A3b's fix round
// (008a115): the hash binds the ready time too; Approve's refusal names only links the caller sees whole,
// the rest one fixed sentence; a holder who reviews nothing is told "not permitted" for a missing item as
// for another office's. The caller's lens is the redaction lens alone (item-links.ts linksAsSeen): members
// passages are every reviewer's (officers are members); a seed marked officersOnly has its members
// passages withheld from anyone outside the officers group, body, preview and links alike. With anything
// withheld, a version comes with no hash and no markup (A3b workflow.ts versionMessage), and (A3B-HARDEN,
// requireWholeView) neither may approve nor publish it: Approve, Publish and ConfirmLinks refuse such a
// caller before any hash is compared; Send back is theirs.
// ConfirmLinks keeps no answer for an address over 2,048 characters (link-gate.ts MAX_URL_LENGTH): A3b's
// parser refuses such a link at save, the stand-in's keeps it, so a seed can show not_in_piece. The
// office's upcoming events are not in the stand-in's list (E7b checks them on the real API).
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
/** @typedef {{ url: string, yes: boolean, note: string, sub: string, label: string, readyAt: number }} Answer */
/**
 * @typedef {{ id: string, number: number, status: 'draft' | 'ready' | 'cleared' | 'approved' | 'superseded', title: string, summary: string,
 *   visibility: 'public' | 'members' | 'officers', markup: string, targets: Targets, editionId: string, printAsIs: boolean,
 *   onBehalfOf: string, readyAt?: Date, approvedAt?: Date, publishedAt?: Date, hash?: Uint8Array, editors: Set<string>, sendBackNote: string,
 *   updatedAt?: Date, approvalKind?: 'normal' | 'self_breakglass' | 'self_single', approvedBy?: string, approvedAsLabel?: string, answers: Answer[] }} Version
 */
/**
 * @typedef {{ id: string, slug: string, kind: string, officeId: string, state: 'draft' | 'ready' | 'published' | 'withdrawn',
 *   live?: Version, working?: Version, withdrawnAt?: Date, updatedAt: Date, withheld: boolean, officersOnly: boolean, history: Entry[] }} Item
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
const STATUS_OUT = { draft: VersionStatus.DRAFT, ready: VersionStatus.READY, cleared: VersionStatus.CLEARED, approved: VersionStatus.APPROVED, superseded: VersionStatus.SUPERSEDED };
/** A1's version_statuses: the working version's status, of those the list holds. */
const STATUS_IN = new Map([
  [VersionStatus.DRAFT, 'draft'],
  [VersionStatus.READY, 'ready'],
  [VersionStatus.CLEARED, 'cleared'],
]);

const invalid = (/** @type {string} */ message) => new ConnectError(message, Code.InvalidArgument);
const precondition = (/** @type {string} */ message) => new ConnectError(message, Code.FailedPrecondition);
/** The API's words for a save from a base someone else has changed since (E3 round 2). */
const STALE_BASE = 'This draft was changed by someone else since you opened it';
/** A Timestamp in milliseconds: the stand-in keeps no finer time. @param {{ seconds: bigint, nanos: number }} at */
const msOf = (at) => Number(at.seconds) * 1000 + Math.floor(at.nanos / 1_000_000);
const denied = () => new ConnectError('not permitted', Code.PermissionDenied);
const notFound = () => new ConnectError('item not found', Code.NotFound);

// ---------------------------------------------------------------------------------------------
// The link gate's list (EDITOR A3b: apps/api/src/content/item-links.ts), the part the screens need.
// ---------------------------------------------------------------------------------------------

/** Where a link of the text is. */
export const IN_TEXT = 'in the text';
/** How much of a URL a refusal shows (apps/api/src/links/rule.ts SHOWN_MAX). */
const SHOWN_MAX = 60;
/** At most this many answers in one call (link-gate.ts MAX_ANSWERS). */
const MAX_ANSWERS = 500;
/** The longest address an answer is kept for (apps/api/src/links/urls.ts MAX_URL_LENGTH). */
const MAX_URL_LENGTH = 2048;
/** The sites that need a sign-in to check (apps/api/src/links/urls.ts LOGIN_WALLED). */
const LOGIN_WALLED = ['facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'messenger.com', 'instagram.com', 'instagr.am', 'linkedin.com', 'lnkd.in', 'x.com', 'twitter.com', 't.co', 'nextdoor.com'];
/** The API's words for answers to a list that changed since it was read. */
export const LINKS_CHANGED = 'the links changed since you opened them; reload them';

/** Whether a URL is on a site that needs a sign-in to check. @param {string} url */
export function loginWalled(url) {
  if (!url.startsWith('https://')) return false;
  const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  return LOGIN_WALLED.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The words of a run of inlines. @param {any[]} nodes @returns {string} */
const wordsOf = (nodes) => nodes.map((n) => (n.kind.case === 'text' ? n.kind.value.text : n.kind.case === 'link' || n.kind.case === 'members' ? wordsOf(n.kind.value.inlines) : '')).join('');

/** Every link and printed address of a body tree, in order, repeats included. @param {any[]} blocks @returns {{ url: string, label: string, where: string }[]} */
export function textLinks(blocks) {
  /** @type {{ url: string, label: string, where: string }[]} */
  const out = [];
  /** @param {any[]} nodes */
  const inline = (nodes) => {
    for (const n of nodes) {
      if (n.kind.case === 'text') for (const url of bareUrls(n.kind.value.text)) out.push({ url, label: '', where: IN_TEXT });
      else if (n.kind.case === 'link') {
        out.push({ url: n.kind.value.href, label: wordsOf(n.kind.value.inlines).replace(/\s+/g, ' ').trim(), where: IN_TEXT });
        inline(n.kind.value.inlines);
      } else if (n.kind.case === 'members') inline(n.kind.value.inlines);
    }
  };
  /** @param {any[]} list */
  const block = (list) => {
    for (const b of list) {
      if (b.kind.case === 'paragraph' || b.kind.case === 'heading') inline(b.kind.value.inlines);
      else if (b.kind.case === 'list') for (const item of b.kind.value.items) block(item.blocks);
      else if (b.kind.case === 'members') block(b.kind.value.blocks);
    }
  };
  block(blocks);
  return out;
}

/** One row per (url, where), the first words kept, sorted by url, then where. @param {{ url: string, label: string, where: string }[]} links */
export function canonicalLinks(links) {
  /** @type {Map<string, { url: string, label: string, where: string }>} */
  const rows = new Map();
  for (const link of links) {
    const key = JSON.stringify([link.url, link.where]);
    const known = rows.get(key);
    if (known === undefined) rows.set(key, { ...link });
    else if (known.label === '') known.label = link.label;
  }
  const order = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()].sort((a, b) => order(a.url, b.url) || order(a.where, b.where));
}

/**
 * A3b fix round: SHA-256 of the JSON array [ready_at, pairs]: the ready time in RFC 3339, in UTC, to the
 * microsecond (null for a draft; the stand-in keeps milliseconds, so the last three digits are 0), then the
 * [url, where] pairs in the list's order. Marked ready again, the same list has a new hash.
 * @param {Date | undefined} readyAt @param {{ url: string, where: string }[]} links
 */
const linksSha256 = (readyAt, links) =>
  new Uint8Array(
    createHash('sha256')
      .update(JSON.stringify([readyAt === undefined ? null : `${readyAt.toISOString().slice(0, 23)}000Z`, links.map((l) => [l.url, l.where])]))
      .digest(),
  );

/** Approve's refusal for links its caller may not see whole: no URL and no count (item-links.ts OFFICERS_ONLY). */
export const OFFICERS_ONLY = "Some links that only officers can see need an officer's answer before this is approved.";

/** A URL as Approve's refusal names it (apps/api/src/links/rule.ts shownUrl): cut at SHOWN_MAX, then "...". @param {string} url */
const shownUrl = (url) => (url.length > SHOWN_MAX ? `${url.slice(0, SHOWN_MAX)}...` : url);

/** Approve's refusal while reviewers answered no (item-links.ts refusedMessage). @param {string[]} urls */
export function refusedMessage(urls) {
  const more = urls.length > 1 ? ` and ${urls.length - 1} more` : '';
  return `a reviewer answered no for the link "${shownUrl(/** @type {string} */ (urls[0]))}"${more} (it does not show the right page): the writer fixes it, or a reviewer changes the answer to yes, before this is approved`;
}

/** Approve's refusal while `count` sign-in links wait (item-links.ts uncheckedMessage). @param {number} count */
export function uncheckedMessage(count) {
  const them = count === 1 ? '1 link needs' : `${count} links need`;
  const it = count === 1 ? 'it' : 'them';
  return `${them} a sign-in to check (such as Facebook): someone other than the writer must open ${it} and answer yes before this is approved`;
}

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

/** The API's audience for a caller (auth/caller.ts audienceFor): the officers group, else a member, else the public. @param {Caller} caller */
const audienceOf = (caller) => (caller.groups.includes('nwfl-officers') ? 'officers' : caller.groups.includes('nwfl-members') ? 'members' : 'public');

/** Whether the caller's lens withholds the item's members passages: held back for all, or marked for officers only. @param {Item} item @param {Caller} caller */
const withheldFor = (item, caller) => item.withheld || (item.officersOnly && audienceOf(caller) !== 'officers');

function rolesOf(/** @type {Caller} */ caller) {
  return {
    admin: caller.groups.includes('nwfl-admin'),
    webmaster: caller.groups.includes('nwfl-webmaster'),
    officer: caller.groups.includes('nwfl-officers'),
    offices: caller.groups.filter((g) => g.startsWith('nwfl-office-')).map((g) => g.slice('nwfl-office-'.length)),
  };
}

/**
 * The publishing workflow, with state. `frozenEditions` (E4): editions already frozen for print, by id and title.
 * @param {{ offices: Office[], now?: () => Date, ruleFor?: (sub: string) => 'two_person' | 'one_approver', frozenEditions?: { id: string, title: string }[] }} options
 */
export function createWorkflow({ offices, now = () => new Date(), ruleFor = () => 'two_person', frozenEditions = [] }) {
  /** @type {Map<string, Item>} */
  const items = new Map();
  const officeById = (/** @type {string} */ id) => offices.find((o) => o.id === id);

  /** The office's holder, or the Admin; anyone else is refused. @param {Caller} caller @param {Item} item */
  const requireOffice = (caller, item) => {
    const roles = rolesOf(caller);
    if (!roles.admin && !roles.offices.includes(officeById(item.officeId)?.slug ?? '')) throw denied();
  };
  /** A1: a reviewer (approve, send back, confirm links) is an officer, the Admin or the Webmaster. */
  const requireReviewer = (/** @type {Caller} */ caller) => {
    const roles = rolesOf(caller);
    if (!roles.officer && !roles.admin && !roles.webmaster) throw denied();
    return roles;
  };
  /** A1: a publisher is the Webmaster, or the Admin as backup. */
  const requirePublisher = (/** @type {Caller} */ caller) => {
    const roles = rolesOf(caller);
    if (!roles.admin && !roles.webmaster) throw denied();
    return roles;
  };
  /**
   * The office a reviewer acts for (workflow.ts actingOffice): one they hold, named; else their one office.
   * @param {Caller} caller @param {string} requested @returns {string}
   */
  const actingOffice = (caller, requested) => {
    const roles = rolesOf(caller);
    if (requested !== '') {
      // The API takes ids only; the stand-in's roster also has ids of its own ("office-treasurer").
      if (officeById(requested) === undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requested)) throw invalid('acting_as_office_id is not an id');
      const slug = officeById(requested)?.slug;
      if (slug === undefined || !roles.offices.includes(slug)) throw new ConnectError('you do not hold that office', Code.PermissionDenied);
      return requested;
    }
    if (roles.offices.length !== 1) return '';
    return offices.find((o) => o.slug === roles.offices[0])?.id ?? '';
  };
  /** The edition a version is for, when it is frozen for print and the version goes to the newsletter. @param {Version} v */
  const frozenTitle = (v) => (v.targets.newsletter ? frozenEditions.find((e) => e.id === v.editionId)?.title : undefined);
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

  /**
   * Who acted, by role (actor-label.ts): the office acted for when they hold it, else Admin, Webmaster, a
   * holder of the item's office by its title, or Officer.
   * @param {Caller} caller @param {Item} item @param {string} acting
   */
  const labelOf = (caller, item, acting) => {
    const roles = rolesOf(caller);
    const actingAs = officeById(acting);
    if (actingAs && roles.offices.includes(actingAs.slug)) return actingAs.title;
    if (roles.admin) return 'Admin';
    if (roles.webmaster) return 'Webmaster';
    const office = officeById(item.officeId);
    if (office && roles.offices.includes(office.slug)) return office.title;
    return 'Officer';
  };

  /**
   * A step in the history; `acting` is the office acted for: the item's own unless said (E4: none for Publish).
   * @param {Item} item @param {Caller} caller @param {Partial<Entry> & { action: string }} entry @param {string} [acting]
   */
  const record = (item, caller, entry, acting = item.officeId, at = now()) => {
    item.updatedAt = at;
    item.history.push({ at, actorSubject: caller.sub, actorLabel: labelOf(caller, item, acting), actingOfficeId: acting, versionNumber: 0, fromState: '', toState: '', note: '', ...entry });
  };

  /**
   * A3B-HARDEN (PR #70, workflow.ts requireWholeView): approving, publishing and vouching for links need the
   * whole version; a caller from whom anything of it is withheld may only send it back. Called before any
   * hash is compared, so the refusal tells nothing about a hash.
   * @param {Item} item @param {Caller} caller @param {'approve it' | 'publish it' | 'check its links'} act
   */
  const requireWholeView = (item, caller, act) => {
    if (withheldFor(item, caller)) throw precondition(`part of this item is withheld from you; an officer who can see all of it must ${act}`);
  };

  /**
   * A1: whether the caller may approve the version as it stands (break-glass aside), and publish it.
   * Neither when anything of it is withheld from them (A3B-HARDEN, requireWholeView).
   * @param {Version} v @param {Caller} caller @param {boolean} withheld
   */
  const mayActOn = (v, caller, withheld) => {
    if (withheld) return { approve: false, publish: false };
    const roles = rolesOf(caller);
    const reviewer = roles.officer || roles.admin || roles.webmaster;
    const publisher = roles.admin || roles.webmaster;
    const edited = v.editors.has(caller.sub);
    const approve = v.status === 'ready' && reviewer && (!edited || (publisher && ruleFor(caller.sub) === 'one_approver'));
    const self = v.approvalKind === 'self_breakglass' || v.approvalKind === 'self_single';
    const publish =
      v.status === 'cleared' && publisher && !(self && v.approvedBy === caller.sub) && (v.approvalKind !== 'self_single' || ruleFor(v.approvedBy ?? '') === 'one_approver');
    return { approve, publish };
  };

  /** A version's approval undone: its hash, approver and answers' standing go with it. @param {Version} v */
  const unclear = (v) => {
    v.status = 'draft';
    delete v.hash;
    delete v.approvedAt;
    delete v.approvalKind;
    delete v.approvedBy;
    delete v.approvedAsLabel;
  };

  /**
   * The piece's links: `actual` as they are, `links` as the caller sees them (their lens: a seed held back,
   * or one marked for officers only to a caller outside the officers group; never members passages as such), with the
   * hash of what they see bound to the ready time, and each link's latest answer for this ready time from
   * someone who did not edit it.
   * @param {Item} item @param {Version} v @param {Caller} caller
   */
  const linksOf = (item, v, caller) => {
    const tree = parseMarkup(v.markup).tree.blocks;
    const actual = canonicalLinks(textLinks(tree));
    const links = canonicalLinks(textLinks(withheldFor(item, caller) ? forPublic(tree) : tree));
    const ready = v.status === 'draft' ? undefined : v.readyAt;
    /** @type {Map<string, Answer>} */
    const latest = new Map();
    for (const answer of v.answers) if (answer.readyAt === ready?.getTime() && !v.editors.has(answer.sub)) latest.set(answer.url, answer);
    return { actual, links, latest, hash: linksSha256(ready, links) };
  };
  /** @param {{ url: string, label: string, where: string }} link @param {Map<string, Answer>} latest */
  const linkMessage = (link, latest) => ({ ...link, loginWalled: loginWalled(link.url), answeredByLabel: latest.get(link.url)?.label ?? '', accepted: latest.get(link.url)?.yes === true });

  /** @param {Version} v @param {Targets} targets @param {string} editionId */
  const hashOf = (v, targets, editionId) => new Uint8Array(createHash('sha256').update(JSON.stringify([v.title, v.summary, v.visibility, v.markup, targets, editionId])).digest());

  /** A version as an officer reads it: with anything withheld, no markup and no hash. @param {Version} v @param {Caller} caller @param {boolean} withheld */
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
          // E4 (A1): what the reader may do, and who approved it.
          callerMayApprove: mayActOn(v, caller, withheld).approve,
          callerMayPublish: mayActOn(v, caller, withheld).publish,
          approvedAsLabel: v.approvedAsLabel ?? '',
          approvalKindSelf: v.approvalKind === 'self_breakglass' || v.approvalKind === 'self_single',
          ...(v.publishedAt ? { publishedAt: timestamp(v.publishedAt) } : {}),
          // E3 round 2: the base a form sends back.
          ...(v.updatedAt ? { updatedAt: timestamp(v.updatedAt) } : {}),
        });

  /** @param {Item} item @param {Caller} caller */
  const itemMessage = (item, caller) => ({
    id: item.id,
    slug: item.slug,
    kind: /** @type {ContentKind} */ (KIND_OUT[item.kind]),
    officeId: item.officeId,
    state: STATE_OUT[item.state],
    ...(item.live ? { live: versionMessage(item.live, caller, withheldFor(item, caller)) } : {}),
    ...(item.working ? { working: versionMessage(item.working, caller, withheldFor(item, caller)) } : {}),
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
    const version = { ...from, id: randomUUID(), number: from.number + 1, status: 'draft', editors: new Set(), sendBackNote: '', answers: [] };
    delete version.hash;
    delete version.readyAt;
    delete version.publishedAt;
    unclear(version);
    item.working = version;
    return version;
  };

  /**
   * Adds an item straight into a state, for the seeds (no history check, no caller).
   * @param {{ id?: string, slug: string, kind: string, officeId: string, state: Item['state'], title: string, summary?: string,
   *   visibility?: Version['visibility'], markup?: string, withheld?: boolean, officersOnly?: boolean, working?: boolean, sendBackNote?: string, editors?: string[],
   *   cleared?: boolean, change?: 'draft' | 'ready' | 'cleared', editionId?: string, newsletter?: boolean, approvedAs?: string, approvedBy?: string,
   *   selfApproved?: boolean, createdBy?: { sub: string, label: string } }} seed
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
      targets: { website: true, newsletter: seed.newsletter ?? false, email: false },
      editionId: seed.editionId ?? '',
      printAsIs: false,
      onBehalfOf: '',
      editors: new Set(seed.editors ?? []),
      sendBackNote: seed.sendBackNote ?? '',
      updatedAt: at,
      answers: [],
    };
    if (version.status !== 'draft') version.hash = hashOf(version, version.targets, version.editionId);
    if (version.status === 'ready' || version.status === 'cleared') version.readyAt = at;
    // E4: a seeded approval is a normal one by someone who is no caller here, unless it names its approver,
    // and a self-approval (the Admin's break-glass) when it says so.
    const approval = { approvalKind: seed.selfApproved ? 'self_breakglass' : 'normal', approvedBy: seed.approvedBy ?? 'seed:approver', approvedAsLabel: seed.approvedAs ?? 'Treasurer' };
    if (version.status === 'cleared') Object.assign(version, { approvedAt: at, ...approval });
    if (version.status === 'approved') Object.assign(version, { approvedAt: at, publishedAt: at, approvalKind: 'normal', approvedBy: 'seed:approver', approvedAsLabel: seed.approvedAs ?? 'Treasurer' });
    /** @type {Item} */
    const item = { id: seed.id ?? randomUUID(), slug: seed.slug, kind: seed.kind, officeId: seed.officeId, state: seed.state, updatedAt: at, withheld: seed.withheld ?? false, officersOnly: seed.officersOnly ?? false, history: [] };
    if (version.status === 'approved') item.live = version;
    else item.working = version;
    // E3 fix 1: a published item with a change being written (a draft) or waiting for approval.
    if (seed.change && item.live) {
      const change = newVersion(item);
      change.title = `${seed.title}, changed`;
      if (seed.change === 'ready' || seed.change === 'cleared') Object.assign(change, { status: 'ready', readyAt: at, hash: hashOf(change, change.targets, '') });
      if (seed.change === 'cleared') Object.assign(change, { status: 'cleared', approvedAt: at, ...approval });
    }
    // E4: who started it, by role, when the seed says (the Admin entering a piece for an office).
    if (seed.createdBy) item.history.push({ at, action: 'create', actorSubject: seed.createdBy.sub, actorLabel: seed.createdBy.label, actingOfficeId: item.officeId, versionNumber: 1, fromState: '', toState: 'draft', note: '' });
    if (seed.state === 'withdrawn') {
      item.withdrawnAt = at;
      // E4: who took it down, by role: its own office.
      item.history.push({ at, action: 'withdraw', actorSubject: 'seed:office', actorLabel: officeById(item.officeId)?.title ?? 'Officer', actingOfficeId: item.officeId, versionNumber: 0, fromState: 'published', toState: 'withdrawn', note: '' });
    }
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
      const item = { id: randomUUID(), slug: req.slug, kind, officeId: office.id, state: 'draft', updatedAt: now(), withheld: false, officersOnly: false, history: [] };
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
        updatedAt: item.updatedAt,
        answers: [],
      };
      items.set(item.id, item);
      record(item, caller, { action: 'create', versionNumber: 1, toState: 'draft' });
      return { item: itemMessage(item, caller) };
    },

    saveDraft: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const item = load(req.itemId);
      requireOffice(caller, item);
      // E3 round 2: a save from a base someone else has changed since writes nothing; an automatic save saves a draft only.
      const opened = /** @type {Version} */ (item.working ?? item.live);
      if (req.auto && item.working?.status !== 'draft') throw precondition('an automatic save only saves a draft');
      // One that carries exactly what is saved overwrites nobody: no conflict, nothing written, as in the API.
      if (req.baseUpdatedAt && msOf(req.baseUpdatedAt) !== opened.updatedAt?.getTime()) {
        const carriesSaved =
          opened.title === req.title.trim() && opened.summary === req.summary.trim() && opened.visibility === (VISIBILITY.get(req.visibility) ?? opened.visibility) && opened.markup === req.bodyMarkup;
        if (!carriesSaved) throw precondition(STALE_BASE);
        return { item: itemMessage(item, caller), problems: parseMarkup(opened.markup).problems };
      }
      const version = item.working ?? newVersion(item);
      const from = version.status;
      if (version.status === 'ready' || version.status === 'cleared') {
        if (version.printAsIs) throw precondition('a print-as-is version can be approved or sent back, never edited');
        // A1: an edit after approval voids it, and says so in the history first.
        if (version.status === 'cleared') record(item, caller, { action: 'approval_voided', versionNumber: version.number, fromState: 'cleared', toState: 'draft' });
        unclear(version);
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
      // Never the same time twice, so a base always tells two saves apart.
      const at = new Date(Math.max(now().getTime(), (version.updatedAt?.getTime() ?? 0) + 1));
      version.updatedAt = at;
      // Consecutive automatic saves by one person on one version within 10 minutes are one step, as in the API.
      const last = item.history.at(-1);
      const repeat =
        req.auto && last?.action === 'autosave' && last.actorSubject === caller.sub && last.versionNumber === version.number && version.updatedAt.getTime() - last.at.getTime() < 10 * 60_000;
      if (repeat) item.updatedAt = at;
      else record(item, caller, { action: req.auto ? 'autosave' : 'save', versionNumber: version.number, fromState: from, toState: 'draft' }, item.officeId, at);
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
      requireReviewer(caller);
      const note = req.note.trim();
      if (note === '' || note.length > MAX_NOTE) throw invalid('a note for the author is required');
      const acting = actingOffice(caller, req.actingAsOfficeId ?? '');
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'ready' && version?.status !== 'cleared') throw precondition('only a version waiting for approval, or approved and not yet published, can be sent back');
      const from = version.status;
      unclear(version);
      version.sendBackNote = note;
      if (item.state === 'ready') item.state = 'draft';
      record(item, caller, { action: 'send_back', versionNumber: version.number, fromState: from, toState: 'draft', note }, acting);
      return { item: itemMessage(item, caller) };
    },

    approve: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const roles = requireReviewer(caller);
      const acting = actingOffice(caller, req.actingAsOfficeId ?? '');
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'ready') throw precondition('only a ready version can be approved');
      requireWholeView(item, caller, 'approve it');
      if (version.hash === undefined || Buffer.compare(Buffer.from(req.contentHash), Buffer.from(version.hash)) !== 0) {
        throw new ConnectError('the version changed since it was opened; reload it', Code.Aborted);
      }
      /** @type {'normal' | 'self_breakglass' | 'self_single'} */
      let kind = 'normal';
      let note = '';
      if (version.editors.has(caller.sub)) {
        if (req.breakGlass) {
          if (!roles.admin) throw new ConnectError('only the Admin may approve their own edit', Code.PermissionDenied);
          note = req.breakGlassReason.trim();
          if (note === '' || note.length > MAX_NOTE) throw invalid('a break-glass approval needs a written reason');
          kind = 'self_breakglass';
        } else if (ruleFor(caller.sub) === 'one_approver' && (roles.admin || roles.webmaster)) kind = 'self_single';
        else throw new ConnectError('you edited this version; a second officer must approve it', Code.PermissionDenied);
      }
      const targets = req.targets ? { website: req.targets.website, newsletter: req.targets.newsletter, email: req.targets.email } : version.targets;
      if (version.visibility === 'officers' && (targets.newsletter || targets.email)) throw invalid('an officers-only item cannot go to the newsletter or email');
      const editionId = req.editionId === '' ? version.editionId : req.editionId;
      const frozen = frozenTitle({ ...version, targets, editionId });
      if (frozen !== undefined) throw precondition(`${frozen} is already frozen for print: pick an open edition, then approve`);
      const changedTargets = JSON.stringify(targets) !== JSON.stringify(version.targets);
      const changedEdition = editionId !== version.editionId;
      // A3b's gate, break-glass included, on the list as it is; its refusal names or counts only the links
      // the caller sees whole, a no first, and says OFFICERS_ONLY once for the rest (item-links.ts linkGate).
      const { actual, links, latest } = linksOf(item, version, caller);
      const urls = [...new Set(actual.map((l) => l.url))];
      const refused = urls.filter((url) => latest.get(url)?.yes === false);
      const unchecked = urls.filter((url) => loginWalled(url) && latest.get(url)?.yes !== true);
      if (refused.length > 0 || unchecked.length > 0) {
        const seen = new Set(links.map((l) => l.url));
        const shownRefused = refused.filter((url) => seen.has(url));
        const shownUnchecked = unchecked.filter((url) => seen.has(url));
        const hidden = shownRefused.length < refused.length || shownUnchecked.length < unchecked.length;
        const named = shownRefused.length > 0 ? refusedMessage(shownRefused) : shownUnchecked.length > 0 ? uncheckedMessage(shownUnchecked.length) : undefined;
        throw precondition(named === undefined ? OFFICERS_ONLY : hidden ? `${named}. ${OFFICERS_ONLY}` : named);
      }
      if (changedTargets) record(item, caller, { action: 'targets_changed', versionNumber: version.number }, acting);
      if (changedEdition) record(item, caller, { action: 'edition_changed', versionNumber: version.number }, acting);
      Object.assign(version, { status: 'cleared', targets, editionId, approvedAt: now(), approvalKind: kind, approvedBy: caller.sub, approvedAsLabel: labelOf(caller, item, acting) });
      if (changedTargets || changedEdition) version.hash = hashOf(version, targets, editionId);
      const action = kind === 'self_breakglass' ? 'approve_self' : kind === 'self_single' ? 'approve_single' : 'approve';
      record(item, caller, { action, versionNumber: version.number, fromState: 'ready', toState: 'cleared', note }, acting);
      return { item: itemMessage(item, caller) };
    },

    publish: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requirePublisher(caller);
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'cleared') throw precondition('only an approved version can be published');
      requireWholeView(item, caller, 'publish it');
      if (Buffer.compare(Buffer.from(req.contentHash), Buffer.from(/** @type {Uint8Array} */ (version.hash))) !== 0) {
        throw new ConnectError('the version changed since it was opened; reload it', Code.Aborted);
      }
      if (item.state === 'withdrawn' && !req.republishWithdrawn) throw precondition('this item was taken down: publishing puts it back on the website, so confirm that first');
      const frozen = frozenTitle(version);
      if (frozen !== undefined) throw precondition(`${frozen} is already frozen for print: send it back to pick an open edition`);
      const self = version.approvalKind === 'self_breakglass' || version.approvalKind === 'self_single';
      if (self && version.approvedBy === caller.sub) throw new ConnectError('you approved your own change; someone else must publish it', Code.PermissionDenied);
      if (version.approvalKind === 'self_single' && ruleFor(version.approvedBy ?? '') !== 'one_approver') throw precondition('the approval rule changed; send it back');
      if (item.live) item.live.status = 'superseded';
      Object.assign(version, { status: 'approved', publishedAt: now() });
      item.live = version;
      delete item.working;
      delete item.withdrawnAt;
      item.state = 'published';
      // Publish records no acting office: "Webmaster", or "Admin" as backup.
      record(item, caller, { action: 'publish', versionNumber: version.number, fromState: 'cleared', toState: 'published' }, '');
      return { item: itemMessage(item, caller) };
    },

    getItemLinks: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      const roles = rolesOf(caller);
      const reviewer = roles.officer || roles.admin || roles.webmaster;
      if (!reviewer && roles.offices.length === 0) throw notFound();
      // A3b fix round: a holder who reviews nothing gets the same answer for a missing item as for another office's.
      if (!reviewer && !roles.offices.includes(officeById(items.get(req.itemId)?.officeId ?? '')?.slug ?? '')) throw denied();
      const item = load(req.itemId);
      const version = /** @type {Version} */ (item.working ?? item.live);
      const { links, latest, hash } = linksOf(item, version, caller);
      const readyAt = version.status === 'draft' ? undefined : version.readyAt;
      return { linksSha256: hash, links: links.map((l) => linkMessage(l, latest)), ...(readyAt ? { readyAt: timestamp(readyAt) } : {}) };
    },

    confirmLinks: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReviewer(caller);
      if (req.answers.length === 0) throw invalid('no answers were given');
      if (req.answers.length > MAX_ANSWERS) throw invalid(`at most ${MAX_ANSWERS} answers at a time`);
      /** @type {Map<string, { yes: boolean, note: string }>} */
      const answers = new Map();
      for (const answer of req.answers) {
        const note = answer.note.trim();
        if (note.length > MAX_NOTE) throw invalid(`a note is at most ${MAX_NOTE} characters`);
        answers.set(answer.url, { yes: answer.yes, note });
      }
      const acting = actingOffice(caller, req.actingAsOfficeId ?? '');
      const item = load(req.itemId);
      const version = item.working;
      if (version?.status !== 'ready') throw precondition('only a version waiting for approval has its links checked');
      requireWholeView(item, caller, 'check its links');
      if (version.editors.has(caller.sub)) throw new ConnectError('you edited this version; a second officer must check its links', Code.PermissionDenied);
      const { actual, links, hash } = linksOf(item, version, caller);
      if (Buffer.compare(Buffer.from(req.linksSha256), Buffer.from(hash)) !== 0) throw precondition(LINKS_CHANGED);
      // Kept only for an address in both lists: what a reviewer could not see whole, they cannot vouch for.
      const whole = new Set(actual.map((l) => l.url));
      const inPiece = new Set(links.map((l) => l.url).filter((url) => whole.has(url)));
      /** @type {string[]} */
      const notInPiece = [];
      let kept = 0;
      for (const [url, answer] of answers) {
        if (url.length > MAX_URL_LENGTH || !inPiece.has(url)) {
          notInPiece.push(url);
          continue;
        }
        version.answers.push({ url, yes: answer.yes, note: answer.note, sub: caller.sub, label: labelOf(caller, item, acting), readyAt: /** @type {Date} */ (version.readyAt).getTime() });
        kept += 1;
      }
      if (kept > 0) record(item, caller, { action: 'links_confirmed', versionNumber: version.number }, acting);
      const { latest } = linksOf(item, version, caller);
      return { links: links.map((l) => linkMessage(l, latest)), notInPiece };
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
      // A1 (S1): a change approved and waiting to be published is voided, so no Publish quietly undoes the takedown.
      if (item.working?.status === 'cleared') {
        unclear(item.working);
        record(item, caller, { action: 'approval_voided', versionNumber: item.working.number, fromState: 'cleared', toState: 'draft' });
      }
      return { item: itemMessage(item, caller) };
    },

    listWorkingItems: async (/** @type {any} */ req, /** @type {import('@connectrpc/connect').HandlerContext} */ ctx) => {
      const caller = await callerOf(ctx);
      requireReader(caller);
      /** @type {string[]} */
      // A1: version_statuses names the working version's status; else states names draft and ready; else all
      // three (draft, ready, cleared). E3 fix 1: published and withdrawn in states name the item's state,
      // read only when version_statuses is empty.
      const named = req.states.map((/** @type {number} */ s) => STATE_IN.get(s));
      const byVersion = (req.versionStatuses ?? []).length > 0;
      const states = byVersion
        ? req.versionStatuses.map((/** @type {number} */ s) => STATUS_IN.get(s)).filter(Boolean)
        : req.states.length === 0
          ? ['draft', 'ready', 'cleared']
          : named.filter((s) => s === 'draft' || s === 'ready');
      /** @type {string[]} */
      const itemStates = byVersion ? [] : named.filter((s) => s === 'published' || s === 'withdrawn');
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
      const membersBody = version.visibility === 'officers' ? undefined : withheldFor(item, caller) ? { blocks: forPublic(tree.blocks) } : tree;
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
