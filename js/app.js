/* App: UI, worker, view (pan/zoom), cached frames, panels, save/load/export */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const canvas = $('#map'), ctx = canvas.getContext('2d', { alpha: false });
const DEF = { cells: 12000, land: 0.42, rough: 0.5, states: 8, towns: 60, rivers: 0.07, km: 2400, climate: 'temperate', shape: 'classic' };
const S = {
  map: null, params: null, edits: { states: {}, burgs: {}, name: null },
  layers: { biomes: true, relief: true, states: true, borders: true, rivers: true, roads: true, burgs: true, labels: true, waves: true, hex: false },
  hexKm: 40, selState: null, selBurg: null, ruler: null, rulerOn: false
};
let dpr = Math.min(window.devicePixelRatio || 1, 2);
let vw = innerWidth, vh = innerHeight;
let view = { scale: 1, x: 0, y: 0 }, fit = 1;
let cache = null, crisp = null, crispTimer = 0, rafId = 0, sortedBurgs = [];
const randSeed = () => Math.random().toString(36).slice(2, 8);
const fmt = n => Math.round(n).toLocaleString('ru-RU');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- worker ----------
let worker = null;
try { worker = new Worker('js/gen.js?v=4'); } catch (e) { worker = null; }
function generate(params) {
  return new Promise((resolve, reject) => {
    const local = () => setTimeout(() => { try { resolve(FMG.generate(params)); } catch (e) { reject(e); } }, 30);
    if (!worker) return local();
    let done = false;
    worker.onmessage = e => { if (done) return; done = true; e.data.ok ? resolve(e.data.map) : reject(new Error(e.data.error)); };
    worker.onerror = ev => { if (done) return; done = true; if (ev.preventDefault) ev.preventDefault(); worker = null; local(); };
    worker.postMessage(params);
  });
}

// ---------- canvas sizing ----------
function resize() {
  vw = innerWidth; vh = innerHeight; dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  if (S.map) { const old = fit; computeFit(); if (Math.abs(old - fit) > 1e-6) buildCache(); crisp = null; requestDraw(); scheduleCrisp(); }
}
function computeFit() {
  const m = S.map; const panelW = innerWidth > 760 && !$('#panel').classList.contains('hidden') ? 320 : 0;
  fit = Math.min((vw - panelW - 70) / m.W, (vh - 20) / m.H);
  return panelW;
}
function fitView() {
  const panelW = computeFit(); const m = S.map;
  view.scale = fit; view.x = -(panelW + (vw - panelW - m.W * fit) / 2) / fit; view.y = -((vh - m.H * fit) / 2) / fit;
}
const V = () => ({ scale: view.scale, x: view.x, y: view.y, dpr, w: vw, h: vh, fit });
const opts = () => ({ layers: S.layers, hexKm: S.hexKm, sortedBurgs, selState: S.selState, selBurg: S.selBurg, ruler: S.ruler, title: S.map ? S.map.name : '' });

