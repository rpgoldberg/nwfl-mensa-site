// A stand-in for the gate's text check on deep copies (fix round 6, S3-6): run as `node <ts flags> this <depth> <split>`,
// it prints checkCopy's reason on deepText(depth, split) and how many rejections pdf.js left unhandled. pdf.js's text
// reading overflows its stack on forms 1,500 deep and leaves such rejections behind, which vitest reports as errors of
// the run, so a test reads those depths here, in a process of its own. (The gate reads the nesting cap first,
// gate-rules.ts nestedPast, so its pdf.js never gets such a copy.)
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
await import('../../helpers/ts-resolve.mjs');
const { checkCopy } = await import('../../../src/pdf/gate.ts');
const { DEEP_QUOTE, deepText } = await import('../shadows.ts');

let unhandled = 0;
process.on('unhandledRejection', () => {
  unhandled += 1;
});
const [depth, split] = process.argv.slice(2);
const reason = await checkCopy(deepText(Number(depth), split === 'split'), [DEEP_QUOTE]);
await sleep(100);
process.stdout.write(JSON.stringify({ reason, unhandled }));
