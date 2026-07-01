// All URLs in this app are relative so it works at any mount point
// (reverse-proxy root, path-prefix dev proxies, etc.).
import { inboxAdd, inboxAll, inboxDelete } from './db.js';

/* ---------- state ---------- */

// Filled from /api/config; sensible defaults so the UI works offline.
let paper = {
  name: 'Postcard 100×148mm',
  canvas: { w: 1872, h: 1248 },   // landscape orientation for the UI
  visible: { w: 1748, h: 1181 },
};

// Queue items: { id, blob, url, bitmap?, crop: {cx, cy, scale, rotate}, copies, state }
// crop.cx/cy = center of the crop window in image coordinates (of the rotated image),
// crop.scale = crop window width in image px (zoom), rotate = 0|90|180|270.
const queue = new Map();
let printing = false;

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const emptyState = $('empty-state');
const actionbar = $('actionbar');

/* ---------- boot ---------- */

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js');
}

try {
  new BroadcastChannel('selphy-share').onmessage = () => loadInbox();
} catch {}

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  await inboxAdd(files);
  await loadInbox();
});

$('btn-clear').addEventListener('click', async () => {
  if (printing) return;
  await inboxDelete([...queue.keys()]);
  for (const item of queue.values()) URL.revokeObjectURL(item.url);
  queue.clear();
  render();
});

$('btn-print').addEventListener('click', printAll);

fetchConfig();
drainServerInbox().then(() => loadInbox());
pollStatus();
setInterval(pollStatus, 10000);

// Tap the printer status to print a calibration page (mm rulers to measure
// the real overscan of your unit).
$('printer-status').addEventListener('click', async () => {
  if (!confirm('Print a calibration page? It uses one sheet of paper.')) return;
  try {
    const res = await fetch('api/calibrate', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    toast('Calibration page queued — read the first visible mm tick on each edge');
  } catch (err) {
    toast('Calibration failed: ' + err.message);
  }
});

// If the share POST hit the server instead of the service worker (first-ever
// share, SW update race), pull the files down into the local inbox.
async function drainServerInbox() {
  try {
    const res = await fetch('api/inbox');
    if (!res.ok) return;
    const { items } = await res.json();
    for (const it of items) {
      const blob = await (await fetch(`api/inbox/${it.id}`)).blob();
      await inboxAdd([new File([blob], it.name || 'shared.jpg', { type: blob.type })]);
      await fetch(`api/inbox/${it.id}`, { method: 'DELETE' });
    }
  } catch {}
}

async function fetchConfig() {
  try {
    const res = await fetch('api/config');
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.paper) paper = cfg.paper;
  } catch {}
}

async function loadInbox() {
  const items = await inboxAll();
  const addedIds = [];
  for (const rec of items) {
    if (queue.has(rec.id)) continue;
    queue.set(rec.id, {
      id: rec.id,
      blob: rec.blob,
      url: URL.createObjectURL(rec.blob),
      crop: null, // default: centered cover crop, computed on first edit/print
      rotate: 0,
      copies: 1,
      state: 'ready',
    });
    addedIds.push(rec.id);
  }
  render();
  // Single new image (single share / single add) → jump straight into crop.
  // Bulk arrivals stay in the queue.
  if (addedIds.length === 1) openEditor(queue.get(addedIds[0]));
}

/* ---------- queue rendering ---------- */

function render() {
  grid.textContent = '';
  const items = [...queue.values()];
  emptyState.hidden = items.length > 0;
  actionbar.hidden = items.length === 0;
  $('btn-clear').hidden = items.length === 0;

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.src = item.url;
    card.appendChild(img);

    if (item.copies > 1) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = item.copies + '×';
      card.appendChild(badge);
    }

    const rm = document.createElement('button');
    rm.className = 'remove';
    rm.textContent = '✕';
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (printing) return;
      await inboxDelete([item.id]);
      URL.revokeObjectURL(item.url);
      queue.delete(item.id);
      render();
    });
    card.appendChild(rm);

    if (item.state !== 'ready') {
      const st = document.createElement('div');
      st.className = 'state ' + item.state;
      st.textContent = item.stateText || item.state;
      card.appendChild(st);
    }

    card.addEventListener('click', () => !printing && openEditor(item));
    grid.appendChild(card);
  }

  const n = items.reduce((s, i) => s + i.copies, 0);
  $('btn-print').textContent = n <= 1 ? 'Print' : `Print all (${n})`;
}

/* ---------- crop editor ---------- */

const editor = $('editor');
const stage = $('editor-stage');
const canvas = $('editor-canvas');
const ctx = canvas.getContext('2d');
const frameEl = $('crop-frame');
const guideEl = $('overscan-guide');

