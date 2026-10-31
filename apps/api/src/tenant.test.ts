// CF-ISO-0: the chapter this deployment serves, TENANT, from config (default nwflorida), checked at
// startup against the database's tenant row (0012): a mismatch or a missing row refuses to start.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT, parseTenant, refuseToStart, startTenantGate, tenantMismatch } from './tenant.js';

describe('parseTenant', () => {
  it('defaults to nwflorida, 0012\'s one row', () => {
    expect(DEFAULT_TENANT).toBe('nwflorida');
    expect(parseTenant(undefined)).toBe('nwflorida');
  });

  it.each(['nwflorida', 'mensa-other', 'ab', `a${'b'.repeat(40)}`])('accepts %s, as 0012\'s CHECK does', (id) => {
    expect(parseTenant(id)).toBe(id);
  });

  it.each(['', 'a', 'Nwflorida', '9nwfl', 'nw florida', "nwflorida'--", 'nw_florida', `a${'b'.repeat(41)}`])('refuses %j', (id) => {
    expect(() => parseTenant(id)).toThrow(/^TENANT must/);
  });
});

describe('tenantMismatch: only a positive answer from the database is a mismatch', () => {
  it('is nothing for exactly the configured tenant', () => {
    expect(tenantMismatch(['nwflorida'], 'nwflorida')).toBeUndefined();
  });

  it('names another chapter\'s row, no row and several rows plainly', () => {
    expect(tenantMismatch(['nwflorida'], 'mensa-other')).toBe('TENANT is mensa-other but the database serves nwflorida: refusing to start');
    expect(tenantMismatch([], 'nwflorida')).toBe('TENANT is nwflorida but the database has no tenant row: refusing to start');
    expect(tenantMismatch(['mensa-other', 'nwflorida'], 'nwflorida')).toBe('the database has 2 tenant rows (mensa-other, nwflorida) and this process serves exactly one: refusing to start');
    expect(tenantMismatch([], 'nwflorida', 'redaction policy tenant')).toBe('TENANT is nwflorida but the database has no redaction policy tenant: refusing to start');
  });
});

describe('startTenantGate: verify in the background, never exit on a database that is down', () => {
  const down = (): Promise<string[]> => Promise.reject(Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432 user nwfl'), { code: 'ECONNREFUSED' }));

  it('stays unverified while the database is down, retries with backoff, then verifies once it answers, with no mismatch', async () => {
    const answers: Array<() => Promise<string[]>> = [down, down, down, () => Promise.resolve(['nwflorida'])];
    const retries: unknown[] = [];
    const waits: number[] = [];
    const onMismatch = vi.fn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = startTenantGate(() => (answers.shift() as () => Promise<string[]>)(), 'nwflorida', {
      onRetry: (fields) => void retries.push(fields),
      onMismatch,
      firstDelayMs: 100,
      maxDelayMs: 250,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 3) await held;
      },
    });
    await vi.waitFor(() => expect(waits).toHaveLength(3));
    expect(gate.verified).toBe(false);
    release();
    expect(await gate.settled).toBe('verified');
    expect(gate.verified).toBe(true);
    expect(onMismatch).not.toHaveBeenCalled();
    expect(waits).toEqual([100, 200, 250]);
    // A plain line per attempt: the code and the error's name, never its text (a host, a user).
    expect(retries).toEqual([
      { attempt: 1, retry_in_ms: 100, error_name: 'Error', error_code: 'ECONNREFUSED' },
      { attempt: 2, retry_in_ms: 200, error_name: 'Error', error_code: 'ECONNREFUSED' },
      { attempt: 3, retry_in_ms: 250, error_name: 'Error', error_code: 'ECONNREFUSED' },
    ]);
    expect(JSON.stringify(retries)).not.toMatch(/10\.0\.0\.9|nwfl\b/);
  });

  it('calls onVerified once verified', async () => {
    const onVerified = vi.fn();
    const gate = startTenantGate(() => Promise.resolve(['nwflorida']), 'nwflorida', { onMismatch: vi.fn(), onVerified });
    expect(await gate.settled).toBe('verified');
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('reports a non-Error failure without a code', async () => {
    const retries: unknown[] = [];
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const reads = [() => Promise.reject('odd'), () => Promise.resolve(['nwflorida'])];
    const gate = startTenantGate(() => (reads.shift() as () => Promise<string[]>)(), 'nwflorida', { onMismatch: vi.fn(), onRetry: (f) => void retries.push(f), sleep: () => Promise.resolve() });
    await gate.settled;
    expect(retries).toEqual([{ attempt: 1, retry_in_ms: 1_000, error_name: 'unknown' }]);
  });

  it('on a positive mismatch calls onMismatch with the reason and stays unverified', async () => {
    for (const [ids, message] of [
      [['nwflorida'], 'TENANT is mensa-other but the database serves nwflorida: refusing to start'],
      [[], 'TENANT is mensa-other but the database has no tenant row: refusing to start'],
      [['a1', 'b2'], 'the database has 2 tenant rows (a1, b2) and this process serves exactly one: refusing to start'],
    ] as const) {
      const onMismatch = vi.fn();
      const gate = startTenantGate(() => Promise.resolve([...ids]), 'mensa-other', { onMismatch });
      expect(await gate.settled).toBe('mismatch');
      expect(gate.verified).toBe(false);
      expect(onMismatch).toHaveBeenCalledWith(message);
    }
  });

  it('stops while waiting between attempts, with the default timer, and never verifies', async () => {
    const onMismatch = vi.fn();
    const gate = startTenantGate(down, 'nwflorida', { onMismatch, firstDelayMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    gate.stop();
    expect(await gate.settled).toBe('stopped');
    expect(gate.verified).toBe(false);
  });

  it('stops during a read: the answer that comes after is ignored', async () => {
    let answer!: (ids: string[]) => void;
    const onMismatch = vi.fn();
    const gate = startTenantGate(() => new Promise<string[]>((resolve) => (answer = resolve)), 'nwflorida', { onMismatch });
    gate.stop();
    answer(['mensa-other']);
    expect(await gate.settled).toBe('stopped');
    expect(onMismatch).not.toHaveBeenCalled();
    let fail!: (error: Error) => void;
    const failing = startTenantGate(() => new Promise<string[]>((_resolve, reject) => (fail = reject)), 'nwflorida', { onMismatch });
    failing.stop();
    fail(new Error('down'));
    expect(await failing.settled).toBe('stopped');
  });
});

describe('refuseToStart', () => {
  it('logs the reason, then exits 1', () => {
    const calls: unknown[] = [];
    refuseToStart((message) => void calls.push(['log', message]), (code) => void calls.push(['exit', code]))('TENANT is x but the database serves y: refusing to start');
    expect(calls).toEqual([
      ['log', 'TENANT is x but the database serves y: refusing to start'],
      ['exit', 1],
    ]);
  });
});
