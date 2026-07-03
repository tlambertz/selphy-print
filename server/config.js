/* Configuration via environment variables (12-factor, Nix/Docker friendly). */

import path from 'node:path';
import { readdirSync } from 'node:fs';

const env = process.env;

/* Discover selectable ICC profiles: every *.icc in the profiles dir becomes a
 * choice the client can switch between per print (id = filename). ICC_PROFILE,
 * if set and outside the dir, is added too and becomes the default. */
function discoverIccProfiles() {
  const dir = env.ICC_DIR || path.join(process.cwd(), 'profiles');
  let list = [];
  try {
    list = readdirSync(dir)
      .filter((f) => /\.icc$/i.test(f))
      .sort()
      .map((f) => ({ id: f, name: f.replace(/\.icc$/i, ''), path: path.join(dir, f) }));
  } catch {
    /* no dir → no profiles */
  }
  if (env.ICC_PROFILE) {
    const base = path.basename(env.ICC_PROFILE);
    if (!list.some((p) => p.path === env.ICC_PROFILE || p.id === base)) {
      list.unshift({ id: base, name: base.replace(/\.icc$/i, ''), path: env.ICC_PROFILE });
    }
  }
  const defaultId = env.ICC_PROFILE ? path.basename(env.ICC_PROFILE) : list[0]?.id || null;
  return { list, defaultId };
}
const { list: iccProfiles, defaultId: iccDefaultId } = discoverIccProfiles();

/* Postcard KP-108IN geometry, all landscape px @300dpi.
 *
 * What is known for certain (IPP attributes + Gutenprint source):
 * - The IPP page for jpn_hagaki is 100×148 mm → 1748×1181 px @300dpi.
 *   A JPEG of exactly this size sent with print-scaling=none is imaged 1:1
 *   onto the page raster (PWG 5100.16) — no printer-side rescale decision.
 * - The dye-sub head canvas is larger (1872×1248 px = 105.66×158.5 mm,
 *   Gutenprint print-dyesub.c): in borderless mode the firmware ENLARGES the
 *   page raster onto that canvas, so content near the page edges lands beyond
 *   the paper and is trimmed.
 *
 * The per-edge trim ("overscan", in page-mm) is firmware behavior that varies
 * slightly per unit; defaults below come from community measurements and can
 * be overridden after printing the calibration page (which carries mm rulers
 * in page space, so the first visible tick per edge IS this number).
 */
const PAPERS = {
  postcard: {
    id: 'postcard',
    name: 'Postcard 100×148 mm (KP-108IN)',
    // physical page in mm (landscape: w = 148 ends-dimension, h = 100 sides)
    mm: { w: 148, h: 100 },
    // The physical KP-108IN sheet is 100×178 mm: a 15 mm tear-off stub
    // beyond a perforation at EACH END (left/right in landscape). There are
    // no stubs on the 100 mm sides — bleed there just runs off the paper.
    // The print head window covers the photo area plus a few mm into the
    // stubs, so the stubs are never fully inked; they exist to be torn off.
    sheet: { mm: { w: 178, h: 100 }, stubMm: 15 },
    // IPP page raster @300dpi — the render target for borderless
    page: { w: 1748, h: 1181 },
    // Full head canvas (Gutenprint print-dyesub.c). Measured on hardware
    // (CPNP calibration prints): the CP1500 firmware
    // aspect-FILL-scales any CPNP JPEG onto this canvas and centers it on
    // the physical sheet (a 1232×1800 test printed its 50 mm bars at 52 mm
    // = 1872/1800 exactly). Sending exactly this size ⇒ scale 1.0, fully
    // deterministic geometry. This is the CPNP render target.
    canvas: { w: 1872, h: 1248 },
    // Paper (100×148 mm) centered on the canvas at 11.835 px/mm: the canvas
    // extends past the paper by these px per edge — structural bleed that is
    // ALWAYS trimmed (ends = 148 mm edges, sides = 100 mm edges).
    canvasBleed: { ends: 60, sides: 32 },
    // Canon SELPHY Photo Layout renders postcard at ceil(mm * 11.835 px/mm)
    // = 1752 x 1184 (landscape); pixel_per_mm from the app's printer_support.json.
    // (The firmware then scales that by 1872/1752 ≈ 1.0685 onto the canvas.)
    canonPage: { w: 1752, h: 1184 },
    // printable area in bordered mode (printer default margins:
    // 2.5 mm sides, 3.7 mm ends → 140.6×95.0 mm)
    printable: { w: 1661, h: 1122 },
    // IPP media-size in 1/100 mm, portrait feed (x = short edge)
    media: { x: 10000, y: 14800 },
    mediaName: 'jpn_hagaki_100x148mm',
  },
};

