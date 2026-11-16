// Command Center window: one column per computer. Everything it shows comes from the players' own state;
// everything it does is a request to a player.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const CUE_MIME = 'application/x-center-cue';
const PLATFORM = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' };

let nodes = [];
const uploads = new Map();   // node id -> Map(file name -> { sent, total, done, error })
const signatures = new Map(); // node id -> last rendered signature
let dragging = null;          // { nodeId, cueId } while a cue row is being dragged
let linked = new Set();       // ids of computers that move together (main + backup, or several rooms)
let noticeTimer = null;

document.body.classList.add(window.center.platform === 'darwin' ? 'mac' : 'win');

// ---------- helpers ----------
function notice(text, kind = 'error') {
  const el = $('notice');
  el.textContent = text;
  el.className = `notice${kind === 'info' ? ' info' : ''}`;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, kind === 'info' ? 4000 : 9000);
}

async function act(id, path, body, method = 'POST') {
  const r = await window.center.action(id, method, path, body);
  if (!r.ok) notice(r.error || 'That did not work.');
  return r;
}

function fmt(ms) {
  const over = ms < 0;
  const total = over ? Math.floor(-ms / 1000) : Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${over ? '+' : ''}${h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')}:${sec}`;
}

// "5" = 5 minutes, "2:30" = 2 min 30 s, "1:00:00" = 1 hour.
function parseDuration(text) {
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 60);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

const nodeById = (id) => nodes.find((n) => n.id === id);
const canManage = (n) => n.online && n.manage && n.keyOk;

// ---------- linked computers ----------
// The computers an action on `id` goes to: itself, plus every other linked computer when it is linked.
function group(id) {
  const me = nodeById(id);
  if (!me) return [];
  return linked.has(id) ? nodes.filter((n) => n.id === id || (linked.has(n.id) && n.online)) : [me];
}

// Same request to every computer in the group.
async function actGroup(id, path, body) {
  const targets = group(id);
  const results = await Promise.all(targets.map((n) => window.center.action(n.id, 'POST', path, body)));
  const failed = results.map((r, i) => (r.ok ? null : `${targets[i].name}: ${r.error || 'did not work'}`)).filter(Boolean);
  if (failed.length) notice(failed.join('\n'));
  return results[0];
}

// A request about one cue. The other linked computers get the cue in the same position of their list.
async function actCue(id, cue, suffix, body) {
  const failed = [];
  await Promise.all(group(id).map(async (n) => {
    if (n.id !== id && !(n.state && n.state.cues[cue.number - 1])) { failed.push(`${n.name} has no cue ${cue.number}.`); return; }
    const r = await window.center.action(n.id, 'POST', `/api/cue/${encodeURIComponent(n.id === id ? cue.id : String(cue.number))}/${suffix}`, body);
    if (!r.ok) failed.push(`${n.name}: ${r.error || 'did not work'}`);
  }));
  if (failed.length) notice(failed.join('\n'));
}

function linkedNames() {
  return nodes.filter((n) => linked.has(n.id)).map((n) => n.name);
}

// Linked computers play by position, so their lists should match.
const listOf = (n) => JSON.stringify(n.state.cues.map((c) => [c.name, c.file]));
function listsDiffer() {
  return new Set(nodes.filter((n) => linked.has(n.id) && n.online && n.state).map(listOf)).size > 1;
}

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

// Makes the targets identical to the source: files, cues, saved timers.
async function copyList(source, targets) {
  notice(`Copying the list of ${source.name} to ${targets.map((t) => t.name).join(', ')}…`, 'info');
  const r = await window.center.copyShow(source.id, targets.map((t) => t.id));
  if (r.ok) notice(`${targets.map((t) => t.name).join(', ')} now ${targets.length === 1 ? 'has' : 'have'} the same list as ${source.name}.`, 'info');
  else notice(r.error);
}

// A computer was just linked: if its list differs from the others, offer to copy the set-up one across,
// so a backup doesn't have to be loaded by hand.
function offerCopy(id) {
  const me = nodeById(id);
  const others = nodes.filter((n) => n.id !== id && linked.has(n.id) && n.online && n.state);
  if (!me || !me.state || !others.length || listOf(me) === listOf(others[0])) return;
  const [source, targets] = !me.state.cues.length || others[0].state.cues.length
    ? [others[0], [me]]
    : [me, others];
  const k = source.state.cues.length;
  if (!k) return;
  const names = targets.map((t) => t.name).join(' and ');
  const text = targets.some((t) => t.state.cues.length)
    ? `${names} has a different list.\n\nReplace it with the ${plural(k, 'presentation')} and cues from ${source.name}?`
    : `Copy the ${plural(k, 'presentation')} and cues from ${source.name} to ${names}?`;
  if (confirm(text)) copyList(source, targets);
}

function toggleLink(id) {
  const on = !linked.has(id);
  if (on) linked.add(id); else linked.delete(id);
  window.center.setPrefs({ linked: [...linked] });
  signatures.clear();
  render();
  if (on) offerCopy(id);
}

// ---------- rendering ----------
function screenMode(s) {
  const ts = s.timerScreen || {};
  return ts.forced ? (ts.content === 'clock' ? 'clock' : 'timer') : 'slides';
}

// ---------- updates ----------
let latest = null;     // the newest version this Command Center knows of: { version }
let selfUpdate = null; // this Command Center's own update state
let saidUpdated = false;
function versionNewer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
// The version a show computer could move to: what this Command Center found, or what that computer found itself.
function updateTarget(n) {
  const mine = n.version;
  if (!mine) return null;
  let best = null;
  for (const v of [latest && latest.version, n.state && n.state.update && n.state.update.available]) {
    if (v && versionNewer(v, mine) && (!best || versionNewer(v, best))) best = v;
  }
  return best;
}
function updateSig(n) {
  const u = (n.state && n.state.update) || {};
  return [n.version, updateTarget(n), n.updating && [n.updating.stage, n.updating.percent], u.status, u.status === 'downloading' ? Math.floor((u.percent || 0) / 4) : 0, u.busy, u.blocked];
}
function updateStrip(n) {
  if (!n.online) return '';
  const u = (n.state && n.state.update) || {};
  const to = updateTarget(n);
  let text = '';
  let button = '';
  if (n.updating) {
    const { stage, percent } = n.updating;
    text = stage === 'downloading' ? `Downloading the update here: ${percent}%` : stage === 'sending' ? `Sending the update to this computer: ${percent}%` : 'Starting the update…';
  } else if (u.status === 'installing') text = 'Installing the update. Deck Cue starts again there in a moment.';
  else if (u.status === 'downloading') text = `That computer is downloading the update: ${u.percent || 0}%`;
  else if (!to) return '';
  else {
    text = `Deck Cue ${n.version} is on this computer. Version ${to} is out.`;
    if (!canManage(n)) text += ' To update it from here, switch on “Connect to Command Center” in its Settings.';
    else if (u.blocked) text += ` ${u.blocked}`;
    else if (u.busy) { text += ` ${u.busyWhy || 'A show is running there.'}`; button = '<button class="btn small" data-act="update" disabled>Update</button>'; }
    else button = '<button class="btn small go" data-act="update">Update</button>';
  }
  return `<div class="pc-update"><span>${esc(text)}</span>${button}</div>`;
}
async function updatePlayer(id) {
  const n = nodeById(id);
  if (!n) return;
  const r = await window.center.updateNode(id);
  if (!r.ok) notice(`${n.name}: ${r.error}`);
}
function updatable() {
  return nodes.filter((n) => n.online && canManage(n) && updateTarget(n) && !n.updating && !((n.state && n.state.update) || {}).busy && !((n.state && n.state.update) || {}).blocked
    && !['installing', 'downloading'].includes(((n.state && n.state.update) || {}).status));
}
// The two buttons in the top bar and the Updates box in Settings.
function renderUpdates() {
  const list = updatable();
  const all = $('updateAllBtn');
  all.hidden = list.length < 2;
  all.textContent = `Update ${list.length} computers`;
  const u = selfUpdate;
  const mine = $('selfUpdateBtn');
  if (!u) { mine.hidden = true; return; }
  const v = u.available;
  const show = ['available', 'downloading', 'ready', 'installing'].includes(u.status) && !!v;
  mine.hidden = !show;
  mine.textContent = u.status === 'downloading' ? `Downloading ${u.percent}%` : u.status === 'installing' ? 'Updating…' : `Update Command Center ${v}`;
  $('updateLine').textContent = {
    idle: 'Not checked yet.',
    checking: 'Looking for a new version…',
    current: `You have the latest version (${u.current}).`,
    available: `Version ${v} is available. You have ${u.current}.`,
    downloading: `Downloading version ${v}: ${u.percent}%`,
    ready: `Version ${v} is downloaded.${u.willInstallOnQuit ? ' It installs when you close the Command Center.' : ''}`,
    installing: `Installing version ${v}. The Command Center starts again in a moment.`,
  }[u.status] || '';
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
  if (u.updatedFrom && !saidUpdated) { saidUpdated = true; notice(`The Command Center was updated to version ${u.current}.`, 'info'); window.center.updateSeen(); }
}

function cardHtml(n) {
  const s = n.state;
  const sub = [PLATFORM[n.platform] || '', s ? s.show : '', n.online ? '' : 'not connected'].filter(Boolean).join(', ');
  const isLinked = linked.has(n.id);
  const linkBtn = `<button class="link-btn${isLinked ? ' on' : ''}" data-act="link" title="${isLinked ? 'Linked: what you do here also happens on the other linked computers. Click to unlink.' : 'Link this computer with others so they play together, like a main and its backup.'}">${isLinked ? 'Linked' : 'Link'}</button>`;
  let banner = '';
  if (!n.online) banner = 'This computer is not answering. Check that Deck Cue is open on it and that it is on the network.';
  else if (!n.manage) banner = 'This computer only takes play controls. To send it files, open Settings on it and switch on “Connect to Command Center”.';
  else if (!n.keyOk) banner = 'This computer has a network key. Type the same key under Settings here.';
  else if (isLinked && listsDiffer()) banner = 'DIFFER';

  if (!s) {
    return `<header class="pc-head"><span class="dot${n.online ? ' on' : ''}"></span>
      <div class="pc-title"><div class="pc-name">${esc(n.name)}</div><div class="pc-sub">${esc(sub)}</div></div>
      <button class="btn ghost small" data-act="remove">Remove</button></header>
      ${banner ? `<div class="pc-banner">${esc(banner)}</div>` : ''}`;
  }

  const mode = screenMode(s);
  const ts = s.timerScreen || {};
  const ups = [...(uploads.get(n.id) || new Map()).entries()];
  const manage = canManage(n);
  const cues = s.cues.map((c) => `
    <li class="cue ${c.state}${c.missing ? ' missing' : ''}" data-cue="${esc(c.id)}" data-num="${c.number}" draggable="${manage}" style="--cue-color:${esc(c.color || '#3a3d43')}" title="Click to make this the next cue">
      <span class="n">${c.number}</span>
      <div class="c-name">${esc(c.name)}</div>
      <div class="c-file" title="${esc(c.file || '')}">${c.missing ? 'Missing: ' : ''}${esc(c.file || 'No file')}${c.changed ? ', updated' : ''}</div>
      <button class="btn small" data-act="fire" title="Play this cue now">Play</button>
      <button class="btn ghost small" data-act="del" ${manage ? '' : 'disabled'} title="Remove this cue from this computer" aria-label="Remove cue">✕</button>
      <div class="c-opts">
        <button class="chip${c.fullscreen ? ' on' : ''}" data-act="fs" ${manage ? '' : 'disabled'} title="${c.fullscreen ? 'Starts the slideshow full screen. Click to only open the file.' : 'Only opens the file. Click to start the slideshow full screen.'}">${c.fullscreen ? 'Full screen' : 'Just open'}</button>
        <label class="cue-timer" title="Timer for this presentation, in minutes. It starts by itself when the cue plays.">Timer
          <input data-cue-timer inputmode="decimal" value="${c.duration || ''}" placeholder="none" ${manage ? '' : 'disabled'}> min</label>
      </div>
    </li>`).join('');
  const presets = (s.timerPresets || []).map((p, i) => `<button class="preset" data-preset="${i + 1}" title="Start a ${p.minutes}-minute timer${p.name ? ` (${esc(p.name)})` : ''}">${esc(`${p.name ? `${p.name} ` : ''}${p.minutes}`)}</button>`).join('');

  return `
    <header class="pc-head"><span class="dot${n.online ? ' on' : ''}"></span>
      <div class="pc-title"><div class="pc-name">${esc(n.name)}</div><div class="pc-sub">${esc(sub)}</div></div>
      ${n.online ? linkBtn : '<button class="btn ghost small" data-act="remove">Remove</button>'}
    </header>
    ${banner === 'DIFFER'
    ? `<div class="pc-banner">The linked computers have different lists. They play by position, so they should match. ${s.cues.length ? '<button class="btn small" data-act="copy-from">Copy this list to the others</button>' : ''}</div>`
    : banner ? `<div class="pc-banner">${esc(banner)}</div>` : ''}
    ${updateStrip(n)}
    <div class="pc-tally">
      <div class="tally-row live${s.live ? ' on' : ''}"><span class="word">Live</span>
        ${s.live ? `<span class="num">${s.live.number}</span><span class="name">${esc(s.live.name)}</span>${s.live.slide ? `<span class="slide">${s.live.slide}/${s.live.slides}</span>` : ''}` : '<span class="name">Nothing live</span>'}</div>
      <div class="tally-row next${s.next ? ' on' : ''}"><span class="word">Next</span>
        ${s.next ? `<span class="num">${s.next.number}</span><span class="name">${esc(s.next.name)}</span>` : `<span class="name">${s.cues.length ? 'End of the list' : 'No cues yet'}</span>`}</div>
    </div>
    <div class="pc-controls">
      <div class="seg-row"><span class="label">Screen shows</span>
      <div class="seg" role="group" aria-label="What the screen shows">
        <button data-screen="slides" class="${mode === 'slides' ? 'on' : ''}">Slides</button>
        <button data-screen="timer" class="${mode === 'timer' ? 'on' : ''}">Timer</button>
        <button data-screen="clock" class="${mode === 'clock' ? 'on' : ''}">Clock</button>
      </div></div>
      <div class="pc-timer">
        <span class="t" data-timer></span>
        <button class="btn small" data-act="timer-toggle">${s.timer.running ? 'Pause' : 'Start'}</button>
        <button class="btn ghost small" data-act="timer-minus" title="Take one minute off, also while it runs">−1</button>
        <button class="btn ghost small" data-act="timer-plus" title="Add one minute, also while it runs">+1</button>
        <button class="btn ghost small" data-act="timer-reset">Reset</button>
      </div>
      <div class="presets">${presets}
        <input class="other" data-timer-set placeholder="Other" title="Another time: type minutes (5), minutes and seconds (2:30), or @15:30 to count down to that time of day. Then press Return.">
        ${manage ? '<button class="preset edit" data-act="presets" title="Add, change or remove the saved timers on this computer">Edit</button>' : ''}
      </div>
      <div class="pc-go">
        <button class="btn go" data-act="go">GO</button>
        <button class="btn" data-act="prev">◀ Slide</button>
        <button class="btn" data-act="next">Slide ▶</button>
        <button class="btn stop" data-act="stop">Stop</button>
      </div>
    </div>
    <ol class="cues">${cues}</ol>
    ${ups.length ? `<div class="sending">${ups.map(([name, u]) => `<div class="up${u.error ? ' err' : ''}">${u.error ? `Could not send ${esc(name)}: ${esc(u.error)}` : u.done ? `${esc(name)} sent` : `Sending ${esc(name)}`}
      ${u.error || u.done ? '' : `<div class="bar"><i style="width:${Math.round((u.sent / Math.max(1, u.total)) * 100)}%"></i></div>`}</div>`).join('')}</div>` : ''}
    ${manage ? '<div class="drop">Drop presentations here, <button data-act="pick">or choose files</button></div>' : ''}
    <details class="more"${n.moreOpen ? ' open' : ''}>
      <summary>More for this computer</summary>
      <div class="line"><span>Between presentations, show</span>
        <select data-idle ${manage ? '' : 'disabled'}>
          <option value="off"${ts.idle === 'off' ? ' selected' : ''}>Nothing</option>
          <option value="timer"${ts.idle === 'timer' ? ' selected' : ''}>The timer</option>
          <option value="clock"${ts.idle === 'clock' ? ' selected' : ''}>The current time</option>
        </select></div>
      <div class="line"><label class="check"><input type="checkbox" data-pip ${ts.livePip ? 'checked' : ''} ${manage ? '' : 'disabled'}><span>Small timer on top of the slides</span></label></div>
      <div class="line"><span>Black screen</span><button class="btn black small${s.blackout ? ' on' : ''}" data-act="blackout">${s.blackout ? 'Blackout is on' : 'Blackout'}</button></div>
    </details>`;
}

// Everything that changes what a card looks like (the running timer is drawn separately by tick()).
function signature(n) {
  const s = n.state;
  return JSON.stringify([updateSig(n), linked.has(n.id), linked.has(n.id) && listsDiffer(), n.name, n.online, n.manage, n.keyOk, n.platform, s && [s.show, s.live, s.next, s.blackout, s.timerScreen, s.timer.running, s.timerPresets, s.cues], [...(uploads.get(n.id) || new Map()).entries()]]);
}

function render() {
  const board = $('board');
  renderUpdates();
  $('empty').hidden = nodes.length > 0;
  board.hidden = nodes.length === 0;
  const online = nodes.filter((n) => n.online).length;
  const names = linkedNames();
  $('summary').textContent = nodes.length
    ? `${online} of ${nodes.length} computer${nodes.length === 1 ? '' : 's'} connected${names.length > 1 ? `. Linked: ${names.join(' + ')} play together.` : names.length === 1 ? `. ${names[0]} is waiting for a second linked computer.` : ''}`
    : '';

  for (const el of [...board.children]) if (!nodeById(el.dataset.id)) { signatures.delete(el.dataset.id); el.remove(); }
  nodes.forEach((n, i) => {
    let el = board.querySelector(`.pc[data-id="${CSS.escape(n.id)}"]`);
    if (!el) {
      el = document.createElement('section');
      el.className = 'pc';
      el.dataset.id = n.id;
      board.appendChild(el);
    }
    if (board.children[i] !== el) board.insertBefore(el, board.children[i]);
    el.classList.toggle('offline', !n.online);
    el.classList.toggle('linked', linked.has(n.id));
    const sig = signature(n);
    // Don't rebuild a card under the operator's hands: while typing in it or dragging one of its cues.
    const busy = (el.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) || (dragging && dragging.nodeId === n.id);
    if (sig !== signatures.get(n.id) && !busy) {
      const more = el.querySelector('.more');
      n.moreOpen = more ? more.open : false;
      const scroll = el.querySelector('.cues') ? el.querySelector('.cues').scrollTop : 0;
      el.innerHTML = cardHtml(n);
      if (el.querySelector('.cues')) el.querySelector('.cues').scrollTop = scroll;
      signatures.set(n.id, sig);
    }
  });
  tick();
}

function tick() {
  for (const n of nodes) {
    const el = document.querySelector(`.pc[data-id="${CSS.escape(n.id)}"] [data-timer]`);
    if (!el || !n.state) continue;
    const t = n.state.timer;
    const idle = !t.running && !t.duration && !t.remaining;
    // Players send their own clock with the state, so the countdown is right even if clocks differ.
    const left = t.running ? t.endsAt - (Date.now() + (n.clockOffset || 0)) : t.remaining;
    el.textContent = idle ? '00:00' : fmt(left);
    el.className = `t${idle ? ' idle' : left < 0 ? ' over' : left <= 120000 ? ' warn' : !t.running ? ' paused' : ''}`;
  }
}

// ---------- actions ----------
const board = $('board');

board.addEventListener('click', async (e) => {
  const card = e.target.closest('.pc');
  if (!card) return;
  const id = card.dataset.id;
  const n = nodeById(id);
  const row = e.target.closest('.cue');
  const actEl = e.target.closest('[data-act]');
  const screen = e.target.closest('[data-screen]');

  if (screen) {
    const mode = screen.dataset.screen;
    if (mode === 'slides') actGroup(id, '/api/timerscreen?state=off');
    else actGroup(id, `/api/timerscreen?state=on&content=${mode}`);
    return;
  }
  const preset = e.target.closest('[data-preset]');
  if (preset) { actGroup(id, `/api/timer/preset?n=${preset.dataset.preset}`); return; }
  if (e.target.closest('.cue-timer')) return; // typing in a cue's timer box, not choosing the cue
  if (actEl) {
    const a = actEl.dataset.act;
    const c = row && n.state ? n.state.cues.find((x) => x.id === row.dataset.cue) : null;
    if (a === 'link') toggleLink(id);
    else if (a === 'update') updatePlayer(id);
    else if (a === 'copy-from') {
      const others = nodes.filter((x) => x.id !== id && linked.has(x.id) && x.online);
      const k = n.state.cues.length;
      if (others.length && confirm(`Replace the list on ${others.map((x) => x.name).join(' and ')} with the ${plural(k, 'presentation')} and cues from ${n.name}?`)) copyList(n, others);
    }
    else if (a === 'go') actGroup(id, '/api/go');
    else if (a === 'stop') actGroup(id, '/api/stop');
    else if (a === 'next') actGroup(id, '/api/next');
    else if (a === 'prev') actGroup(id, '/api/prev');
    // Set the same state everywhere rather than toggling each one.
    else if (a === 'blackout') actGroup(id, `/api/blackout?state=${n.state.blackout ? 'off' : 'on'}`);
    else if (a === 'timer-toggle') actGroup(id, n.state.timer.running ? '/api/timer/pause' : '/api/timer/start');
    else if (a === 'timer-reset') actGroup(id, '/api/timer/reset');
    else if (a === 'timer-minus') actGroup(id, '/api/timer/add?seconds=-60');
    else if (a === 'timer-plus') actGroup(id, '/api/timer/add?seconds=60');
    else if (a === 'presets') openPresets(id);
    else if (a === 'fire') actCue(id, c, 'fire');
    else if (a === 'fs') actCue(id, c, 'update', { autoSlideshow: !c.fullscreen });
    else if (a === 'del') {
      const where = group(id).map((x) => x.name).join(' and ');
      if (confirm(`Remove cue ${c.number} “${c.name}” from ${where}?\nThe file stays on the computer.`)) actCue(id, c, 'delete');
    } else if (a === 'pick') {
      const files = await window.center.pickFiles();
      if (files.length) send(id, files, null);
    } else if (a === 'remove') {
      window.center.remove(id);
    }
    return;
  }
  // A click on the row itself makes it the next cue.
  if (row) actCue(id, n.state.cues.find((x) => x.id === row.dataset.cue), 'arm');
});

board.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('[data-cue-timer]')) { e.target.blur(); return; } // saved on change
  if (!e.target.matches('[data-timer-set]')) return;
  const id = e.target.closest('.pc').dataset.id;
  const text = e.target.value.trim();
  const until = /^@\s*(\d{1,2}[:.]\d{2})$/.exec(text);
  if (until) {
    actGroup(id, `/api/timer/until?time=${encodeURIComponent(until[1].replace('.', ':'))}`);
  } else {
    const seconds = parseDuration(text);
    if (seconds === null) return notice('Type the minutes, for example 5 or 2:30, or @15:30 for a time of day.');
    actGroup(id, `/api/timer/set?seconds=${seconds}`);
  }
  e.target.value = '';
  e.target.blur();
});
board.addEventListener('focusout', () => setTimeout(render, 0)); // catch up on anything skipped while typing

