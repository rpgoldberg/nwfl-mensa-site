// ============================================================================
// ARCHIVE-SEARCH S3: the API's own limits on searching (plan section 3).
//
// The API's one client is the site (grpc/server.ts), so it cannot tell
// visitors apart: the limits are global. A bucket of ten searches a second
// with a burst of twenty, at most four running at once, and each statement
// ended by the database after two seconds. Over a limit the answer is
// RESOURCE_EXHAUSTED, at once: a search never queues.
//
// Four at once is also under half the connection pool (db/pool.ts, ten), so
// searching cannot starve the reads and writes beside it.
// ============================================================================
import { Code, ConnectError } from '@connectrpc/connect';

export interface SearchLimits {
  perSecond: number;
  burst: number;
  concurrent: number;
  /** statement_timeout for each statement of a search. */
  timeoutMs: number;
}

export const SEARCH_LIMITS: SearchLimits = { perSecond: 10, burst: 20, concurrent: 4, timeoutMs: 2000 };

export const limitsFrom = (override: Partial<SearchLimits> | undefined): SearchLimits => ({ ...SEARCH_LIMITS, ...override });

export interface Admission {
  /** Takes a place and a token, or throws RESOURCE_EXHAUSTED. The function returned gives the place back, once. */
  enter(): () => void;
}

const busy = (): ConnectError => new ConnectError('search is busy; try again shortly', Code.ResourceExhausted);

/** `now` is the clock, in milliseconds. */
export function admission(limits: SearchLimits, now: () => number): Admission {
  let tokens = limits.burst;
  let at = now();
  let running = 0;
  return {
    enter() {
      // The place first: a search refused for being one too many at once spends no token.
      if (running >= limits.concurrent) throw busy();
      const time = now();
      // A clock that steps back adds nothing, and does not move the mark back either.
      if (time > at) {
        tokens = Math.min(limits.burst, tokens + ((time - at) / 1000) * limits.perSecond);
        at = time;
      }
      if (tokens < 1) throw busy();
      tokens -= 1;
      running += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        running -= 1;
      };
    },
  };
}
