// Draws the timer on the output screen. State comes from the main process; the countdown runs locally.
const $ = (id) => document.getElementById(id);
let s = null;

function fmt(ms) {
  const over = ms < 0;
  const total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000); // 5:00 until a full second has passed
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${over ? '+' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${sec}`;
}

// Keep the overlay box fully on screen wherever its centre was dragged to.
function place() {
  const pip = $('pip');
  if (pip.hidden) return;
  const p = s.config.pip;
  const w = pip.offsetWidth / innerWidth;
  const h = pip.offsetHeight / innerHeight;
  pip.style.left = `${Math.min(1 - w / 2, Math.max(w / 2, p.x)) * 100}%`;
  pip.style.top = `${Math.min(1 - h / 2, Math.max(h / 2, p.y)) * 100}%`;
}

// Time of day in the computer's own format, split so "PM" can be set smaller than the digits.
const clockFormat = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
function timeOfDay() {
  const parts = clockFormat.formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return { digits: `${get('hour')}:${get('minute')}`, period: get('dayPeriod') };
}

function set(el, text, state) {
  if (el.textContent !== text) el.textContent = text;
  el.dataset.state = state;
}

function tick() {
  if (!s) return;
  const t = s.timer;
  const idle = !t.running && !t.duration && !t.remaining;
  const left = t.running ? t.endsAt - Date.now() : t.remaining;
  const timer = { text: idle ? '00:00' : fmt(left), state: idle ? 'idle' : left < 0 ? 'over' : left <= 120000 ? 'warn' : !t.running ? 'paused' : '' };
  const now = timeOfDay();
  const clock = { text: now.digits, state: '' };

  // Full screen: the timer (optionally with the time of day underneath), or the time of day itself.
  const full = s.content === 'clock' ? clock : timer;
  set($('fullTime'), full.text, full.state);
  $('fullTime').toggleAttribute('data-long', full.text.length > 6);
  $('clock').textContent = s.content === 'clock' ? now.period : s.config.showClock ? `${now.digits}${now.period ? ` ${now.period}` : ''}` : '';

  const pip = s.config.pip.content === 'clock' ? clock : timer;
  set($('pipTime'), pip.text, pip.state);
  place();
}

function render() {
  $('full').hidden = s.mode !== 'full';
  $('pip').hidden = s.mode !== 'pip';
  $('title').textContent = s.config.title || '';
  $('hint').hidden = !s.clickToClose;
  document.body.toggleAttribute('data-click', !!s.clickToClose);
  const p = s.config.pip;
  const pip = $('pip');
  pip.dataset.bg = p.bg;
  pip.style.fontSize = `${p.h * innerHeight}px`;
  $('pipLabel').textContent = p.label || '';
  $('pipLabel').hidden = !p.label;
  tick();
}

window.timerScreen.onState((state) => { s = state; render(); });
document.addEventListener('click', () => { if (s && s.clickToClose) window.timerScreen.dismiss(); });
addEventListener('resize', () => { if (s) render(); });
setInterval(tick, 200);
