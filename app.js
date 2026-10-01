'use strict';

/* ===== データベース (IndexedDB) ===== */
const DB_NAME = 'kinmu';
let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('records', { keyPath: 'date' });
      db.createObjectStore('receipts', { keyPath: 'id' }).createIndex('date', 'date');
      db.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

async function runTx(names, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(names, 'readwrite');
    fn(t);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const monthRange = (y, m) => IDBKeyRange.bound(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-31`);
const getMonthRecords = async (y, m) => wrap((await store('records')).getAll(monthRange(y, m)));
const getMonthReceipts = async (y, m) => wrap((await store('receipts')).index('date').getAll(monthRange(y, m)));
const getDayReceipts = async date => wrap((await store('receipts')).index('date').getAll(date));

/* ===== 設定 ===== */
const DEFAULT_SETTINGS = {
  start: '08:30',
  end: '17:30',
  breakMin: 60,
  parkings: [],
  gasMode: 'none',   // none | distance | actual
  gasRate: 0,
  endFrom: '15:00',  // 退勤ボタンの範囲
  endTo: '17:30',
};
let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const s = await wrap((await store('kv')).get('settings'));
  settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
}
async function saveSettings() {
  await runTx(['kv'], t => t.objectStore('kv').put(settings, 'settings'));
}

/* ===== ユーティリティ ===== */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const yen = n => Math.round(n).toLocaleString('ja-JP');
const num = v => (v === '' || v == null || isNaN(Number(v))) ? 0 : Number(v);

function toMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function workedMin(r) {
  if (!r.start || !r.end) return 0;
  let d = toMin(r.end) - toMin(r.start);
  if (d < 0) d += 24 * 60; // 日をまたぐ勤務
  return Math.max(0, d - num(r.breakMin));
}
function fmtHours(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}
const shortTime = t => t.replace(/^0/, '');
const dayLabel = date => {
  const d = new Date(date + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
};
const gasFee = r => {
  if (settings.gasMode === 'distance') return num(r.km) * num(settings.gasRate);
  if (settings.gasMode === 'actual') return num(r.gas);
  return 0;
};

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// 写真を縮小してJPEGにする（保存容量の節約）
function compressImage(file, maxSide = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error('画像の変換に失敗しました')), 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
    img.src = url;
  });
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ===== 状態 ===== */
const now = new Date();
let curY = now.getFullYear();
let curM = now.getMonth() + 1;
let monthRecs = {};      // date -> record
let monthReceipts = [];  // その月の領収書
let thumbURLs = [];

function releaseThumbs() {
  thumbURLs.forEach(u => URL.revokeObjectURL(u));
  thumbURLs = [];
}
function thumbURL(blob) {
  const u = URL.createObjectURL(blob);
  thumbURLs.push(u);
  return u;
}

/* ===== 描画 ===== */
async function refresh() {
  $('monthTitle').textContent = `${curY}年${curM}月`;
  const recs = await getMonthRecords(curY, curM);
  monthRecs = Object.fromEntries(recs.map(r => [r.date, r]));
  monthReceipts = await getMonthReceipts(curY, curM);
  releaseThumbs();
  renderList();
  renderReport();
}

function totals() {
  const recs = Object.values(monthRecs);
  return {
    days: recs.length,
    min: recs.reduce((s, r) => s + workedMin(r), 0),
    park: recs.reduce((s, r) => s + num(r.parkFee), 0),
    gas: recs.reduce((s, r) => s + gasFee(r), 0),
  };
}

function renderList() {
  const t = totals();
  $('listSummary').innerHTML = `
    <div><b>${t.days}日</b><span>勤務日数</span></div>
    <div><b>${fmtHours(t.min)}</b><span>合計時間</span></div>
    <div><b>${yen(t.park + t.gas)}円</b><span>交通費</span></div>`;

  const receiptCountByDay = {};
  monthReceipts.forEach(r => { receiptCountByDay[r.date] = (receiptCountByDay[r.date] || 0) + 1; });

  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const last = new Date(curY, curM, 0).getDate();
  const ul = $('dayList');
  ul.innerHTML = '';
  for (let d = 1; d <= last; d++) {
    const date = `${curY}-${pad(curM)}-${pad(d)}`;
    const wd = new Date(curY, curM - 1, d).getDay();
    const r = monthRecs[date];
    const li = document.createElement('li');
    if (wd === 6) li.classList.add('sat');
    if (wd === 0) li.classList.add('sun');
    if (date === todayStr) li.classList.add('today');

    let info = '<span class="empty">—</span>';
    let h = '';
    if (r) {
      const subs = [];
      if (num(r.parkFee) || r.parkName) subs.push(`P ${r.parkName ? r.parkName + ' ' : ''}${yen(num(r.parkFee))}円`);
      const g = gasFee(r);
      if (g) subs.push(`ガソリン ${yen(g)}円`);
      if (receiptCountByDay[date]) subs.push(`📎${receiptCountByDay[date]}`);
      if (r.note) subs.push(r.note);
      info = `${shortTime(r.start)}–${shortTime(r.end)} 休${num(r.breakMin)}分
        <div class="sub">${escapeHTML(subs.join(' ・ ')) || '&nbsp;'}</div>`;
      h = `<span class="h">${fmtHours(workedMin(r))}</span>`;
    }
    li.innerHTML = `<span class="d">${d}(${WD[wd]})</span><div class="info">${info}</div>${h}`;
    li.addEventListener('click', () => openEditor(date));
    ul.appendChild(li);
  }

  // 今月を開いたときは今日の位置までスクロール
  const todayEl = ul.querySelector('.today');
  if (todayEl && !renderList.scrolled) {
    renderList.scrolled = true;
    todayEl.scrollIntoView({ block: 'center' });
  }
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildReport() {
  const recs = Object.values(monthRecs).sort((a, b) => a.date.localeCompare(b.date));
  const lines = [`【${curM}月 勤務報告】`];
  for (const r of recs) {
    let line = `${dayLabel(r.date)} ${shortTime(r.start)}-${shortTime(r.end)} 休${num(r.breakMin)}分 ${fmtHours(workedMin(r))}`;
    if (num(r.parkFee)) line += ` 駐車場${r.parkName ? '(' + r.parkName + ')' : ''} ${yen(num(r.parkFee))}円`;
    if (settings.gasMode === 'distance' && num(r.km)) line += ` ガソリン ${num(r.km)}km ${yen(gasFee(r))}円`;
    if (settings.gasMode === 'actual' && num(r.gas)) line += ` ガソリン ${yen(num(r.gas))}円`;
    lines.push(line);
  }
  const t = totals();
  lines.push('――――');
  lines.push(`勤務日数: ${t.days}日`);
  lines.push(`合計時間: ${fmtHours(t.min)}`);
  lines.push(`駐車場代: ${yen(t.park)}円`);
  if (settings.gasMode !== 'none') lines.push(`ガソリン代: ${yen(t.gas)}円`);
  lines.push(`交通費合計: ${yen(t.park + t.gas)}円`);
  return lines.join('\n');
}

function renderReport() {
  $('reportText').value = buildReport();
  $('receiptCount').textContent = `${curM}月の領収書: ${monthReceipts.length}枚`;
  const box = $('monthReceipts');
  box.innerHTML = '';
  for (const rc of monthReceipts) {
    const d = document.createElement('div');
    d.className = 'thumb';
    const day = Number(rc.date.slice(8));
    d.innerHTML = `<img src="${thumbURL(rc.blob)}" alt=""><span class="lbl">${curM}/${day}</span>`;
    d.querySelector('img').addEventListener('click', () => showImage(rc.blob));
    box.appendChild(d);
  }
}

function renderSettings() {
  $('setStart').value = settings.start;
  $('setEnd').value = settings.end;
  $('setBreak').value = settings.breakMin;
  $('setGasMode').value = settings.gasMode;
  $('setGasRate').value = settings.gasRate || '';
  $('gasRateWrap').hidden = settings.gasMode !== 'distance';
  const ul = $('parkingList');
  ul.innerHTML = '';
  if (!settings.parkings.length) ul.innerHTML = '<li class="muted small">まだ登録がありません</li>';
  settings.parkings.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHTML(p.name)}　${yen(p.fee)}円</span><button class="danger">削除</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      settings.parkings.splice(i, 1);
      await saveSettings();
      renderSettings();
    });
    ul.appendChild(li);
  });
}

/* ===== 1日の入力画面 ===== */
let editing = null; // { date, existing, receipts:[{id, blob, isNew}], deleted:[] }

async function openEditor(date) {
  const r = monthRecs[date];
  editing = { date, existing: !!r, receipts: (await getDayReceipts(date)).map(x => ({ ...x, isNew: false })), deleted: [] };
  $('editDate').textContent = dayLabel(date) + (r ? '' : '（新規）');
  $('fStart').value = r ? r.start : settings.start;
  $('fEnd').value = r ? r.end : settings.end;
  $('fBreak').value = r ? r.breakMin : settings.breakMin;
  $('fParkName').value = r ? (r.parkName || '') : '';
  $('fParkFee').value = r && num(r.parkFee) ? r.parkFee : '';
  $('fKm').value = r && r.km ? r.km : '';
  $('fGas').value = r && r.gas ? r.gas : '';
  $('fNote').value = r ? (r.note || '') : '';
  $('gasDistance').hidden = settings.gasMode !== 'distance';
  $('gasActual').hidden = settings.gasMode !== 'actual';
  $('deleteRec').hidden = !r;
  renderChips();
  renderEditorReceipts();
  updateWorked();
  $('editor').showModal();
  $('editor').scrollTop = 0;
}

// 退勤時刻を「時」「分」(5分きざみ)のボタンで選ぶ
function renderEndChips() {
  const from = toMin(settings.endFrom), to = toMin(settings.endTo);
  const cur = $('fEnd').value ? toMin($('fEnd').value) : null;
  const curH = cur == null ? null : Math.floor(cur / 60);
  const curM = cur == null ? null : cur % 60;
  const setEnd = min => {
    min = Math.min(to, Math.max(from, min));
    $('fEnd').value = `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    updateWorked();
  };
  const chip = (box, label, on, disabled, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (on) b.classList.add('on');
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    box.appendChild(b);
  };

  const hBox = $('endHours');
  hBox.innerHTML = '';
  for (let h = Math.floor(from / 60); h <= Math.floor(to / 60); h++) {
    // 時を変えても分はそのまま（範囲外なら端に寄せる）
    chip(hBox, `${h}時`, h === curH, false, () => setEnd(h * 60 + (curM ?? 0)));
  }

  const mBox = $('endMins');
  mBox.innerHTML = '';
  for (let m = 0; m < 60; m += 5) {
    const t = curH == null ? null : curH * 60 + m;
    const out = t == null || t < from || t > to;
    chip(mBox, pad(m), m === curM, out, () => setEnd(t));
  }
}

