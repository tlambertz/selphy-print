/* Minimal PWG (PWG 5102.4) and URF/UNIRAST raster encoders — one sRGB 8-bit
   page at 300 dpi, which is all the SELPHY accepts. PWG header field offsets
   verified against a cupsfilter-generated reference; URF layout taken from
   cups-filters 1.x urftopdf.cpp. Both formats share the same line-repeat +
   packbits-style compression. */

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
  header.writeUInt32BE(19, 400); // cupsColorSpace = sRGB (PWG srgb_8)
  header.writeUInt32BE(3, 420); // cupsNumColors (3 for RGB — cups-filters
  // reads ZERO pages if this is wrong; it was long mis-set to 1, mislabeled
  // as TotalPageCount, which really lives in cupsInteger[0]:)
  header.writeUInt32BE(1, 452); // TotalPageCount (PWG 5102.4 cupsInteger[0])

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

/**
 * URF/UNIRAST — the AirPrint raster format, and the CP1500's
 * document-format-preferred. urf-supported: W8,SRGB24,RS300,PQ4.
 */
export function encodeUrf(rgb, width, height, dpi = 300, opts = {}) {
  if (rgb.length !== width * height * 3) {
    throw new Error(`pixel buffer ${rgb.length} != ${width}x${height}x3`);
  }
  const fileHeader = Buffer.alloc(12);
  fileHeader.write('UNIRAST', 0, 'ascii'); // byte 7 stays \0
  fileHeader.writeUInt32BE(1, 8); // page count

  // 32-byte page header (cups-filters urftopdf.cpp struct urf_page_header):
  // u8 bpp, u8 colorspace, u8 duplex, u8 quality, u32 unknown0, u32 unknown1,
  // u32 width, u32 height, u32 dot_per_inch, u32 unknown2, u32 unknown3.
  const page = Buffer.alloc(32);
  page.writeUInt8(24, 0); // bpp
  page.writeUInt8(1, 1); // colorspace: sRGB
  page.writeUInt8(opts.duplex ?? 1, 2); // 1 = simplex
  page.writeUInt8(opts.quality ?? 4, 3); // PQ4 = normal
  page.writeUInt32BE(opts.mediaType ?? 0, 4); // "unknown0" (mediaType?)
  page.writeUInt32BE(opts.inputSlot ?? 0, 8); // "unknown1" (inputSlot?)
  page.writeUInt32BE(width, 12);
  page.writeUInt32BE(height, 16);
  page.writeUInt32BE(dpi, 20);
  // unknown2 (24), unknown3 (28) stay 0

  const chunks = [fileHeader, page];
  const bpl = width * 3;
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
