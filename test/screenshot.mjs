/* Screenshot tour of the UI: empty state, queue, editor. Usage:
   node test/screenshot.mjs [baseUrl] [outDir]  */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { writeFile, mkdir, rm } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:8080/';
const OUT = process.argv[3] || '/tmp/shots';
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2 });
const failures = [];
page.on('console', (m) => m.type() === 'error' && failures.push(m.text()));
page.on('pageerror', (e) => failures.push(String(e)));
page.on('requestfailed', (r) => failures.push('REQ FAIL ' + r.url()));
page.on('response', (r) => r.status() >= 400 && failures.push(`HTTP ${r.status()} ${r.url()}`));

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.evaluate(async () => {
  const db = await import('./db.js');
  await db.inboxClear();
  const { items } = await (await fetch('api/inbox')).json();
  for (const it of items) await fetch(`api/inbox/${it.id}`, { method: 'DELETE' });
});
await page.reload({ waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: OUT + '/1-empty.png' });

// seed three photo-ish images
const mk = (w, h, hue) =>
  sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${hue + 60},60%,35%)"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${w * 0.7}" cy="${h * 0.3}" r="${h * 0.12}" fill="#fff" opacity="0.85"/>
    <path d="M0 ${h * 0.75} L${w * 0.3} ${h * 0.45} L${w * 0.55} ${h * 0.65} L${w * 0.8} ${h * 0.4} L${w} ${h * 0.6} V${h} H0 Z" fill="#122" opacity="0.6"/>
  </svg>`)
  ).jpeg().toBuffer();
await writeFile('/tmp/s1.jpg', await mk(2400, 1600, 10));
await writeFile('/tmp/s2.jpg', await mk(1600, 2400, 160));
await writeFile('/tmp/s3.jpg', await mk(2000, 2000, 260));

const input = await page.$('#file-input');
await input.uploadFile('/tmp/s1.jpg', '/tmp/s2.jpg', '/tmp/s3.jpg');
await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 3);
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: OUT + '/2-queue.png' });

await page.click('#grid .card');
await page.waitForFunction(() => !document.getElementById('editor').hidden);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: OUT + '/3-editor.png' });
await page.click('#ed-done');

// desktop width
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: OUT + '/4-desktop.png' });

console.log('failures:', failures.length ? failures : 'none');
await browser.close();
await rm('/tmp/s1.jpg', { force: true });
await rm('/tmp/s2.jpg', { force: true });
await rm('/tmp/s3.jpg', { force: true });
console.log('shots in', OUT);
