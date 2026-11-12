// Stage display / confidence monitor. Served by Deck Cue's control server; follows its WebSocket state.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.get('view') === 'timer') document.body.classList.add('timer-only');

let state = null;
let clockOffset = 0; // Deck Cue's clock minus ours
let pdfjs = null;
let pdf = { url: null, doc: null, loading: null };
let rendered = { current: '', next: '' };

// ---------- connection ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws.onopen = () => $('conn').classList.remove('down');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'state') return;
    state = msg.state;
    clockOffset = state.now - Date.now();
    render();
  };
  ws.onclose = () => {
    $('conn').classList.add('down');
    setTimeout(connect, 1500);
  };
}

// ---------- timer and clock ----------
function fmt(ms) {
  const over = ms < 0;
  const total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000); // a countdown shows 5:00 until a full second has passed
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return over ? `+${body}` : body;
}

function tick() {
  const now = new Date(Date.now() + clockOffset);
  $('clock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const el = $('timer');
  if (!state) return;
  const t = state.timer;
  const remaining = t.running ? t.endsAt - (Date.now() + clockOffset) : t.remaining;
  const idle = !t.running && !t.duration && !t.remaining;
  el.textContent = idle ? '--:--' : fmt(remaining);
  el.className = `timer${idle ? ' idle' : ''}${!idle && !t.running ? ' paused' : ''}${!idle && remaining < 0 ? ' over' : !idle && remaining <= 120000 ? ' warn' : ''}`;
}

// ---------- PDF previews ----------
async function loadPdf(url) {
  if (pdf.url === url) return pdf.loading;
  pdf = { url, doc: null, loading: null };
  rendered = { current: '', next: '' };
  if (!url) return null;
  pdf.loading = (async () => {
    if (!pdfjs) {
      pdfjs = await import('/stage/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/stage/pdf.worker.min.mjs';
    }
    const doc = await pdfjs.getDocument({ url, isEvalSupported: false }).promise;
    if (pdf.url === url) pdf.doc = doc;
    return doc;
  })().catch(() => null);
  return pdf.loading;
}

async function renderPage(container, n, key) {
  const doc = pdf.doc;
  const token = `${pdf.url}#${n}@${container.clientWidth}x${container.clientHeight}`;
  if (!doc || n < 1 || n > doc.numPages) return false;
  if (rendered[key] === token) return true;
  rendered[key] = token;
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const fit = Math.min(container.clientWidth / base.width, container.clientHeight / base.height);
  const vp = page.getViewport({ scale: fit * devicePixelRatio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / devicePixelRatio)}px`;
  canvas.style.height = `${Math.floor(vp.height / devicePixelRatio)}px`;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
  if (rendered[key] === token) container.replaceChildren(canvas);
  return true;
}

function showText(container, el, text) {
  if (!container.contains(el)) container.replaceChildren(el);
  el.textContent = text;
}

async function renderPreviews() {
  const live = state.live;
  await loadPdf(live && live.file ? live.file : null);
  const cur = $('currentView');
  const nxt = $('nextView');
  const slide = live && live.slide;
  const hasNextPage = !!(pdf.doc && slide && slide < pdf.doc.numPages);
  if (!(pdf.doc && slide && (await renderPage(cur, slide, 'current')))) {
    rendered.current = '';
    showText(cur, $('currentText') || Object.assign(document.createElement('div'), { id: 'currentText', className: 'big-text' }), live ? live.name : 'Standby');
  }
  if (!(hasNextPage && (await renderPage(nxt, slide + 1, 'next')))) {
    rendered.next = '';
    showText(nxt, $('nextText') || Object.assign(document.createElement('div'), { id: 'nextText', className: 'mid-text' }), state.next ? state.next.name : 'End of show');
  }
  $('nextLabel').textContent = hasNextPage ? `Slide ${slide + 1}` : state.next ? `${state.next.number} · ${state.next.name}` : '';
}

// ---------- render ----------
function render() {
  const live = state.live;
  $('liveName').textContent = live ? `${live.number} · ${live.name}` : 'Standby';
  $('slide').textContent = live && live.slide ? `${live.slide} / ${live.slides}` : '';
  $('notes').textContent = live ? live.notes : '';
  const m = state.stageMessage || {};
  const box = $('message');
  box.hidden = !m.text;
  box.textContent = m.text || '';
  box.classList.toggle('flash', !!m.flash);
  document.body.classList.toggle('has-message', !!m.text);
  tick();
  if (!document.body.classList.contains('timer-only')) renderPreviews();
}

addEventListener('resize', () => { rendered = { current: '', next: '' }; if (state) renderPreviews(); });
setInterval(tick, 200);
tick();
connect();
