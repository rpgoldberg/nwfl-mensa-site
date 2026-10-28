import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NWFL_REDACT_OPTIONS, NWFL_SENSITIVE_KEY_PATTERN, redactString, redactValue } from './shared.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'gen' ? [] : sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('the fc-shared seam', () => {
  it('is the only module that imports @figurecollecting/fc-shared', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('@figurecollecting/fc-shared'))
      .map((file) => path.relative(SRC, file));
    expect(importers).toEqual([path.join('platform', 'shared.ts')]);
  });

  it('imports the stateless subpaths, never the barrel that bundles axios and zustand', () => {
    const seam = readFileSync(path.join(SRC, 'platform', 'shared.ts'), 'utf8');
    expect(seam).not.toMatch(/from '@figurecollecting\/fc-shared'/);
    expect(seam).toMatch(/fc-shared\/utils\/sanitize'/);
    expect(seam).toMatch(/fc-shared\/utils\/trace'/);
    expect(seam).toMatch(/fc-shared\/utils\/logger'/);
  });
});

describe('NWFL_SENSITIVE_KEY_PATTERN', () => {
  it.each(['body', 'body_src', 'body_ast', 'public_ast', 'request.body', 'note', 'approval_reason', 'email', 'display_name', 'password', 'token', 'membership_number', 'pending.membership_number', 'last_name', 'body_markup', 'break_glass_reason', 'membershipNumber', 'pending.membershipNumber', 'lastName', 'membership_no'])(
    'redacts the value under %s',
    (key) => {
      expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
    },
  );

  it.each([
    // names
    'first_name', 'firstName', 'pending.firstName', 'given_name', 'family_name', 'surname', 'full_name', 'fullName', 'member_name', 'legal_name', 'on_behalf_of',
    // contact
    'phone', 'phone_number', 'member.phone', 'telephone', 'mobile', 'address', 'home_address', 'street_address', 'business_address', 'mailing_address',
    // identity numbers and dates
    'member_number', 'memberNumber', 'mensa_number', 'mensa_no', 'member_id', 'birth_date', 'birthdate', 'date_of_birth', 'dob', 'birthday',
    // report text and notes
    'content', 'content_json', 'report', 'report_body', 'report_text', 'text', 'quote', 'notes', 'status_note', 'accessibility_note',
  ])('redacts the member and report field %s', (key) => {
    expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(['remoteAddress', 'remote_ip', 'content_hash', 'content_type', 'text_length', 'phone_count', 'address_count', 'name', 'member_count', 'quote_count', 'reporting'])('still keeps %s legible', (key) => {
    expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(false);
  });

  it.each(['rpc', 'code', 'duration_ms', 'body_count', 'notes_total', 'service', 'verification', 'request_id', 'outcome'])('keeps %s legible', (key) => {
    expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(false);
  });

  it('applies through redactValue with the service options', () => {
    const out = redactValue({ body: 'Treasurer report text', rpc: 'x/Y' }, NWFL_REDACT_OPTIONS) as Record<string, unknown>;
    expect(out['body']).toBe('[REDACTED]');
    expect(out['rpc']).toBe('x/Y');
  });
});

describe('the email value pattern', () => {
  it('masks an address inside free text', () => {
    expect(redactString('write to jane.doe+mensa@example.org today', NWFL_REDACT_OPTIONS)).toBe('write to [REDACTED] today');
  });

  it('masks several, with subdomains and a trailing dot', () => {
    expect(redactString('a@example.org, c_d@example.net.', NWFL_REDACT_OPTIONS)).toBe('[REDACTED], [REDACTED].');
  });

  it('masks one inside a nested value', () => {
    const out = redactValue({ detail: { line: 'from j@example.org' } }, NWFL_REDACT_OPTIONS) as { detail: { line: string } };
    expect(out.detail.line).toBe('from [REDACTED]');
  });

  it('keeps the shared secret-shape patterns', () => {
    expect(redactString('Authorization: Bearer abc.def-ghi', NWFL_REDACT_OPTIONS)).not.toContain('abc.def-ghi');
  });

  it('leaves text without an address alone, including a bare @ and a handle', () => {
    expect(redactString('ping @jane at 5 @ noon, a@b', NWFL_REDACT_OPTIONS)).toBe('ping @jane at 5 @ noon, a@b');
  });

  it('stays fast on a long run of address characters with no @', () => {
    const started = Date.now();
    redactString('a'.repeat(8000), NWFL_REDACT_OPTIONS);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
