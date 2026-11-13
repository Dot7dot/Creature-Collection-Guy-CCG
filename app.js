'use strict';

/* ================= 常數 ================= */
const CATEGORIES = { animal: '動物', plant: '植物', landscape: '風景' };
const THEMES = {
  coffee: { label: '咖啡橘', color: '#4A2E21' },
  green: { label: '森林綠', color: '#1F4D36' },
};
const PHOTO_SIZE = 1080;          // 儲存的正方形照片邊長（px）
const LOCATION_REUSE_MS = 120000; // 兩分鐘內重拍沿用同一次定位

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
      const out = fn(t.objectStore('records'));
      t.oncomplete = () => resolve(out ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },
  add(record) { return this.tx('readwrite', (s) => s.add(record)); },
  remove(id) { return this.tx('readwrite', (s) => s.delete(id)); },
  get(id) { return this.tx('readonly', (s) => s.get(id)); },
  all() { return this.tx('readonly', (s) => s.getAll()); },
  /** 在同一個交易中讀出 → 修改 → 寫回；fn 回傳 false 代表不修改。回傳更新後的記錄或 null */
  update(id, fn) {
    return this.tx('readwrite', (s) => {
      const out = { result: null };
      const req = s.get(id);
      req.onsuccess = () => {
        const r = req.result;
        if (r && fn(r) !== false) { s.put(r); out.result = r; }
      };
      return out;
    });
  },
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

function hasCoords(loc) {
  return Boolean(loc) && typeof loc.lat === 'number' && typeof loc.lng === 'number';
}

function formatCoords(loc) {
  return `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`;
}

/** 有地點名稱就只顯示名稱，否則顯示經緯度 */
function formatLoc(loc) {
  if (!loc) return '未記錄';
  if (loc.place) return loc.place.name;
  return hasCoords(loc) ? formatCoords(loc) : '未記錄';
}

function mapUrl(loc) {
  const base = 'https://www.google.com/maps/search/?api=1';
  if (loc.place && loc.place.source === 'google') {
    return `${base}&query=${encodeURIComponent(loc.place.name)}&query_place_id=${encodeURIComponent(loc.place.id)}`;
  }
  if (hasCoords(loc)) return `${base}&query=${loc.lat},${loc.lng}`;
  return `${base}&query=${encodeURIComponent(loc.place.name)}`;
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
function currentView() {
  return $('.view.active').id.replace('view-', '');
}

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
  // 定位工作：GPS → 附近地點，全部在背景進行
  location: null,   // 目前已知的位置（UI 顯示用）
  locating: false,  // GPS 定位中
  searching: false, // 附近地點搜尋中
  job: null,        // Promise<location|null>，完成時含地點名稱
  jobDone: false,
  jobStartedAt: 0,
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
  ensureLocation(); // 相機開啟後就在背景開始定位，不影響拍照
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  frame.classList.add('live');
  frame.classList.toggle('mirror', state.facing === 'user');
  $('#shutterRow').hidden = false;
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
  ensureLocation();
  renderLoc();
  setTimeout(() => $('#recordForm').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

/** 清掉這次拍攝的照片與表單；定位結果保留，兩分鐘內重拍可直接沿用 */
function resetCapture() {
  state.blob = null;
  state.capturedAt = null;
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  preview.removeAttribute('src');
  preview.hidden = true;
  frame.classList.remove('shot');
  $('#recordForm').hidden = true;
  $('#recordForm').reset();
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

/* ================= GPS 定位 + 附近地點（背景） ================= */
let locToken = 0; // 重新定位時用來忽略舊工作對畫面的更新

function renderLoc() {
  const el = $('#locText');
  const loc = state.location;
  if (state.locating) el.textContent = '定位中…';
  else if (!loc) el.textContent = '無法取得位置';
  else if (loc.place) el.textContent = loc.place.name;
  else if (state.searching) el.textContent = '搜尋附近地點中（可直接儲存）';
  else el.textContent = `${formatCoords(loc)}（±${Math.round(loc.accuracy)}m）`;
}

function getPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        place: null,
        placeStatus: 'pending',
      }),
      (err) => {
        console.warn(err);
        if (err.code === err.PERMISSION_DENIED) toast('定位權限被拒絕，照片將不記錄地點');
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  });
}

/** 搜尋附近地點並寫入 loc：找到 → 名稱；100m 內沒有 → 經緯度；查詢失敗 → 之後重試 */
async function resolvePlace(loc) {
  try {
    loc.place = await Places.nearby(loc.lat, loc.lng);
    loc.placeStatus = 'done';
  } catch (err) {
    console.warn('附近地點查詢失敗，稍後重試', err);
    loc.placeStatus = 'retry';
  }
  return loc;
}