board.addEventListener('change', (e) => {
  const card = e.target.closest('.pc');
  if (!card) return;
  if (e.target.matches('[data-idle]')) actGroup(card.dataset.id, '/api/timerscreen/config', { idle: e.target.value });
  if (e.target.matches('[data-pip]')) actGroup(card.dataset.id, '/api/timerscreen/config', { livePip: e.target.checked });
  if (e.target.matches('[data-cue-timer]')) {
    const minutes = Math.max(0, Number(e.target.value.replace(',', '.')) || 0);
    const n = nodeById(card.dataset.id);
    actCue(card.dataset.id, n.state.cues.find((x) => x.id === e.target.closest('.cue').dataset.cue), 'update', { duration: minutes });
  }
});

// Files go to every linked computer, so a main and its backup get the same list in one drop.
// target: null (add at the end) or { replaceCueId, number } (dropped on a cue).
async function send(id, files, target) {
  const targets = group(id);
  const where = targets.map((n) => n.name).join(' and ');
  const base = (f) => f.split(/[\\/]/).pop();
  if (target) {
    // Dropped on a cue: its file is replaced, on the computer and in its folder.
    const cue = nodeById(id).state.cues[target.number - 1];
    if (!confirm(`Replace the file of cue ${target.number} “${cue.name}” on ${where} with ${base(files[0])}?\n\nThe old file is moved out of the show folder, so only the latest version stays.`)) return;
  } else {
    // Dropped on empty space: a file that is already there is a new version of it, not another cue.
    files = files.filter((f) => {
      const has = targets.map((n) => [n, n.state ? n.state.cues.find((c) => c.file === base(f)) : null]).filter(([, c]) => c);
      if (!has.length) return true;
      return confirm(`“${base(f)}” is already on ${has.map(([n, c]) => `${n.name} (cue ${c.number})`).join(' and ')}.\n\nSend this version and replace it there?`);
    });
    if (!files.length) return;
  }
  const results = await Promise.all(targets.map((n) => {
    if (!canManage(n)) return { ok: false, error: `${n.name} is not accepting files.` };
    const t = target ? { replaceCueId: n.id === id ? target.replaceCueId : String(target.number), index: target.number + 1 } : null;
    return window.center.send(n.id, files, t);
  }));
  const failed = results.filter((r) => !r.ok).map((r) => r.error);
  if (failed.length) notice(failed.join('\n'));
}