// full-map bitmap used while panning/zooming
function buildCache() {
  const m = S.map; if (!m) return;
  const cs = Math.min(4096 / m.W, Math.max(1.4, fit * dpr * 1.6));
  const c = cache && cache.canvas.width === Math.round(m.W * cs) ? cache.canvas : document.createElement('canvas');
  c.width = Math.round(m.W * cs); c.height = Math.round(m.H * cs);
  const t = performance.now();
  FMGR.render(c.getContext('2d'), m, { scale: fit, x: 0, y: 0, dpr: cs / fit, w: m.W * fit, h: m.H * fit, fit }, opts());
  cache = { canvas: c, cs }; S.tCache = performance.now() - t;
}
function renderCrisp() {
  if (!S.map) return;
  const c = crisp && crisp.canvas.width === canvas.width && crisp.canvas.height === canvas.height ? crisp.canvas : document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const t = performance.now();
  FMGR.render(c.getContext('2d'), S.map, V(), opts());
  S.tFrame = performance.now() - t;
  crisp = { canvas: c, view: { ...view } };
  requestDraw(); updateStats();
}
function scheduleCrisp(ms) { clearTimeout(crispTimer); crispTimer = setTimeout(renderCrisp, ms == null ? 140 : ms); }
function requestDraw() { if (!rafId) rafId = requestAnimationFrame(draw); }
function draw() {
  rafId = 0; const m = S.map;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = FMGR.SEA_BG; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!m) return;
  const k = view.scale * dpr;
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low';
  const exact = crisp && crisp.view.scale === view.scale && crisp.view.x === view.x && crisp.view.y === view.y;
  if (exact) ctx.drawImage(crisp.canvas, 0, 0);
  else {
    if (cache) ctx.drawImage(cache.canvas, -view.x * k, -view.y * k, m.W * k, m.H * k);
    if (crisp && Math.abs(Math.log(crisp.view.scale / view.scale)) < 0.7) {
      const r = view.scale / crisp.view.scale;
      ctx.drawImage(crisp.canvas, (crisp.view.x - view.x) * k, (crisp.view.y - view.y) * k, crisp.canvas.width * r, crisp.canvas.height * r);
    }
  }
  const v = V(); const o = opts();
  FMGR.overlay(ctx, m, v, o);
  FMGR.decor(ctx, m, v, o);
}

// ---------- map lifecycle ----------
function readParams() {
  return {
    seed: $('#inSeed').value.trim() || randSeed(), shape: $('#inShape').value, cells: +$('#inCells').value, climate: $('#inClimate').value,
    km: +$('#inKm').value, land: +$('#inLand').value, rough: +$('#inRough').value, states: +$('#inStates').value, towns: +$('#inTowns').value, rivers: +$('#inRivers').value
  };
}
function writeParams(p) {
  $('#inSeed').value = p.seed; $('#inShape').value = p.shape; $('#inCells').value = String(p.cells); $('#inClimate').value = p.climate;
  $('#inKm').value = String(p.km); $('#inLand').value = p.land; $('#inRough').value = p.rough; $('#inStates').value = p.states; $('#inTowns').value = p.towns;
  $('#inRivers').value = String(p.rivers); syncLabels();
}
function syncLabels() {
  $('#vLand').textContent = Math.round($('#inLand').value * 100) + '%';
  $('#vRough').textContent = Math.round($('#inRough').value * 100) + '%';
  $('#vStates').textContent = $('#inStates').value; $('#vTowns').textContent = $('#inTowns').value;
}
function applyEdits(m, e) {
  for (const [id, nm] of Object.entries(e.states || {})) { const s = m.states[id]; if (s) { s.name = nm; s.fullName = s.form + ' ' + nm; } }
  for (const [id, nm] of Object.entries(e.burgs || {})) { const b = m.burgs[id]; if (b) b.name = nm; }
  if (e.name) m.name = e.name;
}
async function makeMap(params, edits) {
  const ld = $('#loading'); ld.classList.remove('off');
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const t0 = performance.now();
  let m;
  try { m = await generate(params); }
  catch (e) { ld.classList.add('off'); alert('Ошибка генерации: ' + e.message); console.error(e); return; }
  const tGen = performance.now() - t0;
  S.edits = edits || { states: {}, burgs: {}, name: null };
  applyEdits(m, S.edits);
  if (document.fonts && document.fonts.load) { try { await Promise.race([Promise.all([document.fonts.load('700 20px "Cormorant SC"'), document.fonts.load('600 14px "Cormorant Garamond"'), document.fonts.load('italic 600 14px "Cormorant Garamond"')]), new Promise(r => setTimeout(r, 1500))]); } catch (e) { /* offline */ } }
  FMGR.prepare(m);
  S.map = m; S.params = m.params; S.selState = null; S.selBurg = null; S.ruler = null; crisp = null;
  sortedBurgs = m.burgs.slice().sort((a, b) => (b.capital - a.capital) || (b.pop - a.pop));
  S.tGen = tGen; S.tWorker = m.timings.total;
  writeParams(m.params); $('#inName').value = m.name;
  fitView(); buildCache(); renderCrisp();
  ld.classList.add('off'); closeInfo(); renderStatesList(); persist(); updateStats();
}
function persist() {
  const data = { params: S.params, edits: S.edits };
  try { localStorage.setItem('fmg-last', JSON.stringify(data)); } catch (e) { /* ignore */ }
  const q = new URLSearchParams(); for (const [k, v] of Object.entries(S.params)) if (k === 'seed' || v !== DEF[k]) q.set(k, v);
  history.replaceState(null, '', '?' + q.toString());
}
function updateStats() {
  const m = S.map; if (!m) return;
  $('#stats').textContent = `${fmt(m.n)} клеток · генерация ${Math.round(S.tGen)} мс · подготовка ${Math.round(m._p.time)} мс`;
}
function refreshLabels() { buildCache(); crisp = null; renderCrisp(); renderStatesList(); persist(); }

