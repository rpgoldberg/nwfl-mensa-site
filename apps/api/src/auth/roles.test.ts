// Roles from the token's nwfl- groups (R10, R25, R33): the own-office rule,
// the content and membership approvers, the affiliate grant, machine scopes.
import { Code } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { ANONYMOUS, type Caller } from './caller.js';
import {
  requireContentApprover,
  requireGrantor,
  requireMembershipApprover,
  requireOffice,
  requireOfficer,
  requireScope,
  requireUser,
  rolesOf,
} from './roles.js';

const user = (...groups: string[]): Caller => ({ kind: 'user', subject: 'sub-x', groups, scopes: [], audience: 'public' });
const agent: Caller = { kind: 'agent', subject: 'svc-nwfl-newsletter', groups: [], scopes: ['newsletter.read'], audience: 'members' };

const ross = user('nwfl-members', 'nwfl-officers', 'nwfl-office-publications', 'nwfl-office-editor', 'nwfl-admin');
const webmaster = user('nwfl-members', 'nwfl-officers', 'nwfl-office-webmaster', 'nwfl-webmaster');
const treasurer = user('nwfl-members', 'nwfl-officers', 'nwfl-office-treasurer');
const approver = user('nwfl-members', 'nwfl-membership-approvers');
const rvc = user('nwfl-affiliates', 'nwfl-role-rvc');
const member = user('nwfl-members');

describe('rolesOf', () => {
  it('reads every role from the groups', () => {
    expect(rolesOf(ross)).toEqual({
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
    expect(requireOffice(ross, 'editor')).toEqual({ onBehalfOf: false });
  });

  it('lets the Admin act for any office, recorded as on behalf of it', () => {
    expect(requireOffice(ross, 'treasurer')).toEqual({ onBehalfOf: true });
  });

  it('refuses anyone else, including the Webmaster and other officers', () => {
    expect(() => requireOffice(treasurer, 'president')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireOffice(webmaster, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireOffice(member, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });
});

describe('approvers and grants', () => {
  it('makes the Admin and the Webmaster the content approvers (P15)', () => {
    expect(() => requireContentApprover(ross)).not.toThrow();
    expect(() => requireContentApprover(webmaster)).not.toThrow();
    expect(() => requireContentApprover(treasurer)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('makes nwfl-membership-approvers, or the Admin while the seat is vacant, the membership approvers', () => {
    expect(() => requireMembershipApprover(approver)).not.toThrow();
    expect(() => requireMembershipApprover(ross)).not.toThrow();
    expect(() => requireMembershipApprover(webmaster)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('lets only the Admin or the Webmaster grant affiliate standing (R33)', () => {
    expect(() => requireGrantor(ross)).not.toThrow();
    expect(() => requireGrantor(webmaster)).not.toThrow();
    expect(() => requireGrantor(approver)).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
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
    expect(() => requireContentApprover(ANONYMOUS)).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
    expect(() => requireOffice(agent, 'treasurer')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
  });

  it('checks a machine scope', () => {
    expect(() => requireScope(agent, 'newsletter.read')).not.toThrow();
    expect(() => requireScope(agent, 'events.write')).toThrow(expect.objectContaining({ code: Code.PermissionDenied }));
    expect(() => requireScope(ANONYMOUS, 'newsletter.read')).toThrow(expect.objectContaining({ code: Code.Unauthenticated }));
  });
});
