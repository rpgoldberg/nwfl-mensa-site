// Roles from the token's nwfl- groups (R10, R25, R33): the own-office rule,
// the content and membership approvers, the affiliate grant, machine scopes.
import { Code } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { ANONYMOUS, type Caller } from './caller.js';
import { internalGroups } from './groups.js';
import {
  requireAdmin,
  requireEditorReader,
  requireGrantor,
  requireMembershipApprover,
  requireOffice,
  requireOfficer,
  requireOfficerOrAdmin,
  requirePublisher,
  requireReviewer,
  requireScope,
  requireSignupReopener,
  requireUser,
  rolesOf,
} from './roles.js';

const user = (...groups: string[]): Caller => ({ kind: 'user', subject: 'sub-x', groups, scopes: [], audience: 'public' });
const agent: Caller = { kind: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'], audience: 'members' };

const adminEditor = user('nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-office-editor', 'nwfl-admin');
const webmaster = user('nwfl-members', 'nwfl-officers', 'nwfl-office-webmaster', 'nwfl-webmaster');
const treasurer = user('nwfl-members', 'nwfl-officers', 'nwfl-office-treasurer');
const approver = user('nwfl-members', 'nwfl-membership-approvers');
const rvc = user('nwfl-affiliates', 'nwfl-role-rvc');
const member = user('nwfl-members');

describe('rolesOf a chapter caller (CF-ISO-0: SITE_GROUP_PREFIX=mensa-nwfl-)', () => {
  it('reads every role from the internal names the gate carries for mensa-nwfl- groups', () => {
    const groups = internalGroups(
      ['mensa-nwfl-admin', 'mensa-nwfl-webmaster', 'mensa-nwfl-officers', 'mensa-nwfl-membership-approvers', 'mensa-nwfl-affiliates', 'mensa-nwfl-office-editor', 'mensa-nwfl-role-rvc'],
      'mensa-nwfl-',
    );
    expect(rolesOf(user(...groups))).toEqual({ admin: true, webmaster: true, officer: true, membershipApprover: true, affiliate: true, offices: ['editor'], roles: ['rvc'] });
  });

  it('gives a bare nwfl- token and another chapter\'s nothing', () => {
    const none = { admin: false, webmaster: false, officer: false, membershipApprover: false, affiliate: false, offices: [], roles: [] };
    expect(rolesOf(user(...internalGroups(['nwfl-admin', 'nwfl-officers', 'nwfl-office-editor'], 'mensa-nwfl-')))).toEqual(none);
    expect(rolesOf(user(...internalGroups(['mensa-other-admin', 'mensa-other-officers', 'mensa-other-office-editor'], 'mensa-nwfl-')))).toEqual(none);
  });
});

describe('rolesOf', () => {
  it('reads every role from the groups', () => {
    expect(rolesOf(adminEditor)).toEqual({
      admin: true,
      webmaster: false,
      officer: true,
      membershipApprover: false,
      affiliate: false,
      offices: ['publications', 'editor'],
      roles: [],
    });
    expect(rolesOf(rvc)).toMatchObject({ affiliate: true, roles: ['rvc'], officer: false, offices: [] });
  });
});

describe('requireOffice: the own-office rule', () => {
  it('lets a holder act as their own office', () => {
    expect(requireOffice(treasurer, 'treasurer')).toEqual({ onBehalfOf: false });
    expect(requireOffice(adminEditor, 'editor')).toEqual({ onBehalfOf: false });
  });

  it('lets the Admin act for any office, recorded as on behalf of it', () => {
    expect(requireOffice(adminEditor, 'treasurer')).toEqual({ onBehalfOf: true });
  });

  it('refuses anyone else, including the Webmaster and other officers', () => {
    expect(() => requireOffice(treasurer, 'president')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireOffice(webmaster, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireOffice(member, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });
});

describe('approvers and grants', () => {
  it('makes every officer, the Admin and the Webmaster a content reviewer, and nobody else (EDITOR A1)', () => {
    for (const reviewer of [adminEditor, webmaster, treasurer, user('nwfl-officers'), user('nwfl-admin'), user('nwfl-webmaster')]) {
      expect(() => requireReviewer(reviewer)).not.toThrow();
    }
    expect(requireReviewer(treasurer)).toMatchObject({ officer: true, offices: ['treasurer'] });
    for (const other of [approver, rvc, member, user('nwfl-office-treasurer'), user('nwfl-affiliates', 'nwfl-office-treasurer')]) {
      expect(() => requireReviewer(other)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
  });

  it('makes the Webmaster, and the Admin as backup, the publishers, and no other officer (EDITOR A1)', () => {
    expect(requirePublisher(webmaster)).toMatchObject({ webmaster: true });
    expect(requirePublisher(adminEditor)).toMatchObject({ admin: true, webmaster: false });
    expect(() => requirePublisher(user('nwfl-webmaster'))).not.toThrow();
    for (const other of [treasurer, approver, rvc, member, user('nwfl-officers', 'nwfl-office-webmaster')]) {
      expect(() => requirePublisher(other)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
  });

  it('makes nwfl-membership-approvers, or the Admin while the seat is vacant, the membership approvers', () => {
    expect(() => requireMembershipApprover(approver)).not.toThrow();
    expect(() => requireMembershipApprover(adminEditor)).not.toThrow();
    expect(() => requireMembershipApprover(webmaster)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('lets only the Admin or the Webmaster grant affiliate standing (R33)', () => {
    expect(() => requireGrantor(adminEditor)).not.toThrow();
    expect(() => requireGrantor(webmaster)).not.toThrow();
    expect(() => requireGrantor(approver)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    // Its own rule (EDITOR A1): a reviewer who is neither is not a grantor.
    expect(() => requireGrantor(treasurer)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireGrantor(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => requireGrantor(agent)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('lets every officer read drafts, and nobody else', () => {
    expect(() => requireOfficer(treasurer)).not.toThrow();
    expect(() => requireOfficer(rvc)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });
});

describe('who may hold a role at all', () => {
  it('asks the anonymous caller to sign in, and refuses machine callers', () => {
    expect(() => requireUser(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => requireUser(agent)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireReviewer(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => requirePublisher(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => requireReviewer(agent)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requirePublisher(agent)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireOffice(agent, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('checks a machine scope', () => {
    expect(() => requireScope(agent, 'newsletter.read')).not.toThrow();
    expect(() => requireScope(agent, 'events.write')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireScope(ANONYMOUS, 'newsletter.read')).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });
});

describe('requireAdmin (SOLO-APPROVE: the approval switch)', () => {
  it('lets the Admin through, and no one else: not the Webmaster, an officer, a member or a machine', () => {
    expect(() => requireAdmin(adminEditor)).not.toThrow();
    for (const caller of [webmaster, treasurer, approver, rvc, member, agent]) {
      expect(() => requireAdmin(caller)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
    expect(() => requireAdmin(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });

  it('refuses an admin group under another prefix, which the gate drops', () => {
    expect(() => requireAdmin(user(...internalGroups(['nwfl-admin', 'other-nwfl-admin'], 'mensa-nwfl-')))).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });
});

describe('requireOfficerOrAdmin (SOLO-APPROVE: reading the approval setting)', () => {
  it('lets officers and the Admin through, the Admin without the officers group too, and no one else', () => {
    for (const caller of [adminEditor, webmaster, treasurer, user('nwfl-admin')]) expect(() => requireOfficerOrAdmin(caller)).not.toThrow();
    for (const caller of [member, agent, user('nwfl-members', 'mensa-nwfl-admin')]) {
      expect(() => requireOfficerOrAdmin(caller)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
    expect(() => requireOfficerOrAdmin(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });
});

describe('requireEditorReader (EDITOR E1: the queue, an item, its history and its preview)', () => {
  it('lets officers, the Admin and the Webmaster through, each approver without the officers group too, and no one else', () => {
    for (const caller of [adminEditor, webmaster, treasurer, user('nwfl-officers'), user('nwfl-admin'), user('nwfl-webmaster')]) expect(() => requireEditorReader(caller)).not.toThrow();
    for (const caller of [member, approver, rvc, agent, user('nwfl-office-publications'), user('nwfl-members', 'mensa-nwfl-admin')]) {
      expect(() => requireEditorReader(caller)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
    expect(() => requireEditorReader(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });
});

describe('requireSignupReopener (REOPEN: a mistaken rejection)', () => {
  const membershipOfficer = user('nwfl-members', 'nwfl-officers', 'nwfl-office-membership', 'nwfl-membership-approvers');
  it('lets the Admin and the Membership Officer seat through, the seat without the approvers group too', () => {
    for (const caller of [adminEditor, membershipOfficer, user('nwfl-admin'), user('nwfl-office-membership')]) expect(() => requireSignupReopener(caller)).not.toThrow();
  });

  it('refuses a membership approver who does not hold the seat, the Webmaster, another seat, a member and a machine', () => {
    for (const caller of [approver, webmaster, treasurer, member, rvc, agent, user('nwfl-office-membershipx'), user('nwfl-members', 'mensa-nwfl-office-membership')]) {
      expect(() => requireSignupReopener(caller)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    }
    expect(() => requireSignupReopener(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });
});
