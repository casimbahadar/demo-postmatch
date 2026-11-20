// importer.js: screenshot in, reader result and row crops out. Runs entirely on the phone.
// The OCR engine (Tesseract.js) and its English data are served from this site; nothing is fetched elsewhere.
import { readScreenshot, MIN_WIDTH } from './reader.js';

export const MAX_BYTES = 30 * 1024 * 1024;
export const MAX_SIDE = 8000;

let workerPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.append(s);
  });
}

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!window.Tesseract) await loadScript('tesseract.min.js');
      const base = new URL('./', location.href).href;
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, workerBlobURL: false,
      });
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Start loading the engine early (after the first screen has drawn) so the first import is quicker.
export function warmUp() { getWorker().catch(() => {}); }

let mode = null;
async function ocr(run, single, text) {
  const worker = await getWorker();
  const c = document.createElement('canvas');
  c.width = run.w; c.height = run.h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(run.w, run.h);
  for (let i = 0; i < run.gray.length; i++) {
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = run.gray[i];
    id.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  const want = text ? 'text' : 'digit';
  if (mode !== want) {
    // digits: one glyph at a time, digits only. text: one line of a player name.
    await worker.setParameters(text
      ? { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '' }
      : { tessedit_pageseg_mode: '8', tessedit_char_whitelist: '0123456789' });
    mode = want;
  }
  const { data } = await worker.recognize(c);
  return { text: (data.text || '').trim(), confidence: data.confidence };
}

function cropRow(canvas, res, row) {
  const lh = row.lineH;
  const W = canvas.width;
  const portraitEdge = res.panel.U * 0.21;
  let x0, x1;
  if (row.side === 'left') {
    x0 = (row.nameBox ? row.nameBox.x0 : row.box.x0 - lh * 8) - lh * 0.5;
    x1 = res.cx - portraitEdge;
  } else {
    x0 = Math.max(res.cx + portraitEdge, (row.nameBox ? row.nameBox.x0 : res.cx + portraitEdge) - lh * 0.5);
    x1 = row.box.x1 + lh * 9;
  }
  x0 = Math.max(0, Math.round(x0)); x1 = Math.min(W, Math.round(x1));
  const y0 = Math.max(0, Math.round(row.box.y0 - lh * 0.9)), y1 = Math.min(canvas.height, Math.round(row.box.y1 + lh * 0.8));
  const scale = Math.min(1, 900 / (x1 - x0));
  const out = document.createElement('canvas');
  out.width = Math.round((x1 - x0) * scale); out.height = Math.round((y1 - y0) * scale);
  out.getContext('2d').drawImage(canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
  return new Promise(r => out.toBlob(b => r(b ? URL.createObjectURL(b) : null), 'image/png'));
}

// Returns { res, strips } or { error, width }.
export async function importFile(file, { username } = {}) {
  if (!file) return { error: 'none' };
  if (file.type && !file.type.startsWith('image/')) return { error: 'type' };
  if (file.size > MAX_BYTES) return { error: 'big' };
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return { error: 'decode' }; }
  const { width, height } = bmp;
  if (width > MAX_SIDE || height > MAX_SIDE) { bmp.close(); return { error: 'big' }; }
  if (width < MIN_WIDTH) { bmp.close(); return { error: 'small', width }; }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  let res;
  try {
    await getWorker();
    res = await readScreenshot(ctx.getImageData(0, 0, width, height), ocr, { username });
  } catch (e) {
    return { error: 'engine', detail: String(e && e.message || e) };
  }
  if (!res.ok) return { error: res.reason || 'unread', width };
  const strips = await Promise.all(res.rows.map(r => cropRow(canvas, res, r)));
  canvas.width = canvas.height = 0;   // free the pixels right away
  return { res, strips };
}
