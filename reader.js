// reader.js: reads an end-of-match screenshot entirely on the device.
// Pure functions over pixel arrays. The only outside dependency is the `ocr`
// callback, which receives one clean run of digits at a time.
//
// Every threshold below is a fraction of the panel height (PH) or of the text
// line height, so the same numbers apply at any screenshot size. They were
// measured on two full-size sample screenshots and need re-measuring on real
// Community Edition screenshots.

export const READER_VERSION = 1;
export const MIN_WIDTH = 1200;

const T = {
  darkPixel: 45,        // max channel below this counts as "dark"
  bandDark: 0.85,       // row is part of a black band when this share is dark
  headerDark: 0.6,
  maskDelta: 14,        // text must beat the local background by this much...
  maskRatio: 1.25,      // ...and by this ratio
  blurRadius: 0.03,     // of PH: half-size of the local background window
  glyphMin: 0.022,      // of PH: shortest stat glyph
  glyphMax: 0.056,      // of PH: tallest stat glyph
  slashAspect: 0.55,
  slashLean: 0.22,
  slashFill: 0.55,
  digitGap: 0.3,        // of line height: widest gap inside one number
  tokenGap: 0.6,        // of line height: gap that separates two fields
  centreGap: 0.21,      // of PH: half-width of the portrait column
  targetLine: 60,       // px: line height after upscaling
  fadedRatio: 0.65,
};

/* ---------- pixel helpers ---------- */

function maxChannel(rgba, W, H) {
  const out = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    out[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  return out;
}

function integralOf(src, W, H) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  return I;
}

// Text mask: pixels clearly brighter than their surroundings.
function contrastMask(mx, W, H, y0, y1, radius) {
  const I = integralOf(mx, W, H);
  const mask = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) {
    const ya = Math.max(0, y - radius), yb = Math.min(H, y + radius + 1);
    for (let x = 0; x < W; x++) {
      const xa = Math.max(0, x - radius), xb = Math.min(W, x + radius + 1);
      const sum = I[yb * (W + 1) + xb] - I[ya * (W + 1) + xb] - I[yb * (W + 1) + xa] + I[ya * (W + 1) + xa];
      const bg = sum / ((yb - ya) * (xb - xa));
      const v = mx[y * W + x];
      if (v - bg > T.maskDelta && v > bg * T.maskRatio) mask[y * W + x] = 1;
    }
  }
  return mask;
}

// 8-connected components inside a rectangle of a binary mask.
function components(mask, W, x0, y0, x1, y1) {
  const w = x1 - x0, h = y1 - y0;
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      if (!mask[(sy + y0) * W + sx + x0] || labels[sy * w + sx]) continue;
      const id = comps.length + 1;
      const c = { x0: sx, y0: sy, x1: sx, y1: sy, area: 0, id };
      labels[sy * w + sx] = id;
      stack.push(sx, sy);
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop();
        c.area++;
        if (cx < c.x0) c.x0 = cx; if (cx > c.x1) c.x1 = cx;
        if (cy < c.y0) c.y0 = cy; if (cy > c.y1) c.y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            if (labels[ny * w + nx] || !mask[(ny + y0) * W + nx + x0]) continue;
            labels[ny * w + nx] = id;
            stack.push(nx, ny);
          }
        }
      }
      comps.push(c);
    }
  }
  for (const c of comps) {
    c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1;
    c.fill = c.area / (c.w * c.h);
    // lean: how far the top of the glyph sits to the right of its bottom
    const band = Math.max(1, Math.round(c.h * 0.3));
    let ts = 0, tn = 0, bs = 0, bn = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      const top = y < c.y0 + band, bot = y > c.y1 - band;
      if (!top && !bot) continue;
      for (let x = c.x0; x <= c.x1; x++) {
        if (labels[y * w + x] !== c.id) continue;
        if (top) { ts += x; tn++; } else { bs += x; bn++; }
      }
    }
    c.lean = tn && bn ? (ts / tn - bs / bn) / c.w : 0;
    c.x0 += x0; c.x1 += x0; c.y0 += y0; c.y1 += y0;
    c.cy = (c.y0 + c.y1) / 2;
  }
  return { comps, labels, w, h, ox: x0, oy: y0 };
}

