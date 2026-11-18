// `api` is the global exposed by preload.js.
const $ = (id) => document.getElementById(id);

const COLORS = ['#3a4150', '#ff3b3b', '#ff8a00', '#f5b400', '#19c26b', '#14b8a6', '#4c8dff', '#8b5cf6', '#ec4899'];
const CUE_MIME = 'application/x-deckcue-cue';

let show = null;
let runtime = {};
let displays = [];
let env = { supportedExt: [] };
let fileOk = {};
let shortcutReport = {};
let selectedId = null;
let thumbs = {}; // cueId -> data: URL
let capture = null; // { kind: 'cue' } | { kind: 'global', key }

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const baseName = (p) => (p || '').split(/[\\/]/).pop(); // Windows paths use backslashes
const stem = (p) => baseName(p).replace(/\.[^.]+$/, '');
const ext = (p) => (baseName(p).match(/\.[^.]+$/) || [''])[0].toLowerCase();
const cueById = (id) => show.cues.find((c) => c.id === id);
const cueName = (c) => c.label || (c.file ? stem(c.file.path) : 'Empty cue');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function isSupported(p) { return env.supportedExt.includes(ext(p)); }

const CODE_MAP = {
  Space: 'Space', Escape: 'Escape', Enter: 'Return', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
};
function keyFromCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
  return CODE_MAP[code] || null;
}
function accelFromEvent(e) {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const parts = [];
  if (e.metaKey && IS_MAC) parts.push('Command'); // the Windows key is reserved by the OS
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}
const IS_MAC = api.platform === 'darwin';
const MOD_TEXT = IS_MAC ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt';
const PRETTY_WIN = { Control: 'Ctrl', Escape: 'Esc', Return: 'Enter', Up: '↑', Down: '↓', Left: '←', Right: '→' };
const PRETTY = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Space: 'Space', Escape: 'Esc', Return: '↩', Up: '↑', Down: '↓', Left: '←', Right: '→' };
function prettyAccel(a) {
  if (!a) return '';
  const parts = a.split('+');
  if (!IS_MAC) return parts.map((p) => PRETTY_WIN[p] || p.replace(/^num/, 'Num ')).join('+');
  return parts.map((p) => PRETTY[p] || p.replace(/^num/, 'Num ')).join('');
}
const GLOBAL_BLOCKLIST = ['Command+Q', 'Command+W', 'Command+Tab', 'Command+Space', 'Command+H', 'Command+M', 'Alt+F4', 'Alt+Tab', 'Control+Alt+Delete', 'Control+Escape'];
function globalAllowed(accel) {
  if (!accel || GLOBAL_BLOCKLIST.includes(accel)) return false;
  const parts = accel.split('+');
  return parts.some((p) => ['Command', 'Control', 'Alt'].includes(p)) || /^F\d{1,2}$/.test(parts[parts.length - 1]);
}
const RESERVED_LOCAL = ['Space', 'Escape', 'Left', 'Right', 'B'];

// ---------- persistence ----------
async function commit() {
  const r = await api.updateShow(show);
  shortcutReport = r.shortcutReport || {};
  render();
}

async function refreshFileStatus() {
  const paths = show.cues.filter((c) => c.file && c.file.path).map((c) => c.file.path);
  fileOk = paths.length ? await api.fileStatus(paths) : {};
}

// ---------- displays ----------
function outputRef(d) { return { id: d.id, label: d.label, width: d.bounds.width, height: d.bounds.height }; }
function displayName(d, i) {
  return `${i + 1}: ${d.label}${d.primary ? ' (main)' : ''} · ${d.bounds.width}×${d.bounds.height}`;
}
function refMatches(ref, d) { return ref && typeof ref === 'object' && ref.id === d.id; }
function outputOptions(current, includeDefault) {
  const opts = [];
  if (includeDefault) opts.push(`<option value="default"${!current || current === 'default' ? ' selected' : ''}>Default (show setting)</option>`);
  opts.push(`<option value="auto"${current === 'auto' ? ' selected' : ''}>Let the app choose</option>`);
  opts.push(`<option value="window"${current === 'window' ? ' selected' : ''}>Program window (for NDI / OBS capture)</option>`);
  let matched = !current || current === 'auto' || current === 'default' || current === 'window';
  displays.forEach((d, i) => {
    const sel = refMatches(current, d);
    if (sel) matched = true;
    opts.push(`<option value="${d.id}"${sel ? ' selected' : ''}>${esc(displayName(d, i))}</option>`);
  });
  if (!matched && current && current.label) {
    opts.push(`<option value="missing" selected>⚠ ${esc(current.label)} (not connected)</option>`);
  }
  return opts.join('');
}
function outputFromValue(v, previous) {
  if (v === 'default' || v === 'auto' || v === 'window') return v;
  if (v === 'missing') return previous;
  const d = displays.find((x) => String(x.id) === v);
  return d ? outputRef(d) : 'auto';
}
function outputShortLabel(ref) {
  if (!ref || ref === 'default') return null;
  if (ref === 'auto') return 'App picks';
  if (ref === 'window') return '→ PGM';
  const i = displays.findIndex((d) => d.id === ref.id);
  return i >= 0 ? `→ ${i + 1}` : '→ ⚠';
}

// ---------- presentation apps ----------
function appInfo(id) { return (env.apps || []).find((a) => a.id === id) || { id, short: id.toUpperCase(), name: id, installed: false }; }
function resolvedApp(c) {
  if (c.app && c.app !== 'auto') return c.app;
  if (c.file && ext(c.file.path) === '.pdf') return 'pdf';
  if (c.file && ext(c.file.path) === '.key') return 'keynote';
  return env.pptApp || 'powerpoint';
}
function appOptions(current, autoLabel, isPdf = false) {
  if (isPdf) return `<option value="auto" selected>${esc(appInfo('pdf').name)}</option>`;
  return [`<option value="auto"${!current || current === 'auto' ? ' selected' : ''}>${esc(autoLabel)}</option>`]
    .concat((env.apps || []).filter((a) => a.id !== 'pdf').map((a) => `<option value="${a.id}"${current === a.id ? ' selected' : ''}>${esc(a.name)}${a.installed ? '' : ' (not installed)'}</option>`))
    .join('');
}

// ---------- MIDI ----------
// Web MIDI in this window: notes / program changes fire cues, MIDI Show Control GO/STOP, and learned
// messages for GO, Stop, Next/Prev slide and Blackout.
let midi = null;          // settings (per computer)
let midiAccess = null;
let midiLearn = null;     // action being learned
let midiLast = '';        // last message, for the monitor line
const MIDI_ACTIONS = [['go', 'GO'], ['stop', 'Stop all'], ['next', 'Next slide'], ['prev', 'Previous slide'], ['blackout', 'Blackout']];

function midiDescribe(m) {
  if (!m) return 'not set';
  const names = { note: 'Note', cc: 'CC', pc: 'Program' };
  return `${names[m.type]} ${m.num} · ch ${m.ch}`;
}

function parseMidi(data) {
  const [status, a, b] = data;
  if (status === 0xf0) return { type: 'sysex', data };
  const kind = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  if (kind === 0x90 && b > 0) return { type: 'note', ch, num: a, vel: b };
  if (kind === 0xb0) return { type: 'cc', ch, num: a, val: b };
  if (kind === 0xc0) return { type: 'pc', ch, num: a };
  return null;
}

// MIDI Show Control: F0 7F <device> 02 <format> <command> [cue number as ASCII] ... F7
function parseMsc(data) {
  if (data.length < 7 || data[1] !== 0x7f || data[3] !== 0x02) return null;
  const device = data[2];
  const command = data[5];
  let cue = '';
  for (let i = 6; i < data.length && data[i] !== 0x00 && data[i] !== 0xf7; i++) cue += String.fromCharCode(data[i]);
  return { device, command, cue };
}

function midiAction(action) {
  if (action === 'go') api.go();
  else if (action === 'stop') api.stop();
  else if (action === 'next') api.nav('next');
  else if (action === 'prev') api.nav('previous');
  else if (action === 'blackout') api.blackout();
}

function fireCueNumber(n) {
  const cue = show.cues[n - 1];
  if (cue) api.fire(cue.id);
  else flash(`MIDI asked for cue ${n}, which doesn't exist.`, 'warn');
}

function onMidiMessage(e) {
  if (!midi || !midi.enabled) return;
  const input = e.target;
  if (midi.input !== 'all' && input.name !== midi.input) return;
  const m = parseMidi(Array.from(e.data));
  if (!m) return;
  if (m.type === 'sysex') {
    const msc = midi.msc && parseMsc(m.data);
    if (!msc) return;
    midiLast = `MSC ${msc.command === 1 ? 'GO' : msc.command === 2 ? 'STOP' : `cmd ${msc.command}`}${msc.cue ? ` cue ${msc.cue}` : ''} (device ${msc.device})`;
    if (msc.command === 0x01) { if (msc.cue && /^\d+$/.test(msc.cue)) fireCueNumber(Number(msc.cue)); else api.go(); }
    else if (msc.command === 0x02 || msc.command === 0x0a) api.stop(); // STOP, ALL_OFF
  } else {
    midiLast = `${m.type === 'note' ? 'Note' : m.type === 'cc' ? 'CC' : 'Program'} ${m.num}${m.type === 'cc' ? ` = ${m.val}` : ''} · ch ${m.ch} · ${input.name}`;
    if (midiLearn) {
      midi.map = { ...midi.map, [midiLearn]: { type: m.type, ch: m.ch, num: m.num } };
      midiLearn = null;
      api.midiSet(midi);
    } else if (!midi.channel || m.ch === midi.channel) {
      // CC only triggers on press (value > 0), like a button.
      const learned = Object.entries(midi.map || {}).find(([, v]) => v && v.type === m.type && v.num === m.num && v.ch === m.ch && (m.type !== 'cc' || m.val > 0));
      if (learned) midiAction(learned[0]);
      else if (m.type === 'note' && midi.notes && m.num >= midi.noteBase) fireCueNumber(m.num - midi.noteBase + 1);
      else if (m.type === 'pc' && midi.programChange) fireCueNumber(m.num + 1);
    }
  }
  if (!$('settings').hidden) renderMidiSettings();
}

async function startMidi() {
  if (!midi || !midi.enabled || midiAccess) return;
  if (!navigator.requestMIDIAccess) { flash('MIDI is not available on this computer.', 'warn'); return; }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    flash(`MIDI could not start: ${e.message}`, 'warn');
    return;
  }
  const attach = () => { for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage; };
  attach();
  midiAccess.onstatechange = () => { attach(); if (!$('settings').hidden) renderMidiSettings(); };
}

