// scripts/buf-breaking.sh compares the protos with a base commit. In the
// monorepo the API lives under apps/api, so the script must find buf.yaml and
// the module there, not at the top of the repository: a base it cannot read
// would otherwise be a silent skip.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('buf-breaking.sh', () => {
  it('compares against a base that has the module under apps/api, and finds nothing broken against itself', async () => {
    const result = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile('sh', ['scripts/buf-breaking.sh', 'HEAD'], { cwd: REPO, timeout: 120_000 }, (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : 1, out: `${stdout}${stderr}` }),
      ),
    );
    expect(result.out).not.toContain('SKIP');
    expect(result.code, result.out).toBe(0);
  });
});
