/* Canvas renderer: pre-builds layers (bitmaps + Path2D) once per map, then every frame is ~40 draw calls. */
(function () {
'use strict';
const SEA_BG = '#8fb0c1';
const hexRgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = c => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
function cellPath(ctx, m, c) {
  let k = m.nOff[c]; const e = m.nOff[c + 1]; let v = m.ev1[k];
  ctx.moveTo(m.vx[v], m.vy[v]);
  for (k++; k < e; k++) { v = m.ev1[k]; ctx.lineTo(m.vx[v], m.vy[v]); }
  ctx.closePath();
}
function smoothClosed(p, pts) {
  const n = pts.length / 2; if (n < 3) return;
  const mx = i => (pts[2 * (i % n)] + pts[2 * ((i + 1) % n)]) / 2, my = i => (pts[2 * (i % n) + 1] + pts[2 * ((i + 1) % n) + 1]) / 2;
  p.moveTo(mx(n - 1), my(n - 1));
  for (let i = 0; i < n; i++) p.quadraticCurveTo(pts[2 * i], pts[2 * i + 1], mx(i), my(i));
  p.closePath();
}
function smoothOpen(p, pts) {
  const n = pts.length / 2; if (n < 2) return;
  p.moveTo(pts[0], pts[1]);
  if (n === 2) { p.lineTo(pts[2], pts[3]); return; }
  for (let i = 1; i < n - 1; i++) p.quadraticCurveTo(pts[2 * i], pts[2 * i + 1], (pts[2 * i] + pts[2 * i + 2]) / 2, (pts[2 * i + 1] + pts[2 * i + 3]) / 2);
  p.lineTo(pts[2 * n - 2], pts[2 * n - 1]);
}

let paperPattern = null; const PATS = new WeakMap();
function paper(ctx) {
  if (!paperPattern) {
    const c = mkCanvas(256, 256), g = c.getContext('2d'); const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) { const v = 200 + Math.random() * 55; img.data[i] = v; img.data[i + 1] = v * 0.97; img.data[i + 2] = v * 0.9; img.data[i + 3] = 255; }
    g.putImageData(img, 0, 0); paperPattern = c;
  }
  return ctx.createPattern(paperPattern, 'repeat');
}

// ---------- one-time preparation per map ----------
function prepare(m) {
  const t0 = performance.now();
  const { n, W, H, type, biome, h, shade, state, nOff, nbr, spacing } = m;
  const B = FMG.BIOMES.map(b => hexRgb(b.color));
  const parchment = hexRgb('#eadfc3'), dark = hexRgb('#3b2f22'), white = [255, 252, 244], high = hexRgb('#d8ccb4');
  const landC = new Array(n), plainC = new Array(n), seaC = new Array(n);
  const shallow = hexRgb('#b9d4dc'), deep = hexRgb('#6a93aa');
  for (let c = 0; c < n; c++) {
    if (type[c] === 0) {
      let col = B[biome[c]];
      col = mix(col, high, smooth(0.45, 0.95, h[c]) * 0.55);
      col = mix(col, parchment, 0.16);
      let pl = mix(parchment, high, smooth(0.3, 0.9, h[c]) * 0.6);
      const s = shade[c];
      if (s > 0) { col = mix(col, white, s * 0.32); pl = mix(pl, white, s * 0.3); }
      else { col = mix(col, dark, -s * 0.42); pl = mix(pl, dark, -s * 0.38); }
      landC[c] = col; plainC[c] = pl;
    }
    const d = type[c] === 1 ? -h[c] : 0;
    seaC[c] = css(mix(shallow, deep, Math.pow(d, 0.75)));
  }
  // dilate land colour into neighbouring water cells so clipping by the smooth coast never shows gaps
  const dil = (arr) => {
    const out = new Array(n);
    for (let c = 0; c < n; c++) {
      if (arr[c]) { out[c] = css(arr[c]); continue; }
      let r = 0, g = 0, b = 0, k0 = 0;
      for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && arr[q]) { r += arr[q][0]; g += arr[q][1]; b += arr[q][2]; k0++; } }
      out[c] = k0 ? css([r / k0, g / k0, b / k0]) : null;
    }
    return out;
  };
  const landCss = dil(landC), plainCss = dil(plainC);
  const R = Math.min(1.6, 2600 / W);
  const blurOK = 'filter' in CanvasRenderingContext2D.prototype;
  const layer = (fillFn, blurPx) => {
    const c = mkCanvas(W * R, H * R), g = c.getContext('2d');
    g.setTransform(R, 0, 0, R, 0, 0); g.lineJoin = 'round'; g.lineWidth = 0.9 / R;
    fillFn(g);
    if (!blurOK || !blurPx) return c;
    const c2 = mkCanvas(c.width, c.height), g2 = c2.getContext('2d');
    g2.filter = `blur(${blurPx}px)`; g2.drawImage(c, 0, 0); return c2;
  };
  const fillCells = (g, colors) => {
    for (let c = 0; c < n; c++) { const col = colors[c]; if (!col) continue; g.fillStyle = col; g.strokeStyle = col; g.beginPath(); cellPath(g, m, c); g.fill(); g.stroke(); }
  };
  const P = {};
  P.ocean = layer(g => fillCells(g, seaC), spacing * R * 0.9);
  P.land = layer(g => fillCells(g, landCss), spacing * R * 0.38);
  P.plain = layer(g => fillCells(g, plainCss), spacing * R * 0.38);
  P.R = R;
  P.buildStates = () => {
    const sc = m.states.map(s => s.color); const cols = new Array(n);
    for (let c = 0; c < n; c++) {
      if (state[c] < 0) continue;
      if (type[c] === 0 || type[c] === 2) { cols[c] = sc[state[c]]; continue; }
      for (let k = nOff[c]; k < nOff[c + 1]; k++) { const q = nbr[k]; if (q >= 0 && type[q] !== 1) { cols[c] = sc[state[q]]; break; } }
    }
    P.states = layer(g => fillCells(g, cols), 1);
  };
  P.buildStates();

  // vector paths (map units)
  P.coast = new Path2D(); for (const l of m.coast) smoothClosed(P.coast, l);
  P.oceanClip = new Path2D(); P.oceanClip.rect(-W, -H, W * 3, H * 3); P.oceanClip.addPath(P.coast);
  P.lakes = new Path2D(); for (const l of m.lakes) smoothClosed(P.lakes, l);
  P.borders = new Path2D(); for (const l of m.borders) smoothOpen(P.borders, l);
  P.roads = [null, new Path2D(), new Path2D(), new Path2D()];
  for (const r of m.roads) smoothOpen(P.roads[r.level], r.pts);
  // rivers: bucket pieces by width
  const bw = spacing * 0.02; const buckets = new Map();
  for (const r of m.rivers) {
    const p = r.pts, w = r.ws, cnt = p.length / 2;
    let sx = p[0], sy = p[1];
    for (let i = 1; i < cnt; i++) {
      const last = i === cnt - 1;
      const ex = last ? p[2 * i] : (p[2 * i] + p[2 * i + 2]) / 2, ey = last ? p[2 * i + 1] : (p[2 * i + 1] + p[2 * i + 3]) / 2;
      const b = Math.max(1, Math.round(w[i] / bw)); let path = buckets.get(b); if (!path) buckets.set(b, path = new Path2D());
      path.moveTo(sx, sy);
      if (last) path.lineTo(ex, ey); else path.quadraticCurveTo(p[2 * i], p[2 * i + 1], ex, ey);
      sx = ex; sy = ey;
    }
  }
  P.rivers = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, path]) => ({ w: b * bw, path }));
  // relief icons
  const I = { mLight: new Path2D(), mShade: new Path2D(), mLine: new Path2D(), snow: new Path2D(), hFill: new Path2D(), hLine: new Path2D(),
    tFill: new Path2D(), tLine: new Path2D(), cFill: new Path2D(), cLine: new Path2D(), pLine: new Path2D(), pFill: new Path2D(), sLine: new Path2D(), dLine: new Path2D() };
  for (const ic of m.icons) {
    const { x, y, s } = ic;
    switch (ic.t) {
      case 'm': case 'M': {
        const px = x - s * 0.08, py = y - s * 1.25;
        I.mLight.moveTo(x - s, y); I.mLight.lineTo(px, py); I.mLight.lineTo(x + s * 0.12, y); I.mLight.closePath();
        I.mShade.moveTo(px, py); I.mShade.lineTo(x + s, y); I.mShade.lineTo(x + s * 0.12, y); I.mShade.closePath();
        I.mLine.moveTo(x - s, y); I.mLine.lineTo(px, py); I.mLine.lineTo(x + s, y);
        I.mLine.moveTo(px, py); I.mLine.lineTo(px + s * 0.12, py + s * 0.45); I.mLine.lineTo(x + s * 0.05, y - s * 0.35);
        if (ic.t === 'M') { I.snow.moveTo(px, py); I.snow.lineTo(px - s * 0.32, py + s * 0.4); I.snow.lineTo(px - s * 0.1, py + s * 0.3); I.snow.lineTo(px + s * 0.05, py + s * 0.45); I.snow.lineTo(px + s * 0.3, py + s * 0.38); I.snow.closePath(); }
        break;
      }
      case 'h':
        I.hFill.moveTo(x - s, y); I.hFill.quadraticCurveTo(x, y - s * 1.1, x + s, y); I.hFill.closePath();
        I.hLine.moveTo(x - s, y); I.hLine.quadraticCurveTo(x, y - s * 1.1, x + s, y);
        break;
      case 't':
        I.tLine.moveTo(x, y); I.tLine.lineTo(x, y - s * 0.7);
        I.tFill.moveTo(x + s * 0.62, y - s * 1.15); I.tFill.arc(x, y - s * 1.15, s * 0.62, 0, Math.PI * 2);
        break;
      case 'c':
        I.cFill.moveTo(x, y - s * 2); I.cFill.lineTo(x + s * 0.55, y - s * 0.25); I.cFill.lineTo(x - s * 0.55, y - s * 0.25); I.cFill.closePath();
        I.cLine.moveTo(x, y); I.cLine.lineTo(x, y - s * 0.3);
        break;
      case 'p':
        I.pLine.moveTo(x, y); I.pLine.quadraticCurveTo(x + s * 0.25, y - s * 0.8, x + s * 0.1, y - s * 1.6);
        for (const a of [-2.6, -1.9, -1.2, -0.5]) { I.pLine.moveTo(x + s * 0.1, y - s * 1.6); I.pLine.quadraticCurveTo(x + s * 0.1 + Math.cos(a) * s * 0.5, y - s * 1.6 + Math.sin(a) * s * 0.5 - s * 0.1, x + s * 0.1 + Math.cos(a) * s * 0.8, y - s * 1.6 + Math.sin(a) * s * 0.3 + s * 0.25); }
        break;
      case 's':
        I.sLine.moveTo(x - s * 0.8, y); I.sLine.lineTo(x + s * 0.8, y);
        for (const dx of [-0.45, 0, 0.45]) { I.sLine.moveTo(x + dx * s, y - s * 0.1); I.sLine.lineTo(x + dx * s * 1.3, y - s * (dx ? 0.6 : 0.85)); }
        break;
      case 'd':
        I.dLine.moveTo(x - s, y); I.dLine.quadraticCurveTo(x - s * 0.2, y - s * 0.7, x + s * 0.4, y - s * 0.1);
        I.dLine.moveTo(x - s * 0.1, y + s * 0.35); I.dLine.quadraticCurveTo(x + s * 0.5, y - s * 0.2, x + s * 1.1, y + s * 0.3);
        break;
    }
  }
  P.icons = I;
  // glaciers and deserts stay readable above the political tint
  P.ice = new Path2D(); P.sand = new Path2D();
  for (const l of FMG.loops(m, c => type[c] === 0 && biome[c] === 11)) smoothClosed(P.ice, l);
  for (const l of FMG.loops(m, c => type[c] === 0 && biome[c] === 1)) smoothClosed(P.sand, l);
  // race habitat areas
  P.folk = [];
  if (m.peoples) for (const pp of m.peoples) {
    if (pp.absent) continue; const path = new Path2D(); const id = pp.id, fk = m.folk;
    for (const l of FMG.loops(m, c => fk[c] === id)) smoothClosed(path, l);
    P.folk.push({ pp, path });
  }
  // horizontal room for each state label (map units)
  for (const s of m.states) {
    const sid = s.id; let l = 0, r = 0; const st = spacing * 0.5;
    while (l < W && (() => { const c = FMG.cellAt(m, s.lx - l - st, s.ly); return type[c] === 0 && state[c] === sid; })()) l += st;
    while (r < W && (() => { const c = FMG.cellAt(m, s.lx + r + st, s.ly); return type[c] === 0 && state[c] === sid; })()) r += st;
    s.lw = Math.max(spacing * 2, Math.min(l, r) * 2 + spacing);
  }
  P.hex = null; P.hexKm = 0; P.sel = null; P.selId = -1;
  P.time = performance.now() - t0;
  m._p = P;
  return P;
}