function otsu(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// Crop a box, keep the brightest colour channel, upscale (bilinear) to `scale`.
function cropChannel(img, box, scale) {
  const { data, width: W, height: H } = img;
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(W, Math.ceil(box.x1)), y1 = Math.min(H, Math.ceil(box.y1));
  const w = x1 - x0, h = y1 - y0;
  const sums = [0, 0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const p = (y * W + x) * 4;
    sums[0] += data[p]; sums[1] += data[p + 1]; sums[2] += data[p + 2];
  }
  const ch = sums[0] >= sums[1] && sums[0] >= sums[2] ? 0 : (sums[1] >= sums[2] ? 1 : 2);
  const ow = Math.max(1, Math.round(w * scale)), oh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const fy = Math.min(h - 1, Math.max(0, (oy + 0.5) / scale - 0.5));
    const ya = Math.floor(fy), yb = Math.min(h - 1, ya + 1), ty = fy - ya;
    for (let ox = 0; ox < ow; ox++) {
      const fx = Math.min(w - 1, Math.max(0, (ox + 0.5) / scale - 0.5));
      const xa = Math.floor(fx), xb = Math.min(w - 1, xa + 1), tx = fx - xa;
      const a = data[((ya + y0) * W + xa + x0) * 4 + ch], b = data[((ya + y0) * W + xb + x0) * 4 + ch];
      const c = data[((yb + y0) * W + xa + x0) * 4 + ch], d = data[((yb + y0) * W + xb + x0) * 4 + ch];
      out[oy * ow + ox] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return { gray: out, w: ow, h: oh, channel: ch };
}

/* ---------- field reading ---------- */

// Upscale a field, threshold it, and split it into glyphs sorted left to right.
function fieldGlyphs(img, box, lineH) {
  const pad = lineH * 0.3;
  const scale = Math.min(8, Math.max(1, T.targetLine / lineH));
  const crop = cropChannel(img, { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad + 1, y1: box.y1 + pad + 1 }, scale);
  const thr = otsu(crop.gray);
  const bin = new Uint8Array(crop.gray.length);
  for (let i = 0; i < bin.length; i++) bin[i] = crop.gray[i] > thr ? 1 : 0;
  const cc = components(bin, crop.w, 0, 0, crop.w, crop.h);
  let glyphs = cc.comps.filter(c => c.area >= 12);
  const tall = glyphs.map(c => c.h).sort((a, b) => b - a);
  const LH = tall.length ? tall[Math.min(tall.length - 1, 1)] : T.targetLine;
  // drop specks that sit on the crop border (neighbouring artwork)
  glyphs = glyphs.filter(c => !(c.h < LH * 0.25 && (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= crop.w - 1 || c.y1 >= crop.h - 1)));
  glyphs.sort((a, b) => a.x0 - b.x0);
  for (const g of glyphs) {
    const aspect = g.w / g.h;
    if (g.h < LH * 0.4) g.kind = 'dot';
    else if (aspect < T.slashAspect && g.lean > T.slashLean && g.fill < T.slashFill) g.kind = 'slash';
    else if (g.fill > 0.72) g.kind = 'coin'; // filled ellipse; no digit is this solid
    else g.kind = 'glyph';
  }
  return { glyphs, cc, crop, LH, thr };
}

// Paint a run of glyphs as dark text on white, ready for the OCR engine.
function renderRun(field, run) {
  const m = 20;
  const x0 = Math.min(...run.map(g => g.x0)), x1 = Math.max(...run.map(g => g.x1));
  const y0 = Math.min(...run.map(g => g.y0)), y1 = Math.max(...run.map(g => g.y1));
  const w = x1 - x0 + 1 + 2 * m, h = y1 - y0 + 1 + 2 * m;
  const out = new Uint8Array(w * h).fill(255);
  const ids = new Set(run.map(g => g.id));
  const { labels, w: cw } = field.cc;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (ids.has(labels[y * cw + x])) out[(y - y0 + m) * w + (x - x0 + m)] = 0;
  }
  return { gray: out, w, h };
}

// Each glyph goes to the OCR engine on its own. Whole runs were tried first,
// but the engine reads "11" as "1"; one glyph per call cannot drop a digit.
async function readRun(field, run, ocr) {
  if (!run.length) return { text: '', conf: 0 };
  let text = '', conf = 100;
  for (const g of run) {
    const r = await ocr(renderRun(field, [g]), true);
    const d = (r.text || '').replace(/\D/g, '');
    if (d.length !== 1) { text += d.length ? d[0] : '?'; conf = 0; continue; }
    text += d; conf = Math.min(conf, r.confidence);
  }
  return { text, conf };
}

async function readKda(img, box, lineH, ocr) {
  const f = fieldGlyphs(img, box, lineH);
  const runs = [[]];
  for (const g of f.glyphs) {
    if (g.kind === 'slash') runs.push([]);
    else if (g.kind !== 'dot') runs[runs.length - 1].push(g);
  }
  if (runs.length !== 3 || runs.some(r => r.length < 1 || r.length > 3)) return { ok: false, raw: '' };
  const parts = [];
  for (const r of runs) parts.push(await readRun(f, r, ocr));
  const raw = parts.map(p => p.text).join('/');
  return { ok: /^\d{1,3}\/\d{1,3}\/\d{1,3}$/.test(raw), raw, k: parts[0].text, d: parts[1].text, a: parts[2].text, conf: Math.min(...parts.map(p => p.conf)) };
}

// Gold: [coin] digits . digit k
async function readGold(img, box, lineH, ocr) {
  const f = fieldGlyphs(img, box, lineH);
  let g = f.glyphs.slice();
  // the coin is a solid ellipse with an outline to its left: drop both
  let coin = -1;
  for (let i = 0; i < Math.min(3, g.length); i++) if (g[i].kind === 'coin') coin = i;
  if (coin >= 0) g = g.slice(coin + 1);
  const dot = g.findIndex(c => c.kind === 'dot');
  if (dot < 1 || g.length - dot < 3) return { ok: false, raw: '', debug: f };
  const whole = g.slice(0, dot).filter(c => c.kind !== 'dot');
  const frac = g.slice(dot + 1, g.length - 1).filter(c => c.kind !== 'dot'); // last glyph is the "k"
  const a = await readRun(f, whole, ocr), b = await readRun(f, frac, ocr);
  const raw = a.text + '.' + b.text + 'k';
  return { ok: /^\d{1,3}\.\dk$/.test(raw), raw, conf: Math.min(a.conf, b.conf), debug: f, stats: f.glyphs.map(c => [c.kind, +(c.w / c.h).toFixed(2), +c.fill.toFixed(2), +c.lean.toFixed(2), +(c.h / f.LH).toFixed(2)]) };
}

// Minion kills: [crosshair] digits
async function readMinions(img, box, lineH, ocr) {
  const f = fieldGlyphs(img, box, lineH);
  let g = f.glyphs.filter(c => c.kind !== 'dot');
  if (g.length >= 2) {
    const gap = g[1].x0 - g[0].x1;
    if (gap > 0.2 * f.LH) g = g.slice(1); // crosshair icon stands apart from the digits
  }
  const r = await readRun(f, g, ocr);
  return { ok: /^\d{1,4}$/.test(r.text), raw: r.text, conf: r.conf, debug: f };
}

// Whatever follows K/D/A on the line. Gold ends in "k"; the other two are an
// icon then digits: a hollow crosshair (minion kills) or a solid skull (points).
async function readExtra(img, box, lineH, ocr) {
  const f = fieldGlyphs(img, box, lineH);
  const tall = f.glyphs.filter(c => c.kind !== 'dot');
  const hasDot = f.glyphs.some((c, i) => c.kind === 'dot' && i > 0 && i < f.glyphs.length - 2);
  if (hasDot) return { type: 'gold', ...(await readGold(img, box, lineH, ocr)) };
  if (tall.length < 2) return { type: null, ok: false, raw: '' };
  const icon = tall[0];
  const solid = icon.fill > 0.6;
  const r = await readRun(f, tall.slice(1), ocr);
  return { type: solid ? 'points' : 'minions', ok: /^\d{1,4}$/.test(r.text), raw: r.text, conf: r.conf, iconFill: +icon.fill.toFixed(2), iconGap: +((tall[1].x0 - icon.x1) / f.LH).toFixed(2) };
}

// Player name: the thresholded line goes to the OCR engine in text mode.
async function readName(img, box, lineH, ocr) {
  const pad = lineH * 0.35, scale = Math.min(8, Math.max(1, 48 / lineH));
  const crop = cropChannel(img, { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad + 1, y1: box.y1 + pad + 1 }, scale);
  const thr = otsu(crop.gray);
  const gray = new Uint8Array(crop.gray.length);
  for (let i = 0; i < gray.length; i++) gray[i] = crop.gray[i] > thr ? 0 : 255;
  const r = await ocr({ gray, w: crop.w, h: crop.h }, false, true);
  return { text: (r.text || '').trim(), conf: r.confidence };
}

const norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
export function nameSimilarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a.length || !b.length) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
}

