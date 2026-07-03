import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
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
  const job = { id, state: 'queued', stateText: 'queued', progress: 0, createdAt: Date.now() };
  jobs.set(id, job);
  queueChain = queueChain.then(async () => {
    try {
      await work(job);
      job.state = 'done';
      job.stateText = 'printed';
      job.progress = 100;
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

/* ---------- print archive ---------- */

let archiveReady = null;
function ensureArchiveDir() {
  if (!config.archiveDir) return Promise.resolve(false);
  if (!archiveReady) {
    archiveReady = mkdir(config.archiveDir, { recursive: true })
      .then(() => true)
      .catch((err) => {
        app.log.warn({ err, dir: config.archiveDir }, 'print archive dir unavailable — archiving disabled');
        config.archiveDir = null;
        return false;
      });
  }
  return archiveReady;
}
const ARCHIVE_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif', tiff: 'tiff', heif: 'heic', avif: 'avif' };
function archiveStamp(id) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_job${id}`;
}
// Store both the untouched upload and the exact cropped image sent to the head.
async function archivePrint(id, original, originalFmt, printJpeg) {
  if (!(await ensureArchiveDir())) return;
  const base = path.join(config.archiveDir, archiveStamp(id));
  try {
    await Promise.all([
      writeFile(`${base}_original.${ARCHIVE_EXT[originalFmt] || 'img'}`, original),
      writeFile(`${base}_print.jpg`, printJpeg),
    ]);
    app.log.info({ base }, 'archived print');
  } catch (err) {
    app.log.warn({ err }, 'print archive write failed');
  }
}

// CPNP print progress (0-100) by reported phase, so the client can draw a real
// bar. The dye-sub cycle is Y→M→C→overcoat, roughly equal time each; the
// upload/handshake is quick, so it gets the first ~15%.
const CPNP_PCT = {
  session: 3, connecting: 5, start: 7, spool: 9, data: 13,
  'pass:paper pick': 15, 'pass:initializing': 18,
  'pass:yellow (heating)': 22, 'pass:yellow': 36,
  'pass:magenta (heating)': 40, 'pass:magenta': 54,
  'pass:cyan (heating)': 58, 'pass:cyan': 72,
  'pass:overcoat (heating)': 76, 'pass:overcoat': 90,
  'pass:finalizing': 96, done: 100,
};

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
  icc: {
    enabled: config.icc.profiles.length > 0,
    intent: config.icc.intent,
    profiles: config.icc.profiles.map((p) => ({ id: p.id, name: p.name })),
    defaultId: config.icc.defaultId,
  },
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

/* Render geometry for the current printer config + per-job options: the target
 * raster, per-edge bleed (px), and whether the bleed is white (bordered) or
 * mirrored image (borderless). Shared by /api/print and /api/preview so the
 * preview is byte-faithful to what gets sent.
 *
 * - cpnp / ipp-jpeg with borderless media: render at the head canvas
 *   (1872×1248) with the structural canvas overhang as bleed — CPNP
 *   fill-scales it off the paper (true full bleed). NB the plain IPP-JPEG path
 *   instead FITS the JPEG to the paper, so that same overhang would print as an
 *   inset border — measured. True borderless ⇒ PRINT_FORMAT=cpnp.
 * - raster (pwg/urf): the 300 dpi page raster.
 * - ipp-jpeg with plain media: the bare paper rect (canonPage).
 * Bordered mode adds a ~2.5 mm side / 3.7 mm end white frame. */
function buildRenderPlan(options, format = config.printFormat) {
  const borderless = !options.border;
  // Per-edge borderless trim in page-mm: the client sends its calibrated
  // values (per-device localStorage); fall back to the server defaults.
  const overscanMm = {};
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const v = Number(options.overscan?.[edge]);
    // negative = the mapping overshoots the paper boundary on that edge
    overscanMm[edge] = isFinite(v) && v >= -5 && v <= 12 ? v : config.overscan[edge];
  }
  const raster = RASTER[format];
  // mm → px: JPEG targets live on the device grid (11.835 px/mm); raster
  // targets on the IPP-standard 300 dpi grid.
  const pxPerMm = raster ? 300 / 25.4 : 11.835;
  const bleed = {
    top: Math.round(overscanMm.top * pxPerMm),
    bottom: Math.round(overscanMm.bottom * pxPerMm),
    left: Math.round(overscanMm.left * pxPerMm),
    right: Math.round(overscanMm.right * pxPerMm),
  };
  const FRAME = { top: 30, bottom: 30, left: 44, right: 44 }; // bordered white

  let target, outBleed;
  if (format === 'cpnp' || (!raster && config.mediaVariant === 'borderless')) {
    const st = config.paper.canvasBleed; // landscape: ends=left/right
    target = config.paper.canvas;
    outBleed = {
      top: st.sides + bleed.top, bottom: st.sides + bleed.bottom,
      left: st.ends + bleed.left, right: st.ends + bleed.right,
    };
    if (!borderless) {
      outBleed.top += FRAME.top; outBleed.bottom += FRAME.bottom;
      outBleed.left += FRAME.left; outBleed.right += FRAME.right;
    }
  } else if (raster) {
    target = config.paper.page;
    outBleed = borderless ? bleed : { ...FRAME };
  } else {
    target = config.paper.canonPage;
    outBleed = borderless ? bleed : { ...FRAME };
  }
  return { target, bleed: outBleed, padWhite: !borderless, raster: !!raster };
}

// Resolve the ICC options for a job into a renderForPrint icc object. The
// client sends options.iccProfile = a profile id, '' / 'none' to disable, or
// omits it to use the server default. (options.icc === false also disables,
// for older clients.)
function resolveIcc(options) {
  const choice = options.iccProfile;
  if (options.icc === false || choice === '' || choice === 'none') return {};
  const list = config.icc.profiles;
  let entry = choice ? list.find((p) => p.id === choice) : null;
  if (!entry) entry = list.find((p) => p.id === config.icc.defaultId);
  if (!entry) return {};
  return { profile: entry.path, intent: config.icc.intent, quality: config.icc.quality };
}

// A job picks ONE mutually-exclusive color mode via options.colorMode:
//   'firmware'      → hand color to the printer (Auto Image Correction ON, the
//                     Canon app's "color correct"); no ICC pre-compensation.
//   'off' | ''      → no color management at all (raw sRGB, optimize OFF).
//   <profile id>    → convert into that ICC profile; optimize stays OFF so the
//                     profile characterizes a deterministic printer path.
// Returns { icc, imageOptimize } — the two levers are never both on: choosing an
// ICC forces firmware optimize off, and firmware mode skips the ICC. Falls back
// to the legacy options.iccProfile for older clients (always optimize OFF).
function resolveColor(options) {
  const mode = options.colorMode ?? options.iccProfile;
  if (mode === 'firmware') return { icc: {}, imageOptimize: true };
  return { icc: resolveIcc({ ...options, iccProfile: mode }), imageOptimize: false };
}

// Transport chosen per job. CPNP is the default (true full-bleed borderless).
// Firmware color-correct only exists on CPNP, so firmware mode forces it even
// if the server is configured for an IPP format. Explicit raster formats
// (pwg/urf) are honored except when firmware correction is requested.
function effectiveFormat(options) {
  const mode = options.colorMode ?? options.iccProfile;
  if (mode === 'firmware') return 'cpnp';
  return config.printFormat;
}

// Brightness as a modulate multiplier from options.brightness (percent, e.g.
// +20 → 1.20). Clamped to ±60%; 1 = neutral.
function brightnessFactor(options) {
  const pct = Math.max(-60, Math.min(60, Number(options.brightness) || 0));
  return 1 + pct / 100;
}

// Parse the multipart body of a print/preview request: the image + options.
async function parsePrintRequest(req) {
  let imageBuf = null;
  let options = {};
  for await (const part of req.parts()) {
    if (part.type === 'file' && part.fieldname === 'image') {
      imageBuf = await part.toBuffer();
    } else if (part.type === 'field' && part.fieldname === 'options') {
      options = JSON.parse(part.value); // caller catches
    }
  }
  return { imageBuf, options };
}

app.post('/api/print', async (req, reply) => {
  let imageBuf, options;
  try {
    ({ imageBuf, options } = await parsePrintRequest(req));
  } catch {
    return reply.code(400).send('bad options JSON');
  }
  if (!imageBuf) return reply.code(400).send('missing image');

  const copies = Math.min(Math.max(parseInt(options.copies, 10) || 1, 1), 99);
  // One mutually-exclusive color mode: an ICC profile, the printer's own
  // firmware auto-correct, or nothing. (Old clients: ICC on unless opted out.)
  const { icc, imageOptimize } = resolveColor(options);
  const transport = effectiveFormat(options);
  const brightness = brightnessFactor(options);
  const plan = buildRenderPlan(options, transport);
  const rotate = [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0;
  const crop = options.crop || null;
  const originalFmt = (await sharp(imageBuf).metadata().catch(() => ({}))).format;

  const job = enqueue(async (job) => {
    job.state = 'rendering';
    job.stateText = 'processing image…';
    job.progress = 1;

    if (transport === 'cpnp') {
      const cv = config.paper.canvas;
      const jpeg = await renderForPrint(imageBuf, {
        crop, rotate, target: plan.target, bleed: plan.bleed, padWhite: plan.padWhite, icc, brightness, output: 'jpeg',
      });
      await archivePrint(job.id, imageBuf, originalFmt, jpeg);
      const host = new URL(printerUrl()).hostname;
      for (let i = 0; i < copies; i++) {
        job.state = 'printing';
        job.stateText = copies > 1 ? `printing ${i + 1}/${copies}…` : 'printing…';
        await cpnpPrint(host, jpeg, {
          width: cv.h, // portrait after rotate
          height: cv.w,
          imageOptimize, // firmware 'color correct' — printer-side, no ICC
          onState: (s) => {
            job.stateText = 'printer: ' + s.replace(/^pass:/, '');
            const p = CPNP_PCT[s];
            // spread each sheet's 0-100 across its slice of the copy run
            if (p != null) job.progress = Math.max(job.progress, Math.round(((i + p / 100) / copies) * 100));
          },
        });
      }
      return;
    }

    const rendered = await renderForPrint(imageBuf, {
      crop, rotate, target: plan.target, bleed: plan.bleed, padWhite: plan.padWhite, icc, brightness,
      output: plan.raster ? 'raw' : 'jpeg',
    });
    if (plan.raster) {
      const r = RASTER[transport];
      const archiveJpeg = await sharp(rendered.rgb, { raw: { width: rendered.width, height: rendered.height, channels: 3 } })
        .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
        .toBuffer();
      await archivePrint(job.id, imageBuf, originalFmt, archiveJpeg);
      const data = r.encode(rendered.rgb, rendered.width, rendered.height);
      await printBuffer(job, data, { copies, format: r.mime });
    } else {
      await archivePrint(job.id, imageBuf, originalFmt, rendered);
      await printBuffer(job, rendered, { copies, format: 'image/jpeg' });
    }
  });

  return { jobId: job.id };
});

// Renders exactly what /api/print would send, but returns it as a viewable
// JPEG instead of printing — a no-paper diagnostic for crop, bleed and color.
// (For raster formats the bytes on the wire differ, but the pixels are these.)
app.post('/api/preview', async (req, reply) => {
  let imageBuf, options;
  try {
    ({ imageBuf, options } = await parsePrintRequest(req));
  } catch {
    return reply.code(400).send('bad options JSON');
  }
  if (!imageBuf) return reply.code(400).send('missing image');

  // Firmware mode has no ICC, so the preview shows the un-optimized image — the
  // printer's adaptive correction can't be reproduced client-side (see the note
  // in the editor). ICC/off modes preview exactly.
  const { icc } = resolveColor(options);
  const brightness = brightnessFactor(options);
  const plan = buildRenderPlan(options, effectiveFormat(options));
  const rotate = [0, 90, 180, 270].includes(options.rotate) ? options.rotate : 0;
  // Render to raw pixels (lossless; ICC via tificc) and encode the preview
  // ONCE, at the same near-lossless q100/4:4:4 as the print — otherwise a
  // second q90/4:2:0 pass would add chroma ringing the real print never has.
  const { rgb, width, height } = await renderForPrint(imageBuf, {
    crop: options.crop || null, rotate, target: plan.target, bleed: plan.bleed,
    padWhite: plan.padWhite, icc, brightness, output: 'raw',
  });
  const landscape = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .rotate(270) // print render is portrait (short edge first); show landscape
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4', progressive: false })
    .toBuffer();
  reply.header('cache-control', 'no-store');
  reply.type('image/jpeg');
  return landscape;
});

app.get('/api/jobs/:id', async (req, reply) => {
  const job = jobs.get(parseInt(req.params.id, 10));
  if (!job) return reply.code(404).send('unknown job');
  return { state: job.state, stateText: job.stateText, error: job.error, progress: job.progress };
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
        onState: (s) => {
          job.stateText = 'printer: ' + s.replace(/^pass:/, '');
          const p = CPNP_PCT[s];
          if (p != null) job.progress = Math.max(job.progress, p);
        },
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
      iccProfiles: config.icc.profiles.map((p) => p.id),
      iccDefault: config.icc.defaultId || '(none)',
      paper: config.paper.name,
      archive: config.archiveDir || '(off)',
    },
    'selphy-print up'
  );
});
