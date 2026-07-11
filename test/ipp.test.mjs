/* Exercise the IPP client (get-printer-attributes, print-job, job polling)
   against a real IPP server: ippeveprinter from cups-ipp-utils, spawned on a
   scratch port for the duration of the test. Skips (exit 0, with a notice)
   when ippeveprinter is missing or can't start — e.g. containers without a
   DNS-SD daemon, which CUPS 2.4's ippeveprinter requires even for localhost. */
import { spawn } from 'node:child_process';
import { getPrinterAttributes, printJob, getJobAttributes } from '../server/ipp.js';
import sharp from 'sharp';

const PORT = 6310;
const url = `ipp://127.0.0.1:${PORT}/ipp/print`;

function skip(reason) {
  console.log(`SKIP ipp test: ${reason}`);
  process.exit(0);
}

const srv = spawn('ippeveprinter', ['-p', String(PORT), 'ipp-test'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOutput = '';
srv.stdout.on('data', (d) => (srvOutput += d));
srv.stderr.on('data', (d) => (srvOutput += d));
srv.on('error', (err) => {
  if (err.code === 'ENOENT') skip('ippeveprinter not installed (cups-ipp-utils)');
  throw err;
});
const srvExited = new Promise((resolve) => srv.on('exit', resolve));
process.on('exit', () => srv.kill());

// Wait until it answers IPP (or gives up: startup failure vs. our bug).
async function connect() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await getPrinterAttributes(url);
    } catch (err) {
      if (srv.exitCode !== null) skip(`ippeveprinter exited: ${srvOutput.trim().split('\n')[0]}`);
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

try {
  const pa = await connect();
  console.log('printer:', pa.attrs['printer-name'], '| state', pa.attrs['printer-state'], '| status', pa.statusCode.toString(16));

  const jpeg = await sharp({ create: { width: 1181, height: 1748, channels: 3, background: '#cc4455' } }).jpeg().toBuffer();
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
    await new Promise((r) => setTimeout(r, 500));
  }
} finally {
  srv.kill();
  await srvExited;
}