function updateWorked() {
  renderEndChips();
  const r ={ start: $('fStart').value, end: $('fEnd').value, breakMin: $('fBreak').value };
  $('fWorked').textContent = r.start && r.end ? `勤務時間: ${fmtHours(workedMin(r))}` : '';
  if (settings.gasMode === 'distance') {
    const km = num($('fKm').value);
    $('fKmFee').textContent = settings.gasRate
      ? `${km}km × ${settings.gasRate}円 = ${yen(km * settings.gasRate)}円`
      : '単価は設定画面で入力してください';
  }
}

function renderChips() {
  const box = $('parkChips');
  box.innerHTML = '';
  const curName = $('fParkName').value;
  settings.parkings.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${p.name} ${yen(p.fee)}円`;
    if (p.name === curName) b.classList.add('on');
    b.addEventListener('click', () => {
      $('fParkName').value = p.name;
      $('fParkFee').value = p.fee;
      renderChips();
    });
    box.appendChild(b);
  });
  if (settings.parkings.length) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'なし';
    b.addEventListener('click', () => { $('fParkName').value = ''; $('fParkFee').value = ''; renderChips(); });
    box.appendChild(b);
  }
}

function renderEditorReceipts() {
  const box = $('fReceipts');
  box.innerHTML = '';
  editing.receipts.forEach((rc, i) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${thumbURL(rc.blob)}" alt="領収書"><button type="button" class="x" aria-label="削除">×</button>`;
    d.querySelector('img').addEventListener('click', () => showImage(rc.blob));
    d.querySelector('.x').addEventListener('click', () => {
      if (!rc.isNew) editing.deleted.push(rc.id);
      editing.receipts.splice(i, 1);
      renderEditorReceipts();
    });
    box.appendChild(d);
  });
}

