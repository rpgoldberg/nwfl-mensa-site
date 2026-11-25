// The build flag's gate, then the signed-in reader (src/lib/auth/compose.ts), then (OFFICER-VERIFY) the
// officer area's gate (src/lib/auth/officer-gate.ts). PUBLIC_ONLY is fixed at build time.
import { PUBLIC_ONLY } from 'astro:env/server';
import { membershipApi } from './lib/api/membership';
import { makeOnRequest } from './lib/auth/compose';
import { runtimeDeps } from './lib/auth/flow';
import { makeSessionStep } from './lib/auth/middleware';
import { afterSession, makeOfficerGate } from './lib/auth/officer-gate';

export const onRequest = makeOnRequest(
  PUBLIC_ONLY,
  afterSession(
    makeSessionStep(runtimeDeps),
    makeOfficerGate(() => ({ api: membershipApi(), readerDeps: runtimeDeps() })),
  ),
);
