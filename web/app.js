// All URLs in this app are relative so it works at any mount point
// (reverse-proxy root, path-prefix dev proxies, etc.).
import { inboxAdd, inboxAll, inboxDelete, inboxUpdate } from './db.js';

/* ---------- state ---------- */

// Filled from /api/config; sensible defaults so the UI works offline.
// `page` is the raster we send (imaged 1:1); the safe-area guide insets by
// the firmware's borderless trim, measured in page-mm per edge.
let paper = {
  name: 'Postcard 100×148mm',
  mm: { w: 148, h: 100 },
  page: { w: 1748, h: 1181 }, // landscape px @300dpi
  // physical sheet: 15 mm tear-off stub past a perforation at each end
  sheet: { mm: { w: 178, h: 100 }, stubMm: 15 },
};
// Per-edge trim in page-mm, in editor orientation (matches the T/B/L/R
// letters printed on the calibration page). On the raster path prints are
// 1:1, so this is only mechanical registration (~1 mm). Calibratable.
// Measured reference defaults; negative = the mapping overshoots the paper
// boundary on that edge. Overridden by /api/config, then by localStorage.
let overscan = { top: 0, bottom: 0, left: -0.5, right: 1 };
// Width of the blue overscan band visible on each end of the calibration
// sheet (mm) — read straight off the sheet; drives the editor's tear-strip
// zones. Ends only; the 100 mm sides have no stub (blue runs off, ~0 mm).
let blueWidth = { left: 2, right: 2 };
// Transport geometry: overscanning modes (cpnp; ipp jpeg with the
// borderless media variant) put ink a few mm past the tear line; plain ipp
// jpeg aspect-fits the paper rect (ink stops ≈ at the tear line).
let printFormat = 'cpnp';
let mediaVariant = 'borderless';

const OVERSCAN_KEY = 'selphy-overscan-v4';
const EDGES = ['top', 'bottom', 'left', 'right'];
function savedCal() {
  try {
    return JSON.parse(localStorage.getItem(OVERSCAN_KEY)) || {};
  } catch {
    return {};
  }
}
function effectiveOverscan() {
  const saved = savedCal();
  return EDGES.every((e) => isFinite(saved[e])) ? saved : overscan;
}
function effectiveBlueWidth() {
  const saved = savedCal();
  return isFinite(saved.blueLeft) && isFinite(saved.blueRight)
    ? { left: saved.blueLeft, right: saved.blueRight }
    : blueWidth;
}

// Color mode is PER IMAGE (like crop/rotate/border): 'firmware' (let the
// printer auto-correct), '' (off), or an ICC profile id — stored on each queue
// item as item.color. The Settings dropdown only sets the DEFAULT applied to
// newly-added photos.
let iccProfiles = []; // [{id,name}] from the server
let iccDefault = null; // server default id
const COLOR_KEY = 'selphy-color-default'; // default color mode for NEW photos
const LEGACY_COLOR_KEY = 'selphy-icc-profile'; // pre-per-image global value
const FIRMWARE = 'firmware';
// Default color mode for newly-added photos (set in Settings; falls back to the
// old global value, then the server's default profile).
function colorDefault() {
  const saved = localStorage.getItem(COLOR_KEY) ?? localStorage.getItem(LEGACY_COLOR_KEY);
  return saved !== null ? saved : (iccDefault || '');
}
// Short chip label for a mode value.
function colorLabel(value) {
  if (value === FIRMWARE) return 'Canon firmware';
  if (value === '' || value === 'none') return 'Off';
  const p = iccProfiles.find((p) => p.id === value);
  // profile names like "CP1500-farbenwerk" → "farbenwerk" for a compact chip
  return p ? (p.name.split(/[-_]/).pop() || p.name) : value;
}
// Ordered list of selectable modes: firmware first, then each ICC profile,
// then off — exactly the "Canon firmware, ICC A, ICC B" spectrum.
function colorModes() {
  const modes = [
    { value: FIRMWARE, label: 'Canon firmware', title: 'Let the printer auto-correct color in firmware (the Canon app’s "color correct"). No ICC — preview shows the un-optimized image.' },
  ];
  for (const p of iccProfiles) {
    modes.push({ value: p.id, label: colorLabel(p.id), title: 'ICC profile: ' + p.name + (p.id === iccDefault ? ' (default)' : '') + '. Firmware auto-correct is turned off so the profile stays deterministic.' });
  }
  modes.push({ value: '', label: 'Off', title: 'No color management: raw sRGB, firmware auto-correct off.' });
  return modes;
}
// Refresh both surfaces: editor chips reflect the CURRENT photo (ed.color); the
// settings dropdown reflects the default for new photos.
function syncColorControls() {
  populateColorChips();
  const sel = $('opt-icc');
  if (sel && sel.options.length) sel.value = colorDefault();
}
// Editor chip → set THIS photo's color; re-render an open preview so A/B is live.
function setItemColor(value) {
  if (!ed) return;
  ed.color = value;
  populateColorChips();
  if (!$('preview-modal').hidden) showPreview();
}
// Brightness (percent, per device): brightens before ICC. 0 = neutral.
const BRIGHT_KEY = 'selphy-brightness';
function brightnessVal() {
  return parseInt(localStorage.getItem(BRIGHT_KEY) || '0', 10) || 0;
}
function syncBright() {
  const v = brightnessVal();
  $('opt-bright').value = v;
  $('opt-bright-val').textContent = (v > 0 ? '+' : '') + v + '%';
}

