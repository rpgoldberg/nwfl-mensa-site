import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sectionFor } from '../../src/lib/site';
import { compileRedirects, resolveOldUrl } from '../redirects.mjs';

/** A small table in the real file's shape. */
const tables = compileRedirects({
  moved: { '/calendar': '/calendar', '/join-mensa': '/join', '/excom-meeting-minutes-11-nov-2022': '/minutes#2022-11-11' },
  interim: { '/photos': '/' },
  gone: ['/2015-mind-games'],
  uploads: { '/uploads/3/4/4/5/34456428/march_2023_minutes.pdf': '/minutes#2023-03-12' },
  goneUploads: ['/uploads/3/4/4/5/34456428/membership_report_apr_2024.pdf'],
  goneDirs: ['/w_api/', '/images/spider/'],
});

describe('resolveOldUrl (R16)', () => {
  it('answers all three old forms of a page: /slug, /slug.html and /mobile/slug.html', () => {
    for (const path of ['/join-mensa', '/join-mensa.html', '/mobile/join-mensa.html', '/Join-Mensa.HTML']) {
      expect(resolveOldUrl(path, tables), path).toEqual({ status: 301, location: '/join' });
    }
  });

  it('sends a minutes page to its meeting on the minutes page', () => {
    expect(resolveOldUrl('/excom-meeting-minutes-11-nov-2022.html', tables)).toEqual({ status: 301, location: '/minutes#2022-11-11' });
  });

  it('never redirects a new page to itself', () => {
    expect(resolveOldUrl('/calendar', tables)).toBeUndefined();
    expect(resolveOldUrl('/calendar.html', tables)).toEqual({ status: 301, location: '/calendar' });
  });

  it('sends a page whose new home does not exist yet with a temporary redirect', () => {
    expect(resolveOldUrl('/photos.html', tables)).toEqual({ status: 302, location: '/' });
  });

  it('leaves a page whose slug named a person to the site, as any unknown path', () => {
    for (const path of ['/someone-letter.html', '/mobile/someone-bio.html', '/someone-essay']) expect(resolveOldUrl(path, tables), path).toBeUndefined();
  });

  it('answers retired pages, PHP, the Weebly machinery and the spam folder with 410 Gone', () => {
    for (const path of ['/2015-mind-games.html', '/w_api/APIHandler.php', '/w_api/', '/images/spider/aposta.jpg', '/log404.php', '/js/404.php', '/gallery.PHP']) {
      expect(resolveOldUrl(path, tables), path).toEqual({ status: 410 });
    }
  });

  it('sends /login.php to the new sign-in', () => {
    expect(resolveOldUrl('/login.php', tables)).toEqual({ status: 302, location: '/sign-in' });
  });

  it('sends a kept upload to where its content lives until storage serves the file, and every other upload is gone', () => {
    expect(resolveOldUrl('/uploads/3/4/4/5/34456428/march_2023_minutes.pdf', tables)).toEqual({ status: 302, location: '/minutes#2023-03-12' });
    expect(resolveOldUrl('/uploads/3/4/4/5/34456428/membership_report_apr_2024.pdf', tables)).toEqual({ status: 410 });
    expect(resolveOldUrl('/uploads/3/4/4/5/34456428/published/someone.jpg', tables)).toEqual({ status: 410 });
    expect(resolveOldUrl('/uploads/3/1/5/8/3158475/old.pdf', tables)).toEqual({ status: 410 });
  });

  it('leaves everything else to the site', () => {
    for (const path of ['/', '/about', '/officers', '/_astro/site.css', '/scripts/install.js', '/prefs', '/no-such-page', '/mobile/', '/mobile/unknown.html', '/a/b.html']) {
      expect(resolveOldUrl(path, tables), path).toBeUndefined();
    }
  });
});

describe('the old-site table (server/old-site.json)', () => {
  const data = JSON.parse(readFileSync('server/old-site.json', 'utf8')) as Record<string, unknown>;
  const real = compileRedirects(data as never);
  const targets = [
    ...Object.values(data['moved'] as Record<string, string>),
    ...Object.values(data['interim'] as Record<string, string>),
    ...Object.values(data['uploads'] as Record<string, string>),
  ];

  it('sends every redirect to a page of the new site', () => {
    for (const target of targets) {
      const [path, fragment] = target.split('#');
      expect(sectionFor(path!), target).toBeDefined();
      if (path === '/minutes' && fragment !== undefined) expect(fragment, target).toMatch(/^\d{4}-\d{2}(-\d{2})?$/);
    }
  });

  it('never shadows a page of the new site with a redirect elsewhere', () => {
    for (const [from, to] of Object.entries({ ...(data['moved'] as object), ...(data['interim'] as object) }) as [string, string][]) {
      if (sectionFor(from)) expect(to, from).toBe(from);
    }
    for (const from of data['gone'] as string[]) expect(sectionFor(from), from).toBeUndefined();
  });

  it('holds no slug that names a person, not even hashed: an unsalted hash of a name is reversed from a list of names', () => {
    expect(Object.keys(data).sort()).toEqual(['about', 'gone', 'goneDirs', 'goneUploads', 'interim', 'moved', 'uploads']);
    expect(JSON.stringify(data)).not.toMatch(/[0-9a-f]{64}/);
  });

  it('never answers a path of the new site with 410: the 404 page, the gone page and sign-in among them', () => {
    for (const path of ['/404', '/gone', '/sign-in', '/sign-out', '/signed-out', '/auth/callback', '/officer-area', '/prefs', '/robots.txt', '/healthz']) {
      expect((data['gone'] as string[]).includes(path), path).toBe(false);
      expect(resolveOldUrl(path, real)?.status, path).not.toBe(410);
    }
  });

  it('retires the membership reports, the officer roster and the officer reports with personal contacts', () => {
    const gone = data['goneUploads'] as string[];
    for (const file of gone) expect(resolveOldUrl(file, real), file).toEqual({ status: 410 });
    expect(gone.filter((f) => /membership_(report|update)|_membership_report|officers_|vp_report|officer_report/.test(f)).length).toBeGreaterThanOrEqual(10);
  });

  it('maps the misspelled old slugs too', () => {
    for (const path of ['/2022-annual-finacial-report.html', '/odd-peilcan-freeport.html', '/ecomm-minutes-november-2024.html']) {
      expect(resolveOldUrl(path, real)?.status, path).toBeOneOf([301, 302]);
    }
  });

  it('maps every minutes page to a meeting date', () => {
    const minutes = Object.entries(data['moved'] as Record<string, string>).filter(([from]) => /^\/(excom|excomm|ecomm|exmm|september-25)/.test(from) && from !== '/excom-meeting-minutes');
    expect(minutes.length).toBeGreaterThanOrEqual(38);
    for (const [from, to] of minutes) {
      if (from === '/excom-mtfg-min') expect(to).toBe('/minutes');
      else expect(to, from).toMatch(/^\/minutes#\d{4}-\d{2}(-\d{2})?$/);
    }
  });
});