/* ---------- panel and header ---------- */

function findPanel(mx, W, H) {
  const dark = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0, t = 0;
    for (let x = 0; x < W; x += 2) { t++; if (mx[y * W + x] < T.darkPixel) n++; }
    dark[y] = n / t;
  }
  const minRun = Math.max(3, Math.round(H * 0.02));
  const runs = [];
  let start = -1;
  for (let y = 0; y <= H; y++) {
    const on = y < H && dark[y] >= T.bandDark;
    if (on && start < 0) start = y;
    if (!on && start >= 0) { if (y - start >= minRun) runs.push([start, y]); start = -1; }
  }
  if (runs.length < 2) return null;
  const top = runs[0][0], bottom = runs[runs.length - 1][1];
  const PH = bottom - top;
  if (PH < H * 0.4) return null;
  let headerEnd = top;
  while (headerEnd < bottom && dark[headerEnd] >= T.headerDark) headerEnd++;
  headerEnd = Math.min(Math.max(headerEnd, top + Math.round(PH * 0.12)), top + Math.round(PH * 0.24));
  let footStart = bottom - 1;
  while (footStart > headerEnd && dark[footStart] >= 0.8) footStart--;
  return { top, bottom, PH, headerEnd, footStart };
}

function meanColour(img, cc, comps) {
  const ids = new Set(comps.map(c => c.id));
  const s = [0, 0, 0]; let n = 0;
  for (const c of comps) {
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      if (!ids.has(cc.labels[(y - cc.oy) * cc.w + (x - cc.ox)])) continue;
      const p = (y * img.width + x) * 4;
      s[0] += img.data[p]; s[1] += img.data[p + 1]; s[2] += img.data[p + 2]; n++;
    }
  }
  return n ? s.map(v => v / n) : [0, 0, 0];
}
const bbox = cs => ({ x0: Math.min(...cs.map(c => c.x0)), y0: Math.min(...cs.map(c => c.y0)), x1: Math.max(...cs.map(c => c.x1)), y1: Math.max(...cs.map(c => c.y1)) });
const isBlue = rgb => rgb[2] > rgb[0];