function hexPath(m, km) {
  const r = km / m.kmPerUnit / Math.sqrt(3); // circumradius for flat-to-flat = km
  const w = Math.sqrt(3) * r, vstep = 1.5 * r; const p = new Path2D();
  for (let row = 0, y = 0; y < m.H + r; row++, y += vstep) {
    const off = row % 2 ? w / 2 : 0;
    for (let x = off; x < m.W + w; x += w) {
      // pointy-top hex: draw 3 edges (top-left, top-right, right) + left on first column
      const pt = i => { const a = Math.PI / 180 * (60 * i - 90); return [x + r * Math.cos(a), y + r * Math.sin(a)]; };
      const v = [0, 1, 2, 3, 4, 5].map(pt);
      p.moveTo(v[4][0], v[4][1]); p.lineTo(v[5][0], v[5][1]); p.lineTo(v[0][0], v[0][1]); p.lineTo(v[1][0], v[1][1]); p.lineTo(v[2][0], v[2][1]);
      if (x - w < 0) { p.moveTo(v[2][0], v[2][1]); p.lineTo(v[3][0], v[3][1]); p.lineTo(v[4][0], v[4][1]); }
    }
  }
  return p;
}

// ---------- frame ----------
// V = {scale (css px per unit), x, y (map coords of top-left), dpr, w, h (css px), fit}
function render(ctx, m, V, O) {
  const P = m._p, L = O.layers; const { W, H, spacing } = m;
  const k = V.scale * V.dpr, u = 1 / V.scale;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = SEA_BG; ctx.fillRect(0, 0, V.w * V.dpr, V.h * V.dpr);
  ctx.setTransform(k, 0, 0, k, -V.x * k, -V.y * k);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.drawImage(P.ocean, 0, 0, W, H);
  if (L.waves) {
    ctx.save(); ctx.clip(P.oceanClip, 'evenodd');
    // two thin "contour" rings like on old sea charts
    let pat = PATS.get(ctx);
    if (!pat || pat.P !== P) { pat = { P, p: ctx.createPattern(P.ocean, 'no-repeat') }; pat.p.setTransform(new DOMMatrix([1 / P.R, 0, 0, 1 / P.R, 0, 0])); PATS.set(ctx, pat); }
    P.oceanPat = pat.p;
    const r1 = Math.max(3.5 * u, spacing * 0.45), r2 = r1 * 2.3;
    for (const r of [r2, r1]) {
      ctx.strokeStyle = 'rgba(60,90,105,0.38)'; ctx.lineWidth = 2 * r + 1.1 * u; ctx.stroke(P.coast);
      ctx.strokeStyle = P.oceanPat; ctx.lineWidth = 2 * r; ctx.stroke(P.coast);
      ctx.strokeStyle = 'rgba(215,232,236,0.22)'; ctx.stroke(P.coast);
    }
    ctx.restore();
  }
  ctx.save(); ctx.clip(P.coast);
  ctx.drawImage(L.biomes ? P.land : P.plain, 0, 0, W, H);
  if (L.states) { ctx.globalAlpha = L.biomes ? 0.32 : 0.45; ctx.drawImage(P.states, 0, 0, W, H); ctx.globalAlpha = 1; }
  if (L.biomes && P.ice) {
    const u0 = 1 / V.scale;
    ctx.fillStyle = 'rgba(250,253,255,0.72)'; ctx.fill(P.ice);
    ctx.strokeStyle = 'rgba(120,160,190,0.75)'; ctx.lineWidth = 1.1 * u0; ctx.stroke(P.ice);
    ctx.fillStyle = 'rgba(242,208,128,0.78)'; ctx.fill(P.sand);
    ctx.strokeStyle = 'rgba(176,124,48,0.7)'; ctx.lineWidth = 1 * u0; ctx.stroke(P.sand);
    ctx.save(); ctx.clip(P.sand);
    if (!P.sandPat) { const pc = mkCanvas(28, 22), g = pc.getContext('2d'); g.strokeStyle = 'rgba(160,108,40,0.7)'; g.lineWidth = 1.1;
      for (const [a, b] of [[4, 6], [18, 15]]) { g.beginPath(); g.moveTo(a, b + 2); g.quadraticCurveTo(a + 4, b - 3, a + 9, b + 2); g.stroke(); }
      g.fillStyle = 'rgba(150,100,40,0.6)'; for (const [a, b] of [[20, 4], [8, 17], [25, 20]]) { g.beginPath(); g.arc(a, b, 0.8, 0, 7); g.fill(); } P.sandPat = ctx.createPattern(pc, 'repeat'); }
    ctx.fillStyle = P.sandPat; ctx.fill(P.sand); ctx.restore();
    if (!P.icePat) { const pc = mkCanvas(16, 16), g = pc.getContext('2d'); g.strokeStyle = 'rgba(110,150,185,0.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 16); g.lineTo(16, 0); g.stroke(); P.icePat = ctx.createPattern(pc, 'repeat'); }
    ctx.save(); ctx.clip(P.ice); ctx.fillStyle = P.icePat; ctx.fill(P.ice); ctx.restore();
  }
  ctx.restore();
  // lakes
  ctx.fillStyle = '#a6c8d5'; ctx.fill(P.lakes);
  ctx.strokeStyle = '#5f8293'; ctx.lineWidth = 0.8 * u; ctx.stroke(P.lakes);
  // rivers
  if (L.rivers) {
    ctx.strokeStyle = '#5a8cad';
    for (const r of P.rivers) { ctx.lineWidth = Math.max(r.w, 0.6 * u); ctx.stroke(r.path); }
  }
  // relief
  if (L.relief) {
    const I = P.icons; const lw = Math.max(0.45 * u, Math.min(spacing * 0.06, 1.1 * u));
    ctx.lineWidth = lw;
    ctx.fillStyle = 'rgba(214,201,170,0.9)'; ctx.fill(I.hFill); ctx.strokeStyle = '#6b5a43'; ctx.stroke(I.hLine);
    ctx.fillStyle = '#efe6d2'; ctx.fill(I.mLight); ctx.fillStyle = '#b3a283'; ctx.fill(I.mShade);
    ctx.fillStyle = '#ffffff'; ctx.fill(I.snow); ctx.strokeStyle = '#4e3f2e'; ctx.stroke(I.mLine);
    ctx.strokeStyle = '#4b5e3c'; ctx.stroke(I.tLine); ctx.fillStyle = '#7f9f62'; ctx.fill(I.tFill); ctx.stroke(I.tFill);
    ctx.fillStyle = '#5c7a54'; ctx.fill(I.cFill); ctx.strokeStyle = '#33472f'; ctx.stroke(I.cFill); ctx.stroke(I.cLine);
    ctx.strokeStyle = '#4f6b3c'; ctx.stroke(I.pLine);
    ctx.strokeStyle = '#5c7a6a'; ctx.stroke(I.sLine);
    ctx.strokeStyle = '#a88d5a'; ctx.stroke(I.dLine);
  }
  // coast line
  ctx.strokeStyle = '#46565b'; ctx.lineWidth = 1.1 * u; ctx.stroke(P.coast);
  // hex grid
  if (L.hex) {
    if (!P.hex || P.hexKm !== O.hexKm) { P.hex = hexPath(m, O.hexKm); P.hexKm = O.hexKm; }
    ctx.strokeStyle = 'rgba(70,45,25,0.28)'; ctx.lineWidth = 0.7 * u; ctx.stroke(P.hex);
  }
  // borders
  if (L.borders) {
    ctx.strokeStyle = 'rgba(120,40,90,0.22)'; ctx.lineWidth = 5 * u; ctx.stroke(P.borders);
    ctx.setLineDash([8 * u, 3 * u, 1.5 * u, 3 * u]);
    ctx.strokeStyle = 'rgba(105,30,75,0.9)'; ctx.lineWidth = 1.6 * u; ctx.stroke(P.borders);
    ctx.setLineDash([]);
  }
  // race habitats
  if (L.folk && P.folk.length) {
    for (const { pp, path } of P.folk) {
      ctx.globalAlpha = pp.under ? 0.1 : 0.14; ctx.fillStyle = pp.color; ctx.fill(path); ctx.globalAlpha = 1;
      ctx.setLineDash(pp.under ? [5 * u, 2 * u, 1 * u, 2 * u] : [1.6 * u, 2.6 * u]);
      ctx.strokeStyle = pp.color; ctx.lineWidth = 1.5 * u; ctx.stroke(path);
    }
    ctx.setLineDash([]);
  }
  // roads
  if (L.roads) {
    ctx.strokeStyle = 'rgba(250,240,215,0.7)'; ctx.lineWidth = 3.2 * u; ctx.stroke(P.roads[1]);
    ctx.strokeStyle = '#7b4a22';
    ctx.lineWidth = 1.6 * u; ctx.stroke(P.roads[1]);
    ctx.lineWidth = 1.15 * u; ctx.setLineDash([4 * u, 2 * u]); ctx.stroke(P.roads[2]);
    if (V.scale >= V.fit * 1.2) { ctx.globalAlpha = 0.85; ctx.lineWidth = 0.9 * u; ctx.setLineDash([1.2 * u, 2.4 * u]); ctx.stroke(P.roads[3]); ctx.globalAlpha = 1; }
    ctx.setLineDash([]);
  }
  // frame
  ctx.strokeStyle = '#3d2f22'; ctx.lineWidth = 2 * u; ctx.strokeRect(0, 0, W, H);
  ctx.lineWidth = 0.8 * u; ctx.strokeRect(5 * u, 5 * u, W - 10 * u, H - 10 * u);

  // ---- screen-space: burgs & labels ----
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  const sx = mx => (mx - V.x) * V.scale, sy = my => (my - V.y) * V.scale;
  const zf = clamp(Math.pow(V.scale / V.fit, 0.22), 1, 1.7);
  const boxes = []; const hit = b => { for (const o of boxes) if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true; return false; };
  const onScreen = (x, y, pad) => x > -pad && y > -pad && x < V.w + pad && y < V.h + pad;
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const halo = (txt, x, y, col, hw) => { ctx.strokeStyle = 'rgba(244,236,214,0.9)'; ctx.lineWidth = hw || 3; ctx.strokeText(txt, x, y); ctx.fillStyle = col; ctx.fillText(txt, x, y); };
  const hasLS = 'letterSpacing' in ctx; const LS = v => { if (hasLS) ctx.letterSpacing = v.toFixed(1) + 'px'; };
  const z = V.scale / V.fit;
  const tier = b => b.capital ? 0 : b.pop >= 10 ? 1 : b.pop >= 3 ? 2 : 3; // столица, город, городок, деревня
  const R_ = [7, 5, 3.2, 2.3];
  const FS = [15, 13.5, 12, 10.5];
  const FONT = ['700 {s}px "Cormorant SC", Georgia, serif', '700 {s}px "Cormorant Garamond", Georgia, serif', '600 {s}px "Cormorant Garamond", Georgia, serif', 'italic 500 {s}px "Cormorant Garamond", Georgia, serif'];
  const COL = ['#7a1414', '#22160c', '#33241a', '#4a3a2c'];
  const font = (t, s) => FONT[t].replace('{s}', s.toFixed(1));
  const iconVis = t => t <= 2 || (t === 3 && z >= 0.75);
  const labelVis = t => t <= 1 || (t === 2 && z >= 1.25) || (t === 3 && z >= 2);
  const star = (x, y, r) => { ctx.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); };
  // 1. settlement icons (reserve space)
  const vis = [];
  if (L.burgs) {
    for (const b of (O.sortedBurgs || m.burgs)) {
      const t = tier(b); if (!iconVis(t)) continue;
      const x = sx(b.x), y = sy(b.y); if (!onScreen(x, y, 60)) continue;
      const r = R_[t]; const box = { x: x - r - 1, y: y - r - 1, w: 2 * r + 2, h: 2 * r + 2 };
      if (t >= 2 && hit(box)) continue;
      vis.push([b, x, y, r, t]); boxes.push(box);
    }
    for (const [b, x, y, r, t] of vis) {
      if (t === 0) {
        ctx.beginPath(); ctx.arc(x, y, r + 2.2, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,248,230,0.95)'; ctx.fill(); ctx.strokeStyle = '#2e2218'; ctx.lineWidth = 1.2; ctx.stroke();
        star(x, y, r); ctx.fillStyle = '#a31b1b'; ctx.fill(); ctx.strokeStyle = '#4a0e0e'; ctx.lineWidth = 0.8; ctx.stroke();
      } else if (t === 1) { // city: square fortress with dark core
        ctx.fillStyle = '#fff8e8'; ctx.strokeStyle = '#2a1d12'; ctx.lineWidth = 1.6;
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r); ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
        ctx.fillStyle = '#2a1d12'; ctx.fillRect(x - r * 0.45, y - r * 0.45, r * 0.9, r * 0.9);
      } else if (t === 2) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#fff8e8'; ctx.fill(); ctx.strokeStyle = '#2a1d12'; ctx.lineWidth = 1.2; ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = '#3a2a1c'; ctx.fill(); ctx.strokeStyle = 'rgba(255,248,232,0.95)'; ctx.lineWidth = 1.1; ctx.stroke();
      }
      if (b.port && z >= 2.2 && t > 0) { ctx.fillStyle = '#2f5f80'; ctx.fillRect(x + r - 0.5, y + r - 0.5, 2.6, 2.6); }
    }
  }
  const placeBurgLabel = (b, x, y, r, t, force) => {
    const fs = FS[t] * zf; ctx.font = font(t, fs); LS(t === 0 ? 0.6 : 0);
    const tw = ctx.measureText(b.name).width, th = fs * 0.95;
    const cand = [[x + r + 4, y, 'left'], [x - r - 4, y, 'right'], [x, y - r - th * 0.7, 'center'], [x, y + r + th * 0.7, 'center'], [x + r + 3, y - th * 0.55, 'left'], [x + r + 3, y + th * 0.55, 'left']];
    for (let i = 0; i < cand.length; i++) {
      const [lx, ly, al] = cand[i]; const bx = al === 'left' ? lx : al === 'right' ? lx - tw : lx - tw / 2;
      const box = { x: bx - 2, y: ly - th / 2, w: tw + 4, h: th };
      if (hit(box) && !(force && i === cand.length - 1)) continue;
      boxes.push(box); ctx.textAlign = al; halo(b.name, lx, ly, COL[t], t === 0 ? 3.6 : 3); LS(0); return true;
    }
    LS(0); return false;
  };
  // 2. capitals and cities labels (highest priority)
  if (L.burgs && L.labels) for (const v of vis) if (v[4] <= 1) placeBurgLabel(v[0], v[1], v[2], v[3], v[4], v[4] === 0);
  // 3. state names: fitted into the state's width, shrunk or dropped instead of overlapping
  if (L.labels) {
    ctx.textAlign = 'center';
    const order = m.states.slice().sort((a, b) => b.cells - a.cells);
    for (const s of order) {
      const x = sx(s.lx), y = sy(s.ly); if (!onScreen(x, y, 300)) continue;
      let size = clamp(Math.sqrt(s.cells) * spacing * V.scale * 0.1, 10, 44);
      const room = s.lw * V.scale * 0.92; const nm = s.name.toUpperCase(), fm = s.form.toUpperCase();
      ctx.font = `700 ${size.toFixed(1)}px "Cormorant SC", Georgia, serif`; LS(size * 0.12);
      let tw = ctx.measureText(nm).width; if (tw > room) { size = Math.max(9, size * room / tw); ctx.font = `700 ${size.toFixed(1)}px "Cormorant SC", Georgia, serif`; LS(size * 0.12); tw = ctx.measureText(nm).width; }
      let placed = false;
      for (const dy of [0, -size * 1.3, size * 1.3, -size * 2.4, size * 2.4]) {
        for (const withForm of [true, false]) {
          const fsz = size * 0.5; ctx.font = `600 ${fsz.toFixed(1)}px "Cormorant SC", Georgia, serif`; LS(fsz * 0.14);
          const fw = withForm ? ctx.measureText(fm).width : 0;
          const top = y + dy - (withForm ? size * 0.62 + fsz * 0.55 : size * 0.5) + size * 0.12;
          const bw = Math.max(tw, fw); const box = { x: x - bw / 2 - 2, y: top, w: bw + 4, h: (y + dy + size * 0.12 + size * 0.5) - top };
          if (hit(box)) continue;
          boxes.push(box); ctx.globalAlpha = 0.86;
          if (withForm) halo(fm, x, y + dy - size * 0.62, 'rgba(70,40,28,0.9)', 2.5);
          ctx.font = `700 ${size.toFixed(1)}px "Cormorant SC", Georgia, serif`; LS(size * 0.12);
          halo(nm, x, y + dy + size * 0.12, 'rgba(70,40,28,0.85)', 3);
          ctx.globalAlpha = 1; placed = true; break;
        }
        if (placed) break;
      }
      LS(0);
    }
    // sea names
    const ss = clamp(15 * zf, 13, 22);
    ctx.font = `italic 600 ${ss.toFixed(1)}px "Cormorant Garamond", Georgia, serif`; LS(ss * 0.35);
    for (const s of m.seas || []) {
      const x = sx(s.x), y = sy(s.y); if (!onScreen(x, y, 200)) continue;
      const tw = ctx.measureText(s.name).width; const box = { x: x - tw / 2, y: y - ss / 2, w: tw, h: ss }; if (hit(box)) continue; boxes.push(box);
      ctx.fillStyle = 'rgba(35,70,95,0.62)'; ctx.fillText(s.name, x, y);
    }
    LS(0);
  }
  // 4. race habitats
  if (L.labels && L.folk && P.folk.length && z >= 0.95) {
    const fs = clamp(11.5 * zf, 11, 16); ctx.textAlign = 'center';
    for (const { pp } of P.folk) {
      const x = sx(pp.lx), y = sy(pp.ly); if (!onScreen(x, y, 100)) continue;
      ctx.font = `italic 700 ${fs.toFixed(1)}px "Cormorant Garamond", Georgia, serif`; LS(0.5);
      const txt = pp.under ? pp.name + ' (Подземье)' : pp.name; const tw = ctx.measureText(txt).width;
      let ok = false;
      for (const dy of [0, -fs * 1.2, fs * 1.2, -fs * 2.4, fs * 2.4]) { const box = { x: x - tw / 2 - 2, y: y + dy - fs * 0.55, w: tw + 4, h: fs * 1.1 }; if (hit(box)) continue; boxes.push(box); halo(txt, x, y + dy, pp.color, 3); ok = true; break; }
      void ok; LS(0);
    }
  }
  // 5. towns & villages labels
  if (L.burgs && L.labels) for (const v of vis) if (v[4] >= 2 && labelVis(v[4])) placeBurgLabel(v[0], v[1], v[2], v[3], v[4], false);
  // 6. rivers
  if (L.labels && L.rivers && z >= 1.35) {
    const fs = 11.5 * zf; ctx.font = `italic 600 ${fs.toFixed(1)}px "Cormorant Garamond", Georgia, serif`; ctx.textAlign = 'center';
    for (const r of m.rivers) {
      if (!r.name) continue; const p = r.pts; const i = Math.max(2, Math.floor(p.length / 4) * 2);
      const x = sx(p[i]), y = sy(p[i + 1]); if (!onScreen(x, y, 50)) continue;
      let a = Math.atan2(p[i + 3] - p[i - 1], p[i + 2] - p[i - 2]); if (a > Math.PI / 2) a -= Math.PI; if (a < -Math.PI / 2) a += Math.PI;
      const txt = 'р. ' + r.name, tw = ctx.measureText(txt).width;
      const ox = Math.sin(a) * 7, oy = -Math.cos(a) * 7; const bw = Math.abs(Math.cos(a)) * tw + fs, bh = Math.abs(Math.sin(a)) * tw + fs;
      const box = { x: x + ox - bw / 2, y: y + oy - bh / 2, w: bw, h: bh }; if (hit(box)) continue; boxes.push(box);
      ctx.save(); ctx.translate(x, y); ctx.rotate(a); halo(txt, 0, -7, '#2f5f80', 2.5); ctx.restore();
    }
  }
  ctx.restore();
}

