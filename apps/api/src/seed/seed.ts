// ============================================================================
// The calendar and roster seed (P13), so the calendar and the Officers page are
// live before the officer forms exist.
//
//   node dist/seed/cli.js <seed-file>        DATABASE_URL (or PG*) as for the service
//
// Rules, each enforced here:
//   - The data lives OUTSIDE the repository, and outside any git work tree;
//     a path inside one, a file with a second hard link (which could be a
//     name for a file inside one), or anything but a regular file (a pipe
//     from <(...), a device) is refused. The repository may be
//     published, and roster names are real people.
//   - Known fields only, as own keys: __proto__, constructor and the like are
//     unknown fields like any other.
//   - Business and virtual venues only: a member's home is refused (R3).
//   - Known fields only, so no phone, email or address field can ride along;
//     contact goes through role aliases, which the schema keeps at
//     nwflorida.us.
//   - One transaction: all of it lands, or none of it.
//   - Idempotent: offices and series by slug, terms by office and start date,
//     venues by name, occurrences by series (or title) and start.
//   - Every row written is recorded in audit_event as the system, with no
//     payload, and the command prints counts only, never the data.
// ============================================================================
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool, type Env } from '../db/pool.js';
import { RecurrenceError, parseRule } from '../events/recurrence.js';
import { isoDate } from '../events/zone.js';

export class SeedError extends Error {
  override name = 'SeedError';
}

type Kind = 'string' | 'number' | 'boolean' | 'date' | 'time' | 'instant';
type Spec = Record<string, [Kind, 'required' | 'optional']>;
type Row = Record<string, string | number | boolean | undefined>;

const SPECS: Record<string, Spec> = {
  offices: {
    slug: ['string', 'required'],
    title: ['string', 'required'],
    kind: ['string', 'required'],
    sortOrder: ['number', 'optional'],
    roleAlias: ['string', 'optional'],
    roleAliasVerifiedOn: ['date', 'optional'],
    active: ['boolean', 'optional'],
  },
  terms: {
    office: ['string', 'required'],
    holder: ['string', 'optional'],
    startsOn: ['date', 'required'],
    endsOn: ['date', 'optional'],
    status: ['string', 'required'],
  },
  venues: {
    name: ['string', 'required'],
    kind: ['string', 'required'],
    businessAddress: ['string', 'optional'],
    city: ['string', 'optional'],
    area: ['string', 'required'],
    url: ['string', 'optional'],
    accessibilityNote: ['string', 'optional'],
    active: ['boolean', 'optional'],
  },
  series: {
    slug: ['string', 'required'],
    title: ['string', 'required'],
    category: ['string', 'required'],
    recurrence: ['string', 'required'],
    cadenceLabel: ['string', 'optional'],
    startsOn: ['date', 'required'],
    defaultStart: ['time', 'optional'],
    durationMinutes: ['number', 'optional'],
    venue: ['string', 'optional'],
    area: ['string', 'required'],
    hostOffice: ['string', 'optional'],
    description: ['string', 'optional'],
    visibility: ['string', 'optional'],
    active: ['boolean', 'optional'],
  },
  occurrences: {
    series: ['string', 'optional'],
    title: ['string', 'optional'],
    startsAt: ['instant', 'required'],
    endsAt: ['instant', 'optional'],
    venue: ['string', 'optional'],
    status: ['string', 'optional'],
    statusNote: ['string', 'optional'],
    detail: ['string', 'optional'],
    url: ['string', 'optional'],
    visibility: ['string', 'optional'],
  },
};
const SECTIONS = Object.keys(SPECS);

export interface Seed {
  offices: Row[];
  terms: Row[];
  venues: Row[];
  series: Row[];
  occurrences: Row[];
}

function valid(kind: Kind, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string' && value !== '';
    case 'number':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      try {
        isoDate({ year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)) });
        return true;
      } catch {
        return false;
      }
    case 'time':
      return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    case 'instant':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
  }
}

function row(section: string, index: number, value: unknown): Row {
  const where = `${section}[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SeedError(`${where} must be an object`);
  const spec = SPECS[section] as Spec;
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record)) if (!Object.hasOwn(spec, field)) throw new SeedError(`${where}: unknown field ${field}`);
  for (const [field, [kind, need]] of Object.entries(spec)) {
    const present = record[field] !== undefined;
    if (!present && need === 'required') throw new SeedError(`${where}.${field} is required`);
    if (present && !valid(kind, record[field])) throw new SeedError(`${where}.${field} must be a ${kind}`);
  }
  return record as Row;
}

export function parseSeed(json: unknown): Seed {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new SeedError('the seed file must hold a JSON object');
  const input = json as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!SECTIONS.includes(key)) throw new SeedError(`unknown section ${key}`);
  const seed = Object.fromEntries(
    SECTIONS.map((section) => {
      const list = input[section] ?? [];
      if (!Array.isArray(list)) throw new SeedError(`${section} must be a list`);
      return [section, list.map((value, index) => row(section, index, value))];
    }),
  ) as unknown as Seed;
  seed.venues.forEach((venue, index) => {
    if (venue['kind'] !== 'business' && venue['kind'] !== 'virtual') {
      throw new SeedError(`venues[${index}].kind must be business or virtual: a member's home is never seeded`);
    }
  });
  seed.series.forEach((series, index) => {
    try {
      parseRule(series['recurrence'] as string);
    } catch (error) {
      if (!(error instanceof RecurrenceError)) throw error;
      throw new SeedError(`series[${index}].recurrence: ${error.message}`);
    }
  });
  return seed;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The nearest directory at or above `dir` holding a .git entry (a directory, or a linked worktree's file). */
function gitWorkTreeOf(dir: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) return undefined;
  }
}