function populateIccSelect() {
  const sel = $('opt-icc');
  const note = $('icc-note');
  sel.innerHTML = '';
  sel.disabled = false;
  // Canon firmware works with zero profiles; ICC choices need profiles present.
  sel.add(new Option('Canon firmware (printer auto-correct)', FIRMWARE));
  for (const p of iccProfiles) {
    sel.add(new Option('ICC · ' + p.name + (p.id === iccDefault ? ' (default)' : ''), p.id));
  }
  sel.add(new Option('Off — no color management', ''));
  sel.value = colorDefault();
  note.textContent = iccProfiles.length
    ? 'Default for new photos. Each photo’s color is set per-image in the crop editor (chips under the photo) and shown in its Preview.'
    : 'Default for new photos. No ICC profiles on the server — drop .icc files in profiles/ and restart. Canon firmware auto-correct still works.';
}

// Editor chip row mirroring the settings dropdown — the color spectrum right
// where you crop. One active at a time (mutually exclusive by construction).
function populateColorChips() {
  const wrap = $('ed-color');
  if (!wrap) return;
  const active = ed ? ed.color : colorDefault();
  wrap.innerHTML = '';
  for (const m of colorModes()) {
    const btn = document.createElement('button');
    btn.className = 'btn chip color-chip';
    btn.dataset.color = m.value;
    btn.textContent = m.label;
    btn.title = m.title;
    btn.setAttribute('aria-pressed', String(m.value === active));
    wrap.appendChild(btn);
  }
  const note = $('ed-color-note');
  if (note) {
    note.textContent =
      active === FIRMWARE
        ? 'Printer optimizes color in firmware (prints via CPNP) — preview shows the un-optimized image.'
      : active === '' || active === 'none' ? 'No color management — preview is exact.'
      : 'ICC “' + colorLabel(active) + '” — preview is exact.';
  }
}

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

/* ---------- "Add to home screen" ----------
   Show an Install button only when the app is running in a browser tab (not
   already installed). Chromium fires beforeinstallprompt and lets us trigger
   the native prompt; iOS Safari never does, so there we show the manual
   "Share → Add to Home Screen" steps. */
(() => {
  const btn = $('btn-install');
  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true; // iOS
  const isIOS =
    /iph|ipod|ipad/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
  let deferred = null;

  if (standalone()) return; // already installed — never show the button

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // keep the mini-infobar from auto-showing; use our button
    deferred = e;
    btn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    btn.hidden = true;
    toast('Installed — find Selphy Print on your home screen');
  });

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') btn.hidden = true;
    } else if (isIOS) {
      toast("Tap the Share icon, then 'Add to Home Screen'");
    } else {
      toast('Use your browser menu → Install app / Add to Home screen');
    }
  });

  // iOS gives no install event, so surface the button (with manual steps) up front.
  if (isIOS) btn.hidden = false;
})();

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

// Printer sheet: status details + borderless-trim calibration.
$('printer-status').addEventListener('click', () => {
  const os = effectiveOverscan();
  const bw = effectiveBlueWidth();
  for (const e of EDGES) $('cal-' + e).value = os[e];
  $('cal-blue-left').value = bw.left;
  $('cal-blue-right').value = bw.right;
  $('cal-defaults').textContent =
    EDGES.map((e) => `${e[0].toUpperCase()} ${overscan[e]}`).join(' · ') +
    ` · blue ${blueWidth.left}/${blueWidth.right} mm`;
  populateIccSelect();
  syncBright();
  $('settings-printer').textContent = $('status-text').textContent;
  // load the calibration preview lazily, only when the sheet opens
  const img = document.querySelector('#cal-preview img');
  if (!img.src) img.src = 'api/calibrate/preview';
  $('settings').hidden = false;
});
$('settings-close').addEventListener('click', () => ($('settings').hidden = true));
document.querySelector('.sheet-backdrop').addEventListener('click', () => ($('settings').hidden = true));

