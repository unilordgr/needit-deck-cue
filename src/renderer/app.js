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
let capture = null; // { kind: 'cue' } | { kind: 'global', key }

// ---------- helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const baseName = (p) => (p || '').split('/').pop();
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
  let matched = !current || current === 'auto' || current === 'default';
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
  if (v === 'default' || v === 'auto') return v;
  if (v === 'missing') return previous;
  const d = displays.find((x) => String(x.id) === v);
  return d ? outputRef(d) : 'auto';
}
function outputShortLabel(ref) {
  if (!ref || ref === 'default') return null;
  if (ref === 'auto') return 'App picks';
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

// ---------- show-machine mode ----------
let showModeInfo = null; // { active, quietOk, items, apps }
let showModeCfg = null;

function renderShowModeIndicators() {
  const on = !!runtime.showMode;
  $('showModeBadge').hidden = !on;
  $('showModeBtn').classList.toggle('on', on);
  $('showModeBtn').textContent = on ? 'Show mode ON' : 'Show mode';
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
  $('lockBtn').textContent = show.settings.locked ? '🔒 Locked' : '🔓 Unlocked';
  $('lockBtn').classList.toggle('locked', !!show.settings.locked);
  renderGrid();
  renderStatus();
  renderEditor();
  renderPreflightButton();
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
      missing && 'missing'].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${c.id}" draggable="${!show.settings.locked}" style="--cue-color:${esc(c.color || COLORS[0])}">
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
    ? `<div class="empty-state"><b>No cues yet.</b><br>Drag .pptx, .key or .pdf files anywhere in this window to create cues.</div>` : '';
  grid.innerHTML = empty + html + addTile;
}

