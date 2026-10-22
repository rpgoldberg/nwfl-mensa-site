// The build flag's gate, then the signed-in reader (src/lib/auth/compose.ts).
// PUBLIC_ONLY is fixed at build time.
import { PUBLIC_ONLY } from 'astro:env/server';
import { makeOnRequest } from './lib/auth/compose';
import { runtimeDeps } from './lib/auth/flow';
import { makeSessionStep } from './lib/auth/middleware';

export const onRequest = makeOnRequest(PUBLIC_ONLY, makeSessionStep(runtimeDeps));
