// The worker thread extract() reads a PDF in (extract.ts): wiring only. It posts one reply and ends.
import { parentPort, workerData } from 'node:worker_threads';
import { type Audience } from './list.js';
import { ExtractError, type WorkerReply, readPdf } from './extract.js';

const { pdf, audience, deadlineMs } = workerData as { pdf: Uint8Array; audience: Audience; deadlineMs: number };
let reply: WorkerReply;
try {
  reply = { ok: true, extraction: await readPdf(pdf, audience, { deadlineMs }) };
} catch (error) {
  reply = { ok: false, message: error instanceof ExtractError ? error.message : 'the file could not be read as a PDF' };
}
parentPort?.postMessage(reply);
