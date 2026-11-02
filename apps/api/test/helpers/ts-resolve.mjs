// For the tests that spawn the real engine sidecar from src/ (UNTRUSTED-PDF-GATE): Node strips the
// types from a .ts file itself, but src/ imports its neighbours as ./x.js, which exist only once
// built. Loaded with --import, this resolves a file .js that is not there to the .ts beside it. The
// sidecar hands its Node flags on to each per-copy child, so the children resolve the same way.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && /^(?:\.{1,2}\/|\/|file:)/.test(specifier)) {
      // The entry point (a forked child's module) comes with no parent.
      const url = new URL(specifier, context.parentURL ?? pathToFileURL(`${process.cwd()}/`));
      const ts = new URL(url.href.replace(/\.js$/, '.ts'));
      if (url.protocol === 'file:' && !existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});
