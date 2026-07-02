import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { config, printerUrl } from './config.js';
import { getPrinterAttributes, getJobAttributes, printJob } from './ipp.js';
import { renderForPrint, renderCalibration } from './render.js';
import { encodePwg, encodeUrf } from './pwg.js';
import { cpnpPrint } from './cpnp.js';

const RASTER = {
  pwg: { mime: 'image/pwg-raster', encode: encodePwg },
  urf: { mime: 'image/urf', encode: encodeUrf },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

await app.register(fastifyMultipart, {
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 24 },
});
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'web'),
  extensions: ['html'],
});

/* ---------- job queue (dye-sub prints strictly one at a time) ---------- */

const jobs = new Map(); // id -> { state, stateText, error, createdAt }
let jobSeq = 0;
let queueChain = Promise.resolve();

function enqueue(work) {
  const id = ++jobSeq;
  const job = { id, state: 'queued', stateText: 'queued', createdAt: Date.now() };
  jobs.set(id, job);
  queueChain = queueChain.then(async () => {
    try {
      await work(job);
      job.state = 'done';
      job.stateText = 'printed';
    } catch (err) {
      job.state = 'error';
      job.error = String(err.message || err);
      app.log.error({ err, jobId: id }, 'print job failed');
    }
  });
  // Expire finished jobs after an hour so the map doesn't grow forever.
  setTimeout(() => jobs.delete(id), 3600_000).unref();
  return job;
}

async function printBuffer(job, data, { copies = 1, format = 'image/jpeg', jobName = 'photo' }) {
  const url = printerUrl();
  if (!url) throw new Error('printer not configured — set PRINTER_HOST');

  job.state = 'printing';
  job.stateText = 'sending to printer…';
  const { jobId: ippJobId } = await printJob(url, data, {
    jobName,
    copies,
    format,
    borderless: config.mediaVariant === 'borderless',
    media: config.paper.mediaName,
    printScaling: config.printScaling,
    mediaSize: config.paper.media,
  });

  if (!ippJobId) return; // printer accepted but gave no job id; assume ok
  // Poll until the printer reports the job finished (state >= 7 is terminal).
  const deadline = Date.now() + 10 * 60_000 * copies;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let attrs;
    try {
      attrs = await getJobAttributes(url, ippJobId);
    } catch {
      continue; // transient network blip while printing
    }
    const state = attrs['job-state'];
    if (state === 9) return;
    if (state === 7 || state === 8) {
      const reasons = [].concat(attrs['job-state-reasons'] || []).join(', ');
      throw new Error(`printer ${state === 7 ? 'canceled' : 'aborted'} the job${reasons ? `: ${reasons}` : ''}`);
    }
    job.stateText = state === 5 ? 'printing…' : 'waiting for printer…';
  }
  throw new Error('timed out waiting for the printer to finish');
}

/* ---------- API ---------- */

app.get('/api/config', async () => ({
  paper: config.paper,
  overscan: config.overscan,
  icc: { enabled: !!config.icc.profile, intent: config.icc.intent },
  printerConfigured: !!printerUrl(),
}));

app.get('/api/printer', async () => {
  const url = printerUrl();
  if (!url) return { reachable: false, configured: false };
  try {
    const { attrs } = await getPrinterAttributes(url);
    const reasons = []
      .concat(attrs['printer-state-reasons'] || [])
      .filter((r) => r && r !== 'none');
    return {
      reachable: true,
      configured: true,
      name: attrs['printer-name'] || attrs['printer-make-and-model'],
      state: attrs['printer-state'], // 3 idle, 4 processing, 5 stopped
      stateReasons: reasons,
      mediaReady: attrs['media-ready'],
      markerLevels: attrs['marker-levels'],
    };
  } catch (err) {
    return { reachable: false, configured: true, error: String(err.message || err) };
  }
});

