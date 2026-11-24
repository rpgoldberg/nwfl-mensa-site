// WEB-SMALL-1: the wrap rules and the series form's follow-up rules, read from the stylesheet the site
// ships. The browser checks are in e2e/web-small.spec.ts; these keep the rules from being dropped.
//   - an event card's words and an item header's title wrap inside their box (EV-CARDS200, E4-FOLLOWUPS);
//   - the series form hides a follow-up question only inside @supports selector(:has(...)), so a browser
//     without :has() shows every question, and never hides one that carries a problem (SERIES-UI-2).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const site = readFileSync('src/styles/site.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/** The declarations of the first rule whose selector list holds `selector`. */
const rule = (selector: string) => {
  const found = [...site.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1]!.split(',').some((s) => s.trim() === selector));
  expect(found, selector).toBeDefined();
  return found![2]!;
};
/** The body of the one @supports block that asks for :has(). */
const hasBlock = () => {
  const start = site.indexOf('@supports selector(:has(');
  expect(start).toBeGreaterThan(-1);
  expect(site.indexOf('@supports selector(:has(', start + 1)).toBe(-1);
  const open = site.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < site.length; i++) {
    if (site[i] === '{') depth++;
    if (site[i] === '}' && --depth === 0) return site.slice(open + 1, i);
  }
  throw new Error('the @supports block never closes');
};

describe('long words wrap inside their box', () => {
  it('in an event card: the title, the time and place, the town', () => {
    expect(rule('.ecard__t')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.ecard__t')).toMatch(/min-width:\s*0/);
    expect(rule('.ecard .chip')).toMatch(/white-space:\s*normal/);
    expect(rule('.ecard .chip')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('in an item header: the title of the piece', () => {
    expect(rule('.item-header h1')).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe('the series form shows only the questions that match the choice', () => {
  const FOLLOW_UPS: [string, string][] = [
    ['.when-weeks', 'input[name="repeat"]:is([value="weekly"], [value="fortnightly"], [value="every-n"]):checked'],
    ['.when-every-n', 'input[name="repeat"][value="every-n"]:checked'],
    ['.when-monthly', 'input[name="repeat"][value="monthly"]:checked'],
    ['.when-month-weekday', 'input[name="monthly"][value="weekday"]:checked'],
    ['.when-month-date', 'input[name="monthly"][value="day"]:checked'],
    ['.when-ends-count', 'input[name="ends"][value="count"]:checked'],
    ['.when-ends-until', 'input[name="ends"][value="until"]:checked'],
  ];

  it('hides each follow-up question unless its choice is made, and never one with a problem', () => {
    const block = hasBlock();
    for (const [question, choice] of FOLLOW_UPS) expect(block, question).toContain(`.series-form:not(:has(${choice})) ${question}:not(:has(.error))`);
    expect(block).toMatch(/\{\s*display:\s*none;\s*\}\s*$/);
    expect(block.match(/\{/g)).toHaveLength(1);
  });

  it('hides nothing outside the @supports block, so a browser without :has() shows every question', () => {
    const outside = site.replace(hasBlock(), '');
    for (const [question] of FOLLOW_UPS) expect(outside, question).not.toContain(question);
  });
});
