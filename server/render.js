/* Image pipeline: EXIF-orient → user rotate → crop → resize to the printer's
   native canvas → ICC-convert into the printer profile (lcms2 jpgicc) →
   untagged JPEG ready to send as-is over IPP.

   The SELPHY has a fixed internal color pipeline that cannot be disabled, so
   usable profiles characterize the *whole* path (sRGB-in → print). Converting
   into the profile and sending the result untagged pre-compensates correctly. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const execFileP = promisify(execFile);

/**
 * @param {Buffer} input source image (any sharp-decodable format)
 * @param {object} opts
 *   crop   {x,y,w,h} as 0..1 fractions of the EXIF-oriented, user-rotated image
 *   rotate 0|90|180|270 user rotation on top of EXIF orientation
 *   canvas {w,h} print canvas in px, landscape (e.g. 1872×1248 for postcard)
 *   icc    { profile: path|null, intent: 'perceptual'|'relative', quality }
 * @returns {Promise<Buffer>} portrait (short-edge-first) JPEG at native size
 */
export async function renderForPrint(input, opts) {
  const { crop, rotate = 0, canvas, icc = {} } = opts;

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
    : centerCover(meta.width, meta.height, canvas.w / canvas.h);
  region.left = Math.max(0, Math.min(region.left, meta.width - 1));
  region.top = Math.max(0, Math.min(region.top, meta.height - 1));
  region.width = Math.min(region.width, meta.width - region.left);
  region.height = Math.min(region.height, meta.height - region.top);

  const rendered = await sharp(buf)
    .extract(region)
    .resize(canvas.w, canvas.h, { fit: 'fill', kernel: 'lanczos3' })
    .rotate(90) // printer feeds portrait, short edge first
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
    .toBuffer();

  if (!icc.profile) return rendered;
  return applyIcc(rendered, icc);
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

async function applyIcc(jpeg, icc) {
  const dir = await mkdtemp(path.join(tmpdir(), 'selphy-'));
  const inFile = path.join(dir, 'in.jpg');
  const outFile = path.join(dir, 'out.jpg');
  try {
    await writeFile(inFile, jpeg);
    // -b: black point compensation, untagged input assumed sRGB, output left
    // untagged (no -e) because the printer assumes sRGB-ish input anyway.
    await execFileP('jpgicc', [
      '-t', INTENTS[icc.intent] ?? '0',
      '-b',
      '-o', icc.profile,
      '-q', String(icc.quality ?? 95),
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

/** Calibration page: mm rulers from every edge so the real visible area
    (and thus overscan) can be measured off a physical print. */
export async function renderCalibration(canvas, dpi = 300) {
  const { w, h } = canvas; // landscape
  const pxPerMm = dpi / 25.4;
  const ticks = [];
  const label = (x, y, text, anchor = 'middle') =>
    ticks.push(
      `<text x="${x}" y="${y}" font-size="28" font-family="monospace" fill="#000" text-anchor="${anchor}">${text}</text>`
    );

  for (let mm = 1; mm <= 12; mm++) {
    const p = mm * pxPerMm;
    const major = mm % 5 === 0;
    const len = major ? 60 : 35;
    const sw = major ? 3 : 1.5;
    // straight ticks measured inward from each edge:
    ticks.push(`<line x1="${p}" y1="${h / 2 - len / 2}" x2="${p}" y2="${h / 2 + len / 2}" stroke="#000" stroke-width="${sw}"/>`); // from left
    ticks.push(`<line x1="${w - p}" y1="${h / 2 - len / 2}" x2="${w - p}" y2="${h / 2 + len / 2}" stroke="#000" stroke-width="${sw}"/>`); // from right
    ticks.push(`<line x1="${w / 2 - len / 2}" y1="${p}" x2="${w / 2 + len / 2}" y2="${p}" stroke="#000" stroke-width="${sw}"/>`); // from top
    ticks.push(`<line x1="${w / 2 - len / 2}" y1="${h - p}" x2="${w / 2 + len / 2}" y2="${h - p}" stroke="#000" stroke-width="${sw}"/>`); // from bottom
    if (major) {
      label(p + 8, h / 2 + 10, mm, 'start');
      label(w - p - 8, h / 2 + 10, mm, 'end');
      label(w / 2 + len / 2 + 8, p + 10, mm, 'start');
      label(w / 2 + len / 2 + 8, h - p + 10, mm, 'start');
    }
  }

  const border = `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="#000" stroke-width="2"/>`;
  const text = `<text x="${w / 2}" y="${h / 2 - 60}" font-size="36" font-family="monospace" fill="#000" text-anchor="middle">selphy-print calibration — ticks are mm from canvas edge</text>
  <text x="${w / 2}" y="${h / 2 + 80}" font-size="30" font-family="monospace" fill="#000" text-anchor="middle">read the first visible tick on each edge = overscan in mm</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${border}${ticks.join('')}${text}</svg>`;

  return sharp(Buffer.from(svg))
    .rotate(90)
    .jpeg({ quality: 97 })
    .toBuffer();
}
