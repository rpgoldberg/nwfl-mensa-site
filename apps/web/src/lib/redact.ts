// LG-N3: the site redactor on the web side. The same fc-shared (the API's vendored 1.7.0 tarball,
// bundled into the server build) with the same site keys and email pattern, read from the API's
// own module (apps/api/src/platform/site-redaction.ts), so the two services cannot drift apart.
import { DEFAULT_SECRET_VALUE_PATTERNS, DEFAULT_SENSITIVE_KEY_PATTERN, redactString } from '@figurecollecting/fc-shared/utils/sanitize';
import { siteRedactOptions } from '../../../api/src/platform/site-redaction';

export const SITE_REDACT_OPTIONS = siteRedactOptions({ sensitiveKeyPattern: DEFAULT_SENSITIVE_KEY_PATTERN, secretValuePatterns: DEFAULT_SECRET_VALUE_PATTERNS });

/** Free text (an error's) with secret shapes and email addresses masked, then cut to `max` characters. */
export function redactText(text: string, max = 200): string {
  return redactString(text, SITE_REDACT_OPTIONS).slice(0, max);
}
