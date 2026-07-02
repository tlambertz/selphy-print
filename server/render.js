/* Image pipeline: EXIF-orient → user rotate → crop → resize to the exact
   print raster → ICC-convert into the printer profile on lossless pixels
   (lcms2 tificc) → single baseline 4:4:4 untagged JPEG encode → ready to send
   as-is over IPP/CPNP. (ICC is never applied with jpgicc: it re-encodes at
   4:2:0 with no way to stop it, discarding chroma the head can't recover.)

   Geometry: the JPEG is rendered at exactly the destination raster size
   (IPP page for borderless, printable area for bordered) and submitted with
   print-scaling=none, so the printer images it 1:1 with no scaling decisions.
   The only remaining transform is the firmware's borderless enlargement,
   which the client-side safe-area guide accounts for.

   Color: the SELPHY has a fixed internal color pipeline that cannot be
   disabled, so usable profiles characterize the *whole* path (sRGB-in →
   print). Converting into the profile and sending the result untagged
   pre-compensates correctly. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const execFileP = promisify(execFile);

// The SELPHY head runs its own fixed color pipeline over an untagged, ~300 dpi
// RGB JPEG. So every JPEG we hand it is encoded ONCE, here, with settings the
// firmware can't improve on and we don't want to lose:
//  - baseline (progressive:false): the firmware's decoder is a black box;
//    baseline is the safe, universally-decodable path.
//  - 4:4:4 chroma (no subsampling): never throw away color resolution before
//    the head's own processing — it can't recover what we drop.
//  - untagged: NO embedded ICC (sharp's withMetadata would inject sRGB and
//    risk a double-convert); ICC is pre-applied into the pixels via tificc.
//  - 300 dpi JFIF density: cosmetic (the firmware scales by pixel count and
//    ignores this) but correct for any other viewer of the same bytes.
async function encodeJpeg(pipeline, quality = 95) {
  const jpeg = await pipeline
    .jpeg({ quality, chromaSubsampling: '4:4:4', progressive: false })
    .toBuffer();
  return setJfifDensity(jpeg, 300);
}

// sharp emits no JFIF APP0 segment, so there is nothing to patch — insert one
// right after SOI declaring the density (units=1 → dpi). Idempotent-ish: only
// inserts when APP0 is absent, which it always is from sharp.
function setJfifDensity(jpeg, dpi) {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg; // not a JPEG; leave it
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) return jpeg; // already has APP0
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, // APP0 marker, length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.01
    0x01, // units: dots per inch
    (dpi >> 8) & 0xff, dpi & 0xff, // X density
    (dpi >> 8) & 0xff, dpi & 0xff, // Y density
    0x00, 0x00, // no thumbnail
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);
}

/**
 * @param {Buffer} input source image (any sharp-decodable format)
 * @param {object} opts
 *   crop   {x,y,w,h} as 0..1 fractions of the EXIF-oriented, user-rotated image
 *   rotate 0|90|180|270 user rotation on top of EXIF orientation
 *   target {w,h} destination raster in px, landscape (e.g. 1748×1181 postcard page)
 *   bleed  {top,bottom,left,right} px of the target that the printer's
 *          borderless enlargement will trim (from calibration). The crop is
 *          rendered into the surviving window and the bleed zone is filled
 *          with mirrored edge content, so the framed image = the paper.
 *   icc    { profile: path|null, intent: 'perceptual'|'relative', quality }
 * @returns {Promise<Buffer>} portrait (short-edge-first) JPEG at target size
 */
