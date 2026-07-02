/* Paper-free URF format probe against the real printer.
   Sends the calibration raster with a given URF header variant, then polls
   the job: 'aborted' = format rejected (no paper used), 'processing' =
   accepted (the sheet that prints IS the verification page).
   Usage: node test/urf-probe.mjs <printer-host> <variant-json>
   e.g.:  node test/urf-probe.mjs 192.168.1.240 '{"quality":4,"mediaType":11}' */
import { encodeUrf } from '../server/pwg.js';
import { renderCalibration } from '../server/render.js';
import { printJob, getJobAttributes, getPrinterAttributes } from '../server/ipp.js';

const host = process.argv[2];
const variant = JSON.parse(process.argv[3] || '{}');
const url = `ipp://${host}:631/ipp/print`;

const before = await getPrinterAttributes(url);
console.log('printer before:', before.attrs['printer-state'], before.attrs['printer-state-reasons']);
if (before.attrs['printer-state'] === 5) {
  console.log('ABORT: printer is stopped — fix the printer first');
  process.exit(2);
}

const r = await renderCalibration({ w: 1748, h: 1181 }, 300, 'raw');
const urf = encodeUrf(r.rgb, r.width, r.height, 300, variant);
console.log('variant:', JSON.stringify(variant), '| urf bytes:', urf.length);

const { jobId, jobState } = await printJob(url, urf, {
  jobName: 'urf-probe',
  format: 'image/urf',
  media: 'jpn_hagaki_100x148mm',
});
console.log('accepted: job', jobId, 'state', jobState);

for (let i = 0; i < 30; i++) {
  await new Promise((s) => setTimeout(s, 2000));
  let attrs;
  try {
    attrs = await getJobAttributes(url, jobId);
  } catch {
    continue;
  }
  const st = attrs['job-state'];
  const reasons = [].concat(attrs['job-state-reasons'] || []).join(',');
  console.log(`t+${(i + 1) * 2}s job-state ${st} (${reasons})`);
  if (st === 9) {
    console.log('RESULT: COMPLETED — this variant PRINTS. Check the sheet!');
    process.exit(0);
  }
  if (st === 7 || st === 8) {
    const after = await getPrinterAttributes(url);
    console.log('printer after:', after.attrs['printer-state'], after.attrs['printer-state-reasons']);
    console.log('RESULT: REJECTED (no paper used)');
    process.exit(1);
  }
}
console.log('RESULT: TIMEOUT — check printer display');
