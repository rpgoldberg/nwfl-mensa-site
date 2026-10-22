// The seed command: `node dist/seed/cli.js <seed-file>`. Everything it does is
// in seed.ts, which the tests drive directly.
import { runSeed } from './seed.js';

process.exitCode = await runSeed(process.argv.slice(2), process.env, (line) => process.stdout.write(`${line}\n`));
