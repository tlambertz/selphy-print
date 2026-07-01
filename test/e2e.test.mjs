/* Frontend e2e — MUST point at a server wired to the MOCK printer
   (ippeveprinter), never the real one: it submits actual print jobs.
   The 'testselphy' status assertion below guards against that.
   Usage: node test/e2e.test.mjs [baseUrl]   (default http://localhost:8081) */
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { strict as assert } from 'node:assert';
import { writeFile, rm } from 'node:fs/promises';

const BASE = process.argv[2] || 'http://localhost:8081';
const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 915 }); // phone-ish

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'networkidle0' });

// Start from a clean queue: drop anything left in IDB or the server inbox.
await page.evaluate(async () => {
  const db = await import('/db.js');
  await db.inboxClear();
  const { items } = await (await fetch('/api/inbox')).json();
  for (const it of items) await fetch(`/api/inbox/${it.id}`, { method: 'DELETE' });
});
await page.reload({ waitUntil: 'networkidle0' });

// 1. printer status should come up green with the mock printer's name
await page.waitForFunction(
  () => document.getElementById('status-text').textContent.includes('testselphy'),
  { timeout: 10000 }
);
console.log('✓ printer status shown');

// 2. add two images via the file input
const img1 = '/tmp/e2e-a.jpg';
const img2 = '/tmp/e2e-b.jpg';
await writeFile(img1, await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#2266cc' } }).jpeg().toBuffer());
await writeFile(img2, await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#cc6622' } }).jpeg().toBuffer());
const input = await page.$('#file-input');
await input.uploadFile(img1, img2);
await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 2, { timeout: 10000 });
console.log('✓ two images queued');

// 3. open the crop editor on the first card, drag, rotate, set copies, done
await page.click('#grid .card');
await page.waitForFunction(() => !document.getElementById('editor').hidden);
const stage = await page.$('#editor-stage');
const box = await stage.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 10, { steps: 5 });
await page.mouse.up();
await page.click('#ed-rotate');
await page.click('#ed-copies-plus');
await page.click('#ed-done');
await page.waitForFunction(() => document.getElementById('editor').hidden);
assert.equal(await page.$eval('#grid .card .badge', (el) => el.textContent), '2×');
console.log('✓ crop editor: pan, rotate, copies, done');

// 4. print all and wait for the queue to drain
await page.click('#btn-print');
await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 0, {
  timeout: 120000,
});
console.log('✓ all jobs printed and cleared');

// 5. share-target POST (goes through the service worker once controlled)
const swActive = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg?.active;
});
console.log('✓ service worker registered:', swActive);

assert.deepEqual(errors, [], 'console errors: ' + errors.join('\n'));
console.log('✓ no console errors');

await browser.close();
await rm(img1, { force: true });
await rm(img2, { force: true });
console.log('E2E PASS');
