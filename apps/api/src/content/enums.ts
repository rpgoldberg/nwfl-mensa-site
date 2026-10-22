// The database's text vocabularies and the proto enums, both ways. One place,
// so a reader and a writer can never disagree on a mapping.
import { ContentKind, FileAudience, FileRole, ItemState, ItemVisibility, VersionStatus } from '../gen/nwfl/mensa/v1/content_pb.js';
import { EditionKind, EditionStatus } from '../gen/nwfl/mensa/v1/edition_pb.js';
import { OfficeKind, TermStatus } from '../gen/nwfl/mensa/v1/roster_pb.js';

export const KINDS: Record<string, ContentKind> = {
  article: ContentKind.ARTICLE,
  president_report: ContentKind.PRESIDENT_REPORT,
  announcement: ContentKind.ANNOUNCEMENT,
  minutes: ContentKind.MINUTES,
  treasurer_summary: ContentKind.TREASURER_SUMMARY,
  document: ContentKind.DOCUMENT,
  page: ContentKind.PAGE,
};
export const KIND_NAMES = new Map(Object.entries(KINDS).map(([name, kind]) => [kind, name]));
export const STATES: Record<string, ItemState> = {
  draft: ItemState.DRAFT,
  ready: ItemState.READY,
  published: ItemState.PUBLISHED,
  withdrawn: ItemState.WITHDRAWN,
};
export const VERSION_STATUSES: Record<string, VersionStatus> = {
  draft: VersionStatus.DRAFT,
  ready: VersionStatus.READY,
  approved: VersionStatus.APPROVED,
  superseded: VersionStatus.SUPERSEDED,
  discarded: VersionStatus.DISCARDED,
};
export const ITEM_VISIBILITIES: Record<string, ItemVisibility> = {
  public: ItemVisibility.PUBLIC,
  members: ItemVisibility.MEMBERS,
  officers: ItemVisibility.OFFICERS,
};
export const FILE_AUDIENCES: Record<string, FileAudience> = {
  public: FileAudience.PUBLIC,
  members: FileAudience.MEMBERS,
  officers: FileAudience.OFFICERS,
};
export const FILE_ROLES: Record<string, FileRole> = {
  primary: FileRole.PRIMARY,
  public_copy: FileRole.PUBLIC_COPY,
  source: FileRole.SOURCE,
};
export const OFFICE_KINDS: Record<string, OfficeKind> = {
  elected: OfficeKind.ELECTED,
  appointed: OfficeKind.APPOINTED,
  ex_officio: OfficeKind.EX_OFFICIO,
  committee: OfficeKind.COMMITTEE,
  regional_external: OfficeKind.REGIONAL_EXTERNAL,
};
export const TERM_STATUSES: Record<string, TermStatus> = {
  active: TermStatus.ACTIVE,
  acting: TermStatus.ACTING,
  vacant: TermStatus.VACANT,
};
export const EDITION_KINDS: Record<string, EditionKind> = { regular: EditionKind.REGULAR, xtra: EditionKind.XTRA };
export const EDITION_STATUSES: Record<string, EditionStatus> = {
  planning: EditionStatus.PLANNING,
  collecting: EditionStatus.COLLECTING,
  drafting: EditionStatus.DRAFTING,
  proof: EditionStatus.PROOF,
  published: EditionStatus.PUBLISHED,
};


/** The reverse of a vocabulary: proto enum value -> database text. */
export function namesOf<E extends number>(map: Record<string, E>): Map<E, string> {
  return new Map(Object.entries(map).map(([name, value]) => [value, name]));
}