// overlays drawn every frame on top of cached frames (cheap)
function overlay(ctx, m, V, O) {
  const k = V.scale * V.dpr, u = 1 / V.scale;
  ctx.save(); ctx.setTransform(k, 0, 0, k, -V.x * k, -V.y * k); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const P = m._p;
  if (O.selState != null && O.selState >= 0) {
    if (P.selId !== O.selState) {
      P.sel = new Path2D(); const st = m.state, ty = m.type;
      for (const l of FMG.loops(m, c => ty[c] !== 1 && st[c] === O.selState)) smoothClosed(P.sel, l);
      P.selId = O.selState;
    }
    ctx.fillStyle = 'rgba(255,240,200,0.18)'; ctx.fill(P.sel);
    ctx.strokeStyle = 'rgba(150,25,25,0.9)'; ctx.lineWidth = 2.6 * u; ctx.stroke(P.sel);
  }
  if (O.selBurg) {
    const b = O.selBurg; ctx.strokeStyle = '#b3261e'; ctx.lineWidth = 2 * u;
    ctx.beginPath(); ctx.arc(b.x, b.y, 10 * u, 0, Math.PI * 2); ctx.stroke();
  }
  if (O.ruler && O.ruler.length) {
    const r = O.ruler;
    ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 3.5 * u; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(r[0][0], r[0][1]); for (const p of r) ctx.lineTo(p[0], p[1]); ctx.stroke();
    ctx.strokeStyle = '#ffd966'; ctx.lineWidth = 1.6 * u; ctx.setLineDash([6 * u, 4 * u]); ctx.stroke(); ctx.setLineDash([]);
    for (const p of r) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 * u, 0, Math.PI * 2); ctx.fillStyle = '#ffd966'; ctx.fill(); ctx.strokeStyle = '#1d1d1d'; ctx.lineWidth = 1.2 * u; ctx.stroke(); }
  }
  ctx.restore();
}

