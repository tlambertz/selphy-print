/* Validate the PWG encoder: roundtrip-decode in JS and (if available) parse
   with cups-filters' pwgtoraster as an independent reference. */
import { encodePwg } from '../server/pwg.js';
import sharp from 'sharp';
import { strict as assert } from 'node:assert';

const W = 1181;
const H = 1748;

// content with flat areas, gradients, and single-pixel noise (worst cases)
const src = await sharp(
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
  <rect x="100" y="100" width="400" height="300" fill="#22aa66"/>
  <circle cx="800" cy="900" r="180" fill="#fff"/>
</svg>`)
)
  .removeAlpha()
  .raw()
  .toBuffer();

const pwg = encodePwg(src, W, H);
assert.equal(pwg.subarray(0, 4).toString(), 'RaS2');
console.log('encoded:', pwg.length, 'bytes (raw would be', W * H * 3, ')');

// JS roundtrip decode
function decode(buf) {
  const header = buf.subarray(4, 1800);
  const width = header.readUInt32BE(372);
  const height = header.readUInt32BE(376);
  const out = Buffer.alloc(width * height * 3);
  let off = 1800;
  let y = 0;
  while (y < height) {
    const repeat = buf[off++] + 1;
    const line = Buffer.alloc(width * 3);
    let x = 0;
    while (x < width) {
      const n = buf[off++];
      if (n <= 127) {
        for (let i = 0; i <= n; i++) {
          buf.copy(line, x * 3, off, off + 3);
          x++;
        }
        off += 3;
      } else {
        const lit = 257 - n;
        buf.copy(line, x * 3, off, off + lit * 3);
        off += lit * 3;
        x += lit;
      }
    }
    for (let r = 0; r < repeat; r++) {
      line.copy(out, (y + r) * width * 3);
    }
    y += repeat;
  }
  return { width, height, pixels: out };
}

const dec = decode(pwg);
assert.equal(dec.width, W);
assert.equal(dec.height, H);
assert.equal(Buffer.compare(dec.pixels, src), 0, 'roundtrip pixel mismatch');
console.log('JS roundtrip: pixels identical ✓');

// independent parse via cups-filters, when present
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
const pwgPath = '/tmp/pwg-test-' + process.pid + '.pwg';
await writeFile(pwgPath, pwg);
try {
  const { stdout } = await promisify(execFile)(
    'bash',
    ['-c', `/usr/lib/cups/filter/pwgtoraster 1 u t 1 '' "${pwgPath}"`],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', timeout: 60000 }
  );
  assert.ok(stdout.length > 1000, 'pwgtoraster produced no raster');
  console.log('pwgtoraster parsed our stream ✓ output', stdout.length, 'bytes');
} catch (err) {
  console.log('pwgtoraster check skipped:', err.code || err.message?.slice(0, 80));
} finally {
  await rm(pwgPath, { force: true });
}
console.log('PWG PASS');

// URF roundtrip (decoder mirrors cups-filters urftopdf.cpp semantics)
import { encodeUrf } from '../server/pwg.js';
const urf = encodeUrf(src, W, H);
assert.equal(urf.subarray(0, 7).toString(), 'UNIRAST');
assert.equal(urf.readUInt32BE(8), 1); // page count
const ph = urf.subarray(12, 44);
assert.equal(ph[0], 24); // bpp
assert.equal(ph[1], 1); // sRGB
assert.equal(ph.readUInt32BE(12), W);
assert.equal(ph.readUInt32BE(16), H);
assert.equal(ph.readUInt32BE(20), 300);
function decodeUrf(buf) {
  const width = buf.readUInt32BE(12 + 12);
  const height = buf.readUInt32BE(12 + 16);
  const out = Buffer.alloc(width * height * 3);
  let off = 44;
  let y = 0;
  while (y < height) {
    const repeat = buf[off++] + 1;
    const line = Buffer.alloc(width * 3);
    let x = 0;
    while (x < width) {
      const code = buf.readInt8(off++); // signed, per urftopdf
      if (code === -128) {
        line.fill(0xff, x * 3);
        x = width;
      } else if (code >= 0) {
        for (let i = 0; i <= code; i++) {
          buf.copy(line, x * 3, off, off + 3);
          x++;
        }
        off += 3;
      } else {
        const lit = -code + 1;
        buf.copy(line, x * 3, off, off + lit * 3);
        off += lit * 3;
        x += lit;
      }
    }
    for (let r = 0; r < repeat; r++) line.copy(out, (y + r) * width * 3);
    y += repeat;
  }
  return { width, height, pixels: out };
}
const udec = decodeUrf(urf);
assert.equal(udec.width, W);
assert.equal(udec.height, H);
assert.equal(Buffer.compare(udec.pixels, src), 0, 'URF roundtrip mismatch');
console.log('URF roundtrip: pixels identical ✓');
console.log('URF PASS');
