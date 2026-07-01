import { renderForPrint, renderCalibration } from '../server/render.js';
import sharp from 'sharp';
import { strict as assert } from 'node:assert';

// synthetic 3000x2000 gradient photo
const src = await sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="2000">
     <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
       <stop offset="0" stop-color="#ff2200"/><stop offset="0.5" stop-color="#22cc66"/><stop offset="1" stop-color="#2244ff"/>
     </linearGradient></defs>
     <rect width="3000" height="2000" fill="url(#g)"/>
     <circle cx="1500" cy="1000" r="400" fill="#ffffff"/>
   </svg>`)).jpeg().toBuffer();

const target = { w: 1748, h: 1181 };

// no ICC
let out = await renderForPrint(src, { crop: { x: 0.1, y: 0.1, w: 0.75, h: 0.75 }, rotate: 0, target, icc: {} });
let meta = await sharp(out).metadata();
assert.equal(meta.width, 1181); assert.equal(meta.height, 1748);
console.log('render no-icc ok:', meta.width + 'x' + meta.height, meta.format);

// with ICC profile
out = await renderForPrint(src, { crop: null, rotate: 90, target, icc: { profile: 'profiles/CP1500-farbenwerk.icc', intent: 'perceptual', quality: 95 } });
meta = await sharp(out).metadata();
assert.equal(meta.width, 1181); assert.equal(meta.height, 1748);
console.log('render icc ok:', meta.width + 'x' + meta.height, 'bytes', out.length);

const cal = await renderCalibration(target);
meta = await sharp(cal).metadata();
assert.equal(meta.width, 1181); assert.equal(meta.height, 1748);
console.log('calibration ok');

// bleed pre-compensation: full page out, mirrored bleed at edges
const bleed = { top: 30, bottom: 30, left: 50, right: 69 };
out = await renderForPrint(src, { crop: { x: 0.1, y: 0.1, w: 0.75, h: 0.75 * (1181/1748) * (3000/2000) }, rotate: 0, target, bleed, icc: {} });
meta = await sharp(out).metadata();
assert.equal(meta.width, 1181); assert.equal(meta.height, 1748);
console.log('render bleed ok:', meta.width + 'x' + meta.height);
await sharp(out).rotate(-90).resize(900).png().toFile(process.env.BLEED_PREVIEW || '/dev/null');
