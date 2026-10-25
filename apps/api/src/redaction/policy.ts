// ============================================================================
// The redaction policy, as pure functions (REDACT R1). A policy maps an
// audience and a category of personal data to an action. Text is shown,
// redacted or hidden; an image is shown, blurred or hidden, whole. It fails
// closed: a missing cell, an unknown audience or category, or an action the
// category does not allow resolves to HIDE, the strictest action for both.
//
// A change that loosens the public audience needs a second officer
// (redaction/service.ts); the database holds the same rule (0012).
// ============================================================================

/** The one group this deployment serves (0012's tenant row). Never taken from a caller. */
export const TENANT = 'nwflorida';

export const AUDIENCES = ['public', 'members', 'officers'] as const;
export type PolicyAudience = (typeof AUDIENCES)[number];

export const CATEGORIES = [
  'member_name',
  'member_address',
  'member_phone',
  'member_email',
  'private_venue',
  'business_venue',
  'officer_contact',
  'image',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Action = 'show' | 'redact' | 'blur' | 'hide';

const TEXT_ACTIONS: readonly Action[] = ['show', 'redact', 'hide'];
const IMAGE_ACTIONS: readonly Action[] = ['show', 'blur', 'hide'];

/** The actions a category allows, least strict first. */
export const actionsFor = (category: Category): readonly Action[] => (category === 'image' ? IMAGE_ACTIONS : TEXT_ACTIONS);

/** A policy's cells, keyed by cellKey(audience, category). Values are as stored, unchecked. */
export type Policy = ReadonlyMap<string, string>;

export const cellKey = (audience: string, category: string): string => `${audience}/${category}`;

const isAudience = (value: string): value is PolicyAudience => (AUDIENCES as readonly string[]).includes(value);
const isCategory = (value: string): value is Category => (CATEGORIES as readonly string[]).includes(value);

/** The action a category allows, or HIDE for anything else. */
function allowed(category: Category, value: string | undefined): Action {
  return actionsFor(category).find((action) => action === value) ?? 'hide';
}

/** What the policy says for this audience and category; HIDE when it says nothing valid. */
export function resolveAction(policy: Policy, audience: string, category: string): Action {
  if (!isAudience(audience) || !isCategory(category)) return 'hide';
  return allowed(category, policy.get(cellKey(audience, category)));
}

/** Whether moving from `from` (as stored; unknown reads as HIDE) to `to` is less strict. */
export function loosens(category: Category, from: string, to: Action): boolean {
  const order = actionsFor(category);
  return order.indexOf(to) < order.indexOf(allowed(category, from));
}

/** A loosening of the public audience waits for a second officer; anything else applies at once. */
export const needsSecondOfficer = (audience: PolicyAudience, category: Category, from: string, to: Action): boolean =>
  audience === 'public' && loosens(category, from, to);
