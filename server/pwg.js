/* Minimal PWG raster encoder (PWG 5102.4) — enough for one sRGB 8-bit page
   at 300 dpi, which is all the SELPHY accepts (pwg-raster-document-type-
   supported: rgb_8, 300dpi). Header field offsets verified against a
   cupsfilter-generated reference. */

const HEADER_SIZE = 1796;

function cstr(buf, off, s) {
  buf.write(s, off, 63, 'ascii');
}

/**
 * @param {Buffer} rgb  raw RGB pixel data, 3 bytes/px, row-major
 * @param {number} width px
 * @param {number} height px
 * @param {number} dpi
 * @returns {Buffer} complete PWG raster stream (single page)
 */
export function encodePwg(rgb, width, height, dpi = 300) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`pixel buffer ${rgb.length} != ${width}x${height}x3`);
  }
  const header = Buffer.alloc(HEADER_SIZE);
  cstr(header, 0, 'PwgRaster'); // MediaClass per spec
  cstr(header, 128, 'photographic'); // MediaType (matches media-type-supported)
  const ptsW = Math.round((width / dpi) * 72);
  const ptsH = Math.round((height / dpi) * 72);
  header.writeUInt32BE(dpi, 276); // HWResolution x
  header.writeUInt32BE(dpi, 280); // HWResolution y
  // CUPS floors the bounding box and rounds PageSize; match it exactly.
  header.writeUInt32BE(Math.floor((width / dpi) * 72), 292); // ImagingBBox right
  header.writeUInt32BE(Math.floor((height / dpi) * 72), 296); // ImagingBBox bottom
  header.writeUInt32BE(1, 340); // NumCopies
  header.writeUInt32BE(ptsW, 352); // PageSize width (pts)
  header.writeUInt32BE(ptsH, 356); // PageSize height (pts)
  header.writeUInt32BE(width, 372); // cupsWidth
  header.writeUInt32BE(height, 376); // cupsHeight
  header.writeUInt32BE(8, 384); // cupsBitsPerColor
  header.writeUInt32BE(24, 388); // cupsBitsPerPixel
  header.writeUInt32BE(width * 3, 392); // cupsBytesPerLine
  header.writeUInt32BE(0, 396); // cupsColorOrder = chunked
  header.writeUInt32BE(1, 400); // cupsColorSpace = RGB (rgb_8)
  header.writeUInt32BE(1, 420); // TotalPageCount

  const chunks = [Buffer.from('RaS2', 'ascii'), header];
  const bpl = width * 3;

  // PWG compression: <repeated-lines-1> then per-line runs:
  // control n in 0..127 → next pixel repeats n+1 times
  // control n in 129..255 → 257-n literal pixels follow
  let y = 0;
  while (y < height) {
    const line = rgb.subarray(y * bpl, (y + 1) * bpl);
    let repeat = 1;
    while (
      y + repeat < height &&
      repeat <= 255 &&
      line.compare(rgb, (y + repeat) * bpl, (y + repeat + 1) * bpl) === 0
    ) {
      repeat++;
    }
    if (repeat > 256) repeat = 256;
    chunks.push(Buffer.from([repeat - 1]));
    chunks.push(compressLine(line, width));
    y += repeat;
  }
  return Buffer.concat(chunks);
}

function compressLine(line, width) {
  const out = [];
  let x = 0;
  while (x < width) {
    // count run of identical pixels
    let run = 1;
    while (
      x + run < width &&
      run < 128 &&
      line[(x + run) * 3] === line[x * 3] &&
      line[(x + run) * 3 + 1] === line[x * 3 + 1] &&
      line[(x + run) * 3 + 2] === line[x * 3 + 2]
    ) {
      run++;
    }
    if (run > 1) {
      out.push(run - 1, line[x * 3], line[x * 3 + 1], line[x * 3 + 2]);
      x += run;
      continue;
    }
    // literal run: collect pixels until the next repeat of length >= 2
    let lit = 1;
    while (
      x + lit < width &&
      lit < 128 &&
      !(
        x + lit + 1 < width &&
        line[(x + lit) * 3] === line[(x + lit + 1) * 3] &&
        line[(x + lit) * 3 + 1] === line[(x + lit + 1) * 3 + 1] &&
        line[(x + lit) * 3 + 2] === line[(x + lit + 1) * 3 + 2]
      )
    ) {
      lit++;
    }
    out.push(257 - lit);
    for (let i = 0; i < lit; i++) {
      out.push(line[(x + i) * 3], line[(x + i) * 3 + 1], line[(x + i) * 3 + 2]);
    }
    x += lit;
  }
  return Buffer.from(out);
}
