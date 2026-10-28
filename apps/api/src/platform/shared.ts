// ============================================================================
// The ONE seam onto @figurecollecting/fc-shared (R15). Every other module
// imports the shared logging, tracing and redaction baseline from here, never
// from the package; shared.test.ts enforces that.
//
// The imports are the stateless 1.7.0 SUBPATHS, never the barrel: the barrel is
// one bundle that also carries fc's axios client and zustand stores, which a
// Postgres-only gRPC service must not load.
//
// fc-shared is consumed as a VENDORED tarball (vendor/, see its README): this
// repo has no token for the FigureCollecting package registry yet. The tarball
// is the registry artifact byte for byte, so its lockfile integrity matches.
// ============================================================================
import {
  DEFAULT_SECRET_VALUE_PATTERNS as SHARED_SECRET_VALUE_PATTERNS,
  DEFAULT_SENSITIVE_KEY_PATTERN as SHARED_SENSITIVE_KEY_PATTERN,
  type RedactOptions,
} from '@figurecollecting/fc-shared/utils/sanitize';

export { getActiveTraceIds } from '@figurecollecting/fc-shared/utils/trace';
export { redactAttributes, redactString, redactValue } from '@figurecollecting/fc-shared/utils/sanitize';
export { sanitizeLogValue } from '@figurecollecting/fc-shared/utils/logger';
export type { AttributeValue, RedactOptions } from '@figurecollecting/fc-shared/utils/sanitize';

// ---------------------------------------------------------------------------
// LOCAL EXTENSION: the site's own sensitive keys.
//
// Officer-report text must never reach a log (R15), and member names and
// emails have no business there either. The structural defence is that nothing
// logs a request message at all (grpc/interceptors.ts); this pattern is the
// second line, for the day someone logs an object that happens to carry one.
//
// Anchored to the FINAL key segment, so `body` and `request.body` are caught
// while counters such as `body_count` stay legible. Composed from the shared
// source, so a future fc-shared pattern is inherited automatically.
// ---------------------------------------------------------------------------
const SITE_KEYS = [
  'body',
  'body_src',
  'body_ast',
  'public_ast',
  'markup',
  'note',
  'approval_reason',
  'email',
  'display_name',
  // Sign-up: typed by the member, read only by the verifier (R33).
  'membership_number',
  'membershipnumber',
  'membership_no',
  'last_name',
  'lastname',
  'break_glass_reason',
  // Member names, however a caller spells them. A bare `name` is NOT here: the
  // logger's own `name` field and many non-personal names would vanish.
  'first_name',
  'firstname',
  'given_name',
  'givenname',
  'family_name',
  'familyname',
  'surname',
  'full_name',
  'fullname',
  'member_name',
  'membername',
  'legal_name',
  'legalname',
  // A contributor's name and role, typed by an officer (content.proto).
  'on_behalf_of',
  // Contact. `address` also catches business_address and home_address; the
  // camelCase `remoteAddress` has no separator before it and stays legible.
  'phone',
  'phone_number',
  'phonenumber',
  'telephone',
  'mobile',
  'address',
  'homeaddress',
  'streetaddress',
  'mailingaddress',
  // Identity numbers and dates.
  'member_number',
  'membernumber',
  'member_no',
  'member_id',
  'memberid',
  'mensa_number',
  'mensanumber',
  'mensa_no',
  'birth_date',
  'birthdate',
  'date_of_birth',
  'dateofbirth',
  'dob',
  'birthday',
  // Report and marked text: what an officer wrote, and the passage a redaction
  // mark quotes (redaction.proto).
  'content',
  'content_json',
  'report',
  'report_body',
  'report_text',
  'text',
  'quote',
  'notes',
];

export const NWFL_SENSITIVE_KEY_PATTERN = new RegExp(
  `${SHARED_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])(?:${SITE_KEYS.join('|')})$`,
  'i',
);

/**
 * An email address inside a free-text value. Bounded quantifiers (RFC 5321
 * limits: 64-char local part, 63-char labels) keep the scan linear on a long
 * string that has no `@`. Deliberately loose: an over-mask costs a log word, a
 * miss costs a member's address.
 */
export const EMAIL_VALUE_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

/** Pass these wherever fc-shared redaction is invoked from this service. */
export const NWFL_REDACT_OPTIONS: RedactOptions = {
  sensitiveKeyPattern: NWFL_SENSITIVE_KEY_PATTERN,
  secretValuePatterns: [...SHARED_SECRET_VALUE_PATTERNS, EMAIL_VALUE_PATTERN],
};