// ---------- drag and drop ----------
const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const isCue = (e) => e.dataTransfer && [...e.dataTransfer.types].includes(CUE_MIME);
function clearMarks() {
  document.querySelectorAll('.drop-on, .insert-before, .replace').forEach((el) => el.classList.remove('drop-on', 'insert-before', 'replace'));
}

document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

board.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.cue');
  if (!row) return;
  dragging = { nodeId: row.closest('.pc').dataset.id, cueId: row.dataset.cue, num: Number(row.dataset.num) };
  e.dataTransfer.setData(CUE_MIME, dragging.cueId);
  e.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
board.addEventListener('dragend', () => {
  dragging = null;
  clearMarks();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  render();
});

board.addEventListener('dragover', (e) => {
  const card = e.target.closest('.pc');
  if (!card || !(isFiles(e) || isCue(e))) return;
  const n = nodeById(card.dataset.id);
  if (!n || !canManage(n)) return;
  e.preventDefault();
  clearMarks();
  const row = e.target.closest('.cue');
  if (isFiles(e)) {
    e.dataTransfer.dropEffect = 'copy';
    if (row) row.classList.add('replace'); else card.classList.add('drop-on');
  } else if (dragging && dragging.nodeId === card.dataset.id) {
    e.dataTransfer.dropEffect = 'move';
    if (row && row.dataset.cue !== dragging.cueId) row.classList.add('insert-before');
  }
});
board.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearMarks(); });

