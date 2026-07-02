/* Canon CPNP transport for SELPHY CP-series (CP1500 = gen2CP).
   Reverse-engineered from SELPHY Photo Layout 4.3.10 — see
   docs/cpnp-protocol.md. This is the path Canon's own app uses, and the only
   one that carries the borderless flag the firmware honours.

   Outer CPNP framing is big-endian; inner command/spool payload fields are
   little-endian. Session control (start/end) is UDP; buffer-size negotiation
   and bulk JPEG data are TCP. Both on port 8609. */

import dgram from 'node:dgram';
import net from 'node:net';

const PORT = 8609;
const MAGIC = Buffer.from('CPNP', 'ascii'); // 43 50 4E 50

// opcodes (byte 5)
const OP = {
  deviceId: 0x30,
  sessionStart: 0x10,
  sessionEnd: 0x11,
  write: 0x21,
  getMaxWriteSize: 0x51,
  setMaxWriteSize: 0x52,
};

// inner command codes (little-endian @2)
const CODE = {
  printDataTransfer: 1,
  cancelPrint: 2,
  endPrint: 3,
  startSpool: 7,
  executeSpoolPrint: 8,
};

// DataRequest values the printer reports in its status (little-endian @16)
const REQ = {
  NON: 0,
  START_PRINT: 0x10000,
  PRINT_DATA: 0x20000,
  END_PRINT: 0x30000,
  CANCEL_PRINT: 0x40000,
  EXECUTE_SPOOL_PRINT: 0x70000,
};

const CP_POST_SIZE = 4; // printSize @14
const BORDER_BORDERLESS = 2; // start-spool @18
const MAX_CHUNK = 33792; // 0x8400, from SetMaxWriteSize

// UTF-16BE "SPL v2.0" and "Square" — the app's fixed session strings.
const SESSION_USER = Buffer.from([0, 83, 0, 80, 0, 76, 0, 32, 0, 118, 0, 50, 0, 46, 0, 48]);
const SESSION_DOC = Buffer.from([0, 83, 0, 113, 0, 117, 0, 97, 0, 114, 0, 101]);

function le(buf, off, len, val) {
  for (let i = 0; i < len; i++) buf[off + i] = (val >>> (i * 8)) & 0xff;
}
function beResult(buf) {
  return (buf[6] << 8) | buf[7]; // reply result code @6-7 (big-endian)
}

let packetId = 0;
function nextPacketId() {
  packetId = packetId >= 0xffff ? 1 : packetId + 1;
  return packetId;
}
function setPacketId(buf, id) {
  buf[8] = (id >> 8) & 0xff;
  buf[9] = id & 0xff;
}

/* ---------- UDP control ---------- */

function udpExchange(host, packet, { expectOpcode, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('CPNP UDP timeout')), timeoutMs);
    sock.on('message', (msg) => {
      if (msg.length >= 6 && msg.subarray(0, 4).equals(MAGIC) && msg[4] === 0x81 &&
          (expectOpcode == null || msg[5] === expectOpcode)) {
        clearTimeout(timer);
        finish(null, msg);
      }
    });
    sock.on('error', (e) => { clearTimeout(timer); finish(e); });
    sock.bind(() => sock.send(packet, PORT, host, (e) => e && (clearTimeout(timer), finish(e))));
  });
}