async function saveEditor() {
  const rec = {
    date: editing.date,
    start: $('fStart').value,
    end: $('fEnd').value,
    breakMin: num($('fBreak').value),
    parkName: $('fParkName').value.trim(),
    parkFee: num($('fParkFee').value),
    km: num($('fKm').value),
    gas: num($('fGas').value),
    note: $('fNote').value.trim(),
  };
  if (!rec.start || !rec.end) { toast('出勤と退勤を入力してください'); return; }
  const { receipts, deleted } = editing;
  await runTx(['records', 'receipts'], t => {
    t.objectStore('records').put(rec);
    const rs = t.objectStore('receipts');
    deleted.forEach(id => rs.delete(id));
    receipts.filter(x => x.isNew).forEach(x => rs.put({ id: x.id, date: x.date, blob: x.blob }));
  });
  $('editor').close();
  editing = null;
  toast('保存しました');
  refresh();
}

async function deleteRecord() {
  const n = editing.receipts.filter(x => !x.isNew).length;
  const msg = n ? `この日の記録と領収書${n}枚を削除しますか？` : 'この日の記録を削除しますか？';
  if (!confirm(msg)) return;
  const date = editing.date;
  const ids = (await getDayReceipts(date)).map(x => x.id);
  await runTx(['records', 'receipts'], t => {
    t.objectStore('records').delete(date);
    ids.forEach(id => t.objectStore('receipts').delete(id));
  });
  $('editor').close();
  editing = null;
  toast('削除しました');
  refresh();
}