function renderMidiSettings() {
  const box = $('midiSettings');
  if (!midi) { box.textContent = 'Loading…'; return; }
  const inputs = midiAccess ? [...midiAccess.inputs.values()].map((i) => i.name) : [];
  box.innerHTML = `
    <label class="toggle"><input type="checkbox" data-midi="enabled" ${midi.enabled ? 'checked' : ''}><span>Listen to MIDI</span></label>
    ${midi.enabled ? `<div class="grid2">
      <span>Input</span><select data-midi="input"><option value="all">All inputs${inputs.length ? ` (${inputs.length})` : ' (none connected)'}</option>${inputs.map((n) => `<option${midi.input === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <span>Channel</span><select data-midi="channel"><option value="0">All channels</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}"${midi.channel === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select>
    </div>
    <label class="toggle"><input type="checkbox" data-midi="notes" ${midi.notes ? 'checked' : ''}><span>Notes fire cues: note</span> <input type="number" min="0" max="127" data-midi="noteBase" value="${midi.noteBase}" style="width:64px"> <span>= cue 1</span></label>
    <label class="toggle"><input type="checkbox" data-midi="programChange" ${midi.programChange ? 'checked' : ''}><span>Program Change n fires cue n+1</span></label>
    <label class="toggle"><input type="checkbox" data-midi="msc" ${midi.msc ? 'checked' : ''}><span>MIDI Show Control: GO [cue], STOP</span></label>
    <div class="midi-learn">${MIDI_ACTIONS.map(([k, label]) => `<span>${label}</span><span class="learned">${esc(midiDescribe((midi.map || {})[k]))}</span>
      <span><button class="btn small${midiLearn === k ? ' learning' : ''}" data-learn="${k}">${midiLearn === k ? 'Send a message…' : 'Learn'}</button>${(midi.map || {})[k] ? ` <button class="btn small ghost" data-unlearn="${k}">✕</button>` : ''}</span>`).join('')}</div>
    <div class="midi-monitor">Last message: ${esc(midiLast || 'none yet')}</div>` : ''}`;
}

async function saveMidi(patch) {
  midi = await api.midiSet({ ...midi, ...patch });
  if (midi.enabled) await startMidi();
  renderMidiSettings();
}

function setupMidi() {
  $('midiSettings').addEventListener('change', (e) => {
    const k = e.target.dataset.midi;
    if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : ['channel', 'noteBase'].includes(k) ? Number(e.target.value) : e.target.value;
    saveMidi({ [k]: v });
  });
  $('midiSettings').addEventListener('click', (e) => {
    const learn = e.target.dataset.learn;
    const unlearn = e.target.dataset.unlearn;
    if (learn) { midiLearn = midiLearn === learn ? null : learn; renderMidiSettings(); }
    if (unlearn) { const map = { ...midi.map }; delete map[unlearn]; saveMidi({ map }); }
  });
}

// ---------- files: copy into the show folder ----------
let filesPrefs = null; // { copy, folder }

function renderFilesSettings() {
  const box = $('filesSettings');
  if (!filesPrefs) { box.textContent = ''; return; }
  box.innerHTML = `
    <label class="toggle"><input type="checkbox" data-files="copy" ${filesPrefs.copy ? 'checked' : ''}><span>Copy presentations into this computer's show folder</span></label>
    <p class="hint">So a USB stick can be taken out. Dropping a file on a cue replaces the old one, and the folder keeps only the latest version.</p>
    <div class="row wide"><span>Show folder</span>
      <div class="file-box"><div class="file-path">${esc(filesPrefs.folder)}</div>
        <div class="file-actions"><button class="btn small" data-files-act="pick">Change folder</button><button class="btn small ghost" data-files-act="open">Open folder</button></div></div></div>`;
}

function setupFilesSettings() {
  $('filesSettings').addEventListener('change', async (e) => {
    if (e.target.dataset.files === 'copy') { filesPrefs = await api.filesPrefs({ copy: e.target.checked }); renderFilesSettings(); }
  });
  $('filesSettings').addEventListener('click', async (e) => {
    const a = e.target.dataset.filesAct;
    if (a === 'open') api.centerOpenFolder();
    if (a === 'pick') {
      const folder = await api.centerPickFolder();
      if (!folder) return;
      centerInfo = await api.centerSet({ folder });
      filesPrefs = await api.filesPrefs();
      renderFilesSettings();
      renderCenterSettings();
    }
  });
}

// ---------- Command Center ----------
let centerInfo = null; // { config, name, centers, addresses, port }

function renderCenterChip() {
  const chip = $('centerChip');
  const names = centerInfo ? centerInfo.centers : [];
  chip.hidden = !names.length;
  chip.textContent = names.length ? `Command Center: ${names.join(', ')}` : '';
}

function renderCenterSettings() {
  const box = $('centerSettings');
  if (!centerInfo) { box.textContent = 'Loading…'; return; }
  const c = centerInfo.config;
  const connected = centerInfo.centers.length > 0;
  const address = centerInfo.addresses.length ? `${centerInfo.addresses[0]}:${centerInfo.port}` : null;
  box.innerHTML = `
    <label class="toggle big"><input type="checkbox" data-cc="accept" ${c.accept ? 'checked' : ''}><span>Connect to Command Center</span></label>
    ${c.accept ? `
    <div class="cc-status ${connected ? 'ok' : ''}">${connected ? `Connected to ${esc(centerInfo.centers.join(', '))}.` : 'Waiting for a Command Center on this network…'}</div>
    <label class="row wide"><span>This computer is called</span><input data-cc="name" value="${esc(c.name)}" placeholder="${esc(centerInfo.name)}" maxlength="40"></label>
    <div class="row wide"><span>Presentations are saved in</span>
      <div class="file-box"><div class="file-path">${esc(c.folder)}</div>
        <div class="file-actions"><button class="btn small" data-cc-act="pick">Change folder</button><button class="btn small ghost" data-cc-act="open">Open folder</button></div></div></div>
    <label class="row wide"><span>Network key (optional)</span><input data-cc="key" value="${esc(c.key)}" placeholder="None" autocomplete="off" spellcheck="false"></label>
    <p class="hint">With a network key, only a Command Center that has the same key can send files here.</p>
    ${address ? `<p class="hint">If this computer does not appear in the Command Center by itself, add it there with this address: <b>${esc(address)}</b></p>` : '<p class="hint status-bad">This computer is not on a network yet.</p>'}` : `
    <p class="hint">Switch this on and this computer shows up in the Command Center by itself. Presentations sent from there are saved here and added as cues.</p>`}`;
}

async function saveCenter(patch) {
  centerInfo = await api.centerSet(patch);
  remote = await api.controlGet();
  renderCenterSettings();
  renderCenterChip();
}

function setupCenter() {
  $('centerSettings').addEventListener('change', (e) => {
    const k = e.target.dataset.cc;
    if (k) saveCenter({ [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value.trim() });
  });
  $('centerSettings').addEventListener('click', async (e) => {
    const a = e.target.dataset.ccAct;
    if (a === 'open') api.centerOpenFolder();
    if (a === 'pick') { const folder = await api.centerPickFolder(); if (folder) saveCenter({ folder }); }
  });
  // Settings sections: one pane at a time.
  document.querySelector('.set-nav').addEventListener('click', (e) => {
    const pane = e.target.dataset.pane;
    if (!pane) return;
    document.querySelectorAll('.set-nav [data-pane]').forEach((b) => b.classList.toggle('on', b.dataset.pane === pane));
    document.querySelectorAll('.set-body [data-pane]').forEach((sec) => { sec.hidden = sec.dataset.pane !== pane; });
    document.querySelector('.set-body').scrollTop = 0;
  });
  // About: who made it, and the three places to go from here.
  api.about().then((a) => { $('aboutName').textContent = `${a.name} ${a.version}`; });
  document.querySelector('.about-actions').addEventListener('click', (e) => {
    if (e.target.dataset.about) api.aboutOpen(e.target.dataset.about);
  });
  $('chooseButtons').onclick = (e) => { const b = e.target.closest('[data-choice]'); if (b && chooseDone) chooseDone(b.dataset.choice); };
  // Updates
  $('updateBtn').onclick = () => openSettingsPane('about');
  $('updateCheck').onclick = async () => { $('updateCheck').disabled = true; await api.updateCheck(); $('updateCheck').disabled = false; };
  $('updateNow').onclick = async () => {
    const u = await api.updateInstall();
    if (u && u.error) flash(u.error, 'warn');
  };
  $('updateCheckOn').onchange = (e) => api.updateSet({ check: e.target.checked });
  $('updateAuto').onchange = (e) => api.updateSet({ auto: e.target.checked });
}

// ---------- timer on the output screen ----------
const tsCfg = () => show.settings.timerScreen;
let tsSaveTimer = null;

// Save without rebuilding the whole window (used while dragging the overlay).
function tsSaveSoon() {
  clearTimeout(tsSaveTimer);
  tsSaveTimer = setTimeout(() => api.updateShow(show), 60);
}

function renderTimerScreenStatus() {
  const rt = runtime.timerScreen || {};
  const btn = $('timerFullBtn');
  const cardUp = !!rt.forced && rt.forcedContent === 'card';
  btn.classList.toggle('on', !!rt.forced && !cardUp);
  btn.textContent = rt.forced && !cardUp ? 'Exit full screen' : 'Full screen';
  $('cardFullBtn').classList.toggle('on', cardUp);
  $('cardFullBtn').textContent = cardUp ? 'Hide the card' : 'Event card';
  const where = rt.display ? rt.display.label : 'the output';
  const el = $('timerScreenStatus');
  el.className = `rail-note${rt.note ? ' warn' : ''}`;
  el.textContent = rt.note
    ? rt.note
    : rt.mode === 'full' ? `${rt.content === 'card' ? 'The event card' : rt.content === 'clock' ? 'Current time' : 'Timer'} is full screen on ${where}.`
      : rt.mode === 'pip' ? `Overlay is showing on ${where}.` : '';
}

// Draws the overlay box in the preview with the same rules the output uses.
function renderTsPreview() {
  const p = tsCfg().pip;
  const prev = $('tsPreview');
  const box = $('tsBox');
  const rt = runtime.timerScreen || {};
  if (rt.display) prev.style.aspectRatio = `${rt.display.width} / ${rt.display.height}`;
  // A slide behind it for context: the live cue's first slide, else the next cue's.
  const cue = cueById(runtime.liveCueId) || cueById(runtime.armedCueId) || show.cues[0];
  prev.style.backgroundImage = cue && thumbs[cue.id] ? `url('${thumbs[cue.id]}')` : '';
  box.dataset.bg = p.bg;
  box.style.fontSize = `${p.h * prev.clientHeight}px`;
  $('tsBoxLabel').textContent = p.label || '';
  $('tsBoxLabel').hidden = !p.label;
  $('tsBoxTime').textContent = p.content === 'clock' ? new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '') : '12:34';
  const w = box.offsetWidth / prev.clientWidth;
  const h = box.offsetHeight / prev.clientHeight;
  box.style.left = `${Math.min(1 - w / 2, Math.max(w / 2, p.x)) * 100}%`;
  box.style.top = `${Math.min(1 - h / 2, Math.max(h / 2, p.y)) * 100}%`;
}

function renderTimerScreenModal() {
  const c = tsCfg();
  const rt = runtime.timerScreen || {};
  const current = c.display && c.display !== 'output' ? c.display : null;
  $('tsDisplay').innerHTML = `<option value="output"${!current ? ' selected' : ''}>Same as the output</option>`
    + displays.map((d, i) => `<option value="${d.id}"${current && current.id === d.id ? ' selected' : ''}>${esc(displayName(d, i))}</option>`).join('')
    + (current && !displays.some((d) => d.id === current.id) ? `<option value="missing" selected>⚠ ${esc(current.label)} (not connected)</option>` : '');
  $('tsIdle').value = c.idle;
  $('tsCardName').textContent = c.card ? baseName(c.card) : 'No image yet';
  $('tsCardName').classList.toggle('set', !!c.card);
  $('tsCardClear').hidden = !c.card;
  if (document.activeElement !== $('tsTitle')) $('tsTitle').value = c.title || '';
  $('tsClock').checked = !!c.showClock;
  $('tsMessages').value = ['off', 'full', 'always'].includes(c.messages) ? c.messages : 'full';
  $('tsClock').disabled = c.idle === 'clock';
  $('tsLivePip').checked = !!c.livePip;
  $('tsContent').value = c.pip.content;
  $('tsBg').value = c.pip.bg;
  if (document.activeElement !== $('tsLabel')) $('tsLabel').value = c.pip.label || '';
  $('tsPreviewOn').checked = !!rt.preview;
  $('tsNote').hidden = !rt.note;
  $('tsNote').textContent = rt.note || '';
  renderTsPreview();
}

function setupTimerScreen() {
  $('timerFullBtn').onclick = () => api.timerScreenForce();
  // The event card. main sends the changed show back, so only the answer's error is handled here.
  const chooseCard = async () => {
    const r = await api.cardChoose();
    if (r && r.error) flash(r.error, 'error');
    if (!$('timerScreenModal').hidden) renderTimerScreenModal();
    return !!(r && r.card);
  };
  $('cardFullBtn').onclick = async () => {
    const up = (runtime.timerScreen || {}).forced && (runtime.timerScreen || {}).forcedContent === 'card';
    if (!up && !tsCfg().card && !(await chooseCard())) return; // no image yet: choose one first
    api.timerScreenForce('card');
  };
  $('tsCardChoose').onclick = chooseCard;
  $('tsCardClear').onclick = async () => { await api.cardClear(); renderTimerScreenModal(); };
  $('timerScreenBtn').onclick = () => { $('timerScreenModal').hidden = false; renderTimerScreenModal(); };
  const closeModal = () => { $('timerScreenModal').hidden = true; api.timerScreenPreview(false); };
  $('tsClose').onclick = closeModal;
  $('timerScreenModal').onclick = (e) => { if (e.target === $('timerScreenModal')) closeModal(); };

  const save = async () => { await api.updateShow(show); renderTimerScreenModal(); };
  $('tsDisplay').onchange = (e) => {
    const d = displays.find((x) => String(x.id) === e.target.value);
    if (e.target.value !== 'missing') tsCfg().display = d ? outputRef(d) : 'output';
    save();
  };
  $('tsIdle').onchange = async (e) => {
    // "The event card" without an image: ask for it now, and leave the choice as it was if none is given.
    if (e.target.value === 'card' && !tsCfg().card && !(await chooseCard())) { renderTimerScreenModal(); return; }
    tsCfg().idle = e.target.value; save();
  };
  $('tsTitle').oninput = (e) => { tsCfg().title = e.target.value; tsSaveSoon(); };
  $('tsClock').onchange = (e) => { tsCfg().showClock = e.target.checked; save(); };
  $('tsMessages').onchange = (e) => { tsCfg().messages = e.target.value; save(); };
  $('tsLivePip').onchange = (e) => { tsCfg().livePip = e.target.checked; save(); };
  $('tsContent').onchange = (e) => { tsCfg().pip.content = e.target.value; save(); };
  $('tsBg').onchange = (e) => { tsCfg().pip.bg = e.target.value; save(); };
  $('tsLabel').oninput = (e) => { tsCfg().pip.label = e.target.value; renderTsPreview(); tsSaveSoon(); };
  $('tsPreviewOn').onchange = (e) => api.timerScreenPreview(e.target.checked);
  document.querySelector('.ts-corners').onclick = (e) => {
    const corner = e.target.dataset.corner;
    if (!corner) return;
    // Centre the box half its own size plus a small gap away from that corner.
    const p = tsCfg().pip;
    const margin = 0.03;
    const prev = $('tsPreview');
    const box = $('tsBox');
    const w = box.offsetWidth / prev.clientWidth / 2;
    const h = box.offsetHeight / prev.clientHeight / 2;
    p.x = corner.endsWith('l') ? margin + w : 1 - margin - w;
    p.y = corner.startsWith('t') ? margin * 1.6 + h : 1 - margin * 1.6 - h;
    save();
  };

  // Drag to move, drag the handle to resize.
  const prev = $('tsPreview');
  let drag = null;
  prev.addEventListener('pointerdown', (e) => {
    const box = $('tsBox');
    if (!box.contains(e.target)) return;
    const r = prev.getBoundingClientRect();
    const p = tsCfg().pip;
    const b = box.getBoundingClientRect();
    drag = e.target.id === 'tsHandle'
      ? { kind: 'size', cy: b.top + b.height / 2 }
      : { kind: 'move', dx: e.clientX - (b.left + b.width / 2), dy: e.clientY - (b.top + b.height / 2) };
    drag.rect = r;
    p.x = (b.left + b.width / 2 - r.left) / r.width; // start from where it is drawn (after clamping)
    p.y = (b.top + b.height / 2 - r.top) / r.height;
    prev.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  prev.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = tsCfg().pip;
    const r = drag.rect;
    if (drag.kind === 'move') {
      p.x = Math.min(1, Math.max(0, (e.clientX - drag.dx - r.left) / r.width));
      p.y = Math.min(1, Math.max(0, (e.clientY - drag.dy - r.top) / r.height));
    } else {
      p.h = Math.min(0.5, Math.max(0.05, (2 * (e.clientY - drag.cy)) / r.height));
    }
    renderTsPreview();
    tsSaveSoon();
  });
  const end = () => { if (drag) { drag = null; api.updateShow(show); } };
  prev.addEventListener('pointerup', end);
  prev.addEventListener('pointercancel', end);
  addEventListener('resize', () => { if (!$('timerScreenModal').hidden) renderTsPreview(); });
}

// ---------- presenter remote ----------
let presenter = null;

function renderPresenterChip() {
  const chip = $('presenterChip');
  const enabled = presenter ? presenter.enabled : false;
  chip.hidden = !enabled;
  const muted = !!runtime.presenterMuted;
  chip.textContent = muted ? 'Presenter paused' : 'Presenter remote on';
  chip.classList.toggle('muted', muted);
}

function renderPresenterSettings() {
  const box = $('presenterSettings');
  if (!presenter) { box.textContent = 'Loading…'; return; }
  const p = presenter;
  box.innerHTML = `
    <label class="toggle"><input type="checkbox" data-pr="enabled" ${p.enabled ? 'checked' : ''}><span>Allow presenters to change slides from their phone</span></label>
    ${p.enabled ? `<div class="presenter-qr"><img src="${p.qr}" alt="QR code for the presenter remote">
      <div><div>Scan, or open <b>${esc(p.url)}</b></div><div>PIN <span class="pin">${esc(p.pin)}</span> <button class="btn small ghost" data-pr="newPin">New PIN</button></div>
      <div class="note" style="margin:0">Only NEXT and PREV. Pause it any time with the PRESENTER chip in the status bar; untick a cue's “Presenter remote can change slides” to keep it for yourself.</div></div></div>` : ''}`;
}

async function loadPresenter() {
  presenter = await api.presenterGet();
  renderPresenterChip();
}

// ---------- show-machine mode ----------
let showModeInfo = null; // { active, quietOk, items, apps }
let showModeCfg = null;

function renderShowModeIndicators() {
  const on = !!runtime.showMode;
  $('showModeBadge').hidden = !on;
  $('showModeBtn').classList.toggle('on', on);
  $('showModeBtn').textContent = on ? 'Show mode on' : 'Show mode';
  const t = $('showModeToggle');
  t.textContent = on ? 'Show mode is ON (click to turn off)' : 'Turn show mode on';
  t.classList.toggle('on', on);
}

async function refreshShowMode() {
  showModeInfo = await api.showModeReadiness();
  renderShowModePanel();
}

function renderShowModePanel() {
  renderShowModeIndicators();
  if (showModeCfg) $('showModeAuto').checked = !!showModeCfg.autoStart;
  const items = showModeInfo ? showModeInfo.items : [];
  $('showModeItems').innerHTML = items.map((i, n) => `<li class="${i.level}">${esc(i.text)}${
    i.fix === 'quit-apps' ? ` <button class="btn small fix" data-fix="quit-apps">Quit them</button>`
      : i.fix === 'focus-help' ? ` <button class="btn small ghost fix" data-fix="focus-help">How?</button>` : ''}</li>`).join('') || '<li class="info">Checking…</li>';
}

function showFocusHelp() {
  const c = showModeCfg || {};
  const box = $('focusHelp');
  box.hidden = false;
  box.innerHTML = `macOS doesn't let apps switch Do Not Disturb, but Deck Cue can run two Shortcuts you make once:
    <ol>
      <li>Open the Shortcuts app and create a shortcut named <code>${esc(c.focusOn)}</code> with the action <b>Set Focus</b> → <b>Do Not Disturb</b> → <b>On</b>.</li>
      <li>Create another named <code>${esc(c.focusOff)}</code> with <b>Set Focus</b> → <b>Do Not Disturb</b> → <b>Off</b>.</li>
      <li>Come back and press <b>Check again</b>. Show mode runs them when it turns on and off.</li>
    </ol>
    <button class="btn small" id="openShortcuts">Open Shortcuts</button>`;
  $('openShortcuts').onclick = () => api.openShortcuts();
}

function setupShowMode() {
  $('showModeBtn').onclick = async () => {
    $('showModeModal').hidden = false;
    $('focusHelp').hidden = true;
    showModeCfg = await api.showModeConfig();
    renderShowModePanel();
    refreshShowMode();
  };
  $('showModeClose').onclick = () => { $('showModeModal').hidden = true; };
  $('showModeModal').onclick = (e) => { if (e.target === $('showModeModal')) $('showModeModal').hidden = true; };
  $('showModeToggle').onclick = async () => {
    $('showModeToggle').disabled = true;
    await api.showModeSet(!runtime.showMode);
    $('showModeToggle').disabled = false;
    refreshShowMode();
  };
  $('showModeAuto').onchange = async (e) => { showModeCfg = await api.showModeConfig({ autoStart: e.target.checked }); };
  $('showModeRefresh').onclick = () => refreshShowMode();
  $('showModeItems').onclick = async (e) => {
    const fix = e.target.dataset && e.target.dataset.fix;
    if (fix === 'focus-help') showFocusHelp();
    if (fix === 'quit-apps') {
      const apps = showModeInfo ? showModeInfo.apps : [];
      if (!apps.length || !confirm(`Quit ${apps.join(', ')}? Unsaved work in those apps may be lost.`)) return;
      const quit = await api.showModeQuitApps(apps);
      flash(`Asked to quit: ${quit.join(', ')}`, 'info');
      setTimeout(refreshShowMode, 2000);
    }
  };
}

// ---------- versions ----------
function verFor(c) { return (runtime.versions || {})[c.id] || null; }
const timeOf = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function verBadge(c) {
  const v = verFor(c);
  if (!v) return '';
  if (v.newer) return `<span class="badge ver-newer" title="Newer version in the folder: ${esc(v.newer.name)}">NEW VERSION</span>`;
  if (v.changedAt) return `<span class="badge ver-changed" title="The file changed on disk at ${timeOf(v.changedAt)}">UPDATED</span>`;
  return '';
}
function renderVersionBox(c) {
  const v = verFor(c);
  const box = $('edVersion');
  if (!v) { box.hidden = true; return; }
  box.hidden = false;
  box.className = `version-box${v.newer ? ' newer' : ''}`;
  box.innerHTML = v.newer
    ? `<div><b>Newer version in the folder:</b> ${esc(v.newer.name)} (saved ${timeOf(v.newer.mtime)})</div>
       <div class="actions"><button class="btn small" data-ver="use">Use it</button><button class="btn small ghost" data-ver="ignore">Ignore</button></div>`
    : `<div><b>The file changed on disk</b> at ${timeOf(v.changedAt)}.${runtime.liveCueId === c.id ? ' The show still runs the old version; fire the cue again to load the new one.' : ' It will load the new version when fired.'}</div>
       <div class="actions"><button class="btn small ghost" data-ver="clear">OK</button></div>`;
}

// ---------- preflight ----------
const PF_ICON = { ok: '✓', info: '✓', warn: '⚠', error: '✕' };
function pfFor(c) { return (runtime.preflight || {})[c.id]; }
function pfBadge(c) {
  const pf = pfFor(c);
  if (!pf) return '';
  const problems = pf.items.filter((i) => i.level === 'warn' || i.level === 'error').length;
  const title = pf.items.length ? pf.items.map((i) => `${PF_ICON[i.level] === '✓' ? 'i' : PF_ICON[i.level]} ${i.text}`).join('\n') : 'Preflight: no problems found';
  return `<span class="badge pf-${pf.level}" title="${esc(title)}">${PF_ICON[pf.level]}${problems ? ` ${problems}` : ''}</span>`;
}
function pfItemsHtml(items) {
  return items.length ? items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('') : '<li class="ok">No problems found.</li>';
}
function renderPreflightButton() {
  const all = show.cues.map(pfFor).filter(Boolean);
  const btn = $('preflightBtn');
  const errors = all.filter((p) => p.level === 'error').length;
  const warns = all.filter((p) => p.level === 'warn').length;
  const level = errors ? 'error' : warns ? 'warn' : all.length ? 'ok' : '';
  btn.className = `btn ghost preflight-btn ${level ? `pf-${level}` : ''}`;
  btn.textContent = !show.cues.length ? 'Preflight' : errors ? `✕ ${errors} won't play` : warns ? `⚠ ${warns} to check` : all.length ? '✓ Ready' : 'Preflight…';
  btn.title = errors || warns ? `${errors ? `${errors} cue${errors > 1 ? 's' : ''} won't play. ` : ''}${warns ? `${warns} cue${warns > 1 ? 's' : ''} to check. ` : ''}Click for the preflight report.` : 'Preflight: every cue checked on this computer. Click for the report.';
}
function renderPreflightReport() {
  const rows = show.cues.map((c, i) => ({ c, i, pf: pfFor(c) })).filter((r) => r.pf && r.pf.items.length);
  $('preflightReport').innerHTML = rows.length
    ? rows.map(({ c, i, pf }) => `<div><h4><span class="badge pf-${pf.level}">${PF_ICON[pf.level]}</span> ${i + 1} · ${esc(cueName(c))}</h4><ul class="pf-list">${pfItemsHtml(pf.items)}</ul></div>`).join('')
    : `<div class="pf-empty">✓ All ${show.cues.length} cue${show.cues.length === 1 ? '' : 's'} passed preflight on this computer.</div>`;
}

// ---------- rendering ----------
function render() {
  if (!show) return;
  document.body.classList.toggle('locked', !!show.settings.locked);
  if (document.activeElement !== $('showName')) $('showName').value = show.showName || '';
  $('defaultOutput').innerHTML = outputOptions(show.settings.defaultOutput, false);
  $('defaultAuto').checked = !!show.settings.defaultAutoSlideshow;
  $('lockBtn').textContent = show.settings.locked ? 'Locked' : 'Unlocked';
  $('lockBtn').classList.toggle('locked', !!show.settings.locked);
  renderGrid();
  renderStatus();
  renderEditor();
  renderPreflightButton();
  renderPresets();
  if (!$('settings').hidden) renderSettings();
  if (!$('preflightModal').hidden) renderPreflightReport();
}

function renderGrid() {
  const grid = $('grid');
  const html = show.cues.map((c, i) => {
    const missing = !c.file || fileOk[c.file.path] === false;
    const auto = c.autoSlideshow === true || c.autoSlideshow === false ? c.autoSlideshow : show.settings.defaultAutoSlideshow;
    const app = appInfo(resolvedApp(c));
    const sc = c.shortcut && c.shortcut.accel;
    const scBad = sc && c.shortcut.global && shortcutReport[c.id];
    const out = outputShortLabel(c.output);
    const cls = ['cue',
      runtime.liveCueId === c.id && 'live',
      runtime.armedCueId === c.id && runtime.liveCueId !== c.id && 'armed',
      runtime.busyCueId === c.id && 'busy',
      selectedId === c.id && 'selected',
      missing && 'missing',
      thumbs[c.id] && !missing && 'has-thumb'].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${c.id}" draggable="${!show.settings.locked}" style="--cue-color:${esc(c.color || COLORS[0])}${thumbs[c.id] && !missing ? `;--thumb:url('${thumbs[c.id]}')` : ''}">
      <div class="num">${i + 1}</div>
      <div class="badges">
        ${verBadge(c)}
        ${pfBadge(c)}
        ${out ? `<span class="badge" title="Output override">${esc(out)}</span>` : ''}
        <span class="badge" title="${auto ? 'Starts the slideshow automatically' : 'Opens without starting the slideshow'}">${auto ? '⛶' : 'open'}</span>
        <span class="badge app-${app.id}${app.installed ? '' : ' bad'}" title="${esc(app.name)}${app.installed ? '' : ' is not installed'}">${esc(app.short)}</span>
        ${sc ? `<span class="badge key ${c.shortcut.global ? 'global' : ''} ${scBad ? 'bad' : ''}" title="${esc(scBad || (c.shortcut.global ? 'Global shortcut' : 'Works when Deck Cue is in front'))}">${c.shortcut.global ? '🌐 ' : ''}${esc(prettyAccel(sc))}</span>` : ''}
      </div>
      <div class="label">${esc(cueName(c))}</div>
      <div class="file">${missing ? '⚠ ' + esc(c.file ? 'Missing: ' + baseName(c.file.path) : 'No file') : esc(baseName(c.file.path))}</div>
      <button class="edit" data-edit="${c.id}" title="Edit cue">✎</button>
    </div>`;
  }).join('');
  const addTile = `<div class="add-tile" id="addTile"><div class="plus">+</div><div>Drop presentations here<br><small>or click to choose a file</small></div></div>`;
  const empty = show.cues.length === 0
    ? `<div class="empty-state"><b>Drop presentations here to build the show</b>PowerPoint, Keynote and PDF files each become a cue. Drop several at once to add them in order.</div>` : '';
  grid.innerHTML = empty + html + addTile;
}

function renderStatus() {
  renderUpdate();
  const live = runtime.liveCueId && cueById(runtime.liveCueId);
  const armed = runtime.armedCueId && cueById(runtime.armedCueId);
  const idx = (c) => show.cues.indexOf(c) + 1;
  const next = armed || (show.cues[0] && !live ? show.cues[0] : null);
  // Tally strip: the live cue (red) and the next cue (amber), numbered like the cue buttons.
  $('tallyLive').classList.toggle('on', !!live);
  $('tallyLive').style.borderLeftColor = '';
  $('liveNum').textContent = live ? idx(live) : '';
  $('liveText').textContent = live ? cueName(live) : 'Nothing live';
  $('liveSlide').textContent = live && runtime.liveSlide ? `${runtime.liveSlide}/${runtime.liveSlides}` : '';
  $('liveSlide').title = live && runtime.liveSlide ? `Slide ${runtime.liveSlide} of ${runtime.liveSlides}` : '';
  $('tallyNext').classList.toggle('on', !!next);
  $('armedNum').textContent = next ? idx(next) : '';
  $('armedText').textContent = next ? cueName(next) : (show.cues.length ? 'End of show' : 'No cues yet');
  const m = $('message');
  m.hidden = !runtime.message;
  m.textContent = runtime.message || '';
  m.title = (runtime.message || '') + ' (click to dismiss)';
  m.className = `message ${runtime.messageLevel || 'info'}`;
  $('blackoutBtn').classList.toggle('active', !!runtime.blackout);
}

function renderEditor() {
  const c = selectedId && cueById(selectedId);
  const ed = $('editor');
  if (!c || show.settings.locked) { ed.hidden = true; return; }
  ed.hidden = false;
  $('edNumber').textContent = `${show.cues.indexOf(c) + 1}`;
  if (document.activeElement !== $('edLabel')) { $('edLabel').value = c.label || ''; $('edLabel').placeholder = c.file ? stem(c.file.path) : 'Label'; }
  const fp = $('edFile');
  fp.textContent = c.file ? c.file.path : 'No file — choose one or drop a file on the cue';
  fp.classList.toggle('missing', !c.file || fileOk[c.file.path] === false);
  $('edReveal').disabled = !c.file;
  const isPdf = !!(c.file && ext(c.file.path) === '.pdf');
  $('edApp').innerHTML = appOptions(c.app, `Auto (${appInfo(resolvedApp({ ...c, app: 'auto' })).name})`, isPdf);
  $('edApp').disabled = isPdf;
  $('edAuto').value = c.autoSlideshow === true ? 'on' : c.autoSlideshow === false ? 'off' : 'default';
  if (document.activeElement !== $('edStart')) $('edStart').value = c.startSlide || 1;
  if (document.activeElement !== $('edDuration')) $('edDuration').value = c.duration || '';
  $('edOutput').innerHTML = outputOptions(c.output || 'default', true);
  $('edPresenter').checked = c.presenterControl !== false;
  const sc = c.shortcut && c.shortcut.accel;
  const btn = $('edShortcut');
  if (!(capture && capture.kind === 'cue')) { btn.textContent = sc ? prettyAccel(sc) : 'Click to set'; btn.classList.remove('capturing'); }
  $('edGlobal').checked = !!(c.shortcut && c.shortcut.global);
  const note = $('edShortcutNote');
  let noteText = '';
  let bad = false;
  if (sc && c.shortcut.global && shortcutReport[c.id]) { noteText = shortcutReport[c.id]; bad = true; }
  else if (sc && c.shortcut.global) noteText = 'Works everywhere, even while the slideshow is in front.';
  else if (sc) noteText = 'Works when Deck Cue is in front. Tick Global to use it while a slideshow is showing.';
  const dup = sc && show.cues.find((o) => o.id !== c.id && o.shortcut && o.shortcut.accel === sc);
  if (dup) { noteText = `Also used by cue ${show.cues.indexOf(dup) + 1} (${cueName(dup)})`; bad = true; }
  note.textContent = noteText;
  note.classList.toggle('bad', bad);
  $('edColors').innerHTML = COLORS.map((col) => `<span class="swatch${(c.color || COLORS[0]) === col ? ' on' : ''}" data-color="${col}" style="background:${col}"></span>`).join('');
  if (document.activeElement !== $('edNotes')) $('edNotes').value = c.notes || '';
  renderVersionBox(c);
  const pf = pfFor(c);
  $('edPreflight').innerHTML = pf ? pfItemsHtml(pf.items) : '<li class="info">Checking…</li>';
}

const GLOBAL_ACTIONS = [['go', 'GO (next cue)'], ['stop', 'Stop all'], ['blackout', 'Blackout'], ['next', 'Next slide'], ['prev', 'Previous slide']];
function renderSettings() {
  const s = show.settings;
  $('setPptApp').innerHTML = appOptions(s.pptApp, `Auto: first installed (${appInfo(env.pptApp).name})`);
  $('setClosePrev').checked = !!s.closePrevious;
  $('setCloseStop').checked = s.closeOnStop !== false;
  $('setTimerAuto').checked = s.timerAutoStart !== false;
  $('setNewer').value = s.newerVersions || 'ask';
  $('setBackdrop').checked = !!s.backdropDuringChangeover;
  $('setRefocus').checked = !!s.refocusAfterFire;
  $('globalKeys').innerHTML = GLOBAL_ACTIONS.map(([k, label]) => {
    const accel = s.globalKeys[k];
    const capturing = capture && capture.kind === 'global' && capture.key === k;
    return `<span>${label}</span>
      <div class="shortcut-box">
        <button class="btn small key-capture${capturing ? ' capturing' : ''}" data-gkey="${k}">${capturing ? 'Press keys…' : accel ? esc(prettyAccel(accel)) : 'Not set'}</button>
        ${accel ? `<button class="btn small ghost" data-gclear="${k}">Clear</button>` : ''}
      </div>
      ${shortcutReport[k] ? `<div class="note bad">${esc(shortcutReport[k])}</div>` : ''}`;
  }).join('');
  renderRemote();
  renderSync();
  renderPresenterSettings();
  renderMidiSettings();
  renderCenterSettings();
  renderFilesSettings();
  $('envInfo').innerHTML = `
    ${(env.apps || []).map((a) => `<div>${esc(a.name)}: ${a.installed ? '<span class="ok">installed</span>' : '<span class="bad">not found</span>'}</div>`).join('')}
    ${IS_MAC ? `<div>Accessibility (needed for WPS Office, and to send slideshows to a chosen output): ${env.accessibility ? '<span class="ok">allowed</span>' : '<span class="bad">not allowed</span> <button class="btn small" id="grantAx">Open settings</button>'}</div>
    <div class="env-note">The first time a cue fires, macOS asks to let Deck Cue control your presentation app. Click OK.</div>` : ''}`;
  const g = $('grantAx');
  if (g) g.onclick = () => api.requestAccessibility();
}

// ---------- updates ----------
// The button in the top bar is the notice everyone sees, with or without a Command Center.
let saidUpdated = false;
function renderUpdate() {
  const u = runtime.update;
  const btn = $('updateBtn');
  if (!u) { btn.hidden = true; return; }
  const v = u.available;
  const show = ['available', 'downloading', 'ready', 'installing'].includes(u.status) && !!v;
  btn.hidden = !show;
  btn.textContent = u.status === 'downloading' ? `Downloading ${u.percent}%` : u.status === 'installing' ? 'Updating…' : u.status === 'ready' ? `Update ${v} ready` : `Update ${v}`;
  btn.classList.toggle('ready', u.status === 'ready');

  const line = {
    idle: 'Not checked yet.',
    checking: 'Looking for a new version…',
    current: `You have the latest version (${u.current}).`,
    available: `Version ${v} is available. You have ${u.current}.`,
    downloading: `Downloading version ${v}: ${u.percent}%`,
    ready: `Version ${v} is downloaded.${u.willInstallOnQuit ? ' It installs when you close Deck Cue.' : ''}`,
    installing: `Installing version ${v}. Deck Cue starts again in a moment.`,
  }[u.status] || '';
  $('updateLine').textContent = line;
  const note = u.error || (show && u.blocked) || (show && u.busyWhy) || '';
  $('updateNote').hidden = !note;
  $('updateNote').textContent = note;
  const now = $('updateNow');
  now.hidden = !(show && !u.blocked && u.status !== 'installing');
  now.disabled = u.busy || u.status === 'downloading';
  now.textContent = u.status === 'downloading' ? 'Downloading…' : 'Update now';
  if (document.activeElement !== $('updateCheckOn')) $('updateCheckOn').checked = u.settings.check;
  if (document.activeElement !== $('updateAuto')) $('updateAuto').checked = u.settings.auto;
  $('updateAuto').disabled = !!u.blocked || !u.asset;
  $('updateMacNote').hidden = !IS_MAC;
  if (u.updatedFrom && !saidUpdated) {
    saidUpdated = true;
    flash(`Updated to version ${u.current}.${IS_MAC && !env.accessibility ? ' macOS needs the Accessibility permission again: Settings › This computer.' : ''}`, 'info');
    api.updateSeen();
  }
}

function openSettingsPane(pane) {
  $('settingsBtn').click();
  const b = document.querySelector(`.set-nav [data-pane="${pane}"]`);
  if (b) b.click();
}

// ---------- main / backup ----------
let sync = null; // { config, status }

function renderSyncBadge() {
  const el = $('syncBadge');
  const st = sync && sync.status;
  if (!st || st.role === 'standalone') { el.hidden = true; return; }
  el.hidden = false;
  let text;
  let level;
  if (st.role === 'main') {
    text = st.followers.length ? `MAIN · backup connected: ${st.followers.join(', ')}` : 'MAIN · no backup connected';
    level = st.followers.length ? 'ok' : 'warn';
    // A backup can be connected and still not follow: its show differs, or it is holding after this main came back.
    const trouble = st.followerTrouble || [];
    if (trouble.length) {
      const t = trouble[0];
      text = `MAIN · backup ${t.name} ${t.issue ? 'has a different show' : 'is holding'}${trouble.length > 1 ? ` (+${trouble.length - 1} more)` : ''}`;
      level = 'warn';
    }
  } else {
    const link = st.link || {};
    if (link.state === 'connected') { text = `BACKUP · following ${link.host}`; level = 'ok'; }
    else if (link.state === 'lost') { text = 'BACKUP · MAIN LOST — run the show from here'; level = 'bad'; }
    else if (link.state === 'connecting') { text = `BACKUP · connecting to ${link.host}…`; level = 'warn'; }
    else { text = 'BACKUP · set the main computer in Settings'; level = 'warn'; }
    if (st.held && link.state === 'connected') { text = `BACKUP · main back (${link.host}) — holding until the main's next action`; level = 'warn'; }
    if (st.issue && level === 'ok') { text += ' · shows differ'; level = 'warn'; }
  }
  el.textContent = text;
  el.title = (st.issue || '') + (st.link && st.link.error ? ` ${st.link.error}` : '')
    + (st.followerTrouble || []).map((t) => `${t.name}: ${t.issue || 'holding until the next action here (GO, play or Stop)'}`).join('\n');
  el.className = `sync-badge ${level}`;
}

function renderSync() {
  const box = $('syncSettings');
  if (!sync) { box.textContent = 'Loading…'; return; }
  const c = sync.config;
  const st = sync.status;
  const backup = c.role === 'backup';
  box.innerHTML = `
    <div class="grid2">
      <span>This computer is</span>
      <select data-sync="role">
        <option value="standalone"${c.role === 'standalone' ? ' selected' : ''}>Standalone</option>
        <option value="main"${c.role === 'main' ? ' selected' : ''}>Main (backups follow it)</option>
        <option value="backup"${backup ? ' selected' : ''}>Backup (follows a main)</option>
      </select>
      ${backup ? `<span>Main computer</span><div><input type="text" placeholder="IP or hostname" data-sync="mainHost" value="${esc(c.mainHost)}"> : <input type="number" min="1" max="65535" data-sync="mainPort" value="${c.mainPort}"></div>` : ''}
    </div>
    ${backup ? `<label class="toggle"><input type="checkbox" data-sync="mirrorBlackout" ${c.mirrorBlackout ? 'checked' : ''}><span>Follow blackout</span></label>
    <label class="toggle"><input type="checkbox" data-sync="mirrorTimer" ${c.mirrorTimer ? 'checked' : ''}><span>Follow speaker timer and stage messages</span></label>
    <div><button class="btn small" id="syncPull">Copy show from main</button> <span class="note" style="margin:0">Use the same show on both computers; files are found by name if their folder differs.</span></div>` : ''}
    ${c.role === 'main' ? `<div class="note" style="margin:0">On the backup computer choose “Backup” and enter this computer's address${remote && remote.addresses.length ? ` (${esc(remote.addresses.join(', '))})` : ''}, port ${remote ? remote.config.httpPort : 9640}. Remote control must allow other computers.</div>` : ''}
    ${st.issue ? `<div class="status-bad">${esc(st.issue)}</div>` : ''}
    ${(st.followerTrouble || []).map((t) => `<div class="status-bad">Backup ${esc(t.name)}: ${esc(t.issue || 'connected, but holding until the next action on this computer (GO, play or Stop).')}</div>`).join('')}`;
  const pull = $('syncPull');
  if (pull) pull.onclick = async () => {
    const r = await api.syncPull();
    if (r.error) flash(`Copy show failed: ${r.error}`, 'error');
    else if (r.replaced) flash(r.missing ? `Show copied. ${r.missing} file(s) still missing on this computer.` : 'Show copied from main.', r.missing ? 'warn' : 'info');
  };
}

async function saveSync(patch) {
  sync = await api.syncSet({ ...sync.config, ...patch });
  // A main must be reachable from the backup computer.
  if (sync.config.role === 'main' && remote && !remote.config.allowNetwork) await saveRemote({ allowNetwork: true });
  renderSync();
  renderSyncBadge();
}

// ---------- remote control settings ----------
let remote = null; // { config, status, addresses }

function statusLine(label, s) {
  const ok = s && s.startsWith('listening');
  return `<div>${label}: <span class="${ok ? 'status-ok' : 'status-bad'}">${esc(s || 'off')}</span></div>`;
}

function renderRemote() {
  const box = $('remoteControl');
  if (!remote) { box.textContent = 'Loading…'; return; }
  const c = remote.config;
  const host = c.allowNetwork ? (remote.addresses[0] || 'this-computer-ip') : '127.0.0.1';
  box.innerHTML = `
    <label class="toggle"><input type="checkbox" data-rc="enabled" ${c.enabled ? 'checked' : ''}><span>Enable remote control</span></label>
    <label class="toggle"><input type="checkbox" data-rc="allowNetwork" ${c.allowNetwork ? 'checked' : ''}><span>Allow other computers on the network (Companion on another machine)</span></label>
    <div class="grid2">
      <span>HTTP / WebSocket port</span><input type="number" min="1024" max="65535" data-rc="httpPort" value="${c.httpPort}">
      <span>OSC receive port (UDP)</span><input type="number" min="1024" max="65535" data-rc="oscPort" value="${c.oscPort}">
      <span>OSC feedback to</span><div><input type="text" placeholder="host (optional)" data-rc="oscFeedbackHost" value="${esc(c.oscFeedbackHost)}"> : <input type="number" min="1" max="65535" data-rc="oscFeedbackPort" value="${c.oscFeedbackPort}"></div>
    </div>
    ${c.enabled ? `${statusLine('HTTP', remote.status.http)}${statusLine('OSC', remote.status.osc)}
    <div class="addr">Stage display: <b>http://${esc(host)}:${c.httpPort}/stage</b> (timer only: <b>/stage?view=timer</b>)<br>
      <button class="btn small" id="openStage">Open stage display</button> <button class="btn small ghost" id="openStageTimer">Open timer only</button>${c.allowNetwork ? '' : '<br>Tick “Allow other computers” to open it on a tablet or another computer.'}</div>
    <div class="addr">Companion: host <b>${esc(host)}</b>, port <b>${c.httpPort}</b><br>OSC: send to ${esc(host)}:${c.oscPort} · /deckcue/go, /deckcue/cue/3/fire …${c.allowNetwork && remote.addresses.length > 1 ? `<br>Other addresses of this computer: ${esc(remote.addresses.slice(1).join(', '))}` : ''}</div>` : ''}`;
  wireRemoteButtons();
}

function wireRemoteButtons() {
  const a = $('openStage');
  const b = $('openStageTimer');
  if (a) a.onclick = () => api.openStage('full');
  if (b) b.onclick = () => api.openStage('timer');
}

async function saveRemote(patch) {
  remote = await api.controlSet({ ...remote.config, ...patch });
  renderRemote();
}

// ---------- speaker timer and stage message ----------
function fmtTimer(ms) {
  const over = ms < 0;
  const total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${over ? '+' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${sec}`;
}

function tickTimer() {
  const t = runtime.timer;
  const el = $('timerDisplay');
  if (!t) return;
  const remaining = t.running ? t.endsAt - Date.now() : t.remaining;
  const idle = !t.running && !t.duration && !t.remaining;
  el.textContent = idle ? '00:00' : fmtTimer(remaining);
  el.className = `timer-display${idle ? ' idle' : ''}${!idle && !t.running ? ' paused' : ''}${!idle && remaining < 0 ? ' over' : !idle && remaining <= 120000 ? ' warn' : ''}`;
  $('timerStart').textContent = t.running ? 'Pause' : 'Start';
  // How much of the time has been used.
  const used = idle || !t.duration ? 0 : Math.min(1, Math.max(0, 1 - remaining / t.duration));
  $('timerBar').style.width = `${used * 100}%`;
  $('timerBar').parentElement.className = `timer-bar${!idle && remaining < 0 ? ' over' : !idle && remaining <= 120000 ? ' warn' : ''}`;
}

// "5" = 5 minutes, "2:30" = 2 min 30 s, "1:00:00" = 1 hour.
function parseDuration(text) {
  const parts = String(text).trim().split(':').map((p) => Number(p));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 60);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ---------- saved timers ----------
const presetLabel = (p) => `${p.name ? `${p.name} ` : ''}${p.minutes}`;

function renderPresets() {
  const list = show.settings.timerPresets || [];
  $('timerPresets').innerHTML = list.map((p, i) => `<button class="preset" data-preset="${i + 1}" title="Start a ${p.minutes}-minute timer${p.name ? ` (${esc(p.name)})` : ''}">${esc(presetLabel(p))}</button>`).join('');
}

function renderPresetsEditor() {
  const list = show.settings.timerPresets || [];
  $('presetsList').innerHTML = list.map((p, i) => `<div class="preset-row" data-row="${i}">
      <input data-pname value="${esc(p.name)}" placeholder="Name (optional)" maxlength="24">
      <input data-pmin type="number" min="0.5" max="1440" step="0.5" value="${p.minutes}" aria-label="Minutes">
      <span>min</span>
      <button class="btn ghost small" data-premove>Remove</button>
    </div>`).join('') || '<p class="hint">No saved timers yet.</p>';
  $('presetsAdd').disabled = list.length >= 10;
}

function setupPresets() {
  $('presetsEdit').onclick = () => { $('presetsModal').hidden = false; renderPresetsEditor(); };
  $('timerPresets').onclick = (e) => {
    const n = e.target.dataset.preset;
    if (n) api.timerCmd('preset', Number(n));
  };
  const save = () => { commit(); };
  $('presetsList').addEventListener('change', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    const p = show.settings.timerPresets[Number(row.dataset.row)];
    if (e.target.matches('[data-pname]')) p.name = e.target.value.trim();
    if (e.target.matches('[data-pmin]')) p.minutes = Math.min(1440, Math.max(0.5, Number(e.target.value) || p.minutes));
    save();
  });
  $('presetsList').addEventListener('click', (e) => {
    if (!e.target.matches('[data-premove]')) return;
    show.settings.timerPresets.splice(Number(e.target.closest('[data-row]').dataset.row), 1);
    save();
    renderPresetsEditor();
  });
  $('presetsAdd').onclick = () => {
    const list = show.settings.timerPresets;
    list.push({ name: '', minutes: list.length ? list[list.length - 1].minutes + 5 : 5 });
    save();
    renderPresetsEditor();
  };
  const close = () => { $('presetsModal').hidden = true; };
  $('presetsClose').onclick = close;
  $('presetsModal').onclick = (e) => { if (e.target === $('presetsModal')) close(); };
}

function setupStageBar() {
  $('timerSet').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const text = e.target.value.trim();
    if (!text) return; // Return in the empty box must not wipe a running timer
    // "@15:30" counts down to that time of day.
    const until = /^@\s*(\d{1,2}[:.]\d{2})$/.exec(text);
    if (until) {
      api.timerCmd('until', until[1].replace('.', ':'));
    } else {
      const seconds = parseDuration(text);
      if (seconds === null) return flash('Timer: type minutes (5), minutes and seconds (2:30), or @15:30 for a time of day.', 'warn');
      api.timerCmd('set', seconds);
    }
    e.target.value = '';
    e.target.blur();
  });
  $('timerMinus').onclick = () => api.timerCmd('add', -60);
  $('timerPlus').onclick = () => api.timerCmd('add', 60);
  $('timerStart').onclick = () => api.timerCmd(runtime.timer && runtime.timer.running ? 'pause' : 'start');
  $('timerReset').onclick = () => api.timerCmd('reset');
  const send = () => api.stageMessage($('stageMsg').value.trim(), $('stageFlash').checked);
  $('stageMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { send(); e.target.blur(); } });
  // Flash works at once and by itself: it blinks what is on stage now (a half-typed message is not sent by it).
  $('stageFlash').onchange = (e) => api.stageFlash(e.target.checked);
  $('stageClear').onclick = () => { $('stageMsg').value = ''; api.stageMessage('', false); };
  setInterval(tickTimer, 250);
}

