// SERIES-UI-2: the series form marks each follow-up question with the choice it belongs to (the classes
// site.css hides by, inside @supports selector(:has(...))), and keeps every question and its label in the
// page whatever was chosen: a browser without :has() shows them all, each saying what it is for.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import SeriesForm from '../../src/components/SeriesForm.astro';
import { blankSeriesValues } from '../../src/lib/editor/series';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const render = (values = blankSeriesValues(), errors: Record<string, string[]> = {}) =>
  container.renderToString(SeriesForm, {
    props: { action: '/officer-area/events/series/new', mode: 'new', values, errors, venues: [], offices: [], keep: undefined, preview: undefined, dropped: [], submit: 'Start it', back: '/officer-area/events' },
  });
/** The classes of the field or fieldset that holds the control with this id. */
const blockOf = (html: string, id: string) => {
  const at = html.indexOf(`id="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  const start = Math.max(html.lastIndexOf('<fieldset', at), html.lastIndexOf('<div class="field', at));
  return /class="([^"]*)"/.exec(html.slice(start, html.indexOf('>', start)))?.[1]?.split(/\s+/) ?? [];
};

describe('SeriesForm', () => {
  it('marks each follow-up question with its choice', async () => {
    const html = await render();
    expect(blockOf(html, 'everyN')).toEqual(['field', 'when-every-n']);
    expect(blockOf(html, 'day-MO')).toEqual(['when-weeks']);
    expect(blockOf(html, 'monthly-weekday')).toEqual(['when-monthly']);
    expect(blockOf(html, 'ordinal-1')).toEqual(['when-monthly', 'when-month-weekday']);
    expect(blockOf(html, 'weekday-MO')).toEqual(['when-monthly', 'when-month-weekday']);
    expect(blockOf(html, 'monthDay')).toEqual(['field', 'when-monthly', 'when-month-date']);
    expect(blockOf(html, 'count')).toEqual(['field', 'when-ends-count']);
    expect(blockOf(html, 'until')).toEqual(['field', 'when-ends-until']);
  });

  it('marks no question that is always asked', async () => {
    const html = await render();
    for (const id of ['title', 'kind-lunch', 'repeat-weekly', 'startsOn', 'time', 'length', 'venue-later', 'area-okaloosa', 'visibility-public', 'description', 'ends-never']) {
      expect(blockOf(html, id).filter((c) => c.startsWith('when-')), id).toEqual([]);
    }
  });

  it('keeps every question in the page, each labelled with what it is for, whatever is chosen', async () => {
    for (const values of [blankSeriesValues(), { ...blankSeriesValues(), repeat: 'monthly', monthly: 'last-day', ends: 'until' }]) {
      const html = (await render(values)).replace(/&(#34|quot);/g, '"');
      for (const label of [
        'For "Every few weeks": how many weeks apart',
        'For a weekly event: on which days',
        'For a monthly event: which day of the month',
        'For a monthly event on a day of the week: which one in the month',
        'For a monthly event on a day of the week: which day',
        'For a monthly event on a date: the day of the month',
        'For "After a number of dates": how many dates',
        'For "On a date": the last date',
      ]) expect(html, label).toContain(label);
    }
  });

  it('writes a problem inside its question, where the stylesheet keeps it shown', async () => {
    const html = await render({ ...blankSeriesValues(), repeat: 'weekly' }, { days: ['Choose at least one day of the week.'] });
    const start = html.lastIndexOf('<fieldset', html.indexOf('id="day-MO"'));
    expect(html.slice(start, html.indexOf('id="day-MO"'))).toContain('<p class="error" id="days-error">Problem: Choose at least one day of the week.</p>');
  });
});
