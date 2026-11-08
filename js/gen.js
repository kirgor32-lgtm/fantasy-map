/* Fantasy continent generator.
   Works both as a Web Worker (postMessage) and as a plain script (window.FMG). */
(function (root) {
'use strict';
const IS_WORKER = typeof importScripts === 'function' && typeof document === 'undefined';
if (IS_WORKER && typeof Delaunator === 'undefined') importScripts('vendor/delaunator.min.js');

// ---------------- utils ----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^ h >>> 16) >>> 0;
}
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const now = () => (typeof performance !== 'undefined' ? performance : Date).now();

function makeNoise(rand) {
  const p = new Uint8Array(256); for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  const perm = new Uint8Array(512); for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  return function (xin, yin) {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2; const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2; const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { const g = perm[ii + perm[jj]] & 7; t0 *= t0; n0 = t0 * t0 * (gx[g] * x0 + gy[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; t1 *= t1; n1 = t1 * t1 * (gx[g] * x1 + gy[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; t2 *= t2; n2 = t2 * t2 * (gx[g] * x2 + gy[g] * y2); }
    return 70 * (n0 + n1 + n2);
  };
}
function fbm(nz, x, y, oct) {
  let a = 1, f = 1, s = 0, norm = 0;
  for (let i = 0; i < oct; i++) { s += a * nz(x * f, y * f); norm += a; a *= 0.5; f *= 2.03; }
  return s / norm;
}

class Heap {
  constructor() { this.ids = []; this.pr = []; }
  get size() { return this.ids.length; }
  push(id, p) {
    const ids = this.ids, pr = this.pr; let i = ids.length; ids.push(id); pr.push(p);
    while (i > 0) { const j = (i - 1) >> 1; if (pr[j] <= p) break; ids[i] = ids[j]; pr[i] = pr[j]; i = j; }
    ids[i] = id; pr[i] = p;
  }
  pop() {
    const ids = this.ids, pr = this.pr; const top = ids[0]; this.lastP = pr[0];
    const lid = ids.pop(), lp = pr.pop(); const n = ids.length;
    if (n > 0) {
      let i = 0;
      for (;;) { let l = 2 * i + 1; if (l >= n) break; const r = l + 1; if (r < n && pr[r] < pr[l]) l = r; if (pr[l] >= lp) break; ids[i] = ids[l]; pr[i] = pr[l]; i = l; }
      ids[i] = lid; pr[i] = lp;
    }
    return top;
  }
}

// ---------------- reference data ----------------
// id, name, color, habitability, movement cost
const BIOMES = [
  { name: 'Море', color: '#4c7691', hab: 0, cost: 30 },
  { name: 'Пустыня', color: '#c7b584', hab: 4, cost: 3 },
  { name: 'Холодная пустошь', color: '#919c86', hab: 8, cost: 3 },
  { name: 'Саванна', color: '#aba35f', hab: 50, cost: 1.3 },
  { name: 'Луга и степи', color: '#7f9a5c', hab: 100, cost: 1 },
  { name: 'Сезонный лес', color: '#587a49', hab: 80, cost: 1.6 },
  { name: 'Лиственный лес', color: '#3f6640', hab: 90, cost: 1.7 },
  { name: 'Джунгли', color: '#397a42', hab: 35, cost: 3 },
  { name: 'Влажный лес', color: '#355f3d', hab: 60, cost: 2 },
  { name: 'Тайга', color: '#48705a', hab: 25, cost: 2 },
  { name: 'Тундра', color: '#8b9683', hab: 8, cost: 2.5 },
  { name: 'Ледник', color: '#e4eef2', hab: 0, cost: 6 },
  { name: 'Болото', color: '#566d4e', hab: 15, cost: 4 },
  { name: 'Высокогорье', color: '#857c6e', hab: 3, cost: 6 }
];

const LANGS = {
  nord: { name: 'Северяне', on: ['хьял', 'бьор', 'ульф', 'скай', 'вин', 'даг', 'хрот', 'свен', 'торн', 'ивар', 'рик', 'мар', 'хель', 'фрос', 'кваль', 'ринн', 'стен', 'валь', 'йорн', 'сиг', 'эйр', 'хаф', 'бру', 'гун', 'тор', 'фальк', 'ингв', 'орм'], mid: ['а', 'е', 'ин', 'ен', 'ар'], end: ['хейм', 'гард', 'вик', 'хольм', 'стад', 'фьорд', 'берг', 'мар', 'ранд', 'ск', 'дал', 'хал', 'рун'], forms: ['Ярлство', 'Королевство', 'Конунгство'] },
  imp: { name: 'Имперцы', on: ['кор', 'вен', 'аль', 'три', 'лу', 'ма', 'се', 'ре', 'но', 'ан', 'ти', 'ка', 'дор', 'ви', 'люк', 'пра', 'кас', 'бра', 'мер', 'сол', 'вал', 'цир', 'ант', 'фла'], mid: ['и', 'е', 'ан', 'ер', 'ол'], end: ['иум', 'ия', 'ус', 'ан', 'ора', 'ента', 'ис', 'он', 'ея', 'ина', 'ум'], forms: ['Империя', 'Республика', 'Королевство', 'Провинция'] },
  elf: { name: 'Эльфы', on: ['эл', 'ла', 'ри', 'ан', 'си', 'тал', 'на', 'ли', 'эр', 'фа', 'ил', 'ва', 'лос', 'мир', 'тэ', 'аэ', 'сил', 'ин', 'кел', 'ор', 'фин'], mid: ['а', 'э', 'и', 'ен', 'ил'], end: ['ндор', 'риэль', 'лин', 'нар', 'эль', 'иан', 'ассэ', 'ор', 'ис', 'рин', 'лас', 'тиль', 'мэ'], forms: ['Доминион', 'Королевство', 'Владычество'] },
  desert: { name: 'Пустынники', on: ['за', 'ра', 'ка', 'ши', 'ма', 'хар', 'ад', 'су', 'кха', 'ба', 'ри', 'ну', 'джа', 'ал', 'ас', 'тар', 'саф', 'ким', 'ор'], mid: ['и', 'а', 'ар', 'ам'], end: ['ад', 'ар', 'ир', 'ун', 'аш', 'им', 'ра', 'ах', 'ия', 'ша', 'лит'], forms: ['Султанат', 'Халифат', 'Эмират'] },
  orc: { name: 'Орки', on: ['гро', 'маш', 'урз', 'гор', 'душ', 'краг', 'бол', 'руг', 'шаг', 'мор', 'зуг', 'гул', 'ург', 'баз', 'ног', 'тхар'], mid: ['а', 'о', 'у'], end: ['гар', 'мош', 'ук', 'раз', 'дул', 'ак', 'ор', 'граш', 'бур', 'зог'], forms: ['Орда', 'Ханство', 'Вождество'] },
  marsh: { name: 'Болотники', on: ['ше', 'ксан', 'хи', 'ти', 'зе', 'ли', 'ва', 'ксу', 'ре', 'са', 'ну', 'ка', 'шей', 'тее', 'хаш', 'уул'], mid: ['-', 'и', 'е'], end: ['ксис', 'ит', 'ей', 'ус', 'ель', 'ка', 'ша', 'тил', 'рей', 'зар'], forms: ['Племенной союз', 'Вождество', 'Топи'] },
  dwarf: { name: 'Подгорный народ', on: ['мзу', 'нчу', 'бтар', 'арк', 'нгу', 'мзин', 'зан', 'рал', 'тхал', 'рук', 'бам', 'дер', 'кель', 'амч', 'ну'], mid: ['а', 'у', 'ар'], end: ['анд', 'эзал', 'ард', 'улм', 'чанд', 'ит', 'ар', 'ак', 'унз', 'ферн'], forms: ['Твердыня', 'Королевство', 'Каганат'] }
};
const LANG_KEYS = Object.keys(LANGS);
// culture names are human ethnic groups (races live inside states, they don't own them)
LANGS.elf.name = 'Сильванцы'; LANGS.orc.name = 'Степняки'; LANGS.dwarf.name = 'Горцы';

// Races from the D&D character editor (ids = editor ids). `where` follows the editor lore (dnd.su texts).
const RACES = {
  'human': { name: 'Люди', where: 'Повсюду: строят города и королевства, основа населения всех государств' },
  'high-elf': { name: 'Высокие эльфы', where: 'Города со шпилями в древних лесах у рек и побережий' },
  'wood-elf': { name: 'Лесные эльфы', where: 'Глубины древних лесов вдали от людских городов' },
  'drow': { name: 'Дроу', where: 'Подземье под горами; на поверхность выходят редко' },
  'mountain-dwarf': { name: 'Горные дворфы', where: 'Подгорные королевства: шахты и твердыни глубоко под горами' },
  'hill-dwarf': { name: 'Холмовые дворфы', where: 'Холмы и предгорья' },
  'lightfoot-halfling': { name: 'Легконогие полурослики', where: 'Живут бок о бок с другими народами или кочуют по дорогам' },
  'stout-halfling': { name: 'Крепкие полурослики', where: 'Тёплые плодородные долины и речные поймы' },
  'forest-gnome': { name: 'Лесные гномы', where: 'Скрытые общины в глубине лесов, по соседству с эльфами' },
  'rock-gnome': { name: 'Скальные гномы', where: 'Норы в лесистых холмах' },
  'dragonborn': { name: 'Драконорождённые', where: 'Кланы на диких высотах и пустошах — там, где логова драконов; многие служат в городах наёмниками' },
  'half-elf': { name: 'Полуэльфы', where: 'Своих государств нет — живут в городах, где рядом люди и эльфы' },
  'half-orc': { name: 'Полуорки', where: 'Варварские племена в степях и пустошах, а также городские трущобы' },
  'tiefling': { name: 'Тифлинги', where: 'Небольшие общины в крупных людских городах' },
  'air-genasi': { name: 'Дженази воздуха', where: 'Без своих городов; встречаются в высокогорных поселениях' },
  'earth-genasi': { name: 'Дженази земли', where: 'Без своих городов; встречаются в горных и шахтёрских городах' },
  'fire-genasi': { name: 'Дженази огня', where: 'Без своих городов; встречаются в городах жарких пустынь' },
  'water-genasi': { name: 'Дженази воды', where: 'Без своих городов; встречаются в портах' },
  'kenku': { name: 'Кенку', where: 'Мрачные города, наводнённые преступностью; верхние этажи башен' },
  'shifter': { name: 'Шифтеры', where: 'Дикие леса и тайга на грани дикой природы и цивилизации' },
  'aasimar': { name: 'Аазимары', where: 'Рождаются среди людей, чаще в крупных городах' },
  'tabaxi': { name: 'Табакси', where: 'Родом из далёких земель; странствуют, заходят в порты' },
  'goliath': { name: 'Голиафы', where: 'Кочуют по высочайшим горным вершинам выше границы леса' },
  'triton': { name: 'Тритоны', where: 'Поселения в океанских глубинах у побережья' },
  'goblin': { name: 'Гоблины', where: 'Племена в холмах, пещерах и чащах; кварталы больших городов' },
  'centaur': { name: 'Кентавры', where: 'Открытые равнины и степи — простор и свобода' },
  'changeling': { name: 'Ченджлинги', where: 'Скрываются в больших городах или странствуют' },
  'grung': { name: 'Грунги', where: 'Дождевые леса и тропические джунгли' }
};
const EDITOR_RACE = { 'human': 'human', 'high-elf': 'elf', 'wood-elf': 'elf', 'drow': 'elf', 'mountain-dwarf': 'dwarf', 'hill-dwarf': 'dwarf', 'lightfoot-halfling': 'halfling', 'stout-halfling': 'halfling', 'forest-gnome': 'gnome', 'rock-gnome': 'gnome', 'air-genasi': 'genasi', 'earth-genasi': 'genasi', 'fire-genasi': 'genasi', 'water-genasi': 'genasi' };
for (const k in RACES) RACES[k].race = EDITOR_RACE[k] || k;
// races that occupy territory on the map, in placement order (rare habitats first)
// size = share of land per area, builds = founds own towns (majority in them)
const FOLK = [
  { id: 'triton', color: '#2c6e8f', size: 0.035, areas: 2, sea: true, builds: true },
  { id: 'mountain-dwarf', color: '#7a4b2a', size: 0.035, areas: 2, builds: true },
  { id: 'goliath', color: '#6b6f7a', size: 0.022, areas: 2 },
  { id: 'drow', color: '#4b2d5c', size: 0.025, areas: 1, under: true, builds: true },
  { id: 'grung', color: '#3f8a3a', size: 0.018, areas: 1 },
  { id: 'dragonborn', color: '#a3362a', size: 0.016, areas: 1, builds: true },
  { id: 'wood-elf', color: '#2f6b32', size: 0.035, areas: 2, builds: true },
  { id: 'forest-gnome', color: '#5c7d2e', size: 0.012, areas: 1, builds: true },
  { id: 'high-elf', color: '#3c6fa0', size: 0.025, areas: 1, builds: true },
  { id: 'hill-dwarf', color: '#8c5a2b', size: 0.028, areas: 1, builds: true },
  { id: 'rock-gnome', color: '#8a6d2f', size: 0.015, areas: 1, builds: true },
  { id: 'shifter', color: '#6d4e33', size: 0.025, areas: 1 },
  { id: 'centaur', color: '#9a6a1c', size: 0.03, areas: 1 },
  { id: 'half-orc', color: '#5e6b2a', size: 0.03, areas: 2 },
  { id: 'goblin', color: '#6c7a2a', size: 0.018, areas: 1 },
  { id: 'stout-halfling', color: '#a0782a', size: 0.02, areas: 1, builds: true }
];
const FOLK_BY = {};
for (const F of FOLK) { Object.assign(F, { name: RACES[F.id].name, where: RACES[F.id].where, race: RACES[F.id].race, sub: F.id }); FOLK_BY[F.id] = F; }
const RELATIONS = [['Союз', 0.14], ['Дружба', 0.2], ['Нейтралитет', 0.32], ['Соперничество', 0.22], ['Война', 0.12]];

function makeNamer(rand, used) {
  const pick = a => a[(rand() * a.length) | 0];
  return function (lang, maxLen) {
    const L = LANGS[lang]; maxLen = maxLen || 12;
    for (let t = 0; t < 60; t++) {
      let s = pick(L.on);
      if (rand() < 0.4) s += pick(L.mid);
      if (rand() < 0.22) s += pick(L.on);
      s += pick(L.end);
      s = s.replace(/([аеиоуыэюя])\1+/g, '$1').replace(/([^аеиоуыэюя-])\1\1+/g, '$1$1').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (s.length < 4 || s.length > maxLen) continue;
      s = s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
      if (!used.has(s)) { used.add(s); return s; }
    }
    return 'Безымянь' + used.size;
  };
}

// ---------------- geometry helpers (also used by the renderer) ----------------
function cellAt(m, x, y) {
  const c = clamp(Math.floor(x / m.sx), 0, m.cols - 1), r = clamp(Math.floor(y / m.sy), 0, m.rows - 1);
  let i = r * m.cols + c;
  let best = (m.cx[i] - x) ** 2 + (m.cy[i] - y) ** 2;
  for (let guard = 0; guard < 64; guard++) {
    let moved = false;
    for (let k = m.nOff[i]; k < m.nOff[i + 1]; k++) {
      const q = m.nbr[k]; if (q < 0) continue;
      const d = (m.cx[q] - x) ** 2 + (m.cy[q] - y) ** 2;
      if (d < best) { best = d; i = q; moved = true; }
    }
    if (!moved) break;
  }
  return i;
}
// closed loops (flat [x,y,...]) around the region where inside(c) is true
function loops(m, inside) {
  const { n, nOff, nbr, ev1, ev2, vx, vy, cx, cy } = m;
  const next = new Map();
  for (let c = 0; c < n; c++) {
    if (!inside(c)) continue;
    for (let k = nOff[c]; k < nOff[c + 1]; k++) {
      const q = nbr[k]; if (q >= 0 && inside(q)) continue;
      let a = ev2[k], b = ev1[k]; if (a < 0) continue;
      const cr = (vx[b] - vx[a]) * (cy[c] - vy[a]) - (vy[b] - vy[a]) * (cx[c] - vx[a]);
      if (cr < 0) { const t = a; a = b; b = t; }
      next.set(a, b);
    }
  }
  const res = [], seen = new Set();
  for (const s of next.keys()) {
    if (seen.has(s)) continue;
    const pts = []; let v = s;
    while (v !== undefined && !seen.has(v)) { seen.add(v); pts.push(vx[v], vy[v]); v = next.get(v); }
    if (pts.length >= 6) res.push(pts);
  }
  return res;
}
// chain undirected node pairs into polylines of node ids
function chain(pairs) {
  const adj = new Map();
  const add = (a, b) => { let l = adj.get(a); if (!l) adj.set(a, l = []); l.push(b); };
  for (let i = 0; i < pairs.length; i += 2) { add(pairs[i], pairs[i + 1]); add(pairs[i + 1], pairs[i]); }
  const used = new Set(); const key = (a, b) => a < b ? a * 4194304 + b : b * 4194304 + a;
  const out = [];
  const walk = (s, nx) => {
    const path = [s, nx]; used.add(key(s, nx)); let prev = s, cur = nx;
    for (;;) {
      const l = adj.get(cur); if (l.length !== 2) break;
      const nn = l[0] === prev ? l[1] : l[0];
      if (used.has(key(cur, nn))) break;
      used.add(key(cur, nn)); path.push(nn); prev = cur; cur = nn;
    }
    return path;
  };
  for (const [v, l] of adj) { if (l.length === 2) continue; for (const u of l) if (!used.has(key(v, u))) out.push(walk(v, u)); }
  for (const [v, l] of adj) { for (const u of l) if (!used.has(key(v, u))) out.push(walk(v, u)); }
  return out;
}

// ---------------- main ----------------
function generate(P) {
  const T = {}; let t = now(); const t00 = t;
  const W = 1600, H = 1000;
  const seed = String(P.seed || 'dnd');
  const rand = mulberry32(hashStr(seed));
  const N = clamp(P.cells | 0 || 12000, 1000, 80000);
  const landFrac = clamp(+P.land || 0.42, 0.2, 0.7);
  const rough = clamp(P.rough == null ? 0.5 : +P.rough, 0, 1);
  const nStates = clamp(P.states | 0 || 8, 2, 30);
  const nTowns = clamp(P.towns == null ? 60 : P.towns | 0, 0, 400);
  const riverFrac = clamp(+P.rivers || 0.07, 0.02, 0.2);
  const mapKm = clamp(+P.km || 2400, 300, 20000);
  const kmPerUnit = mapKm / W;
  const climate = P.climate || 'temperate';
  const shape = P.shape || 'classic';
  const used = new Set(); const namer = makeNamer(rand, used);

  // ---- grid ----
  const spacing = Math.sqrt(W * H / N);
  const cols = Math.max(4, Math.round(W / spacing)), rows = Math.max(4, Math.round(H / spacing));
  const sx = W / cols, sy = H / rows; const n = cols * rows;
  const coords = new Float64Array(2 * n + 8 * (cols + rows + 8));
  let ci = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    coords[ci++] = (c + 0.5 + (rand() - 0.5) * 0.85) * sx;
    coords[ci++] = (r + 0.5 + (rand() - 0.5) * 0.85) * sy;
  }
  for (let c = -1; c <= cols; c++) { const x = (c + 0.5) * sx; coords[ci++] = x; coords[ci++] = -sy * 0.5; coords[ci++] = x; coords[ci++] = H + sy * 0.5; }
  for (let r = 0; r < rows; r++) { const y = (r + 0.5) * sy; coords[ci++] = -sx * 0.5; coords[ci++] = y; coords[ci++] = W + sx * 0.5; coords[ci++] = y; }
  const del = new Delaunator(coords.subarray(0, ci));
  const tri = del.triangles, he = del.halfedges; const nt = tri.length / 3;
  const vx = new Float32Array(nt), vy = new Float32Array(nt);
  for (let i = 0; i < nt; i++) {
    const a = tri[3 * i] * 2, b = tri[3 * i + 1] * 2, c = tri[3 * i + 2] * 2;
    const ax = coords[a], ay = coords[a + 1];
    const dx = coords[b] - ax, dy = coords[b + 1] - ay, ex = coords[c] - ax, ey = coords[c + 1] - ay;
    const bl = dx * dx + dy * dy, cl = ex * ex + ey * ey; const d = 0.5 / (dx * ey - dy * ex || 1e-9);
    vx[i] = ax + (ey * bl - dy * cl) * d; vy[i] = ay + (dx * cl - ex * bl) * d;
  }
  const cx = new Float32Array(n), cy = new Float32Array(n);
  for (let i = 0; i < n; i++) { cx[i] = coords[2 * i]; cy[i] = coords[2 * i + 1]; }
  const inc = new Int32Array(n).fill(-1);
  for (let e = 0; e < tri.length; e++) {
    const p = tri[e % 3 === 2 ? e - 2 : e + 1];
    if (p < n && (inc[p] === -1 || he[e] === -1)) inc[p] = e;
  }
  const nOff = new Int32Array(n + 1); const nbrA = [], ev1A = [], ev2A = [];
  for (let p = 0; p < n; p++) {
    let e = inc[p]; const start = e;
    do {
      const q = tri[e]; nbrA.push(q < n ? q : -1); ev1A.push((e / 3) | 0);
      const o = he[e]; ev2A.push(o >= 0 ? (o / 3) | 0 : -1);
      e = he[e % 3 === 2 ? e - 2 : e + 1];
    } while (e !== -1 && e !== start);
    nOff[p + 1] = nbrA.length;
  }
  const nbr = Int32Array.from(nbrA), ev1 = Int32Array.from(ev1A), ev2 = Int32Array.from(ev2A);
  const M = { W, H, n, cols, rows, sx, sy, spacing, cx, cy, vx, vy, nOff, nbr, ev1, ev2 };
  T.grid = now() - t; t = now();

  // ---- heightmap ----
  const nz = []; for (let i = 0; i < 8; i++) nz.push(makeNoise(rand));
  const rot = rand() * Math.PI * 2;
  const h = new Float32Array(n);
  const ell = (u, v, x0, y0, a, b) => 1 - Math.hypot((u - x0) / a, (v - y0) / b);
  const flipX = rand() < 0.5 ? -1 : 1, flipY = rand() < 0.5 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const u = (cx[i] - W / 2) / (H / 2), v = (cy[i] - H / 2) / (H / 2);
    const wa = 0.3 + 0.35 * rough;
    const wu = (u + wa * fbm(nz[1], u * 0.9 + 5.3, v * 0.9, 3)) * flipX;
    const wv = (v + wa * fbm(nz[2], u * 0.9, v * 0.9 + 9.1, 3)) * flipY;
    let base;
    if (shape === 'twin') base = Math.max(ell(wu, wv, -0.68, -0.15, 0.78, 0.66), ell(wu, wv, 0.66, 0.16, 0.8, 0.62), ell(wu, wv, 0, 0, 0.6, 0.22) * 0.7);
    else if (shape === 'crescent') base = Math.min(ell(wu, wv, 0, 0.08, 1.3, 0.84), -ell(wu, wv, 0.15, -0.62, 0.78, 0.55) * 0.9 + 0.02);
    else if (shape === 'long') { const ca = Math.cos(0.42), sa = Math.sin(0.42); const ru = wu * ca - wv * sa, rv = wu * sa + wv * ca; base = ell(ru, rv, 0, 0, 1.45, 0.5); }
    else base = ell(wu, wv, 0, 0, 1.22, 0.8);
    let hh = base * 0.85 + fbm(nz[0], u * 2.1 + 1.7, v * 2.1 - 3.3, 6) * (0.32 + 0.36 * rough);
    const rr = 1 - Math.abs(fbm(nz[3], u * 1.3 + 3.1, v * 1.3 - 2.4, 4) * 1.6);
    hh += Math.pow(clamp(rr, 0, 1), 5) * 0.75 * smooth(0.0, 0.45, base);
    const edge = Math.min(cx[i], W - cx[i], cy[i], H - cy[i]) / (H * 0.09);
    if (edge < 1) hh -= (1 - edge) * 0.8;
    h[i] = hh;
  }
  { // calibrate sea level
    const sorted = Float32Array.from(h).sort();
    const sl = sorted[Math.floor((1 - landFrac) * n)];
    for (let i = 0; i < n; i++) h[i] -= sl;
  }
  // 0 land, 1 ocean, 2 lake
  const type = new Uint8Array(n);
  for (let i = 0; i < n; i++) type[i] = h[i] > 0 ? 0 : 1;
  const comp = new Int32Array(n).fill(-1);
  const bfsComp = (pred) => {
    const groups = []; comp.fill(-1); const stack = [];
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0 || !pred(s)) continue;
      const id = groups.length; const g = []; comp[s] = id; stack.push(s);
      while (stack.length) { const c = stack.pop(); g.push(c); for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && comp[q] < 0 && pred(q)) { comp[q] = id; stack.push(q); } } }
      groups.push(g);
    }
    return groups;
  };
  { // keep the main continent + reasonable islands
    const groups = bfsComp(c => type[c] === 0);
    let maxG = 0; for (const g of groups) maxG = Math.max(maxG, g.length);
    const minIsland = Math.max(4, Math.round(n * 0.0005));
    for (const g of groups) if (g.length < maxG && g.length < minIsland) for (const c of g) { type[c] = 1; h[c] = -0.01; }
  }
  { // water not connected to map border -> lake
    const groups = bfsComp(c => type[c] !== 0);
    for (const g of groups) {
      let border = false;
      for (const c of g) { for (let k = nOff[c]; k < nOff[c + 1]; k++) if (nbr[k] < 0) { border = true; break; } if (border) break; }
      if (!border) for (const c of g) { if (g.length < 3) { type[c] = 0; h[c] = 0.002; } else type[c] = 2; }
    }
  }
  { // normalise
    let maxH = 1e-6, minH = -1e-6;
    for (let i = 0; i < n; i++) { if (type[i] === 0) maxH = Math.max(maxH, h[i]); else minH = Math.min(minH, h[i]); }
    for (let i = 0; i < n; i++) {
      if (type[i] === 0) h[i] = Math.max(0.004, Math.pow(h[i] / maxH, 1.25));
      else h[i] = -Math.max(0.01, Math.min(1, h[i] / minH));
    }
    const tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      for (let c = 0; c < n; c++) {
        if (type[c] !== 0) { tmp[c] = h[c]; continue; }
        let s = 0, k0 = 0;
        for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] === 0) { s += h[q]; k0++; } }
        tmp[c] = k0 ? Math.max(0.004, (h[c] * 2 + s / k0) / 3) : h[c];
      }
      h.set(tmp);
    }
    // ocean depth: smooth by distance from coast
    const dist = new Int32Array(n).fill(-1); const q = [];
    for (let c = 0; c < n; c++) if (type[c] !== 1) { dist[c] = 0; q.push(c); }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && dist[o] < 0) { dist[o] = dist[c] + 1; q.push(o); } } }
    for (let c = 0; c < n; c++) if (type[c] === 1) h[c] = -clamp(dist[c] / 9 * 0.7 + (-h[c]) * 0.3 + fbm(nz[4], cx[c] / 200, cy[c] / 200, 3) * 0.15, 0.02, 1);
  }
  T.height = now() - t; t = now();

  // ---- drainage (priority flood) ----
  const recv = new Int32Array(n).fill(-1); const fz = new Float32Array(n); const order = [];
  {
    const vis = new Uint8Array(n); const heap = new Heap();
    for (let c = 0; c < n; c++) {
      if (type[c] !== 1) continue; vis[c] = 1; fz[c] = h[c];
      for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] !== 1) { heap.push(c, h[c]); break; } }
    }
    while (heap.size) {
      const c = heap.pop(); const z = heap.lastP;
      if (type[c] !== 1) order.push(c);
      for (let k = nOff[c]; k < nOff[c + 1]; k++) {
        const q = nbr[k]; if (q < 0 || vis[q]) continue;
        vis[q] = 1; recv[q] = c; const e = type[q] === 2 ? h[q] : h[q];
        fz[q] = Math.max(e, z + 1e-5); heap.push(q, fz[q]);
      }
    }
  }
  { // depressions -> lakes (keep meaningful ones)
    const cand = c => type[c] === 0 && fz[c] - h[c] > 0.015;
    const groups = bfsComp(cand).sort((a, b) => b.length - a.length);
    const maxLakes = 14;
    groups.forEach((g, i) => { if (i < maxLakes && g.length >= 2) for (const c of g) type[c] = 2; });
  }
  // ---- climate ----
  const distSea = new Int32Array(n).fill(-1);
  { const q = []; for (let c = 0; c < n; c++) if (type[c] === 1) { distSea[c] = 0; q.push(c); }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && distSea[o] < 0) { distSea[o] = distSea[c] + 1; q.push(o); } } } }
  let maxDist = 1; for (let c = 0; c < n; c++) maxDist = Math.max(maxDist, distSea[c]);
  // latitude is measured across the continent itself, so the north tip is always polar
  // and the south tip always hot (glaciers + deserts on every map)
  const CL = { temperate: [-8, 37], cold: [-16, 24], hot: [6, 44], skyrim: [-24, 12] }[climate] || [-8, 37];
  let minY = H, maxY = 0;
  for (let c = 0; c < n; c++) if (type[c] !== 1) { if (cy[c] < minY) minY = cy[c]; if (cy[c] > maxY) maxY = cy[c]; }
  const latSpan = Math.max(1, maxY - minY);
  const latOf = c => clamp((cy[c] - minY) / latSpan, -0.1, 1.1);
  const temp = new Float32Array(n), moist = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const lat = latOf(c); const hl = Math.max(0, h[c]);
    temp[c] = CL[0] + (CL[1] - CL[0]) * lat - hl * 24 + fbm(nz[5], cx[c] / 300, cy[c] / 300, 2) * 4;
    if (type[c] === 1) { moist[c] = 1; continue; }
    const u = cx[c] / (H / 2), v = cy[c] / (H / 2);
    let m = 0.52 + 0.55 * fbm(nz[6], u * 1.4 + 11, v * 1.4 - 7, 4);
    m += 0.28 * Math.exp(-distSea[c] / 5) - 0.22 * distSea[c] / maxDist;
    let mx = 0; // rain shadow (westerlies)
    for (let s = 1; s <= 5; s++) { const q = cellAt(M, cx[c] - s * spacing * 1.6, cy[c]); if (type[q] === 0) mx = Math.max(mx, h[q]); }
    m -= Math.max(0, mx - hl) * 0.9;
    if (temp[c] > 22) m -= (temp[c] - 22) * 0.012;
    // subtropical dry belt in the south interior (Hadley cell) -> real deserts
    const belt = clamp((lat - 0.58) / 0.22, 0, 1);
    m -= belt * (0.42 + 0.25 * fbm(nz[6], u * 2.1 - 5, v * 2.1 + 3, 2)) * (1 - Math.exp(-distSea[c] / 3));
    moist[c] = clamp(m, 0, 1);
  }
  // ---- flux ----
  const flux = new Float32Array(n);
  for (let c = 0; c < n; c++) if (type[c] !== 1) flux[c] = 0.2 + moist[c];
  for (let i = order.length - 1; i >= 0; i--) { const c = order[i]; const r = recv[c]; if (r >= 0 && type[r] !== 1) flux[r] += flux[c]; }
  let riverThr;
  { const lf = []; for (let c = 0; c < n; c++) if (type[c] === 0) lf.push(flux[c]); lf.sort((a, b) => a - b);
    riverThr = Math.max(3, lf[Math.floor((1 - riverFrac) * (lf.length - 1))] || 10); }
  const isRiver = c => type[c] === 0 && flux[c] > riverThr;
  // ---- biomes & shade ----
  const biome = new Uint8Array(n); const shade = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    if (type[c] !== 0) { biome[c] = 0; continue; }
    const hl = h[c], tt = temp[c], m = moist[c]; let b;
    if (hl > 0.8) b = tt < 2 ? 11 : 13;
    else if (tt < -6) b = 11;
    else if (tt < 0) b = m > 0.55 ? 9 : 10;
    else if (tt < 7) b = m < 0.28 ? 10 : 9;
    else if (tt < 19) b = (m > 0.82 && hl < 0.18) ? 12 : m < 0.2 ? 2 : m < 0.44 ? 4 : m < 0.72 ? 6 : 8;
    else if (tt < 25) b = m < 0.18 ? 1 : m < 0.4 ? 4 : m < 0.7 ? 5 : (m > 0.86 && hl < 0.15) ? 12 : 8;
    else b = m < 0.26 ? 1 : m < 0.42 ? 3 : m < 0.58 ? 5 : (m > 0.85 && hl < 0.15) ? 12 : 7;
    biome[c] = b;
    let gx = 0, gy = 0;
    for (let k = nOff[c]; k < nOff[c + 1]; k++) {
      const q = nbr[k]; if (q < 0) continue;
      const dx = cx[q] - cx[c], dy = cy[q] - cy[c]; const d2 = dx * dx + dy * dy;
      const dh = Math.max(0, h[q]) - hl; gx += dh * dx / d2; gy += dh * dy / d2;
    }
    gx *= spacing / 2; gy *= spacing / 2;
    shade[c] = clamp((gx + gy) * 0.707 * 7, -1, 1);
  }
  T.climate = now() - t; t = now();

  // ---- burgs: capitals ----
  const score = new Float32Array(n);
  const coastal = c => { for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] === 1) return true; } return false; };
  const nearLake = c => { for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] === 2) return true; } return false; };
  const landCells = [];
  for (let c = 0; c < n; c++) {
    if (type[c] !== 0) continue; landCells.push(c);
    const hab = BIOMES[biome[c]].hab; if (!hab) continue;
    let s = hab * (1 - h[c] * 0.6);
    if (isRiver(c)) s += 25 + Math.min(35, Math.sqrt(flux[c] / riverThr) * 8);
    if (coastal(c)) s += 22; if (nearLake(c)) s += 12;
    score[c] = s * (0.7 + rand() * 0.6);
  }
  const landArea = landCells.length * W * H / n;
  const byScore = landCells.filter(c => score[c] > 0).sort((a, b) => score[b] - score[a]);
  const burgs = []; const burgCell = new Int32Array(n).fill(-1);
  const placeSet = (count, minD, isCap) => {
    let d = minD; let tries = 0;
    while (burgs.filter(b => b.capital === isCap).length < count && tries++ < 8) {
      const d2 = d * d;
      for (const c of byScore) {
        if (burgs.filter(b => b.capital === isCap).length >= count) break;
        if (burgCell[c] >= 0) continue;
        let ok = true;
        for (const b of burgs) { const lim = b.capital || isCap ? d2 : d2; if ((cx[c] - b.x) ** 2 + (cy[c] - b.y) ** 2 < lim) { ok = false; break; } }
        if (!ok) continue;
        burgCell[c] = burgs.length;
        burgs.push({ id: burgs.length, cell: c, x: cx[c], y: cy[c], capital: isCap });
      }
      d *= 0.82;
    }
  };
  placeSet(nStates, Math.sqrt(landArea / nStates) * 0.62, true);
  const nCap = burgs.length;
  placeSet(nTowns, Math.sqrt(landArea / (nCap + nTowns)) * 0.55, false);
  // fill empty lands with villages: no habitable spot farther than gapKm from a settlement
  // (deserts, tundra and high mountains are allowed to stay sparser; glaciers stay empty)
  {
    const cellKm = spacing * kmPerUnit;
    const gapKm = clamp(62 * Math.sqrt(60 / Math.max(10, nTowns)), 30, 120);
    const loose = c => { const b = biome[c]; return (b === 1 || b === 2 || b === 10 || b === 13) ? 1.8 : h[c] > 0.6 ? 1.5 : (b === 9 || b === 7 || b === 12) ? 1.25 : 1; };
    const dist = new Float32Array(n).fill(Infinity);
    const spread = src => { // BFS over land/lake from src, updating nearest-settlement distance (in km)
      const q = [src]; dist[src] = 0;
      for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; const nd = dist[c] + cellKm;
        if (nd > gapKm * 2.2) continue;
        for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o < 0 || type[o] === 1 || nd >= dist[o]) continue; dist[o] = nd; q.push(o); } }
    };
    for (const b of burgs) spread(b.cell);
    const cand = landCells.filter(c => biome[c] !== 11 && BIOMES[biome[c]].hab > 0);
    let maxS = 1; for (const c of cand) if (score[c] > maxS) maxS = score[c];
    for (let guard = 0; guard < 4000; guard++) {
      let best = -1, bv = 0;
      for (const c of cand) {
        if (burgCell[c] >= 0) continue;
        const over = dist[c] / (gapKm * loose(c)); if (over < 1) continue;
        const v = over * (0.55 + 0.45 * score[c] / maxS);
        if (v > bv) { bv = v; best = c; }
      }
      if (best < 0) break;
      // settle at the most attractive cell close to the chosen gap
      let pick = best, ps = score[best];
      for (let k = nOff[best]; k < nOff[best + 1]; k++) { const o = nbr[k]; if (o >= 0 && type[o] === 0 && burgCell[o] < 0 && biome[o] !== 11 && score[o] > ps) { ps = score[o]; pick = o; } }
      burgCell[pick] = burgs.length;
      burgs.push({ id: burgs.length, cell: pick, x: cx[pick], y: cy[pick], capital: false, filler: true });
      spread(pick);
    }
  }
  T.burgs = now() - t; t = now();

  // ---- cultures ----
  const caps = burgs.filter(b => b.capital);
  const nCult = clamp(Math.round(caps.length * 0.65), Math.min(3, caps.length), 7);
  const seeds = [caps[0]];
  while (seeds.length < nCult) {
    let best = null, bd = -1;
    for (const b of caps) { if (seeds.includes(b)) continue; let md = Infinity; for (const s of seeds) md = Math.min(md, (s.x - b.x) ** 2 + (s.y - b.y) ** 2); if (md > bd) { bd = md; best = b; } }
    seeds.push(best);
  }
  const cultures = []; const usedLang = new Set();
  for (const s of seeds) {
    const c = s.cell, b = biome[c], tt = temp[c];
    const prefs = [];
    if (tt < 4) prefs.push('nord');
    if (b === 1 || b === 3 || (tt > 23 && moist[c] < 0.45)) prefs.push('desert');
    if (b === 12 || b === 7) prefs.push('marsh');
    if (h[c] > 0.42) prefs.push(rand() < 0.5 ? 'dwarf' : 'orc');
    if (b === 6 || b === 8 || b === 5) prefs.push('elf');
    prefs.push('imp');
    let lang = prefs.find(l => !usedLang.has(l));
    if (!lang) { const free = LANG_KEYS.filter(l => !usedLang.has(l)); lang = free.length ? free[(rand() * free.length) | 0] : prefs[0]; }
    usedLang.add(lang);
    cultures.push({ id: cultures.length, lang, name: LANGS[lang].name, center: c, cells: 0 });
  }
  const dijkstra = (sources, costFn, owner) => {
    const cost = new Float64Array(n).fill(Infinity); const heap = new Heap();
    sources.forEach((c, i) => { cost[c] = 0; owner[c] = i; heap.push(c, 0); });
    while (heap.size) {
      const c = heap.pop(); const pc = heap.lastP; if (pc > cost[c]) continue;
      const o = owner[c];
      for (let k = nOff[c]; k < nOff[c + 1]; k++) {
        const q = nbr[k]; if (q < 0) continue;
        const nc = pc + costFn(c, q, o); if (nc < cost[q]) { cost[q] = nc; owner[q] = o; heap.push(q, nc); }
      }
    }
  };
  const culture = new Int16Array(n).fill(-1);
  const langPenalty = (lang, q) => {
    const tt = temp[q], b = biome[q];
    switch (lang) {
      case 'nord': return tt > 14 ? 1.5 : 0;
      case 'desert': return tt < 14 ? 1.5 : 0;
      case 'marsh': return (b === 12 || b === 7 || b === 8 || b === 5) ? 0 : 0.9;
      case 'elf': return (b === 5 || b === 6 || b === 8 || b === 7) ? 0 : 0.6;
      case 'dwarf': case 'orc': return h[q] < 0.3 ? 0.8 : 0;
      default: return 0;
    }
  };
  dijkstra(cultures.map(c => c.center), (c, q, o) => {
    if (type[q] === 1) return 25;
    return (BIOMES[biome[q]].cost + (h[q] > 0.55 ? 3 : 0) + langPenalty(cultures[o].lang, q)) * (type[q] === 2 ? 2 : 1);
  }, culture);
  for (let c = 0; c < n; c++) if (type[c] === 0 && culture[c] >= 0) cultures[culture[c]].cells++;

  // ---- states ----
  const states = caps.map((b, i) => ({ id: i, capital: b.id, cell: b.cell, culture: culture[b.cell], expansion: 0.8 + rand() * 0.6 }));
  const state = new Int16Array(n).fill(-1);
  dijkstra(states.map(s => s.cell), (c, q, o) => {
    if (type[q] === 1) return 18;
    const S = states[o];
    let cc = BIOMES[biome[q]].cost + (h[q] > 0.55 ? (h[q] - 0.4) * 10 : h[q] * 1.5);
    if (isRiver(q) && !isRiver(c)) cc += 2;
    if (culture[q] !== S.culture) cc += 2.5;
    if (type[q] === 2) cc += 2;
    return cc / S.expansion;
  }, state);
  T.states = now() - t; t = now();

  // naming
  const hue0 = rand() * 360;
  states.forEach((s, i) => {
    const lang = cultures[s.culture].lang;
    s.name = namer(lang, 11);
    s.color = `hsl(${(hue0 + i * 137.508) % 360},${42 + (i % 3) * 8}%,${58 + (i % 2) * 7}%)`;
    s.cells = 0; s.burgs = 0; s.rural = 0; s.urban = 0;
  });
  const cellAreaKm = W * H / n * kmPerUnit * kmPerUnit;
  for (let c = 0; c < n; c++) {
    if (type[c] !== 0 || state[c] < 0) continue;
    const s = states[state[c]]; s.cells++; s.rural += BIOMES[biome[c]].hab / 100 * cellAreaKm * 9;
  }
  const avgCells = landCells.length / Math.max(1, states.length);
  const sizeOrder = states.slice().sort((a, b) => b.cells - a.cells);
  states.forEach(s => {
    const L = LANGS[cultures[s.culture].lang];
    let form = L.forms[(rand() * L.forms.length) | 0];
    if (s.cells < avgCells * 0.45 && !['orc', 'marsh', 'desert'].includes(cultures[s.culture].lang)) form = ['Княжество', 'Герцогство', 'Вольный город'][(rand() * 3) | 0];
    if (s === sizeOrder[0] && cultures[s.culture].lang === 'imp') form = 'Империя';
    s.form = form; s.fullName = form + ' ' + s.name;
  });
  burgs.forEach(b => {
    const c = b.cell; b.state = state[c]; b.culture = culture[c];
    b.name = b.capital ? namer(cultures[b.culture].lang, 11) : namer(cultures[Math.max(0, b.culture)].lang, 11);
    b.port = coastal(c); b.river = isRiver(c); b.lake = nearLake(c);
    const sc = score[c];
    b.pop = b.capital ? +(8 + sc * 0.28 * (0.6 + rand() * 0.8)).toFixed(1) : b.filler ? +(0.2 + sc * 0.025 * (0.4 + rand() * 1.2)).toFixed(1) : +(0.4 + sc * 0.07 * (0.35 + rand() * 1.0)).toFixed(1);
    b.type = b.capital ? 'Столица' : b.pop >= 10 ? 'Город' : b.pop >= 3 ? 'Городок' : 'Деревня';
    b.elev = Math.round(h[c] * 4500);
    if (b.state >= 0) { states[b.state].burgs++; states[b.state].urban += b.pop * 1000; }
  });
  // diplomacy
  const neigh = states.map(() => new Set());
  for (let c = 0; c < n; c++) {
    if (type[c] === 1) continue;
    for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] !== 1 && state[q] !== state[c]) neigh[state[c]].add(state[q]); }
  }
  const pickRel = () => { let r = rand(); for (const [nm, w] of RELATIONS) { if ((r -= w) <= 0) return nm; } return 'Нейтралитет'; };
  states.forEach(s => { s.neighbors = [...neigh[s.id]]; s.relations = {}; });
  states.forEach(s => s.neighbors.forEach(o => { if (o > s.id) { const r = pickRel(); s.relations[o] = r; states[o].relations[s.id] = r; } }));

  // ---- peoples (races of the character editor) living in fitting biomes inside states ----
  const folk = new Int16Array(n).fill(-1);
  const peoples = [];
  {
    const distBurg = new Int32Array(n).fill(-1);
    { const q = []; for (const b of burgs) { distBurg[b.cell] = 0; q.push(b.cell); }
      for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && distBurg[o] < 0) { distBurg[o] = distBurg[c] + 1; q.push(o); } } } }
    const distLand = new Int32Array(n).fill(-1);
    { const q = []; for (let c = 0; c < n; c++) if (type[c] !== 1) { distLand[c] = 0; q.push(c); }
      for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && distLand[o] < 0) { distLand[o] = distLand[c] + 1; q.push(o); } } } }
    const L0 = c => type[c] === 0;
    const forest = b => b === 5 || b === 6 || b === 8;
    const wild = c => Math.min(1, distBurg[c] / 4); // 0 near towns, 1 far away
    const band = (v, a, b, soft) => v < a ? Math.max(0, 1 - (a - v) / soft) : v > b ? Math.max(0, 1 - (v - b) / soft) : 1;
    for (const F of FOLK) {
      const fit = c => {
        const b = biome[c], hh = h[c], tt = temp[c];
        switch (F.id) {
          case 'triton': return type[c] === 1 && distLand[c] >= 2 && distLand[c] <= 7 ? 0.6 + (h[c] < -0.25 ? 0.4 : 0) : 0;
          case 'goliath': return L0(c) && hh > 0.6 ? 0.5 + hh * 0.5 : 0;
          case 'drow': return L0(c) && hh > 0.36 && distBurg[c] >= 2 ? 0.3 + hh * 0.4 + wild(c) * 0.3 : 0;
          case 'mountain-dwarf': return L0(c) && hh > 0.45 ? 0.5 + band(hh, 0.5, 0.66, 0.15) * 0.5 - (b === 11 ? 0.3 : 0) : 0;
          case 'grung': return L0(c) && (b === 7 || (b === 12 && tt > 18) || (b === 8 && tt > 21)) ? 0.6 + wild(c) * 0.4 : 0;
          case 'dragonborn': return L0(c) && (hh > 0.45 || b === 1 || b === 13) && b !== 11 ? 0.4 + wild(c) * 0.6 : 0;
          case 'wood-elf': return L0(c) && (forest(b) || b === 9) && tt > -2 && tt < 25 ? (b === 9 ? 0.35 : 0.6) + wild(c) * 0.4 : 0;
          case 'forest-gnome': return L0(c) && forest(b) && hh < 0.45 ? 0.5 + wild(c) * 0.5 : 0;
          case 'high-elf': return L0(c) && (forest(b) || b === 4 || b === 9) && tt > 2 && tt < 24 ? 0.5 + (isRiver(c) || coastal(c) ? 0.3 : 0) + band(hh, 0.1, 0.4, 0.2) * 0.2 : 0;
          case 'hill-dwarf': return L0(c) && hh >= 0.28 && hh <= 0.52 && b !== 11 ? 0.7 : 0;
          case 'rock-gnome': return L0(c) && hh >= 0.2 && hh <= 0.45 && (forest(b) || b === 4 || b === 9) ? 0.7 : 0;
          case 'shifter': return L0(c) && (b === 9 || forest(b) || b === 12) && distBurg[c] >= 2 ? 0.4 + wild(c) * 0.6 : 0;
          case 'centaur': return L0(c) && (b === 4 || b === 3) && hh < 0.35 ? 0.5 + wild(c) * 0.5 : 0;
          case 'half-orc': return L0(c) && (b === 2 || b === 10 || b === 3 || b === 4 || b === 9) && distBurg[c] >= 2 ? 0.4 + wild(c) * 0.6 : 0;
          case 'goblin': return L0(c) && (hh > 0.25 || forest(b) || b === 12) && b !== 11 && distBurg[c] >= 1 ? 0.4 + wild(c) * 0.4 : 0;
          case 'stout-halfling': return L0(c) && (b === 4 || b === 5 || b === 6) && tt > 8 && hh < 0.4 ? 0.5 + (isRiver(c) ? 0.3 : 0) + (distBurg[c] <= 3 ? 0.2 : 0) : 0;
          default: return 0;
        }
      };
      const pool = F.sea ? null : landCells;
      const cand = []; const sc = new Float32Array(n);
      for (let c = 0; c < n; c++) { if (folk[c] >= 0) continue; if (!F.sea && type[c] !== 0) continue; const v = fit(c); if (v > 0) { sc[c] = v * (0.85 + rand() * 0.3); cand.push(c); } }
      void pool;
      const base = F.sea ? landCells.length * 0.6 : landCells.length;
      const target = Math.max(12, Math.round(base * F.size));
      const minCells = Math.max(6, Math.round(target * 0.15));
      if (P.debugFolk) console.log(F.id, 'cand', cand.length, 'target', target);
      if (cand.length < minCells) { peoples.push({ id: peoples.length, key: F.id, absent: true, cells: 0 }); continue; }
      cand.sort((a, b) => sc[b] - sc[a]);
      const areas = [];
      for (let a = 0; a < F.areas; a++) {
        const seedC = cand.find(c => folk[c] < 0 && areas.every(o => Math.hypot(cx[o.seed] - cx[c], cy[o.seed] - cy[c]) > W * 0.22));
        if (seedC == null) break;
        const fid = peoples.length + areas.length;
        const heap = new Heap(); heap.push(seedC, -sc[seedC]); let got = 0; const mine = [];
        const seen = new Set([seedC]);
        while (heap.size && got < target) {
          const c = heap.pop(); if (folk[c] >= 0) continue;
          folk[c] = fid; mine.push(c); got++;
          for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q < 0 || seen.has(q) || folk[q] >= 0 || sc[q] <= 0) continue; seen.add(q); heap.push(q, -sc[q] + Math.hypot(cx[q] - cx[seedC], cy[q] - cy[seedC]) / spacing * 0.02); }
        }
        if (got < minCells) { for (const c of mine) folk[c] = -1; continue; }
        areas.push({ seed: seedC, cells: mine });
      }
      if (!areas.length) { peoples.push({ id: peoples.length, key: F.id, absent: true, cells: 0 }); continue; }
      for (const A of areas) {
        const fid = peoples.length;
        for (const c of A.cells) folk[c] = fid; // re-index after possible rollbacks
        // label anchor: cell of the area farthest from its edge
        const inA = new Set(A.cells); let best = A.cells[0], bd = -1;
        const dd = new Map(); const q = [];
        for (const c of A.cells) { let edge = false; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o < 0 || !inA.has(o)) { edge = true; break; } } if (edge) { dd.set(c, 0); q.push(c); } }
        for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; const d0 = dd.get(c); if (d0 > bd) { bd = d0; best = c; } for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && inA.has(o) && !dd.has(o)) { dd.set(o, d0 + 1); q.push(o); } } }
        const inStates = {}; for (const c of A.cells) if (state[c] >= 0) inStates[state[c]] = (inStates[state[c]] || 0) + 1;
        peoples.push({ id: fid, key: F.id, name: F.name, race: F.race, sub: F.sub, color: F.color, where: F.where, lore: F.lore, sea: !!F.sea, under: !!F.under,
          cells: A.cells.length, lx: cx[best], ly: cy[best], states: Object.entries(inStates).sort((a, b) => b[1] - a[1]).map(([s, k]) => [+s, k]) });
      }
    }
    // composition of every settlement
    const folkNear = (c, R) => { // folk ids within R cells
      const res = new Map(); const seen = new Set([c]); let fr = [c];
      for (let d = 0; d <= R; d++) { const nx = []; for (const x of fr) { if (folk[x] >= 0 && !peoples[folk[x]].sea) res.set(folk[x], Math.min(res.get(folk[x]) ?? 99, d)); for (let k = nOff[x]; k < nOff[x + 1]; k++) { const o = nbr[k]; if (o >= 0 && !seen.has(o)) { seen.add(o); nx.push(o); } } } fr = nx; }
      return res;
    };
    for (const b of burgs) {
      const sh = {}; const add = (k, v) => { sh[k] = (sh[k] || 0) + v; };
      const big = b.pop >= 10 || b.capital, mid = b.pop >= 3;
      const near = folkNear(b.cell, 3);
      for (const [fid, d] of near) {
        const F = FOLK_BY[peoples[fid].key];
        if (d === 0) add(F.id, b.capital ? 10 + rand() * 15 : F.builds ? 55 + rand() * 30 : 18 + rand() * 20);
        else add(F.id, (F.builds ? 10 : 5) * (4 - d) / 3 * (0.6 + rand() * 0.8));
      }
      const elves = [...near.keys()].some(f => /elf/.test(peoples[f].key));
      add('half-elf', (elves ? 6 : 1.5) * (big ? 1.6 : 1) * (0.5 + rand()));
      add('lightfoot-halfling', (mid ? 4 : 6) * (0.4 + rand()));
      if (big) { add('tiefling', 2 + rand() * 4); add('changeling', rand() * 2.5); add('half-orc', 1 + rand() * 3); add('goblin', rand() * 3); add('aasimar', rand() * 1.5); add('dragonborn', rand() * 2); }
      if (big && rand() < 0.6) add('kenku', 1 + rand() * 3);
      if (b.port && mid) { add('tabaxi', 0.5 + rand() * 2.5); add('water-genasi', rand() * 2.5); if (rand() < 0.4) add('triton', rand() * 2); }
      const tt = temp[b.cell];
      if (mid && (biome[b.cell] === 1 || tt > 24)) add('fire-genasi', 0.5 + rand() * 2.5);
      if (mid && h[b.cell] > 0.4) add('earth-genasi', 0.5 + rand() * 2);
      if (mid && h[b.cell] > 0.5 && rand() < 0.5) add('air-genasi', 0.5 + rand() * 1.5);
      let other = 0; for (const k in sh) other += sh[k];
      const scale = other > 92 ? 92 / other : 1; const out = [];
      for (const k in sh) { const v = sh[k] * scale; if (v >= 1) out.push([k, Math.round(v)]); }
      const hum = 100 - out.reduce((s, x) => s + x[1], 0); out.push(['human', hum]);
      out.sort((a, b) => b[1] - a[1]); b.races = out;
    }
    // per-state composition by population (rural by cells + urban by settlements)
    states.forEach(s => { s.races = {}; });
    for (let c = 0; c < n; c++) {
      if (type[c] !== 0 || state[c] < 0) continue;
      const p = BIOMES[biome[c]].hab / 100 * cellAreaKm * 9; if (!p) continue;
      const S = states[state[c]].races;
      if (folk[c] >= 0) { const F = FOLK_BY[peoples[folk[c]].key]; S[F.id] = (S[F.id] || 0) + p * (F.builds ? 0.75 : 0.5); S.human = (S.human || 0) + p * (F.builds ? 0.25 : 0.5); }
      else S.human = (S.human || 0) + p;
    }
    for (const b of burgs) { if (b.state < 0) continue; const S = states[b.state].races; for (const [k, v] of b.races) S[k] = (S[k] || 0) + b.pop * 1000 * v / 100; }
    states.forEach(s => {
      const tot = Object.values(s.races).reduce((a, b) => a + b, 0) || 1;
      s.races = Object.entries(s.races).map(([k, v]) => [k, v / tot * 100]).filter(x => x[1] >= 0.5).sort((a, b) => b[1] - a[1]);
    });
  }
  T.names = now() - t; t = now();

  // ---- rivers ----
  const ups = new Map(); const R = c => (type[c] !== 1) && flux[c] > riverThr;
  for (let c = 0; c < n; c++) { if (!R(c)) continue; const r = recv[c]; if (r >= 0 && R(r)) { let l = ups.get(r); if (!l) ups.set(r, l = []); l.push(c); } }
  const edgeMid = (p, q) => {
    for (let k = nOff[p]; k < nOff[p + 1]; k++) if (nbr[k] === q) { const a = ev1[k], b = ev2[k]; return [(vx[a] + vx[b]) / 2, (vy[a] + vy[b]) / 2]; }
    return [(cx[p] + cx[q]) / 2, (cy[p] + cy[q]) / 2];
  };
  const rivers = []; const stack = [];
  for (let c = 0; c < n; c++) if (R(c) && type[c] === 0 && recv[c] >= 0 && type[recv[c]] === 1) stack.push([c, recv[c], true]);
  stack.sort((a, b) => flux[a[0]] - flux[b[0]]);
  const mouthsByFlux = stack.slice().reverse().slice(0, 7).map(s => s[0]);
  const riverOfMouth = new Map();
  while (stack.length) {
    const [start, end, isMouth] = stack.pop();
    const seq = [end, start]; let cur = start;
    for (;;) {
      const l = ups.get(cur); if (!l) break;
      l.sort((a, b) => flux[b] - flux[a]);
      for (let i = 1; i < l.length; i++) stack.push([l[i], cur, false]);
      cur = l[0]; seq.push(cur);
    }
    seq.reverse(); // source ... end
    const water = c => type[c] !== 0;
    let i = 0; const L = seq.length;
    const parts = [];
    while (i < L) {
      if (water(seq[i])) { i++; continue; }
      let j = i; while (j + 1 < L && !water(seq[j + 1])) j++;
      const isLast = j === L - 1; // tributary joining a land cell
      const cellsN = j - i + 1;
      if (cellsN >= (isLast || isMouth ? 2 : 2)) {
        const pts = [], ws = [];
        const wOf = c => Math.min(spacing * 0.42, spacing * 0.05 + spacing * 0.04 * Math.sqrt(flux[c] / riverThr));
        if (i > 0) { const m = edgeMid(seq[i - 1], seq[i]); pts.push(m[0], m[1]); ws.push(wOf(seq[i])); }
        for (let k = i; k <= j; k++) {
          const c = seq[k];
          if (k > i || i > 0) { // meander point between previous and this centre
            const px = pts[pts.length - 2], py = pts[pts.length - 1];
            const dx = cx[c] - px, dy = cy[c] - py; const off = (rand() - 0.5) * 0.45;
            pts.push((px + cx[c]) / 2 - dy * off, (py + cy[c]) / 2 + dx * off); ws.push(wOf(c));
          }
          pts.push(cx[c], cy[c]); ws.push(wOf(c));
        }
        if (j + 1 < L) { const m = edgeMid(seq[j], seq[j + 1]); pts.push(m[0], m[1]); ws.push(wOf(seq[j])); }
        if (pts.length >= 6 || (pts.length >= 4 && cellsN >= 2)) parts.push({ pts, ws, flux: flux[seq[j]] });
      }
      i = j + 1;
    }
    if (isMouth && parts.length) riverOfMouth.set(start, parts);
    for (const p of parts) rivers.push(p);
  }
  // name the biggest rivers
  for (const m of mouthsByFlux) {
    const parts = riverOfMouth.get(m); if (!parts) continue;
    const longest = parts.reduce((a, b) => b.pts.length > a.pts.length ? b : a);
    if (longest.pts.length < 12) continue;
    longest.name = namer(cultures[Math.max(0, culture[m])].lang, 9);
  }
  T.rivers = now() - t; t = now();

  // ---- roads ----
  const roadCell = new Uint8Array(n); const roadEdges = new Map();
  const gS = new Float64Array(n), from = new Int32Array(n), stamp = new Int32Array(n); let curStamp = 0;
  const stepCost = (c, q) => {
    if (type[q] !== 0) return Infinity;
    const d = Math.hypot(cx[q] - cx[c], cy[q] - cy[c]) / spacing;
    let k = BIOMES[biome[q]].cost * 0.6 + 0.6 + Math.abs(h[q] - h[c]) * 25 + (h[q] > 0.6 ? (h[q] - 0.6) * 25 : 0);
    if (isRiver(q)) k += 1.5;
    return d * k * (roadCell[q] ? 0.3 : 1);
  };
  const astar = (s, g) => {
    curStamp++; const heap = new Heap(); stamp[s] = curStamp; gS[s] = 0; from[s] = -1; heap.push(s, 0);
    const gx = cx[g], gy = cy[g]; let exp = 0;
    while (heap.size) {
      const c = heap.pop(); if (c === g) break;
      if (++exp > n * 3) return null;
      const gc = gS[c];
      for (let k = nOff[c]; k < nOff[c + 1]; k++) {
        const q = nbr[k]; if (q < 0) continue;
        const sc = stepCost(c, q); if (sc === Infinity) continue;
        const ng = gc + sc;
        if (stamp[q] !== curStamp || ng < gS[q]) { stamp[q] = curStamp; gS[q] = ng; from[q] = c; heap.push(q, ng + Math.hypot(cx[q] - gx, cy[q] - gy) / spacing * 0.35); }
      }
    }
    if (stamp[g] !== curStamp) return null;
    const path = []; for (let c = g; c !== -1; c = from[c]) path.push(c);
    return path;
  };
  const addRoad = (path, level) => {
    for (let i = 0; i < path.length; i++) {
      roadCell[path[i]] = 1;
      if (i) { const a = path[i - 1], b = path[i]; const key = a < b ? a * 4194304 + b : b * 4194304 + a; const old = roadEdges.get(key); if (!old || old > level) roadEdges.set(key, level); }
    }
  };
  const connected = new Set();
  { // capitals: MST over k nearest
    const cand = [];
    caps.forEach((a, i) => {
      const d = caps.map((b, j) => [j, (a.x - b.x) ** 2 + (a.y - b.y) ** 2]).filter(x => x[0] !== i).sort((x, y) => x[1] - y[1]).slice(0, 4);
      d.forEach(([j, dd]) => { if (i < j) cand.push([i, j, dd]); else if (!d.some(() => false)) cand.push([j, i, dd]); });
    });
    cand.sort((a, b) => a[2] - b[2]);
    const parent = caps.map((_, i) => i); const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const seenPair = new Set(); const extra = [];
    for (const [i, j] of cand) {
      const key = i * 1000 + j; if (seenPair.has(key)) continue; seenPair.add(key);
      if (find(i) !== find(j)) {
        const path = astar(caps[i].cell, caps[j].cell);
        if (path) { parent[find(i)] = find(j); addRoad(path, 1); connected.add(caps[i].id); connected.add(caps[j].id); }
      } else extra.push([i, j]);
    }
    for (const [i, j] of extra.slice(0, Math.ceil(caps.length / 3))) { if (rand() < 0.6) { const p = astar(caps[i].cell, caps[j].cell); if (p) addRoad(p, 1); } }
    caps.forEach(c => connected.add(c.id));
  }
  {
    const towns = burgs.filter(b => !b.capital);
    const capOf = b => burgs[states[b.state] ? states[b.state].capital : 0];
    towns.sort((a, b) => ((a.x - capOf(a).x) ** 2 + (a.y - capOf(a).y) ** 2) - ((b.x - capOf(b).x) ** 2 + (b.y - capOf(b).y) ** 2));
    const net = burgs.filter(b => b.capital);
    for (const t of towns) {
      const cands = net.map(b => [b, (b.x - t.x) ** 2 + (b.y - t.y) ** 2 * 1]).sort((a, b) => a[1] - b[1]).slice(0, 3);
      let done = false;
      for (const [b] of cands) {
        const p = astar(t.cell, b.cell); if (p) { addRoad(p, t.pop >= 3 || b.capital && t.pop > 1.5 ? 2 : 3); done = true; break; }
      }
      net.push(t); t.road = done;
    }
  }
  const roads = [];
  for (const lvl of [1, 2, 3]) {
    const pairs = [];
    for (const [key, l] of roadEdges) if (l === lvl) pairs.push(Math.floor(key / 4194304), key % 4194304);
    for (const line of chain(pairs)) { const pts = []; for (const c of line) pts.push(cx[c], cy[c]); roads.push({ level: lvl, pts }); }
  }
  T.roads = now() - t; t = now();

  // ---- geometry: coast, lakes, borders ----
  const coast = loops(M, c => type[c] !== 1);
  const lakes = loops(M, c => type[c] === 2);
  const bpairs = [];
  for (let c = 0; c < n; c++) {
    if (type[c] !== 0) continue;
    for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q > c && type[q] === 0 && state[q] !== state[c]) bpairs.push(ev1[k], ev2[k]); }
  }
  const borders = chain(bpairs).map(line => { const pts = []; for (const v of line) pts.push(vx[v], vy[v]); return pts; });

  // ---- relief icons ----
  const icons = [];
  {
    const grid = new Map(); const gk = (x, y) => Math.floor(x / spacing) * 65536 + Math.floor(y / spacing);
    const free = (x, y, r) => {
      const R = Math.ceil(r / spacing); const bx = Math.floor(x / spacing), by = Math.floor(y / spacing);
      for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) { const l = grid.get((bx + i) * 65536 + by + j); if (l) for (const o of l) if ((o.x - x) ** 2 + (o.y - y) ** 2 < (r + o.r) ** 2 * 0.25) return false; }
      return true;
    };
    const put = ic => { icons.push(ic); const k = gk(ic.x, ic.y); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(ic); };
    const blocked = new Uint8Array(n);
    for (const b of burgs) { blocked[b.cell] = 1; for (let k = nOff[b.cell]; k < nOff[b.cell + 1]; k++) if (nbr[k] >= 0) blocked[nbr[k]] = 1; }
    const byH = landCells.slice().sort((a, b) => h[b] - h[a]);
    for (const c of byH) {
      if (blocked[c] || h[c] < 0.3) continue;
      if (flux[c] > riverThr * 2) continue;
      const jx = cx[c] + (rand() - 0.5) * spacing * 0.5, jy = cy[c] + (rand() - 0.5) * spacing * 0.5;
      if (h[c] >= 0.42) {
        const s = spacing * (0.8 + (h[c] - 0.42) * 1.8) * (0.85 + rand() * 0.3);
        const type2 = h[c] > 0.62 && temp[c] < 11 ? 'M' : 'm';
        if (free(jx, jy, s * 2.1)) {
          put({ t: type2, x: jx, y: jy, s, r: s * 2.1 });
          // tall massifs get a second, smaller peak beside the main one -> reads as a ridge, not a single cone
          if (h[c] > 0.5 && rand() < 0.65) {
            const a = rand() * Math.PI * 2, s2 = s * (0.55 + rand() * 0.2);
            const jx2 = jx + Math.cos(a) * s * 0.85, jy2 = jy + Math.sin(a) * s * 0.4 - s2 * 0.15;
            put({ t: type2, x: jx2, y: jy2, s: s2, r: s2 * 1.4, behind: true });
          }
        }
      }
      else if (rand() < 0.55) { const s = spacing * 0.6; if (free(jx, jy, s * 2.2)) put({ t: 'h', x: jx, y: jy, s, r: s * 2.2 }); }
    }
    const treeT = { 5: 't', 6: 't', 8: 't', 9: 'c', 7: 'p', 12: 's', 1: 'd' };
    for (const c of landCells) {
      if (blocked[c]) continue; const tt = treeT[biome[c]]; if (!tt) continue;
      if (rand() > (tt === 'd' ? 0.25 : tt === 's' ? 0.45 : 0.75)) continue;
      const jx = cx[c] + (rand() - 0.5) * spacing * 0.7, jy = cy[c] + (rand() - 0.5) * spacing * 0.7;
      const s = spacing * (0.32 + rand() * 0.1);
      if (free(jx, jy, s * 2.4)) put({ t: tt, x: jx, y: jy, s, r: s * 2.4 });
    }
    // man-made props: windmills on farmland near real (non-filler) towns, lighthouses on capes near ports
    const farmBiome = { 3: 1, 4: 1, 5: 1, 6: 0.5 };
    for (const b of burgs) {
      if (b.filler || b.pop < 1.5) continue;
      const chanceW = farmBiome[biome[b.cell]]; if (!chanceW) continue;
      for (let k = nOff[b.cell]; k < nOff[b.cell + 1]; k++) {
        const q = nbr[k]; if (q < 0 || type[q] !== 0 || biome[q] === 11) continue;
        if (rand() < 0.4 * chanceW) { const s = spacing * 0.42; if (free(cx[q], cy[q], s * 2.2)) put({ t: 'w', x: cx[q], y: cy[q], s, r: s * 2.2 }); break; }
      }
    }
    for (const b of burgs) {
      if (!coastal(b.cell) || (!b.capital && b.pop < 6) || rand() > 0.65) continue;
      for (let k = nOff[b.cell]; k < nOff[b.cell + 1]; k++) {
        const q = nbr[k]; if (q < 0 || type[q] !== 1) continue;
        const s = spacing * 0.5; if (free(cx[b.cell] * 0.35 + cx[q] * 0.65, cy[b.cell] * 0.35 + cy[q] * 0.65, s * 2.4)) put({ t: 'L', x: cx[b.cell] * 0.35 + cx[q] * 0.65, y: cy[b.cell] * 0.35 + cy[q] * 0.65, s, r: s * 2.4 });
        break;
      }
    }
    icons.sort((a, b) => a.y - b.y);
  }
  // state label anchors (pole of inaccessibility on the cell graph)
  {
    const d = new Int32Array(n).fill(-1); const q = [];
    for (let c = 0; c < n; c++) {
      if (type[c] !== 0) continue;
      let edge = false; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o < 0 || type[o] !== 0 || state[o] !== state[c]) { edge = true; break; } }
      if (edge) { d[c] = 0; q.push(c); }
    }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && type[o] === 0 && d[o] < 0 && state[o] === state[c]) { d[o] = d[c] + 1; q.push(o); } } }
    const best = states.map(() => -1); const bd = states.map(() => -1);
    for (let c = 0; c < n; c++) if (type[c] === 0 && state[c] >= 0 && d[c] > bd[state[c]]) { bd[state[c]] = d[c]; best[state[c]] = c; }
    states.forEach((s, i) => { const c = best[i] >= 0 ? best[i] : s.cell; s.lx = cx[c]; s.ly = cy[c]; s.depth = Math.max(1, bd[i]); });
  }
  // sea labels: open-water points far from land, spread apart
  const seas = [];
  {
    const d = new Int32Array(n).fill(-1); const q = [];
    for (let c = 0; c < n; c++) if (type[c] !== 1) { d[c] = 0; q.push(c); }
    for (let qi = 0; qi < q.length; qi++) { const c = q[qi]; for (let k = nOff[c]; k < nOff[c + 1]; k++) { const o = nbr[k]; if (o >= 0 && d[o] < 0) { d[o] = d[c] + 1; q.push(o); } } }
    const cand = [];
    for (let c = 0; c < n; c++) {
      if (type[c] !== 1 || d[c] < 3) continue;
      const e = Math.min(cx[c] - W * 0.08, W * 0.92 - cx[c], cy[c] - H * 0.1, H * 0.84 - cy[c]); if (e < 0) continue;
      cand.push(c);
    }
    cand.sort((a, b) => d[b] - d[a]);
    for (const c of cand) {
      if (seas.length >= 3) break;
      if (seas.some(s => Math.hypot(s.x - cx[c], s.y - cy[c]) < W * 0.28)) continue;
      let cu = 0, best = Infinity; for (const b of burgs) { const dd = (b.x - cx[c]) ** 2 + (b.y - cy[c]) ** 2; if (dd < best) { best = dd; cu = Math.max(0, b.culture); } }
      seas.push({ x: cx[c], y: cy[c], name: (seas.length === 0 ? 'Море ' : rand() < 0.5 ? 'Море ' : 'Воды ') + namer(cultures[cu] ? cultures[cu].lang : 'imp', 10) });
    }
  }
  const pickLang = LANG_KEYS[(rand() * LANG_KEYS.length) | 0];
  const name = namer(cultures.length ? cultures[(rand() * cultures.length) | 0].lang : pickLang, 10);
  T.geometry = now() - t; T.total = now() - t00;

  return {
    ...M, seed, params: { seed, cells: N, land: landFrac, rough, states: nStates, towns: nTowns, rivers: riverFrac, km: mapKm, climate, shape },
    kmPerUnit, cellAreaKm, h, type, biome, temp, moist, flux, shade, riverThr, state, culture,
    burgs, states, cultures, rivers, roads, coast, lakes, borders, icons, seas, folk, peoples, name, timings: T,
    landCells: landCells.length
  };
}

const API = { generate, cellAt, loops, chain, BIOMES, LANGS, RACES, hashStr };
if (IS_WORKER) {
  self.onmessage = (e) => {
    try {
      const map = generate(e.data);
      const tr = []; for (const k of ['cx', 'cy', 'vx', 'vy', 'nOff', 'nbr', 'ev1', 'ev2', 'h', 'type', 'biome', 'temp', 'moist', 'flux', 'shade', 'state', 'culture', 'folk']) tr.push(map[k].buffer);
      self.postMessage({ ok: true, map }, tr);
    } catch (err) { self.postMessage({ ok: false, error: String(err && err.stack || err) }); }
  };
} else root.FMG = API;
})(typeof self !== 'undefined' ? self : this);
