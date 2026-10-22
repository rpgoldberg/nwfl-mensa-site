// The calendar and roster seed (P13): business venues only, no personal
// contacts, read from a file OUTSIDE the repository, applied in one
// transaction, idempotent, and audited.
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentService } from '../../src/gen/nwfl/mensa/v1/content_pb.js';
import { EventService } from '../../src/gen/nwfl/mensa/v1/event_pb.js';
import { SeedError, applySeed, assertOutsideRepo, parseSeed, runSeed } from '../../src/seed/seed.js';
import { type Api, startApi } from '../helpers/api.js';
import { APP, APP_PW, live, urlFor } from '../helpers/pg.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = path.join(REPO, 'test', 'fixtures', 'seed.example.json');
const example = (): Record<string, unknown> => JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

describe('parseSeed', () => {
  it('reads the example file', () => {
    const seed = parseSeed(example());
    expect([seed.offices.length, seed.terms.length, seed.venues.length, seed.series.length, seed.occurrences.length]).toEqual([5, 5, 3, 5, 2]);
  });

  it.each([
    ["a member's home as a venue", { venues: [{ name: 'Host home', kind: 'member_home', area: 'bay' }] }, /venues\[0\]\.kind/],
    ['a phone number field', { venues: [{ name: 'Cafe', kind: 'business', area: 'bay', phone: '850-555-0100' }] }, /venues\[0\]: unknown field phone/],
    ['an email field on a term', { terms: [{ office: 'president', holder: 'Pat Example', startsOn: '2026-10-01', status: 'active', email: 'pat@example.org' }] }, /terms\[0\]: unknown field email/],
    ['a missing required field', { offices: [{ slug: 'president', kind: 'elected' }] }, /offices\[0\]\.title/],
    ['a wrong type', { series: [{ slug: 'x', title: 'X', category: 'lunch', recurrence: 'FREQ=WEEKLY', startsOn: 20260101, area: 'bay' }] }, /series\[0\]\.startsOn/],
    ['a rule the calendar cannot expand', { series: [{ slug: 'x', title: 'X', category: 'lunch', recurrence: 'FREQ=DAILY', startsOn: '2026-01-01', area: 'bay' }] }, /series\[0\]\.recurrence/],
    ['an unknown section', { members: [] }, /unknown section members/],
    ['a list that is not a list', { offices: {} }, /offices must be a list/],
    ['a file that is not an object', [], /a JSON object/],
    ['a row that is not an object', { terms: ['president'] }, /terms\[0\] must be an object/],
    ['a date the calendar does not have', { terms: [{ office: 'president', startsOn: '2026-02-30', status: 'vacant' }] }, /terms\[0\]\.startsOn/],
    ['a time that is not HH:MM', { series: [{ slug: 'x', title: 'X', category: 'lunch', recurrence: 'FREQ=WEEKLY', startsOn: '2026-01-01', defaultStart: '25:00', area: 'bay' }] }, /defaultStart/],
    ['an instant without a zone', { occurrences: [{ title: 'X', startsAt: '2026-11-14T17:00:00' }] }, /startsAt/],
    ['a __proto__ field', JSON.parse('{"venues": [{"name": "Cafe", "kind": "business", "area": "bay", "__proto__": {"x": 1}}]}') as unknown, /venues\[0\]: unknown field __proto__/],
    ['a constructor field', { venues: [{ name: 'Cafe', kind: 'business', area: 'bay', constructor: 'x' }] }, /venues\[0\]: unknown field constructor/],
    ['a toString field', { offices: [{ slug: 'p', title: 'P', kind: 'elected', toString: 'x' }] }, /offices\[0\]: unknown field toString/],
    ['a __proto__ section', JSON.parse('{"__proto__": []}') as unknown, /unknown section __proto__/],
  ])('refuses %s', (_label, json, message) => {
    expect(() => parseSeed(json)).toThrow(SeedError);
    expect(() => parseSeed(json)).toThrow(message);
  });
});