async function readHeader(img, mask, panel, ocr) {
  const W = img.width, PH = panel.PH;
  const yEnd = Math.min(panel.footStart, panel.headerEnd + Math.round(PH * 0.03));
  const cc = components(mask, W, 0, panel.top, W, yEnd);
  const comps = cc.comps.filter(c => c.h <= PH * 0.09 && c.w <= c.h * 3 && c.h >= PH * 0.02);
  if (!comps.length) return null;
  const hmax = Math.max(...comps.map(c => c.h));
  const tallest = comps.filter(c => c.h >= hmax * 0.9);
  const ly0 = Math.min(...tallest.map(c => c.y0)), ly1 = Math.max(...tallest.map(c => c.y1));
  const line = comps.filter(c => c.cy > ly0 && c.cy < ly1 && c.h >= PH * 0.025).sort((a, b) => a.x0 - b.x0);
  const tokens = [];
  for (const c of line) {
    const last = tokens[tokens.length - 1];
    if (last && c.x0 - last.x1 <= PH * 0.022) { last.comps.push(c); last.x1 = Math.max(last.x1, c.x1); }
    else tokens.push({ comps: [c], x0: c.x0, x1: c.x1 });
  }
  const cx = W / 2;
  // the word sits between the two score tokens; start from the token over the image centre
  let wi = tokens.findIndex(t => t.x0 <= cx && t.x1 >= cx);
  if (wi < 0) {
    let best = Infinity;
    tokens.forEach((t, i) => { const d = Math.abs((t.x0 + t.x1) / 2 - cx); if (d < best) { best = d; wi = i; } });
  }
  if (wi < 1 || wi >= tokens.length - 1) return null;
  const word = tokens[wi], left = tokens[wi - 1], right = tokens[wi + 1];
  const wordRgb = meanColour(img, cc, word.comps);
  const leftRgb = meanColour(img, cc, left.comps), rightRgb = meanColour(img, cc, right.comps);
  const out = {
    wordRgb, leftRgb, rightRgb,
    result: isBlue(wordRgb) ? 'win' : 'loss',
    resultMargin: Math.abs(wordRgb[2] - wordRgb[0]),
    blueSide: isBlue(leftRgb) === isBlue(rightRgb) ? null : (isBlue(leftRgb) ? 'left' : 'right'),
    scores: {}, wordBox: bbox(word.comps),
  };
  // Notched phones inset the panel, so the content centre is the word's centre, not W / 2
  out.cx = Math.round((out.wordBox.x0 + out.wordBox.x1) / 2);
  for (const [name, tok] of [['left', left], ['right', right]]) {
    const b = bbox(tok.comps);
    const f = fieldGlyphs(img, b, b.y1 - b.y0 + 1);
    // Blitz puts a round skull icon beside each score: digits are never that round or solid
    const digits = f.glyphs.filter(g => g.kind === 'glyph' && g.w / g.h < 0.9);
    const r = await readRun(f, digits, ocr);
    out.scores[name] = { raw: r.text, conf: r.conf, ok: /^\d{1,3}$/.test(r.text), icon: f.glyphs.some(g => g.h >= f.LH * 0.6 && (g.kind === 'coin' || g.w / g.h >= 0.9)) };
  }
  // duration: small text centred under the result word
  const wb = out.wordBox;
  const under = cc.comps.filter(c => c.y0 > (wb.y0 + wb.y1) / 2 && c.cy > wb.y1 &&
    (c.x0 + c.x1) / 2 > wb.x0 - PH * 0.05 && (c.x0 + c.x1) / 2 < wb.x1 + PH * 0.05 && c.h <= PH * 0.05 && c.area >= 4);
  let digits = under.filter(c => c.h >= PH * 0.02);
  if (digits.length) {
    // keep only what sits on the first text line under the word
    const first = digits.reduce((a, b) => (b.y0 < a.y0 ? b : a));
    digits = digits.filter(c => Math.abs(c.cy - first.cy) < first.h * 0.4 && c.h < first.h * 1.3 && c.h > first.h * 0.7);
  }
  out.duration = { ok: false, raw: '' };
  if (digits.length >= 3) {
    const lineH = Math.max(...digits.map(c => c.h));
    const f = fieldGlyphs(img, bbox(digits), lineH);
    const runs = [[]];
    for (const g of f.glyphs) {
      if (g.kind === 'dot') { if (runs[runs.length - 1].length) runs.push([]); }
      else runs[runs.length - 1].push(g);
    }
    const parts = [];
    for (const r of runs.filter(r => r.length)) parts.push(await readRun(f, r, ocr));
    const raw = parts.map(p => p.text).join(':');
    out.duration = { raw, ok: /^\d{1,2}:\d{2}$/.test(raw), conf: Math.min(...parts.map(p => p.conf)) };
  }
  return out;
}

