// REDACT R3c: /documents/[id].pdf, on request; with no API (the canary) every file is not found.
import { describe, expect, it } from 'vitest';
import { GET, prerender } from '../../src/pages/documents/[id].pdf';

type Ctx = Parameters<typeof GET>[0];

describe('/documents/[id].pdf, with no API', () => {
  it('is not found, on request', async () => {
    expect(prerender).toBe(false);
    const res = (await GET({ params: { id: '0b9c1f5e-4c1a-4d55-9a3e-2f7d8e6a1b20' } } as unknown as Ctx)) as Response;
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No such file');
  });
});