/** 開始一個新的定位工作（GPS → 附近地點），完全不阻擋拍照與儲存 */
function locate() {
  const token = ++locToken;
  const mine = () => token === locToken;
  state.location = null;
  state.locating = true;
  state.searching = false;
  state.jobDone = false;
  state.jobStartedAt = Date.now();
  state.job = (async () => {
    const loc = await getPosition();
    if (mine()) {
      state.locating = false;
      state.location = loc;
      state.searching = Boolean(loc);
      renderLoc();
    }
    if (loc) await resolvePlace(loc);
    if (mine()) {
      state.searching = false;
      state.jobDone = true;
      renderLoc();
    }
    return loc;
  })();
  renderLoc();
}

/** 沒有定位工作或已過時才重新定位 */
function ensureLocation() {
  if (!state.job || Date.now() - state.jobStartedAt > LOCATION_REUSE_MS) locate();
}

$('#locBtn').addEventListener('click', locate);

/* ---------- 已儲存記錄的背景補完 ---------- */
const bgActive = new Set();

/** 等定位工作完成後，把結果寫回已儲存的記錄（使用者若已手動編輯地點則不覆蓋） */
async function finishInBackground(id, job) {
  bgActive.add(id);
  try {
    const loc = await job;
    const updated = await db.update(id, (r) => {
      if (!r.locPending) return false;
      r.locPending = false;
      r.location = loc ? { ...loc } : null;
    });
    if (updated) onRecordChanged(updated);
  } finally {
    bgActive.delete(id);
  }
  // 查詢失敗的話交給重試流程
  retryPending();
}

/** 重試尚未完成的地點搜尋（App 重新開啟、恢復網路時） */
let retrying = false;
async function retryPending() {
  if (retrying || !navigator.onLine) return;
  retrying = true;
  try {
    const records = await db.all();
    for (const r of records) {
      if (bgActive.has(r.id)) continue;
      const loc = r.location;
      const needsPlace = hasCoords(loc) && (loc.placeStatus === 'retry' || (r.locPending && loc.placeStatus === 'pending'));
      if (!needsPlace && !r.locPending) continue;
      if (!needsPlace) {
        // App 在 GPS 定位完成前被關閉，無法補回位置
        const updated = await db.update(r.id, (x) => { if (!x.locPending) return false; x.locPending = false; });
        if (updated) onRecordChanged(updated);
        continue;
      }
      const fresh = await resolvePlace({ ...loc });
      if (fresh.placeStatus === 'retry') break; // 仍然失敗，等下次
      const updated = await db.update(r.id, (x) => {
        const cur = x.location;
        if (!cur || cur.placeStatus === 'done' || cur.placeStatus === 'manual') return false;
        x.location = fresh;
        x.locPending = false;
      });
      if (updated) onRecordChanged(updated);
    }
  } catch (err) {
    console.warn(err);
  } finally {
    retrying = false;
  }
}

window.addEventListener('online', retryPending);

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
  // 不等待定位／地點搜尋：先用目前已知的位置儲存，結果出來後在背景更新
  const pending = Boolean(state.job) && !state.jobDone;
  const record = {
    id: uid(),
    category,
    name,
    note: $('#noteInput').value.trim(),
    createdAt: state.capturedAt,
    location: state.location ? { ...state.location } : null,
    locPending: pending,
    photo: state.blob,
  };
  const btn = $('#saveBtn');
  btn.disabled = true;
  try {
    await db.add(record);
    if (pending) finishInBackground(record.id, state.job);
    else if (record.location && record.location.placeStatus === 'retry') retryPending();
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

/** 記錄被背景更新或編輯後，刷新畫面 */
function onRecordChanged(record) {
  if (currentView() === 'album') renderAlbum();
  if (detail.open && detailRecord && detailRecord.id === record.id) {
    detailRecord = record;
    if ($('#editForm').hidden) renderDetail();
    else renderEditLocHint();
  }
}

/* ================= 照片詳情 ================= */
const detail = $('#detail');
let detailRecord = null;
let detailUrl = null;

function isSearching(r) {
  return r.locPending || (r.location && (r.location.placeStatus === 'pending' || r.location.placeStatus === 'retry') && !r.location.place);
}

function renderDetail() {
  const r = detailRecord;
  $('#detailImg').alt = r.name;
  $('#detailCat').textContent = CATEGORIES[r.category];
  $('#detailName').textContent = r.name;
  $('#detailTime').textContent = formatTime(r.createdAt);
  $('#detailNote').textContent = r.note || '—';

  const loc = $('#detailLoc');
  loc.textContent = '';
  if (r.location && (r.location.place || hasCoords(r.location))) {
    const a = document.createElement('a');
    a.href = mapUrl(r.location);
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = '在 Google 地圖上查看';
    a.textContent = formatLoc(r.location);
    loc.append(a);
    if (isSearching(r)) {
      const s = document.createElement('span');
      s.className = 'pending';
      s.textContent = r.location.placeStatus === 'retry' ? '（連上網路後會自動搜尋地點）' : '（搜尋附近地點中…）';
      loc.append(' ', s);
    }
  } else {
    loc.textContent = r.locPending ? '定位中…' : '未記錄';
  }

  const dl = $('#detailDownload');
  dl.href = detailUrl;
  dl.download = `${r.name}-${r.createdAt.slice(0, 10)}.jpg`;
}

async function openDetail(id) {
  const r = await db.get(id);
  if (!r) return;
  detailRecord = r;
  if (detailUrl) URL.revokeObjectURL(detailUrl);
  detailUrl = URL.createObjectURL(r.photo);
  $('#detailImg').src = detailUrl;
  showEdit(false);
  renderDetail();
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
  detailRecord = null;
});

