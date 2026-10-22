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
  DEFAULT_SENSITIVE_KEY_PATTERN as SHARED_SENSITIVE_KEY_PATTERN,
  type RedactOptions,
} from '@figurecollecting/fc-shared/utils/sanitize';

export { getActiveTraceIds } from '@figurecollecting/fc-shared/utils/trace';
export { redactAttributes, redactValue } from '@figurecollecting/fc-shared/utils/sanitize';
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
];

export const NWFL_SENSITIVE_KEY_PATTERN = new RegExp(
  `${SHARED_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])(?:${SITE_KEYS.join('|')})$`,
  'i',
);

/** Pass these wherever fc-shared redaction is invoked from this service. */
export const NWFL_REDACT_OPTIONS: RedactOptions = {
  sensitiveKeyPattern: NWFL_SENSITIVE_KEY_PATTERN,
};
