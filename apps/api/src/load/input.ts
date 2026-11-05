// ============================================================================
// What the two stdin commands share: the issue loader (load.ts, nwfl-issue/1
// and /2) and the links command (attach.ts, nwfl-links/1). Their bundles
// arrive on stdin and nowhere else, bounded, as UTF-8 JSON, and are read by
// known fields only, as own keys. A refusal names the field, never its value.
// ============================================================================

export class LoadError extends Error {
  override name = 'LoadError';
}

export type Json = Record<string, unknown>;

export const HEX64 = /^[0-9a-f]{64}$/;
/** A reply tag (PUBCOPY, ML-H7, LINKS): no free text, so no name. */
export const REFERENCE = /^[A-Z][A-Z0-9-]{1,39}$/;

export function object(value: unknown, where: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new LoadError(`${where} must be a JSON object`);
  return value as Json;
}

/** Own keys only, each one known: __proto__, constructor and the like are unknown fields like any other. */
export function known(json: Json, where: string, keys: readonly string[]): void {
  for (const key of Object.keys(json)) if (!keys.includes(key)) throw new LoadError(`${where}: unknown field ${key}`);
}

export const own = (json: Json, key: string): unknown => (Object.hasOwn(json, key) ? json[key] : undefined);

export function wholeNumber(value: unknown, where: string, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new LoadError(`${where} must be a whole number from 1 to ${max}`);
  return value;
}

export function matching(value: unknown, pattern: RegExp, where: string, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new LoadError(`${where} must be ${what}`);
  return value;
}

export type StdinKind = 'pipe' | 'socket' | 'file' | 'device' | 'other';

export interface Stdin {
  kind: StdinKind;
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

/** What stdin is, from its fstat. */
export function stdinKind(stat: { isFIFO(): boolean; isSocket(): boolean; isFile(): boolean; isCharacterDevice(): boolean }): StdinKind {
  if (stat.isFIFO()) return 'pipe';
  if (stat.isSocket()) return 'socket';
  if (stat.isFile()) return 'file';
  if (stat.isCharacterDevice()) return 'device';
  return 'other';
}

async function readCapped(chunks: Stdin['chunks'], maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.length;
    if (size > maxBytes) throw new LoadError(`the bundle is larger than ${maxBytes / (1024 * 1024)} MiB`);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/**
 * The bundle's JSON, read from stdin. In production mode (NODE_ENV=production, as the image sets
 * it) stdin must be a pipe or a socket, the attached stdin of a Job: a file redirected into it, a
 * terminal or a device is refused.
 */
export async function readBundleJson(env: Readonly<Record<string, string | undefined>>, stdin: Stdin, maxBytes: number): Promise<unknown> {
  if (env['NODE_ENV'] === 'production' && stdin.kind !== 'pipe' && stdin.kind !== 'socket') {
    throw new LoadError('in production the bundle must arrive on a pipe (the attached stdin of the Job), not a file, terminal or device');
  }
  const bytes = await readCapped(stdin.chunks, maxBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new LoadError('the bundle is not valid JSON');
  }
}
