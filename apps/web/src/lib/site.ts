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
  /** A long read: the reading bar (text size and theme) sits at the foot of the screen. */
  reading?: boolean;
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
    reading: true,
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
    reading: true,
  },
  { path: '/newsletter', title: 'Newsletter', description: 'The current issue, and every past issue we can share.' },
  {
    path: '/minutes',
    title: 'Meeting minutes',
    description: 'The approved minutes of each Executive Committee meeting, newest first.',
  },
  // R1's Events section; "Calendar" is its word in the nav and in the design draft's URLs.
  {
    path: '/calendar',
    title: 'Calendar',
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

/** What the More page lists: every section but Home, then Help and the home-screen how-to. */
export const MORE_PAGES: readonly Page[] = [...SECTIONS.filter((s) => s.path !== '/'), HELP, HOME_SCREEN];

const PAGES: readonly Page[] = [
  ...SECTIONS,
  HELP,
  HOME_SCREEN,
  { path: '/search', title: 'Search', description: 'Search the newsletter archive.' },
  { path: '/more', title: 'More', description: 'Every part of the site in one list.' },
  {
    path: '/sign-in',
    title: 'Sign in',
    description: 'Officers and members will sign in here once accounts open.',
  },
];

export type NavIcon = 'home' | 'calendar' | 'newsletter' | 'search' | 'more';

export interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { label: 'Home', href: '/', icon: 'home' },
  { label: 'Calendar', href: '/calendar', icon: 'calendar' },
  { label: 'Newsletter', href: '/newsletter', icon: 'newsletter' },
  { label: 'Search', href: '/search', icon: 'search' },
  { label: 'More', href: '/more', icon: 'more' },
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