let ed = null; // { item, bitmap, crop:{cx,cy,scale}, rotate, copies, frame:{x,y,w,h} }

async function openEditor(item) {
  const bitmap = await createImageBitmap(item.blob);
  ed = {
    item,
    bitmap,
    rotate: item.rotate,
    copies: item.copies,
    crop: item.crop ? { ...item.crop } : null,
  };
  editor.hidden = false;
  layoutEditor();
  if (!ed.crop) ed.crop = defaultCrop();
  clampCrop();
  draw();
  $('ed-copies').textContent = ed.copies + '×';
}

function rotatedSize() {
  const { width, height } = ed.bitmap;
  return ed.rotate % 180 === 0 ? { w: width, h: height } : { w: height, h: width };
}

function paperAspect() {
  return paper.canvas.w / paper.canvas.h; // landscape, e.g. 1872/1248
}

// Cover crop: largest paper-aspect window that fits in the image, centered.
function defaultCrop() {
  const img = rotatedSize();
  const a = paperAspect();
  let w = img.w;
  let h = w / a;
  if (h > img.h) {
    h = img.h;
    w = h * a;
  }
  return { cx: img.w / 2, cy: img.h / 2, scale: w };
}

function clampCrop() {
  const img = rotatedSize();
  const a = paperAspect();
  const maxW = Math.min(img.w, img.h * a);
  ed.crop.scale = Math.min(Math.max(ed.crop.scale, maxW / 8), maxW);
  const w = ed.crop.scale;
  const h = w / a;
  ed.crop.cx = Math.min(Math.max(ed.crop.cx, w / 2), img.w - w / 2);
  ed.crop.cy = Math.min(Math.max(ed.crop.cy, h / 2), img.h - h / 2);
}

function layoutEditor() {
  const r = stage.getBoundingClientRect();
  canvas.width = r.width * devicePixelRatio;
  canvas.height = r.height * devicePixelRatio;

  const a = paperAspect();
  const pad = 24;
  let fw = r.width - pad * 2;
  let fh = fw / a;
  if (fh > r.height - pad * 2) {
    fh = r.height - pad * 2;
    fw = fh * a;
  }
  const fx = (r.width - fw) / 2;
  const fy = (r.height - fh) / 2;
  ed.frame = { x: fx, y: fy, w: fw, h: fh };

  Object.assign(frameEl.style, {
    left: fx + 'px',
    top: fy + 'px',
    width: fw + 'px',
    height: fh + 'px',
  });
  // Overscan guide: the region of the print canvas that lands on visible paper.
  const ix = ((paper.canvas.w - paper.visible.w) / 2 / paper.canvas.w) * fw;
  const iy = ((paper.canvas.h - paper.visible.h) / 2 / paper.canvas.h) * fh;
  Object.assign(guideEl.style, {
    left: ix + 'px',
    top: iy + 'px',
    width: fw - 2 * ix + 'px',
    height: fh - 2 * iy + 'px',
  });
}

function draw() {
  const img = rotatedSize();
  const f = ed.frame;
  const scale = f.w / ed.crop.scale; // screen px per image px
  const h = ed.crop.scale / paperAspect();

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  // Map image coords -> screen: crop window (cx,cy,scale) fills the frame.
  ctx.translate(f.x - (ed.crop.cx - ed.crop.scale / 2) * scale, f.y - (ed.crop.cy - h / 2) * scale);
  ctx.scale(scale, scale);
  // Apply rotation about the rotated-image space.
  ctx.translate(img.w / 2, img.h / 2);
  ctx.rotate((ed.rotate * Math.PI) / 180);
  ctx.drawImage(ed.bitmap, -ed.bitmap.width / 2, -ed.bitmap.height / 2);
  ctx.restore();
}

/* pointer interaction: drag to pan, pinch/wheel to zoom */
const pointers = new Map();
let pinchStart = null;

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [p1, p2] = [...pointers.values()];
    pinchStart = { dist: Math.hypot(p1.x - p2.x, p1.y - p2.y), scale: ed.crop.scale };
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!ed || !pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size === 1) {
    const pxPerImg = ed.frame.w / ed.crop.scale;
    ed.crop.cx -= (e.clientX - prev.x) / pxPerImg;
    ed.crop.cy -= (e.clientY - prev.y) / pxPerImg;
  } else if (pointers.size === 2 && pinchStart) {
    const [p1, p2] = [...pointers.values()];
    const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    if (dist > 0) ed.crop.scale = (pinchStart.scale * pinchStart.dist) / dist;
  }
  clampCrop();
  draw();
});
const endPointer = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = null;
};
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener(
  'wheel',
  (e) => {
    if (!ed) return;
    e.preventDefault();
    ed.crop.scale *= e.deltaY > 0 ? 1.05 : 0.95;
    clampCrop();
    draw();
  },
  { passive: false }
);