describe('assertOutsideRepo', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-seed-path-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a file inside the repository, and accepts one outside it', () => {
    expect(() => assertOutsideRepo(FIXTURE)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(path.join(os.tmpdir(), 'seed.json'))).not.toThrow();
  });

  it('follows a symlink outside the repository to the file it names', () => {
    const link = path.join(dir, 'looks-outside.json');
    symlinkSync(FIXTURE, link);
    expect(() => assertOutsideRepo(link)).toThrow(/outside the repository/);
  });

  it('refuses a file inside any git work tree, a linked worktree (a .git file) included', () => {
    const other = path.join(dir, 'other-repo', 'data');
    mkdirSync(path.join(dir, 'other-repo', '.git'), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'seed.json'), '{}');
    expect(() => assertOutsideRepo(path.join(other, 'seed.json'))).toThrow(/outside any git work tree/);
    const linked = path.join(dir, 'linked-worktree');
    mkdirSync(linked);
    writeFileSync(path.join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
    writeFileSync(path.join(linked, 'seed.json'), '{}');
    expect(() => assertOutsideRepo(path.join(linked, 'seed.json'))).toThrow(/outside any git work tree/);
  });

  it('refuses a file with a second hard link, which could be a name for a file inside a repository', async () => {
    const plain = path.join(dir, 'plain.json');
    writeFileSync(plain, '{"offices": []}');
    const lines: string[] = [];
    const say = (line: string): void => {
      lines.push(line);
    };
    linkSync(plain, path.join(dir, 'second-name.json'));
    expect(await runSeed([plain], {}, say)).toBe(2);
    expect(lines).toEqual(['seed: the seed file has more than one link: copy it to a file of its own']);
  });
});

