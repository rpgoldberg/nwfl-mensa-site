// SOLO-APPROVE: the words the officer pages use for the approval rule, and the Admin's switch form,
// checked here on the server (the page works with no script). The API holds the rule and refuses
// anyone but the Admin; the site hides the switch from everyone else as well.
import { ZONE } from './calendar';

export type Scope = 'content' | 'redaction_policy';
export type Rule = 'two_person' | 'one_approver';

/** One scope's rule, when the Admin set it (none while it is still the default), and which switch set it ('' for none). */
export interface Setting {
  scope: Scope;
  rule: Rule;
  setAt?: Date;
  revision: string;
}

export const SCOPES: readonly Scope[] = ['content', 'redaction_policy'];
export const RULES: readonly Rule[] = ['two_person', 'one_approver'];
export const SCOPE_LABEL: Record<Scope, string> = { content: 'Publishing content', redaction_policy: 'Loosening a public privacy setting' };
/**
 * W-SIGNUP fix 1: in each scope's own words. Content is approved by someone other than the writer (the
 * Admin or the Webmaster, apps/api src/content/workflow.ts), so it says "people"; a privacy setting
 * really is approved by another officer.
 */
export const RULE_LABEL: Record<Scope, Record<Rule, string>> = {
  content: { two_person: 'Two people: someone other than the writer approves (the Admin or the Webmaster)', one_approver: 'One person: the writer may approve their own edit' },
  redaction_policy: { two_person: 'Two officers: another officer approves', one_approver: 'One officer' },
};
/** The API takes 2000; a short reason is what the ledger needs, and the box says so. */
export const MAX_REASON = 500;

export const NOTE_UNKNOWN = 'We could not check the approval setting just now.';
const NOTE_LEAD: Record<Scope, string> = { content: 'One approver', redaction_policy: 'One approver for public privacy settings' };
/** Whose second approval is not required: a person's for content, an officer's for a privacy setting. */
const SECOND: Record<Scope, string> = { content: "a second person's", redaction_policy: "a second officer's" };

const DATE = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'long', day: 'numeric' });

/** A date as officers read it: "November 3, 2026", by the Central calendar. */
export function formatSetDate(at: Date): string {
  return DATE.format(at);
}

/**
 * The notes an officer sees where approval happens: one per scope set to one approver, content
 * first; none under the usual two-approver rule; and a plain line when the setting could not be read (undefined).
 */
export function notesFor(settings: readonly Omit<Setting, 'revision'>[] | undefined): string[] {
  if (settings === undefined) return [NOTE_UNKNOWN];
  return SCOPES.flatMap((scope) => {
    const setting = settings.find((s) => s.scope === scope);
    if (setting?.rule !== 'one_approver') return [];
    const when = setting.setAt === undefined ? '' : ` on ${formatSetDate(setting.setAt)}`;
    return [`${NOTE_LEAD[scope]}: ${SECOND[scope]} approval is not required right now (set by the Admin${when}).`];
  });
}

/** The Admin, by the internal group the session carries (server/groups.mjs). */
export function isAdmin(session: { groups: readonly string[] } | undefined): boolean {
  return session?.groups.includes('nwfl-admin') ?? false;
}

export interface RuleForm {
  step: 'review' | 'apply';
  scope: Scope;
  rule: Rule;
  reason: string;
  /** The revision the Admin read the setting at, carried by both steps: a switch since then refuses the change. */
  revision: string;
}

export type FormErrors = Partial<Record<'step' | 'scope' | 'rule' | 'reason', string>>;

export type ParsedForm = { ok: true; value: RuleForm } | { ok: false; scope: Scope | undefined; errors: FormErrors; values: { rule: string; reason: string } };

const isScope = (value: string | undefined): value is Scope => SCOPES.includes(value as Scope);
/** The API's revisions: a switch's id, lower-case, or '' for the default. */
const isRevision = (value: string | undefined): value is string => value !== undefined && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(value);
/** A reason says something: a letter in any alphabet, or a digit (as the API and 0023 check). */
const SAYS_SOMETHING = /[\p{Alphabetic}0-9]/u;
/** A control character but a tab or a line break (a NUL, an escape code): the API and 0023 refuse it. */
const CONTROL = /[^\P{Cc}\t\n\r]/u;
const isRule = (value: string | undefined): value is Rule => RULES.includes(value as Rule);

/** The switch form's fields, checked; each problem is said in words, by field. */
export function parseRuleForm(field: (name: string) => string | undefined): ParsedForm {
  const step = field('step');
  const scope = field('scope');
  const rule = field('rule');
  const reason = (field('reason') ?? '').trim();
  const revision = field('revision');
  const errors: FormErrors = {};
  if ((step !== 'review' && step !== 'apply') || !isRevision(revision)) errors.step = 'Send the form again.';
  if (!isScope(scope)) errors.scope = 'Choose what this is for.';
  if (!isRule(rule)) errors.rule = 'Choose who must approve.';
  if (!SAYS_SOMETHING.test(reason)) errors.reason = 'Write why you are making this change.';
  else if (reason.length > MAX_REASON) errors.reason = `Keep the reason to ${MAX_REASON} characters or fewer.`;
  else if (CONTROL.test(reason)) errors.reason = 'Type the reason again: it has a hidden character that cannot be kept.';
  if (Object.keys(errors).length > 0 || !isScope(scope) || !isRule(rule) || (step !== 'review' && step !== 'apply') || !isRevision(revision)) {
    return { ok: false, scope: isScope(scope) ? scope : undefined, errors, values: { rule: rule ?? '', reason } };
  }
  return { ok: true, value: { step, scope, rule, reason, revision } };
}

/** What the confirmation step says the change will do. */
export function confirmText(scope: Scope, rule: Rule): string {
  if (scope === 'content') {
    return rule === 'one_approver'
      ? "You are about to let the writer approve and publish their own edit without a second person's approval."
      : 'You are about to require someone other than the writer (the Admin or the Webmaster) to approve again before anything is published.';
  }
  return rule === 'one_approver'
    ? "You are about to let one officer loosen a public privacy setting without another officer's approval."
    : "You are about to require another officer's approval again before a public privacy setting is loosened.";
}

/** The outcome named by the address the page lands on after saving (?done=<scope>&changed=0|1). */
export function doneFromQuery(params: URLSearchParams): { scope: Scope; changed: boolean } | undefined {
  const scope = params.get('done') ?? undefined;
  const changed = params.get('changed');
  if (!isScope(scope) || (changed !== '0' && changed !== '1')) return undefined;
  return { scope, changed: changed === '1' };
}

export function doneText(changed: boolean): string {
  return changed ? 'Saved.' : 'No change: it was already set that way.';
}
