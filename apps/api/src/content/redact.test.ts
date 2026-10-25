// REDACT R2a: a content item's slug through the lens. A slug is ASCII (0003),
// so it cannot be checked against a mark on an accented name: an audience
// with anything withheld from the item never gets the slug. Every name here
// is made up.
import { describe, expect, it } from 'vitest';
import { cellKey } from '../redaction/policy.js';
import { lensFor, subjectKey } from '../redaction/render.js';
import { slugFor } from './redact.js';

const ID = '00000000-0000-4000-8000-000000000001';
const POLICY = new Map([
  [cellKey('public', 'member_name'), 'redact'],
  [cellKey('members', 'member_name'), 'show'],
]);
const body = { subject: subjectKey('content_item', ID), quote: 'José Núñez', category: 'member_name' };
const item = { id: ID, slug: 'memorial-jose-nunez' };

describe('slugFor', () => {
  it('gives the id to an audience with a passage withheld anywhere in the item, the body included', () => {
    expect(slugFor(item, lensFor('public', POLICY, [body]))).toBe(ID);
  });

  it('gives the slug where nothing is withheld', () => {
    expect(slugFor(item, lensFor('members', POLICY, [body]))).toBe('memorial-jose-nunez');
    expect(slugFor(item, lensFor('public', POLICY, []))).toBe('memorial-jose-nunez');
    expect(slugFor(item, lensFor('public', POLICY, [{ ...body, subject: subjectKey('content_item', '00000000-0000-4000-8000-000000000002') }]))).toBe('memorial-jose-nunez');
  });
});
