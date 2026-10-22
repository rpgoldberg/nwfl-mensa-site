// The golden exports against the generator's loader contract (v1): the keys it
// reads directly must be there with the types it expects, the keys it reads
// with defaults must have its types when present, and no contact field may
// appear. The goldens were also run through the generator's own main() (N2
// report); this keeps a regenerated golden from drifting out of that shape.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const OFFICER_KEYS = ['President', 'Vice President', 'Treasurer', 'Membership Officer', 'Member at Large', 'Past President', 'Editor', 'Publications Officer', 'Webmaster'];
const EVENT_KEYS = new Set(['time', 'title', 'location', 'url']);

const isString = (value: unknown): value is string => typeof value === 'string';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every way `data` breaks the loader contract; empty when it holds. */
function contractProblems(data: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(data)) return ['not an object'];
  const { config, officers, articles, events, minutes } = data;
  if (!isRecord(config)) problems.push('config');
  else {
    for (const key of ['month_year', 'volume', 'issue', 'organization']) if (!isString(config[key])) problems.push(`config.${key}`);
    const months = config['calendar_months'];
    if (!Array.isArray(months) || !months.every((m) => isRecord(m) && Number.isInteger(m['month']) && Number(m['month']) >= 1 && Number(m['month']) <= 12 && Number.isInteger(m['year'])))
      problems.push('config.calendar_months');
  }
  if (!isRecord(officers) || JSON.stringify(Object.keys(officers)) !== JSON.stringify(OFFICER_KEYS) || !Object.values(officers).every(isString)) problems.push('officers');
  if (!Array.isArray(articles) || !articles.every((a) => isRecord(a) && isString(a['title']) && isString(a['content']))) problems.push('articles');
  if (minutes !== undefined && !isString(minutes)) problems.push('minutes');
  if (!isRecord(events)) problems.push('events');
  else
    for (const [date, list] of Object.entries(events)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push(`events key ${date}`);
      if (!Array.isArray(list) || !list.every((e) => isRecord(e) && isString(e['title']) && Object.entries(e).every(([k, v]) => EVENT_KEYS.has(k) && isString(v))))
        problems.push(`events ${date}`);
    }
  return problems;
}

describe('golden exports keep the generator contract', () => {
  it.each(['export.members.golden.json', 'export.public.golden.json'])('%s', (name) => {
    expect(contractProblems(JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')))).toEqual([]);
  });

  it('catches a contact field, a missing direct key and a tenth officer', () => {
    const data = JSON.parse(readFileSync(path.join(FIXTURES, 'export.members.golden.json'), 'utf8')) as Record<string, Record<string, unknown>>;
    const events = data['events'] as Record<string, Array<Record<string, string>>>;
    const [first] = Object.values(events);
    if (first?.[0]) first[0]['phone'] = '850-555-0100';
    delete data['config']?.['volume'];
    (data['officers'] as Record<string, string>)['Historian'] = 'Casey Madeup';
    expect(contractProblems(data)).toEqual(['config.volume', 'officers', `events ${Object.keys(events)[0]}`]);
    expect(contractProblems([])).toEqual(['not an object']);
    expect(contractProblems({ config: {}, officers: {}, articles: [{}], events: { tomorrow: 'x' }, minutes: 3 })).toEqual([
      'config.month_year',
      'config.volume',
      'config.issue',
      'config.organization',
      'config.calendar_months',
      'officers',
      'articles',
      'minutes',
      'events key tomorrow',
      'events tomorrow',
    ]);
  });
});