export async function discover(host) {
  const pkt = Buffer.from([67, 80, 78, 80, 1, 0x30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
  const reply = await udpExchange(host, pkt, { expectOpcode: OP.deviceId });
  // device-ID string follows the 16-byte header
  return reply.subarray(16).toString('latin1').replace(/\0+$/, '');
}

// Poll the printer status over TCP (opcode 0x20 with sessionId). The reply
// payload's byte 0x12 is the print "state" (selphy_go), and bytes 0x18/0x1c
// carry the requested data offset/length; byte 0x08 is an error/cassette code.
async function readStatus(conn, sessionId) {
  const pkt = Buffer.from([67, 80, 78, 80, 1, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  setPacketId(pkt, nextPacketId());
  setSession(pkt, sessionId);
  await conn.write(pkt);
  const { body } = await readFrame(conn);
  const u32 = (o) => (o + 4 <= body.length ? body.readUInt32LE(o) : 0);
  return {
    state: body.length > 0x12 ? body[0x12] : -1,
    statusCode: body.length > 8 ? body[8] : 0, // 0x0c = no cassette
    offset: u32(0x18),
    length: u32(0x1c),
    raw: body,
  };
}

// Returns { sessionId, tcpPort } — the printer allocates a per-session data
// port (reply bytes 20-21) and a session id (bytes 10-11).
async function sessionStart(host) {
  const buf = Buffer.alloc(408);
  // 24-byte base; payload length 0x0188 (=392) big-endian at bytes 14-15.
  const base = [67, 80, 78, 80, 1, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x88, 0, 0, 0, 0, 0, 0, 0, 0];
  Buffer.from(base).copy(buf, 0);
  setPacketId(buf, nextPacketId());
  const name = Buffer.from('selphy-print', 'utf16le').swap16(); // UTF-16BE
  name.copy(buf, 24, 0, Math.min(name.length, 64));
  SESSION_USER.copy(buf, 88);
  SESSION_DOC.copy(buf, 152);
  const reply = await udpExchange(host, buf, { expectOpcode: OP.sessionStart });
  const result = beResult(reply);
  if (result !== 0) throw new Error(`CPNP sessionStart failed: result ${result}`);
  const sessionId = (reply[10] << 8) | reply[11];
  const tcpPort = (reply[20] << 8) | reply[21];
  if (!sessionId || !tcpPort) throw new Error('CPNP sessionStart: no session/port in reply');
  return { sessionId, tcpPort };
}

async function sessionEnd(host, sessionId) {
  const buf = Buffer.from([67, 80, 78, 80, 1, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  setPacketId(buf, nextPacketId());
  if (sessionId) { buf[10] = (sessionId >> 8) & 0xff; buf[11] = sessionId & 0xff; }
  try {
    await udpExchange(host, buf, { expectOpcode: OP.sessionEnd, timeoutMs: 2000 });
  } catch {
    /* best-effort */
  }
}

/* ---------- TCP data ---------- */

class TcpConn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._pump();
    });
  }
  _pump() {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (this.buf.length >= w.n) {
        const out = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        this.waiters.splice(i, 1);
        w.resolve(out);
      }
    }
  }
  write(data) {
    return new Promise((res, rej) => this.sock.write(data, (e) => (e ? rej(e) : res())));
  }
  read(n, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const w = { n, resolve };
      const t = setTimeout(() => {
        const idx = this.waiters.indexOf(w);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('CPNP TCP read timeout'));
      }, timeoutMs);
      w.resolve = (v) => { clearTimeout(t); resolve(v); };
      this.waiters.push(w);
      this._pump();
    });
  }
  close() { try { this.sock.destroy(); } catch {} }
}

function tcpConnect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => resolve(new TcpConn(sock)));
    sock.once('error', reject);
    sock.setTimeout(15000);
  });
}

// Read one CPNP reply frame from TCP (16-byte header + payload len @12-15 BE).
async function readFrame(conn) {
  const head = await conn.read(16);
  const len = (head[12] << 24) | (head[13] << 16) | (head[14] << 8) | head[15];
  const body = len > 0 ? await conn.read(len) : Buffer.alloc(0);
  return { head, body, result: beResult(head) };
}

function setSession(buf, sessionId) {
  buf[10] = (sessionId >> 8) & 0xff;
  buf[11] = sessionId & 0xff;
}

async function negotiateMaxWriteSize(conn, sessionId) {
  const set = Buffer.from([67, 80, 78, 80, 1, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0x84, 0]);
  setPacketId(set, nextPacketId());
  setSession(set, sessionId);
  await conn.write(set);
  const reply = await readFrame(conn);
  if (reply.result !== 0) throw new Error(`SetMaxWriteSize failed: ${reply.result}`);
}

