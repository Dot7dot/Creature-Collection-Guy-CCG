'use strict';

/* ================= 常數 ================= */
const CATEGORIES = { animal: '動物', plant: '植物', landscape: '風景' };
const THEMES = {
  coffee: { label: '咖啡橘', color: '#4A2E21' },
  green: { label: '森林綠', color: '#1F4D36' },
};
const PHOTO_SIZE = 1080; // 儲存的正方形照片邊長（px）

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ================= 資料庫（IndexedDB） ================= */
const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('nature-journal', 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('records', { keyPath: 'id' });
        store.createIndex('category', 'category');
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async tx(mode, fn) {
    const d = await this.open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('records', mode);
      const result = fn(t.objectStore('records'));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  add(record) { return this.tx('readwrite', (s) => s.add(record)); },
  remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
};

/* ================= 工具 ================= */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function formatTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatLoc(loc) {
  if (!loc) return '未記錄';
  return `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
}

function mapUrl(loc) {
  return `https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=16/${loc.lat}/${loc.lng}`;
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* ================= 主題 ================= */
function applyTheme(name) {
  if (!THEMES[name]) name = 'coffee';
  document.documentElement.dataset.theme = name;
  $('#themeLabel').textContent = THEMES[name].label;
  $('meta[name="theme-color"]').setAttribute('content', THEMES[name].color);
  try { localStorage.setItem('theme', name); } catch (_) { /* 無痕模式等 */ }
}

$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'coffee' ? 'green' : 'coffee');
});

/* ================= 頁面切換 ================= */
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'album') {
    stopCamera();
    renderAlbum();
  }
  window.scrollTo(0, 0);
}

$$('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

/* ================= 相機 ================= */
const frame = $('#frame');
const video = $('#video');
const preview = $('#preview');
const canvas = $('#canvas');

const state = {
  stream: null,
  facing: 'environment',
  blob: null,
  previewUrl: null,
  capturedAt: null,
  location: null,
  locating: false,
};

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('此瀏覽器無法使用相機，請改從相簿選擇照片');
    return;
  }
  stopCamera();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch (err) {
    console.error(err);
    toast(err.name === 'NotAllowedError' ? '相機權限被拒絕，請在瀏覽器設定中允許' : '無法開啟相機');
    return;
  }
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  frame.classList.add('live');
  frame.classList.toggle('mirror', state.facing === 'user');
  $('#shutterRow').hidden = false;
  locate(); // 提前開始定位，拍照時就有位置
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  video.srcObject = null;
  frame.classList.remove('live', 'mirror');
  $('#shutterRow').hidden = true;
}

/** 將來源（video 或 image）中央裁切成正方形並輸出 JPEG Blob */
function cropToSquare(source, sw, sh, mirror) {
  const side = Math.min(sw, sh);
  const sx = (sw - side) / 2;
  const sy = (sh - side) / 2;
  const out = Math.min(PHOTO_SIZE, side);
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.save();
  if (mirror) { ctx.translate(out, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, sx, sy, side, side, 0, 0, out, out);
  ctx.restore();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
}

async function takePhoto() {
  if (!video.videoWidth) return;
  const blob = await cropToSquare(video, video.videoWidth, video.videoHeight, state.facing === 'user');
  stopCamera();
  setCaptured(blob);
}

function setCaptured(blob) {
  state.blob = blob;
  state.capturedAt = new Date().toISOString();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(blob);
  preview.src = state.previewUrl;
  preview.hidden = false;
  frame.classList.add('shot');
  $('#timeText').textContent = formatTime(state.capturedAt);
  $('#recordForm').hidden = false;
  renderLoc();
  if (!state.location && !state.locating) locate();
  setTimeout(() => $('#recordForm').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

function resetCapture() {
  state.blob = null;
  state.capturedAt = null;
  state.location = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  preview.removeAttribute('src');
  preview.hidden = true;
  frame.classList.remove('shot');
  $('#recordForm').hidden = true;
  $('#recordForm').reset();
  $('#locText').textContent = '尚未取得';
  $('#timeText').textContent = '—';
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    stopCamera();
    const blob = await cropToSquare(img, img.naturalWidth, img.naturalHeight, false);
    setCaptured(blob);
  } catch (err) {
    console.error(err);
    toast('無法讀取這張照片');
  } finally {
    URL.revokeObjectURL(url);
  }
}

$('#startCamBtn').addEventListener('click', startCamera);
$('#shutterBtn').addEventListener('click', takePhoto);
$('#closeCamBtn').addEventListener('click', stopCamera);
$('#switchCamBtn').addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
});
$('#fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});
$('#retakeBtn').addEventListener('click', () => {
  resetCapture();
  startCamera();
});

/* ================= GPS 定位 ================= */
function renderLoc() {
  const el = $('#locText');
  if (state.locating && !state.location) el.textContent = '定位中…';
  else if (state.location) {
    el.textContent = `${formatLoc(state.location)}（±${Math.round(state.location.accuracy)}m）`;
  } else el.textContent = '無法取得位置';
}

function locate() {
  if (!('geolocation' in navigator)) {
    state.locating = false;
    renderLoc();
    return;
  }
  state.locating = true;
  renderLoc();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.locating = false;
      state.location = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      renderLoc();
    },
    (err) => {
      state.locating = false;
      console.warn(err);
      renderLoc();
      if (err.code === err.PERMISSION_DENIED) toast('定位權限被拒絕，照片將不記錄地點');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

$('#locBtn').addEventListener('click', () => {
  state.location = null;
  locate();
});

/* ================= 儲存 ================= */
$('#recordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.blob) return;
  const name = $('#nameInput').value.trim();
  if (!name) {
    toast('請輸入照片名稱');
    $('#nameInput').focus();
    return;
  }
  const category = new FormData(e.target).get('category');
  const record = {
    id: uid(),
    category,
    name,
    note: $('#noteInput').value.trim(),
    createdAt: state.capturedAt,
    location: state.location,
    photo: state.blob,
  };
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    await db.add(record);
    toast(`已儲存到「${CATEGORIES[category]}」相簿`);
    resetCapture();
    currentCat = category;
    showView('album');
  } catch (err) {
    console.error(err);
    toast('儲存失敗，請再試一次');
  } finally {
    btn.disabled = false;
  }
});

/* ================= 相簿 ================= */
let currentCat = 'animal';
let gridUrls = [];

async function renderAlbum() {
  const records = await db.all();
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  Object.keys(CATEGORIES).forEach((c) => {
    $(`[data-count="${c}"]`).textContent = records.filter((r) => r.category === c).length;
  });
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.cat === currentCat));

  gridUrls.forEach((u) => URL.revokeObjectURL(u));
  gridUrls = [];
  const grid = $('#grid');
  grid.textContent = '';

  const list = records.filter((r) => r.category === currentCat);
  $('#emptyText').hidden = list.length > 0;

  for (const r of list) {
    const url = URL.createObjectURL(r.photo);
    gridUrls.push(url);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.setAttribute('aria-label', r.name);
    const img = document.createElement('img');
    img.src = url;
    img.alt = r.name;
    img.loading = 'lazy';
    const label = document.createElement('span');
    label.className = 'card-name';
    label.textContent = r.name;
    card.append(img, label);
    card.addEventListener('click', () => openDetail(r.id));
    grid.append(card);
  }
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  currentCat = t.dataset.cat;
  renderAlbum();
}));

/* ================= 照片詳情 ================= */
const detail = $('#detail');
let detailId = null;
let detailUrl = null;

async function openDetail(id) {
  const r = await db.get(id);
  if (!r) return;
  detailId = id;
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = URL.createObjectURL(r.photo);

  $('#detailImg').src = detailUrl;
  $('#detailImg').alt = r.name;
  $('#detailCat').textContent = CATEGORIES[r.category];
  $('#detailName').textContent = r.name;
  $('#detailTime').textContent = formatTime(r.createdAt);
  $('#detailNote').textContent = r.note || '—';

  const loc = $('#detailLoc');
  loc.textContent = '';
  if (r.location) {
    const a = document.createElement('a');
    a.href = mapUrl(r.location);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = `${formatLoc(r.location)}（在地圖上查看）`;
    loc.append(a);
  } else {
    loc.textContent = '未記錄';
  }

  const dl = $('#detailDownload');
  dl.href = detailUrl;
  dl.download = `${r.name}-${r.createdAt.slice(0, 10)}.jpg`;

  detail.showModal();
}

function closeDetail() {
  detail.close();
}

$('#detailClose').addEventListener('click', closeDetail);
detail.addEventListener('click', (e) => { if (e.target === detail) closeDetail(); });
detail.addEventListener('close', () => {
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = null;
  detailId = null;
});

$('#detailDelete').addEventListener('click', async () => {
  if (!detailId) return;
  if (!confirm('確定要刪除這張照片嗎？')) return;
  await db.remove(detailId);
  closeDetail();
  toast('已刪除');
  renderAlbum();
});

/* ================= 啟動 ================= */
(function init() {
  let saved = 'coffee';
  try { saved = localStorage.getItem('theme') || 'coffee'; } catch (_) { /* ignore */ }
  applyTheme(saved);

  // 頁面切到背景時關閉相機以節省電力
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // 要求瀏覽器盡量保留資料，避免照片被自動清除
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
