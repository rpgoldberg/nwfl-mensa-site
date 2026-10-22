// The site's middleware, for a build: the build flag's gate (src/lib/access.ts),
// then the signed-in reader. The public-only build never reads a session at
// all, so no page there can show anyone signed in.
import type { MiddlewareHandler } from 'astro';
import { makeGate } from '../access';

export function makeOnRequest(publicOnly: boolean, session: MiddlewareHandler): MiddlewareHandler {
  const gate = makeGate(publicOnly);
  if (publicOnly) return gate;
  return (context, next) => gate(context, async () => (await session(context, next)) as Response);
}