// ---------- cue operations ----------
function newCue(path) {
  return { id: uid(), label: '', file: path ? { path } : null, app: 'auto', autoSlideshow: null, startSlide: 1, output: 'default', shortcut: null, color: COLORS[0], notes: '' };
}

const cueList = (numbers) => `cue ${numbers.join(', ')}`;

// Copies a dropped file into the show folder (so a USB stick can be removed). Asks before replacing a
// different file of the same name. Returns what main reported, or null when cancelled or failed.
// ---------- a question with named answers ----------
// Bigger and clearer than the system's OK / Cancel box, and it can offer three answers.
let chooseDone = null;
function choose({ title, lines = [], warn = '', buttons, all = '' }) {
  return new Promise((resolve) => {
    $('chooseTitle').textContent = title;
    $('chooseLines').innerHTML = lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join('');
    $('chooseWarn').hidden = !warn;
    $('chooseWarn').textContent = warn;
    $('chooseAllWrap').hidden = !all;
    $('chooseAllText').textContent = all;
    $('chooseAll').checked = false;
    $('chooseButtons').innerHTML = buttons.map((b) => `<button class="btn ${b.kind || ''}" data-choice="${esc(b.id)}">${esc(b.label)}</button>`).join('');
    chooseDone = (id) => { chooseDone = null; $('chooseModal').hidden = true; resolve({ id, all: $('chooseAll').checked }); };
    $('chooseModal').hidden = false;
    const first = $('chooseButtons').querySelector('.go') || $('chooseButtons').querySelector('button');
    if (first) first.focus();
  });
}
const when = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Copy one file into the show folder. A different file with the same name is never overwritten without asking.
let importRule = null; // the answer the operator gave "for the other files too" in one drop
async function importPath(p, more = 0, justAdded = []) {
  const copying = `Copying ${baseName(p)} into the show folder…`;
  let r = await working(copying, () => api.importFile(p));
  if (r.conflict) {
    let mode = importRule;
    if (!mode) {
      // A newer file for a cue that uses that name is most likely its new version; anything else is safer kept apart.
      const likelyNewVersion = r.usedBy.length > 0 && !r.older;
      const ans = await choose({
        title: `“${r.name}” is already in the show folder`,
        lines: [
          r.usedBy.length ? `It is the file of ${cueList(r.usedBy)}.` : justAdded.includes(r.name.toLowerCase()) ? 'You added a file with this name a moment ago.' : 'No cue uses it at the moment.',
          `In the folder: ${when(r.existingDate)}. The one you added: ${when(r.incomingDate)}.`,
          'Replace makes this the new version (the old one goes to the Trash). Keep both adds it as a separate presentation.',
        ],
        warn: r.older ? 'The file you added is OLDER than the one in the folder.' : '',
        all: more > 0 ? 'Do the same for the other files in this drop' : '',
        buttons: likelyNewVersion
          ? [{ id: 'replace', label: 'Replace', kind: 'go' }, { id: 'keep', label: 'Keep both' }, { id: 'cancel', label: 'Skip this file', kind: 'ghost' }]
          : [{ id: 'keep', label: 'Keep both', kind: 'go' }, { id: 'replace', label: 'Replace' }, { id: 'cancel', label: 'Skip this file', kind: 'ghost' }],
      });
      if (ans.id === 'cancel') return null;
      mode = ans.id;
      if (ans.all) importRule = mode;
    }
    r = await working(copying, () => api.importFile(p, mode));
  }
  if (r.error) { flash(r.error, 'error'); return null; }
  return r;
}