/* ---------- player rows ---------- */

// Rating and chat buttons are thin circles of one fixed size (radius ~0.056 PH).
// Count circle centres where most of the circumference is lit in the text mask.
function countRings(mask, W, x0, x1, y0, y1, PH) {
  const R = PH * 0.0557, N = 48, hits = [];
  const ring = [];
  for (let i = 0; i < N; i++) ring.push([Math.cos(i * 2 * Math.PI / N), Math.sin(i * 2 * Math.PI / N)]);
  const lit = (x, y) => x >= x0 && x < x1 && y >= 0 && mask[y * W + x];
  for (let cy = Math.round(y0 + R); cy <= y1 - R; cy += 2) {
    for (let cx = Math.round(x0 + R); cx <= x1 - R; cx += 2) {
      let n = 0;
      for (const [c, sn] of ring) {
        let ok = false;
        for (let d = -3; d <= 3 && !ok; d++) ok = lit(Math.round(cx + (R + d) * c), Math.round(cy + (R + d) * sn));
        if (ok) n++;
        else if (n + (N - ring.indexOf(ring.find(q => q[0] === c && q[1] === sn))) < N * 0.8) break;
      }
      if (n >= N * 0.8) hits.push([cx, cy, n]);
    }
  }
  hits.sort((a, b) => b[2] - a[2]);
  const kept = [];
  for (const h of hits) if (!kept.some(k => Math.hypot(k[0] - h[0], k[1] - h[1]) < R * 1.5)) kept.push(h);
  return kept.length;
}

