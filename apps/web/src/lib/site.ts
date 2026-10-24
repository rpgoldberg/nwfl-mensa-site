// The site's map: the nine public sections (R1), the pages around them, the
// primary navigation (R30) and the breadcrumb trail every non-home page shows.

export const SITE_NAME = 'Northwest Florida Mensa';

export interface Page {
  path: string;
  /** The page heading, and its name in breadcrumbs and Back links. */
  title: string;
  description: string;
  /** Built once at deploy time: the page reads nothing from the API. */
  prerender?: boolean;
}

export interface Crumb {
  label: string;
  href: string;
}

export const SECTIONS: readonly Page[] = [
  { path: '/', title: 'Home', description: 'What is on this week, the current newsletter, and how to join.' },
  {
    path: '/about',
    title: 'About us',
    description: 'Who we are: the Northwest Florida local group of American Mensa, and our history.',
    prerender: true,
  },
  {
    path: '/join',
    title: 'Join Mensa',
    description: 'How to join American Mensa and come to our events.',
    prerender: true,
  },
  { path: '/officers', title: 'Officers', description: 'Who holds each office, and the email address for each one.' },
  {
    path: '/governance',
    title: 'Governance',
    description: 'Our charter, our bylaws and the rules for elections.',
    prerender: true,
  },
  // The newsletter; "News" is its word in the nav (W-LOOK), and the page's heading.
  { path: '/news', title: 'News', description: 'The current issue, and every past issue we can share.' },
  {
    path: '/minutes',
    title: 'Meeting minutes',
    description: 'The approved minutes of each Executive Committee meeting, newest first.',
  },
  // R1's Events section, the calendar. /calendar and /newsletter answer 301 (server/redirects.mjs).
  {
    path: '/events',
    title: 'Events',
    description: 'Lunches, happy hours, meetups and meetings, with dates and places.',
  },
  { path: '/finances', title: 'Finances', description: "The treasurer's summary for each period." },
];

const HELP: Page = {
  path: '/help',
  title: 'Help',
  description: 'How to use this site, and who to ask when something is hard.',
};

const HOME_SCREEN: Page = {
  path: '/home-screen',
  title: 'Put the club on your home screen',
  description: "Add the club's icon to your phone, so the site opens like an app.",
};

const SEARCH: Page = { path: '/search', title: 'Search', description: 'Search the newsletter archive.' };

/** What the More page lists: every section but Home, then Search, Help and the home-screen how-to. */
export const MORE_PAGES: readonly Page[] = [...SECTIONS.filter((s) => s.path !== '/'), SEARCH, HELP, HOME_SCREEN];

/** Icons the More page's rows use (drawn in components/Icon.astro). */
export type MoreIcon = 'info' | 'users' | 'scale' | 'doc' | 'coin' | 'calendar' | 'newsletter' | 'search' | 'join' | 'help' | 'mail' | 'phone';

export interface MoreRow {
  title: string;
  description: string;
  href: string;
  icon: MoreIcon;
}

export interface MoreGroup {
  /** Names the group's colour tokens (--grp-<id>-tile, -icon, -edge). */
  id: 'club' | 'on' | 'join';
  title: string;
  rows: readonly MoreRow[];
}

/** The More page: three groups of rows (Ross approved, 2026-10-24). Every page in MORE_PAGES is a row. */
export const MORE_GROUPS: readonly MoreGroup[] = [
  {
    id: 'club',
    title: 'The club',
    rows: [
      { title: 'About us', description: 'Who we are and how to visit', href: '/about', icon: 'info' },
      { title: 'Officers', description: 'Who holds each office, and how to reach them', href: '/officers', icon: 'users' },
      { title: 'Governance', description: 'Bylaws and how the group is run', href: '/governance', icon: 'scale' },
      { title: 'Meeting minutes', description: 'What the ExComm decided', href: '/minutes', icon: 'doc' },
      { title: 'Finances', description: 'Treasurer reports', href: '/finances', icon: 'coin' },
    ],
  },
  {
    id: 'on',
    title: 'What\u2019s on',
    rows: [
      { title: 'Events', description: 'Lunches, happy hours and meetings', href: '/events', icon: 'calendar' },
      { title: 'News', description: 'Pensa Mensa, the newsletter, and every issue', href: '/news', icon: 'newsletter' },
      { title: 'Search', description: 'Find anything on the site', href: '/search', icon: 'search' },
    ],
  },
  {
    id: 'join',
    title: 'Join and get help',
    rows: [
      { title: 'Join Mensa', description: 'Take the test or bring a qualifying score', href: '/join', icon: 'join' },
      { title: 'Help', description: 'Using this site, step by step', href: '/help', icon: 'help' },
      { title: 'Contact an officer', description: 'Ask a question or send an idea', href: '/officers', icon: 'mail' },
      { title: 'Put the club on your home screen', description: 'One tap from your phone, like an app', href: '/home-screen', icon: 'phone' },
    ],
  },
];