// ---------- view helpers ----------
function clampView() {
  const m = S.map; view.scale = Math.min(Math.max(view.scale, fit * 0.6), fit * 30);
  const mw = m.W * view.scale, mh = m.H * view.scale;
  const minX = -(vw - 80) / view.scale, maxX = m.W - 80 / view.scale, minY = -(vh - 80) / view.scale, maxY = m.H - 80 / view.scale;
  view.x = Math.min(Math.max(view.x, minX), maxX); view.y = Math.min(Math.max(view.y, minY), maxY);
  void mw; void mh;
}
function zoomAt(px, py, f) {
  const mx = view.x + px / view.scale, my = view.y + py / view.scale;
  view.scale *= f; clampView();
  view.x = mx - px / view.scale; view.y = my - py / view.scale; clampView();
  requestDraw(); scheduleCrisp();
}
let anim = 0;
function flyTo(x, y, scale) {
  cancelAnimationFrame(anim);
  const from = { ...view }; const ts = Math.max(view.scale, scale || fit * 3);
  const info = !$('#info').hidden && innerWidth > 760 ? 190 : 0; const panelW = innerWidth > 760 && !$('#panel').classList.contains('hidden') ? 160 : 0;
  const to = { scale: ts, x: x - (vw / 2 + panelW - info) / ts, y: y - vh / 2 / ts };
  const t0 = performance.now(), dur = 450;
  const step = () => {
    const t = Math.min(1, (performance.now() - t0) / dur), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const ls = Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * e;
    view.scale = Math.exp(ls);
    view.x = from.x + (to.x - from.x) * e; view.y = from.y + (to.y - from.y) * e;
    requestDraw();
    if (t < 1) anim = requestAnimationFrame(step); else { clampView(); scheduleCrisp(30); }
  };
  step();
}

// ---------- pointer interaction ----------
const pointers = new Map(); let dragMoved = 0, pinch = null, last = null;
canvas.addEventListener('pointerdown', e => {
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  dragMoved = 0; last = { x: e.clientX, y: e.clientY };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; }
  if (!S.rulerOn) canvas.classList.add('drag');
  hideTip();
});
canvas.addEventListener('pointermove', e => {
  if (!S.map) return;
  if (!pointers.has(e.pointerId)) { hover(e.clientX, e.clientY); return; }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    view.x -= (cx - pinch.cx) / view.scale; view.y -= (cy - pinch.cy) / view.scale;
    zoomAt(cx, cy, d / pinch.d); pinch = { d, cx, cy }; dragMoved += 10; return;
  }
  const dx = e.clientX - last.x, dy = e.clientY - last.y; last = { x: e.clientX, y: e.clientY };
  dragMoved += Math.abs(dx) + Math.abs(dy);
  if (dragMoved > 3) { view.x -= dx / view.scale; view.y -= dy / view.scale; clampView(); requestDraw(); scheduleCrisp(); }
});
const endPointer = e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
  canvas.classList.remove('drag');
  if (pointers.size === 0 && dragMoved <= 4 && e.type === 'pointerup') click(e.clientX, e.clientY);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', hideTip);