board.addEventListener('drop', (e) => {
  const card = e.target.closest('.pc');
  clearMarks();
  if (!card) return;
  e.preventDefault();
  const id = card.dataset.id;
  const n = nodeById(id);
  if (!n || !canManage(n)) return notice(`${n ? n.name : 'That computer'} is not accepting files right now.`);
  const row = e.target.closest('.cue');
  if (isCue(e)) {
    if (!dragging) return;
    if (dragging.nodeId !== id) return notice('To put a presentation on another computer, drop its file on that computer.', 'info');
    const count = n.state.cues.length;
    const before = row ? Number(row.dataset.num) : count + 1;
    // Position after the dragged cue has been taken out of the list.
    const to = before > dragging.num ? before - 1 : before;
    if (to !== dragging.num) actCue(id, { id: dragging.cueId, number: dragging.num }, `move?to=${to}`);
    return;
  }
  const files = [...e.dataTransfer.files].map((f) => window.center.pathForFile(f)).filter(Boolean);
  if (!files.length) return;
  // On a cue: replace its file (more files follow it as new cues). On empty space: add at the end.
  send(id, files, row ? { replaceCueId: row.dataset.cue, number: Number(row.dataset.num) } : null);
});

// ---------- saved timers of one computer ----------
let presetsFor = null; // { id, list }