/* Default borderless trim per edge in page-mm, in EDITOR orientation
 * (landscape page as shown in the crop UI; the calibration page prints the
 * letters T/B/L/R so readings are unambiguous). top/bottom are the 100 mm
 * "sides", left/right the 148 mm "ends".
 *
 * Theory (canvas/page arithmetic): uniform firmware enlargement loses
 * 3.31 mm per 100 mm-side and 4.90 mm per 148 mm-end; anisotropic stretch
 * would lose 2.68/4.90. Which one the firmware does is unmeasured — the
 * difference (~0.6 mm) is below the ±1 mm mechanical registration variance
 * units exhibit anyway (feed offset makes opposite ends differ by ~1–2 mm).
 *
 * On the PWG-raster + plain-media path the raster prints 1:1 with no
 * enlargement, so the expected trim is only mechanical registration
 * (~0–1.5 mm per edge). Defaults are a conservative 1 mm; measure with the
 * calibration page (entered in the UI, or via env:
 * OVERSCAN_MM="top,bottom,left,right", or symmetric
 * OVERSCAN_SIDES_MM/OVERSCAN_ENDS_MM). */
function parseOverscan() {
  if (env.OVERSCAN_MM) {
    const [top, bottom, left, right] = env.OVERSCAN_MM.split(',').map(Number);
    if ([top, bottom, left, right].every(isFinite)) return { top, bottom, left, right };
    throw new Error('OVERSCAN_MM must be four numbers: "top,bottom,left,right"');
  }
  // Measured on the reference CP1500 (calibration sheet):
  // top/bottom land exactly on the paper edge; the left mapping overshoots
  // its perforation by 0.5 mm (negative = window extends past the photo
  // boundary), the right falls 1 mm short of its perforation.
  return { top: 0, bottom: 0, left: -0.5, right: 1 };
}
const overscan = parseOverscan();

// Width of the blue overscan band that ends up visible on each END of the
// calibration sheet, in mm — literally "how many mm wide is the blue strip on
// that edge." (The blue zone is the structural canvas overhang; how much of it
// lands on the paper before running onto the tear-off stub is what you read.)
// Drives the editor's "prints past the tear line" visualization. Ends only
// (left/right): the 100 mm sides have no stub, so their blue runs straight off
// the paper (~0 mm visible) and needs no calibration.
function parseBlueWidth() {
  if (env.BLUE_MM) {
    const [left, right] = env.BLUE_MM.split(',').map(Number);
    if ([left, right].every(isFinite)) return { left, right };
    throw new Error('BLUE_MM must be two numbers: "left,right"');
  }
  // measured on the reference CP1500 (calibration sheet):
  // ~2 mm of blue visible on each end.
  return { left: 2, right: 2 };
}
const blueWidth = parseBlueWidth();

// White-border width per edge in mm, for "White border" mode (a plain white
// frame baked into the render — the CP1500 always prints borderless at the
// firmware level, so the border is entirely ours to size). `sides` = the 100 mm
// edges (editor top/bottom), `ends` = the 148 mm edges (editor left/right).
// Defaults are the IPP default printable margins (2.5 / 3.7 mm); Canon's app
// bakes a slightly wider frame — measure a bordered print and set BORDER_MM if
// you want to match it. The editor visualizes exactly this width.
function parseBorder() {
  if (env.BORDER_MM) {
    const [sides, ends] = env.BORDER_MM.split(',').map(Number);
    if ([sides, ends].every(isFinite)) return { sides, ends };
    throw new Error('BORDER_MM must be two numbers: "sides,ends"');
  }
  return { sides: 2.5, ends: 3.7 };
}
const border = parseBorder();