async function addFiles(paths, beforeIndex = show.cues.length) {
  const ok = paths.filter(isSupported);
  const rejected = paths.length - ok.length;
  const cues = [];
  const updated = [];
  const already = [];
  importRule = null;
  const justAdded = [];
  let mediaCopied = 0;
  for (let i = 0; i < ok.length; i++) {
    const r = await importPath(ok[i], ok.length - i - 1, justAdded);
    if (!r) continue;
    justAdded.push(baseName(r.path).toLowerCase());
    // A file that a cue already uses was replaced in place: that cue has the new version, no second cue.
    if (r.usedBy && r.usedBy.length) { (r.same ? already : updated).push(...r.usedBy); continue; }
    if (r.media && r.media.length) mediaCopied += r.media.length;
    cues.push(newCue(r.path));
  }
  importRule = null;
  if (cues.length) {
    show.cues.splice(beforeIndex, 0, ...cues);
    if (!runtime.armedCueId) api.arm(cues[0].id);
  }
  await refreshFileStatus();
  if (cues.length) await commit(); else render();
  if (rejected) flash(`${rejected} file(s) skipped. Supported: ${env.supportedExt.join(' ')}`, 'warn');
  else if (updated.length) flash(`${cueList(updated).replace(/^c/, 'C')} now ${updated.length === 1 ? 'has' : 'have'} the new version. The old one is in the Trash.`, 'info');
  else if (already.length && !cues.length) flash(`That file is already in the show as ${cueList(already)}.`, 'info');
  else if (mediaCopied) flash(`${mediaCopied} linked video or sound file${mediaCopied === 1 ? '' : 's'} came along with the presentation.`, 'info');
}