function showImage(blob) {
  $('viewerImg').src = thumbURL(blob);
  $('viewer').showModal();
}

/* ===== 共有・コピー ===== */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = $('reportText');
    ta.removeAttribute('readonly');
    ta.select();
    document.execCommand('copy');
    ta.setAttribute('readonly', '');
  }
}

async function shareReport() {
  const text = buildReport();
  if (navigator.share) {
    try { await navigator.share({ text }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  // 共有機能がないブラウザはLINEの送信画面を直接開く
  location.href = 'https://line.me/R/share?text=' + encodeURIComponent(text);
}

async function shareReceipts() {
  if (!monthReceipts.length) { toast(`${curM}月の領収書はありません`); return; }
  const count = {};
  const files = monthReceipts.map(rc => {
    const key = rc.date.slice(5).replace('-', '');
    count[key] = (count[key] || 0) + 1;
    return new File([rc.blob], `receipt_${key}_${count[key]}.jpg`, { type: 'image/jpeg' });
  });
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); }
    catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした'); }
    return;
  }
  // 共有できない場合は1枚ずつ保存
  files.forEach(f => downloadBlob(f, f.name));
  toast('このブラウザでは共有できないため、画像を保存しました');
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ===== バックアップ ===== */
const blobToDataURL = blob => new Promise(res => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.readAsDataURL(blob);
});
const dataURLToBlob = async url => (await fetch(url)).blob();

