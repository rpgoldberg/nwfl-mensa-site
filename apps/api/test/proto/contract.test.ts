// The nwfl.mensa.v1 contract, read from the GENERATED descriptors the server
// will register, so a proto edit that breaks a rule fails here before any
// handler exists. Every file under src/gen/nwfl/mensa/v1 is loaded; a new
// proto file is checked without touching this test.
//
// The rules:
//   - seven services, each with a separate caller (the BFF, the newsletter
//     agent, the membership verifier);
//   - no RPC takes an audience from the caller, except ExportEdition, and no
//     read RPC takes a visibility filter either (P17: the audience comes from
//     the verified token);
//   - the membership number reaches only the verifier's pending list (out),
//     the sign-up call (in), the approvers' queue and rejections (out) and the
//     owner's own account (out); PROFILE-ID: nothing takes it back in to change it;
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
  it('declares the seven services and nothing else', () => {
    expect(services().map((s) => s.name).sort()).toEqual(
      ['ApprovalRuleService', 'ContentService', 'EventService', 'MembershipService', 'MembershipVerifierService', 'NewsletterService', 'RedactionPolicyService'].sort(),
    );
  });

  // One exception: ReadFile streams a file of at most 10 MiB in 64 KiB chunks and stops at the drain deadline (content/files.ts).
  it('keeps every RPC unary but ReadFile: no stream holds a drain open', () => {
    expect(methods().length).toBeGreaterThan(0);
    for (const m of methods()) expect(m.methodKind, rpc(m)).toBe(rpc(m) === 'ContentService.ReadFile' ? 'server_streaming' : 'unary');
  });

  it('marks every List/Get/Export/Read RPC as a read (NO_SIDE_EFFECTS), and nothing else', () => {
    for (const m of methods()) {
      const isRead = /^(List|Get|Export|Read)/.test(m.name);
      expect(m.idempotency === Idempotency.NO_SIDE_EFFECTS, rpc(m)).toBe(isRead);
    }
  });
});

describe(`${PKG}: the approval rule (SOLO-APPROVE)`, () => {
  it('is its own service: two reads for officers and the Admin\'s one write', () => {
    expect(service('ApprovalRuleService')?.methods.map((m) => [m.name, m.idempotency === Idempotency.NO_SIDE_EFFECTS])).toEqual([
      ['GetApprovalRules', true],
      ['SetApprovalRule', false],
      ['ListApprovalRuleChanges', true],
    ]);
  });

  it('sets a scope to a rule with a reason, and says whether anything changed', () => {
    const set = service('ApprovalRuleService')?.methods.find((m) => m.name === 'SetApprovalRule');
    // expected_revision: the revision the Admin read, so a stale form cannot undo a later switch.
    expect(fieldNames(set?.input)).toEqual(['scope', 'rule', 'reason', 'expected_revision']);
    expect(fieldNames(set?.output)).toEqual(['setting', 'changed']);
  });

  it('never names who set the rule in the setting itself: the revision is the switch\'s id, not a person', () => {
    const get = service('ApprovalRuleService')?.methods.find((m) => m.name === 'GetApprovalRules');
    const setting = get?.output.fields.map(fieldMessage).find((m) => m !== undefined);
    expect(fieldNames(setting)).toEqual(['scope', 'rule', 'set_at', 'revision']);
  });
});

