// A stand-in worker for the flag tests (fix round 6, S2b): run as `node <flags> this <child> <quote>`, it makes
// one copy through the real isolatedRedact with that stand-in child and prints the reply, so a test can see what a
// child of a parent started with those flags may do.
import process from 'node:process';
import { URL } from 'node:url';
// The resolve hook first (isolated.ts imports ./no-fork.js, which is no-fork.ts here), then the engine.
await import('../../helpers/ts-resolve.mjs');
const { isolatedRedact } = await import('../../../src/pdf/isolated.ts');

const [name, quote] = process.argv.slice(2);
const child = new URL(`./${name}.ts`, import.meta.url).pathname;
const reply = await isolatedRedact({ module: child })(Uint8Array.from([1]), { quotes: [quote], redactsAny: true });
process.stdout.write(JSON.stringify(reply));