$('#detailDelete').addEventListener('click', async () => {
  if (!detailRecord) return;
  if (!confirm('確定要刪除這張照片嗎？')) return;
  await db.remove(detailRecord.id);
  closeDetail();
  toast('已刪除');
  renderAlbum();
});

/* ================= 編輯 ================= */
const editForm = $('#editForm');
let editLocOriginal = '';
let editLocFound = null; // 「自動搜尋」找到的地點（保留來源與 id）

function showEdit(on) {
  $('#detailView').hidden = on;
  editForm.hidden = !on;
}

function renderEditLocHint() {
  const r = detailRecord;
  const input = $('#editLoc');
  const hint = $('#editLocHint');
  const coords = hasCoords(r.location);
  input.placeholder = coords ? formatCoords(r.location) : '輸入地點名稱';
  if (isSearching(r) && input.value === editLocOriginal && !editLocOriginal) {
    hint.textContent = '正在背景搜尋附近地點，也可以直接輸入';
  } else {
    hint.textContent = coords ? '留空則顯示經緯度' : '這張照片沒有 GPS 記錄，留空則不記錄地點';
  }
  $('#editLocSearch').hidden = !coords;
}

$('#detailEdit').addEventListener('click', () => {
  const r = detailRecord;
  if (!r) return;
  editForm.querySelector(`input[name="editCategory"][value="${r.category}"]`).checked = true;
  $('#editName').value = r.name;
  $('#editNote').value = r.note || '';
  editLocOriginal = (r.location && r.location.place && r.location.place.name) || '';
  editLocFound = null;
  $('#editLoc').value = editLocOriginal;
  renderEditLocHint();
  showEdit(true);
  $('#editName').focus();
});

$('#editCancel').addEventListener('click', () => {
  showEdit(false);
  renderDetail();
});

$('#editLocSearch').addEventListener('click', async () => {
  const r = detailRecord;
  if (!r || !hasCoords(r.location)) return;
  const btn = $('#editLocSearch');
  btn.disabled = true;
  btn.textContent = '搜尋中…';
  try {
    const place = await Places.nearby(r.location.lat, r.location.lng);
    if (place) {
      editLocFound = place;
      $('#editLoc').value = place.name;
    } else {
      toast(`方圓 ${Places.radius} 公尺內沒有找到地點`);
    }
  } catch (err) {
    console.warn(err);
    toast('搜尋失敗，請檢查網路連線');
  } finally {
    btn.disabled = false;
    btn.textContent = '自動搜尋附近地點';
  }
});

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = detailRecord;
  if (!r) return;
  const name = $('#editName').value.trim();
  if (!name) {
    toast('請輸入照片名稱');
    $('#editName').focus();
    return;
  }
  const category = new FormData(editForm).get('editCategory');
  const note = $('#editNote').value.trim();
  const locName = $('#editLoc').value.trim();
  const locChanged = locName !== editLocOriginal;

  const updated = await db.update(r.id, (x) => {
    x.name = name;
    x.category = category;
    x.note = note;
    if (!locChanged) return; // 地點沒動：保留（包括背景搜尋剛寫入的結果）
    x.locPending = false;
    const base = x.location || { lat: null, lng: null, accuracy: null };
    if (!locName) {
      x.location = hasCoords(base) ? { ...base, place: null, placeStatus: 'manual' } : null;
    } else if (editLocFound && editLocFound.name === locName) {
      x.location = { ...base, place: editLocFound, placeStatus: 'done' };
    } else {
      x.location = { ...base, place: { name: locName, source: 'manual' }, placeStatus: 'manual' };
    }
  });
  if (!updated) return;
  detailRecord = updated;
  showEdit(false);
  renderDetail();
  toast('已更新');
  if (category !== currentCat) currentCat = category;
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

  // 補完上次未完成的地點搜尋
  retryPending();
})();