async function exportData() {
  const records = await wrap((await store('records')).getAll());
  const receipts = await wrap((await store('receipts')).getAll());
  const data = {
    app: 'kinmu', version: 1, exportedAt: new Date().toISOString(),
    settings, records,
    receipts: await Promise.all(receipts.map(async r => ({ id: r.id, date: r.date, data: await blobToDataURL(r.blob) }))),
  };
  const d = new Date();
  const name = `kinmu-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  downloadBlob(file, name);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (!data || data.app !== 'kinmu') { toast('バックアップファイルではありません'); return; }
  if (!confirm(`記録${data.records.length}日分・領収書${data.receipts.length}枚を読み込みます。\n今のデータは置き換えられます。よろしいですか？`)) return;
  const receipts = await Promise.all(data.receipts.map(async r => ({ id: r.id, date: r.date, blob: await dataURLToBlob(r.data) })));
  await runTx(['records', 'receipts', 'kv'], t => {
    const rs = t.objectStore('records'), cs = t.objectStore('receipts');
    rs.clear(); cs.clear();
    data.records.forEach(r => rs.put(r));
    receipts.forEach(r => cs.put(r));
    t.objectStore('kv').put({ ...DEFAULT_SETTINGS, ...data.settings }, 'settings');
  });
  await loadSettings();
  renderSettings();
  await refresh();
  toast('読み込みました');
}

/* ===== イベント ===== */
function bind() {
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
    window.scrollTo(0, 0);
  }));

  $('prevMonth').addEventListener('click', () => { if (--curM < 1) { curM = 12; curY--; } refresh(); });
  $('nextMonth').addEventListener('click', () => { if (++curM > 12) { curM = 1; curY++; } refresh(); });

  ['fStart', 'fEnd', 'fBreak', 'fKm'].forEach(id => $(id).addEventListener('input', updateWorked));
  $('fParkName').addEventListener('input', renderChips);
  $('editForm').addEventListener('submit', e => { e.preventDefault(); saveEditor(); });
  $('cancelEdit').addEventListener('click', () => { $('editor').close(); editing = null; });
  $('deleteRec').addEventListener('click', deleteRecord);

  $('addReceipt').addEventListener('click', () => $('receiptFile').click());
  $('receiptFile').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    for (const f of files) {
      try {
        const blob = await compressImage(f);
        editing.receipts.push({ id: uid(), date: editing.date, blob, isNew: true });
      } catch (err) { toast(err.message); }
    }
    renderEditorReceipts();
  });

  $('copyReport').addEventListener('click', async () => { await copyText(buildReport()); toast('コピーしました。LINEに貼り付けてください'); });
  $('shareReport').addEventListener('click', shareReport);
  $('shareReceipts').addEventListener('click', shareReceipts);

  const saveDefaults = async () => {
    settings.start = $('setStart').value || DEFAULT_SETTINGS.start;
    settings.end = $('setEnd').value || DEFAULT_SETTINGS.end;
    settings.breakMin = num($('setBreak').value);
    settings.gasMode = $('setGasMode').value;
    settings.gasRate = num($('setGasRate').value);
    $('gasRateWrap').hidden = settings.gasMode !== 'distance';
    await saveSettings();
    renderList();
    renderReport();
  };
  ['setStart', 'setEnd', 'setBreak', 'setGasMode', 'setGasRate'].forEach(id => $(id).addEventListener('change', saveDefaults));

  $('addParking').addEventListener('click', async () => {
    const name = $('newParkName').value.trim();
    if (!name) { toast('駐車場の名前を入力してください'); return; }
    settings.parkings.push({ name, fee: num($('newParkFee').value) });
    $('newParkName').value = '';
    $('newParkFee').value = '';
    await saveSettings();
    renderSettings();
    toast('追加しました');
  });

  $('exportData').addEventListener('click', exportData);
  $('importData').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importData(f);
  });
}

async function init() {
  bind();
  await loadSettings();
  renderSettings();
  await refresh();
  // ブラウザに勝手にデータを消されにくくする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
