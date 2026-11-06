// BOXLABEL against the database: which of the public's quotes members withhold too (store.ts inputsFor), one
// boolean per quote, so the engine labels each box "Members Only" or "Private". The flags carry no text: the
// public's request holds only the public's quotes, the members' only the members'. The "PDFs" are a few bytes
// no engine reads. Every person and place is made up.
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PREFIX_BYTES, encodeRequest } from '../../src/pdf/engine-protocol.js';
import { ENGINE_VERSION, inputHash, inputsFor } from '../../src/pdf/store.js';
import { APP, APP_PW, dropDatabase, freshDatabase, live, migrate, urlFor, testPool } from '../helpers/pg.js';

const LOADER = 'system:issue-loader';
const OFFICER = { sub: 'sub-officer', groups: ['nwfl-members', 'nwfl-officers'] };
const ORIGIN = 'https://nwflorida.us';
const sha = (bytes: Uint8Array | string): Buffer => createHash('sha256').update(bytes).digest();

/** Every string in a value, at any depth. */
const strings = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : typeof value === 'object' && value !== null ? Object.values(value).flatMap(strings) : [];
/** The header the engine would be sent for a request. */
const header = (request: Parameters<typeof encodeRequest>[1]): Record<string, unknown> => {
  const frame = encodeRequest(Uint8Array.from([37]), request);
  return JSON.parse(frame.subarray(PREFIX_BYTES, PREFIX_BYTES + frame.readUInt32BE(4)).toString('utf8')) as Record<string, unknown>;
};