// Wrap a command payload in CPNP write frames (opcode 0x21) over TCP,
// splitting into <= MAX_CHUNK pieces. Every frame carries sessionId@10-11
// and its piece length (big-endian) @12-15. Returns the last frame's result.
async function writeData(conn, sessionId, payload) {
  let lastResult = 0;
  for (let off = 0; off < payload.length; off += MAX_CHUNK) {
    const piece = payload.subarray(off, Math.min(off + MAX_CHUNK, payload.length));
    const head = Buffer.from([67, 80, 78, 80, 1, 0x21, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    setPacketId(head, nextPacketId());
    setSession(head, sessionId);
    head[12] = (piece.length >>> 24) & 0xff;
    head[13] = (piece.length >>> 16) & 0xff;
    head[14] = (piece.length >>> 8) & 0xff;
    head[15] = piece.length & 0xff;
    await conn.write(Buffer.concat([head, piece]));
    const reply = await readFrame(conn);
    lastResult = reply.result;
    if (reply.result !== 0) throw new Error(`write frame rejected: result ${reply.result}`);
  }
  return lastResult;
}

/* ---------- payload builders (little-endian inner fields) ---------- */

function makeStartSpool(jpegSize, { typePrint = 0, typeJpeg = 0 } = {}) {
  const b = Buffer.alloc(192);
  le(b, 0, 2, typePrint); // commandType
  le(b, 2, 2, CODE.startSpool); // code = 7
  le(b, 4, 4, 192); // commandDataSize
  le(b, 8, 4, typeJpeg); // printDataType
  le(b, 12, 2, 1); // totalJpegImages
  le(b, 14, 2, CP_POST_SIZE); // printSize = 4
  le(b, 16, 1, 1); // overcoatSetting (each page)
  le(b, 17, 1, 0); // imageOptimize
  le(b, 18, 1, BORDER_BORDERLESS); // borderSetting = 2  ← borderless
  le(b, 19, 1, 0); // printFinish
  le(b, 32, 4, jpegSize); // JPEG file size for image 0
  return b;
}

function makeTransferHeader(chunk, offset, total, w, h, jpegSize, opts = {}) {
  const { typePrint = 0, typeJpeg = 0 } = opts;
  const b = Buffer.alloc(104);
  le(b, 0, 2, typePrint);
  le(b, 2, 2, CODE.printDataTransfer); // code = 1
  le(b, 4, 4, 104 + chunk.length); // commandDataSize
  le(b, 8, 4, typeJpeg); // printDataType
  le(b, 12, 2, 1); // totalJpegImages
  le(b, 14, 2, CP_POST_SIZE); // printSize
  le(b, 16, 4, 1); // jpegImageNo
  le(b, 20, 4, jpegSize); // jpegDataSize (whole image)
  le(b, 24, 4, w); // jpegWidth
  le(b, 28, 4, h); // jpegHeight
  le(b, 32, 1, 0); // overcoatSetting
  le(b, 96, 4, offset); // partialJpegOffset
  le(b, 100, 4, chunk.length); // partialJpegSize
  return b;
}

function makeSimple(code, { typePrint = 0 } = {}) {
  const b = Buffer.alloc(104);
  le(b, 0, 2, typePrint);
  le(b, 2, 2, code);
  le(b, 4, 4, 104);
  return b;
}

/* ---------- public API ---------- */

/**
 * Print a JPEG borderless to a SELPHY CP1500 via CPNP.
 * @param {string} host printer IP
 * @param {Buffer} jpeg the image (rendered at ~1752×1184 for postcard)
 * @param {object} opts { width, height, typePrint, typeJpeg, onState }
 */
export async function cpnpPrint(host, jpeg, opts = {}) {
  const { width = 1184, height = 1752, border = false, onState = () => {}, log = () => {} } = opts;

  onState('session');
  const { sessionId, tcpPort } = await sessionStart(host);
  onState('connecting');
  let conn = null;
  for (let a = 0; a < 12 && !conn; a++) {
    try { conn = await tcpConnect(host, tcpPort); } catch { await sleep(300); }
  }
  if (!conn) throw new Error('CPNP: printer did not open its data port');

  try {
    await negotiateMaxWriteSize(conn, sessionId);
    const deadline = Date.now() + 180000;
    let transferred = false;
    let lastKey = '';
    let sameCount = 0;

    while (Date.now() < deadline) {
      let st;
      try { st = await readStatus(conn, sessionId); } catch { await sleep(150); continue; }

      // Cassette / error at byte 8 (0x0c = no paper cassette).
      if (st.statusCode === 0x0c) throw new Error('no paper cassette in printer');
      if (st.statusCode && st.statusCode !== 0x01 && st.statusCode !== 0x0f) {
        throw new Error('printer error 0x' + st.statusCode.toString(16));
      }

      const key = `${st.state}:${st.offset}:${st.length}`;
      sameCount = key === lastKey ? sameCount + 1 : 0;
      lastKey = key;

      if (st.state === 0x01) {
        onState('flags');
        await writeData(conn, sessionId, makeFlags(border));
      } else if (st.state === 0x02) {
        onState('data');
        // Serve get_chunk(offset,length) like selphy_go: ONE 104-byte header
        // declaring the whole requested length, followed by that many bytes
        // (zero-padded past EOF), streamed across frames by writeData.
        const off = st.offset;
        let length = st.length;
        // sanitise a garbage/huge length request
        if (!(length > 0) || length > jpeg.length) length = Math.max(0, jpeg.length - off);
        await writeData(conn, sessionId, makeTransfer(jpeg, off, length, width, height));
        if (off + length >= jpeg.length || off >= jpeg.length) transferred = true;
        if (off >= jpeg.length && sameCount > 3) break; // done reading
        log(`sent off=${off} len=${length}`);
      } else if (st.state === 0x03) {
        const done = Buffer.alloc(0x40);
        done.writeUInt32LE(0x40, 0x04);
        done[2] = 0x03;
        await writeData(conn, sessionId, done).catch(() => {});
        break;
      } else if (st.state === 0x04) {
        throw new Error('printer reported error state');
      } else {
        // idle/processing: once the whole image is in, the printer prints.
        if (transferred && sameCount > 4) break;
        await sleep(300);
      }
    }
    onState('printing');
  } finally {
    conn.close();
    await sessionEnd(host, sessionId);
  }
  onState('done');
  return { printed: true };
}

// Job-flags packet (64B): length@4, marker@0x0c=1, border@0x12 (2=borderless,
// 3=bordered). Sent in state 1.
function makeFlags(border) {
  const b = Buffer.alloc(0x40);
  b.writeUInt32LE(0x40, 0x04);
  b.writeUInt32LE(1, 0x0c);
  b.writeUInt32LE(border ? 3 : 2, 0x12);
  return b;
}

// selphy_go get_chunk(offset,length): a single 0x68 (104) byte header
// declaring the whole requested length, then `length` bytes of the file at
// `offset` (zero-padded past EOF). writeData streams header+data over frames.
function makeTransfer(jpeg, off, length, width, height) {
  const h = Buffer.alloc(0x68);
  h.writeUInt32LE(1, 0x02); // commandCode
  h.writeUInt32LE(length + 0x68, 0x04); // total data size
  h.writeUInt32LE(1, 0x0c);
  h.writeUInt32LE(jpeg.length, 0x14); // whole file size
  h.writeUInt32LE(width, 0x18);
  h.writeUInt32LE(height, 0x1c);
  h.writeUInt32LE(off, 0x60); // partial offset
  h.writeUInt32LE(length, 0x64); // partial length (whole request)
  const data = Buffer.alloc(length); // zero-padded
  if (off < jpeg.length) jpeg.copy(data, 0, off, Math.min(off + length, jpeg.length));
  return Buffer.concat([h, data]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