export async function renderForPrint(input, opts) {
  const { crop, rotate = 0, target, icc = {} } = opts;
  const bleed = { top: 0, bottom: 0, left: 0, right: 0, ...(opts.bleed || {}) };
  const inner = {
    w: target.w - bleed.left - bleed.right,
    h: target.h - bleed.top - bleed.bottom,
  };
  if (inner.w < 100 || inner.h < 100) throw new Error('bleed leaves no printable window');

  let img = sharp(input, { failOn: 'truncated' }).rotate(); // EXIF auto-orient
  if (rotate) img = img.rotate(rotate);

  // Resolve fractional crop against the oriented+rotated dimensions.
  const buf = await img.toBuffer();
  const meta = await sharp(buf).metadata();
  const region = crop
    ? {
        left: Math.round(crop.x * meta.width),
        top: Math.round(crop.y * meta.height),
        width: Math.round(crop.w * meta.width),
        height: Math.round(crop.h * meta.height),
      }
    : centerCover(meta.width, meta.height, inner.w / inner.h);
  region.left = Math.max(0, Math.min(region.left, meta.width - 1));
  region.top = Math.max(0, Math.min(region.top, meta.height - 1));
  region.width = Math.min(region.width, meta.width - region.left);
  region.height = Math.min(region.height, meta.height - region.top);

  // Bleed fill: use REAL image content beyond the crop where the source has
  // any (the photo genuinely continues over the tear line / paper edge),
  // mirror only at source boundaries. Under ±1 mm registration drift a
  // sliver of that continuation shows instead of white. White-border mode
  // keeps a plain white surround instead.
  // (Separate pass for the final rotate — sharp orders rotate before extend
  // within a single pipeline, which would put the bleed on the wrong edges.)
  const s = region.width / inner.w; // source px per target px
  const avail = {
    left: region.left,
    top: region.top,
    right: meta.width - region.left - region.width,
    bottom: meta.height - region.top - region.height,
  };
  const got = {}; // real-content bleed obtained, in target px
  for (const e of ['left', 'top', 'right', 'bottom']) {
    got[e] = opts.padWhite ? 0 : Math.min(bleed[e], Math.floor(avail[e] / s));
  }
  const srcExt = {
    left: Math.min(Math.round(got.left * s), avail.left),
    top: Math.min(Math.round(got.top * s), avail.top),
    right: Math.min(Math.round(got.right * s), avail.right),
    bottom: Math.min(Math.round(got.bottom * s), avail.bottom),
  };
  const page = await sharp(buf)
    .extract({
      left: region.left - srcExt.left,
      top: region.top - srcExt.top,
      width: region.width + srcExt.left + srcExt.right,
      height: region.height + srcExt.top + srcExt.bottom,
    })
    .resize(inner.w + got.left + got.right, inner.h + got.top + got.bottom, { fit: 'fill', kernel: 'lanczos3' })
    .extend({
      top: bleed.top - got.top,
      bottom: bleed.bottom - got.bottom,
      left: bleed.left - got.left,
      right: bleed.right - got.right,
      extendWith: opts.padWhite ? 'background' : 'mirror',
      background: '#ffffff',
    })
    .toBuffer();
  let portrait = sharp(page).rotate(90); // printer feeds portrait, short edge first

  if (opts.output === 'raw') {
    let tiff = await portrait.removeAlpha().tiff({ compression: 'none' }).toBuffer();
    if (icc.profile) tiff = await applyIccTiff(tiff, icc);
    const { data, info } = await sharp(tiff)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { rgb: data, width: info.width, height: info.height };
  }

  // No ICC: encode the final baseline 4:4:4 JPEG directly.
  if (!icc.profile) return encodeJpeg(portrait, icc.quality);
  // ICC: convert LOSSLESSLY on uncompressed pixels (tificc on a TIFF), then do
  // the single JPEG encode ourselves. Never route the final JPEG through
  // jpgicc — it re-encodes at libjpeg's default 4:2:0 and there is no flag to
  // stop it, so it would quietly halve chroma resolution.
  let tiff = await portrait.removeAlpha().tiff({ compression: 'none' }).toBuffer();
  tiff = await applyIccTiff(tiff, icc);
  return encodeJpeg(sharp(tiff), icc.quality);
}

function centerCover(w, h, aspect) {
  let cw = w;
  let ch = Math.round(cw / aspect);
  if (ch > h) {
    ch = h;
    cw = Math.round(ch * aspect);
  }
  return {
    left: Math.round((w - cw) / 2),
    top: Math.round((h - ch) / 2),
    width: cw,
    height: ch,
  };
}

const INTENTS = { perceptual: '0', relative: '1', saturation: '2', absolute: '3' };

