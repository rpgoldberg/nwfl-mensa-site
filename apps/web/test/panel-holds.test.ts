// L-ITEM fix round 2: the approvals panel's words, checked against the gate itself. Each row is given to
// the API's own linkHold (apps/api/src/content/item-links.ts), and the panel is handed what the API would
// send for it (accepted, loginWalled, neverFetched), so the words can never say something the gate does not:
// a held link always says what it waits for, and an accepted one never asks for anything.
import { describe, expect, it } from 'vitest';
import { type Answer, type Hold, type Verdict, linkHold, loginWalled, neverFetched } from '../../api/src/content/item-links.js';
import type { PieceLink } from '../src/lib/api/editor';
import { answerWords, linkRows, machineWords } from '../src/lib/editor/review';

const NOW = new Date('2026-11-16T15:00:00Z');
const HOUR = 3_600_000;
const SITE = 'https://club.example.org/page';
const FACEBOOK = 'https://www.facebook.com/groups/example';
// The no-fetch host, named once: the address with userinfo below is put together from it, so no text here reads as a person's email address.
const NO_FETCH_HOST = 'us.mensa.org';
const NATIONAL = `https://${NO_FETCH_HOST}/x`;

const machine = (verdict: Verdict['verdict'], id: bigint, over: Partial<Verdict> = {}): Verdict => ({ verdict, reasons: verdict === 'drop' ? ['dead'] : [], at: new Date(NOW.getTime() - 2 * HOUR), fresh: true, id, ...over });
const human = (answer: Answer['answer'], id: bigint, note: string | null = null): Answer => ({ answer, label: 'Treasurer', note, id });
const STALE = { at: new Date(NOW.getTime() - 8 * 24 * HOUR), fresh: false };

const NOT_YET = 'Not checked yet.';
const CHECKED = 'Checked by Treasurer: it shows the right page.';
const BROKEN_ASKS = 'The link checker found it broken 2 hours ago (dead). Answer Yes only with a note saying why it is right.';

// [the case, the address, the reviewer's latest answer, the checker's latest verdict, the hold, the answer's words, the checker's words]
const CASES: [string, string, Answer | undefined, Verdict | undefined, Hold | undefined, string, string][] = [
  ['no', SITE, human('no', 2n), machine('ok', 1n), 'no', 'Treasurer answered no: it does not show the right page.', 'The link checker found it working 2 hours ago.'],
  ['no, over a DROP', SITE, human('no', 2n, 'Wrong page.'), machine('drop', 1n), 'no', 'Treasurer answered no: it does not show the right page.', BROKEN_ASKS],
  ['drop, no answer', SITE, undefined, machine('drop', 1n), 'drop', NOT_YET, BROKEN_ASKS],
  ['drop, a yes with no note', SITE, human('yes', 2n), machine('drop', 1n), 'drop', 'Treasurer answered yes, but that does not count yet: the link checker found it broken, so it needs a Yes with a note saying why it is right.', BROKEN_ASKS],
  ['drop, after a yes with a note', SITE, human('yes', 1n, 'It moved.'), machine('drop', 2n), 'drop', 'Treasurer answered yes, but that does not count yet: the link checker found it broken, so it needs a Yes with a note saying why it is right.', BROKEN_ASKS],
  ['drop on a sign-in link', FACEBOOK, undefined, machine('drop', 1n), 'drop', NOT_YET, BROKEN_ASKS],
  ['a lifted drop', SITE, human('yes', 2n, 'It moved; the old address forwards.'), machine('drop', 1n), undefined, CHECKED, "The link checker found it broken 2 hours ago (dead); a person's yes with a note lets it through."],
  ['walled, nothing', FACEBOOK, undefined, undefined, 'walled', NOT_YET, 'The link checker does not open links that need a sign-in: a person checks it.'],
  ['walled, a CONFIRM', FACEBOOK, undefined, machine('confirm', 1n, { reasons: ['login-walled'] }), 'walled', NOT_YET, 'The link checker could not tell 2 hours ago (login-walled): a person checks it.'],
  ['walled, a fresh OK', FACEBOOK, undefined, machine('ok', 1n), 'walled', NOT_YET, 'The link checker found it working 2 hours ago. That does not count for a link that needs a sign-in: a person checks it.'],
  ['walled, an address nobody can read with a fresh OK', `https://user@${NO_FETCH_HOST}/x`, undefined, machine('ok', 1n), 'walled', NOT_YET, 'The link checker found it working 2 hours ago. That does not count for a link that needs a sign-in: a person checks it.'],
  ['walled, a yes', FACEBOOK, human('yes', 1n), undefined, undefined, CHECKED, 'The link checker does not open links that need a sign-in: a person checks it.'],
  ['unchecked, nothing', SITE, undefined, undefined, 'unchecked', NOT_YET, 'The link checker has not checked it yet.'],
  ['unchecked, a CONFIRM', SITE, undefined, machine('confirm', 1n, { reasons: ['timeout'] }), 'unchecked', NOT_YET, 'The link checker could not tell 2 hours ago (timeout): a person checks it.'],
  ['unchecked, a stale OK', SITE, undefined, machine('ok', 1n, STALE), 'unchecked', NOT_YET, 'The link checker found it working 8 days ago. That no longer counts (an OK counts for 7 days): it checks the link again, or a person answers.'],
  ['unchecked, a no-fetch OK', NATIONAL, undefined, machine('ok', 1n), 'unchecked', NOT_YET, 'The link checker does not check this site: a person opens it and answers.'],
  ['unchecked, a no-fetch CONFIRM', NATIONAL, undefined, machine('confirm', 1n, { reasons: ['no-fetch'] }), 'unchecked', NOT_YET, 'The link checker could not tell 2 hours ago (no-fetch): a person checks it.'],
  ['a no-fetch OK, then a yes', NATIONAL, human('yes', 2n), machine('ok', 1n), undefined, CHECKED, 'The link checker does not check this site.'],
  ['a fresh OK', SITE, undefined, machine('ok', 1n), undefined, 'No person has answered: the link checker found it working, and that counts.', 'The link checker found it working 2 hours ago.'],
  ['a yes over a stale OK', SITE, human('yes', 2n), machine('ok', 1n, STALE), undefined, CHECKED, 'The link checker found it working 8 days ago.'],
  ['a yes over a CONFIRM', SITE, human('yes', 2n), machine('confirm', 1n, { reasons: ['timeout'] }), undefined, CHECKED, 'The link checker could not tell 2 hours ago (timeout): a person checks it.'],
];