function findRows(img, mask, panel, side, cx) {
  const W = img.width, PH = panel.PH;
  const x0 = side === 'left' ? 0 : Math.round(cx + PH * T.centreGap);
  const x1 = side === 'left' ? Math.round(cx - PH * T.centreGap) : W;
  const cc = components(mask, W, x0, panel.headerEnd - Math.round(PH * 0.01), x1, panel.footStart);
  const glyphs = cc.comps.filter(c => c.h >= PH * T.glyphMin && c.h <= PH * T.glyphMax);
  const slashes = glyphs.filter(c => c.w / c.h < T.slashAspect && c.lean > T.slashLean && c.fill < T.slashFill)
    .sort((a, b) => a.x0 - b.x0);
  const onLine = (c, s) => Math.min(c.y1, s.y1) - Math.max(c.y0, s.y0) >= 0.5 * c.h;
  const digitLike = (c, s) => onLine(c, s) && c.h >= s.h * 0.6 && c.h <= s.h * 1.2 && c.w <= s.h;
  const rows = [];
  const used = new Set();
  for (const A of slashes) {
    if (used.has(A.id)) continue;
    const B = slashes.find(s => s !== A && !used.has(s.id) && Math.abs(s.cy - A.cy) < A.h * 0.3 &&
      s.x0 - A.x1 > A.h * 0.3 && s.x0 - A.x1 < A.h * 2.6);
    if (!B) continue;
    const mid = glyphs.filter(c => c !== A && c !== B && digitLike(c, A) && c.x0 > A.x1 - 2 && c.x1 < B.x0 + 2);
    if (!mid.length) continue;
    const walk = (from, dir) => {
      const got = [];
      let edge = dir < 0 ? from.x0 : from.x1;
      const cands = glyphs.filter(c => digitLike(c, A) && (dir < 0 ? c.x1 <= from.x0 + 2 : c.x0 >= from.x1 - 2))
        .sort((p, q) => dir < 0 ? q.x1 - p.x1 : p.x0 - q.x0);
      for (const c of cands) {
        const gap = dir < 0 ? edge - c.x1 : c.x0 - edge;
        if (gap > A.h * T.digitGap || got.length >= 3) break;
        got.push(c); edge = dir < 0 ? c.x0 : c.x1;
      }
      return got;
    };
    const before = walk(A, -1), after = walk(B, 1);
    if (!before.length || !after.length) continue;
    used.add(A.id); used.add(B.id);
    const all = [...before, A, ...mid, B, ...after];
    rows.push({ side, lineH: Math.max(A.h, B.h), kdaBox: bbox(all), before, slashA: A, cc });
  }
  rows.sort((a, b) => a.kdaBox.y0 - b.kdaBox.y0);
  // K/D/A is left-aligned in a column: trim name letters that ran into it
  if (rows.length >= 2) {
    const starts = rows.map(r => r.kdaBox.x0).sort((a, b) => a - b);
    const col = starts[Math.floor(starts.length / 2)];
    for (const r of rows) {
      if (r.kdaBox.x0 < col - r.lineH * 0.25) {
        const keep = r.before.filter(c => c.x0 >= col - r.lineH * 0.25);
        if (keep.length) r.kdaBox.x0 = Math.min(...keep.map(c => c.x0));
      }
    }
  }
  // fields to the right of K/D/A on the same line: gold, then minion kills
  for (const r of rows) {
    const s = r.slashA, lh = r.lineH;
    const inLine = c => c.area >= 3 && c.h <= lh * 1.4 && c.y0 >= s.y0 - lh * 0.3 && c.y1 <= s.y1 + lh * 0.3 &&
      c.cy > r.kdaBox.y0 - lh * 0.15 && c.cy < r.kdaBox.y1 + lh * 0.15;
    const rest = cc.comps.filter(c => c.x0 > r.kdaBox.x1 && inLine(c)).sort((a, b) => a.x0 - b.x0);
    const tokens = [];
    for (const c of rest) {
      const last = tokens[tokens.length - 1];
      if (last && c.x0 - last.x1 <= lh * T.tokenGap) { last.comps.push(c); last.x1 = Math.max(last.x1, c.x1); }
      else tokens.push({ comps: [c], x0: c.x0, x1: c.x1 });
    }
    const good = tokens.filter(t => {
      const b = bbox(t.comps);
      return t.comps.length >= 2 && b.y0 >= s.y0 - lh * 0.3 && b.y1 <= s.y1 + lh * 0.3 &&
        t.comps.some(c => c.h >= lh * 0.6);
    });
    r.extraBoxes = good.slice(0, 2).map(t => bbox(t.comps));
    // name: glyph-sized pieces on the text line, left of K/D/A (descenders reach below it)
    const nm = cc.comps.filter(c => c.x1 < r.kdaBox.x0 - lh * 0.3 && c.area >= 6 && c.h >= lh * 0.3 && c.h <= lh * 1.7 &&
      c.y0 >= s.y0 - lh * 0.5 && c.y1 <= s.y1 + lh * 0.6);
    // split on wide gaps and keep the biggest cluster: portrait badges and scenery are small strays
    nm.sort((a, b) => a.x0 - b.x0);
    const clusters = [];
    for (const c of nm) {
      const last = clusters[clusters.length - 1];
      if (last && c.x0 - Math.max(...last.map(q => q.x1)) <= lh * 1.2) last.push(c); else clusters.push([c]);
    }
    const cluster = clusters.reduce((best, c) => (c.length >= best.length ? c : best), []);
    r.nameBox = cluster.length >= 2 ? bbox(cluster) : null;
    // brightness of the K/D/A text, used to spot faded (left the match) rows
    let sum = 0, n = 0;
    for (let y = r.kdaBox.y0; y <= r.kdaBox.y1; y++) for (let x = r.kdaBox.x0; x <= r.kdaBox.x1; x++) {
      if (!mask[y * W + x]) continue;
      const p = (y * W + x) * 4;
      sum += Math.max(img.data[p], img.data[p + 1], img.data[p + 2]); n++;
    }
    r.textLevel = n ? sum / n : 0;
    // what sits under the text line: rating buttons are grey, items are colourful
    const by0 = r.kdaBox.y1 + Math.round(PH * 0.03), by1 = Math.min(panel.footStart, r.kdaBox.y1 + Math.round(PH * 0.12));
    let m = 0, grey = 0, tot = 0;
    for (let y = by0; y < by1; y++) for (let x = x0; x < x1; x++) {
      tot++;
      if (!mask[y * W + x]) continue;
      m++;
      const p = (y * W + x) * 4;
      const hi = Math.max(img.data[p], img.data[p + 1], img.data[p + 2]), lo = Math.min(img.data[p], img.data[p + 1], img.data[p + 2]);
      if (hi - lo < hi * 0.25) grey++;
    }
    r.under = { share: tot ? m / tot : 0, grey: m ? grey / m : 0 };
    r.rings = countRings(mask, W, x0, x1, r.kdaBox.y1 + Math.round(PH * 0.02), Math.min(panel.footStart, r.kdaBox.y1 + Math.round(PH * 0.17)), PH);
    delete r.cc; delete r.before; delete r.slashA;
  }
  return rows;
}

