// The nwfl.mensa.v1 contract, read from the GENERATED descriptors the server
// will register, so a proto edit that breaks a rule fails here before any
// handler exists. Every file under src/gen/nwfl/mensa/v1 is loaded; a new
// proto file is checked without touching this test.
//
// The rules:
//   - six services, each with a separate caller (the BFF, the newsletter
//     agent, the membership verifier);
//   - no RPC takes an audience from the caller, except ExportEdition, and no
//     read RPC takes a visibility filter either (P17: the audience comes from
//     the verified token);
//   - the membership number reaches only the verifier's pending list (out) and
//     the sign-up call (in);
//   - nothing National-sourced has a field: no phone, birthday or home address,
//     and no free-text notes on membership records.
import type { DescEnum, DescField, DescFile, DescMessage, DescMethod, DescService } from '@bufbuild/protobuf';
import { MethodOptions_IdempotencyLevel as Idempotency } from '@bufbuild/protobuf/wkt';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const GEN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/gen/nwfl/mensa/v1');
const PKG = 'nwfl.mensa.v1';

let files: DescFile[] = [];

async function loadFiles(): Promise<DescFile[]> {
  let names: string[];
  try {
    names = readdirSync(GEN).filter((name) => name.endsWith('_pb.ts'));
  } catch {
    return [];
  }
  const modules = await Promise.all(names.map((name) => import(pathToFileURL(path.join(GEN, name)).href) as Promise<Record<string, unknown>>));
  return modules.flatMap((mod) =>
    Object.values(mod).filter((value): value is DescFile => (value as { kind?: unknown } | null)?.kind === 'file'),
  );
}

const services = (): DescService[] => files.flatMap((file) => file.services);
const service = (name: string): DescService | undefined => services().find((s) => s.typeName === `${PKG}.${name}`);
const methods = (): DescMethod[] => services().flatMap((s) => s.methods);
const rpc = (m: DescMethod): string => `${m.parent.name}.${m.name}`;

function allMessages(): DescMessage[] {
  const out: DescMessage[] = [];
  const walk = (message: DescMessage): void => {
    out.push(message);
    message.nestedMessages.forEach(walk);
  };
  files.flatMap((file) => file.messages).forEach(walk);
  return out;
}

function fieldMessage(field: DescField): DescMessage | undefined {
  if (field.fieldKind === 'message') return field.message;
  if (field.fieldKind === 'list' && field.listKind === 'message') return field.message;
  if (field.fieldKind === 'map' && field.mapKind === 'message') return field.message;
  return undefined;
}

function fieldEnum(field: DescField): DescEnum | undefined {
  if (field.fieldKind === 'enum') return field.enum;
  if (field.fieldKind === 'list' && field.listKind === 'enum') return field.enum;
  if (field.fieldKind === 'map' && field.mapKind === 'enum') return field.enum;
  return undefined;
}

/** Every field reachable from a message, through nested and referenced messages, each visited once. */
function reachableFields(root: DescMessage): DescField[] {
  const seen = new Set<string>();
  const out: DescField[] = [];
  const walk = (message: DescMessage): void => {
    if (seen.has(message.typeName)) return;
    seen.add(message.typeName);
    for (const field of message.fields) {
      out.push(field);
      const next = fieldMessage(field);
      if (next !== undefined) walk(next);
    }
  };
  walk(root);
  return out;
}

const fieldNames = (message: DescMessage | undefined): string[] => (message?.fields ?? []).map((f) => f.name);

beforeAll(async () => {
  files = await loadFiles();
});

describe(`${PKG}: services`, () => {
  it('declares the six services and nothing else', () => {
    expect(services().map((s) => s.name).sort()).toEqual(
      ['ContentService', 'EventService', 'MembershipService', 'MembershipVerifierService', 'NewsletterService', 'RedactionPolicyService'].sort(),
    );
  });

  it('keeps every RPC unary: no stream holds a drain open', () => {
    expect(methods().length).toBeGreaterThan(0);
    for (const m of methods()) expect(m.methodKind, rpc(m)).toBe('unary');
  });

  it('marks every List/Get/Export RPC as a read (NO_SIDE_EFFECTS), and nothing else', () => {
    for (const m of methods()) {
      const isRead = /^(List|Get|Export)/.test(m.name);
      expect(m.idempotency === Idempotency.NO_SIDE_EFFECTS, rpc(m)).toBe(isRead);
    }
  });
});

