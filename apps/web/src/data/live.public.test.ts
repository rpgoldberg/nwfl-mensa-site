// The public output of every live read, pinned before A14 (S5a) taught the news
// reads a members view: without a reader, each read must give exactly this,
// byte for byte, whatever the API sent. The fixtures mix every visibility,
// every file audience and role, members and redacted nodes, and an API that
// lists more than it should.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import { ContentItemSchema, ContentKind, type ContentItem, FileAudience, FileRole, ItemVisibility } from '../gen/nwfl/mensa/v1/content_pb.js';
import { ApiNotFound, type ApiReads } from '../lib/api/client';
import { liveData } from './live';

const file = (id: string, audience: FileAudience, role = FileRole.PRIMARY, mimeType = 'application/pdf') => ({
  id,
  filename: `${id.slice(0, 8)}.pdf`,
  mimeType,
  sizeBytes: 1234n,
  sha256: new Uint8Array(32).fill(0xcd),
  audience,
  role,
});

const FILES = [
  file('a0000000-0000-4000-8000-000000000001', FileAudience.PUBLIC),
  file('a0000000-0000-4000-8000-000000000002', FileAudience.MEMBERS),
  file('a0000000-0000-4000-8000-000000000003', FileAudience.OFFICERS),
  file('a0000000-0000-4000-8000-000000000004', FileAudience.PUBLIC, FileRole.SOURCE),
  file('a0000000-0000-4000-8000-000000000005', FileAudience.MEMBERS, FileRole.PUBLIC_COPY),
  file('a0000000-0000-4000-8000-000000000006', FileAudience.PUBLIC, FileRole.PRIMARY, 'image/jpeg'),
  file('not-an-id', FileAudience.PUBLIC),
];

const BODY = {
  blocks: [
    { kind: { case: 'paragraph', value: { inlines: [{ kind: { case: 'text', value: { text: 'Open <b>&</b> "quoted"' } } }, { kind: { case: 'members', value: { inlines: [{ kind: { case: 'text', value: { text: 'INLINE SECRET' } } }] } } }, { kind: { case: 'redacted', value: {} } }] } } },
    { kind: { case: 'members', value: { blocks: [{ kind: { case: 'paragraph', value: { inlines: [{ kind: { case: 'text', value: { text: 'BLOCK SECRET' } } }] } } }] } } },
    { kind: { case: 'redacted', value: {} } },
    { kind: { case: 'heading', value: { level: 1, inlines: [{ kind: { case: 'text', value: { text: 'Heading' } } }] } } },
  ],
} as const;

const item = (n: number, kind: ContentKind, visibility: ItemVisibility, title = `Item ${n}`): ContentItem =>
  create(ContentItemSchema, {
    id: `b0000000-0000-4000-8000-00000000000${n}`,
    slug: `item-${n}`,
    kind,
    live: { title, summary: `Summary ${n}`, visibility, approvedAt: timestampFromDate(new Date(Date.UTC(2026, 9, n, 15))), body: BODY as never, files: FILES },
  });

const KINDS = [ContentKind.TREASURER_SUMMARY, ContentKind.PRESIDENT_REPORT, ContentKind.ANNOUNCEMENT, ContentKind.ARTICLE];
const LISTS = new Map<ContentKind, ContentItem[]>([
  ...KINDS.map((kind): [ContentKind, ContentItem[]] => [kind, [item(1, kind, ItemVisibility.PUBLIC), item(2, kind, ItemVisibility.MEMBERS), item(3, kind, ItemVisibility.OFFICERS), item(4, kind, ItemVisibility.PUBLIC)]]),
  [
    ContentKind.DOCUMENT,
    [
      item(5, ContentKind.DOCUMENT, ItemVisibility.PUBLIC, 'Pensa Mensa, October-November 2026'),
      item(6, ContentKind.DOCUMENT, ItemVisibility.MEMBERS, 'Pensa Mensa, August-September 2026'),
      item(7, ContentKind.DOCUMENT, ItemVisibility.OFFICERS, 'Pensa Mensa, June-July 2026'),
      item(8, ContentKind.DOCUMENT, ItemVisibility.PUBLIC, 'Pensa Mensa, April-May 2026'),
      item(9, ContentKind.DOCUMENT, ItemVisibility.PUBLIC, 'Our bylaws'),
    ],
  ],
]);

const reads: ApiReads = {
  listOccurrences: () => Promise.resolve([]),
  getOccurrence: () => Promise.reject(new ApiNotFound('GetOccurrence')),
  listSeries: () => Promise.resolve([]),
  getRoster: () => Promise.resolve([]),
  listPublishedItems: (kind) => Promise.resolve(LISTS.get(kind) ?? []),
  readFile: (id) => Promise.resolve(id === FILES[0]!.id ? { kind: 'not_ready' } : { kind: 'not_found' }),
};

describe('the public output of the live reads, as before A14', () => {
  it('is unchanged for every section', async () => {
    const live = liveData(reads);
    const out = {
      treasurerSummaries: await live.treasurerSummaries(),
      presidentReport: await live.presidentReport(),
      announcements: await live.announcements(),
      issues: await live.issues(),
      files: await Promise.all(FILES.map((f) => live.file(f.id))),
    };
    expect(JSON.stringify(out, null, 1)).toMatchSnapshot();
    expect(JSON.stringify(out)).not.toMatch(/SECRET|a0000000-0000-4000-8000-00000000000[2-5]/);
  });
});
