// ============================================================================
// The content hash (R25, P18): SHA-256 over the canonical JSON of everything
// an approver judges. "Mark ready" records it; Approve must present the hash
// the approver saw, so a version changed after the approval page was opened
// cannot be approved.
//
// The canonical form is versioned ("v": 1) and pinned by a test: changing it
// would make every ready version's stored hash unreachable, so a change needs
// a new version number and a migration of the stored hashes.
// ============================================================================
import { createHash } from 'node:crypto';
import type { Tree } from './tree.js';

export interface HashInput {
  title: string;
  summary: string | null;
  visibility: string;
  /** The NORMALIZED tree. */
  body: Tree;
  targets: { website: boolean; newsletter: boolean; email: boolean };
  editionId: string | null;
  printAsIs: boolean;
  /** The SHA-256 of each file attached to the version. */
  fileHashes: Buffer[];
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(input: HashInput): Buffer {
  const canonical = canonicalJson({
    v: 1,
    title: input.title,
    summary: input.summary,
    visibility: input.visibility,
    body: input.body,
    targets: input.targets,
    edition: input.editionId,
    printAsIs: input.printAsIs,
    files: input.fileHashes.map((hash) => hash.toString('hex')).sort(),
  });
  return createHash('sha256').update(canonical).digest();
}
