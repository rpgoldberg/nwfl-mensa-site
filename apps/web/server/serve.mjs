// @ts-check
// The container's entry point (Dockerfile CMD and the e2e web server).
import { start } from './start.mjs';

const ENTRY = '../dist/server/entry.mjs';

await start({
  env: process.env,
  proc: process,
  clientDir: new URL('../dist/client/', import.meta.url),
  oldSite: new URL('./old-site.json', import.meta.url),
  buildInfo: new URL('../dist/build.json', import.meta.url),
  // The build's output, absent from a fresh checkout: named through a variable
  // so the type check (CI runs it before any build) does not look for it.
  loadHandler: () => import(ENTRY),
});
