
// ===== IndexedDB helper (promise-style) =====
const DB_NAME = 'inspectionPWA';
const DB_VER = 1;
function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('types')){
        const s = db.createObjectStore('types', { keyPath: 'typeCd' });
        s.createIndex('typeName', 'typeName', {unique:false});
      }
      if(!db.objectStoreNames.contains('places')){
        const s = db.createObjectStore('places', { keyPath: 'placeId' });
        s.createIndex('typeCd', 'typeCd', {unique:false});
      }
      if(!db.objectStoreNames.contains('inspections')){
        const s = db.createObjectStore('inspections', { keyPath: 'id' });
        s.createIndex('typeCd', 'typeCd', {unique:false});
        s.createIndex('date', 'date', {unique:false});
        s.createIndex('placeId', 'placeId', {unique:false});
        s.createIndex('typeCd_date', ['typeCd','date'], {unique:false});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function txStore(db, name, mode='readonly'){
  return db.transaction(name, mode).objectStore(name);
}
function idbGetAll(store){
  return new Promise((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
function idbPut(store, val){
  return new Promise((res, rej) => { const r = store.put(val); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
}
function idbClear(store){
  return new Promise((res, rej) => { const r = store.clear(); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); });
}
function idbGet(store, key){
  return new Promise((res, rej) => { const r = store.get(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}
function idbIndexGetAll(store, indexName, key){
  return new Promise((res, rej) => { const idx = store.index(indexName); const r = idx.getAll(key); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
}

// ===== Utilities =====
const todayStr = () => new Date().toISOString().slice(0,10);
function hashId(str){ let h=0; for(let i=0;i<str.length;i++){ h=(h*31 + str.charCodeAt(i))|0; } return 'ID'+Math.abs(h); }
function csvParse(text){
  const rows=[]; let i=0, field='', row=[], inQ=false;
  const pushField=()=>{ row.push(field); field=''; };
  const pushRow=()=>{ rows.push(row); row=[]; };
  while(i<text.length){
    const c=text[i];
    if(inQ){
      if(c==='"'){
        if(text[i+1]==='"'){ field+='"'; i++; } else { inQ=false; }
      } else { field+=c; }
    } else {
      if(c==='"') inQ=true;
      else if(c===',') pushField();
      else if(c==='
' || c===''){
        if(c==='' && text[i+1]==='
'){ i++; }
        pushField();
        if(row.length>1 || (row.length===1 && row[0]!=='')) pushRow();
      } else { field+=c; }
    }
    i++;
  }
  if(field!=='' || row.length>0){ pushField(); pushRow(); }
  return rows;
}
function downloadFile(filename, content, mime='text/plain;charset=utf-8'){
  const blob = new Blob([content], {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
const palette = ['#ef4444','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899','#22d3ee','#84cc16','#fb923c','#06b6d4'];
function colorForTypeCd(typeCd){ const n=parseInt(typeCd,10); if(Number.isNaN(n)) return '#3b82f6'; return palette[n % palette.length]; }

// ===== App State & Navigation =====
const state = { current: 'master' };
function showScreen(name){
  state.current = name;
  document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active', b.dataset.nav===name));
  document.querySelectorAll('main section').forEach(s=>s.classList.toggle('active', s.id === `screen-${name}`));
  // 地図はフルスクリーンで表示（検索UI不要）
  if(name==='map') document.body.classList.add('fullscreen-map'); else document.body.classList.remove('fullscreen-map');
  if(name==='list') refreshList();
  if(name==='map') renderMap();
  if(name==='master') renderTypeList();
}

// ===== Master Import =====
async function importMaster(file){
  const text = await file.text();
  const rows = csvParse(text);
  if(rows.length<2) throw new Error('行がありません');
  const header = rows[0].map(h=>h.trim());
  const idx = {
    typeCd: header.indexOf('点検種類CD'),
    typeName: header.indexOf('点検種類'),
    item: header.indexOf('項目'),
    inputCd: header.indexOf('入力種別CD'),
    inputName: header.indexOf('入力種別'),
    opts: header.indexOf('選択肢')
  };
  if(Object.values(idx).some(v=>v===-1)) throw new Error('ヘッダが不正です');
  const map = new Map();
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(row.length<6) continue;
    const typeCd = (row[idx.typeCd]||'').trim();
    const typeName = (row[idx.typeName]||'').trim();
    const itemLabel = (row[idx.item]||'').trim();
    const inputCd = (row[idx.inputCd]||'').trim();
    const rawOpts = (row[idx.opts]||'').trim();
    if(!typeCd || !typeName || !itemLabel) continue;
    let inputType = 'text';
    if(inputCd==='1') inputType='number';
    else if(inputCd==='2') inputType='text';
    else if(inputCd==='3') inputType='select';
    else if(inputCd==='4') inputType='okng';
    // OK/NG の表記ゆれ吸収（OKNG / OK,NG / OK、NG）
    const rawUpper = rawOpts.toUpperCase().replace(/\s/g,'');
    if(inputType!=='okng' && (rawUpper==='OKNG' || rawUpper==='OK,NG' || rawUpper==='OK、NG')){
      inputType='okng';
    }
    let options = [];
    if(inputType==='select'){
      const replaced = rawOpts.replace(/、/g, ',');
      options = replaced.split(',').map(s=>s.trim()).filter(s=>s);
    }
    const obj = map.get(typeCd) || { typeCd, typeName, items: [] };
    obj.items.push({ order: obj.items.length+1, label: itemLabel, inputType, options });
    map.set(typeCd, obj);
  }
  const db = await openDB();
  const store = txStore(db, 'types', 'readwrite');
  for(const v of map.values()){
    await idbPut(store, v);
  }
}
async function renderTypeList(){
  const db = await openDB();
  const types = await idbGetAll(txStore(db,'types'));
  const ul = document.getElementById('type-list');
  ul.innerHTML = '';
  types.sort((a,b)=>parseInt(a.typeCd,10)-parseInt(b.typeCd,10)).forEach(t=>{
    const li = document.createElement('li');
    li.textContent = `${t.typeCd}: ${t.typeName}（項目${t.items.length}件）`;
    ul.appendChild(li);
  });
  populateTypeSelects(types);
}
function populateTypeSelects(types){
  const selects = [document.getElementById('filter-type'), document.getElementById('map-type')];
  for(const sel of selects){
    const cur = sel.value;
    sel.innerHTML = '<option value="">選択してください</option>' +
      types.sort((a,b)=>parseInt(a.typeCd)-parseInt(b.typeCd)).map(t=>`<option value="${t.typeCd}">${t.typeCd}: ${t.typeName}</option>`).join('');
    if(cur) sel.value = cur;
  }
}

// ===== Place Import =====
async function importPlaces(file){
  const text = await file.text();
  const rows = csvParse(text);
  if(rows.length<2) throw new Error('行がありません');
  const header = rows[0].map(h=>h.trim());
  const is4 = header.includes('緯度') && header.includes('経度');
  const idx = {
    typeCd: header.indexOf('点検種類CD'),
    lat: is4 ? header.indexOf('緯度') : header.indexOf('緯度経度'),
    lng: is4 ? header.indexOf('経度') : -1,
    name: header.indexOf('名称')
  };
  if(idx.typeCd===-1 || idx.lat===-1 || idx.name===-1) throw new Error('ヘッダが不正です');
  let warnings = 0, imported=0;
  const db = await openDB();
  const store = txStore(db,'places','readwrite');
  for(let r=1;r<rows.length;r++){
    const row = rows[r];
    if(row.length<header.length) continue;
    const typeCd = (row[idx.typeCd]||'').trim();
    if(!typeCd) continue;
    let lat=null, lng=null;
    if(is4){ lat = (row[idx.lat]||'').trim(); lng = (row[idx.lng]||'').trim(); }
    else { const combo = (row[idx.lat]||'').trim(); if(combo.includes(',')) [lat,lng] = combo.split(',').map(s=>s.trim()); else if(combo.includes(' ')) [lat,lng] = combo.split(' ').map(s=>s.trim()); }
    const name = (row[idx.name]||'').trim();
    const placeId = hashId(`${typeCd}::${name}::${lat||''}::${lng||''}`);
    if(!lat || !lng){ warnings++; }
    await idbPut(store, { placeId, typeCd, name, lat: lat?Number(lat):null, lng: lng?Number(lng):null });
    imported++;
  }
  return {imported, warnings};
}

// ===== List Screen =====
async function refreshList(){
  const db = await openDB();
  const types = await idbGetAll(txStore(db,'types'));
  if(types.length===0){ document.getElementById('list-tbody').innerHTML = '<tr><td colspan="4">まずマスターを取り込んでください</td></tr>'; return; }
  populateTypeSelects(types);
  const typeSel = document.getElementById('filter-type');
  const dateInp = document.getElementById('filter-date');
  const statusSel = document.getElementById('filter-status');
  if(!dateInp.value) dateInp.value = todayStr();
  if(!typeSel.value){ document.getElementById('list-tbody').innerHTML = '<tr><td colspan="4">点検種類を選択してください</td></tr>'; return; }
  const typeCd = typeSel.value;
  const date = dateInp.value;
  const places = (await idbIndexGetAll(txStore(db,'places'),'typeCd', typeCd))
                   .sort((a,b)=>a.name.localeCompare(b.name,'ja'));
  const tbody = document.getElementById('list-tbody');
  tbody.innerHTML = '';
  const inspStore = txStore(db,'inspections');
  for(const p of places){
    const recId = `${date}::${p.placeId}`;
    const rec = await idbGet(inspStore, recId);
    const status = rec?.status==='submitted' ? 'submitted' : 'pending';
    if(statusSel.value!=='all' && statusSel.value!==status) continue;
    const tr = document.createElement('tr');
    const coord = (p.lat!=null && p.lng!=null) ? `${p.lat}, ${p.lng}` : '<span class="helper">（位置なし）</span>';
    tr.innerHTML = `<td>${p.name}</td><td>${coord}</td><td><span class="badge ${status==='submitted'?'complete':'pending'}">${status==='submitted'?'完了':'未完了'}</span></td>`;
    const tdOp = document.createElement('td');
    const btnGo = document.createElement('button'); btnGo.className='btn'; btnGo.textContent='点検入力';
    btnGo.onclick = async ()=>{ const typeObj = (await idbGet(txStore(db,'types'), typeCd)); openForm(typeObj, p, date); };

    const btnMap = document.createElement('button'); btnMap.className='btn info'; btnMap.textContent='地図で表示';
    btnMap.onclick = ()=>{
      document.getElementById('map-type').value = typeCd;
      document.getElementById('map-date').value = date;
      document.getElementById('map-status').value = statusSel.value;
      document.body.classList.add('fullscreen-map');
      showScreen('map'); renderMap(p);
    };
    tdOp.appendChild(btnGo); tdOp.appendChild(btnMap); tr.appendChild(tdOp);
    tbody.appendChild(tr);
  }
}

// ===== Map =====
let mapObj = null; let mapLayer = null;
async function renderMap(focusPlace=null){
  const typeCd = document.getElementById('map-type').value;
  const date = document.getElementById('map-date').value || todayStr();
  const status = document.getElementById('map-status').value || 'all';
  const db = await openDB();
  const types = await idbGetAll(txStore(db,'types'));
  populateTypeSelects(types);
  if(!typeCd){
    document.getElementById('legend').innerHTML = '<span class="helper">点検種類を選択してください（一覧から遷移してください）</span>';
    document.getElementById('map').innerHTML = '';
    return;
  }
  const places = await idbIndexGetAll(txStore(db,'places'),'typeCd', typeCd);
  const inspStore = txStore(db,'inspections');
  const colorActive = colorForTypeCd(typeCd);
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  const chipA = document.createElement('div'); chipA.className='chip'; chipA.innerHTML = `<span class="dot" style="background:${colorActive}"></span><span>未完了</span>`; legend.appendChild(chipA);
  const chipB = document.createElement('div'); chipB.className='chip'; chipB.innerHTML = `<span class="dot" style="background:#9ca3af"></span><span>完了</span>`; legend.appendChild(chipB);

  if(!mapObj){
    mapObj = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(mapObj);
  }
  if(mapLayer){ mapLayer.remove(); }
  mapLayer = L.layerGroup().addTo(mapObj);

  let bounds = [];
  for(const p of places){
    if(p.lat==null || p.lng==null) continue;
    const rec = await idbGet(inspStore, `${date}::${p.placeId}`);
    const isDone = rec?.status==='submitted';
    const thisStatus = isDone ? 'submitted' : 'pending';
    if(status!=='all' && status!==thisStatus) continue;
    const color = isDone ? '#9ca3af' : colorActive; // gray if done
    const m = L.circleMarker([p.lat, p.lng], {radius:10, color:color, fillColor:color, fillOpacity:0.9});

    const popup = document.createElement('div');
    popup.innerHTML = `<div style="margin-bottom:6px"><strong>${p.name}</strong></div><div class="small" style="margin-bottom:8px">${p.lat}, ${p.lng}</div>`;

    const btnStart = document.createElement('button'); btnStart.className='btn primary'; btnStart.textContent='点検を開始';
    btnStart.onclick = async ()=>{ const typeObj = await idbGet(txStore(db,'types'), typeCd); document.body.classList.remove('fullscreen-map'); openForm(typeObj, p, date); };

    const btnGo = document.createElement('button'); btnGo.className='btn'; btnGo.style.marginLeft='8px'; btnGo.textContent='ここへ行く';
    btnGo.onclick = ()=>{
      if(p.lat!=null && p.lng!=null){ const url = `https://www.google.com/maps?q=${encodeURIComponent(p.lat)},${encodeURIComponent(p.lng)}`; window.open(url, '_blank', 'noopener'); }
      else { alert('この地点には緯度経度が設定されていません'); }
    };

    const wrap = document.createElement('div'); wrap.style.display='flex'; wrap.style.flexWrap='wrap'; wrap.appendChild(btnStart); wrap.appendChild(btnGo);
    popup.appendChild(wrap);

    m.bindPopup(popup);
    m.addTo(mapLayer);
    bounds.push([p.lat,p.lng]);
    if(focusPlace && focusPlace.placeId===p.placeId){ setTimeout(()=>m.openPopup(), 250); }
  }
  if(bounds.length){ mapObj.fitBounds(bounds, {padding:[30,30]}); }
  else { mapObj.setView([26.2125, 127.6809], 10); }
}

// ===== Form =====
async function openForm(typeObj, place, date){
  const formSec = document.getElementById('inspect-form');
  formSec.innerHTML = '';
  const meta = document.getElementById('form-meta');
  meta.textContent = `種類：${typeObj.typeCd} ${typeObj.typeName} ／ 場所：${place.name} ／ 日付：${date}`;
  for(const item of typeObj.items){
    const row = document.createElement('div'); row.className='form-row';
    const label = document.createElement('label'); label.textContent = item.label; row.appendChild(label);
    if(item.inputType==='number'){
      const inp = document.createElement('input'); inp.type='number'; inp.name=item.label; row.appendChild(inp);
    } else if(item.inputType==='text'){
      const inp = document.createElement('input'); inp.type='text'; inp.name=item.label; row.appendChild(inp);
    } else if(item.inputType==='select'){
      if(item.options && item.options.length===2){
        const seg = document.createElement('div'); seg.className='segment';
        item.options.forEach(opt=>{
          const b = document.createElement('button'); b.type='button'; b.className='seg-btn'; b.textContent=opt;
          b.onclick = ()=>{ seg.querySelectorAll('.seg-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); seg.dataset.value = opt; };
          seg.appendChild(b);
        });
        seg.dataset.value = '';
        seg.dataset.name = item.label;
        row.appendChild(seg);
      } else {
        const sel = document.createElement('select'); sel.name=item.label;
        sel.innerHTML = '<option value="">選択</option>' + (item.options||[]).map(o=>`<option value="${o}">${o}</option>`).join('');
        row.appendChild(sel);
      }
    } else if(item.inputType==='okng'){
      const seg = document.createElement('div'); seg.className='segment';
      const ok = document.createElement('button'); ok.type='button'; ok.className='seg-btn ok-button'; ok.textContent='OK'; ok.setAttribute('aria-pressed','false');
      const ng = document.createElement('button'); ng.type='button'; ng.className='seg-btn ng-button'; ng.textContent='NG'; ng.setAttribute('aria-pressed','false');
      const setActive = (btn, value)=>{ seg.querySelectorAll('.seg-btn').forEach(x=>{ x.classList.remove('active'); x.setAttribute('aria-pressed','false'); }); btn.classList.add('active'); btn.setAttribute('aria-pressed','true'); seg.dataset.value=value; };
      ok.onclick = ()=> setActive(ok,'OK');
      ng.onclick = ()=> setActive(ng,'NG');
      seg.dataset.value=''; seg.dataset.name=item.label;
      seg.appendChild(ok); seg.appendChild(ng);
      row.appendChild(seg);
    }
    formSec.appendChild(row);
  }
  showScreen('form');
  document.getElementById('btn-save').onclick = ()=>saveInspection(date, place, typeObj);
  document.getElementById('btn-cancel').onclick = ()=>{ showScreen('list'); };
}

async function saveInspection(date, place, typeObj){
  const formSec = document.getElementById('inspect-form');
  const answers = {};
  formSec.querySelectorAll('input, select').forEach(el=>{ answers[el.name]=el.value; });
  formSec.querySelectorAll('.segment').forEach(seg=>{ const name = seg.dataset.name; if(name) answers[name] = seg.dataset.value || ''; });
  const id = `${date}::${place.placeId}`;
  const rec = { id, date, typeCd: typeObj.typeCd, placeId: place.placeId, status: 'submitted', answers, ts: new Date().toISOString() };
  const db = await openDB(); await idbPut(txStore(db,'inspections','readwrite'), rec);
  alert('保存しました（完了）');
  showScreen('list');
}

// ===== Export CSV =====
async function exportCsv(){
  const typeCd = document.getElementById('filter-type').value;
  const date = document.getElementById('filter-date').value || todayStr();
  const status = document.getElementById('filter-status').value;
  const db = await openDB();
  const typeObj = await idbGet(txStore(db,'types'), typeCd);
  const places = await idbIndexGetAll(txStore(db,'places'),'typeCd', typeCd);
  const insp = txStore(db,'inspections');
  const headers = ['対象日','点検種類CD','点検種類','名称','緯度','経度','状態', ...typeObj.items.map(i=>i.label)];
  const rows = [headers];
  for(const p of places){
    const rec = await idbGet(insp, `${date}::${p.placeId}`);
    const isDone = rec?.status==='submitted';
    const st = isDone?'完了':'未完了';
    if(status==='submitted' && !isDone) continue;
    if(status==='pending' && isDone) continue;
    const ans = {};
    if(rec && rec.answers){ Object.assign(ans, rec.answers); }
    const row = [date, typeObj.typeCd, typeObj.typeName, p.name, p.lat??'', p.lng??'', st, ...typeObj.items.map(i=> ans[i.label]??'')];
    rows.push(row);
  }
  const content = rows.map(r=>r.map(cell=>{
    const s = (cell==null? '': String(cell));
    return (s.includes(',')||s.includes('"')||s.includes('
')) ? '"'+ s.replace(/"/g,'""') +'"' : s;
  }).join(',')).join('
');
  downloadFile(`export_${typeObj.typeCd}_${date}.csv`, content, 'text/csv;charset=utf-8');
}

// ===== Event bindings =====
window.addEventListener('DOMContentLoaded', async ()=>{
  // nav
  document.querySelectorAll('nav button').forEach(b=> b.addEventListener('click', ()=>{ showScreen(b.dataset.nav); }));
  // set initial dates
  document.getElementById('filter-date').value = todayStr();
  document.getElementById('map-date').value = todayStr();

  // master import
  document.getElementById('btn-import-master').onclick = async ()=>{
    const f = document.getElementById('master-file').files[0];
    if(!f){ alert('CSVファイルを選択してください'); return; }
    try{ await importMaster(f); document.getElementById('master-result').textContent = '取り込み完了。種類リストを更新しました。'; await renderTypeList(); }
    catch(err){ alert('エラー：'+err.message); }
  };
  document.getElementById('btn-clear-master').onclick = async ()=>{
    if(!confirm('マスター（種類）を全削除します。よろしいですか？')) return;
    const db = await openDB(); await idbClear(txStore(db,'types','readwrite'));
    await renderTypeList();
  };

  // place import
  document.getElementById('btn-import-places').onclick = async ()=>{
    const f = document.getElementById('places-file').files[0];
    if(!f){ alert('CSVファイルを選択してください'); return; }
    try{ const {imported, warnings} = await importPlaces(f); document.getElementById('places-result').textContent = `取り込み：${imported} 件（警告：緯度経度なし ${warnings} 件）`; }
    catch(err){ alert('エラー：'+err.message); }
  };
  document.getElementById('btn-clear-places').onclick = async ()=>{
    if(!confirm('点検場所を全削除します。よろしいですか？')) return;
    const db = await openDB(); await idbClear(txStore(db,'places','readwrite'));
    document.getElementById('places-result').textContent = '削除しました';
  };

  // list
  ['filter-type','filter-date','filter-status'].forEach(id=> document.getElementById(id).addEventListener('change', refreshList));
  document.getElementById('btn-go-map').onclick = ()=>{
    document.getElementById('map-type').value = document.getElementById('filter-type').value;
    document.getElementById('map-date').value = document.getElementById('filter-date').value;
    document.getElementById('map-status').value = document.getElementById('filter-status').value;
    document.body.classList.add('fullscreen-map');
    showScreen('map'); renderMap();
  };
  document.getElementById('btn-export').onclick = exportCsv;

  // map change (UI は非表示になるが内部値は維持)
  ['map-type','map-date','map-status'].forEach(id=> document.getElementById(id).addEventListener('change', ()=>renderMap()));
  document.getElementById('btn-back-list').onclick = ()=>{ document.body.classList.remove('fullscreen-map'); showScreen('list'); };

  await renderTypeList();
});