function renderStatus() {
  const live = runtime.liveCueId && cueById(runtime.liveCueId);
  const armed = runtime.armedCueId && cueById(runtime.armedCueId);
  const idx = (c) => show.cues.indexOf(c) + 1;
  $('liveText').textContent = live ? `${idx(live)} · ${cueName(live)}${runtime.liveDetail ? ` · ${runtime.liveDetail}` : ''}` : '—';
  $('armedText').textContent = armed ? `${idx(armed)} · ${cueName(armed)}` : (show.cues[0] && !live ? `1 · ${cueName(show.cues[0])}` : '—');
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
  $('envInfo').innerHTML = `
    ${(env.apps || []).map((a) => `<div>${esc(a.name)}: ${a.installed ? '<span class="ok">installed</span>' : '<span class="bad">not found</span>'}</div>`).join('')}
    ${IS_MAC ? `<div>Accessibility (needed for WPS Office, and to send slideshows to a chosen output): ${env.accessibility ? '<span class="ok">allowed</span>' : '<span class="bad">not allowed</span> <button class="btn small" id="grantAx">Open settings</button>'}</div>
    <div style="color:var(--muted);font-size:12px">The first time a cue fires, macOS asks to let Deck Cue control your presentation app. Click OK.</div>` : ''}`;
  const g = $('grantAx');
  if (g) g.onclick = () => api.requestAccessibility();
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
  el.title = (st.issue || '') + (st.link && st.link.error ? ` ${st.link.error}` : '');
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
    ${st.issue ? `<div class="status-bad">${esc(st.issue)}</div>` : ''}`;
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
  el.textContent = idle ? '--:--' : fmtTimer(remaining);
  el.className = `timer-display${idle ? ' idle' : ''}${!idle && !t.running ? ' paused' : ''}${!idle && remaining < 0 ? ' over' : !idle && remaining <= 120000 ? ' warn' : ''}`;
  $('timerStart').textContent = t.running ? '⏸' : '▶';
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

function setupStageBar() {
  $('timerSet').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const seconds = parseDuration(e.target.value);
    if (seconds === null) return flash('Timer: type minutes (5), mm:ss (2:30) or h:mm:ss.', 'warn');
    api.timerCmd('set', seconds);
    e.target.value = '';
    e.target.blur();
  });
  $('timerStart').onclick = () => api.timerCmd(runtime.timer && runtime.timer.running ? 'pause' : 'start');
  $('timerReset').onclick = () => api.timerCmd('reset');
  const send = () => api.stageMessage($('stageMsg').value.trim(), $('stageFlash').checked);
  $('stageMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter') { send(); e.target.blur(); } });
  $('stageFlash').onchange = () => { if (runtime.stageMessage && runtime.stageMessage.text) send(); };
  $('stageClear').onclick = () => { $('stageMsg').value = ''; api.stageMessage('', false); };
  setInterval(tickTimer, 250);
}

// ---------- cue operations ----------
function newCue(path) {
  return { id: uid(), label: '', file: path ? { path } : null, app: 'auto', autoSlideshow: null, startSlide: 1, output: 'default', shortcut: null, color: COLORS[0], notes: '' };
}

async function addFiles(paths, beforeIndex = show.cues.length) {
  const ok = paths.filter(isSupported);
  const rejected = paths.length - ok.length;
  if (ok.length) {
    const cues = ok.map(newCue);
    show.cues.splice(beforeIndex, 0, ...cues);
    if (!runtime.armedCueId) api.arm(cues[0].id);
    await refreshFileStatus();
    await commit();
  }
  if (rejected) flash(`${rejected} file(s) skipped. Supported: ${env.supportedExt.join(' ')}`, 'warn');
}

async function replaceFile(id, path) {
  if (!isSupported(path)) return flash(`Not a presentation: ${baseName(path)}`, 'warn');
  const c = cueById(id);
  c.file = { path };
  await refreshFileStatus();
  await commit();
  flash(`Cue ${show.cues.indexOf(c) + 1} now uses ${baseName(path)}`, 'info');
}

function moveCue(id, beforeId) {
  const from = show.cues.findIndex((c) => c.id === id);
  if (from < 0 || id === beforeId) return;
  const [c] = show.cues.splice(from, 1);
  const to = beforeId ? show.cues.findIndex((x) => x.id === beforeId) : show.cues.length;
  show.cues.splice(to < 0 ? show.cues.length : to, 0, c);
  commit();
}

function updateSelected(patch) {
  const c = cueById(selectedId);
  if (!c) return;
  Object.assign(c, patch);
  commit();
}

let flashTimer = null;
function flash(msg, level) {
  runtime = { ...runtime, message: msg, messageLevel: level };
  renderStatus();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (runtime.message === msg) api.clearMessage(); }, 5000);
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
    if (!confirm(`Delete cue ${show.cues.indexOf(c) + 1} “${cueName(c)}”?`)) return;
    show.cues = show.cues.filter((x) => x.id !== selectedId);
    selectedId = null;
    commit();
  };

  $('settingsBtn').onclick = async () => {
    env = await api.env();
    remote = await api.controlGet();
    sync = await api.syncGet();
    $('settings').hidden = false;
    renderSettings();
  };
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
  $('message').onclick = () => api.clearMessage();
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
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (!$('settings').hidden) { if (e.key === 'Escape') $('settings').hidden = true; return; }
    if (!$('preflightModal').hidden) { if (e.key === 'Escape') $('preflightModal').hidden = true; return; }
    if (!$('showModeModal').hidden) { if (e.key === 'Escape') $('showModeModal').hidden = true; return; }
    const accel = accelFromEvent(e);
    if (!accel) return;
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
  setupShowMode();
  render();
  renderShowModeIndicators();

  api.on('state', (s) => {
    runtime = s;
    renderGrid();
    renderStatus();
    renderPreflightButton();
    renderShowModeIndicators();
    if (selectedId) renderEditor();
    if (!$('preflightModal').hidden) renderPreflightReport();
    tickTimer();
    $('stageMsg').classList.toggle('sent', !!(s.stageMessage && s.stageMessage.text));
  });
  api.on('show', async (p) => {
    show = p.show; shortcutReport = p.shortcutReport || {};
    if (selectedId && !cueById(selectedId)) selectedId = null;
    await refreshFileStatus();
    render();
  });
  api.on('displays', (d) => { displays = d; render(); });
  sync = await api.syncGet();
  renderSyncBadge();
  api.on('sync', (status) => { if (sync) { sync.status = status; renderSyncBadge(); if (!$('settings').hidden) renderSync(); } });
  api.on('control-status', (status) => { if (remote) { remote.status = status; if (!$('settings').hidden) renderRemote(); } });
  // Coming back to the app (after editing a deck, installing a font…) re-checks; unchanged files are cached.
  window.addEventListener('focus', async () => { await refreshFileStatus(); renderGrid(); renderEditor(); api.preflightRun(); });
}

init();