async function replaceFile(id, p) {
  if (!isSupported(p)) return flash(`Not a presentation: ${baseName(p)}`, 'warn');
  const c = cueById(id);
  const n = show.cues.indexOf(c) + 1;
  if (c.file) {
    const ans = await choose({
      title: `Replace the file of cue ${n}?`,
      lines: [`Cue ${n} “${cueName(c)}” will play ${baseName(p)} from now on.`, 'The file it plays now goes to the Trash, so the show folder keeps only the latest version.'],
      buttons: [{ id: 'replace', label: 'Replace', kind: 'go' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
    });
    if (ans.id !== 'replace') return;
  }
  const copying = `Copying ${baseName(p)} into the show folder…`;
  let r = await working(copying, () => api.importFile(p));
  let note = '';
  if (r.conflict) {
    // A file with that name is in the folder already. If it is this cue's own file, this is its new version.
    // If another cue uses it, it is a different presentation that happens to have the same name: leave it alone.
    const own = r.usedBy.length === 1 && r.usedBy[0] === n;
    if (own && r.older) {
      const ans = await choose({
        title: 'That file is older',
        lines: [`The file cue ${n} plays now: ${when(r.existingDate)}.`, `The file you dropped: ${when(r.incomingDate)}.`],
        warn: 'The file you dropped is OLDER than the one the cue plays now.',
        buttons: [{ id: 'cancel', label: 'Keep the newer one', kind: 'go' }, { id: 'replace', label: 'Use the older file' }],
      });
      if (ans.id !== 'replace') return;
    }
    const others = r.usedBy.filter((x) => x !== n);
    r = await working(copying, () => api.importFile(p, own ? 'replace' : 'keep'));
    if (!own && !r.error) note = ` ${others.length ? `${cueList(others).replace(/^c/, 'C')} plays a different file with that name` : 'A different file with that name is in the folder'}, so this one was saved as ${baseName(r.path)}.`;
  }
  if (r.error) return flash(r.error, 'error');
  const old = c.file ? c.file.path : null;
  c.file = { path: r.path };
  await refreshFileStatus();
  await commit();
  if (old) api.retireFile(old, r.path);
  flash(`Cue ${n} now plays ${baseName(r.path)}.${note}`, 'info');
}

function moveCue(id, beforeId) {
  const from = show.cues.findIndex((c) => c.id === id);
  if (from < 0 || id === beforeId) return;
  // Dropped on another cue: it takes that cue's place. Moving down, that is after it; moving up, before it.
  const target = beforeId ? show.cues.findIndex((x) => x.id === beforeId) : -1;
  const [c] = show.cues.splice(from, 1);
  show.cues.splice(target < 0 ? show.cues.length : target, 0, c);
  commit();
}

function updateSelected(patch) {
  const c = cueById(selectedId);
  if (!c) return;
  Object.assign(c, patch);
  commit();
}

let flashTimer = null;
let localFlash = null; // a message from this window; it must outlive state updates from the main process
// An error stays until it is clicked away: it must not vanish while the operator looks at the stage.
// stay = true keeps any other message up too (used while something is being copied; see working()).
function flash(msg, level, stay) {
  const keep = stay || level === 'error';
  localFlash = { msg, level, until: keep ? Infinity : Date.now() + 6000 };
  runtime = { ...runtime, message: msg, messageLevel: level };
  renderStatus();
  clearTimeout(flashTimer);
  if (!keep) flashTimer = setTimeout(() => clearFlash(msg), 6000);
}
function clearFlash(msg) {
  if (localFlash && localFlash.msg === msg) localFlash = null;
  if (runtime.message === msg) { runtime = { ...runtime, message: null }; renderStatus(); }
}
// Shows "Copying …" for as long as the work takes (a deck with videos can take a while), then removes it.
async function working(msg, job) {
  flash(msg, 'info', true);
  try { return await job(); } finally { clearFlash(msg); }
}

// ---------- drag & drop ----------
let dragCueId = null;
const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
const isCueDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types).includes(CUE_MIME);
function clearDropMarks() {
  document.querySelectorAll('.drop-target, .move-target').forEach((el) => el.classList.remove('drop-target', 'move-target'));
  $('grid').classList.remove('drop-empty');
}

function setupDragDrop() {
  const grid = $('grid');
  // Prevent Electron from navigating to a file dropped anywhere else.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('dragenter', (e) => { if (isFileDrag(e) && !show.settings.locked) $('dropHint').hidden = false; });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) { $('dropHint').hidden = true; clearDropMarks(); } });

  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest('.cue');
    if (!tile || show.settings.locked) return;
    dragCueId = tile.dataset.id;
    e.dataTransfer.setData(CUE_MIME, dragCueId);
    e.dataTransfer.effectAllowed = 'move';
    tile.classList.add('dragging');
  });
  grid.addEventListener('dragend', () => { dragCueId = null; clearDropMarks(); document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging')); });

  grid.addEventListener('dragover', (e) => {
    if (show.settings.locked || !(isFileDrag(e) || isCueDrag(e))) return;
    e.preventDefault();
    const tile = e.target.closest('.cue');
    const add = e.target.closest('.add-tile');
    clearDropMarks();
    if (tile) {
      if (isFileDrag(e)) { tile.classList.add('drop-target'); e.dataTransfer.dropEffect = 'copy'; }
      else if (tile.dataset.id !== dragCueId) { tile.classList.add('move-target'); e.dataTransfer.dropEffect = 'move'; }
    } else if (add) {
      add.classList.add('drop-target');
    } else {
      grid.classList.add('drop-empty');
    }
  });

  grid.addEventListener('drop', async (e) => {
    e.preventDefault();
    $('dropHint').hidden = true;
    clearDropMarks();
    if (show.settings.locked) return;
    const tile = e.target.closest('.cue');
    if (isCueDrag(e)) {
      moveCue(e.dataTransfer.getData(CUE_MIME), tile ? tile.dataset.id : null);
      return;
    }
    const paths = Array.from(e.dataTransfer.files).map((f) => api.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    if (tile) {
      await replaceFile(tile.dataset.id, paths[0]);
      if (paths.length > 1) await addFiles(paths.slice(1), show.cues.findIndex((c) => c.id === tile.dataset.id) + 1);
    } else {
      await addFiles(paths);
    }
  });

  grid.addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) { selectedId = edit.dataset.edit; render(); return; }
    if (e.target.closest('.add-tile')) {
      const p = await api.pickFile();
      if (p) addFiles([p]);
      return;
    }
    const tile = e.target.closest('.cue');
    if (!tile) return;
    const id = tile.dataset.id;
    if (e.altKey) { api.arm(id); return; }
    if (selectedId && !show.settings.locked) selectedId = id;
    api.fire(id);
  });
  grid.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.cue');
    if (!tile || show.settings.locked) return;
    e.preventDefault();
    selectedId = tile.dataset.id;
    render();
  });
}

