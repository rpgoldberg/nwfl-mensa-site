// The data the on-request pages read. The minutes are still made-up fixtures,
// and so is the newsletter until the API has an issue. The live sections (the
// calendar, the roster, the treasurer's summaries, the President's report, the
// announcements and the newsletter's issues) come from nwfl-mensa-api over gRPC
// when API_URL is set (W3); without it they are undefined, and the pages keep
// their bundled content, as the public-only canary does.
import { PUBLIC_ONLY } from 'astro:env/server';
import { apiSetup, grpcReads, unavailableReads } from '../lib/api/client';
import { fixtureData } from './fixtures';
import { type LiveData, liveData as liveFrom } from './live';
import type { SiteData } from './site-data';

export const siteData: SiteData = fixtureData;

/**
 * The live data for this environment. A public-only build shows no officer- or
 * member-submitted content (MT-50), so it never reads the API at all.
 */
export function liveFromEnv(env: Record<string, string | undefined>, { publicOnly, log }: { publicOnly: boolean; log: (line: string) => void }): LiveData | undefined {
  if (publicOnly) return undefined;
  const setup = apiSetup(env);
  if (!setup.enabled) return undefined;
  if ('error' in setup) {
    log(JSON.stringify({ level: 'error', msg: setup.error }));
    return liveFrom(unavailableReads());
  }
  return liveFrom(grpcReads(setup.config, log));
}

let live: { data: LiveData | undefined } | undefined;

/** One per process, so every page shares one HTTP/2 connection to the API. */
export function liveData(): LiveData | undefined {
  live ??= { data: liveFromEnv(process.env, { publicOnly: PUBLIC_ONLY, log: (line) => console.error(line) }) };
  return live.data;
}
