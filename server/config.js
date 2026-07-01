/* Configuration via environment variables (12-factor, Nix/Docker friendly). */

const env = process.env;

// Postcard KP-108IN. Native spool canvas is exactly 2:3 (Gutenprint
// print-dyesub.c cp910_page); visible paper is the central 100×148 mm.
// The firmware overscans borderless prints onto the full canvas, so the
// crop UI uses `canvas` as the frame and `visible` as the safe-area guide.
const PAPERS = {
  postcard: {
    id: 'postcard',
    name: 'Postcard 100×148 mm (KP-108IN)',
    canvas: { w: 1872, h: 1248 }, // landscape px @300dpi
    visible: { w: 1748, h: 1181 },
    // IPP media-size in 1/100 mm, portrait feed (x = short edge)
    media: { x: 10000, y: 14800 },
  },
};

export const config = {
  port: parseInt(env.PORT || '8080', 10),
  host: env.HOST || '0.0.0.0',

  // e.g. "192.168.1.42" or "CP1500fa052c.local"
  printerHost: env.PRINTER_HOST || null,
  printerUrl: env.PRINTER_URL || null, // full override

  paper: PAPERS[env.PAPER || 'postcard'],

  icc: {
    profile: env.ICC_PROFILE || null, // absolute path to .icc, empty = no color management
    intent: env.ICC_INTENT || 'perceptual', // perceptual | relative | saturation | absolute
    quality: parseInt(env.JPEG_QUALITY || '95', 10),
  },

  // 'fill' guarantees full-bleed; the printer rescales onto its overscan
  // canvas regardless. 'none' would print 1:1 at 300dpi.
  printScaling: env.PRINT_SCALING || 'fill',

  maxUploadMb: parseInt(env.MAX_UPLOAD_MB || '64', 10),
};

export function printerUrl() {
  if (config.printerUrl) return config.printerUrl;
  if (!config.printerHost) return null;
  return `ipp://${config.printerHost}:631/ipp/print`;
}
