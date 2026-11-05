// extract()'s worker as the tests start it: the .ts sources, resolved as ./x.js the way the built files are.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { URL, fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const ts = new URL(url.href.replace(/\.js$/, '.ts'));
      if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(ts))) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});
await import('../../src/extract-worker.ts');
