// EDITOR E3 round 2: the auto-save endpoint, each answer, with the editor's API and the sign-in stood in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiNotFound } from '../../src/lib/api/client';
import { DraftChanged, EditorRefused, NotAllowed, SignInAgain } from '../../src/lib/api/editor';

const state = vi.hoisted(() => ({
  api: undefined as undefined | { saveDraft: ReturnType<typeof vi.fn>; offices: ReturnType<typeof vi.fn>; getWorkingItem: ReturnType<typeof vi.fn> },
  reader: { bearer: 'tok' } as undefined | { bearer: string },
}));

vi.mock('../../src/lib/api/editor', async (actual) => ({
  ...(await actual<typeof import('../../src/lib/api/editor')>()),
  editorApi: () => state.api,
  editorReader: () => ({ reader: state.reader, lapsed: state.reader === undefined }),
}));
vi.mock('../../src/lib/auth/flow', () => ({
  // 20:05 UTC, November 12, 2026: 2:05 pm Central.
  runtimeDeps: () => ({ now: () => Date.parse('2026-11-12T20:05:00Z') / 1000 }),
}));

const { GET, POST } = await import('../../src/pages/officer-area/news/[id]/autosave');

type Ctx = Parameters<typeof POST>[0];
const ID = 'c0e20000-0000-4000-8000-0000000000a1';
const OFFICER = { groups: ['nwfl-members', 'nwfl-officers', 'nwfl-office-president'] };
const PRESIDENT = { id: 'c0e20000-0000-4000-8000-0000000000f1', slug: 'president', title: 'President' };
const SOCIAL = { id: 'c0e20000-0000-4000-8000-0000000000f2', slug: 'social', title: 'Social Chair' };
const FORM = { title: 'Fall picnic', summary: '', visibility: 'public', markup: 'Noon.', base: '1794528300.123456000' };

function post(fields: Record<string, string> = FORM, opts: { id?: string; session?: unknown; type?: string; length?: string } = {}) {
  const headers = new Headers({ 'content-type': opts.type ?? 'application/x-www-form-urlencoded' });
  if (opts.length) headers.set('content-length', opts.length);
  const request = new Request(`https://site.test/officer-area/news/${opts.id ?? ID}/autosave`, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
  return POST({ request, params: { id: opts.id ?? ID }, locals: { session: 'session' in opts ? opts.session : OFFICER } } as unknown as Ctx) as Promise<Response>;
}

beforeEach(() => {
  state.api = {
    saveDraft: vi.fn(async () => ({ item: { working: { base: '1794528360.000000000' } }, problems: [] })),
    offices: vi.fn(async () => [PRESIDENT, SOCIAL]),
    getWorkingItem: vi.fn(async () => ({ id: ID, officeId: PRESIDENT.id })),
  };
  state.reader = { bearer: 'tok' };
});

describe('POST /officer-area/news/[id]/autosave', () => {
  it('saves automatically, with the base the page was opened from, and answers the new base and the time', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({ base: '1794528360.000000000', savedAt: '2:05 pm' });
    expect(state.api?.saveDraft).toHaveBeenCalledWith(state.reader, { itemId: ID, title: 'Fall picnic', summary: '', visibility: 'public', markup: 'Noon.', base: '1794528300.123456000', auto: true });
  });

  it('sends no base when the form has none, and answers an empty base when the API gives none', async () => {
    state.api!.saveDraft.mockResolvedValueOnce({ item: {}, problems: [] });
    const res = await post(Object.fromEntries(Object.entries(FORM).filter(([name]) => name !== 'base')));
    expect(await res.json()).toMatchObject({ base: '' });
    expect(state.api?.saveDraft.mock.calls[0]?.[1]).toMatchObject({ base: '', auto: true });
  });

  it.each([
    ['an id that is not one', { id: 'nope' }, 404],
    ['no session', { session: undefined }, 401],
    ['a member', { session: { groups: ['nwfl-members'] } }, 404],
  ])('refuses %s, saving nothing', async (_what, opts, status) => {
    expect((await post(FORM, opts)).status).toBe(status);
    expect(state.api?.saveDraft).not.toHaveBeenCalled();
  });

  it('answers 503 with no API, and 401 with no sign-in to send', async () => {
    state.reader = undefined;
    expect((await post()).status).toBe(401);
    state.api = undefined;
    expect((await post()).status).toBe(503);
  });

  it('refuses what is not the form, a body over the cap (closing), and a field not right yet (try later)', async () => {
    expect((await post(FORM, { type: 'application/json' })).status).toBe(415);
    const big = await post(FORM, { length: String(57 * 1024) });
    expect(big.status).toBe(413);
    expect(big.headers.get('connection')).toBe('close');
    const blank = await post({ ...FORM, title: '' });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ problem: 'form' });
    expect(state.api?.saveDraft).not.toHaveBeenCalled();
  });

  it.each([
    ['someone else changed it', new DraftChanged('SaveDraft'), 409, { problem: 'changed' }],
    ['the sign-in ran out', new SignInAgain('SaveDraft'), 401, { problem: 'sign-in' }],
    ['it is no longer a draft', new EditorRefused('SaveDraft', 'an automatic save only saves a draft'), 422, { problem: 'not-draft' }],
    ['another refusal', new EditorRefused('SaveDraft', 'title is required'), 400, { problem: 'refused' }],
    ['not this person\'s item', new NotAllowed('SaveDraft'), 403, {}],
    ['no such item', new ApiNotFound('SaveDraft'), 404, {}],
    ['the API not there', new Error('down'), 503, {}],
  ])('answers when %s', async (_what, error, status, body) => {
    state.api!.saveDraft.mockRejectedValueOnce(error);
    const res = await post();
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('the office check, as the edit page makes it (E7A-FIX, the E7a check\'s N2)', () => {
  it('answers 404 for another office\'s item, after reading it, before any save', async () => {
    state.api!.getWorkingItem.mockResolvedValueOnce({ id: ID, officeId: SOCIAL.id });
    const res = await post();
    expect(res.status).toBe(404);
    expect(state.api?.getWorkingItem).toHaveBeenCalledWith(state.reader, ID);
    expect(state.api?.saveDraft).not.toHaveBeenCalled();
  });

  it('answers 404 to someone who holds no office (the Webmaster), before any call to the API', async () => {
    const res = await post(FORM, { session: { groups: ['nwfl-members', 'nwfl-webmaster'] } });
    expect(res.status).toBe(404);
    expect(state.api?.offices).not.toHaveBeenCalled();
    expect(state.api?.getWorkingItem).not.toHaveBeenCalled();
    expect(state.api?.saveDraft).not.toHaveBeenCalled();
  });

  it('lets the Admin save for any office', async () => {
    state.api!.getWorkingItem.mockResolvedValueOnce({ id: ID, officeId: SOCIAL.id });
    expect((await post(FORM, { session: { groups: ['nwfl-members', 'nwfl-admin'] } })).status).toBe(200);
    expect(state.api?.saveDraft).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no such item', new ApiNotFound('GetWorkingItem'), 404],
    ['the sign-in ran out', new SignInAgain('GetWorkingItem'), 401],
    ['the API not there', new Error('down'), 503],
  ])('answers when reading the item finds %s, saving nothing', async (_what, error, status) => {
    state.api!.getWorkingItem.mockRejectedValueOnce(error);
    expect((await post()).status).toBe(status);
    expect(state.api?.saveDraft).not.toHaveBeenCalled();
  });
});

describe('GET /officer-area/news/[id]/autosave', () => {
  it('finds nothing to read: 405, a post only, never cached', async () => {
    const res = (await GET({} as Ctx)) as Response;
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
