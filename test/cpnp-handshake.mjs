/* Paper-free CPNP handshake validation against a real printer.
   Exercises everything EXCEPT the spool print: discovery, TCP connect,
   UDP sessionStart, TCP SetMaxWriteSize, UDP sessionEnd.
   Usage: node test/cpnp-handshake.mjs <printer-ip> */
import dgram from 'node:dgram';
import net from 'node:net';

const host = process.argv[2] || '192.168.1.240';
const PORT = 8609;
const MAGIC = Buffer.from('CPNP', 'ascii');

function hex(b, n = 24) {
  return [...b.subarray(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

function udp(host, packet, expectOp, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { s.close(); } catch {} reject(new Error('timeout')); }, timeoutMs);
    s.on('message', (m) => {
      if (m.subarray(0, 4).equals(MAGIC) && m[4] === 0x81 && (expectOp == null || m[5] === expectOp)) {
        clearTimeout(t); try { s.close(); } catch {} resolve(m);
      }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
    s.bind(() => s.send(packet, PORT, host, (e) => e && reject(e)));
  });
}

// 1. discovery
const disc = Buffer.from([67, 80, 78, 80, 1, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
const dr = await udp(host, disc, 0x30);
console.log('✓ discovery reply, opcode 0x' + dr[5].toString(16));
console.log('  device-id:', dr.subarray(16).toString('latin1').replace(/\0+$/, '').slice(0, 70));

// 2. sessionStart (UDP, 408 bytes) — MUST precede TCP; it opens the listener
const ss = Buffer.alloc(408);
Buffer.from([67, 80, 78, 80, 1, 0x10, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0x88, 0, 0, 0, 0, 0, 0, 0, 0]).copy(ss);
Buffer.from('selphy-print', 'utf16le').swap16().copy(ss, 24, 0, 64);
Buffer.from([0, 83, 0, 80, 0, 76, 0, 32, 0, 118, 0, 50, 0, 46, 0, 48]).copy(ss, 88);
Buffer.from([0, 83, 0, 113, 0, 117, 0, 97, 0, 114, 0, 101]).copy(ss, 152);
let tcpPort = 0, sessionId = 0;
try {
  const sr = await udp(host, ss, 0x10);
  const result = (sr[6] << 8) | sr[7];
  sessionId = (sr[10] << 8) | sr[11]; // bytes 10-11
  tcpPort = (sr[20] << 8) | sr[21]; // bytes 20-21 → dynamic data port
  console.log(`✓ sessionStart reply, result=${result} ${result === 0 ? '(OK)' : '(nonzero!)'}`);
  console.log(`  sessionId=${sessionId}, dynamic TCP port=${tcpPort}`);
  console.log('  hex:', hex(sr));
} catch (e) {
  console.log('✗ sessionStart:', e.message);
  process.exit(1);
}

// 3. TCP connect to the DYNAMIC port from the reply
let sock = null;
for (let attempt = 1; attempt <= 8 && !sock; attempt++) {
  try {
    sock = await new Promise((res, rej) => {
      const s = net.connect({ host, port: tcpPort }, () => res(s));
      s.once('error', rej);
      s.setTimeout(8000, () => rej(new Error('tcp connect timeout')));
    });
  } catch (e) {
    console.log(`  tcp attempt ${attempt} to :${tcpPort}: ${e.code || e.message}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
if (!sock) { console.log('✗ TCP never opened on port ' + tcpPort); process.exit(1); }
console.log('✓ TCP connected to', host + ':' + tcpPort);

let rbuf = Buffer.alloc(0);
sock.on('data', (d) => (rbuf = Buffer.concat([rbuf, d])));
const readN = (n, ms = 4000) => new Promise((res, rej) => {
  const started = Date.now();
  const iv = setInterval(() => {
    if (rbuf.length >= n) { clearInterval(iv); const o = rbuf.subarray(0, n); rbuf = rbuf.subarray(n); res(o); }
    else if (Date.now() - started > ms) { clearInterval(iv); rej(new Error('tcp read timeout')); }
  }, 20);
});

// 4. SetMaxWriteSize (TCP) — sessionId at bytes 10-11
try {
  const set = Buffer.from([67, 80, 78, 80, 1, 0x52, 0, 0, 0, 2, 0, 0, 0, 0, 0, 4, 0, 0, 0x84, 0]);
  set[10] = (sessionId >> 8) & 0xff;
  set[11] = sessionId & 0xff;
  sock.write(set);
  const head = await readN(16);
  const len = (head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15];
  const result = (head[6] << 8) | head[7];
  if (len > 0) await readN(len);
  console.log(`✓ SetMaxWriteSize reply, opcode 0x${head[5].toString(16)}, result=${result}, bodylen=${len}`);
  console.log('  hex:', hex(head));
} catch (e) {
  console.log('✗ SetMaxWriteSize:', e.message);
}

// 5. sessionEnd (UDP)
try {
  const se = Buffer.from([67, 80, 78, 80, 1, 0x11, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0]);
  const ser = await udp(host, se, 0x11, 2000);
  console.log('✓ sessionEnd reply, result=' + ((ser[6] << 8) | ser[7]));
} catch (e) {
  console.log('~ sessionEnd:', e.message, '(non-fatal)');
}

sock.destroy();
console.log('\nHandshake probe complete — NO paper used.');
process.exit(0);