function renderPresetsEditor() {
  const { id, list } = presetsFor;
  const n = nodeById(id);
  $('presetsTitle').textContent = `Saved timers on ${n ? n.name : 'this computer'}`;
  $('presetsList').innerHTML = list.map((p, i) => `<div class="preset-row" data-row="${i}">
      <input data-pname value="${esc(p.name)}" placeholder="Name (optional)" maxlength="24">
      <input data-pmin type="number" min="0.5" max="1440" step="0.5" value="${p.minutes}" aria-label="Minutes">
      <span>min</span>
      <button class="btn ghost small" data-premove>Remove</button>
    </div>`).join('') || '<p>No saved timers yet.</p>';
  $('presetsAdd').disabled = list.length >= 10;
}

function openPresets(id) {
  const n = nodeById(id);
  presetsFor = { id, list: (n.state.timerPresets || []).map((p) => ({ ...p })) };
  renderPresetsEditor();
  openModal('presetsModal');
}

const savePresets = () => actGroup(presetsFor.id, '/api/timer/presets', { presets: presetsFor.list });
$('presetsList').addEventListener('change', (e) => {
  const row = e.target.closest('[data-row]');
  if (!row) return;
  const p = presetsFor.list[Number(row.dataset.row)];
  if (e.target.matches('[data-pname]')) p.name = e.target.value.trim();
  if (e.target.matches('[data-pmin]')) p.minutes = Math.min(1440, Math.max(0.5, Number(e.target.value) || p.minutes));
  savePresets();
});
$('presetsList').addEventListener('click', (e) => {
  if (!e.target.matches('[data-premove]')) return;
  presetsFor.list.splice(Number(e.target.closest('[data-row]').dataset.row), 1);
  savePresets();
  renderPresetsEditor();
});
$('presetsAdd').onclick = () => {
  const { list } = presetsFor;
  list.push({ name: '', minutes: list.length ? list[list.length - 1].minutes + 5 : 5 });
  savePresets();
  renderPresetsEditor();
};

