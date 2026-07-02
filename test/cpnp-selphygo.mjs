/* Faithful port of tbleher/selphy_go's working flow, adapted to the CP1500's
   dynamic-port session. NO startSpool / setMaxWriteSize / 104-byte headers —
   just: poll status, and act on status byte 0x12 (state):
     0 wait · 1 send 64B flags(border@0x12) · 2 send raw JPEG[off:off+len] in
     4KB chunks · 3 send done · 4 error.
   Paper removed, so running to completion is safe. Usage: node test/cpnp-selphygo.mjs <ip> */
import dgram from 'node:dgram';
import net from 'node:net';
import sharp from 'sharp';

const host = process.argv[2] || '192.168.1.240';
const border = process.argv[3] === 'border';
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

const ss = Buffer.alloc(408);
Buffer.from([67, 80, 78, 80, 1, 0x10, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]).copy(ss);
Buffer.from('selphy-print', 'utf16le').swap16().copy(ss, 24, 0, 64); // payload 0x08 = packet 24
Buffer.from([0, 83, 0, 80, 0, 76, 0, 32, 0, 118, 0, 50, 0, 46, 0, 48]).copy(ss, 88);
Buffer.from([0, 83, 0, 113, 0, 117, 0, 97, 0, 114, 0, 101]).copy(ss, 152);
const sr = await udp(ss, 0x10);
const sessionId = (sr[10] << 8) | sr[11];
const tcpPort = (sr[20] << 8) | sr[21];
console.log(`session id=${sessionId} port=${tcpPort} border=${border}`);

let sock = null;
for (let a = 0; a < 12 && !sock; a++) {
  try {
    sock = await new Promise((res, rej) => {
      const s = net.connect({ host, port: tcpPort }, () => res(s));
      s.once('error', rej); s.setTimeout(6000, () => rej(new Error('t')));
    });
  } catch { await sleep(300); }
}
if (!sock) { console.log('no TCP'); process.exit(1); }

let rbuf = Buffer.alloc(0);
sock.on('data', (d) => (rbuf = Buffer.concat([rbuf, d])));
const readFrame = (ms = 6000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (rbuf.length >= 16) {
      const len = (rbuf[12] << 24) | (rbuf[13] << 16) | (rbuf[14] << 8) | rbuf[15];
      if (rbuf.length >= 16 + len) { clearInterval(iv); const f = rbuf.subarray(0, 16 + len); rbuf = rbuf.subarray(16 + len); res({ result: (f[6] << 8) | f[7], body: f.subarray(16) }); }
    }
    if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('read timeout')); }
  }, 10);
});
const write = (b) => new Promise((r) => sock.write(b, r));
function pkt(op, payload = Buffer.alloc(0)) {
  const h = Buffer.from([67, 80, 78, 80, 1, op, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const id = nid(); h[8] = (id >> 8) & 0xff; h[9] = id & 0xff;
  h[10] = (sessionId >> 8) & 0xff; h[11] = sessionId & 0xff;
  h[12] = (payload.length >>> 24) & 0xff; h[13] = (payload.length >>> 16) & 0xff;
  h[14] = (payload.length >>> 8) & 0xff; h[15] = payload.length & 0xff;
  return Buffer.concat([h, payload]);
}
async function cmd(op, payload) { await write(pkt(op, payload)); return readFrame(); }
const le = (b, o, v) => b.writeUInt32LE(v >>> 0, o);

const jpeg = await sharp({ create: { width: 1184, height: 1752, channels: 3, background: '#c04060' } }).jpeg({ quality: 90 }).toBuffer();
console.log('JPEG', jpeg.length, 'bytes');

// negotiate max write size (33792) like the app
{
  const set = Buffer.from([67, 80, 78, 80, 1, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0x84, 0]);
  set[10] = (sessionId >> 8) & 0xff; set[11] = sessionId & 0xff;
  await write(set); const r = await readFrame();
  console.log('SetMaxWriteSize result', r.result);
}
const MAXW = 33792;

let last = null;
for (let i = 0; i < 200; i++) {
  const st = (await cmd(0x20)).body;
  const state = st.length > 0x12 ? st[0x12] : -1;
  const off = st.readUInt32LE(0x18), length = st.readUInt32LE(0x1c);
  // Only dedup-wait on state 0 (idle). For data states, keep responding.
  if (state === 0 && last && Buffer.compare(last, st) === 0) { await sleep(200); continue; }
  last = Buffer.from(st);
  console.log(`state=${state} off=${off} len=${length} status: ${H(st, 40)}`);

  if (state === 0x00) { await sleep(400); }
  else if (state === 0x01) {
    const b = Buffer.alloc(0x40); le(b, 0x04, 0x40); le(b, 0x0c, 1); le(b, 0x12, border ? 3 : 2);
    const r = await cmd(0x21, b); console.log('  → flags result', r.result, 'ack', H(r.body));
  } else if (state === 0x02) {
    // neo: satisfy the requested [off,len] range with 104-header transfers,
    // each carrying <= (MAXW-104) bytes of JPEG at its partial offset.
    const total = Math.min(length, jpeg.length - off);
    let done = 0, ok = true;
    while (done < total) {
      const poff = off + done;
      const n = Math.min(MAXW - 104, total - done);
      const part = jpeg.subarray(poff, poff + n);
      const h = Buffer.alloc(104);
      le(h, 0x02, 1); le(h, 0x04, 104 + part.length); le(h, 0x0c, 1); le(h, 0x0e, 4);
      le(h, 0x10, 1); le(h, 0x14, jpeg.length); le(h, 0x18, 1184); le(h, 0x1c, 1752);
      le(h, 0x60, poff); le(h, 0x64, part.length);
      const r = await cmd(0x21, Buffer.concat([h, part]));
      if (r.result !== 0) { console.log(`  chunk off=${poff} n=${n} REJECT result=0x${r.result.toString(16)}`); ok = false; break; }
      done += n;
    }
    console.log(`  → satisfied off=${off} len=${total} sent=${done} ${ok ? 'OK' : 'FAIL'}`);
  } else if (state === 0x03) {
    const b = Buffer.alloc(0x40); le(b, 0x04, 0x40); b[2] = 0x03;
    const r = await cmd(0x21, b); console.log('  → DONE result', r.result); break;
  } else if (state === 0x04) { console.log('  PRINTER ERROR (expected: no paper?)'); break; }
  else { await sleep(300); }
}

sock.destroy();
try { const e = Buffer.from([67, 80, 78, 80, 1, 0x11, 0, 0, 0, 9, 0, 0, 0, 0, 0, 0]); e[10] = (sessionId >> 8) & 0xff; e[11] = sessionId & 0xff; await udp(e, 0x11, 1500); } catch {}
console.log('done');
process.exit(0);
