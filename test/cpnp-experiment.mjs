/* Paper-free experiment (paper removed): run the full CPNP flow, dumping the
   printer's raw status at every step and every result code, INCLUDING execute
   — so we learn the real request/offset/length layout and see the no-paper
   status. Usage: node test/cpnp-experiment.mjs <ip> */
import dgram from 'node:dgram';
import net from 'node:net';
import sharp from 'sharp';

const host = process.argv[2] || '192.168.1.240';
const PORT = 8609;
let pid = 0;
const nid = () => (pid = pid >= 0xffff ? 1 : pid + 1);
const H = (b, n = b.length) => [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
console.log(`session id=${sessionId} port=${tcpPort}`);

let sock = null;
for (let a = 0; a < 10 && !sock; a++) {
  try {
    sock = await new Promise((res, rej) => {
      const s = net.connect({ host, port: tcpPort }, () => res(s));
      s.once('error', rej);
      s.setTimeout(6000, () => rej(new Error('timeout')));
    });
  } catch { await sleep(300); }
}
if (!sock) { console.log('TCP never opened on', tcpPort); process.exit(1); }
let rbuf = Buffer.alloc(0);
sock.on('data', (d) => (rbuf = Buffer.concat([rbuf, d])));
const readFrame = (ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (rbuf.length >= 16) {
      const len = (rbuf[12] << 24) | (rbuf[13] << 16) | (rbuf[14] << 8) | rbuf[15];
      if (rbuf.length >= 16 + len) {
        clearInterval(iv);
        const f = rbuf.subarray(0, 16 + len); rbuf = rbuf.subarray(16 + len);
        res({ op: f[5], result: (f[6] << 8) | f[7], body: f.subarray(16) });
      }
    }
    if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('read timeout')); }
  }, 15);
});
const write = (b) => new Promise((r) => sock.write(b, r));
const le = (b, o, n, v) => { for (let i = 0; i < n; i++) b[o + i] = (v >>> (i * 8)) & 0xff; };
function hdr(op, sid, payloadLen) {
  const h = Buffer.from([67, 80, 78, 80, 1, op, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const id = nid(); h[8] = (id >> 8) & 0xff; h[9] = id & 0xff;
  h[10] = (sid >> 8) & 0xff; h[11] = sid & 0xff;
  h[12] = (payloadLen >>> 24) & 0xff; h[13] = (payloadLen >>> 16) & 0xff;
  h[14] = (payloadLen >>> 8) & 0xff; h[15] = payloadLen & 0xff;
  return h;
}
async function cmd(op, payload = Buffer.alloc(0)) {
  await write(Buffer.concat([hdr(op, sessionId, payload.length), payload]));
  return readFrame();
}
async function queryStatus() {
  const r = await cmd(0x20);
  const b = r.body;
  const u32 = (o) => (o + 4 <= b.length ? b.readUInt32LE(o) : 0);
  return { raw: b, dataRequest: u32(16), off24: u32(24), sz28: u32(28), off28: u32(28), sz32: u32(32), err12: u32(12) };
}

// SetMaxWriteSize
{
  const set = Buffer.from([67, 80, 78, 80, 1, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0x84, 0]);
  set[10] = (sessionId >> 8) & 0xff; set[11] = sessionId & 0xff;
  await write(set); const r = await readFrame();
  console.log('SetMaxWriteSize result', r.result);
}

// JPEG at Canon postcard size
const jpeg = await sharp({ create: { width: 1184, height: 1752, channels: 3, background: '#d04070' } })
  .jpeg({ quality: 90 }).toBuffer();
console.log('JPEG', jpeg.length, 'bytes');

// startSpool (code 7, border=2, CP_POST_SIZE=4)
{
  const s = Buffer.alloc(192);
  le(s, 2, 2, 7); le(s, 4, 4, 192); le(s, 12, 2, 1); le(s, 14, 2, 4);
  le(s, 16, 1, 1); le(s, 18, 1, 2); le(s, 32, 4, jpeg.length);
  const r = await cmd(0x21, s);
  console.log('startSpool result', r.result, 'ackbody', H(r.body));
}

// makeStartPrint (64B, code = startPrintCode). Sent on START_PRINT state.
const startPrintCode = Number(process.argv[3] || 4);
function makeStartPrint() {
  const b = Buffer.alloc(64);
  le(b, 2, 2, startPrintCode); le(b, 4, 4, 64); le(b, 12, 2, 1); le(b, 14, 2, 4); le(b, 16, 1, 0);
  return b;
}
console.log('using startPrintCode =', startPrintCode);

const CHUNK = 33792 - 104;
let sentStart = false;
for (let i = 0; i < 40; i++) {
  const st = await queryStatus();
  const dr = st.dataRequest;
  console.log(`[${i}] dataReq=0x${dr.toString(16)} err=0x${st.err12.toString(16)} b18=${st.raw[18]} @28=${st.sz28} @96=${st.raw.length>=100?st.raw.readUInt32LE(96):'-'}`);

  if (dr === 0x30000) { const b = Buffer.alloc(104); le(b, 2, 2, 3); le(b, 4, 4, 104); const r = await cmd(0x21, b); console.log('  → endPrint', r.result); break; }
  else if (dr === 0x70000) { const b = Buffer.alloc(104); le(b, 2, 2, 8); le(b, 4, 4, 104); const r = await cmd(0x21, b); console.log('  → EXECUTE result', r.result, 'ack', H(r.body)); }
  else if ((dr & 0xffff0000) === 0x20000) { // PRINT_DATA
    const off = st.raw.readUInt32LE(96) < jpeg.length ? st.raw.readUInt32LE(96) : 0;
    const size = Math.min(CHUNK, jpeg.length - off);
    const part = jpeg.subarray(off, off + size);
    const h = Buffer.alloc(104);
    le(h, 2, 2, 1); le(h, 4, 4, 104 + part.length); le(h, 12, 2, 1); le(h, 14, 2, 4);
    le(h, 16, 4, 1); le(h, 20, 4, jpeg.length); le(h, 24, 4, 1184); le(h, 28, 4, 1752);
    le(h, 96, 4, off); le(h, 100, 4, part.length);
    const r = await cmd(0x21, Buffer.concat([h, part]));
    console.log(`  → PRINT_DATA off=${off} size=${size} result ${r.result} ack ${H(r.body)}`);
  } else if (dr === 0x10000) { // START_PRINT → send makeStartPrint once
    if (!sentStart) { const r = await cmd(0x21, makeStartPrint()); console.log('  → startPrint result', r.result, 'ack', H(r.body)); sentStart = true; }
    else await sleep(250);
  } else { await sleep(250); }
}

sock.destroy();
try { const e = Buffer.from([67, 80, 78, 80, 1, 0x11, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]); e[10] = (sessionId >> 8) & 0xff; e[11] = sessionId & 0xff; await udp(e, 0x11, 1500); } catch {}
console.log('\nexperiment done');
process.exit(0);