// ---------- dialogs ----------
function openModal(id) { $(id).hidden = false; }
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); });

async function addComputer() {
  $('addError').textContent = '';
  $('addGo').disabled = true;
  const r = await window.center.add($('addAddress').value);
  $('addGo').disabled = false;
  if (!r.ok) { $('addError').textContent = r.error; return; }
  $('addModal').hidden = true;
  $('addAddress').value = '';
  notice(`${r.name} added.`, 'info');
}
const showAdd = () => { openModal('addModal'); $('addError').textContent = ''; $('addAddress').focus(); };
$('addBtn').onclick = showAdd;
$('emptyAdd').onclick = showAdd;
$('addGo').onclick = addComputer;
$('addAddress').addEventListener('keydown', (e) => { if (e.key === 'Enter') addComputer(); });

$('settingsBtn').onclick = async () => {
  const p = await window.center.prefs();
  $('setKey').value = p.key;
  $('setName').textContent = `The show computers see this Command Center as “${p.name}”.`;
  openModal('settingsModal');
};
$('setKey').addEventListener('change', (e) => window.center.setPrefs({ key: e.target.value.trim() }));
window.center.about().then((a) => { $('aboutName').textContent = `${a.name} ${a.version}`; });
document.querySelector('.about-actions').addEventListener('click', (e) => {
  if (e.target.dataset.about) window.center.aboutOpen(e.target.dataset.about);
});
$('notice').onclick = () => { $('notice').hidden = true; };

