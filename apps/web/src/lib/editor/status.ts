// EDITOR E2: an item's status in the officer editor's words (spec S2), with the tone of the chip it is
// shown in (StatusChip.astro's: ok, warn, stop, past). The words always go with the chip: never colour alone.
// The item's state decides first; then, for a draft or a published item, its working version: ready
// (a change waiting), or a draft with the approver's note (sent back).
import type { EditorItem, KindName } from '../api/editor';
import { formatSetDate } from '../approval-rules';

/** What an item is, in the words of the new-item form (S3). */
export const KIND_WORDS: Record<KindName, string> = {
  announcement: 'Announcement',
  article: 'News article',
  president_report: "President's report",
  minutes: 'Minutes',
  treasurer_summary: "Treasurer's summary",
  document: 'Document',
  page: 'Page',
};

export type StatusKey = 'draft' | 'ready' | 'sent_back' | 'published' | 'published_change_waiting' | 'taken_down';
export type StatusTone = 'ok' | 'warn' | 'stop' | 'past';

export interface Status {
  key: StatusKey;
  label: string;
  tone: StatusTone;
}

export const STATUS_WORDS: Record<StatusKey, string> = {
  draft: 'Draft – only officers can see it',
  ready: 'Waiting for approval',
  sent_back: 'Sent back – please read the note',
  published: 'Published',
  published_change_waiting: 'Published – a change is waiting for approval',
  taken_down: 'Taken down',
};

const TONES: Record<StatusKey, StatusTone> = { draft: 'past', ready: 'warn', sent_back: 'stop', published: 'ok', published_change_waiting: 'warn', taken_down: 'stop' };

const status = (key: StatusKey, label = STATUS_WORDS[key]): Status => ({ key, label, tone: TONES[key] });

/** The item's status: "Taken down on November 11, 2026" carries the Central date it was taken down, when the API gave one. */
export function statusOf(item: EditorItem): Status {
  const working = item.working;
  const sentBack = working?.status === 'draft' && working.sendBackNote !== '';
  switch (item.state) {
    case 'withdrawn':
      return status('taken_down', item.withdrawnAt === undefined ? STATUS_WORDS.taken_down : `${STATUS_WORDS.taken_down} on ${formatSetDate(item.withdrawnAt)}`);
    case 'published':
      if (working?.status === 'ready') return status('published_change_waiting');
      return status(sentBack ? 'sent_back' : 'published');
    case 'ready':
      return status('ready');
    case 'draft':
      return status(sentBack ? 'sent_back' : 'draft');
  }
}