describe.skipIf(!live)('BOXLABEL: what members withhold, per public quote (store.ts inputsFor)', () => {
  let database: string;
  let app: pg.Pool;
  let office: string;
  let serial = 0;

  async function file(): Promise<{ file: string; item: string; bytes: Buffer }> {
    serial++;
    const item = (await app.query<{ id: string }>(`INSERT INTO content_item (slug, kind, office_id) VALUES ($1, 'document', $2) RETURNING id`, [`issue-${serial}`, office])).rows[0]!.id;
    const version = (await app.query<{ id: string }>(`INSERT INTO content_version (item_id, n, title, created_by_sub, acting_office_id) VALUES ($1, 1, 'Issue', $2, $3) RETURNING id`, [item, LOADER, office])).rows[0]!.id;
    const bytes = Buffer.from(`%PDF-1.7\n% issue ${serial}\n%%EOF\n`, 'latin1');
    const fileId = (
      await app.query<{ id: string }>(
        `INSERT INTO stored_file (version_id, object_key, filename, mime_type, size_bytes, sha256, audience) VALUES ($1, $2, 'i.pdf', 'application/pdf', $3, $4, 'public') RETURNING id`,
        [version, `k-${serial}`, bytes.length, sha(bytes)],
      )
    ).rows[0]!.id;
    await app.query(`SELECT pdf_original_put($1, $2, $3, '{}', NULL)`, [fileId, bytes, LOADER]);
    return { file: fileId, item, bytes };
  }
  const mark = (item: string, quote: string, category: string) => app.query(`SELECT redaction_mark_add('content_item', $1, 'body', $2, $3, $4, $5, NULL)`, [item, quote, category, OFFICER.sub, OFFICER.groups]);
  const propose = (audience: string, category: string, to: string) => app.query(`SELECT redaction_propose('nwflorida', $1, $2, $3, $4, $5, NULL)`, [audience, category, to, OFFICER.sub, OFFICER.groups]);
  const copyOf = async (fileId: string, audience: string) => {
    const inputs = await inputsFor(app, fileId, audience, undefined, ORIGIN);
    if (inputs?.kind !== 'copy') throw new Error(`expected a copy for ${audience}, got ${JSON.stringify(inputs)}`);
    return inputs;
  };

  beforeAll(async () => {
    database = await freshDatabase('nwfl_boxlabel');
    const run = await migrate(database);
    if (run.code !== 0) throw new Error(`migrate failed: ${run.stderr}`);
    app = testPool({ connectionString: urlFor(APP, APP_PW, database), max: 3 });
    office = (await app.query<{ id: string }>(`INSERT INTO office (slug, title, kind) VALUES ('editor', 'Newsletter Editor', 'appointed') RETURNING id`)).rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    if (database !== undefined) await dropDatabase(database);
  });

  it('flags each public quote members withhold too (an address), and not one they see (a phone); every members quote', async () => {
    const { file: f, item, bytes } = await file();
    await mark(item, 'Wrenhallow Lane', 'member_address');
    await mark(item, '850-555-0142', 'member_phone');
    const pub = await copyOf(f, 'public');
    expect(pub.request.quotes).toEqual(['850-555-0142', 'Wrenhallow Lane']);
    expect(pub.request.membersWithhold).toEqual([false, true]);
    const members = await copyOf(f, 'members');
    expect(members.request.quotes).toEqual(['Wrenhallow Lane']);
    expect(members.request.membersWithhold).toEqual([true]);
    // The flags are keyed: the hash is of the request as given.
    expect(pub.hash.equals(inputHash(sha(bytes), pub.request, ENGINE_VERSION, {}))).toBe(true);
    expect(pub.hash.equals(inputHash(sha(bytes), { ...pub.request, membersWithhold: [true, true] }, ENGINE_VERSION, {}))).toBe(false);
    // What the engine is sent: the same text as before the flags, and only this audience's.
    // (and the origin and the image action, as before).
    expect(strings(header(pub.request)).sort()).toEqual(['850-555-0142', ORIGIN, 'Wrenhallow Lane', 'show'].sort());
    expect(strings(header(members.request)).sort()).toEqual([ORIGIN, 'Wrenhallow Lane', 'show'].sort());
  });

  it('flags a quote one of whose marks members withhold, when another mark of it they see', async () => {
    const { file: f, item } = await file();
    await mark(item, 'Kestrel Ambry', 'member_phone');
    await mark(item, 'Kestrel Ambry', 'member_address');
    expect((await copyOf(f, 'public')).request).toMatchObject({ quotes: ['Kestrel Ambry'], membersWithhold: [true] });
  });

  it('never puts a quote only members withhold into the public request, nor a public quote into the members request', async () => {
    // Members redact business venues; the public sees them (a policy no one would set, read as it is).
    await propose('members', 'business_venue', 'redact');
    const { file: f, item } = await file();
    await mark(item, 'Fernhollow Hall', 'business_venue');
    await mark(item, '850-555-0199', 'member_phone');
    const pub = await copyOf(f, 'public');
    expect(pub.request).toMatchObject({ quotes: ['850-555-0199'], membersWithhold: [false] });
    expect(JSON.stringify(header(pub.request))).not.toContain('Fernhollow');
    const members = await copyOf(f, 'members');
    expect(members.request).toMatchObject({ quotes: ['Fernhollow Hall'], membersWithhold: [true] });
    expect(JSON.stringify(header(members.request))).not.toContain('850-555-0199');
  });

  it('flags every public quote when members are not given the file at all (a mark hides it from them)', async () => {
    await propose('members', 'member_email', 'hide');
    const { file: f, item } = await file();
    await mark(item, '850-555-0177', 'member_phone');
    await mark(item, 'k.ambry@example.org', 'member_email');
    expect(await inputsFor(app, f, 'members', undefined, ORIGIN)).toEqual({ kind: 'hidden' });
    expect((await copyOf(f, 'public')).request).toMatchObject({ quotes: ['850-555-0177', 'k.ambry@example.org'], membersWithhold: [true, true] });
  });

  it('gives the officers\' copy, where there is one, every quote flagged', async () => {
    await propose('officers', 'member_phone', 'redact');
    const { file: f, item } = await file();
    await mark(item, '850-555-0188', 'member_phone');
    expect((await copyOf(f, 'officers')).request).toMatchObject({ quotes: ['850-555-0188'], membersWithhold: [true] });
  });
});
