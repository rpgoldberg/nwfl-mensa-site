// LAUNCH-FIX-1: the privacy page, the error page and the footer's link, rendered by Astro's container.
// The privacy page's statements are held to the code by name: each test below names the file that
// makes its statement true.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINKS_COOKIE, SIZE_COOKIE, THEME_COOKIE } from '../../server/prefs.mjs';
import { AUTH_COOKIE } from '../../server/session.mjs';
import { SESSION_COOKIE } from '../../server/policy.mjs';
import NotFound from '../../src/pages/404.astro';
import ServerError from '../../src/pages/500.astro';
import Privacy from '../../src/pages/privacy.astro';

let container: AstroContainer;
const render = (page: Parameters<AstroContainer['renderToString']>[0], path: string) => container.renderToString(page, { request: new Request(`https://nwflorida.us${path}`) });
/** The words a reader sees in <main>, tags dropped. */
const mainText = (html: string) =>
  (/<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

beforeAll(async () => {
  container = await AstroContainer.create();
});

describe('/privacy', () => {
  let html = '';
  let text = '';
  beforeAll(async () => {
    html = await render(Privacy, '/privacy');
    text = mainText(html);
  });

  it('is a page in the site layout, headed Privacy, under 450 words, and never says draft', () => {
    expect(html).toContain('<title>Privacy | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<h1[^>]*>Privacy<\/h1>/);
    expect(html).toContain('class="skip-link"');
    expect(text.split(' ').length).toBeLessThan(450);
    expect(text.split(' ').length).toBeGreaterThan(150);
    expect(text).not.toMatch(/draft/i);
  });

  it('lists what a sign-up stores: the columns of signup_request and member_account (migrations 0005 to 0028)', () => {
    for (const words of ['first name and last name', 'Mensa membership number', 'name and email address on your sign-in', 'date you signed up', 'who decided', 'result of the membership check', 'last confirmed']) expect(text, words).toContain(words);
    const schema = ['0005_membership.sql', '0007_a2_fix.sql', '0009_membership_fix.sql', '0026_signup_reopen.sql', '0027_signup_vetting.sql', '0028_member_profile.sql'].map((f) => readFileSync(`../api/migrations/${f}`, 'utf8')).join('\n');
    for (const column of ['first_name', 'last_name', 'membership_number', 'display_name', 'email', 'created_at', 'decided_by_sub', 'decided_at', 'verification', 'verified_on']) expect(schema, column).toMatch(new RegExp(`\\b${column}\\b`));
    // What the page says we do not keep has no column anywhere in the schema.
    expect(text).toContain('We do not keep your address, phone number or birthday.');
    expect(schema).not.toMatch(/^\s+(address|street|phone|birth\w*|password)\s/m);
  });

  it('says we never ask for or keep a Mensa sign-in or password, and names the check only as Mensa\'s own records', () => {
    expect(text).toMatch(/never ask for the user name or password you use at American Mensa.s website, and we do not keep them/);
    expect(text).toContain("We check your membership with Mensa's own records.");
    // The sign-up form's only fields (src/pages/account.astro).
    const form = readFileSync('src/pages/account.astro', 'utf8');
    expect([...form.matchAll(/<input\s+type="(?:text|password|email)"\s+id="([A-Za-z]+)"/g)].map((m) => m[1])).toEqual(['firstName', 'lastName', 'membershipNumber']);
    expect(form).not.toMatch(/type="password"/);
  });

  it('says who can see a sign-up: the approving officers and the Admin; a rejected one, the Admin and the Membership Officer (api/src/auth/roles.ts)', () => {
    expect(text).toContain('The officers who approve sign-ups, and the site\'s Admin');
    expect(text).toContain('The Admin and the Membership Officer can also see a sign-up that was not approved.');
    const roles = readFileSync('../api/src/auth/roles.ts', 'utf8');
    expect(roles).toContain('if (!roles.membershipApprover && !roles.admin) throw denied();');
    expect(roles).toContain('if (!roles.admin && !roles.offices.includes(MEMBERSHIP_OFFICE)) throw denied();');
  });

  it('gives the 13 months of api/src/auth/standing.ts, and says a removed account keeps its sign-up record (migration 0026)', () => {
    const VERIFICATION_MONTHS = Number(/export const VERIFICATION_MONTHS = (\d+);/.exec(readFileSync('../api/src/auth/standing.ts', 'utf8'))?.[1]);
    expect(VERIFICATION_MONTHS).toBe(13);
    expect(text).toContain(`Member access lasts ${VERIFICATION_MONTHS} months from the last time your membership was confirmed.`);
    expect(text).toContain('the record of your sign-up stays');
    expect(text).toContain('until you ask us to remove it');
    expect(readFileSync('../api/migrations/0026_signup_reopen.sql', 'utf8')).toContain('is decided and is kept');
  });

  it('names every cookie the site sets by what it is for, and no tracking: five cookies, scripts from this site only', () => {
    expect([SESSION_COOKIE, AUTH_COOKIE, SIZE_COOKIE, THEME_COOKIE, LINKS_COOKIE]).toEqual(['__Host-nwfl-session', '__Host-nwfl-auth', '__Host-nwfl-size', '__Host-nwfl-theme', '__Host-nwfl-links']);
    const set = ['policy.mjs', 'prefs.mjs', 'session.mjs'].flatMap((f) => [...readFileSync(`server/${f}`, 'utf8').matchAll(/'(__Host-[a-z-]+)'/g)].map((m) => m[1]));
    expect([...new Set(set)].sort()).toEqual(['__Host-nwfl-auth', '__Host-nwfl-links', '__Host-nwfl-session', '__Host-nwfl-size', '__Host-nwfl-theme']);
    for (const words of ['sign you in and keep you signed in', 'your text size, your theme', 'links that leave the site', 'no tracking and no advertising']) expect(text, words).toContain(words);
    const policy = readFileSync('server/policy.mjs', 'utf8');
    expect(policy).toContain(`"script-src 'self'"`);
    expect(policy).toContain(`"connect-src 'self'"`);
  });

  it('says what the log holds: the time, what was asked for and a request number (server/log.mjs, api/src/grpc/interceptors.ts)', () => {
    expect(text).toContain('the time, what was asked for and a request number');
    expect(text).toContain('It does not record what a page says or what you type into a form.');
    expect(readFileSync('server/log.mjs', 'utf8')).toContain('trace_id: trace?.traceId');
    expect(readFileSync('../api/src/grpc/interceptors.ts', 'utf8')).toContain('request_id: requestId');
  });

  it('sends a request for a copy or for removal to the officers page, and links nowhere behind sign-in', () => {
    const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
    expect([...main.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/officers']);
    expect(text).toMatch(/ask for a copy of what we keep about you, or ask us to remove it/);
  });

  it('never says how the membership check is done', () => {
    expect(text).not.toMatch(/verif|roster|scrap|robot|automat|national office|us\.mensa\.org/i);
  });
});

describe('the footer of every page', () => {
  it('links to /privacy', async () => {
    for (const html of [await render(NotFound, '/no-such-page'), await render(Privacy, '/privacy'), await render(ServerError, '/500')]) {
      const footer = /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';
      expect(footer).toContain('<a href="/privacy">Privacy</a>');
    }
  });
});

describe('the error page (500)', () => {
  it('says so in plain words in the site layout, with a link to the officers, and is kept out of search', async () => {
    const html = await render(ServerError, '/500');
    expect(html).toContain('class="skip-link"');
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).toMatch(/<h1[^>]*>Something went wrong on our side<\/h1>/);
    expect(mainText(html)).toBe('Something went wrong on our side Please try again in a few minutes. If it keeps happening, tell an officer .');
    expect(/<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1]).toContain('<a href="/officers">tell an officer</a>');
  });
});
