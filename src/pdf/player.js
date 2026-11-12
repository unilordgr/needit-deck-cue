import * as pdfjsLib from '../../node_modules/pdfjs-dist/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const stage = document.getElementById('stage');
let doc = null;
let page = 1;
let loadId = 0;
const cache = new Map(); // page number -> rendered canvas for the current window size
let cacheSize = '';
let typed = '';          // digits typed for "number + Return" jumps

async function renderPage(n) {
  const size = `${innerWidth}x${innerHeight}x${devicePixelRatio}`;
  if (size !== cacheSize) { cache.clear(); cacheSize = size; }
  if (cache.has(n)) return cache.get(n);
  const p = await doc.getPage(n);
  const base = p.getViewport({ scale: 1 });
  const fit = Math.min(innerWidth / base.width, innerHeight / base.height);
  const vp = p.getViewport({ scale: fit * devicePixelRatio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / devicePixelRatio)}px`;
  canvas.style.height = `${Math.floor(vp.height / devicePixelRatio)}px`;
  await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
  cache.set(n, canvas);
  // Keep only the pages around the current one.
  for (const k of cache.keys()) if (Math.abs(k - page) > 2) cache.delete(k);
  return canvas;
}

async function show(n) {
  if (!doc) return;
  page = Math.min(Math.max(1, n), doc.numPages);
  const id = loadId;
  const canvas = await renderPage(page);
  if (id !== loadId) return;
  stage.replaceChildren(canvas);
  window.player.status({ ok: true, page, pages: doc.numPages });
  // Pre-render the neighbours so the next click is instant.
  if (page < doc.numPages) renderPage(page + 1).catch(() => {});
  if (page > 1) renderPage(page - 1).catch(() => {});
}

async function load({ token, data, startPage }) {
  const id = ++loadId;
  try {
    const next = await pdfjsLib.getDocument({
      data,
      isEvalSupported: false,
      cMapUrl: new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
    }).promise;
    if (id !== loadId) return;
    if (doc) doc.destroy();
    doc = next;
    cache.clear();
    page = Math.min(Math.max(1, startPage || 1), doc.numPages);
    const canvas = await renderPage(page);
    if (id !== loadId) return;
    stage.replaceChildren(canvas);
    window.player.status({ token, ok: true, page, pages: doc.numPages });
    if (page < doc.numPages) renderPage(page + 1).catch(() => {});
  } catch (e) {
    const msg = document.createElement('div');
    msg.id = 'error';
    msg.textContent = `Could not open PDF: ${e.message}`;
    stage.replaceChildren(msg);
    window.player.status({ token, ok: false, error: e.message });
  }
}

window.player.onCommand((cmd) => {
  if (cmd.type === 'load') load(cmd);
  else if (cmd.type === 'nav') show(page + (cmd.dir === 'next' ? 1 : -1));
  else if (cmd.type === 'goto') show(cmd.page);
});

// Keys a presentation clicker or operator would use.
document.addEventListener('keydown', (e) => {
  if (/^\d$/.test(e.key)) { typed += e.key; return; }
  switch (e.key) {
    case 'Enter':
      if (typed) { show(parseInt(typed, 10)); typed = ''; } else show(page + 1);
      break;
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': case ' ': case 'n':
      show(page + 1); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': case 'Backspace': case 'p':
      show(page - 1); break;
    case 'Home': show(1); break;
    case 'End': if (doc) show(doc.numPages); break;
    case 'Escape': window.player.stop(); break;
    default: return;
  }
  typed = '';
  e.preventDefault();
});
document.addEventListener('click', () => show(page + 1));
document.addEventListener('contextmenu', (e) => { e.preventDefault(); show(page - 1); });

let cursorTimer = null;
document.addEventListener('mousemove', () => {
  document.body.classList.add('cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.remove('cursor'), 1500);
});
addEventListener('resize', () => show(page));
