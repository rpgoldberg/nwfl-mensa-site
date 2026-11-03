// A stand-in gate child that passes, naming the sha256 of other bytes than it was sent.
import { createHash } from 'node:crypto';
process.once('message', () => {
  process.send?.({ verdict: { pass: true }, sha256: createHash('sha256').update('other bytes').digest('hex') }, () => process.exit(0));
});