describe(`${PKG}: the membership verifier`, () => {
  it('is its own service with exactly ListPendingVerifications, ReportVerification and ListReleasedClaims', () => {
    expect(service('MembershipVerifierService')?.methods.map((m) => m.name)).toEqual([
      'ListPendingVerifications',
      'ReportVerification',
      'ListReleasedClaims',
    ]);
  });

  it('lists a pending verification as request id, membership number, last name and the sign-up\'s email only, a page at a time', () => {
    const list = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ListPendingVerifications');
    expect(fieldNames(list?.input)).toEqual(['page_size']);
    const item = list?.output.fields.map(fieldMessage).find((m) => m !== undefined);
    expect(fieldNames(item)).toEqual(['request_id', 'membership_number', 'last_name', 'email']);
  });

  it('takes back a request id, an outcome and, for a duplicate claim, the earlier sign-up: nothing else', () => {
    const report = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ReportVerification');
    expect(fieldNames(report?.input)).toEqual(['request_id', 'outcome', 'conflicting_request_id']);
    expect(fieldNames(report?.output)).toEqual([]);
    const outcome = report?.input.fields.map(fieldEnum).find((e) => e !== undefined);
    expect(outcome?.values.map((v) => v.name)).toEqual([
      'VERIFICATION_OUTCOME_UNSPECIFIED',
      'VERIFICATION_OUTCOME_VERIFIED_LOCAL',
      'VERIFICATION_OUTCOME_VERIFIED_OTHER_GROUP',
      'VERIFICATION_OUTCOME_NOT_FOUND',
      'VERIFICATION_OUTCOME_ERROR',
      'VERIFICATION_OUTCOME_EMAIL_MISMATCH',
      'VERIFICATION_OUTCOME_DUPLICATE_CLAIM',
    ]);
  });

  it('VET: lists released claims as sign-up ids, times and kinds after a cursor, never a number, a name or an email', () => {
    const list = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ListReleasedClaims');
    expect(list?.idempotency).toBe(Idempotency.NO_SIDE_EFFECTS);
    expect(fieldNames(list?.input)).toEqual(['after', 'page_size']);
    expect(fieldNames(list?.output)).toEqual(['released', 'next_cursor']);
    const item = list?.output.fields.map(fieldMessage).find((m) => m !== undefined);
    expect(fieldNames(item)).toEqual(['request_id', 'released_at', 'kind']);
    const kind = item?.fields.map(fieldEnum).find((e) => e !== undefined);
    expect(kind?.values.map((v) => v.name)).toEqual([
      'CLAIM_RELEASE_KIND_UNSPECIFIED',
      'CLAIM_RELEASE_KIND_REJECTED',
      'CLAIM_RELEASE_KIND_REOPENED',
      'CLAIM_RELEASE_KIND_ACCOUNT_DELETED',
      // Fix 1 (N3): a reported pending sign-up the database owner deleted.
      'CLAIM_RELEASE_KIND_DELETED',
    ]);
    const names = list === undefined ? [] : reachableFields(list.output).map((f) => f.name);
    expect(names.filter((n) => /number|name|email/.test(n))).toEqual([]);
  });

  it('VET: lets the approver see the two new outcomes and the earlier claim by its display name, date and typed values', () => {
    const verification = files.flatMap((file) => file.enums).find((e) => e.typeName === `${PKG}.Verification`);
    expect(verification?.values.map((v) => v.name).slice(-2)).toEqual(['VERIFICATION_EMAIL_MISMATCH', 'VERIFICATION_DUPLICATE_CLAIM']);
    const request = allMessages().find((m) => m.typeName === `${PKG}.SignupRequest`);
    const earlier = request?.fields.find((f) => f.name === 'earlier_claim');
    expect(earlier?.number).toBe(8);
    // Fix 1 (N2): closed, with no display name, when the earlier sign-up was rejected or reopened.
    // PROFILE-ID: and the names and number it typed, so the approver can compare.
    expect(fieldNames(earlier === undefined ? undefined : fieldMessage(earlier))).toEqual(['display_name', 'signed_up_at', 'closed', 'first_name', 'last_name', 'membership_number']);
  });

  it('PROFILE-ID: shows the approvers what each sign-up typed, pending or rejected', () => {
    const message = (name: string) => allMessages().find((m) => m.typeName === `${PKG}.${name}`);
    expect(fieldNames(message('SignupRequest')).slice(-3)).toEqual(['first_name', 'last_name', 'membership_number']);
    expect(fieldNames(message('RejectedSignup')).slice(-3)).toEqual(['first_name', 'last_name', 'membership_number']);
    expect(fieldNames(message('SubmitSignupRequest'))).toEqual(['last_name', 'membership_number', 'first_name']);
  });

  it('PROFILE-ID: gives the owner a profile to read, and a change that takes the two names and nothing else', () => {
    const membership = service('MembershipService');
    const mine = membership?.methods.find((m) => m.name === 'GetMyAccount');
    const profile = mine?.output.fields.find((f) => f.name === 'profile');
    expect(fieldNames(profile === undefined ? undefined : fieldMessage(profile))).toEqual(['first_name', 'last_name', 'membership_number']);
    const update = membership?.methods.find((m) => m.name === 'UpdateMyProfile');
    expect(update?.idempotency).not.toBe(Idempotency.NO_SIDE_EFFECTS);
    expect(fieldNames(update?.input)).toEqual(['first_name', 'last_name']);
    expect(fieldNames(update?.output)).toEqual([]);
    // The account the approvers' calls return carries no profile: only GetMyAccount does.
    expect(fieldNames(allMessages().find((m) => m.typeName === `${PKG}.MemberAccount`))).toEqual(['status', 'route', 'verified_on']);
    expect(fieldNames(allMessages().find((m) => m.typeName === `${PKG}.Member`))).not.toContain('membership_number');
  });

  it('VET fix 1: an approval of a warning outcome carries the approver\'s confirmation, nothing else new', () => {
    const approve = service('MembershipService')?.methods.find((m) => m.name === 'ApproveSignup');
    expect(fieldNames(approve?.input)).toEqual(['request_id', 'confirmed_warning']);
    expect(approve?.input.fields.find((f) => f.name === 'confirmed_warning')?.fieldKind).toBe('scalar');
  });

  // PROFILE-ID: the owner (GetMyAccount) and the approvers (the queue and the rejections) see it too.
  const NUMBER_CARRIERS = [
    'MembershipService.GetMyAccount out',
    'MembershipService.ListRejectedSignups out',
    'MembershipService.ListSignupRequests out',
    'MembershipService.SubmitSignup in',
    'MembershipVerifierService.ListPendingVerifications out',
  ];
  const carriersOf = (name: string): string[] =>
    methods()
      .flatMap((m) => [
        ...(reachableFields(m.input).some((f) => f.name === name) ? [`${rpc(m)} in`] : []),
        ...(reachableFields(m.output).some((f) => f.name === name) ? [`${rpc(m)} out`] : []),
      ])
      .sort();

  it('lets the membership number reach only the pending list, the sign-up call, the owner and the approvers\' two lists', () => {
    expect(carriersOf('membership_number')).toEqual(NUMBER_CARRIERS);
  });

  it('lets the last name reach the same places, and the owner\'s change of name (in)', () => {
    expect(carriersOf('last_name')).toEqual([...NUMBER_CARRIERS, 'MembershipService.UpdateMyProfile in'].sort());
  });

  it('PROFILE-ID: lets the first name reach the same places but the verifier\'s', () => {
    expect(carriersOf('first_name')).toEqual(
      [...NUMBER_CARRIERS.filter((c) => !c.startsWith('MembershipVerifierService')), 'MembershipService.UpdateMyProfile in'].sort(),
    );
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

  it('returns the verifier exactly its pending list of four fields (VET: the sign-up\'s email), nothing reachable besides', () => {
    const list = service('MembershipVerifierService')?.methods.find((m) => m.name === 'ListPendingVerifications');
    expect(list === undefined ? [] : reachableFields(list.output).map((f) => f.name)).toEqual(['pending', 'request_id', 'membership_number', 'last_name', 'email']);
  });

  it('lets a membership number under any name reach only the places it is shown (PROFILE-ID), and never in to change it', () => {
    const carriers = methods().flatMap((m) => [
      ...(reachableFields(m.input).some((f) => NUMBER_LIKE.test(f.name)) ? [`${rpc(m)} in`] : []),
      ...(reachableFields(m.output).some((f) => NUMBER_LIKE.test(f.name)) ? [`${rpc(m)} out`] : []),
    ]);
    expect(carriers.sort()).toEqual([
      'MembershipService.GetMyAccount out',
      'MembershipService.ListRejectedSignups out',
      'MembershipService.ListSignupRequests out',
      'MembershipService.SubmitSignup in',
      'MembershipVerifierService.ListPendingVerifications out',
    ]);
  });
});
