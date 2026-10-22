// The build flag's gate (src/lib/access.ts). PUBLIC_ONLY is fixed at build time.
import { PUBLIC_ONLY } from 'astro:env/server';
import { makeGate } from './lib/access';

export const onRequest = makeGate(PUBLIC_ONLY);
