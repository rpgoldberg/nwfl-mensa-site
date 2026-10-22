import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NWFL_REDACT_OPTIONS, NWFL_SENSITIVE_KEY_PATTERN, redactValue } from './shared.js';

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
  it.each(['body', 'body_src', 'body_ast', 'public_ast', 'request.body', 'note', 'approval_reason', 'email', 'display_name', 'password', 'token'])(
    'redacts the value under %s',
    (key) => {
      expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(true);
    },
  );

  it.each(['rpc', 'code', 'duration_ms', 'body_count', 'notes_total', 'service'])('keeps %s legible', (key) => {
    expect(NWFL_SENSITIVE_KEY_PATTERN.test(key)).toBe(false);
  });

  it('applies through redactValue with the service options', () => {
    const out = redactValue({ body: 'Treasurer report text', rpc: 'x/Y' }, NWFL_REDACT_OPTIONS) as Record<string, unknown>;
    expect(out['body']).toBe('[REDACTED]');
    expect(out['rpc']).toBe('x/Y');
  });
});
