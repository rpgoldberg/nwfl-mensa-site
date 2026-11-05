import { describe, expect, it } from 'vitest';
import { ExtractError, MAX_PDF_BYTES, extract, readPdf } from '../src/extract.js';
import { buildPdf, uriLink } from './helpers/pdf.js';

const WORKER = new URL('./helpers/extract-worker.mjs', import.meta.url);
const js = (code: string): URL => new URL(`data:text/javascript,${encodeURIComponent(code)}`);

describe('extract: readPdf in a worker with a heap limit and a deadline', () => {
  const pdf = buildPdf([{ text: [{ x: 72, y: 700, str: 'Our events page' }], annots: [uriLink([72, 696, 160, 712], 'https://example.org/events')] }]);

  it('gives what readPdf gives', async () => {
    expect(await extract(pdf, 'members', { workerUrl: WORKER })).toEqual(await readPdf(pdf, 'members'));
  });

  it('passes a refusal of the whole file on with its message', async () => {
    await expect(extract(new TextEncoder().encode('not a pdf'), 'public', { workerUrl: WORKER })).rejects.toThrow(new ExtractError('the file is not a PDF'));
  });

  it('refuses a file over 10 MiB before starting a worker', async () => {
    await expect(extract(new Uint8Array(MAX_PDF_BYTES + 1), 'public', { workerUrl: js('throw new Error("started")') })).rejects.toThrow(/larger than 10 MiB/);
  });

  it('ends a worker that runs past the deadline', async () => {
    await expect(extract(pdf, 'public', { workerUrl: js('setInterval(() => {}, 1000)'), deadlineMs: 200 })).rejects.toThrow(new ExtractError('reading the file took longer than 200 ms'));
  });

  it('ends a worker that runs out of heap', async () => {
    const hog = js('const keep = []; for (;;) keep.push(new Array(100000).fill({ a: Math.random() }));');
    await expect(extract(pdf, 'public', { workerUrl: hog, heapMb: 32 })).rejects.toThrow(new ExtractError('reading the file needed more than 32 MiB'));
  });

  it('refuses when the worker fails or ends without a reply', async () => {
    await expect(extract(pdf, 'public', { workerUrl: js('throw new Error("boom")') })).rejects.toThrow(new ExtractError('the file could not be read as a PDF'));
    await expect(extract(pdf, 'public', { workerUrl: js('process.exit(0)') })).rejects.toThrow(new ExtractError('the file could not be read as a PDF'));
  });
});
