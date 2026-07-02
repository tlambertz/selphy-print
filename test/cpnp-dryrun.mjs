/* Paper-free CPNP dry run: session → startSpool → data transfer, reading
   every result code, but STOPPING before executeSpoolPrint (no paper feeds
   until execute). Tries type-constant candidates until startSpool is accepted.
   Usage: node test/cpnp-dryrun.mjs <printer-ip> */
import sharp from 'sharp';
import { cpnpPrint } from '../server/cpnp.js';

const host = process.argv[2] || '192.168.1.240';

// A real postcard-size JPEG (1752×1184 = ceil(mm * 11.835)), portrait feed.
const jpeg = await sharp({
  create: { width: 1184, height: 1752, channels: 3, background: '#4488cc' },
})
  .jpeg({ quality: 90 })
  .toBuffer();
console.log('test JPEG:', jpeg.length, 'bytes, 1184×1752');

// Candidate (typePrint, typeJpeg) pairs to try — 0/0 first, then small magics.
const candidates = [
  [0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [1, 2], [0x10000, 0x20000],
];

for (const [typePrint, typeJpeg] of candidates) {
  process.stdout.write(`try typePrint=${typePrint} typeJpeg=${typeJpeg} … `);
  try {
    const r = await cpnpPrint(host, jpeg, {
      width: 1184,
      height: 1752,
      typePrint,
      typeJpeg,
      dryRun: true,
      onState: () => {},
    });
    console.log(`startSpool=${r.results.startSpool} data=${r.results.data} → ACCEPTED ✓ (no paper used)`);
    console.log('\nWINNER:', { typePrint, typeJpeg });
    process.exit(0);
  } catch (e) {
    console.log('rejected:', e.message);
    await new Promise((s) => setTimeout(s, 800)); // let the printer settle
  }
}
console.log('\nNo candidate accepted — need to inspect result codes / framing.');
process.exit(1);
