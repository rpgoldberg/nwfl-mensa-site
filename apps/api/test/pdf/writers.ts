// The writers Node's permission model does not check, as a child would try them (fix round 5, S2): the
// node:sqlite module, which opens its database files itself, and V8 flags set at run time, under which
// V8 writes its own trace files. Measured on node 24.22.1 under --permission --allow-fs-read=*: both
// wrote into a directory node:fs could not write. Used by the stand-ins in children/ and gate-children/.
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';

const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error);

/** Tries `writer` ("sqlite" or "v8") on `dir`; resolves to "done" or the error's code. */
export async function attemptWrite(dir: string, writer: string): Promise<string> {
  try {
    if (writer === 'sqlite') {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(path.join(dir, 'written.db'));
      db.exec('CREATE TABLE t (a)');
      db.close();
    } else {
      setFlagsFromString(`--trace-turbo --trace-turbo-path=${dir}`);
      let total = 0;
      const hot = (n: number): number => (n * 7) % 13;
      for (let i = 0; i < 2_000_000; i++) total += hot(i);
      if (total < 0) return 'never';
    }
    return 'done';
  } catch (error) {
    return code(error);
  }
}
