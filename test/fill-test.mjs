/* One-off empirical test: does print-scaling=fill actually enlarge?
 *
 * The original calibration print was rendered at CANVAS size (1872×1248), so
 * 'fill' had nothing to enlarge (scale ≈ 1.0) — it never tested fill's claimed
 * ~7% enlargement. This renders the calibration sheet at PAGE size (1748×1181,
 * the IPP page raster) and prints it as a plain IPP JPEG with print-scaling=fill.
 *
 * Read the 50 mm reference bars on the print:
 *   bars = 50 mm    → 'fill' placed the page raster 1:1 (NO enlargement)
 *   bars ≈ 53.5 mm  → 'fill' enlarged page→canvas (1872/1748 = ~7%)  [the theory]
 * Also note where the mm rulers' first visible tick lands at each edge.
 *
 * Usage: node test/fill-test.mjs [host] [scaling] [--dry]
 *   --dry renders to scratchpad and does NOT print (no paper used).
 */
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCalibration } from '../server/render.js';
import { printJob } from '../server/ipp.js';
import { config } from '../server/config.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const positional = args.filter((a) => !a.startsWith('--'));
const HOST = positional[0] || process.env.PRINTER_HOST;
const SCALING = positional[1] || 'fill';
if (!dry && !HOST) {
  console.error('usage: node test/fill-test.mjs <printer-host> [scaling]   (or set PRINTER_HOST; add --dry to render without printing)');
  process.exit(1);
}

const page = config.paper.page; // landscape {w:1748, h:1181} — the 100×148 mm photo area
const jpeg = await renderCalibration(page, 300, 'jpeg', null); // page-sized, no blue overscan zone
console.log(`rendered PAGE-size calibration: ${jpeg.length} bytes, source raster ${page.w}×${page.h} @300dpi`);
console.log(`(50 mm bars encode as ${Math.round((50 * 300) / 25.4)} px; if fill enlarges page→canvas they print ~53.5 mm)`);

if (dry) {
  const out = path.join(tmpdir(), 'selphy-fill-test-page.jpg');
  await writeFile(out, jpeg);
  console.log(`DRY RUN — wrote ${out}, nothing printed.`);
  process.exit(0);
}

console.log(`printing to ipp://${HOST}:631 — format=image/jpeg, borderless media-col, print-scaling=${SCALING}`);
const res = await printJob(`ipp://${HOST}:631/ipp/print`, jpeg, {
  jobName: `fill-test-${SCALING}`,
  format: 'image/jpeg',
  borderless: true,
  mediaSize: config.paper.media, // {x:10000, y:14800} 1/100 mm
  printScaling: SCALING,
});
console.log('Print-Job result:', JSON.stringify(res));
