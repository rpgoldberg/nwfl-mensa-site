// @ts-check
// The container's entry point (Dockerfile CMD and the e2e web server).
import { start } from './start.mjs';

await start({ env: process.env, proc: process, loadHandler: () => import('../dist/server/entry.mjs') });