// ---------- editor & settings wiring ----------
function setupEditor() {
  $('edClose').onclick = () => { selectedId = null; capture = null; render(); };
  $('edLabel').oninput = (e) => updateSelected({ label: e.target.value });
  $('edApp').onchange = (e) => updateSelected({ app: e.target.value });
  $('edAuto').onchange = (e) => updateSelected({ autoSlideshow: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null });
  $('edStart').oninput = (e) => updateSelected({ startSlide: Math.max(1, parseInt(e.target.value, 10) || 1) });
  $('edDuration').oninput = (e) => updateSelected({ duration: Math.max(0, parseFloat(e.target.value) || 0) || null });
  $('edPresenter').onchange = (e) => updateSelected({ presenterControl: e.target.checked });
  $('edOutput').onchange = (e) => updateSelected({ output: outputFromValue(e.target.value, cueById(selectedId).output) });
  $('edNotes').oninput = (e) => updateSelected({ notes: e.target.value });
  $('edColors').onclick = (e) => { const s = e.target.closest('[data-color]'); if (s) updateSelected({ color: s.dataset.color }); };
  $('edPick').onclick = async () => { const p = await api.pickFile(); if (p) replaceFile(selectedId, p); };
  $('edReveal').onclick = () => { const c = cueById(selectedId); if (c && c.file) api.reveal(c.file.path); };
  $('edShortcut').onclick = () => { capture = { kind: 'cue' }; $('edShortcut').textContent = 'Press keys…'; $('edShortcut').classList.add('capturing'); };
  $('edShortcutClear').onclick = () => { capture = null; updateSelected({ shortcut: null }); };
  $('edGlobal').onchange = (e) => {
    const c = cueById(selectedId);
    const accel = c.shortcut && c.shortcut.accel;
    if (e.target.checked && accel && !globalAllowed(accel)) {
      e.target.checked = false;
      flash(`Global shortcuts need ${MOD_TEXT}, or an F-key, so they don’t block keys the slideshow uses.`, 'warn');
      return;
    }
    updateSelected({ shortcut: accel ? { accel, global: e.target.checked } : null });
  };
  $('edTest').onclick = () => api.fire(selectedId);
  $('edPreflightRun').onclick = () => api.preflightRun();
  $('edVersion').onclick = (e) => {
    const act = e.target.dataset && e.target.dataset.ver;
    if (act === 'use') api.versionUse(selectedId);
    else if (act === 'ignore') api.versionIgnore(selectedId);
    else if (act === 'clear') api.versionClear(selectedId);
  };
  $('setNewer').onchange = (e) => { show.settings.newerVersions = e.target.value; commit(); };
  $('preflightBtn').onclick = () => { api.preflightRun(); $('preflightModal').hidden = false; renderPreflightReport(); };
  $('preflightRerun').onclick = () => api.preflightRun();
  $('preflightClose').onclick = () => { $('preflightModal').hidden = true; };
  $('preflightModal').onclick = (e) => { if (e.target === $('preflightModal')) $('preflightModal').hidden = true; };
  $('edDuplicate').onclick = () => {
    const c = cueById(selectedId);
    const copy = { ...JSON.parse(JSON.stringify(c)), id: uid(), shortcut: null };
    show.cues.splice(show.cues.indexOf(c) + 1, 0, copy);
    selectedId = copy.id;
    commit();
  };
  $('edDelete').onclick = () => {
    const c = cueById(selectedId);
    if (c.id === runtime.liveCueId || c.id === runtime.busyCueId) return flash('That cue is live. Stop it first, then delete it.', 'warn');
    if (!confirm(`Delete cue ${show.cues.indexOf(c) + 1} “${cueName(c)}”?`)) return;
    show.cues = show.cues.filter((x) => x.id !== selectedId);
    selectedId = null;
    commit();
  };

  $('settingsBtn').onclick = async () => {
    env = await api.env();
    remote = await api.controlGet();
    sync = await api.syncGet();
    presenter = await api.presenterGet();
    centerInfo = await api.centerGet();
    filesPrefs = await api.filesPrefs();
    $('settings').hidden = false;
    renderSettings();
  };
  $('presenterSettings').addEventListener('change', async (e) => {
    if (e.target.dataset.pr === 'enabled') {
      presenter = await api.presenterSet({ enabled: e.target.checked });
      remote = await api.controlGet();
      renderPresenterSettings(); renderRemote(); renderPresenterChip();
    }
  });
  $('presenterSettings').addEventListener('click', async (e) => {
    if (e.target.dataset.pr === 'newPin') { presenter = await api.presenterSet({ newPin: true }); renderPresenterSettings(); }
  });
  $('presenterChip').onclick = () => api.presenterMute();
  $('syncSettings').addEventListener('change', (e) => {
    const key = e.target.dataset.sync;
    if (!key) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value.trim();
    saveSync({ [key]: value });
  });
  $('remoteControl').addEventListener('change', (e) => {
    const key = e.target.dataset.rc;
    if (!key) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value.trim();
    saveRemote({ [key]: value });
  });
  $('settingsClose').onclick = () => { $('settings').hidden = true; capture = null; };
  $('settings').onclick = (e) => {
    if (e.target === $('settings')) { $('settings').hidden = true; capture = null; return; }
    const g = e.target.closest('[data-gkey]');
    if (g) { capture = { kind: 'global', key: g.dataset.gkey }; renderSettings(); }
    const cl = e.target.closest('[data-gclear]');
    if (cl) { show.settings.globalKeys[cl.dataset.gclear] = ''; commit(); }
  };
  $('setPptApp').onchange = async (e) => { show.settings.pptApp = e.target.value; await api.updateShow(show); env = await api.env(); render(); };
  $('setTimerAuto').onchange = (e) => { show.settings.timerAutoStart = e.target.checked; commit(); };
  $('setClosePrev').onchange = (e) => { show.settings.closePrevious = e.target.checked; commit(); };
  $('setCloseStop').onchange = (e) => { show.settings.closeOnStop = e.target.checked; commit(); };
  $('setBackdrop').onchange = (e) => { show.settings.backdropDuringChangeover = e.target.checked; commit(); };
  $('setRefocus').onchange = (e) => { show.settings.refocusAfterFire = e.target.checked; commit(); };

  $('showName').oninput = (e) => { show.showName = e.target.value; commit(); };
  $('defaultOutput').onchange = (e) => { show.settings.defaultOutput = outputFromValue(e.target.value, show.settings.defaultOutput); commit(); };
  $('defaultAuto').onchange = (e) => { show.settings.defaultAutoSlideshow = e.target.checked; commit(); };
  $('identifyBtn').onclick = () => api.identify();
  $('lockBtn').onclick = () => { show.settings.locked = !show.settings.locked; if (show.settings.locked) selectedId = null; commit(); };

  $('goBtn').onclick = () => api.go();
  $('stopBtn').onclick = () => api.stop();
  $('blackoutBtn').onclick = () => api.blackout();
  $('nextBtn').onclick = () => api.nav('next');
  $('prevBtn').onclick = () => api.nav('previous');
  $('message').onclick = () => {
    localFlash = null;
    clearTimeout(flashTimer);
    runtime = { ...runtime, message: null };
    renderStatus();
    api.clearMessage();
  };
}

