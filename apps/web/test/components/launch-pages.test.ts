// LAUNCH-FIX-1: the privacy page, the error page and the footer's link, rendered by Astro's container.
// The privacy page's statements are held to the code by name: each test below names the file that
// makes its statement true.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { LINKS_COOKIE, SIZE_COOKIE, THEME_COOKIE } from '../../server/prefs.mjs';
import { AUTH_COOKIE } from '../../server/session.mjs';
import { SESSION_COOKIE } from '../../server/policy.mjs';
import NotFound from '../../src/pages/404.astro';
import ServerError from '../../src/pages/500.astro';
import Privacy from '../../src/pages/privacy.astro';
import { POST as postPrefs } from '../../src/pages/prefs';

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

  // OFFICER-VERIFY: 560 (was 520) for the local group and the first-name check the membership check now reports.
  it('is a page in the site layout, headed Privacy, under 560 words, and never says draft', () => {
    expect(html).toContain('<title>Privacy | Northwest Florida Mensa</title>');
    expect(html).toMatch(/<h1[^>]*>Privacy<\/h1>/);
    expect(html).toContain('class="skip-link"');
    expect(text.split(' ').length).toBeLessThan(560);
    expect(text.split(' ').length).toBeGreaterThan(150);
    expect(text).not.toMatch(/draft/i);
  });

  it('lists what a sign-up stores: the columns of signup_request and member_account (migrations 0005 to 0032)', () => {
    for (const words of ['first name and last name', 'Mensa membership number', 'name and email address on your sign-in', 'date you signed up', 'who decided', 'result of the membership check', 'last confirmed']) expect(text, words).toContain(words);
    const schema = ['0005_membership.sql', '0007_a2_fix.sql', '0009_membership_fix.sql', '0026_signup_reopen.sql', '0027_signup_vetting.sql', '0028_member_profile.sql', '0032_officer_verify.sql']
      .map((f) => readFileSync(`../api/migrations/${f}`, 'utf8'))
      .join('\n');
    for (const column of ['first_name', 'last_name', 'membership_number', 'display_name', 'email', 'created_at', 'decided_by_sub', 'decided_at', 'verification', 'verified_on', 'first_name_matched', 'local_group', 'chapter_member']) {
      expect(schema, column).toMatch(new RegExp(`\\b${column}\\b`));
    }
    // OFFICER-VERIFY (0032): the local group the check reports, whether that makes a chapter or a guest member,
    // whether it confirmed the first name; and that an invited person's check may decide.
    expect(text).toContain('your local group as the check reports it (it makes you a chapter or a guest member), and whether the check confirmed your first name;');
    expect(text).toContain('who decided (an officer, or the check) and when;');
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

  it('lists exactly who can see it, the membership check with the four fields it is sent (api/src/membership/verifier.ts), and that no page shows it to anyone else', () => {
    const who = /<h2[^>]*>Who can see it<\/h2>\s*<ul>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
    expect([...who.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]!.replace(/&#39;/g, "'"))).toEqual([
      'You.',
      "The officers who approve sign-ups, and the site's Admin: what you typed, your email address and the result of the membership check.",
      'The Admin and the Membership Officer can also see a sign-up that was not approved.',
      'The membership check: your membership number, first name, last name and email address, to confirm you are a member.',
    ]);
    expect(text).toContain('No page on this site shows it to other members or to the public.');
    // What the check is sent: the columns ListPendingVerifications reads, and the fields it returns.
    const verifier = readFileSync('../api/src/membership/verifier.ts', 'utf8');
    expect(/SELECT id, ([a-z_, ]+) FROM signup_request WHERE \$\{WAITING\}/.exec(verifier)?.[1]?.split(', ')).toEqual(['membership_number', 'last_name', 'email', 'first_name']);
    expect(verifier).toContain(
      "pending: rows.map((row) => ({ requestId: row.id, membershipNumber: row.membership_number, lastName: row.last_name, email: row.email, firstName: row.first_name ?? '' }))",
    );
  });

  it('says the Your account page shows the name, number and local group, and the name can be corrected there', () => {
    expect(text).toContain('Once you are approved, the Your account page shows your name, number and local group, and you can correct your name there.');
  });

  it('OFFICER-VERIFY: says officers pass the same check before their officer tools open (api/src/auth/caller.ts)', () => {
    expect(text).toContain("Before the members' pages or an officer's tools open for you, we have to know you are a member.");
    expect(readFileSync('../api/src/auth/caller.ts', 'utf8')).toContain('officerVerify && !holdsOfficerPower(kind) ? withholdPower(all)');
  });

  it('gives the 13 months of api/src/auth/standing.ts, and that access then pauses until an officer confirms it', () => {
    const VERIFICATION_MONTHS = Number(/export const VERIFICATION_MONTHS = (\d+);/.exec(readFileSync('../api/src/auth/standing.ts', 'utf8'))?.[1]);
    expect(VERIFICATION_MONTHS).toBe(13);
    expect(text).toContain(`Member access lasts ${VERIFICATION_MONTHS} months from the last time your membership was confirmed. After that it is paused until an officer confirms it again.`);
  });

  it('says a decided sign-up is kept and only removed by hand: migration 0026 takes DELETE from the app and refuses it for a decided row; no app code deletes one', () => {
    expect(text).toContain('If your account is removed, your member access ends, but the record of your sign-up stays. We keep that record so a decision can be checked later. If you ask us to remove it, we remove it by hand.');
    expect(text).not.toContain('until you ask us to remove it');
    const m0026 = readFileSync('../api/migrations/0026_signup_reopen.sql', 'utf8');
    expect(m0026).toContain('REVOKE DELETE ON signup_request FROM nwfl;');
    expect(m0026).toMatch(/CREATE TRIGGER signup_request_keep_decided BEFORE DELETE ON signup_request\s+FOR EACH ROW EXECUTE FUNCTION signup_request_keep_decided\(\);/);
    expect(m0026).toContain("IF OLD.decision <> 'pending' THEN\n    RAISE EXCEPTION 'signup_request % is decided and is kept'");
    // No later migration gives the app its DELETE back or drops the trigger.
    const later = readdirSync('../api/migrations').filter((f) => f.endsWith('.sql') && f > '0026_signup_reopen.sql');
    expect(later.length).toBeGreaterThan(0);
    for (const f of later) {
      const sql = readFileSync(`../api/migrations/${f}`, 'utf8').replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/GRANT[^;]*\b(DELETE|ALL)\b[^;]*\bON\s+(TABLE\s+)?signup_request\b/i);
      expect(sql, f).not.toMatch(/signup_request_keep_decided[^;]*\b(DROP|DISABLE)\b|\b(DROP|DISABLE)\b[^;]*signup_request_keep_decided/i);
    }
    // No app code deletes a sign-up (generated code aside).
    const sources = (readdirSync('../api/src', { recursive: true }) as string[]).filter((f) => f.endsWith('.ts') && !f.startsWith('gen'));
    expect(sources.length).toBeGreaterThan(20);
    for (const f of sources) expect(readFileSync(`../api/src/${f}`, 'utf8'), f).not.toMatch(/DELETE\s+FROM\s+signup_request\b/i);
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

  it("says this site's password stays with the sign-in service: a code grant with PKCE (src/lib/auth/oidc.ts), bearer tokens at the API (api/src/auth/jwt.ts), no password field", () => {
    expect(text).toContain("Your password for this site is kept by our sign-in service; the site's own pages never see it.");
    const oidc = readFileSync('src/lib/auth/oidc.ts', 'utf8');
    expect(oidc).toContain('client.authorizationCodeGrant(');
    expect(oidc).toContain("code_challenge_method: 'S256'");
    expect(readFileSync('../api/src/auth/jwt.ts', 'utf8')).toContain('jwtVerify(token, client.jwks');
    const pages = (readdirSync('src', { recursive: true }) as string[]).filter((f) => f.endsWith('.astro'));
    expect(pages.length).toBeGreaterThan(20);
    for (const f of pages) expect(readFileSync(`src/${f}`, 'utf8'), f).not.toMatch(/type=["']?password/i);
    const protos = (readdirSync('../api/proto', { recursive: true }) as string[]).filter((f) => f.endsWith('.proto'));
    expect(protos.length).toBeGreaterThan(5);
    for (const f of protos) expect(readFileSync(`../api/proto/${f}`, 'utf8'), f).not.toMatch(/\bpassword\b/i);
  });

  it('says Cloudflare carries the traffic and keeps its own records, with no period of its own (api/src/auth/caller.ts: the edge is cloudflared)', () => {
    const sentence = "Cloudflare, which carries the site's traffic, keeps its own records under its own privacy policy.";
    expect(text).toContain(sentence);
    const log = /The server.s log (.*?) To see your record/.exec(text)?.[1] ?? '';
    expect(log).toContain(sentence);
    // Cloudflare's period is its own: the page claims none for it (only the sign-in service's year follows).
    expect(log.split(' Our sign-in service ')[0]).not.toMatch(/\d|day|week|month|year/i);
    expect(readFileSync('../api/src/auth/caller.ts', 'utf8')).toContain("DEFAULT_EDGE_CLIENT_IDS: readonly string[] = ['cloudflared.nwfl-edge.serviceaccount.identity.linkerd.cluster.local']");
  });

  // The year and the fields are the sign-in service's own settings (live: event retention 365 days, the default;
  // each sign-in event records the IP with its GeoIP location and ASN); no code in this repo holds them, so the
  // test holds the sentence and its place.
  it('says the sign-in service keeps its own record of each sign-in for a year, after the Cloudflare sentence', () => {
    const sentence = 'Our sign-in service keeps its own record of each sign-in, with the time, your internet address, and the approximate location and internet provider that address points to, for a year.';
    const log = /The server.s log (.*?) To see your record/.exec(text)?.[1] ?? '';
    expect(log.endsWith(`keeps its own records under its own privacy policy. ${sentence}`)).toBe(true);
    expect(log.split(sentence)).toHaveLength(2);
  });

  it('sends a request for a copy or for removal to the officers page, and links nowhere behind sign-in', () => {
    const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? '';
    expect([...main.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/officers']);
    expect(text).toMatch(/ask for a copy of what we keep about you, or ask us to remove it/);
  });

  it('says nothing the tests above do not hold: the page is exactly these words, so a new statement needs a test first', () => {
    expect(text).toBe(
      [
        'Privacy What this site keeps about you, who can see it, and how to ask about it.',
        "What we keep when you sign up Before the members' pages or an officer's tools open for you, we have to know you are a member. So we keep:",
        'your first name and last name, as you typed them; your Mensa membership number, as you typed it; the name and email address on your sign-in;',
        'the date you signed up, whether your sign-up was approved, who decided (an officer, or the check) and when;',
        'your local group as the check reports it (it makes you a chapter or a guest member), and whether the check confirmed your first name;',
        'the result of the membership check, and the date your membership was last confirmed.',
        'Once you are approved, the Your account page shows your name, number and local group, and you can correct your name there.',
        "What we do not keep We never ask for the user name or password you use at American Mensa's website, and we do not keep them. We check your membership with Mensa's own records.",
        "Your password for this site is kept by our sign-in service; the site's own pages never see it. We do not keep your address, phone number or birthday.",
        "Who can see it You. The officers who approve sign-ups, and the site's Admin: what you typed, your email address and the result of the membership check.",
        'The Admin and the Membership Officer can also see a sign-up that was not approved.',
        'The membership check: your membership number, first name, last name and email address, to confirm you are a member.',
        'No page on this site shows it to other members or to the public.',
        'How long we keep it Member access lasts 13 months from the last time your membership was confirmed. After that it is paused until an officer confirms it again.',
        'If your account is removed, your member access ends, but the record of your sign-up stays. We keep that record so a decision can be checked later. If you ask us to remove it, we remove it by hand.',
        'Cookies A cookie is a small note a site leaves in your browser.',
        'This site uses cookies only to sign you in and keep you signed in, and to remember your text size, your theme and your choice about links that leave the site.',
        'There is no tracking and no advertising on this site, and nothing here follows what you read.',
        "The server's log Our server keeps a log so that we can find faults. A line in it has the time, what was asked for and a request number. It does not record what a page says or what you type into a form.",
        "Cloudflare, which carries the site's traffic, keeps its own records under its own privacy policy. Our sign-in service keeps its own record of each sign-in, with the time, your internet address, and the approximate location and internet provider that address points to, for a year.",
        'To see your record, or have it removed Write to an officer: their addresses are on the Officers page . You can ask for a copy of what we keep about you, or ask us to remove it.',
      ].join(' '),
    );
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

  it('has no control that leads back to /500: every link, form, return and the 303 after each Aa press', async () => {
    const html = await render(ServerError, '/500');
    const decode = (s: string) => s.replace(/&amp;/g, '&');
    const targets = [
      ...[...html.matchAll(/\shref="([^"]*)"/g)].map((m) => decode(m[1]!)),
      ...[...html.matchAll(/<form[^>]*\saction="([^"]*)"/g)].map((m) => decode(m[1]!)),
      ...[...html.matchAll(/<button[^>]*\sformaction="([^"]*)"/g)].map((m) => decode(m[1]!)),
    ];
    expect(targets.length).toBeGreaterThan(10);
    const backs = [...html.matchAll(/<input type="hidden" name="(?:back|return)" value="([^"]*)"/g)].map((m) => decode(m[1]!));
    expect(backs.length).toBeGreaterThan(0);
    const returns = targets.flatMap((t) => [...new URL(t, 'https://nwflorida.us').searchParams.entries()].filter(([k]) => /^(return|back|next)$/.test(k)).map(([, v]) => v));
    for (const t of [...targets, ...backs, ...returns]) expect(new URL(t, 'https://nwflorida.us').pathname, t).not.toMatch(/^\/500(\.html)?\/?$/);
    // Each Aa press, posted with the page's own hidden fields: where does the reader land?
    const form = /<form class="reader-form" method="post" action="\/prefs">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? '';
    const hidden = Object.fromEntries([...form.matchAll(/<input type="hidden" name="([a-z]+)" value="([^"]*)"/g)].map((m) => [m[1]!, decode(m[2]!)]));
    const presses = [...form.matchAll(/<button[^>]*type="submit" name="([a-z]+)" value="([a-z-]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(presses.length).toBeGreaterThanOrEqual(10);
    for (const [name, value] of presses) {
      const url = new URL('https://nwflorida.us/prefs');
      const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...hidden, [name]: value }).toString() });
      const res = (await postPrefs({ request, url } as unknown as Parameters<typeof postPrefs>[0])) as Response;
      expect(res.status).toBe(303);
      const location = res.headers.get('location') ?? '';
      expect(new URL(location, url).pathname, `${name}=${value} -> ${location}`).toBe('/');
    }
  });
});
