// Raw HTTP/2 and HTTP/1.1 requests, below any Connect client, so a test can
// send exactly the bytes a non-gRPC caller would and read exactly what the
// server answers.
import http from 'node:http';
import http2 from 'node:http2';

export interface RawResponse {
  status: number;
  headers: http2.IncomingHttpHeaders;
  trailers: http2.IncomingHttpHeaders;
  body: Buffer;
}

export function h2Request(
  baseUrl: string,
  headers: http2.OutgoingHttpHeaders,
  body?: Uint8Array | string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(baseUrl);
    session.on('error', reject);
    const stream = session.request(headers, { endStream: body === undefined });
    let status = 0;
    let responseHeaders: http2.IncomingHttpHeaders = {};
    let trailers: http2.IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    stream.on('response', (h) => {
      responseHeaders = h;
      status = Number(h[':status']);
    });
    stream.on('trailers', (t: http2.IncomingHttpHeaders) => {
      trailers = t;
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', (error: Error) => {
      session.close();
      reject(error);
    });
    stream.on('end', () => {
      session.close();
      resolve({ status, headers: responseHeaders, trailers, body: Buffer.concat(chunks) });
    });
    if (body !== undefined) stream.end(body);
  });
}

export function http1Post(url: string, contentType: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': contentType } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** A gRPC length-prefixed frame around an already-encoded message. */
export function grpcFrame(message: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + message.length);
  new DataView(frame.buffer).setUint32(1, message.length);
  frame.set(message, 5);
  return frame;
}