canvas.addEventListener('wheel', e => { e.preventDefault(); if (!S.map) return; const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; zoomAt(e.clientX, e.clientY, Math.exp(-d * 0.0016)); }, { passive: false });
canvas.addEventListener('contextmenu', e => { if (S.rulerOn) { e.preventDefault(); S.ruler = []; updateRuler(); requestDraw(); } });
addEventListener('keydown', e => { if (e.key === 'Escape') { if (S.rulerOn) toggleRuler(false); else closeInfo(); } });

const toMap = (px, py) => [view.x + px / view.scale, view.y + py / view.scale];
function burgAt(px, py) {
  let best = null, bd = 12 * 12;
  for (const b of S.map.burgs) { const x = (b.x - view.x) * view.scale, y = (b.y - view.y) * view.scale; const d = (x - px) ** 2 + (y - py) ** 2; if (d < bd) { bd = d; best = b; } }
  if (best && !best.capital && view.scale < fit * 0.85) return null;
  return best;
}
let hoverRaf = 0, hoverPt = null;
function hover(px, py) {
  hoverPt = [px, py]; if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0; const [x, y] = hoverPt; const m = S.map; const [mx, my] = toMap(x, y);
    if (mx < 0 || my < 0 || mx > m.W || my > m.H) return hideTip();
    const c = FMG.cellAt(m, mx, my); const b = burgAt(x, y);
    let html;
    if (b) html = `<b>${esc(b.name)}</b> — ${b.type.toLowerCase()}<br>${fmt(b.pop * 1000)} жителей${b.port ? ' · порт' : ''}`;
    else if (m.type[c] === 1) html = `<b>Море</b><br>глубина ~${fmt(-m.h[c] * 3500)} м`;
    else if (m.type[c] === 2) html = `<b>Озеро</b>${m.state[c] >= 0 ? '<br>' + esc(m.states[m.state[c]].fullName) : ''}`;
    else {
      const st = m.states[m.state[c]], cu = m.cultures[m.culture[c]];
      html = `<b>${FMG.BIOMES[m.biome[c]].name}</b>${m.flux[c] > m.riverThr ? ' · река' : ''}<br>высота ${fmt(m.h[c] * 4500)} м · ${Math.round(m.temp[c])}°C<br>${st ? esc(st.fullName) : ''}${cu ? ' · ' + cu.name : ''}`;
    }
    const tip = $('#tip'); tip.innerHTML = html; tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(x + 16, vw - tw - 8) + 'px'; tip.style.top = Math.min(y + 16, vh - th - 8) + 'px';
  });
}
function hideTip() { $('#tip').hidden = true; }
function click(px, py) {
  const m = S.map; const [mx, my] = toMap(px, py);
  if (S.rulerOn) { (S.ruler = S.ruler || []).push([mx, my]); updateRuler(); requestDraw(); return; }
  const b = burgAt(px, py); if (b) return showBurg(b.id);
  if (mx < 0 || my < 0 || mx > m.W || my > m.H) return closeInfo();
  const c = FMG.cellAt(m, mx, my);
  if (m.type[c] === 1 || m.state[c] < 0) return closeInfo();
  showState(m.state[c]);
}

