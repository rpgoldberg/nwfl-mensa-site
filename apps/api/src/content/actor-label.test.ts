import { describe, expect, it } from 'vitest';
import { actorLabel } from './actor-label.js';

const PUBLICATIONS = { slug: 'publications', title: 'Publications Officer' };
const EDITOR = { slug: 'editor', title: 'Newsletter Editor' };
const user = (groups: string[], actingOffice: typeof PUBLICATIONS | null = null) => ({ kind: 'user', groups, actingOffice });

describe('actorLabel: who acted, by role at the time, never by name', () => {
  it.each([
    ['the seat acted for, when the actor held it', user(['nwfl-officers', 'nwfl-office-publications'], PUBLICATIONS), 'Publications Officer'],
    ['the seat acted for, even for the Admin who holds it', user(['nwfl-officers', 'nwfl-admin', 'nwfl-office-publications'], PUBLICATIONS), 'Publications Officer'],
    ['the Admin acting for an office they do not hold', user(['nwfl-admin'], PUBLICATIONS), 'Admin'],
    ['the Admin with no office acted for', user(['nwfl-officers', 'nwfl-admin', 'nwfl-webmaster']), 'Admin'],
    ['the Webmaster', user(['nwfl-officers', 'nwfl-webmaster', 'nwfl-office-webmaster']), 'Webmaster'],
    ['a holder of the item\'s office, with no office acted for', user(['nwfl-officers', 'nwfl-office-editor']), 'Newsletter Editor'],
    ['another officer', user(['nwfl-officers', 'nwfl-office-treasurer']), 'Officer'],
    ['a signed-in person with no role', user(['nwfl-members']), 'Someone'],
    ['the newsletter agent', { kind: 'agent', groups: [], actingOffice: null }, 'Newsletter agent'],
    ['the membership verifier', { kind: 'verifier', groups: [], actingOffice: null }, 'Membership verifier'],
    ['the issue loader, which writes as the system', { kind: 'system', groups: [], actingOffice: PUBLICATIONS }, 'System'],
  ])('%s', (_case, row, label) => {
    expect(actorLabel(row, EDITOR)).toBe(label);
  });

  it('reads only the internal group names the gate leaves: another chapter\'s admin group is no role', () => {
    expect(actorLabel(user(['nwfl-officers', 'mensa-nwfl-admin', 'admin']), EDITOR)).toBe('Officer');
  });
});
