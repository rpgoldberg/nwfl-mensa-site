import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildInfoIntegration, readBuildInfo } from '../build-info.mjs';

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? os.tmpdir(), 'nwfl-build-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildInfoIntegration', () => {
  it('writes dist/build.json beside the client folder, saying whether the build is public-only', async () => {
    for (const [flag, publicOnly] of [['true', true], ['false', false], [undefined, false]] as const) {
      const root = scratch();
      const hook = buildInfoIntegration({ PUBLIC_ONLY: flag }).hooks['astro:build:done'];
      await hook({ dir: pathToFileURL(`${root}/client/`) } as never);
      expect(JSON.parse(readFileSync(`${root}/build.json`, 'utf8')), String(flag)).toEqual({ publicOnly });
    }
  });
});

describe('readBuildInfo', () => {
  it('reads the flag the build wrote', async () => {
    expect(await readBuildInfo(new URL('./fixtures/build-public-only.json', import.meta.url))).toEqual({ publicOnly: true });
  });

  it('takes a missing file, or any other value, as a full build', async () => {
    const root = scratch();
    expect(await readBuildInfo(pathToFileURL(`${root}/none.json`))).toEqual({ publicOnly: false });
    writeFileSync(`${root}/odd.json`, '{ "publicOnly": "yes" }');
    expect(await readBuildInfo(pathToFileURL(`${root}/odd.json`))).toEqual({ publicOnly: false });
  });
});
