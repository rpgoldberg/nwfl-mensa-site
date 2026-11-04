// In a capped container: a real engine child, with the real guard and the real prlimit, tries to start
// a process every way (children/try-fork.ts). Prints what it saw, and the guard's own probe result:
// "result" without the permission model (the kernel's limit alone), "denied" with it (fix round 4, S2).
import { fileURLToPath } from 'node:url';
import { isolatedRedact } from '../../../src/pdf/isolated.js';

const module = fileURLToPath(new URL('../children/try-fork.ts', import.meta.url));
const run = (permission: boolean) => isolatedRedact({ module, permission })(Uint8Array.from([1]), { quotes: ['x'], redactsAny: true });
const result = await run(false);
const denied = await run(true);
process.stdout.write(`${JSON.stringify({ pid: process.pid, result, denied })}\n`);
