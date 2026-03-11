// 【重要】ここにGASのURLを貼り付けてください（必ず半角の " " で囲む）
const GAS_URL = "ここにGASのURLを貼り付けてください";

// ===== DB関連 =====
const DB_NAME = 'inspectionPWA';
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('types')) {
        const s = db.createObjectStore('types', { keyPath: 'typeCd' });
        s.createIndex('typeName', 'typeName', { unique: false });
      }
      if (!db.objectStoreNames.contains('places')) {
        const s = db.createObjectStore('places', { keyPath: 'placeId' });
        s.createIndex('typeCd', 'typeCd', { unique: false });
      }
      if (!db.objectStoreNames.contains('inspections')) {
        const s = db.createObjectStore('inspections', { keyPath: 'id' });
        s.createIndex('typeCd', 'typeCd', { unique: false });
        s.createIndex('date', 'date', { unique: false });
        s.createIndex('placeId', 'placeId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txStore(db, name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}

function idbGetAll(store) {
  return new Promise((res) => { const req = store.getAll(); req.onsuccess = () => res(req.result); });
}

function idbPut(store, val) {
  return new Promise((res) => { const r = store.put(val); r.onsuccess = () => res(); });
}

function idbClear(store) {
  return new Promise((res) => { const r = store.clear(); r.onsuccess = () => res(); });
}

function idbGet(store, key) {
  return new Promise((res) => { const r = store.get(key); r.onsuccess = () => res(r.result); });
}

function idbIndexGetAll(store, indexName, key) {
  return new Promise((res) => { const idx = store.index(indexName); const r = idx.getAll(key); r.onsuccess = () => res(r.result); });
}

// ===== ユーティリティ =====
const todayStr = () => new Date().toISOString().slice(0, 10);

function hashId(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return 'ID' + Math.abs(h);
}

function csvParse(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQ = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQ = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') pushField();
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        pushField();
        if (row.length > 1 || (row.length === 1 && row !== '')) pushRow();
      } else {
        field += c;
      }
    }
    i++;
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}

function downloadFile(filename, content) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

const palette = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#22d3ee', '#84cc16', '#fb923c', '#06b6d4'];
function colorForTypeCd(typeCd) {
  const n = parseInt(typeCd, 10);
  return Number.isNaN(n) ? '#3b82f6' : palette[n % palette.length];
}

// ===== アプリの状態管理 =====
const state = { current: 'master', selectedType: null, selectedDate: todayStr(), status: 'all', currentPlace: null, currentTypeObj: null };

function showScreen(name) {
  state.current = name;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  if (name === 'list') refreshList();
  if (name === 'map') renderMap();
  if (name === 'master') renderTypeList();
}

// ===== 各種機能 =====
async function importMaster(file) {
  const text = await file.text();
  const rows = csvParse(text);
  if (rows.length < 2) throw new Error('行がありません');
  const header = rows.map(h => h.trim());
  const idx = {
    typeCd: header.indexOf('点検種類CD'),
    typeName: header.indexOf('点検種類'),
    item: header.indexOf('項目'),
    inputCd: header.indexOf('入力種別CD'),
    inputName: header.indexOf('入力種別'),
    opts: header.indexOf('選択肢')
  };
  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 6) continue;
    const typeCd = (row[idx.typeCd] || '').trim();
    const typeName = (row[idx.typeName] || '').trim();
    const itemLabel = (row[idx.item] || '').trim();
    const inputCd = (row[idx.inputCd] || '').trim();
    const rawOpts = (row[idx.opts] || '').trim();
    
    if (!typeCd || !typeName || !itemLabel) continue;
    
    let inputType = 'text';
    if (inputCd === '1') inputType = 'number';
    else if (inputCd === '3') inputType = 'select';
    else if (inputCd === '4') inputType = 'okng';
    
    let options = [];
    if (inputType === 'select') {
      options = rawOpts.replace(/、/g, ',').split(',').map(s => s.trim()).filter(s => s);
    }
    
    const obj = map.get(typeCd) || { typeCd, typeName, items: [] };
    obj.items.push({ order: obj.items.length + 1, label: itemLabel, inputType, options });
    map.set(typeCd, obj);
  }
  const db = await openDB();
  const store = txStore(db, 'types', 'readwrite');
  for (const v of map.values()) await idbPut(store, v);
}

