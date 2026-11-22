// ARCHIVE-SEARCH S3: the API's own limits on searching (plan section 3): a global bucket of ten a
// second with a burst of twenty, and at most four searches at once. The API cannot tell visitors
// apart (its one client is the site), so these are global.
import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import { SEARCH_LIMITS, admission, limitsFrom } from './limits.js';

const refused = (run: () => unknown): ConnectError | undefined => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as ConnectError;
  }
};

describe('search: the limits', () => {
  it('pins the plan\'s numbers', () => {
    expect(SEARCH_LIMITS).toEqual({ perSecond: 10, burst: 20, concurrent: 4, timeoutMs: 2000 });
  });

  it('takes an override of some and keeps the rest', () => {
    expect(limitsFrom(undefined)).toEqual(SEARCH_LIMITS);
    expect(limitsFrom({ timeoutMs: 50 })).toEqual({ ...SEARCH_LIMITS, timeoutMs: 50 });
  });

  it('lets a burst of twenty through, then refuses, RESOURCE_EXHAUSTED', () => {
    const gate = admission({ ...SEARCH_LIMITS, concurrent: 1000 }, () => 0);
    for (let n = 0; n < 20; n++) expect(refused(() => gate.enter()), `call ${n + 1}`).toBeUndefined();
    const error = refused(() => gate.enter());
    expect(error).toBeInstanceOf(ConnectError);
    expect(error?.code).toBe(Code.ResourceExhausted);
  });

  it('refills at ten a second, and never past the burst', () => {
    let now = 0;
    const gate = admission({ ...SEARCH_LIMITS, concurrent: 1000 }, () => now);
    for (let n = 0; n < 20; n++) gate.enter();
    now = 99;
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    now = 100;
    expect(refused(() => gate.enter())).toBeUndefined();
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    now = 1100;
    for (let n = 0; n < 10; n++) expect(refused(() => gate.enter()), `refilled ${n + 1}`).toBeUndefined();
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    // A long quiet spell fills the bucket to the burst and no further.
    now = 3_600_000;
    for (let n = 0; n < 20; n++) expect(refused(() => gate.enter()), `after the quiet ${n + 1}`).toBeUndefined();
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
  });

  it('is not moved by a clock that steps back', () => {
    let now = 1000;
    const gate = admission({ ...SEARCH_LIMITS, concurrent: 1000 }, () => now);
    for (let n = 0; n < 20; n++) gate.enter();
    now = 0;
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    now = 1100;
    expect(refused(() => gate.enter())).toBeUndefined();
  });

  it('answers four at once and refuses the fifth until one has left', () => {
    const gate = admission(SEARCH_LIMITS, () => 0);
    const leaves = [gate.enter(), gate.enter(), gate.enter(), gate.enter()];
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    leaves[0]!();
    const fifth = gate.enter();
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    // Leaving twice gives back one place, not two.
    leaves[1]!();
    leaves[1]!();
    gate.enter();
    expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    fifth();
  });

  it('does not spend a token on a search it refuses for being one too many at once', () => {
    const gate = admission({ ...SEARCH_LIMITS, burst: 5 }, () => 0);
    const leaves = [gate.enter(), gate.enter(), gate.enter(), gate.enter()];
    for (let n = 0; n < 50; n++) expect(refused(() => gate.enter())?.code).toBe(Code.ResourceExhausted);
    leaves[0]!();
    // The fifth token is still there.
    expect(refused(() => gate.enter())).toBeUndefined();
  });
});
