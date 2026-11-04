// SOLO-APPROVE: the words the officer pages use for the approval rule, and the Admin's switch form,
// checked here on the server (the page works with no script). The API holds the rule and refuses
// anyone but the Admin; the site hides the switch from everyone else as well.
import { ZONE } from './calendar';

export type Scope = 'content' | 'redaction_policy';
export type Rule = 'two_person' | 'one_approver';

/** One scope's rule, and when the Admin set it (none while it is still the default). */
export interface Setting {
  scope: Scope;
  rule: Rule;
  setAt?: Date;
}

export const SCOPES: readonly Scope[] = ['content', 'redaction_policy'];
export const RULES: readonly Rule[] = ['two_person', 'one_approver'];
export const SCOPE_LABEL: Record<Scope, string> = { content: 'Publishing content', redaction_policy: 'Loosening a public privacy setting' };
export const RULE_LABEL: Record<Rule, string> = { two_person: 'Two officers (a second officer approves)', one_approver: 'One officer' };
/** The API takes 2000; a short reason is what the ledger needs, and the box says so. */
export const MAX_REASON = 500;

export const NOTE_UNKNOWN = 'We could not check the approval setting just now.';
const NOTE_LEAD: Record<Scope, string> = { content: 'One approver', redaction_policy: 'One approver for public privacy settings' };

const DATE = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'long', day: 'numeric' });

/** A date as officers read it: "November 3, 2026", by the Central calendar. */
export function formatSetDate(at: Date): string {
  return DATE.format(at);
}

/**
 * The notes an officer sees where approval happens: one per scope set to one approver, content
 * first; none under two officers; and a plain line when the setting could not be read (undefined).
 */
export function notesFor(settings: readonly Setting[] | undefined): string[] {
  if (settings === undefined) return [NOTE_UNKNOWN];
  return SCOPES.flatMap((scope) => {
    const setting = settings.find((s) => s.scope === scope);
    if (setting?.rule !== 'one_approver') return [];
    const when = setting.setAt === undefined ? '' : ` on ${formatSetDate(setting.setAt)}`;
    return [`${NOTE_LEAD[scope]}: a second officer's approval is not required right now (set by the Admin${when}).`];
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
}

export type FormErrors = Partial<Record<'step' | 'scope' | 'rule' | 'reason', string>>;

export type ParsedForm = { ok: true; value: RuleForm } | { ok: false; scope: Scope | undefined; errors: FormErrors; values: { rule: string; reason: string } };

const isScope = (value: string | undefined): value is Scope => SCOPES.includes(value as Scope);
const isRule = (value: string | undefined): value is Rule => RULES.includes(value as Rule);

/** The switch form's fields, checked; each problem is said in words, by field. */
export function parseRuleForm(field: (name: string) => string | undefined): ParsedForm {
  const step = field('step');
  const scope = field('scope');
  const rule = field('rule');
  const reason = (field('reason') ?? '').trim();
  const errors: FormErrors = {};
  if (step !== 'review' && step !== 'apply') errors.step = 'Send the form again.';
  if (!isScope(scope)) errors.scope = 'Choose what this is for.';
  if (!isRule(rule)) errors.rule = 'Choose two officers or one officer.';
  if (reason === '') errors.reason = 'Write why you are making this change.';
  else if (reason.length > MAX_REASON) errors.reason = `Keep the reason to ${MAX_REASON} characters or fewer.`;
  if (Object.keys(errors).length > 0 || !isScope(scope) || !isRule(rule) || (step !== 'review' && step !== 'apply')) {
    return { ok: false, scope: isScope(scope) ? scope : undefined, errors, values: { rule: rule ?? '', reason } };
  }
  return { ok: true, value: { step, scope, rule, reason } };
}

/** What the confirmation step says the change will do. */
export function confirmText(scope: Scope, rule: Rule): string {
  if (scope === 'content') {
    return rule === 'one_approver'
      ? 'You are about to let one officer publish without a second approval.'
      : "You are about to require a second officer's approval again before anything is published.";
  }
  return rule === 'one_approver'
    ? 'You are about to let one officer loosen a public privacy setting without a second approval.'
    : "You are about to require a second officer's approval again before a public privacy setting is loosened.";
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
