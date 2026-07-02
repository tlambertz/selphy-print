import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import sharp from 'sharp';

// The print head's native grid: 11.835 px/mm (≈300.6 dpi) — JPEG-path
// renders and their calibration rulers live on it; raster formats declare
// plain 300 dpi in their headers and keep that grid.
const DEVICE_DPI = 11.835 * 25.4;
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
  // geometry differs per transport: overscanning modes (cpnp; ipp jpeg with
  // the borderless variant) put ink past the tear line, plain ipp jpeg ends
  // ≈ at it — the editor visualization adapts.
  printFormat: config.printFormat,
  mediaVariant: config.mediaVariant,
  blueWidth: config.blueWidth,
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
    // negative = the mapping overshoots the paper boundary on that edge
    // (the structural canvas bleed absorbs it, so total bleed stays ≥ 0)
    overscanMm[edge] = isFinite(v) && v >= -5 && v <= 12 ? v : config.overscan[edge];
  }
  // mm → px at the render target's resolution: JPEG targets (canonPage,
  // canvas) live on the device grid (11.835 px/mm); raster targets on the
  // IPP-standard 300 dpi grid.
  const bleedPx = (pxPerMm) => ({
    top: Math.round(overscanMm.top * pxPerMm),
    bottom: Math.round(overscanMm.bottom * pxPerMm),
    left: Math.round(overscanMm.left * pxPerMm),
    right: Math.round(overscanMm.right * pxPerMm),
  });
  const bleed = bleedPx(RASTER[config.printFormat] ? 300 / 25.4 : 11.835);

  const job = enqueue(async (job) => {
    job.state = 'rendering';
    job.stateText = 'processing image…';

    if (config.printFormat === 'cpnp') {
      // Canon's own path. Measured firmware behavior: any JPEG is aspect-fill
      // scaled onto the full head canvas (1872×1248) and centered on the
      // sheet, so we render AT the canvas (scale 1.0) with the photo composed
      // for the centered paper window. Bleed per edge = structural canvas
      // overhang (always trimmed) + calibrated registration. Like Canon's
      // app we always print with the borderless spool flag — a "bordered"
      // print is a white frame baked into the image.
      const cv = config.paper.canvas;
      const structural = config.paper.canvasBleed; // landscape: ends=left/right
      const cpnpBleed = {
        top: structural.sides + bleed.top,
        bottom: structural.sides + bleed.bottom,
        left: structural.ends + bleed.left,
        right: structural.ends + bleed.right,
      };
      if (!borderless) {
        // classic SELPHY bordered look: ~2.5 mm sides / 3.7 mm ends of white
        cpnpBleed.top += 30; cpnpBleed.bottom += 30;
        cpnpBleed.left += 44; cpnpBleed.right += 44;
      }
      const jpeg = await renderForPrint(imageBuf, {
        crop: options.crop || null,
        rotate: [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0,
        target: cv,
        bleed: cpnpBleed,
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
          width: cv.h, // portrait after rotate
          height: cv.w,
          onState: (s) => { job.stateText = 'printer: ' + s; },
        });
      }
      return;
    }

    // IPP fallbacks. The JPEG path aspect-fits the image BY PIXELS (DPI
    // metadata ignored) onto a firmware rect that depends on the media
    // variant: with PLAIN media it's the paper rect (canonPage in device px
    // — measured: canvas padding printed as inset borders), with the
    // zero-margin borderless media-col it should be the head canvas, like
    // URF's enlargement — so we render canvas-size with the same overscan
    // composition as CPNP and the fit scale stays 1.0. The calibration page
    // goes through this exact geometry and verifies it. Raster formats keep
    // the 300 dpi page geometry their headers declare.
    const raster = RASTER[config.printFormat];
    const overscans = !raster && config.mediaVariant === 'borderless';
    let target, ippBleed;
    if (raster) {
      target = config.paper.page;
      ippBleed = borderless ? bleed : { top: 30, bottom: 30, left: 44, right: 44 };
    } else if (overscans) {
      const st = config.paper.canvasBleed;
      target = config.paper.canvas;
      ippBleed = {
        top: st.sides + bleed.top,
        bottom: st.sides + bleed.bottom,
        left: st.ends + bleed.left,
        right: st.ends + bleed.right,
      };
      if (!borderless) {
        ippBleed.top += 30; ippBleed.bottom += 30;
        ippBleed.left += 44; ippBleed.right += 44;
      }
    } else {
      target = config.paper.canonPage;
      ippBleed = borderless ? bleed : { top: 30, bottom: 30, left: 44, right: 44 };
    }
    const rendered = await renderForPrint(imageBuf, {
      crop: options.crop || null,
      rotate: [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0,
      target,
      bleed: ippBleed,
      padWhite: !borderless,
      icc: config.icc,
      output: raster ? 'raw' : 'jpeg',
    });
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
// The calibration page always mirrors the photo path exactly (same target,
// same media variant, only without the calibrated pre-compensation), so its
// rulers measure the real print geometry. Overscanning modes (cpnp always;
// ipp jpeg with the borderless variant) pad the paper-window rulers out to
// the head canvas; plain ipp jpeg prints the bare paper rect.
function calibrationJpeg() {
  const overscans =
    config.printFormat === 'cpnp' ||
    (!RASTER[config.printFormat] && config.mediaVariant === 'borderless');
  return renderCalibration(
    config.paper.canonPage, DEVICE_DPI, 'jpeg',
    overscans ? config.paper.canvasBleed : null
  );
}

// The exact image the calibrate button prints, for on-screen preview
// (rotated back to landscape so it displays the way you hold the sheet).
app.get('/api/calibrate/preview', async (req, reply) => {
  const jpeg = RASTER[config.printFormat]
    ? await renderCalibration(config.paper.page)
    : await calibrationJpeg();
  const landscape = await sharp(jpeg).rotate(270).jpeg({ quality: 90 }).toBuffer();
  reply.header('cache-control', 'no-store');
  reply.type('image/jpeg');
  return landscape;
});

app.post('/api/calibrate', async () => {
  const job = enqueue(async (job) => {
    job.state = 'rendering';
    job.stateText = 'rendering calibration page…';
    if (config.printFormat === 'cpnp') {
      const jpeg = await calibrationJpeg();
      const host = new URL(printerUrl()).hostname;
      job.state = 'printing';
      job.stateText = 'printing…';
      await cpnpPrint(host, jpeg, {
        width: config.paper.canvas.h,
        height: config.paper.canvas.w,
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
      await printBuffer(job, await calibrationJpeg(), { copies: 1, format: 'image/jpeg', jobName: 'calibration' });
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
