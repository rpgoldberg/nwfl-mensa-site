// A stand-in worker for the --env-file test (CF-ISO-0 N1): run as `node --env-file=<file> this`, it
// makes one copy through the real isolatedRedact with the env stand-in child, and prints the reply.
import process from 'node:process';
import { URL } from 'node:url';
import { isolatedRedact } from '../../../src/pdf/isolated.ts';

const child = new URL('./env.ts', import.meta.url).pathname;
const reply = await isolatedRedact({ module: child })(Uint8Array.from([1]), { quotes: [], redactsAny: true });
process.stdout.write(JSON.stringify(reply));