export const config = {
  port: parseInt(env.PORT || '8080', 10),
  host: env.HOST || '0.0.0.0',

  // e.g. "192.168.1.42" or "CP1500fa052c.local"
  printerHost: env.PRINTER_HOST || null,
  printerUrl: env.PRINTER_URL || null, // full override

  paper: PAPERS[env.PAPER || 'postcard'],
  overscan,
  blueWidth,
  border,

  icc: {
    // Selectable profiles (client picks per print; empty = no color management).
    profiles: iccProfiles, // [{ id, name, path }]
    defaultId: iccDefaultId, // id used when the client hasn't chosen
    // Relative colorimetric (with black-point compensation, always applied in
    // render.js) is the standard best default for photo printing: it leaves
    // in-gamut colors accurate and only remaps what's out of gamut, so smooth
    // gradients band less than under perceptual (measured: ~10% narrower bands).
    // Perceptual compresses the whole gamut — better only for heavily
    // out-of-gamut images. Override with ICC_INTENT.
    intent: env.ICC_INTENT || 'relative', // perceptual | relative | saturation | absolute
    // The head canvas is only 1248×1872, so file size is a non-issue on the
    // LAN — encode near-lossless (q100, 4:4:4) to keep dye-sub gradients clean.
    quality: parseInt(env.JPEG_QUALITY || '100', 10),
  },

  /* Transport. The borderless GEOMETRY is won in render.js by drawing at the
   * 1248×1872 head canvas so the head images it 1:1 (ink to the perforations) —
   * NOT by the transport. Measured on real hardware (2026-07-03): 'jpeg' with
   * print-scaling=fill genuinely enlarges a page-size raster ~7% (a 50 mm bar
   * printed 53.5 mm = 1872/1748) to reach the same coverage, but it loses
   * ~3-5 mm of image per edge and softens everything, so we render at canvas
   * size instead. The old "IPP JPEG can't do borderless / white bars at the
   * ends" note here was a misread — the white was the blank tear-off stubs
   * (full story in the README "borders thing").
   * - 'cpnp' (DEFAULT) = Canon's own protocol. Default NOT for geometry but
   *   because it's the ONLY transport that can invoke the printer's firmware
   *   color-correct (Auto Image Correction). Extras: per-pass progress, decoded
   *   errors, paper-out pause/resume. Firmware color mode forces this transport
   *   per job regardless of the setting.
   * - 'jpeg': plain IPP Print-Job with image/jpeg. Same canvas-size render;
   *   kept for experiments, no firmware color hook.
   * - 'urf'/'pwg' raster paths: URF prints bordered, PWG is rejected —
   *   experiments only. */
  printFormat: env.PRINT_FORMAT || 'cpnp',
  // 'borderless' (default): zero-margin media-col — the firmware maps the
  // JPEG onto its overscan rect, so renders are canvas-size with structural
  // bleed (true full bleed; feed offset buried in overscan, like CPNP).
  // 'plain': media keyword — image fits the bare paper rect 1:1; a ±1 mm
  // feed shift leaves a white sliver no image content can cover.
  mediaVariant: env.MEDIA_VARIANT || 'borderless',
  // 'fill' is NOT ignored — measured 2026-07-03 it enlarges the page raster
  // ~7% (50 mm bar → 53.5 mm) up to the head canvas. Lossy vs a canvas-size
  // render, so we leave it null and render at canvas size. Experiments only.
  printScaling: env.PRINT_SCALING || null,

  maxUploadMb: parseInt(env.MAX_UPLOAD_MB || '64', 10),

  // Every print is archived here as two files: the untouched upload and the
  // exact cropped/rendered image sent to the printer. Defaults to
  // ./print-archive next to the working dir; set PRINT_ARCHIVE_DIR to relocate,
  // or PRINT_ARCHIVE_DIR=off to disable. Disabled at runtime if the dir can't
  // be created (e.g. read-only FS).
  archiveDir:
    env.PRINT_ARCHIVE_DIR === 'off'
      ? null
      : env.PRINT_ARCHIVE_DIR || path.join(process.cwd(), 'print-archive'),
};

export function printerUrl() {
  if (config.printerUrl) return config.printerUrl;
  if (!config.printerHost) return null;
  return `ipp://${config.printerHost}:631/ipp/print`;
}