// ---------- boot ----------
function setNodes(list) {
  const open = new Map(nodes.map((n) => [n.id, n.moreOpen]));
  nodes = list.map((n) => ({ ...n, moreOpen: open.get(n.id) || false }));
  render();
}

window.center.on('nodes', setNodes);
// This Command Center's own update state; it also tells the cards which version is the newest.
async function setUpdate(u) {
  selfUpdate = u;
  latest = await window.center.latest();
  render();
}
window.center.on('update', setUpdate);
window.center.update().then(setUpdate);
$('selfUpdateBtn').onclick = () => $('settingsBtn').click();
$('updateAllBtn').onclick = async () => {
  const list = updatable();
  if (!confirm(`Update Deck Cue on ${list.length} computers now?\n\n${list.map((n) => n.name).join('\n')}\n\nEach one closes Deck Cue, installs the new version and opens it again. Computers with a show running are left alone.`)) return;
  for (const n of list) await updatePlayer(n.id);
};
$('updateCheck').onclick = async () => { $('updateCheck').disabled = true; await window.center.updateCheck(); $('updateCheck').disabled = false; };
$('updateNow').onclick = async () => { const u = await window.center.updateInstall(); if (u && u.error) notice(u.error); };
$('updateCheckOn').onchange = (e) => window.center.updateSet({ check: e.target.checked });
$('updateAuto').onchange = (e) => window.center.updateSet({ auto: e.target.checked });
window.center.on('upload', (u) => {
  if (!uploads.has(u.id)) uploads.set(u.id, new Map());
  const map = uploads.get(u.id);
  map.set(u.name, u);
  // Clear a finished line after a moment; keep errors a little longer.
  if (u.done) setTimeout(() => { if (map.get(u.name) === u) { map.delete(u.name); render(); } }, u.error ? 8000 : 2000);
  render();
});
window.center.prefs().then((p) => { linked = new Set(p.linked || []); signatures.clear(); render(); });
window.center.nodes().then(setNodes);
setInterval(tick, 250);