// ---------- keyboard ----------
function handleCapture(e) {
  e.preventDefault();
  if (e.code === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) { capture = null; render(); return; }
  if (['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) return;
  const accel = accelFromEvent(e);
  if (!accel) return;
  if (capture.kind === 'global') {
    if (!globalAllowed(accel)) { flash(`${prettyAccel(accel)} can’t be global. Use ${MOD_TEXT} with a key, or an F-key.`, 'warn'); return; }
    show.settings.globalKeys[capture.key] = accel;
  } else {
    if (RESERVED_LOCAL.includes(accel)) { flash(`${prettyAccel(accel)} is used by Deck Cue itself (GO, Stop, slides, Blackout).`, 'warn'); return; }
    const c = cueById(selectedId);
    const wantGlobal = c.shortcut ? c.shortcut.global : globalAllowed(accel);
    c.shortcut = { accel, global: wantGlobal && globalAllowed(accel) };
  }
  capture = null;
  commit();
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (capture) return handleCapture(e);
    if (!$('chooseModal').hidden) { if (e.key === 'Escape' && chooseDone) chooseDone('cancel'); return; }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (!$('settings').hidden) { if (e.key === 'Escape') $('settings').hidden = true; return; }
    if (!$('preflightModal').hidden) { if (e.key === 'Escape') $('preflightModal').hidden = true; return; }
    if (!$('showModeModal').hidden) { if (e.key === 'Escape') $('showModeModal').hidden = true; return; }
    if (!$('timerScreenModal').hidden) { if (e.key === 'Escape') $('tsClose').click(); return; }
    if (!$('presetsModal').hidden) { if (e.key === 'Escape') $('presetsModal').hidden = true; return; }
    const accel = accelFromEvent(e);
    if (!accel) return;
    // A key that is held down repeats: one press is one action, or a held Space runs through the cues.
    if (e.repeat) { e.preventDefault(); return; }
    // Esc with the cue editor open closes the editor. It does not stop the show.
    if (accel === 'Escape' && selectedId) { e.preventDefault(); $('edClose').click(); return; }
    // Cue shortcuts (global ones are handled by the main process, which also fires while we're focused).
    const cue = show.cues.find((c) => c.shortcut && c.shortcut.accel === accel && !c.shortcut.global);
    if (cue) { e.preventDefault(); api.fire(cue.id); return; }
    if (show.cues.some((c) => c.shortcut && c.shortcut.global && c.shortcut.accel === accel)) return;
    switch (accel) {
      case 'Space': e.preventDefault(); api.go(); break;
      case 'Escape': e.preventDefault(); api.stop(); break;
      case 'Right': e.preventDefault(); api.nav('next'); break;
      case 'Left': e.preventDefault(); api.nav('previous'); break;
      case 'B': e.preventDefault(); api.blackout(); break;
      case 'Up': case 'Down': {
        e.preventDefault();
        const i = show.cues.findIndex((c) => c.id === runtime.armedCueId);
        const n = Math.min(show.cues.length - 1, Math.max(0, (i < 0 ? 0 : i) + (accel === 'Down' ? 1 : -1)));
        if (show.cues[n]) api.arm(show.cues[n].id);
        break;
      }
      case 'Delete': case 'Backspace':
        if (selectedId && !show.settings.locked) $('edDelete').click();
        break;
      default:
    }
  });
}