async function renderTypeList() {
  const db = await openDB();
  const types = await idbGetAll(txStore(db, 'types'));
  const ul = document.getElementById('type-list');
  ul.innerHTML = '';
  types.sort((a, b) => parseInt(a.typeCd, 10) - parseInt(b.typeCd, 10)).forEach(t => {
    const li = document.createElement('li');
    li.textContent = `${t.typeCd}: ${t.typeName}（項目${t.items.length}件）`;
    ul.appendChild(li);
  });
  populateTypeSelects(types);
}

function populateTypeSelects(types) {
  const selects = [document.getElementById('filter-type'), document.getElementById('map-type')];
  for (const sel of selects) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">選択</option>' + types.sort((a, b) => parseInt(a.typeCd) - parseInt(b.typeCd)).map(t => `<option value="${t.typeCd}">${t.typeCd}: ${t.typeName}</option>`).join('');
    if (cur) sel.value = cur;
  }
}

async function importPlaces(file) {
  const text = await file.text();
  const rows = csvParse(text);
  if (rows.length < 2) throw new Error('行がありません');
  const header = rows.map(h => h.trim());
  const is4 = header.includes('緯度');
  const idx = {
    typeCd: header.indexOf('点検種類CD'),
    lat: is4 ? header.indexOf('緯度') : header.indexOf('緯度経度'),
    lng: is4 ? header.indexOf('経度') : -1,
    name: header.indexOf('名称')
  };
  let imported = 0;
  const db = await openDB();
  const store = txStore(db, 'places', 'readwrite');
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length) continue;
    const typeCd = (row[idx.typeCd] || '').trim();
    if (!typeCd) continue;
    
    let lat = null, lng = null;
    if (is4) {
      lat = (row[idx.lat] || '').trim();
      lng = (row[idx.lng] || '').trim();
    } else {
      const combo = (row[idx.lat] || '').trim();
      if (combo.includes(',')) [lat, lng] = combo.split(',').map(s => s.trim());
    }
    const name = (row[idx.name] || '').trim();
    const placeId = hashId(`${typeCd}::${name}::${lat || ''}::${lng || ''}`);
    await idbPut(store, { placeId, typeCd, name, lat: lat ? Number(lat) : null, lng: lng ? Number(lng) : null });
    imported++;
  }
  return { imported };
}