// Lossless ICC conversion for the raster path (littleCMS tificc).
async function applyIccTiff(tiff, icc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'selphy-'));
  const inFile = path.join(dir, 'in.tif');
  const outFile = path.join(dir, 'out.tif');
  try {
    await writeFile(inFile, tiff);
    await execFileP('tificc', [
      '-t', INTENTS[icc.intent] ?? '0',
      '-b',
      '-o', icc.profile,
      inFile,
      outFile,
    ]);
    return await readFile(outFile);
  } catch (err) {
    throw new Error(`ICC conversion failed: ${err.stderr || err.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Calibration/diagnostic page, rendered at the printer's full head-canvas
    raster (1872×1248). Under the measured JPEG behavior (1:1 placement
    centered on the canvas), the rulers count true mm inward from the canvas
    edges, so the first tick visible on paper = per-edge trim directly. The
    50 mm reference bars expose any hidden scaling: if they don't measure
    50 mm on paper, the printer scaled the raster and the model is wrong. */
/**
 * @param {object} page landscape {w,h} px — the ruler content area (the paper)
 * @param {number} dpi
 * @param {string} output 'jpeg' | 'raw'
 * @param {object} pad landscape px of overscan bleed around the paper window
 *   ({ends, sides} — the structural canvas overhang). Drawn as a BLUE inked
 *   zone with its own outward-counting mm ticks: on a correct print it lands
 *   past the paper edges / tear lines (readable on the stubs), and if any of
 *   it shows on the photo area it is visibly blue — never ambiguous white.
 *   The rulers keep counting from the PAPER edge (0 = paper edge), so
 *   "number at the paper edge / tear line = calibration value" stays true.
 */
export async function renderCalibration(page, dpi = 300, output = 'jpeg', pad = null) {
  const { w, h } = page; // landscape (the paper window)
  const padE = pad ? pad.ends : 0;
  const padS = pad ? pad.sides : 0;
  const W = w + 2 * padE; // full render (head canvas when padded)
  const H = h + 2 * padS;
  const pxPerMm = dpi / 25.4;
  const ticks = [];
  const label = (x, y, text, anchor = 'middle', size = 28) =>
    ticks.push(
      `<text x="${x}" y="${y}" font-size="${size}" font-family="monospace" fill="#000" text-anchor="${anchor}">${text}</text>`
    );

  // Full-bleed tinted band on the outer 8 mm of every edge: makes the exact
  // spot where ink stops obvious against paper-white, even between rulers.
  const band = 8 * pxPerMm;
  ticks.push(`<rect x="0" y="0" width="${w}" height="${band}" fill="#ffe2a8"/>`);
  ticks.push(`<rect x="0" y="${h - band}" width="${w}" height="${band}" fill="#ffe2a8"/>`);
  ticks.push(`<rect x="0" y="0" width="${band}" height="${h}" fill="#ffe2a8"/>`);
  ticks.push(`<rect x="${w - band}" y="0" width="${band}" height="${h}" fill="#ffe2a8"/>`);

  // 50 mm reference bars (detect hidden scaling) + nominal paper outline
  const ref = 50 * pxPerMm;
  ticks.push(`<rect x="${w / 2 - ref / 2}" y="${h / 2 - 190}" width="${ref}" height="8" fill="#000"/>`);
  ticks.push(`<rect x="${w / 2 - 600}" y="${h / 2 - ref / 2}" width="8" height="${ref}" fill="#000"/>`);
  label(w / 2, h / 2 - 210, 'bars = exactly 50 mm if unscaled');

  // Rulers counting inward from the image edge (0 = image edge), every
  // 0.5 mm; every whole mm is numbered (odd/even staggered to fit).
  for (let mm = 0.5; mm <= 15; mm += 0.5) {
    const p = mm * pxPerMm;
    const whole = Number.isInteger(mm);
    const major = whole && mm % 5 === 0;
    const len = major ? 74 : whole ? 48 : 26;
    const sw = major ? 3.5 : whole ? 2 : 1;
    // straight ticks measured inward from each edge:
    ticks.push(`<line x1="${p}" y1="${h / 2 - len / 2}" x2="${p}" y2="${h / 2 + len / 2}" stroke="#000" stroke-width="${sw}"/>`); // from left
    ticks.push(`<line x1="${w - p}" y1="${h / 2 - len / 2}" x2="${w - p}" y2="${h / 2 + len / 2}" stroke="#000" stroke-width="${sw}"/>`); // from right
    ticks.push(`<line x1="${w / 2 - len / 2}" y1="${p}" x2="${w / 2 + len / 2}" y2="${p}" stroke="#000" stroke-width="${sw}"/>`); // from top
    ticks.push(`<line x1="${w / 2 - len / 2}" y1="${h - p}" x2="${w / 2 + len / 2}" y2="${h - p}" stroke="#000" stroke-width="${sw}"/>`); // from bottom
    if (whole) {
      // stagger numbers across three rows (mm % 3) so 2-digit labels at
      // 1 mm pitch never collide; rows alternate sides of the tick strip
      const size = major ? 26 : 20;
      const row = mm % 3; // 0,1,2
      const off = 48 + row * 26;
      const before = row !== 1; // rows 0/2 above-left, row 1 below-right
      // left & right rulers: numbers above/below the tick strip
      label(p, before ? h / 2 - off : h / 2 + off + 14, mm, 'middle', size);
      label(w - p, before ? h / 2 - off : h / 2 + off + 14, mm, 'middle', size);
      // top & bottom rulers: numbers left/right of the tick strip
      label(before ? w / 2 - off - 6 : w / 2 + off + 6, p + 8, mm, before ? 'end' : 'start', size);
      label(before ? w / 2 - off - 6 : w / 2 + off + 6, h - p + 8, mm, before ? 'end' : 'start', size);
    }
  }

  // Edge letters in editor orientation (landscape page) so readings map
  // unambiguously to the app's T/B/L/R calibration fields.
  const lm = 20 * pxPerMm; // letters 20 mm in: safely inside any trim
  const letters = `
  <text x="${w / 2}" y="${lm}" font-size="72" font-weight="bold" font-family="monospace" fill="#000" text-anchor="middle" dominant-baseline="middle">T</text>
  <text x="${w / 2}" y="${h - lm}" font-size="72" font-weight="bold" font-family="monospace" fill="#000" text-anchor="middle" dominant-baseline="middle">B</text>
  <text x="${lm}" y="${h / 2 + 90}" font-size="72" font-weight="bold" font-family="monospace" fill="#000" text-anchor="middle" dominant-baseline="middle">L</text>
  <text x="${w - lm}" y="${h / 2 + 90}" font-size="72" font-weight="bold" font-family="monospace" fill="#000" text-anchor="middle" dominant-baseline="middle">R</text>`;

  const border = `<rect x="2" y="2" width="${w - 4}" height="${h - 4}" fill="none" stroke="#000" stroke-width="4"/>`;
  const text = `<text x="${w / 2}" y="${h / 2 - 90}" font-size="34" font-family="monospace" fill="#000" text-anchor="middle">selphy-print calibration</text>
  <text x="${w / 2}" y="${h / 2 - 40}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">hold so that T reads on top</text>
  <text x="${w / 2}" y="${h / 2 + 70}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">rulers count mm inward from the nominal paper edge</text>
  <text x="${w / 2}" y="${h / 2 + 110}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">per edge: read the number at the actual paper edge / tear line</text>
  <text x="${w / 2}" y="${h / 2 + 150}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">enter those four numbers as T/B/L/R under Printer &gt; Calibration</text>
  <text x="${w / 2}" y="${h / 2 + 190}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">blue = overscan: its ticks count mm PAST the paper edge —</text>
  <text x="${w / 2}" y="${h / 2 + 230}" font-size="26" font-family="monospace" fill="#000" text-anchor="middle">read how wide the blue band is (L/R) → "width of blue region"</text>`;

  // Bleed zone: blue ink filling the overscan, with outward-counting mm
  // ticks from the paper edge so the overshoot is readable on the stubs.
  let bleedSvg = '';
  if (pad) {
    const parts = [`<rect width="${W}" height="${H}" fill="#bfe0ff"/>`];
    const otick = (x1, y1, x2, y2) =>
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="2"/>`);
    const olabel = (x, y, t) =>
      parts.push(`<text x="${x}" y="${y}" font-size="17" font-family="monospace" fill="#000" text-anchor="middle">${t}</text>`);
    for (let mm = 1; mm * pxPerMm <= padE; mm++) {
      const p = mm * pxPerMm;
      otick(padE - p, H / 2 - 60, padE - p, H / 2 + 60); // past left paper edge
      otick(padE + w + p, H / 2 - 60, padE + w + p, H / 2 + 60); // past right
      olabel(padE - p, H / 2 - 70, mm);
      olabel(padE + w + p, H / 2 - 70, mm);
    }
    for (let mm = 1; mm * pxPerMm <= padS; mm++) {
      const p = mm * pxPerMm;
      otick(W / 2 - 60, padS - p, W / 2 + 60, padS - p); // past top paper edge
      otick(W / 2 - 60, padS + h + p, W / 2 + 60, padS + h + p); // past bottom
      olabel(W / 2 + 80, padS - p + 6, mm);
      olabel(W / 2 + 80, padS + h + p + 6, mm);
    }
    bleedSvg = parts.join('');
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bleedSvg}<g transform="translate(${padE},${padS})"><rect width="${w}" height="${h}" fill="#fff"/>${border}${ticks.join('')}${letters}${text}</g></svg>`;

  const portrait = sharp(Buffer.from(svg)).rotate(90);
  if (output === 'raw') {
    const { data, info } = await portrait
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { rgb: data, width: info.width, height: info.height };
  }
  // Same baseline / 4:4:4 / 300-dpi encode as photo prints, so the calibration
  // sheet travels the identical JPEG path it is meant to characterize.
  return encodeJpeg(portrait, 97);
}