app.post('/api/print', async (req, reply) => {
  let imageBuf = null;
  let options = {};
  for await (const part of req.parts()) {
    if (part.type === 'file' && part.fieldname === 'image') {
      imageBuf = await part.toBuffer();
    } else if (part.type === 'field' && part.fieldname === 'options') {
      try {
        options = JSON.parse(part.value);
      } catch {
        return reply.code(400).send('bad options JSON');
      }
    }
  }
  if (!imageBuf) return reply.code(400).send('missing image');

  const copies = Math.min(Math.max(parseInt(options.copies, 10) || 1, 1), 99);
  const borderless = !options.border;

  // Per-edge borderless trim in page-mm: the client sends its calibrated
  // values (per-device localStorage); fall back to the server defaults.
  // Renders pre-compensate for it, so calibration changes the actual print.
  const overscanMm = {};
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const v = Number(options.overscan?.[edge]);
    overscanMm[edge] = isFinite(v) && v >= 0 && v <= 12 ? v : config.overscan[edge];
  }
  const PX_PER_MM = 300 / 25.4;
  const bleed = {
    top: Math.round(overscanMm.top * PX_PER_MM),
    bottom: Math.round(overscanMm.bottom * PX_PER_MM),
    left: Math.round(overscanMm.left * PX_PER_MM),
    right: Math.round(overscanMm.right * PX_PER_MM),
  };

  const job = enqueue(async (job) => {
    job.state = 'rendering';
    job.stateText = 'processing image…';

    if (config.printFormat === 'cpnp') {
      // Canon's own path: JPEG at the app's render size (1752×1184 → portrait
      // 1184×1752), borderless flag in the spool header does the full bleed.
      // The firmware overscans, so pre-compensate with the calibrated bleed.
      const jpeg = await renderForPrint(imageBuf, {
        crop: options.crop || null,
        rotate: [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0,
        target: config.paper.canonPage,
        bleed: borderless ? bleed : { top: 30, bottom: 30, left: 44, right: 44 },
        padWhite: !borderless,
        icc: config.icc,
        output: 'jpeg',
      });
      const url = printerUrl();
      const host = new URL(url).hostname;
      for (let i = 0; i < copies; i++) {
        job.state = 'printing';
        job.stateText = copies > 1 ? `printing ${i + 1}/${copies}…` : 'printing…';
        await cpnpPrint(host, jpeg, {
          width: config.paper.canonPage.h, // portrait after rotate
          height: config.paper.canonPage.w,
          onState: (s) => { job.stateText = 'printer: ' + s; },
        });
      }
      return;
    }

    // IPP fallbacks (raster / jpeg) — kept for experimentation.
    const rendered = await renderForPrint(imageBuf, {
      crop: options.crop || null,
      rotate: [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0,
      target: config.paper.page,
      bleed: borderless ? bleed : { top: 30, bottom: 30, left: 44, right: 44 },
      padWhite: !borderless,
      icc: config.icc,
      output: RASTER[config.printFormat] ? 'raw' : 'jpeg',
    });
    const raster = RASTER[config.printFormat];
    if (raster) {
      const data = raster.encode(rendered.rgb, rendered.width, rendered.height);
      await printBuffer(job, data, { copies, format: raster.mime });
    } else {
      await printBuffer(job, rendered, { copies, format: 'image/jpeg' });
    }
  });

  return { jobId: job.id };
});

app.get('/api/jobs/:id', async (req, reply) => {
  const job = jobs.get(parseInt(req.params.id, 10));
  if (!job) return reply.code(404).send('unknown job');
  return { state: job.state, stateText: job.stateText, error: job.error };
});

// Prints a page of mm rulers so the true visible area / overscan can be
// measured with the exact same render+IPP path as real prints.
app.post('/api/calibrate', async () => {
  const job = enqueue(async (job) => {
    job.state = 'rendering';
    job.stateText = 'rendering calibration page…';
    // Full-page ruler through the same path as photos.
    if (config.printFormat === 'cpnp') {
      const jpeg = await renderCalibration(config.paper.canonPage);
      const host = new URL(printerUrl()).hostname;
      job.state = 'printing';
      job.stateText = 'printing…';
      await cpnpPrint(host, jpeg, {
        width: config.paper.canonPage.h,
        height: config.paper.canonPage.w,
        onState: (s) => { job.stateText = 'printer: ' + s; },
      });
      return;
    }
    const raster = RASTER[config.printFormat];
    if (raster) {
      const r = await renderCalibration(config.paper.page, 300, 'raw');
      const data = raster.encode(r.rgb, r.width, r.height);
      await printBuffer(job, data, { copies: 1, format: raster.mime, jobName: 'calibration' });
    } else {
      const jpeg = await renderCalibration(config.paper.page);
      await printBuffer(job, jpeg, { copies: 1, format: 'image/jpeg', jobName: 'calibration' });
    }
  });
  return { jobId: job.id };
});

/* ---------- share-target fallback ----------
   Normally the service worker intercepts POST /share-target before it hits
   the network. This route only fires when the SW isn't controlling the page
   yet (first ever share, SW update race): stash files server-side and let the
   app pull them from /api/inbox after the redirect. */

const inbox = new Map(); // id -> { buf, type, name, addedAt }
let inboxSeq = 0;

app.post('/share-target', async (req, reply) => {
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buf = await part.toBuffer();
        if (buf.length) {
          const id = ++inboxSeq;
          inbox.set(id, { buf, type: part.mimetype, name: part.filename, addedAt: Date.now() });
          setTimeout(() => inbox.delete(id), 3600_000).unref();
        }
      }
    }
  } catch (err) {
    req.log.warn({ err }, 'share-target fallback failed to parse');
  }
  return reply.redirect('/?srvshared=1', 303);
});

app.get('/api/inbox', async () => ({
  items: [...inbox.entries()].map(([id, f]) => ({ id, name: f.name, type: f.type })),
}));

app.get('/api/inbox/:id', async (req, reply) => {
  const f = inbox.get(parseInt(req.params.id, 10));
  if (!f) return reply.code(404).send('gone');
  return reply.type(f.type || 'application/octet-stream').send(f.buf);
});

app.delete('/api/inbox/:id', async (req) => {
  inbox.delete(parseInt(req.params.id, 10));
  return { ok: true };
});

/* ---------- start ---------- */

app.listen({ port: config.port, host: config.host }).then(() => {
  app.log.info(
    {
      printer: printerUrl() || '(unset — set PRINTER_HOST)',
      icc: config.icc.profile || '(none — set ICC_PROFILE)',
      paper: config.paper.name,
    },
    'selphy-print up'
  );
});