// ---------- info panels ----------
function closeInfo() { $('#info').hidden = true; S.selState = null; S.selBurg = null; requestDraw(); }
function showState(id, fly) {
  const m = S.map, s = m.states[id]; S.selState = id; S.selBurg = null;
  const cap = m.burgs[s.capital], cu = m.cultures[s.culture];
  const area = s.cells * m.cellAreaKm, pop = s.rural + s.urban;
  const burgs = m.burgs.filter(b => b.state === id).sort((a, b) => (b.capital - a.capital) || b.pop - a.pop);
  const rel = Object.entries(s.relations).map(([o, r]) => `<div class="item" data-state="${o}"><span class="sw" style="background:${m.states[o].color}"></span>${esc(m.states[o].fullName)}<small class="rel-${r}">${r}</small></div>`).join('');
  const biomeCnt = {}; for (let c = 0; c < m.n; c++) if (m.type[c] === 0 && m.state[c] === id) biomeCnt[m.biome[c]] = (biomeCnt[m.biome[c]] || 0) + 1;
  const topB = Object.entries(biomeCnt).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([b, n]) => `<span class="tag">${FMG.BIOMES[b].name} ${Math.round(n / s.cells * 100)}%</span>`).join('');
  $('#info').innerHTML = `<button class="close" title="Закрыть">×</button>
    <div class="form">${esc(s.form)}</div>
    <input id="edName" value="${esc(s.name)}" maxlength="30" title="Переименовать">
    <table>
      <tr><td>Столица</td><td><a href="#" data-burg="${cap.id}">${esc(cap.name)}</a></td></tr>
      <tr><td>Народ</td><td>${esc(cu.name)}</td></tr>
      <tr><td>Площадь</td><td>${fmt(area)} км²</td></tr>
      <tr><td>Население</td><td>${fmt(pop)}</td></tr>
      <tr><td>Поселений</td><td>${burgs.length}</td></tr>
    </table>
    <div>${topB}</div>
    ${rel ? `<h3>Отношения с соседями</h3><div class="list">${rel}</div>` : ''}
    <h3>Города</h3><div class="list">${burgs.map(b => `<div class="item" data-burg="${b.id}">${b.capital ? '★ ' : ''}${esc(b.name)}<small>${b.type}, ${fmt(b.pop * 1000)}</small></div>`).join('')}</div>`;
  openInfo();
  $('#edName').addEventListener('change', e => { const v = e.target.value.trim(); if (!v) return; s.name = v; s.fullName = s.form + ' ' + v; S.edits.states[id] = v; refreshLabels(); });
  if (fly) flyTo(s.lx, s.ly, fit * 1.6); else requestDraw();
}
function showBurg(id, fly) {
  const m = S.map, b = m.burgs[id]; S.selBurg = b; S.selState = null;
  const st = m.states[b.state], cu = m.cultures[b.culture];
  const feats = [b.capital && 'столица', b.port && 'морской порт', b.river && 'на реке', b.lake && 'у озера', b.road === false && 'без дорог'].filter(Boolean);
  const nearest = m.burgs.filter(o => o !== b).map(o => [o, Math.hypot(o.x - b.x, o.y - b.y) * m.kmPerUnit]).sort((a, c) => a[1] - c[1]).slice(0, 5);
  $('#info').innerHTML = `<button class="close" title="Закрыть">×</button>
    <div class="form">${b.type}</div>
    <input id="edName" value="${esc(b.name)}" maxlength="30" title="Переименовать">
    <table>
      <tr><td>Государство</td><td>${st ? `<a href="#" data-state="${st.id}">${esc(st.fullName)}</a>` : '—'}</td></tr>
      <tr><td>Народ</td><td>${cu ? esc(cu.name) : '—'}</td></tr>
      <tr><td>Население</td><td>${fmt(b.pop * 1000)}</td></tr>
      <tr><td>Местность</td><td>${FMG.BIOMES[m.biome[b.cell]].name}, ${fmt(b.elev)} м</td></tr>
      <tr><td>Климат</td><td>${Math.round(m.temp[b.cell])}°C в среднем</td></tr>
    </table>
    <div>${feats.map(f => `<span class="tag">${f}</span>`).join('')}</div>
    <h3>Ближайшие поселения</h3><div class="list">${nearest.map(([o, d]) => `<div class="item" data-burg="${o.id}">${esc(o.name)}<small>${fmt(d)} км · ${(d / 30).toFixed(1)} дн.</small></div>`).join('')}</div>`;
  openInfo();
  $('#edName').addEventListener('change', e => { const v = e.target.value.trim(); if (!v) return; b.name = v; S.edits.burgs[id] = v; refreshLabels(); });
  if (fly) flyTo(b.x, b.y, fit * 3.5); else requestDraw();
}
function openInfo() {
  const el = $('#info'); el.hidden = false; el.scrollTop = 0;
  el.querySelector('.close').onclick = closeInfo;
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-burg],[data-state]'); if (!t || !S.map) return;
  e.preventDefault();
  if (t.dataset.burg != null) showBurg(+t.dataset.burg, true); else showState(+t.dataset.state, true);
});
function renderStatesList() {
  const m = S.map;
  $('#statesList').innerHTML = m.states.slice().sort((a, b) => b.cells - a.cells).map(s => `<div class="item" data-state="${s.id}"><span class="sw" style="background:${s.color}"></span>${esc(s.fullName)}<small>${fmt(s.cells * m.cellAreaKm / 1000)} т.км²</small></div>`).join('');
}
$('#inSearch').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase(); const m = S.map; const out = $('#searchRes');
  if (!q || !m) { out.innerHTML = ''; return; }
  const st = m.states.filter(s => s.fullName.toLowerCase().includes(q)).slice(0, 5).map(s => `<div class="item" data-state="${s.id}"><span class="sw" style="background:${s.color}"></span>${esc(s.fullName)}</div>`);
  const bs = m.burgs.filter(b => b.name.toLowerCase().includes(q)).slice(0, 10).map(b => `<div class="item" data-burg="${b.id}">${b.capital ? '★ ' : '• '}${esc(b.name)}<small>${b.type}</small></div>`);
  out.innerHTML = st.concat(bs).join('') || '<div class="item"><small>ничего не найдено</small></div>';
});