// ---------- boot ----------
async function init() {
  document.body.classList.add(IS_MAC ? 'mac' : 'win');
  env = await api.env();
  displays = await api.displays();
  const r = await api.getShow();
  show = r.show;
  shortcutReport = r.shortcutReport || {};
  runtime = r.state || {};
  await api.resolveFiles().then((s) => { show = s; });
  await refreshFileStatus();
  setupDragDrop();
  setupEditor();
  setupKeyboard();
  setupStageBar();
  setupPresets();
  setupShowMode();
  setupTimerScreen();
  setupCenter();
  setupFilesSettings();
  setupMidi();
  midi = await api.midiGet();
  startMidi();
  await loadPresenter();
  render();
  renderShowModeIndicators();
  renderTimerScreenStatus();

  api.on('state', (s) => {
    runtime = s;
    if (s.message && localFlash && localFlash.until !== Infinity) localFlash = null; // the app said something newer
    if (!s.message && localFlash && Date.now() < localFlash.until) runtime = { ...s, message: localFlash.msg, messageLevel: localFlash.level };
    renderGrid();
    renderStatus();
    renderPreflightButton();
    renderShowModeIndicators();
    renderPresenterChip();
    renderTimerScreenStatus();
    if (!$('timerScreenModal').hidden) renderTimerScreenModal();
    if (selectedId) renderEditor();
    if (!$('preflightModal').hidden) renderPreflightReport();
    tickTimer();
    const onStage = (s.stageMessage && s.stageMessage.text) || '';
    $('stageMsg').classList.toggle('sent', !!onStage);
    // Show what's on stage now (from here, Companion or a backup's main), unless the operator is typing.
    if (document.activeElement !== $('stageMsg')) $('stageMsg').value = onStage;
    const flashing = !!(s.stageMessage && s.stageMessage.flash);
    $('stageFlash').checked = flashing; // the switch shows what the stage sees now, whoever set it
    $('stageFlash').closest('label').classList.toggle('flashing', flashing);
  });
  api.on('show', async (p) => {
    show = p.show; shortcutReport = p.shortcutReport || {};
    if (selectedId && !cueById(selectedId)) selectedId = null;
    await refreshFileStatus();
    render();
  });
  api.on('displays', (d) => { displays = d; render(); });
  api.on('thumbs', (t) => { thumbs = t || {}; renderGrid(); });
  api.on('centers', (names) => {
    if (centerInfo) centerInfo.centers = names;
    renderCenterChip();
    if (!$('settings').hidden) renderCenterSettings();
  });
  centerInfo = await api.centerGet();
  renderCenterChip();
  thumbs = (await api.thumbsGet()) || {};
  sync = await api.syncGet();
  renderSyncBadge();
  api.on('sync', (status) => { if (sync) { sync.status = status; renderSyncBadge(); if (!$('settings').hidden) renderSync(); } });
  api.on('control-status', (status) => { if (remote) { remote.status = status; if (!$('settings').hidden) renderRemote(); } });
  // Coming back to the app (after editing a deck, installing a font…) re-checks; unchanged files are cached.
  window.addEventListener('focus', async () => { await refreshFileStatus(); renderGrid(); renderEditor(); api.preflightRun(); });
  api.on('files-changed', async () => { await refreshFileStatus(); renderGrid(); renderEditor(); });
}

init();
