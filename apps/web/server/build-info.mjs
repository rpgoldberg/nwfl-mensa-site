// @ts-check
// What kind of build dist/ holds, for the server wrapper: Astro inlines the
// PUBLIC_ONLY flag into its own bundle, and the wrapper, outside it, reads
// dist/build.json, written at the end of the build.

/**
 * The Astro integration that writes dist/build.json.
 *
 * @param {Record<string, string | undefined>} env the build's environment
 */
export function buildInfoIntegration(env = process.env) {
  return {
    name: 'nwfl-build-info',
    hooks: {
      /** @param {{ dir: URL }} options dir: the client folder, dist/client/ */
      'astro:build:done': async ({ dir }) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(new URL('../build.json', dir), `${JSON.stringify({ publicOnly: env['PUBLIC_ONLY'] === 'true' })}\n`);
      },
    },
  };
}

/**
 * @param {URL} file dist/build.json
 * @returns {Promise<{ publicOnly: boolean }>} a missing file is a full build
 */
export async function readBuildInfo(file) {
  const { readFile } = await import('node:fs/promises');
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { publicOnly: false };
  }
  return { publicOnly: JSON.parse(raw).publicOnly === true };
}