// ---------- ruler ----------
function toggleRuler(on) {
  S.rulerOn = on == null ? !S.rulerOn : on; S.ruler = S.rulerOn ? [] : null;
  $('#btnRuler').classList.toggle('on', S.rulerOn); canvas.classList.toggle('ruler', S.rulerOn);
  updateRuler(); requestDraw();
}
function updateRuler() {
  const box = $('#rulerBox'); if (!S.rulerOn) { box.hidden = true; return; }
  box.hidden = false; const r = S.ruler || []; let d = 0;
  for (let i = 1; i < r.length; i++) d += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
  d *= S.map.kmPerUnit;
  box.innerHTML = r.length < 2 ? '📏 Кликайте по карте, чтобы проложить маршрут<div class="hint">ПКМ — сбросить, Esc — выключить</div>'
    : `Расстояние: <b>${fmt(d)} км</b><br>Пешком: <b>${(d / 30).toFixed(1)}</b> дн. · Верхом: <b>${(d / 50).toFixed(1)}</b> дн.<div class="hint">ПКМ — сбросить, Esc — выключить</div>`;
}

// ---------- export / save / load ----------
function exportPng() {
  const m = S.map; const cssScale = 1.6, outW = Math.min(6400, m.W * 3); const d = outW / m.W / cssScale;
  const c = document.createElement('canvas'); c.width = Math.round(m.W * cssScale * d); c.height = Math.round(m.H * cssScale * d);
  const v = { scale: cssScale, x: 0, y: 0, dpr: d, w: m.W * cssScale, h: m.H * cssScale, fit: cssScale };
  const g = c.getContext('2d'); const o = { ...opts(), selState: null, selBurg: null, ruler: null };
  FMGR.render(g, m, v, o); FMGR.decor(g, m, v, o);
  c.toBlob(b => download(b, `континент-${m.name}.png`), 'image/png');
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
$('#btnPng').onclick = exportPng;
$('#btnSave').onclick = () => download(new Blob([JSON.stringify({ app: 'kartograf', v: 1, params: S.params, edits: S.edits }, null, 1)], { type: 'application/json' }), `континент-${S.map.name}.json`);
$('#btnLoad').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  try { const d = JSON.parse(await f.text()); if (!d.params) throw new Error('нет параметров'); makeMap({ ...DEF, ...d.params }, d.edits); }
  catch (err) { alert('Не удалось открыть файл: ' + err.message); }
};
$('#btnLink').onclick = async () => { try { await navigator.clipboard.writeText(location.href); $('#btnLink').textContent = '✔ Ссылка скопирована'; setTimeout(() => $('#btnLink').textContent = '🔗 Скопировать ссылку', 1800); } catch (e) { prompt('Ссылка:', location.href); } };

