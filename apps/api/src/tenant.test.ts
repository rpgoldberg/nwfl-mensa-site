// CF-ISO-0: the chapter this deployment serves, TENANT, from config (default nwflorida), checked at
// startup against the database's tenant row (0012): a mismatch or a missing row refuses to start.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TENANT, checkTenant, parseTenant } from './tenant.js';

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

describe('checkTenant', () => {
  const sleep = (): Promise<void> => Promise.resolve();

  it('passes when the database has exactly the configured tenant', async () => {
    await expect(checkTenant(() => Promise.resolve(['nwflorida']), 'nwflorida', { sleep })).resolves.toBeUndefined();
  });

  it('refuses at once, with a plain reason, when the row is another chapter\'s', async () => {
    const read = vi.fn(() => Promise.resolve(['nwflorida']));
    await expect(checkTenant(read, 'mensa-other', { sleep })).rejects.toThrow('TENANT is mensa-other but the database serves nwflorida: refusing to start');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refuses when there is no row, and when there are several', async () => {
    await expect(checkTenant(() => Promise.resolve([]), 'nwflorida', { sleep })).rejects.toThrow('TENANT is nwflorida but the database has no tenant row: refusing to start');
    await expect(checkTenant(() => Promise.resolve(['mensa-other', 'nwflorida']), 'nwflorida', { sleep })).rejects.toThrow(
      'the database has 2 tenant rows (mensa-other, nwflorida) and this process serves exactly one: refusing to start',
    );
  });

  it('names what it read in the reason', async () => {
    await expect(checkTenant(() => Promise.resolve([]), 'nwflorida', { sleep, what: 'redaction policy tenant' })).rejects.toThrow('has no redaction policy tenant');
  });

  it('retries a database that does not answer yet, then checks', async () => {
    const read = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValueOnce(['nwflorida']);
    const waits: number[] = [];
    const record = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
    await checkTenant(read, 'nwflorida', { sleep: record, attempts: 3, delayMs: 7 });
    expect(read).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([7]);
  });

  it('gives up after its attempts, saying it could not check', async () => {
    const read = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(checkTenant(read, 'nwflorida', { sleep, attempts: 3 })).rejects.toThrow('could not check TENANT against the database after 3 attempts (ECONNREFUSED): refusing to start');
    expect(read).toHaveBeenCalledTimes(3);
    // A non-Error rejection, as a driver can give.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(checkTenant(() => Promise.reject('odd'), 'nwflorida', { sleep, attempts: 1 })).rejects.toThrow('(odd)');
  });

  it('waits between attempts by default', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn<() => Promise<string[]>>().mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(['nwflorida']);
      const done = checkTenant(read, 'nwflorida');
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(done).resolves.toBeUndefined();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