window.addEventListener('resize', () => {
  if (!ed || editor.hidden) return;
  layoutEditor();
  clampCrop();
  draw();
});

$('ed-rotate').addEventListener('click', () => {
  ed.rotate = (ed.rotate + 90) % 360;
  ed.crop = defaultCrop();
  draw();
});
$('ed-copies-minus').addEventListener('click', () => {
  ed.copies = Math.max(1, ed.copies - 1);
  $('ed-copies').textContent = ed.copies + '×';
});
$('ed-copies-plus').addEventListener('click', () => {
  ed.copies = Math.min(99, ed.copies + 1);
  $('ed-copies').textContent = ed.copies + '×';
});
$('ed-cancel').addEventListener('click', closeEditor);
$('ed-done').addEventListener('click', () => {
  ed.item.crop = { ...ed.crop };
  ed.item.rotate = ed.rotate;
  ed.item.copies = ed.copies;
  closeEditor();
  render();
});

function closeEditor() {
  editor.hidden = true;
  ed?.bitmap.close();
  ed = null;
}

/* ---------- printing ---------- */

async function printAll() {
  if (printing || queue.size === 0) return;
  printing = true;
  $('btn-print').disabled = true;

  const border = $('opt-border').checked;
  let failed = 0;

  for (const item of queue.values()) {
    if (item.state === 'done') continue;
    item.state = 'printing';
    item.stateText = 'sending…';
    render();
    try {
      const crop = await cropForPrint(item);
      const form = new FormData();
      form.append('image', item.blob, 'photo.jpg');
      form.append(
        'options',
        JSON.stringify({
          crop,
          rotate: item.rotate,
          copies: item.copies,
          border,
        })
      );
      const res = await fetch('api/print', { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      const { jobId } = await res.json();
      item.stateText = 'printing…';
      render();
      await waitForJob(jobId, item);
      item.state = 'done';
      item.stateText = 'printed';
      await inboxDelete([item.id]);
    } catch (err) {
      failed++;
      item.state = 'error';
      item.stateText = String(err.message || err).slice(0, 80);
    }
    render();
  }

  printing = false;
  $('btn-print').disabled = false;
  toast(failed ? `${failed} print(s) failed — tap a photo for details` : 'All prints sent 🎉');
  // Drop successfully printed items from the visible queue.
  for (const [id, item] of [...queue.entries()]) {
    if (item.state === 'done') {
      URL.revokeObjectURL(item.url);
      queue.delete(id);
    }
  }
  render();
}

// Compute the crop rect in *original image* pixel coords (before rotation),
// as fractions, so the server can reproduce it exactly with sharp.
async function cropForPrint(item) {
  const bitmap = await createImageBitmap(item.blob);
  const saved = ed;
  ed = { bitmap, rotate: item.rotate, crop: item.crop ? { ...item.crop } : null };
  if (!ed.crop) ed.crop = defaultCrop();
  clampCrop();
  const img = rotatedSize();
  const w = ed.crop.scale;
  const h = w / paperAspect();
  const rect = {
    x: (ed.crop.cx - w / 2) / img.w,
    y: (ed.crop.cy - h / 2) / img.h,
    w: w / img.w,
    h: h / img.h,
  };
  bitmap.close();
  ed = saved;
  return rect;
}

async function waitForJob(jobId, item) {
  for (let i = 0; i < 900; i++) {
    const res = await fetch(`api/jobs/${jobId}`);
    if (!res.ok) throw new Error('lost track of job');
    const job = await res.json();
    if (job.state === 'done') return;
    if (job.state === 'error') throw new Error(job.error || 'print failed');
    item.stateText = job.stateText || 'printing…';
    render();
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('timed out waiting for printer');
}

/* ---------- printer status ---------- */

async function pollStatus() {
  const dot = $('status-dot');
  const text = $('status-text');
  try {
    const res = await fetch('api/printer');
    if (!res.ok) throw 0;
    const s = await res.json();
    dot.className = 'dot ' + (s.reachable ? (s.stateReasons?.length ? 'warn' : 'ok') : 'err');
    text.textContent = s.reachable
      ? `${s.name || 'SELPHY'}${s.stateReasons?.length ? ' — ' + s.stateReasons.join(', ') : ''}`
      : 'printer unreachable';
  } catch {
    dot.className = 'dot err';
    text.textContent = 'server offline';
  }
}

/* ---------- misc ---------- */

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}