$('btn-calibrate').addEventListener('click', async () => {
  if (!confirm('Print the calibration page? It uses one sheet of paper.')) return;
  try {
    const res = await fetch('api/calibrate', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    toast('Calibration page queued');
  } catch (err) {
    toast('Calibration failed: ' + err.message);
  }
});

$('cal-save').addEventListener('click', () => {
  const values = {};
  for (const e of EDGES) values[e] = parseFloat($('cal-' + e).value);
  values.blueLeft = parseFloat($('cal-blue-left').value);
  values.blueRight = parseFloat($('cal-blue-right').value);
  if (!EDGES.every((e) => isFinite(values[e]) && values[e] >= -5 && values[e] <= 12)) {
    toast('Edge values must be between -5 and 12 mm');
    return;
  }
  if (![values.blueLeft, values.blueRight].every((v) => isFinite(v) && v >= 0 && v <= 8)) {
    toast('Blue region width must be between 0 and 8 mm');
    return;
  }
  localStorage.setItem(OVERSCAN_KEY, JSON.stringify(values));
  $('settings').hidden = true;
  toast('Calibration updated for this device');
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
    if (cfg.overscan) overscan = cfg.overscan;
    if (cfg.blueWidth) blueWidth = cfg.blueWidth;
    if (cfg.icc) { iccProfiles = cfg.icc.profiles || []; iccDefault = cfg.icc.defaultId || null; }
    if (cfg.printFormat) printFormat = cfg.printFormat;
    if (cfg.mediaVariant) mediaVariant = cfg.mediaVariant;
    syncColorControls(); // profiles just arrived — refresh chips/dropdown
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
      // Edit settings persisted per record (survive refresh); defaults if unset.
      crop: rec.crop || null, // {cx,cy,scale} or null = centered cover crop
      rotate: rec.rotate || 0,
      copies: rec.copies || 1,
      border: !!rec.border, // per-image white border (else edge-to-edge)
      color: rec.color ?? colorDefault(), // per-image color mode
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
    // Thumbnail shows exactly what prints: the crop, rotation and (if set) the
    // white border — not the raw upload.
    const canvas = document.createElement('canvas');
    canvas.width = 592;
    canvas.height = 400; // 592/400 = 1.48 = postcard page aspect
    canvas.className = 'card-canvas';
    card.appendChild(canvas);
    paintThumb(canvas, item);

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
      item._bmp?.close?.();
      queue.delete(item.id);
      render();
    });
    card.appendChild(rm);

    if (item.state !== 'ready') {
      // Top progress bar for active jobs — determinate from the printer's pass
      // (CPNP), else an indeterminate sweep.
      if (item.state === 'queued' || item.state === 'rendering' || item.state === 'printing') {
        const bar = document.createElement('div');
        bar.className = 'progress' + (item.progress ? '' : ' indet');
        const fill = document.createElement('div');
        fill.className = 'progress-fill';
        if (item.progress) fill.style.width = item.progress + '%';
        bar.appendChild(fill);
        card.appendChild(bar);
      }
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

// Paint a card thumbnail = the paper (page aspect) showing the item's crop,
// rotation and white-border setting — i.e. what the print will look like.
// Mirrors the editor's draw() mapping (crop window → the photo rect).
async function paintThumb(canvas, item) {
  const bmp = item._bmp || (item._bmp = await createImageBitmap(item.blob));
  const ctx = canvas.getContext('2d');
  const cw = canvas.width, ch = canvas.height;
  const a = paperAspect();
  const rot = item.rotate || 0;
  const rw = rot % 180 === 0 ? bmp.width : bmp.height;
  const rh = rot % 180 === 0 ? bmp.height : bmp.width;
  // crop window in rotated-image px (fall back to centered cover)
  let sw, sh, cx, cy;
  if (item.crop) { sw = item.crop.scale; sh = sw / a; cx = item.crop.cx; cy = item.crop.cy; }
  else { sw = Math.min(rw, rh * a); sh = sw / a; cx = rw / 2; cy = rh / 2; }

  ctx.clearRect(0, 0, cw, ch);
  // White border ≈ 2.5 mm/100 = 3.7 mm/148 ⇒ a uniform ~2.5% inset each edge.
  const ins = item.border ? 0.025 : 0;
  if (item.border) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
  const dx = ins * cw, dy = ins * ch, dw = cw - 2 * dx, dh = ch - 2 * dy;

  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  const scale = dw / sw; // dest px per rotated-image px
  ctx.translate(dx - (cx - sw / 2) * scale, dy - (cy - sh / 2) * scale);
  ctx.scale(scale, scale);
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  ctx.restore();
}

/* ---------- crop editor ---------- */

const editor = $('editor');
const stage = $('editor-stage');
const canvas = $('editor-canvas');
const ctx = canvas.getContext('2d');
const frameEl = $('crop-frame');


let ed = null; // { item, bitmap, crop:{cx,cy,scale}, rotate, copies, frame:{x,y,w,h} }

async function openEditor(item) {
  const bitmap = await createImageBitmap(item.blob);
  ed = {
    item,
    bitmap,
    rotate: item.rotate,
    copies: item.copies,
    border: !!item.border,
    color: item.color ?? colorDefault(),
    crop: item.crop ? { ...item.crop } : null,
  };
  editor.hidden = false;
  syncBorderBtn();
  populateColorChips();
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
  return paper.page.w / paper.page.h; // landscape, e.g. 1748/1181 (= 148/100)
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
  // Reserve room for the tear-off stubs (15 mm past a perforation at each
  // END of the physical sheet; the sides have none) so the sheet context
  // always fits the stage.
  const stubMm = paper.sheet?.stubMm ?? 15;
  const stubFrac = stubMm / paper.mm.w;
  let fw = (r.width - pad * 2) / (1 + 2 * stubFrac);
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
  // Three-zone sheet visualization. Screen px per mm:
  const mmX = fw / paper.mm.w;
  const mmY = fh / paper.mm.h;
  const stubW = stubFrac * fw;
  // How far ink prints past the tear line onto the stub. On one axis (mm
  // inward from the nominal edge, blue is negative): the tear line sits at
  // `overscan`, ink stops at `-blueWidth`, so the inked strip past the tear
  // = overscan - (-blueWidth) = blueWidth + overscan. (overscan may be
  // negative when the tear line falls in the blue.) Plain media has no
  // overscan; only the ~registration overlap remains.
  const ov = effectiveOverscan();
  const bw = effectiveBlueWidth();
  const overscans = printFormat === 'cpnp' || mediaVariant === 'borderless';
  const overL = overscans ? Math.max(0, bw.left + ov.left) : 1;
  const overR = overscans ? Math.max(0, bw.right + ov.right) : 1;
  const tornL = overL * mmX;
  const tornR = overR * mmX;
  const rect = (id, x, y, w, h) =>
    Object.assign($(id).style, { left: x + 'px', top: y + 'px', width: Math.max(0, w) + 'px', height: Math.max(0, h) + 'px' });

  // layer 3 — never reaches paper: everything outside frame + torn strips
  rect('dim-t', 0, 0, r.width, fy);
  rect('dim-b', 0, fy + fh, r.width, r.height - fy - fh);
  rect('dim-l', 0, fy, fx - tornL, fh);
  rect('dim-r', fx + fw + tornR, fy, r.width - fx - fw - tornR, fh);
  // hatched paper for the un-inked remainder of each 15 mm stub
  rect('stub-left', fx - stubW, fy, stubW - tornL, fh);
  rect('stub-right', fx + fw + tornR, fy, stubW - tornR, fh);
  // layer 2 — prints past the tear line, torn off with the stub
  rect('torn-l', fx - tornL, fy, tornL, fh);
  rect('torn-r', fx + fw, fy, tornR, fh);
  // Feed registration: the tear/edge lands within ±1 mm of the frame edge —
  // drawn OUTSIDE the frame. Ink always overlaps the tear line (no white
  // ever); what varies is which content sits at the tear.
  const TOLERANCE_MM = 1;
  rect('edge-guide', fx - TOLERANCE_MM * mmX, fy - TOLERANCE_MM * mmY,
    fw + 2 * TOLERANCE_MM * mmX, fh + 2 * TOLERANCE_MM * mmY);
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

// Fill presets: set the zoom so the photo fills the paper with a chosen bleed
// margin — mm of REAL image content pushed past every paper edge. 0 = cover
// crop, edges flush (the most photo kept); >0 zooms in just enough that the
// crop is inset from the image by that margin, so the printer bleeds genuine
// image (not a mirror/white sliver) under the ±1 mm feed drift. maxW is the
// cover-crop scale; magnifying by (shortHalf+m)/shortHalf overflows the short
// paper edge by exactly m mm (the long edge gets proportionally more), so
// every side clears m mm. Framing center is preserved.
function fillWithBleed(marginMm) {
  const img = rotatedSize();
  const maxW = Math.min(img.w, img.h * paperAspect()); // cover-crop scale
  const shortHalf = Math.min(paper.mm.w, paper.mm.h) / 2; // 50 mm on postcard
  ed.crop.scale = maxW * (shortHalf / (shortHalf + marginMm));
  clampCrop();
  draw();
}
$('ed-fill-max').addEventListener('click', () => fillWithBleed(0));
$('ed-fill-bleed').addEventListener('click', () => fillWithBleed(1));

function syncBorderBtn() {
  const b = $('ed-border');
  b.setAttribute('aria-pressed', ed.border ? 'true' : 'false');
  b.classList.toggle('active', ed.border);
}
$('ed-border').addEventListener('click', () => {
  ed.border = !ed.border;
  syncBorderBtn();
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
// Settings dropdown sets the DEFAULT color mode for newly-added photos.
$('opt-icc').addEventListener('change', (e) => {
  localStorage.setItem(COLOR_KEY, e.target.value);
});
// Editor color chips set THIS photo's color (event-delegated; rebuilt on open).
$('ed-color').addEventListener('click', (e) => {
  const btn = e.target.closest('.color-chip');
  if (btn) setItemColor(btn.dataset.color);
});
$('opt-bright').addEventListener('input', (e) => {
  localStorage.setItem(BRIGHT_KEY, e.target.value);
  $('opt-bright-val').textContent = (e.target.value > 0 ? '+' : '') + e.target.value + '%';
});

// Crop rect (image fractions) for the LIVE editor state — mirrors cropForPrint.
function currentCropRect() {
  clampCrop();
  const img = rotatedSize();
  const w = ed.crop.scale;
  const h = w / paperAspect();
  return { x: (ed.crop.cx - w / 2) / img.w, y: (ed.crop.cy - h / 2) / img.h, w: w / img.w, h: h / img.h };
}

// Render the exact bytes the printer would get and show them — no paper.
async function showPreview() {
  if (!ed) return;
  const btn = $('ed-preview');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Rendering…';
  try {
    const form = new FormData();
    form.append('image', ed.item.blob, 'photo.jpg');
    form.append('options', JSON.stringify({
      crop: currentCropRect(),
      rotate: ed.rotate,
      border: ed.border,
      overscan: effectiveOverscan(),
      colorMode: ed.color,
      brightness: brightnessVal(),
    }));
    const res = await fetch('api/preview', { method: 'POST', body: form });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const url = URL.createObjectURL(await res.blob());
    const el = $('preview-img');
    if (el.dataset.url) URL.revokeObjectURL(el.dataset.url);
    el.dataset.url = url;
    el.src = url;
    $('preview-modal').hidden = false;
  } catch (err) {
    toast('Preview failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}
$('ed-preview').addEventListener('click', showPreview);
const closePreview = () => ($('preview-modal').hidden = true);
$('preview-close').addEventListener('click', closePreview);
document.querySelector('.preview-backdrop').addEventListener('click', closePreview);

$('ed-cancel').addEventListener('click', closeEditor);
$('ed-done').addEventListener('click', () => {
  ed.item.crop = { ...ed.crop };
  ed.item.rotate = ed.rotate;
  ed.item.copies = ed.copies;
  ed.item.border = ed.border;
  ed.item.color = ed.color;
  // Persist so crop/orientation/copies/border/color survive a page refresh.
  inboxUpdate(ed.item.id, {
    crop: ed.item.crop, rotate: ed.item.rotate, copies: ed.item.copies, border: ed.item.border, color: ed.item.color,
  });
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

  let failed = 0;

  for (const item of queue.values()) {
    if (item.state === 'done') continue;
    item.state = 'printing';
    item.stateText = 'sending…';
    item.progress = 0;
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
          border: !!item.border,
          // per-device calibration → the server pre-compensates the render
          overscan: effectiveOverscan(),
          colorMode: item.color ?? colorDefault(),
      brightness: brightnessVal(),
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
      item.progress = 100;
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
    if (typeof job.progress === 'number') item.progress = job.progress;
    render();
    await new Promise((r) => setTimeout(r, 1500));
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
