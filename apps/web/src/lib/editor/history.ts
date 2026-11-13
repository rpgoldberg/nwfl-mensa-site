// EDITOR E2: an item's history as sentences (spec S8), newest first:
//   "Tue 17 Nov, 10:42 – Publications Officer (you) sent it for approval (version 2)."
// Who acted is the API's label for their role at the time (HistoryEntry.actor_label), never a name: the
// site keeps no subject-to-name store. "(you)" marks the signed-in officer's own steps, by subject. A
// send-back note or a break-glass reason is quoted after the sentence. An action with no words here is
// put in plain words from its name. Times are Central.
import type { HistoryStep } from '../api/editor';
import { ZONE } from '../calendar';

export interface HistorySentence {
  at?: Date;
  sentence: string;
}

const DOING: Record<string, string> = {
  create: 'started it as a draft',
  save: 'saved a draft',
  autosave: 'saved a draft automatically',
  ready: 'sent it for approval',
  send_back: 'sent it back',
  approve: 'approved it',
  approve_single: 'approved their own change, as the one-approver setting allows',
  approve_self: 'approved their own change by break-glass',
  withdraw: 'took it down from the website',
  restore: 'brought it back as a new draft',
  targets_changed: 'changed where it will appear',
  edition_changed: 'changed the newsletter edition',
};

/** What a note is, by the step it came with. */
const NOTE_LEAD: Record<string, string> = { approve_self: 'The reason' };

const PARTS = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "Tue 17 Nov, 10:42", in Central. */
export function whenText(at: Date): string {
  const part = Object.fromEntries(PARTS.formatToParts(at).map((p) => [p.type, p.value]));
  return `${part['weekday']} ${part['day']} ${part['month']}, ${part['hour']}:${part['minute']}`;
}

/** An action's own name in words, when it is a plain name: "pin_edition" is "pin edition". */
function plainAction(action: string): string {
  return /^[a-z][a-z_]{0,39}$/.test(action) ? ` (${action.replace(/_/g, ' ')})` : '';
}

const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();

function sentenceOf(step: HistoryStep, you: string | undefined): HistorySentence {
  const who = `${step.actorLabel.trim() || 'Someone'}${you && step.actorSubject === you ? ' (you)' : ''}`;
  const doing = Object.hasOwn(DOING, step.action) ? DOING[step.action] : `made a change${plainAction(step.action)}`;
  const version = step.versionNumber > 0 ? ` (version ${step.versionNumber})` : '';
  const note = oneLine(step.note);
  const quoted = note === '' ? '' : ` ${NOTE_LEAD[step.action] ?? 'The note'}: “${note}”`;
  const body = `${who} ${doing}${version}.${quoted}`;
  return step.at === undefined ? { sentence: body } : { at: step.at, sentence: `${whenText(step.at)} – ${body}` };
}

/** The history as the API gives it (oldest first), as sentences newest first. `you`: the signed-in subject. */
export function historySentences(steps: readonly HistoryStep[], { you }: { you: string | undefined }): HistorySentence[] {
  return steps.map((step) => sentenceOf(step, you)).reverse();
}
