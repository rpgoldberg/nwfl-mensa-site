// A parent for the stdout test (fix round 4, integrity S1): it runs the real isolatedRedact and isolatedGate
// with the noisy stand-ins (1 MiB on each of stdout and stderr), writes nothing to its own stdout, and
// sends both outcomes over IPC. The test captures this process's stdout: any byte there came from a child.
import { isolatedGate } from '../../../src/pdf/gate-isolated.js';
import { isolatedRedact } from '../../../src/pdf/isolated.js';

const at = (name: string): string => new URL(name, import.meta.url).pathname;
const quiet = (): void => {};
const engine = await isolatedRedact({ module: at('./noisy.ts'), log: quiet })(Uint8Array.from([1]), { quotes: ['Kestrel'], redactsAny: true });
const gate = await isolatedGate({ module: at('../gate-children/noisy.ts'), log: quiet })({ copy: Uint8Array.from([1, 2, 3]), original: Uint8Array.from([9]), quotes: ['Kestrel'], image: 'blur' });
process.send?.({ engine, gate: gate.verdict }, () => process.exit(0));