/** The row the API sends for a link the gate reads this way (link-gate.ts shown). */
const sent = (url: string, answer: Answer | undefined, verdict: Verdict | undefined): PieceLink => ({
  url,
  label: '',
  where: 'in the text',
  loginWalled: loginWalled(url),
  neverFetched: neverFetched(url),
  answeredByLabel: answer?.label ?? '',
  reviewerAnswer: answer?.answer ?? 'none',
  ...(verdict !== undefined ? { machine: { verdict: verdict.verdict, reasons: verdict.reasons, checkedAt: verdict.at } } : {}),
  accepted: linkHold(url, answer, verdict) === undefined,
});

// What a row says when it asks for a step, and what it says when the gate has what it needs.
const ASKS = /Not checked yet|answered no|does not count|no longer counts|Answer Yes only with a note|needs a Yes with a note|a person opens it and answers/;
const DONE = /^(Checked by Treasurer: it shows the right page\.|No person has answered: the link checker found it working, and that counts\.) /;
// Nothing an accepted row may say: each asks for a step, or says the gate does not count something.
const NEVER_WHEN_ACCEPTED = /Not checked yet|answered no|does not count|no longer counts|Answer Yes|needs a Yes|opens it and answers/;

describe('the panel words against the gate (linkHold), for every kind of hold', () => {
  it('covers each hold, a lifted DROP, a stale OK and a no-fetch OK', () => {
    const holds = new Set(CASES.map(([, url, answer, verdict]) => linkHold(url, answer, verdict)));
    expect([...holds].map(String).sort()).toEqual(['drop', 'no', 'unchecked', 'undefined', 'walled']);
  });

  it.each(CASES)('%s', (_name, url, answer, verdict, hold, answerSays, checkerSays) => {
    expect(linkHold(url, answer, verdict)).toBe(hold);
    const [row] = linkRows([sent(url, answer, verdict)]);
    if (row === undefined) throw new Error('no row');
    expect(answerWords(row)).toBe(answerSays);
    expect(machineWords(row, NOW)).toBe(checkerSays);
    const said = `${answerWords(row)} ${machineWords(row, NOW)}`;
    if (hold === undefined) {
      expect(said).toMatch(DONE);
      expect(said).not.toMatch(NEVER_WHEN_ACCEPTED);
    } else {
      expect(said).toMatch(ASKS);
      expect(said).not.toMatch(DONE);
    }
  });
});