/**
 * Refuses a seed file inside the repository (or the image's /app) or inside
 * any git work tree; symlinks resolved. What the file IS (a regular file with
 * one link) is checked on the descriptor it is read through (readRegularFile).
 */
export function assertOutsideRepo(file: string): void {
  let resolved = path.resolve(file);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // A missing file is reported when it is read.
  }
  const relative = path.relative(REPO_ROOT, resolved);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new SeedError('the seed file must live outside the repository: it holds real names');
  }
  if (gitWorkTreeOf(path.dirname(resolved)) !== undefined) {
    throw new SeedError('the seed file must live outside any git work tree: it holds real names');
  }
}

/**
 * The file's text, read through one descriptor whose fstat says it is a
 * regular file: a pipe (what a shell's <(...) gives), a device or a directory
 * is refused before a byte is read, and nothing is swapped in between the
 * check and the read. O_NONBLOCK, so opening a pipe does not wait for a writer.
 */
function readRegularFile(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new SeedError('cannot read the seed file');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new SeedError('the seed file must be a regular file');
    if (stat.nlink > 1) throw new SeedError('the seed file has more than one link: copy it to a file of its own');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export interface SeedSummary {
  offices: number;
  terms: number;
  venues: number;
  series: number;
  occurrences: number;
}

const or = <T>(value: T | undefined, fallback: T | null = null): T | null => (value === undefined ? fallback : value);

async function audit(client: pg.PoolClient, subjectKind: string, subjectId: string): Promise<void> {
  await client.query(
    `INSERT INTO audit_event (actor_kind, action, subject_kind, subject_id) VALUES ('system', 'seed', $1, $2)`,
    [subjectKind, subjectId],
  );
}

async function idOf(client: pg.PoolClient, text: string, values: unknown[]): Promise<string | undefined> {
  return (await client.query<{ id: string }>(text, values)).rows[0]?.id;
}

function lookup(map: Map<string, string>, key: Row[string], what: string): string | null {
  if (key === undefined) return null;
  const id = map.get(key as string);
  if (id === undefined) throw new SeedError(`unknown ${what} '${String(key)}'`);
  return id;
}

export async function applySeed(pool: Pick<pg.Pool, 'connect'>, seed: Seed): Promise<SeedSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const offices = new Map<string, string>();
    for (const office of seed.offices) {
      const id = (await idOf(
        client,
        `INSERT INTO office (slug, title, kind, sort_order, role_alias, role_alias_verified_on, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE SET title = $2, kind = $3, sort_order = $4, role_alias = $5,
           role_alias_verified_on = $6, active = $7, updated_at = now()
         RETURNING id`,
        [office['slug'], office['title'], office['kind'], or(office['sortOrder'], 0), or(office['roleAlias']), or(office['roleAliasVerifiedOn']), or(office['active'], true)],
      )) as string;
      offices.set(office['slug'] as string, id);
      await audit(client, 'office', id);
    }
    const known = await client.query<{ id: string; slug: string }>('SELECT id, slug FROM office');
    known.rows.forEach((office) => offices.set(office.slug, office.id));

    for (const term of seed.terms) {
      const officeId = lookup(offices, term['office'], 'office');
      const values = [officeId, term['startsOn'], or(term['holder']), or(term['endsOn']), term['status']];
      const existing = await idOf(client, 'SELECT id FROM office_term WHERE office_id = $1 AND starts_on = $2', values.slice(0, 2));
      const id =
        existing === undefined
          ? await idOf(client, 'INSERT INTO office_term (office_id, starts_on, holder_display_name, ends_on, status) VALUES ($1, $2, $3, $4, $5) RETURNING id', values)
          : await idOf(
              client,
              'UPDATE office_term SET holder_display_name = $3, ends_on = $4, status = $5, updated_at = now() WHERE office_id = $1 AND starts_on = $2 RETURNING id',
              values,
            );
      await audit(client, 'office_term', id as string);
    }

    const venues = new Map<string, string>();
    for (const venue of seed.venues) {
      const values = [venue['name'], venue['kind'], or(venue['businessAddress']), or(venue['city']), venue['area'], or(venue['url']), or(venue['accessibilityNote']), or(venue['active'], true)];
      const existing = await idOf(client, `SELECT id FROM venue WHERE name = $1 AND kind <> 'member_home'`, [venue['name']]);
      const id =
        existing === undefined
          ? await idOf(
              client,
              'INSERT INTO venue (name, kind, business_address, city, area, url, accessibility_note, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
              values,
            )
          : await idOf(
              client,
              `UPDATE venue SET name = $1, kind = $2, business_address = $3, city = $4, area = $5, url = $6, accessibility_note = $7, active = $8, updated_at = now()
               WHERE id = $9 RETURNING id`,
              [...values, existing],
            );
      venues.set(venue['name'] as string, id as string);
      await audit(client, 'venue', id as string);
    }
    const knownVenues = await client.query<{ id: string; name: string }>(`SELECT id, name FROM venue WHERE kind <> 'member_home'`);
    knownVenues.rows.forEach((venue) => venues.set(venue.name, venue.id));

    const series = new Map<string, { id: string; visibility: string }>();
    for (const item of seed.series) {
      const visibility = or(item['visibility'], 'public') as string;
      const id = (await idOf(
        client,
        `INSERT INTO event_series (slug, title, category, recurrence, cadence_label, starts_on, default_start, default_duration_minutes,
           default_venue_id, area, host_office_id, description, visibility, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (slug) DO UPDATE SET title = $2, category = $3, recurrence = $4, cadence_label = $5, starts_on = $6,
           default_start = $7, default_duration_minutes = $8, default_venue_id = $9, area = $10, host_office_id = $11,
           description = $12, visibility = $13, active = $14, updated_at = now()
         RETURNING id`,
        [
          item['slug'],
          item['title'],
          item['category'],
          item['recurrence'],
          or(item['cadenceLabel']),
          item['startsOn'],
          or(item['defaultStart']),
          or(item['durationMinutes']),
          lookup(venues, item['venue'], 'venue'),
          item['area'],
          lookup(offices, item['hostOffice'], 'office'),
          or(item['description']),
          visibility,
          or(item['active'], true),
        ],
      )) as string;
      series.set(item['slug'] as string, { id, visibility });
      await audit(client, 'event_series', id);
    }
    const knownSeries = await client.query<{ id: string; slug: string; visibility: string }>('SELECT id, slug, visibility FROM event_series');
    knownSeries.rows.forEach((row) => series.set(row.slug, { id: row.id, visibility: row.visibility }));

    for (const occurrence of seed.occurrences) {
      const parent = occurrence['series'] === undefined ? undefined : series.get(occurrence['series'] as string);
      if (occurrence['series'] !== undefined && parent === undefined) throw new SeedError(`unknown series '${String(occurrence['series'])}'`);
      const values = [
        parent?.id ?? null,
        or(occurrence['title']),
        occurrence['startsAt'],
        or(occurrence['endsAt']),
        lookup(venues, occurrence['venue'], 'venue'),
        or(occurrence['status'], 'scheduled'),
        or(occurrence['statusNote']),
        or(occurrence['detail']),
        or(occurrence['url']),
        or(occurrence['visibility'], parent?.visibility ?? 'public'),
      ];
      const existing = await idOf(
        client,
        'SELECT id FROM event_occurrence WHERE series_id IS NOT DISTINCT FROM $1 AND starts_at = $3 AND (series_id IS NOT NULL OR title = $2)',
        values.slice(0, 3),
      );
      const id =
        existing === undefined
          ? await idOf(
              client,
              `INSERT INTO event_occurrence (series_id, title, starts_at, ends_at, venue_id, status, status_note, detail, url, visibility)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              values,
            )
          : await idOf(
              client,
              `UPDATE event_occurrence SET title = $2, ends_at = $4, venue_id = $5, status = $6, status_note = $7, detail = $8, url = $9,
                 visibility = $10, updated_at = now()
               WHERE id = $11 AND series_id IS NOT DISTINCT FROM $1 AND starts_at = $3 RETURNING id`,
              [...values, existing],
            );
      await audit(client, 'event_occurrence', id as string);
    }
    await client.query('COMMIT');
    return {
      offices: seed.offices.length,
      terms: seed.terms.length,
      venues: seed.venues.length,
      series: seed.series.length,
      occurrences: seed.occurrences.length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The command: exit 0 on success, 2 on a usage or file problem, 1 when the database refuses. */
export async function runSeed(argv: string[], env: Env, say: (line: string) => void): Promise<number> {
  if (argv.length !== 1) {
    say('usage: node dist/seed/cli.js <seed-file>   (the file must live outside the repository)');
    return 2;
  }
  let seed: Seed;
  try {
    const file = argv[0] as string;
    assertOutsideRepo(file);
    const text = readRegularFile(file);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SeedError('the seed file is not valid JSON');
    }
    seed = parseSeed(json);
  } catch (error) {
    say(`seed: ${(error as Error).message}`);
    return 2;
  }
  const pool = createPool(env);
  try {
    const summary = await applySeed(pool, seed);
    say(`seeded: ${Object.entries(summary).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    return 0;
  } catch (error) {
    // The driver's code only: its message can echo the row it refused.
    const code = (error as { code?: unknown }).code;
    say(`seed failed, nothing applied: ${error instanceof SeedError ? error.message : typeof code === 'string' ? code : 'error'}`);
    return 1;
  } finally {
    await pool.end();
  }
}
