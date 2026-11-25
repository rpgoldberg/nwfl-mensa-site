// OFFICER-VERIFY: the officer area's one gate, after the signed-in reader (middleware.ts). A person whose
// officer tools wait for their membership check (GetMyAccount's officer_tools, from the API's own gate,
// apps/api src/auth/caller.ts) is sent to /account, where the sign-up form and the notice are, from every
// page under /officer-area; the API would refuse each officer call of theirs anyway. Open tools, none, or
// an API that cannot say: on to the page, which checks its own groups, and the API decides again.
import type { MiddlewareHandler } from 'astro';
import { type MembershipApi, type SessionReaderDeps, sessionReader } from '../api/membership';
import { ACCOUNT_PATH } from '../signup';

const AREA = '/officer-area';

export function makeOfficerGate(deps: () => { api: MembershipApi | undefined; readerDeps: SessionReaderDeps }): MiddlewareHandler {
  return async (context, next) => {
    const path = new URL(context.request.url).pathname;
    if (path !== AREA && !path.startsWith(`${AREA}/`)) return next();
    const session = context.locals.session;
    const { api, readerDeps } = deps();
    if (session === undefined || api === undefined) return next();
    const { reader } = sessionReader(session, readerDeps);
    if (reader === undefined) return next();
    try {
      if ((await api.getMyStanding(reader)).officerTools === 'awaiting_check') {
        return new Response(null, { status: 303, headers: { Location: ACCOUNT_PATH, 'Cache-Control': 'private, no-store' } });
      }
    } catch {
      // The page says what is wrong; the API refuses what is not theirs.
    }
    return next();
  };
}

/** The session step, then the gate inside it, then the page. */
export function afterSession(session: MiddlewareHandler, gate: MiddlewareHandler): MiddlewareHandler {
  return (context, next) => session(context, () => gate(context, next) as Promise<Response>);
}
