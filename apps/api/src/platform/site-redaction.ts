// ============================================================================
// The site's own redaction keys and value pattern, with NO imports, so the web
// (apps/web/src/lib/redact.ts) composes the very same options with fc-shared
// as this service does (platform/shared.ts). One list, two services (LG-N3).
// ============================================================================

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
// source (siteRedactOptions), so a future fc-shared pattern is inherited
// automatically.
// ---------------------------------------------------------------------------
export const SITE_KEYS: readonly string[] = [
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

/**
 * An email address inside a free-text value. Bounded quantifiers (RFC 5321
 * limits: 64-char local part, 63-char labels) keep the scan linear on a long
 * string that has no `@`. Deliberately loose: an over-mask costs a log word, a
 * miss costs a member's address.
 */
export const EMAIL_VALUE_PATTERN = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/g;

/** The redaction options the site passes to fc-shared, from fc-shared's own defaults. */
export function siteRedactOptions(shared: { sensitiveKeyPattern: RegExp; secretValuePatterns: readonly RegExp[] }): {
  sensitiveKeyPattern: RegExp;
  secretValuePatterns: RegExp[];
} {
  return {
    sensitiveKeyPattern: new RegExp(`${shared.sensitiveKeyPattern.source}|(?:^|[.\\-_])(?:${SITE_KEYS.join('|')})$`, 'i'),
    secretValuePatterns: [...shared.secretValuePatterns, EMAIL_VALUE_PATTERN],
  };
}
