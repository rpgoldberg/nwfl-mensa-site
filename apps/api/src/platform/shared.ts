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
import { siteRedactOptions } from './site-redaction.js';

export { getActiveTraceIds } from '@figurecollecting/fc-shared/utils/trace';
export { redactAttributes, redactString, redactValue } from '@figurecollecting/fc-shared/utils/sanitize';
export { sanitizeLogValue } from '@figurecollecting/fc-shared/utils/logger';
export type { AttributeValue, RedactOptions } from '@figurecollecting/fc-shared/utils/sanitize';

// The site's own keys and email pattern live in site-redaction.ts (no imports,
// so the web shares them); they are composed with the shared source here.
export { EMAIL_VALUE_PATTERN, SITE_KEYS } from './site-redaction.js';

const SITE_OPTIONS = siteRedactOptions({
  sensitiveKeyPattern: SHARED_SENSITIVE_KEY_PATTERN,
  secretValuePatterns: SHARED_SECRET_VALUE_PATTERNS,
});

export const NWFL_SENSITIVE_KEY_PATTERN: RegExp = SITE_OPTIONS.sensitiveKeyPattern;

/** Pass these wherever fc-shared redaction is invoked from this service. */
export const NWFL_REDACT_OPTIONS: RedactOptions = SITE_OPTIONS;
