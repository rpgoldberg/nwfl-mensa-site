// A DNS stand-in on the container's loopback (UDP): answers A, AAAA, MX and NS from a handler, or an
// rcode (3 is NXDOMAIN, 2 SERVFAIL), or nothing at all (a timeout). Enough of RFC 1035 for c-ares.
import { type Socket, createSocket } from 'node:dgram';

export type Answer = string | { priority: number; exchange: string };
export type Reply = { rcode?: number; answers?: Answer[] } | 'silent';
export type Handler = (name: string, type: 'A' | 'AAAA' | 'MX' | 'NS' | 'OTHER') => Reply;

const TYPES: Record<number, 'A' | 'AAAA' | 'MX' | 'NS'> = { 1: 'A', 28: 'AAAA', 15: 'MX', 2: 'NS' };

const labels = (name: string): Buffer =>
  Buffer.concat([...name.split('.').filter(Boolean).map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);

function v6(ip: string): Buffer {
  const [head = '', tail] = ip.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

function rdata(type: number, answer: Answer): Buffer {
  if (type === 1) return Buffer.from((answer as string).split('.').map(Number));
  if (type === 28) return v6(answer as string);
  if (type === 15) {
    const mx = answer as { priority: number; exchange: string };
    const pref = Buffer.alloc(2);
    pref.writeUInt16BE(mx.priority);
    return Buffer.concat([pref, labels(mx.exchange)]);
  }
  return labels(answer as string);
}

export interface DnsServer {
  port: number;
  queries: { name: string; type: string }[];
  close(): Promise<void>;
}

export async function startDnsServer(handler: Handler): Promise<DnsServer> {
  const socket: Socket = createSocket('udp4');
  const queries: { name: string; type: string }[] = [];
  socket.on('message', (msg, peer) => {
    const id = msg.readUInt16BE(0);
    let at = 12;
    const parts: string[] = [];
    while ((msg[at] as number) > 0) {
      const n = msg[at] as number;
      parts.push(msg.subarray(at + 1, at + 1 + n).toString());
      at += n + 1;
    }
    const question = msg.subarray(12, at + 5);
    const qtype = msg.readUInt16BE(at + 1);
    const name = parts.join('.').toLowerCase();
    const type = TYPES[qtype] ?? 'OTHER';
    queries.push({ name, type });
    const reply = handler(name, type);
    if (reply === 'silent') return;
    const answers = reply.answers ?? [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8180 | (reply.rcode ?? 0), 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    const records = answers.map((answer) => {
      const data = rdata(qtype, answer);
      const fixed = Buffer.alloc(12);
      fixed.writeUInt16BE(0xc00c, 0);
      fixed.writeUInt16BE(qtype, 2);
      fixed.writeUInt16BE(1, 4);
      fixed.writeUInt32BE(0, 6);
      fixed.writeUInt16BE(data.length, 10);
      return Buffer.concat([fixed, data]);
    });
    socket.send(Buffer.concat([header, question, ...records]), peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, queries, close: () => new Promise<void>((resolve) => socket.close(() => resolve())) };
}