const PAGES: readonly Page[] = [
  ...SECTIONS,
  SEARCH,
  HELP,
  HOME_SCREEN,
  { path: '/more', title: 'More', description: 'The club, what\u2019s on, and how to join or get help.' },
  { path: '/sign-in', title: 'Sign in', description: 'Sign in to the site, for officers and members.' },
  { path: '/signed-out', title: "You're signed out", description: 'You have signed out of this site. You can sign in again at any time.' },
  { path: '/officer-area', title: 'Officer area', description: 'Where officers write reports and approve what goes on the site.' },
];

export type NavIcon = 'home' | 'calendar' | 'newsletter' | 'more';

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
}

/** Four, so the bottom bar is always one row; Search and Help are on More (W-LOOK). */
export const PRIMARY_NAV: readonly NavItem[] = [
  { label: 'Home', href: '/', icon: 'home' },
  { label: 'Events', href: '/events', icon: 'calendar' },
  { label: 'News', href: '/news', icon: 'newsletter' },
  { label: 'More', href: '/more', icon: 'more' },
];

export interface Link {
  label: string;
  href: string;
}

/** The design draft's About subnav, on each page it names. */
export const ABOUT_NAV: readonly Link[] = [
  { label: 'Who we are', href: '/about' },
  { label: 'Officers', href: '/officers' },
  { label: 'Governance', href: '/governance' },
  { label: 'Minutes', href: '/minutes' },
  { label: 'Finances', href: '/finances' },
];

/** The old Home page's outbound links (R1), on Home and in About. */
export const MENSA_LINKS: readonly Link[] = [
  { label: 'American Mensa', href: 'https://www.us.mensa.org/' },
  { label: 'Region 10 of American Mensa', href: 'https://region10.us.mensa.org/' },
  { label: 'Mensa International', href: 'https://www.mensa.org/' },
  { label: 'Our group on Facebook', href: 'https://www.facebook.com/groups/167192940095851/' },
];

function normalise(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function sectionFor(path: string): Page | undefined {
  const p = normalise(path);
  return PAGES.find((page) => page.path === p);
}

/** The nav item a page sits under: its own, or More for the pages listed there. */
export function currentNav(path: string): string | undefined {
  const p = normalise(path);
  const own = PRIMARY_NAV.find((n) => n.href !== '/' && (p === n.href || p.startsWith(`${n.href}/`)));
  if (own) return own.href;
  if (p === '/') return '/';
  return MORE_PAGES.some((m) => m.path === p) ? '/more' : undefined;
}

/** Home, each named ancestor, then the page itself; empty on Home. */
export function trailFor(path: string, title: string): Crumb[] {
  const p = normalise(path);
  if (p === '/') return [];
  const trail: Crumb[] = [{ label: 'Home', href: '/' }];
  const parts = p.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const href = `/${parts.slice(0, i).join('/')}`;
    const page = sectionFor(href);
    if (page) trail.push({ label: page.title, href });
  }
  trail.push({ label: title, href: p });
  return trail;
}

/** A page that must exist; a typo in a page file fails the build, not a reader. */
export function page(path: string): Page {
  const found = sectionFor(path);
  if (!found) throw new Error(`no page registered at ${path}`);
  return found;
}
