// One source of truth for the API contract: the protos in apps/api/proto.
// The site's client code (src/gen) is generated from them by buf.gen.yaml and
// committed; this regenerates it and fails on any difference, so a changed
// proto cannot leave the site reading an old shape. web.yml runs on a proto
// change for the same reason.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const out = mkdtempSync(path.join(os.tmpdir(), 'nwfl-proto-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const files = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(js|d\.ts)$/.test(f)).sort();

describe('src/gen', () => {
  it('is exactly what buf generates from the API protos', () => {
    const bin = path.resolve('node_modules/.bin');
    execFileSync(path.join(bin, 'buf'), ['generate', '-o', out], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH']}` }, stdio: 'pipe' });
    const fresh = path.join(out, 'src/gen');
    expect(files('src/gen')).toEqual(files(fresh));
    for (const file of files(fresh)) expect(readFileSync(path.join('src/gen', file), 'utf8'), file).toBe(readFileSync(path.join(fresh, file), 'utf8'));
  }, 60_000);

  it('holds the read side the site uses, and nothing it should not call', () => {
    expect(files('src/gen').filter((f) => f.endsWith('.js'))).toEqual(['nwfl/mensa/v1/common_pb.js', 'nwfl/mensa/v1/content_pb.js', 'nwfl/mensa/v1/edition_pb.js', 'nwfl/mensa/v1/event_pb.js', 'nwfl/mensa/v1/roster_pb.js']);
  });
});
