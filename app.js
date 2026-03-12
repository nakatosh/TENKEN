const DB_NAME = 'inspectionPWA';
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('types')) db.createObjectStore('types', { keyPath: 'typeCd' });
      if (!db.objectStoreNames.contains('places')) {
        const s = db.createObjectStore('places', { keyPath: 'placeId' });
        s.createIndex('typeCd', 'typeCd', { unique: false });
      }
      if (!db.objectStoreNames.contains('inspections')) db.createObjectStore('inspections', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getStore(name, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(name, mode).objectStore(name);
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const hashId = (s) => 'ID' + Math.abs(s.split('').reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a; }, 0));

const state = { currentScreen: 'master', mapObj: null, mapLayer: null };

function showScreen(name) {
  state.currentScreen = name;
  document.body.classList.toggle('fullscreen-map', name === 'map');
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  document.querySelectorAll('main section').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  if (name === 'list') refreshList();
  if (name === 'map') { renderMap(); if (state.mapObj) setTimeout(() => state.mapObj.invalidateSize(), 200); }
}

async function refreshList() {
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value;
  const statusFilter = document.getElementById('filter-status').value;
  const tbody = document.getElementById('list-tbody');
  tbody.innerHTML = '';
  if (!typeCd) return;

  const storeP = await getStore('places');
  const places = await new Promise(res => {
    const req = storeP.index('typeCd').getAll(typeCd);
    req.onsuccess = () => res(req.result);
  });
  places.sort((a,b) => a.name.localeCompare(b.name, 'ja'));
  
  const storeI = await getStore('inspections');
  for (const p of places) {
    let isDone = false;
    if (date) {
      const rec = await new Promise(res => {
        const req = storeI.get(`${date}::${p.placeId}`);
        req.onsuccess = () => res(req.result);
      });
      isDone = rec?.status === 'submitted';
    }
    const st = isDone ? 'submitted' : 'pending';
    if (statusFilter !== 'all' && statusFilter !== st) continue;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${p.name}</strong></td>
      <td><span class="badge ${isDone?'complete':'pending'}">${isDone?'完了':'未完了'}</span></td>
      <td><button class="btn" onclick="openInspectForm('${p.placeId}')">入力</button></td>
    `;
    tbody.appendChild(tr);
  }
}

async function renderMap(focusPlace = null) {
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value || todayStr();
  if (!typeCd) return;
  if (!state.mapObj) {
    state.mapObj = L.map('map').setView([35.68, 139.76], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(state.mapObj);
  }
  if (state.mapLayer) state.mapLayer.remove();
  state.mapLayer = L.layerGroup().addTo(state.mapObj);

  const storeP = await getStore('places');
  const places = await new Promise(res => { const req = storeP.index('typeCd').getAll(typeCd); req.onsuccess = () => res(req.result); });
  const storeI = await getStore('inspections');
  let bounds = [];
  for (const p of places) {
    if (!p.lat || !p.lng) continue;
    const rec = await new Promise(res => { const req = storeI.get(`${date}::${p.placeId}`); req.onsuccess = () => res(req.result); });
    const isDone = rec?.status === 'submitted';
    const m = L.circleMarker([p.lat, p.lng], { radius: 15, color: isDone ? '#9ca3af' : '#2563eb', fillOpacity: 0.8 }).addTo(state.mapLayer);
    const pop = document.createElement('div');
    pop.innerHTML = `<b>${p.name}</b><br><br>`;
    const bNav = document.createElement('button'); bNav.className='btn info'; bNav.textContent='ナビ';
    bNav.onclick = () => window.open(`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`, '_blank');
    const bIns = document.createElement('button'); bIns.className='btn primary'; bIns.textContent='入力'; bIns.style.marginLeft='5px';
    bIns.onclick = () => openInspectForm(p.placeId);
    pop.appendChild(bNav); pop.appendChild(bIns);
    m.bindPopup(pop);
    bounds.push([p.lat, p.lng]);
  }
  if (bounds.length) state.mapObj.fitBounds(bounds, { padding: [50, 50] });
}

async function exportToCSV() {
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value;
  const statusFilter = document.getElementById('filter-status').value;

  if (!typeCd) { alert('点検種別を選択してください'); return; }

  const storeP = await getStore('places');
  const places = await new Promise(res => {
    const req = storeP.index('typeCd').getAll(typeCd);
    req.onsuccess = () => res(req.result);
  });
  
  const storeI = await getStore('inspections');
  const exportData = [];

  for (const p of places) {
    const rec = await new Promise(res => {
      if(!date) { res(null); return; }
      const req = storeI.get(`${date}::${p.placeId}`);
      req.onsuccess = () => res(req.result);
    });

    const isDone = rec?.status === 'submitted';
    const st = isDone ? 'submitted' : 'pending';
    if (statusFilter !== 'all' && statusFilter !== st) continue;

    const row = { '点検日': date || '', '場所名': p.name, '状況': isDone ? '完了' : '未完了' };
    if (rec?.answers) {
      Object.entries(rec.answers).forEach(([k, v]) => { row[k] = v; });
    }
    exportData.push(row);
  }

  if (exportData.length === 0) { alert('出力対象のデータがありません'); return; }

  const allKeys = new Set();
  exportData.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
  const headers = Array.from(allKeys);

  const csvContent = [
    headers.join(','),
    ...exportData.map(row => headers.map(h => `"${row[h] || ''}"`).join(','))
  ].join('\n');

  const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `inspection_${typeCd}_${date || 'all'}.csv`;
  link.click();
}

window.openInspectForm = async (placeId) => {
  const storeP = await getStore('places');
  const place = await new Promise(res => { const req = storeP.get(placeId); req.onsuccess = () => res(req.result); });
  const storeT = await getStore('types');
  const type = await new Promise(res => { const req = storeT.get(place.typeCd); req.onsuccess = () => res(req.result); });
  const date = document.getElementById('filter-date').value || todayStr();
  const form = document.getElementById('inspect-form');
  form.innerHTML = '';
  document.getElementById('form-meta').textContent = `${place.name} (${date})`;

  type.items.forEach((item, index) => {
    const row = document.createElement('div'); 
    row.className = 'form-row'; 
    row.id = `row-${index}`;
    if(index===0) row.classList.add('active-row');

    row.onclick = () => {
      if (!row.classList.contains('active-row')) {
        document.querySelectorAll('.form-row').forEach(r => r.classList.remove('active-row'));
        row.classList.add('active-row');
        row.scrollIntoView({behavior:'smooth', block:'center'});
      }
    };

    row.innerHTML = `<label style="font-size:16px; font-weight:bold; margin-bottom:10px; display:block;">${item.label}</label>`;

    const goToNext = () => {
      row.classList.remove('active-row');
      const next = document.getElementById(`row-${index+1}`);
      if(next) { next.classList.add('active-row'); next.scrollIntoView({behavior:'smooth', block:'center'}); }
      else { document.getElementById('btn-save').scrollIntoView({behavior:'smooth'}); }
    };

    if (item.inputType === 'okng') {
      const seg = document.createElement('div'); seg.className = 'segment';
      ['OK', 'NG'].forEach(v => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-btn'; b.textContent = v;
        b.onclick = (e) => { 
          e.stopPropagation(); 
          seg.querySelectorAll('button').forEach(x => x.classList.remove('active')); 
          b.classList.add('active'); 
          seg.dataset.value = v; 
          setTimeout(goToNext, 250); 
        };
        seg.appendChild(b);
      });
      seg.dataset.name = item.label; row.appendChild(seg);
    } 
    else if (item.inputType === 'select') {
      const listContainer = document.createElement('div');
      listContainer.className = 'list-options-container'; 
      listContainer.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-top:10px;';
      item.options.forEach(opt => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'seg-btn'; b.textContent = opt;
        b.style.cssText = 'text-align:left; padding:15px; font-size:16px; font-weight:bold;';
        b.onclick = (e) => {
          e.stopPropagation();
          listContainer.querySelectorAll('button').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          listContainer.dataset.value = opt;
          setTimeout(goToNext, 250);
        };
        listContainer.appendChild(b);
      });
      listContainer.dataset.name = item.label; row.appendChild(listContainer);
    } 
    else {
      const inp = document.createElement('input'); inp.name = item.label; inp.type = item.inputType;
      inp.onclick = (e) => e.stopPropagation();
      inp.onkeypress = (e) => { if(e.key==='Enter'){ e.preventDefault(); goToNext(); }};
      row.appendChild(inp);
    }
    form.appendChild(row);
  });
  state.activePlaceId = placeId; state.activeDate = date;
  showScreen('form');
  window.scrollTo(0, 0);
};

document.getElementById('btn-save').onclick = async () => {
  const answers = {}; const form = document.getElementById('inspect-form');
  form.querySelectorAll('input, select').forEach(i => answers[i.name] = i.value);
  form.querySelectorAll('.segment, .list-options-container').forEach(s => {
    if(s.dataset.name) answers[s.dataset.name] = s.dataset.value || '';
  });
  const storeI = await getStore('inspections', 'readwrite');
  await storeI.put({ id: `${state.activeDate}::${state.activePlaceId}`, status: 'submitted', answers, date: state.activeDate });
  alert('完了'); showScreen('list');
};

window.onload = () => {
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showScreen(b.dataset.nav));
  document.getElementById('btn-back-list').onclick = () => showScreen('list');
  document.getElementById('btn-cancel').onclick = () => showScreen('list');
  document.getElementById('btn-go-map').onclick = () => showScreen('map');
  document.getElementById('btn-export-csv').onclick = exportToCSV;
  ['filter-type', 'filter-date', 'filter-status'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.onchange = refreshList;
  });
  
  document.getElementById('btn-import-master').onclick = async () => {
    const f = document.getElementById('master-file').files[0]; if(!f) return;
    const text = await f.text();
    const rows = text.split(/\r?\n/).map(row => row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(v => v.replace(/^"|"$/g, '').trim()));
    const storeT = await getStore('types', 'readwrite');
    const map = new Map();
    rows.slice(1).forEach(r => { 
      if(r.length < 4) return; 
      const cd = r[0]; 
      const obj = map.get(cd) || { typeCd: cd, typeName: r[1], items: [] };
      let opts = r[5] ? r[5].split(/[、,\n]/).map(o => o.trim()).filter(o => o !== "") : [];
      obj.items.push({ label: r[2], inputType: r[3]==='3' ? 'select' : (r[3]==='4' ? 'okng' : 'text'), options: opts });
      map.set(cd, obj); 
    });
    for (const v of map.values()) await storeT.put(v);
    alert('マスター完了'); location.reload();
  };

  document.getElementById('btn-import-places').onclick = async () => {
    const f = document.getElementById('places-file').files[0]; if(!f) return;
    const text = await f.text();
    const rows = text.split(/\r?\n/).map(r => r.split(',').map(v => v.replace(/^"|"$/g, '').trim()));
    const storeP = await getStore('places', 'readwrite');
    rows.slice(1).forEach(r => { 
      if(r.length<4) return; 
      const p = { typeCd: r[0], lat: Number(r[1]), lng: Number(r[2]), name: r[3] }; 
      p.placeId = hashId(p.typeCd+p.name+p.lat); 
      storeP.put(p); 
    });
    alert('場所完了');
  };

  openDB().then(db => {
    const req = db.transaction('types').objectStore('types').getAll();
    req.onsuccess = () => { 
      const sel = document.getElementById('filter-type'); 
      req.result.forEach(t => sel.add(new Option(`${t.typeCd}: ${t.typeName}`, t.typeCd))); 
    };
  });
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(reg => console.log('SW OK')).catch(err => console.log('SW NG'));
  });
}