/* ---------- top level ---------- */

// img: { data: Uint8ClampedArray (RGBA), width, height }
// ocr: async ({gray,w,h}, single) => { text, confidence }
export async function readScreenshot(img, ocr, opts = {}) {
  const W = img.width, H = img.height;
  const out = { ok: false, width: W, height: H, flags: [] };
  if (W < MIN_WIDTH && !opts.allowSmall) {
    out.reason = 'too-small';
    return out;
  }
  const mx = maxChannel(img.data, W, H);
  const panel = findPanel(mx, W, H);
  if (!panel) { out.reason = 'no-panel'; return out; }
  out.panel = panel;
  const radius = Math.max(4, Math.round(panel.PH * T.blurRadius));
  const mask = contrastMask(mx, W, H, panel.top, panel.bottom, radius);

  const header = await readHeader(img, mask, panel, ocr);
  if (!header) { out.reason = 'no-header'; return out; }
  out.cx = header.cx;
  Object.assign(out, { result: header.result, resultMargin: header.resultMargin, blueSide: header.blueSide, scores: header.scores, duration: header.duration });
  if (!header.blueSide) out.flags.push('team-colours-unclear');
  if (header.resultMargin < 25) out.flags.push('result-colour-unclear');

  const sides = { left: findRows(img, mask, panel, 'left', header.cx), right: findRows(img, mask, panel, 'right', header.cx) };
  out.rowsPerSide = { left: sides.left.length, right: sides.right.length };
  if (!sides.left.length || !sides.right.length) { out.reason = 'no-rows'; return out; }
  if (sides.left.length !== sides.right.length) out.flags.push('row-count-mismatch');

  out.rows = [];
  for (const side of ['left', 'right']) {
    const rows = sides[side];
    const brightest = Math.max(...rows.map(r => r.textLevel));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const row = { side, index: i, team: header.blueSide ? (side === header.blueSide ? 'blue' : 'red') : null, box: r.kdaBox, nameBox: r.nameBox, lineH: r.lineH };
      row.faded = r.textLevel < brightest * T.fadedRatio;
      row.rings = r.rings;
      row.buttons = r.rings > 0;
      // item icons are colourful and cover far more of the row than grey buttons do
      row.itemsUnder = r.under.share > 0.1 && r.under.grey < 0.5;
      row.kda = await readKda(img, r.kdaBox, r.lineH, ocr);
      row.gold = null; row.minions = null; row.points = null;
      for (const box of r.extraBoxes) {
        const e = await readExtra(img, box, r.lineH, ocr);
        delete e.debug;
        if (e.type && !row[e.type]) row[e.type] = e;
      }
      row.name = r.nameBox && opts.readNames !== false ? await readName(img, r.nameBox, r.lineH, ocr) : null;
      out.rows.push(row);
    }
  }
  const n = out.rows.length;
  const count = k => out.rows.filter(r => r[k] && r[k].ok).length;
  // a: K/D/A only. b: K/D/A, gold, minion kills. p: K/D/A and points (Blitz).
  out.layout = count('points') >= n / 2 ? 'p' : (count('gold') >= n / 2 ? 'b' : 'a');
  for (const r of out.rows) {
    if (out.layout !== 'b') { r.gold = null; r.minions = null; }
    if (out.layout !== 'p') r.points = null;
  }
  out.itemsView = out.rows.filter(r => r.itemsUnder).length >= n / 2;

  // header score = sum of that side's kills. A mismatch means a misread somewhere.
  out.checks = {};
  for (const side of ['left', 'right']) {
    const rows = out.rows.filter(r => r.side === side);
    // in Blitz the header shows points, so the points column is what adds up
    const val = r => out.layout === 'p' ? (r.points && r.points.ok ? r.points.raw : null) : (r.kda.ok ? r.kda.k : null);
    const sum = rows.every(r => val(r) !== null) ? rows.reduce((s, r) => s + Number(val(r)), 0) : null;
    const score = out.scores[side].ok ? Number(out.scores[side].raw) : null;
    out.checks[side] = sum !== null && score !== null ? sum === score : null;
  }

  // The player's row: the one blue row with no buttons under it. The saved
  // username is the fallback (and the only signal in the items view).
  const blue = out.rows.filter(r => r.team === 'blue');
  const bare = out.itemsView ? [] : blue.filter(r => !r.buttons);
  const byButtons = bare.length === 1 && blue.length > 1 ? out.rows.indexOf(bare[0]) : null;
  let byName = null;
  if (opts.username) {
    const scored = blue.map(r => ({ r, s: r.name ? nameSimilarity(r.name.text, opts.username) : 0 })).sort((a, b) => b.s - a.s);
    if (scored.length && scored[0].s >= 0.7 && (scored.length < 2 || scored[1].s < scored[0].s)) byName = out.rows.indexOf(scored[0].r);
  }
  out.playerBy = { buttons: byButtons, name: byName };
  out.playerRow = byButtons !== null ? byButtons : byName;
  if (byButtons !== null && byName !== null && byButtons !== byName) out.flags.push('player-row-signals-disagree');
  out.mode = out.rowsPerSide.left === out.rowsPerSide.right ? (out.layout === 'p' ? 'Blitz' : out.rowsPerSide.left === 3 ? '3v3' : out.rowsPerSide.left === 5 ? '5v5' : null) : null;
  out.ok = true;
  return out;
}

export const _internals = { findPanel, maxChannel, contrastMask, components, fieldGlyphs, renderRun, otsu };
