// Presenter phone remote: NEXT / PREV for the live cue, with a preview, the timer and operator messages.
// Needs the PIN set by the operator; the operator can mute it at any time.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let pin = params.get('pin') || (() => { try { return localStorage.getItem('deckcue-pin') || ''; } catch { return ''; } })();
let state = null;
let offset = 0;
let pdfjs = null;
let pdf = { url: null, doc: null };
let renderedKey = '';

async function api(path) {
  const r = await fetch(path, { method: 'POST', headers: { 'X-Presenter-Pin': pin } });
  const body = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, error: body.error };
}

async function login() {
  pin = $('pin').value.trim() || pin;
  const r = await api('/api/presenter/check');
  if (!r.ok) {
    $('login').hidden = false;
    $('remote').hidden = true;
    $('loginError').textContent = r.status === 403 ? 'Wrong PIN.' : r.error || 'Presenter remote is off.';
    return;
  }
  try { localStorage.setItem('deckcue-pin', pin); } catch { /* private mode */ }
  if (params.has('pin')) history.replaceState(null, '', location.pathname); // keep the PIN out of the address bar
  $('login').hidden = true;
  $('remote').hidden = false;
  connect();
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
  ws.onopen = () => $('conn').classList.remove('down');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'state') return;
    state = msg.state;
    offset = state.now - Date.now();
    render();
  };
  ws.onclose = () => { $('conn').classList.add('down'); setTimeout(connect, 1500); };
}

function fmt(ms) {
  const over = ms < 0;
  const t = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  return `${over ? '+' : ''}${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function tick() {
  if (!state) return;
  const t = state.timer;
  const idle = !t.running && !t.duration && !t.remaining;
  const left = t.running ? t.endsAt - (Date.now() + offset) : t.remaining;
  const el = $('timer');
  el.textContent = idle ? '--:--' : fmt(left);
  el.className = `timer${idle ? ' idle' : left < 0 ? ' over' : left <= 120000 ? ' warn' : ''}`;
}

async function renderPreview() {
  const live = state.live;
  const box = $('preview');
  if (live && live.file && live.slide) {
    if (pdf.url !== live.file) {
      pdf = { url: live.file, doc: null };
      if (!pdfjs) { pdfjs = await import('/stage/pdf.min.mjs'); pdfjs.GlobalWorkerOptions.workerSrc = '/stage/pdf.worker.min.mjs'; }
      pdf.doc = await pdfjs.getDocument({ url: live.file, isEvalSupported: false }).promise.catch(() => null);
    }
    const key = `${live.file}#${live.slide}@${box.clientWidth}x${box.clientHeight}`;
    if (pdf.doc && key !== renderedKey) {
      renderedKey = key;
      const page = await pdf.doc.getPage(live.slide);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(box.clientWidth / base.width, box.clientHeight / base.height) * devicePixelRatio });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      c.style.width = `${vp.width / devicePixelRatio}px`; c.style.height = `${vp.height / devicePixelRatio}px`;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#fff' }).promise;
      if (renderedKey === key) box.replaceChildren(c);
    }
    return;
  }
  renderedKey = '';
  if (live) {
    const src = `/api/cue/${encodeURIComponent(live.id)}/thumb`;
    if (!(box.firstChild && box.firstChild.dataset && box.firstChild.dataset.src === src)) {
      const img = new Image();
      img.dataset.src = src;
      img.onerror = () => { const d = document.createElement('div'); d.className = 'preview-text'; d.textContent = live.name; box.replaceChildren(d); };
      img.src = src;
      box.replaceChildren(img);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'preview-text';
    d.textContent = 'Standby';
    box.replaceChildren(d);
  }
}

function render() {
  const live = state.live;
  const p = state.presenter || {};
  $('liveName').textContent = live ? live.name : 'Standby';
  $('slide').textContent = live && live.slide ? `Slide ${live.slide} of ${live.slides}` : '';
  const m = state.stageMessage || {};
  $('message').hidden = !m.text;
  $('message').textContent = m.text || '';
  $('message').classList.toggle('flash', !!m.flash);
  const blocked = !p.enabled ? 'Presenter remote is off.' : p.muted ? 'Paused by the operator.' : live && live.presenterAllowed === false ? 'The operator controls this part.' : !live ? 'Waiting for your presentation…' : '';
  $('notice').hidden = !blocked;
  $('notice').textContent = blocked;
  $('next').disabled = $('prev').disabled = !!blocked;
  tick();
  renderPreview();
}

async function press(dir) {
  if (navigator.vibrate) navigator.vibrate(20);
  const r = await api(`/api/presenter/${dir}`);
  if (r.status === 403) { $('login').hidden = false; $('remote').hidden = true; $('loginError').textContent = 'The PIN changed. Enter the new one.'; }
}

$('next').onclick = () => press('next');
$('prev').onclick = () => press('prev');
$('loginBtn').onclick = login;
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
// Volume/arrow keys on a Bluetooth keyboard or clicker paired with the phone.
document.addEventListener('keydown', (e) => {
  if ($('remote').hidden) return;
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); press('next'); }
  if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); press('prev'); }
});
setInterval(tick, 250);
if (pin) login(); else $('login').hidden = false;