describe(`${PKG}: the membership verifier`, () => {
  it('is its own service with exactly ListPendingVerifications and ReportVerification', () => {
    expect(service('MembershipVerifierService')?.methods.map((m) => m.name)).toEqual([
      'ListPendingVerifications',
      'ReportVerification',
    ]);
  });

  it('lists a pending verification as request id, membership number and last name only, a page at a time', () => {
    const list = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ListPendingVerifications');
    expect(fieldNames(list?.input)).toEqual(['page_size']);
    const item = list?.output.fields.map(fieldMessage).find((m) => m !== undefined);
    expect(fieldNames(item)).toEqual(['request_id', 'membership_number', 'last_name']);
  });

  it('takes back a request id and an outcome, nothing else', () => {
    const report = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ReportVerification');
    expect(fieldNames(report?.input)).toEqual(['request_id', 'outcome']);
    expect(fieldNames(report?.output)).toEqual([]);
    const outcome = report?.input.fields.map(fieldEnum).find((e) => e !== undefined);
    expect(outcome?.values.map((v) => v.name)).toEqual([
      'VERIFICATION_OUTCOME_UNSPECIFIED',
      'VERIFICATION_OUTCOME_VERIFIED_LOCAL',
      'VERIFICATION_OUTCOME_VERIFIED_OTHER_GROUP',
      'VERIFICATION_OUTCOME_NOT_FOUND',
      'VERIFICATION_OUTCOME_ERROR',
    ]);
  });

  it('lets the membership number reach only the pending list (out) and the sign-up call (in)', () => {
    const carriers = methods().flatMap((m) => [
      ...(reachableFields(m.input).some((f) => f.name === 'membership_number') ? [`${rpc(m)} in`] : []),
      ...(reachableFields(m.output).some((f) => f.name === 'membership_number') ? [`${rpc(m)} out`] : []),
    ]);
    expect(carriers.sort()).toEqual([
      'MembershipService.SubmitSignup in',
      'MembershipVerifierService.ListPendingVerifications out',
    ]);
  });

  it('lets the last name reach only the same two places', () => {
    const carriers = methods().flatMap((m) => [
      ...(reachableFields(m.input).some((f) => f.name === 'last_name') ? [`${rpc(m)} in`] : []),
      ...(reachableFields(m.output).some((f) => f.name === 'last_name') ? [`${rpc(m)} out`] : []),
    ]);
    expect(carriers.sort()).toEqual([
      'MembershipService.SubmitSignup in',
      'MembershipVerifierService.ListPendingVerifications out',
    ]);
  });
});

describe(`${PKG}: the audience comes from the token`, () => {
  const AUDIENCE = `${PKG}.Audience`;
  const VISIBILITY = new Set([AUDIENCE, `${PKG}.ItemVisibility`, `${PKG}.EventVisibility`, `${PKG}.FileAudience`]);
  const enumsIn = (message: DescMessage): string[] =>
    reachableFields(message).flatMap((f) => fieldEnum(f)?.typeName ?? []);

  it('lets only NewsletterService.ExportEdition take an Audience', () => {
    const takers = methods()
      .filter((m) => enumsIn(m.input).includes(AUDIENCE))
      .map(rpc);
    expect(takers).toEqual(['NewsletterService.ExportEdition']);
    const exportEdition = service('NewsletterService')?.methods.find((m) => m.name === 'ExportEdition');
    expect(fieldNames(exportEdition?.input)).toEqual(['edition_id', 'audience']);
  });

  it('gives no other read RPC a visibility or audience filter', () => {
    const offenders = methods()
      .filter((m) => m.idempotency === Idempotency.NO_SIDE_EFFECTS && rpc(m) !== 'NewsletterService.ExportEdition')
      .filter((m) => enumsIn(m.input).some((name) => VISIBILITY.has(name)))
      .map(rpc);
    expect(offenders).toEqual([]);
  });
});

describe(`${PKG}: nothing National-sourced has a field`, () => {
  it('has no phone, birthday, Mensaversary or home-address field anywhere', () => {
    const banned = /phone|birth|dob|mensaversary|home_address|street/;
    const offenders = allMessages().flatMap((m) => m.fields.filter((f) => banned.test(f.name)).map((f) => `${m.name}.${f.name}`));
    expect(offenders).toEqual([]);
  });

  it('stores a venue by area and host office, with an address only for a business', () => {
    const venue = allMessages().find((m) => m.typeName === `${PKG}.Venue`);
    expect(fieldNames(venue)).toEqual(expect.arrayContaining(['kind', 'area', 'host_office_id', 'business_address']));
  });

  it('gives membership records no free-text note field', () => {
    const membershipFiles = files.filter((f) => /membership|verifier/.test(f.name));
    expect(membershipFiles.length).toBeGreaterThanOrEqual(2);
    const offenders = membershipFiles
      .flatMap((f) => f.messages)
      .flatMap((m) => m.fields.filter((f) => /note|comment|remark|reason/.test(f.name)).map((f) => `${m.name}.${f.name}`));
    expect(offenders).toEqual([]);
  });
});

// A2-FIX: the same rules by NAME as well as by type, so a bool or string
// "audience", an extra field beside the verifier's list, or another spelling of
// the membership number cannot slip past.
describe(`${PKG}: rules by name as well as by type`, () => {
  const AUDIENCE_LIKE = /audience|visibility|member|officer|role|redact|public|private|as_/;
  const NUMBER_LIKE = /^(member(ship)?_?(number|num|no|nr|id)|mensa_?(number|num|no|id)|aml_?(number|id))$/;

  it('gives no read RPC an audience-like field of any type, except ExportEdition.audience', () => {
    const offenders = methods()
      .filter((m) => m.idempotency === Idempotency.NO_SIDE_EFFECTS)
      .flatMap((m) => reachableFields(m.input).filter((f) => AUDIENCE_LIKE.test(f.name)).map((f) => `${rpc(m)}.${f.name}`));
    expect(offenders).toEqual(['NewsletterService.ExportEdition.audience']);
  });

  it('returns the verifier exactly its pending list of three fields, nothing reachable besides', () => {
    const list = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ListPendingVerifications');
    expect(list === undefined ? [] : reachableFields(list.output).map((f) => f.name)).toEqual(['pending', 'request_id', 'membership_number', 'last_name']);
  });

  it('lets a membership number under any name reach only the pending list (out) and the sign-up call (in)', () => {
    const carriers = methods().flatMap((m) => [
      ...(reachableFields(m.input).some((f) => NUMBER_LIKE.test(f.name)) ? [`${rpc(m)} in`] : []),
      ...(reachableFields(m.output).some((f) => NUMBER_LIKE.test(f.name)) ? [`${rpc(m)} out`] : []),
    ]);
    expect(carriers.sort()).toEqual(['MembershipService.SubmitSignup in', 'MembershipVerifierService.ListPendingVerifications out']);
  });
});