// compass, scale bar, title, paper grain
function decor(ctx, m, V, O) {
  ctx.save(); ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  // paper grain + vignette
  ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.22; ctx.fillStyle = paper(ctx); ctx.fillRect(0, 0, V.w, V.h);
  ctx.globalAlpha = 1;
  const g = ctx.createRadialGradient(V.w / 2, V.h / 2, Math.min(V.w, V.h) * 0.45, V.w / 2, V.h / 2, Math.max(V.w, V.h) * 0.75);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(120,90,60,0.28)'); ctx.fillStyle = g; ctx.fillRect(0, 0, V.w, V.h);
  ctx.globalCompositeOperation = 'source-over';
  // scale bar
  const kmPerPx = m.kmPerUnit / V.scale; const target = 150 * kmPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(target))); let step = pow;
  for (const f of [1, 2, 2.5, 5, 10]) if (f * pow <= target) step = f * pow;
  const len = step / kmPerPx; const x0 = O.scaleX || 20, y0 = V.h - 28;
  ctx.fillStyle = 'rgba(244,236,214,0.85)'; ctx.fillRect(x0 - 10, y0 - 22, len + 20 + 90, 40);
  ctx.strokeStyle = '#3d2f22'; ctx.lineWidth = 1; ctx.strokeRect(x0 - 10, y0 - 22, len + 20 + 90, 40);
  for (let i = 0; i < 4; i++) { ctx.fillStyle = i % 2 ? '#f4ecd6' : '#3d2f22'; ctx.fillRect(x0 + len / 4 * i, y0, len / 4, 5); }
  ctx.strokeRect(x0, y0, len, 5);
  ctx.fillStyle = '#2a1d12'; ctx.font = '600 13px "Cormorant Garamond", Georgia, serif'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const days = step / 30;
  ctx.fillText(`${step} км`, x0, y0 - 6);
  ctx.fillText(`≈ ${days < 1 ? days.toFixed(1) : Math.round(days * 10) / 10} дн. пешком`, x0 + len + 8, y0 + 5);
  // compass
  const cxp = V.w - 62, cyp = V.h - 70, R = 34;
  ctx.translate(cxp, cyp);
  ctx.strokeStyle = '#3d2f22'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.78, 0, Math.PI * 2); ctx.fillStyle = 'rgba(244,236,214,0.75)'; ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, R * 0.7, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 - Math.PI / 2; const long = i % 2 === 0; const r1 = long ? R : R * 0.55, r2 = R * 0.14;
    const ax = Math.cos(a) * r1, ay = Math.sin(a) * r1, bx = Math.cos(a + Math.PI / 2) * r2, by = Math.sin(a + Math.PI / 2) * r2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(0, 0); ctx.closePath(); ctx.fillStyle = '#3d2f22'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(-bx, -by); ctx.lineTo(0, 0); ctx.closePath(); ctx.fillStyle = '#f4ecd6'; ctx.fill(); ctx.stroke();
  }
  ctx.font = '700 13px "Cormorant SC", Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#2a1d12';
  ctx.fillText('С', 0, -R - 9);
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  // legend
  if (O.layers && O.layers.legend) {
    const rows = [['cap', 'Столица'], ['city', 'Город'], ['town', 'Городок'], ['vil', 'Деревня'], ['road', 'Тракт / дорога'], ['border', 'Граница'], ['folk', 'Земли народа']];
    const lx = (O.scaleX || 20) - 10, lh = 17, bw = 132, bh = rows.length * lh + 30, ly = V.h - 58 - bh;
    ctx.fillStyle = 'rgba(244,236,214,0.88)'; ctx.fillRect(lx, ly, bw, bh); ctx.strokeStyle = '#3d2f22'; ctx.lineWidth = 1; ctx.strokeRect(lx, ly, bw, bh);
    ctx.font = '700 13px "Cormorant SC", Georgia, serif'; ctx.fillStyle = '#2a1d12'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('Обозначения', lx + 10, ly + 13);
    ctx.font = '600 13px "Cormorant Garamond", Georgia, serif';
    rows.forEach(([k, t], i) => {
      const y = ly + 32 + i * lh, x = lx + 20;
      ctx.lineWidth = 1.2; ctx.setLineDash([]);
      if (k === 'cap') { ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = '#fff8e6'; ctx.fill(); ctx.strokeStyle = '#2e2218'; ctx.stroke(); ctx.beginPath(); for (let j = 0; j < 10; j++) { const a = -Math.PI / 2 + j * Math.PI / 5, rr = j % 2 ? 2.3 : 5.2; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } ctx.closePath(); ctx.fillStyle = '#a31b1b'; ctx.fill(); }
      else if (k === 'city') { ctx.fillStyle = '#fff8e8'; ctx.strokeStyle = '#2a1d12'; ctx.lineWidth = 1.6; ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10); ctx.fillStyle = '#2a1d12'; ctx.fillRect(x - 2.2, y - 2.2, 4.5, 4.5); }
      else if (k === 'town') { ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fillStyle = '#fff8e8'; ctx.fill(); ctx.strokeStyle = '#2a1d12'; ctx.stroke(); }
      else if (k === 'vil') { ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI * 2); ctx.fillStyle = '#3a2a1c'; ctx.fill(); }
      else if (k === 'road') { ctx.strokeStyle = '#7b4a22'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(x - 9, y - 2); ctx.lineTo(x + 9, y - 2); ctx.stroke(); ctx.lineWidth = 1.1; ctx.setLineDash([4, 2]); ctx.beginPath(); ctx.moveTo(x - 9, y + 3); ctx.lineTo(x + 9, y + 3); ctx.stroke(); }
      else if (k === 'border') { ctx.strokeStyle = 'rgba(105,30,75,0.9)'; ctx.lineWidth = 1.6; ctx.setLineDash([8, 3, 1.5, 3]); ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.stroke(); }
      else if (k === 'folk') { ctx.fillStyle = 'rgba(47,107,50,0.18)'; ctx.fillRect(x - 9, y - 5, 18, 10); ctx.strokeStyle = '#2f6b32'; ctx.lineWidth = 1.4; ctx.setLineDash([1.6, 2.6]); ctx.strokeRect(x - 9, y - 5, 18, 10); }
      ctx.setLineDash([]); ctx.fillStyle = '#2a1d12'; ctx.fillText(t, lx + 38, y + 1);
    });
  }
  // title cartouche
  if (O.title) {
    const t = O.title; ctx.font = '700 30px "Cormorant SC", Georgia, serif'; if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
    const tw = ctx.measureText(t).width; const bx = V.w / 2, by = 34;
    ctx.fillStyle = 'rgba(244,236,214,0.9)'; ctx.strokeStyle = '#3d2f22'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx - tw / 2 - 34, by - 22); ctx.lineTo(bx + tw / 2 + 34, by - 22); ctx.lineTo(bx + tw / 2 + 22, by); ctx.lineTo(bx + tw / 2 + 34, by + 22); ctx.lineTo(bx - tw / 2 - 34, by + 22); ctx.lineTo(bx - tw / 2 - 22, by); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#2a1d12'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, bx, by + 1);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }
  ctx.restore();
}

window.FMGR = { prepare, render, overlay, decor, SEA_BG };
})();
