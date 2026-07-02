/* Configuration via environment variables (12-factor, Nix/Docker friendly). */

const env = process.env;

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
    // IPP page raster @300dpi — the render target for borderless
    page: { w: 1748, h: 1181 },
    // full head canvas (Gutenprint print-dyesub.c) — diagnostic raster size
    canvas: { w: 1872, h: 1248 },
    // printable area in bordered mode (printer default margins:
    // 2.5 mm sides, 3.7 mm ends → 140.6×95.0 mm)
    printable: { w: 1661, h: 1122 },
    // IPP media-size in 1/100 mm, portrait feed (x = short edge)
    media: { x: 10000, y: 14800 },
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
 * These values are only meaningful for the print-scaling mode they were
 * measured under ('fill', the default — see printScaling below). Theory for
 * 'fill' (uniform enlargement onto the canvas): sides 3.3 mm, ends 4.9 mm
 * per edge, ± the unit's feed offset. Per-unit truth comes from the
 * calibration page (entered in the UI, or via env:
 * OVERSCAN_MM="top,bottom,left,right", or symmetric
 * OVERSCAN_SIDES_MM/OVERSCAN_ENDS_MM). */
function parseOverscan() {
  if (env.OVERSCAN_MM) {
    const [top, bottom, left, right] = env.OVERSCAN_MM.split(',').map(Number);
    if ([top, bottom, left, right].every(isFinite)) return { top, bottom, left, right };
    throw new Error('OVERSCAN_MM must be four numbers: "top,bottom,left,right"');
  }
  const sides = parseFloat(env.OVERSCAN_SIDES_MM || '3.3');
  const ends = parseFloat(env.OVERSCAN_ENDS_MM || '4.9');
  return { top: sides, bottom: sides, left: ends, right: ends };
}
const overscan = parseOverscan();

export const config = {
  port: parseInt(env.PORT || '8080', 10),
  host: env.HOST || '0.0.0.0',

  // e.g. "192.168.1.42" or "CP1500fa052c.local"
  printerHost: env.PRINTER_HOST || null,
  printerUrl: env.PRINTER_URL || null, // full override

  paper: PAPERS[env.PAPER || 'postcard'],
  overscan,

  icc: {
    profile: env.ICC_PROFILE || null, // absolute path to .icc, empty = no color management
    intent: env.ICC_INTENT || 'perceptual', // perceptual | relative | saturation | absolute
    quality: parseInt(env.JPEG_QUALITY || '95', 10),
  },

  // Empirically (measured on a real CP1500): 'none' places the raster 1:1
  // centered on the head canvas — sides get shaved ~2.8 mm (canvas is wider
  // than the paper) but the ends STOP at the tear-off perforations ± feed
  // offset, leaving white bars: true borderless is impossible with 'none'.
  // 'fill' engages the firmware's borderless enlargement (~7%), which the
  // calibration/pre-compensation machinery models. Calibration pages are
  // printed with the same mode, so measurements stay consistent.
  printScaling: env.PRINT_SCALING || 'fill',

  maxUploadMb: parseInt(env.MAX_UPLOAD_MB || '64', 10),
};

export function printerUrl() {
  if (config.printerUrl) return config.printerUrl;
  if (!config.printerHost) return null;
  return `ipp://${config.printerHost}:631/ipp/print`;
}
