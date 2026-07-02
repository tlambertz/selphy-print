/* Drive the real server/cpnp.js cpnpPrint() with verbose logging. This
   exercises the exact code path /api/print uses.
   Usage: node test/cpnp-print.mjs [ip] [calib|bars] [border]
   Default prints the mm-ruler CALIBRATION page (doubles as the borderless
   test: first readable tick per edge = trimmed mm).
   WITH PAPER LOADED THIS PRINTS A REAL SHEET. */
import sharp from 'sharp';
import { cpnpPrint } from '../server/cpnp.js';
import { renderCalibration } from '../server/render.js';
import { config } from '../server/config.js';

const host = process.argv[2] || '192.168.1.240';
const kind = process.argv[3] || 'calib';
const border = process.argv.includes('border');

// All CPNP prints render AT the head canvas (firmware scale = 1.0).
const cv = config.paper.canvas;
let jpeg;
if (kind === 'bars') {
  // Colour bars: unmistakable vs a blank sheet.
  const bars = ['#e03131', '#f08c00', '#ffd43b', '#2f9e44', '#1971c2', '#9c36b5'];
  const bh = Math.ceil(cv.w / bars.length);
  const svg = `<svg width="${cv.h}" height="${cv.w}">${bars
    .map((c, i) => `<rect x="0" y="${i * bh}" width="${cv.h}" height="${bh}" fill="${c}"/>`)
    .join('')}</svg>`;
  jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
} else {
  jpeg = await renderCalibration(config.paper.canonPage, 300, 'jpeg', config.paper.canvasBleed);
}

const width = cv.h; // portrait after rotate
const height = cv.w;
console.log(`${kind} JPEG ${jpeg.length} bytes ${width}x${height}, border=${border}, host=${host}`);

const res = await cpnpPrint(host, jpeg, {
  width,
  height,
  border,
  onState: (s) => console.log(`[state] ${s}`),
  log: (m) => console.log(`[cpnp] ${m}`),
});
console.log('result:', res);
