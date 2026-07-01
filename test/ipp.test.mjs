import { getPrinterAttributes, printJob, getJobAttributes } from '../server/ipp.js';
import sharp from 'sharp';

const url = 'ipp://127.0.0.1:6310/ipp/print';

const pa = await getPrinterAttributes(url);
console.log('printer:', pa.attrs['printer-name'], '| state', pa.attrs['printer-state'], '| status', pa.statusCode.toString(16));

const jpeg = await sharp({ create: { width: 1248, height: 1872, channels: 3, background: '#cc4455' } }).jpeg().toBuffer();
const { jobId, jobState } = await printJob(url, jpeg, {
  jobName: 'test-photo',
  copies: 1,
  borderless: true,
  printScaling: 'fill',
  mediaSize: { x: 10000, y: 14800 },
});
console.log('print-job accepted: id', jobId, 'state', jobState);

for (let i = 0; i < 10; i++) {
  const attrs = await getJobAttributes(url, jobId);
  console.log('job-state:', attrs['job-state'], attrs['job-state-reasons']);
  if (attrs['job-state'] >= 7) break;
  await new Promise(r => setTimeout(r, 500));
}