// ---------- controls ----------
$('#btnNew').onclick = () => { $('#inSeed').value = randSeed(); makeMap(readParams()); };
$('#btnRegen').onclick = () => makeMap(readParams());
$('#btnSeed').onclick = () => { $('#inSeed').value = randSeed(); };
['#inLand', '#inRough', '#inStates', '#inTowns'].forEach(s => $(s).addEventListener('input', syncLabels));
$('#inName').addEventListener('change', e => { const v = e.target.value.trim(); if (!v || !S.map) return; S.map.name = v; S.edits.name = v; persist(); requestDraw(); });
document.querySelectorAll('#layers input').forEach(cb => cb.addEventListener('change', () => {
  S.layers[cb.dataset.l] = cb.checked; $('#hexRow').style.display = S.layers.hex ? '' : 'none';
  buildCache(); crisp = null; renderCrisp();
}));
$('#hexRow').style.display = 'none';
$('#inHex').onchange = e => { S.hexKm = +e.target.value; buildCache(); crisp = null; renderCrisp(); };
$('#zIn').onclick = () => zoomAt(vw / 2, vh / 2, 1.5);
$('#zOut').onclick = () => zoomAt(vw / 2, vh / 2, 1 / 1.5);
$('#zFit').onclick = () => { fitView(); requestDraw(); scheduleCrisp(10); };
$('#btnRuler').onclick = () => toggleRuler();
// panel collapse
const panel = $('#panel'), fab = $('#panelToggle');
const hideBtn = document.createElement('button'); hideBtn.className = 'btn sq'; hideBtn.textContent = '«'; hideBtn.title = 'Скрыть меню';
hideBtn.style.cssText = 'position:absolute;right:10px;top:12px;width:34px;height:34px;font-size:18px';
panel.style.position = 'fixed'; panel.querySelector('.ph').style.position = 'relative'; panel.querySelector('.ph').appendChild(hideBtn);
const setPanel = open => { panel.classList.toggle('hidden', !open); fab.classList.toggle('show', !open); };
hideBtn.onclick = () => setPanel(false); fab.onclick = () => setPanel(true);
if (innerWidth <= 760) setPanel(false);
addEventListener('resize', () => { clearTimeout(resize.t); resize.t = setTimeout(resize, 120); });

// ---------- start ----------
resize();
(function start() {
  const q = new URLSearchParams(location.search);
  let params = null, edits = null;
  if (q.get('seed')) { params = { ...DEF, seed: q.get('seed') }; for (const k of Object.keys(DEF)) if (q.has(k)) params[k] = isNaN(+q.get(k)) ? q.get(k) : +q.get(k); }
  try { const last = JSON.parse(localStorage.getItem('fmg-last') || 'null'); if (last && last.params && (!params || last.params.seed === params.seed)) { params = params || last.params; edits = last.params.seed === params.seed ? last.edits : null; } } catch (e) { /* ignore */ }
  if (!params) params = { ...DEF, seed: randSeed() };
  writeParams(params); makeMap(params, edits);
})();
window.__app = { S, view: () => view, renderCrisp, makeMap };
})();
