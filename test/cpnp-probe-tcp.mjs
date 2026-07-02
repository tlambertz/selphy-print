/* Paper-free: do the CPNP handshake + startSpool, then log every raw TCP
   frame the printer pushes (opcode + body) WITHOUT sending execute — so we
   can see the real request/status format. Usage: node test/cpnp-probe-tcp.mjs */
import dgram from 'node:dgram';
import net from 'node:net';
import sharp from 'sharp';

const host = process.argv[2] || '192.168.1.240';
const PORT = 8609;
let pid = 0;
const nextId = () => (pid = pid >= 0xffff ? 1 : pid + 1);
const hx = (b, n = 48) => [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');

function udp(pkt, op, ms = 3000) {
  return new Promise((res, rej) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); rej(new Error('udp timeout')); }, ms);
    s.on('message', (m) => { if (m[4] === 0x81 && m[5] === op) { clearTimeout(t); s.close(); res(m); } });
    s.bind(() => s.send(pkt, PORT, host));
  });
}

// sessionStart
const ss = Buffer.alloc(408);
Buffer.from([67, 80, 78, 80, 1, 0x10, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]).copy(ss);
Buffer.from('selphy-print', 'utf16le').swap16().copy(ss, 24, 0, 64);
Buffer.from([0, 83, 0, 80, 0, 76, 0, 32, 0, 118, 0, 50, 0, 46, 0, 48]).copy(ss, 88);
Buffer.from([0, 83, 0, 113, 0, 117, 0, 97, 0, 114, 0, 101]).copy(ss, 152);
const sr = await udp(ss, 0x10);
const sessionId = (sr[10] << 8) | sr[11];
const tcpPort = (sr[20] << 8) | sr[21];
console.log(`session ok: id=${sessionId} port=${tcpPort}`);

const sock = await new Promise((res, rej) => {
  const s = net.connect({ host, port: tcpPort }, () => res(s));
  s.once('error', rej);
});
console.log('tcp connected');

let rbuf = Buffer.alloc(0);
const frames = [];
sock.on('data', (d) => {
  rbuf = Buffer.concat([rbuf, d]);
  // parse CPNP frames: 16-byte header, big-endian length @12-15
  while (rbuf.length >= 16) {
    const len = (rbuf[12] << 24) | (rbuf[13] << 16) | (rbuf[14] << 8) | rbuf[15];
    if (rbuf.length < 16 + len) break;
    const frame = rbuf.subarray(0, 16 + len);
    rbuf = rbuf.subarray(16 + len);
    const op = frame[5];
    const body = frame.subarray(16);
    console.log(`FRAME op=0x${op.toString(16)} len=${len} result=${(frame[6] << 8) | frame[7]}`);
    if (len > 0) {
      const u32 = (o) => (o + 4 <= body.length ? body.readUInt32LE(o) : 0);
      console.log(`  body: ${hx(body)}`);
      console.log(`  parsed LE: status@8=0x${u32(8).toString(16)} err@12=0x${u32(12).toString(16)} dataReq@16=0x${u32(16).toString(16)} off@24=${u32(24)} size@28=${u32(28)}`);
    }
    frames.push({ op, len, body: Buffer.from(body) });
  }
});

const write = (buf) => new Promise((r) => sock.write(buf, r));
function frame(op, payload = Buffer.alloc(0), sid = sessionId) {
  const h = Buffer.from([67, 80, 78, 80, 1, op, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const id = nextId();
  h[8] = (id >> 8) & 0xff; h[9] = id & 0xff;
  h[10] = (sid >> 8) & 0xff; h[11] = sid & 0xff;
  h[12] = (payload.length >>> 24) & 0xff; h[13] = (payload.length >>> 16) & 0xff;
  h[14] = (payload.length >>> 8) & 0xff; h[15] = payload.length & 0xff;
  return Buffer.concat([h, payload]);
}
const le = (b, o, n, v) => { for (let i = 0; i < n; i++) b[o + i] = (v >>> (i * 8)) & 0xff; };

// SetMaxWriteSize
const set = Buffer.from([67, 80, 78, 80, 1, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0x84, 0]);
set[10] = (sessionId >> 8) & 0xff; set[11] = sessionId & 0xff;
await write(set);
await new Promise((r) => setTimeout(r, 300));

// startSpool (192B, border=2, CP_POST_SIZE=4)
const jpeg = await sharp({ create: { width: 1184, height: 1752, channels: 3, background: '#40a0e0' } }).jpeg().toBuffer();
const spool = Buffer.alloc(192);
le(spool, 2, 2, 7); le(spool, 4, 4, 192); le(spool, 12, 2, 1); le(spool, 14, 2, 4);
le(spool, 16, 1, 1); le(spool, 18, 1, 2); le(spool, 32, 4, jpeg.length);
console.log('--- sending startSpool, then listening 6s for pushed frames ---');
await write(frame(0x21, spool));

await new Promise((r) => setTimeout(r, 6000));
console.log(`\ncaptured ${frames.length} frames total`);
sock.destroy();
// sessionEnd
try { await udp((() => { const e = Buffer.from([67, 80, 78, 80, 1, 0x11, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]); e[10] = (sessionId >> 8) & 0xff; e[11] = sessionId & 0xff; return e; })(), 0x11, 1500); } catch {}
console.log('done (no execute sent — no paper)');
process.exit(0);