async function refreshList() {
  const db = await openDB();
  const types = await idbGetAll(txStore(db, 'types'));
  if (types.length === 0) {
    document.getElementById('list-tbody').innerHTML = '<tr><td colspan="4">まずマスターを取り込んでください</td></tr>';
    return;
  }
  populateTypeSelects(types);
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value || todayStr();
  const statusSel = document.getElementById('filter-status').value;
  
  if (!typeCd) {
    document.getElementById('list-tbody').innerHTML = '<tr><td colspan="4">点検種類を選択してください</td></tr>';
    return;
  }
  
  const places = (await idbIndexGetAll(txStore(db, 'places'), 'typeCd', typeCd)).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const tbody = document.getElementById('list-tbody');
  tbody.innerHTML = '';
  const inspStore = txStore(db, 'inspections');
  
  for (const p of places) {
    const rec = await idbGet(inspStore, `${date}::${p.placeId}`);
    const status = rec?.status === 'submitted' ? 'submitted' : 'pending';
    if (statusSel !== 'all' && statusSel !== status) continue;
    
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${p.name}</td><td>${p.lat ? `${p.lat}, ${p.lng}` : 'なし'}</td><td><span class="badge ${status === 'submitted' ? 'complete' : 'pending'}">${status === 'submitted' ? '完了' : '未完了'}</span></td>`;
    
    const tdOp = document.createElement('td');
    const btnGo = document.createElement('button');
    btnGo.className = 'btn';
    btnGo.textContent = '点検';
    btnGo.onclick = async () => {
      const typeObj = (await idbGet(txStore(db, 'types'), typeCd));
      openForm(typeObj, p, date);
    };
    tdOp.appendChild(btnGo);
    tr.appendChild(tdOp);
    tbody.appendChild(tr);
  }
}

let mapObj = null;
let mapLayer = null;

async function renderMap() {
  const typeCd = document.getElementById('map-type').value;
  const date = document.getElementById('map-date').value || todayStr();
  const status = document.getElementById('map-status').value;
  const db = await openDB();
  const types = await idbGetAll(txStore(db, 'types'));
  populateTypeSelects(types);
  
  if (!typeCd) {
    document.getElementById('legend').innerHTML = '<span class="helper">種類を選択してください</span>';
    return;
  }
  
  if (!mapObj) {
    mapObj = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(mapObj);
  }
  if (mapLayer) { mapLayer.remove(); }
  mapLayer = L.layerGroup().addTo(mapObj);
  
  const places = await idbIndexGetAll(txStore(db, 'places'), 'typeCd', typeCd);
  const inspStore = txStore(db, 'inspections');
  let bounds = [];
  const colorActive = colorForTypeCd(typeCd);
  document.getElementById('legend').innerHTML = `<div class="chip"><span class="dot" style="background:${colorActive}"></span>未完了</div><div class="chip"><span class="dot" style="background:#9ca3af"></span>完了</div>`;
  
  for (const p of places) {
    if (p.lat == null || p.lng == null) continue;
    const rec = await idbGet(inspStore, `${date}::${p.placeId}`);
    const isDone = rec?.status === 'submitted';
    if (status !== 'all' && status !== (isDone ? 'submitted' : 'pending')) continue;
    
    const color = isDone ? '#9ca3af' : colorActive;
    const m = L.circleMarker([p.lat, p.lng], { radius: 10, color: color, fillColor: color, fillOpacity: 0.9 });
    const popup = document.createElement('div');
    popup.innerHTML = `<strong>${p.name}</strong><br><button class="btn" style="margin-top:5px">点検開始</button>`;
    popup.querySelector('button').onclick = async () => {
      const typeObj = await idbGet(txStore(db, 'types'), typeCd);
      openForm(typeObj, p, date);
    };
    m.bindPopup(popup);
    m.addTo(mapLayer);
    bounds.push([p.lat, p.lng]);
  }
  if (bounds.length) mapObj.fitBounds(bounds, {padding:});
  else mapObj.setView([35.6812, 139.7671], 10);
}

async function openForm(typeObj, place, date) {
  state.currentTypeObj = typeObj;
  state.currentPlace = place;
  const formSec = document.getElementById('inspect-form');
  formSec.innerHTML = '';
  document.getElementById('form-meta').textContent = `${typeObj.typeName} ／ ${place.name} ／ ${date}`;
  
  for (const item of typeObj.items) {
    const row = document.createElement('div');
    row.className = 'form-row';
    const label = document.createElement('label');
    label.textContent = item.label;
    row.appendChild(label);
    
    if (item.inputType === 'number' || item.inputType === 'text') {
      const inp = document.createElement('input');
      inp.type = item.inputType;
      inp.name = item.label;
      row.appendChild(inp);
    } else if (item.inputType === 'select') {
      const sel = document.createElement('select');
      sel.name = item.label;
      sel.innerHTML = '<option value="">選択</option>' + (item.options || []).map(o => `<option value="${o}">${o}</option>`).join('');
      row.appendChild(sel);
    } else if (item.inputType === 'okng') {
      const seg = document.createElement('div');
      seg.className = 'segment';
      ['OK', 'NG'].forEach(txt => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg-btn';
        b.textContent = txt;
        b.style.background = txt === 'OK' ? 'var(--ok)' : 'var(--ng)';
        b.style.color = '#fff';
        b.onclick = () => {
          seg.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          seg.dataset.value = txt;
        };
        seg.appendChild(b);
      });
      seg.dataset.value = '';
      seg.dataset.name = item.label;
      row.appendChild(seg);
    }
    formSec.appendChild(row);
  }
  showScreen('form');
  document.getElementById('btn-save').onclick = () => saveInspection(date);
  document.getElementById('btn-cancel').onclick = () => showScreen('list');
}

async function saveInspection(date) {
  const place = state.currentPlace;
  const typeObj = state.currentTypeObj;
  const formSec = document.getElementById('inspect-form');
  const answers = {};
  
  formSec.querySelectorAll('input, select').forEach(el => { answers[el.name] = el.value; });
  formSec.querySelectorAll('.segment').forEach(seg => { if (seg.dataset.name) answers[seg.dataset.name] = seg.dataset.value || ''; });
  
  const id = `${date}::${place.placeId}`;
  const rec = { id, date, typeCd: typeObj.typeCd, placeId: place.placeId, status: 'submitted', answers };
  const db = await openDB();
  await idbPut(txStore(db, 'inspections', 'readwrite'), rec);
  
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = '送信中...';
  
  try {
    if (GAS_URL && GAS_URL.startsWith('http')) {
      await fetch(GAS_URL, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rec)
      });
      alert('保存し、スプレッドシートへ送信しました！');
    } else {
      alert('保存しました（ローカルのみ。GASのURLが正しく設定されていません）');
    }
  } catch (err) {
    console.error(err);
    alert('クラウド送信エラー。端末内にのみ保存しました。');
  } finally {
    btn.disabled = false;
    btn.textContent = '完了として保存';
    showScreen('list');
  }
}

async function exportCsv() {
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value || todayStr();
  const db = await openDB();
  const typeObj = await idbGet(txStore(db, 'types'), typeCd);
  const places = await idbIndexGetAll(txStore(db, 'places'), 'typeCd', typeCd);
  const rows = [['対象日', '点検種類', '名称', '緯度', '経度', '状態', ...typeObj.items.map(i => i.label)]];
  
  for (const p of places) {
    const rec = await idbGet(txStore(db, 'inspections'), `${date}::${p.placeId}`);
    const ans = rec?.answers || {};
    rows.push([date, typeObj.typeName, p.name, p.lat ?? '', p.lng ?? '', rec ? '完了' : '未完了', ...typeObj.items.map(i => ans[i.label] ?? '')]);
  }
  const content = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadFile(`export_${date}.csv`, content);
}

window.addEventListener('DOMContentLoaded', async () => {
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.nav)));
  document.getElementById('filter-date').value = todayStr();
  document.getElementById('map-date').value = todayStr();
  
  document.getElementById('btn-import-master').onclick = async () => {
    const f = document.getElementById('master-file').files;
    if (f) { await importMaster(f); renderTypeList(); alert('取込完了'); }
  };
  
  document.getElementById('btn-clear-master').onclick = async () => {
    if (confirm('マスターを全削除しますか？')) { const db = await openDB(); await idbClear(txStore(db, 'types', 'readwrite')); renderTypeList(); }
  };
  
  document.getElementById('btn-import-places').onclick = async () => {
    const f = document.getElementById('places-file').files;
    if (f) { const r = await importPlaces(f); alert(`${r.imported}件 取込完了`); }
  };
  
  document.getElementById('btn-clear-places').onclick = async () => {
    if (confirm('場所を全削除しますか？')) { const db = await openDB(); await idbClear(txStore(db, 'places', 'readwrite')); alert('削除完了'); }
  };
  
  ['filter-type', 'filter-date', 'filter-status'].forEach(id => document.getElementById(id).addEventListener('change', refreshList));
  document.getElementById('btn-go-map').onclick = () => { document.getElementById('map-type').value = document.getElementById('filter-type').value; showScreen('map'); renderMap(); };
  document.getElementById('btn-export').onclick = exportCsv;
  ['map-type', 'map-date', 'map-status'].forEach(id => document.getElementById(id).addEventListener('change', () => renderMap()));
  document.getElementById('btn-back-list').onclick = () => showScreen('list');
  
  await renderTypeList();
});
// ↑ これより下には何も書かない（ここでファイルを終わらせる）