describe.skipIf(!live)('applySeed and runSeed', () => {
  let api: Api;
  let dir: string;

  beforeAll(async () => {
    api = await startApi('nwfl_seed');
    dir = mkdtempSync(path.join(os.tmpdir(), 'nwfl-seed-'));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await api?.close();
  });

  it('loads the roster and the calendar, which the read RPCs then serve', async () => {
    const summary = await applySeed(api.pool, parseSeed(example()));
    expect(summary).toEqual({ offices: 5, terms: 5, venues: 3, series: 5, occurrences: 2 });
    const roster = await api.client(ContentService).getRoster({});
    expect(roster.offices.map((o) => [o.slug, o.terms[0]?.holderDisplayName ?? ''])).toEqual([
      ['president', 'Pat Example'],
      ['vice-president', 'Sam Sample'],
      ['treasurer', 'Alex Placeholder'],
      ['membership', ''],
      ['publications', 'Jordan Fictional'],
    ]);
    const series = await api.client(EventService).listSeries({});
    expect(series.series.map((s) => s.slug)).toEqual(['excomm', 'happy-hour', 'panama-city-lunch', 'pensacola-dinner', 'wednesday-lunch']);
    const november = await api.client(EventService).listOccurrences({ from: { year: 2026, month: 11, day: 1 }, to: { year: 2026, month: 11, day: 30 } });
    expect(november.occurrences.map((o) => o.title)).toContain('Fall Picnic');
    expect(november.occurrences.filter((o) => o.title === 'Wednesday Lunch')).toHaveLength(3);
  });

  it('is idempotent, and updates in place', async () => {
    const changed = example();
    (changed['terms'] as Array<Record<string, unknown>>)[0]!['holder'] = 'Pat Renamed';
    await applySeed(api.pool, parseSeed(changed));
    await applySeed(api.pool, parseSeed(changed));
    const counts = await api.pool.query<{ offices: string; terms: string; venues: string; series: string; occurrences: string }>(
      `SELECT (SELECT count(*) FROM office) AS offices, (SELECT count(*) FROM office_term) AS terms, (SELECT count(*) FROM venue) AS venues,
              (SELECT count(*) FROM event_series) AS series, (SELECT count(*) FROM event_occurrence) AS occurrences`,
    );
    expect(counts.rows[0]).toEqual({ offices: '5', terms: '5', venues: '3', series: '5', occurrences: '2' });
    const roster = await api.client(ContentService).getRoster({});
    expect(roster.offices[0]?.terms[0]?.holderDisplayName).toBe('Pat Renamed');
  });

  it('records every row it writes in the audit log, as the system, with no payload', async () => {
    const { rows } = await api.pool.query<{ actor_kind: string; action: string; payload: unknown; n: string }>(
      `SELECT actor_kind, action, payload, count(*) AS n FROM audit_event GROUP BY 1, 2, 3`,
    );
    expect(rows).toEqual([{ actor_kind: 'system', action: 'seed', payload: {}, n: String(3 * 20) }]);
  });

  it('applies all or nothing', async () => {
    const bad = example();
    (bad['offices'] as Array<Record<string, unknown>>).push({ slug: 'webmaster', title: 'Webmaster', kind: 'appointed', roleAlias: 'someone@example.org' });
    (bad['terms'] as Array<Record<string, unknown>>)[1]!['holder'] = 'Should Not Land';
    await expect(applySeed(api.pool, parseSeed(bad))).rejects.toThrow();
    const roster = await api.client(ContentService).getRoster({});
    expect(roster.offices.map((o) => o.slug)).not.toContain('webmaster');
    expect(JSON.stringify(roster.offices.map((o) => o.terms.map((t) => t.holderDisplayName)))).not.toContain('Should Not Land');
  });

  it('runs from the command line on a file outside the repository, printing counts only', async () => {
    const outside = path.join(dir, 'seed.json');
    copyFileSync(FIXTURE, outside);
    const lines: string[] = [];
    const db = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db as string;
    const env = { DATABASE_URL: urlFor(APP, APP_PW, db) };
    expect(await runSeed([outside], env, (line) => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toMatch(/offices=5 terms=5 venues=3 series=5 occurrences=2/);
    expect(lines.join('\n')).not.toMatch(/Pat |Example Grill/);
  });

  it('reports a refused row by its code or reason only, and applies nothing', async () => {
    const db = (await api.pool.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db as string;
    const env = { DATABASE_URL: urlFor(APP, APP_PW, db) };
    const lines: string[] = [];
    const say = (line: string): void => {
      lines.push(line);
    };
    const refused = path.join(dir, 'refused.json');
    writeFileSync(refused, JSON.stringify({ offices: [{ slug: 'social', title: 'Social', kind: 'appointed', roleAlias: 'pat.private@example.org' }] }));
    expect(await runSeed([refused], env, say)).toBe(1);
    const dangling = path.join(dir, 'dangling.json');
    writeFileSync(dangling, JSON.stringify({ terms: [{ office: 'no-such-office', startsOn: '2026-10-01', status: 'vacant' }] }));
    expect(await runSeed([dangling], env, say)).toBe(1);
    const unknownSeries = path.join(dir, 'unknown-series.json');
    writeFileSync(unknownSeries, JSON.stringify({ occurrences: [{ series: 'no-such-series', startsAt: '2026-11-14T17:00:00Z' }] }));
    expect(await runSeed([unknownSeries], env, say)).toBe(1);
    expect(lines).toEqual([
      'seed failed, nothing applied: 23514',
      "seed failed, nothing applied: unknown office 'no-such-office'",
      "seed failed, nothing applied: unknown series 'no-such-series'",
    ]);
    expect(lines.join('\n')).not.toContain('pat.private');
  });

  it('refuses anything but a regular file: a pipe (what <(...) gives), a device, a directory', async () => {
    const lines: string[] = [];
    const say = (line: string): void => {
      lines.push(line);
    };
    const fifo = path.join(dir, 'seed.fifo');
    execFileSync('mkfifo', [fifo]);
    for (const target of [fifo, '/dev/null', dir]) {
      lines.length = 0;
      expect(await runSeed([target], {}, say), target).toBe(2);
      expect(lines, target).toEqual(['seed: the seed file must be a regular file']);
    }
  });

  it('refuses no argument, a file inside the repository, a missing file, and a bad file', async () => {
    const lines: string[] = [];
    const say = (line: string): void => {
      lines.push(line);
    };
    expect(await runSeed([], {}, say)).toBe(2);
    expect(await runSeed([FIXTURE], {}, say)).toBe(2);
    expect(await runSeed([path.join(dir, 'missing.json')], {}, say)).toBe(2);
    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, '{"venues": [{"name": "Home", "kind": "member_home", "area": "bay"}]}');
    expect(await runSeed([broken], {}, say)).toBe(2);
    const notJson = path.join(dir, 'not-json.json');
    writeFileSync(notJson, 'offices: []');
    expect(await runSeed([notJson], {}, say)).toBe(2);
    expect(lines.join('\n')).toMatch(/usage: .* <seed-file>/);
    expect(lines.join('\n')).toMatch(/outside the repository/);
    expect(lines.join('\n')).toMatch(/venues\[0\]\.kind/);
    expect(lines.join('\n')).toMatch(/not valid JSON/);
  });
});
