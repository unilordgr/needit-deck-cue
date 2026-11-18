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

// A question with named answers: bigger and clearer than the system's OK / Cancel box, and it can offer three.
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

// Linked computers play by position. Before anything is done to "cue 2" on another computer, that cue must be
// the same presentation there; otherwise the wrong deck would be played, changed or removed.
const sameCue = (a, b) => !!a && !!b && a.name === b.name && (a.file || '') === (b.file || '');
async function actCue(id, cue, suffix, body) {
  const failed = [];
  await Promise.all(group(id).map(async (n) => {
    if (n.id !== id) {
      const there = n.state && n.state.cues[cue.number - 1];
      if (!there) { failed.push(`${n.name} has no cue ${cue.number}. Nothing was done there.`); return; }
      if (!sameCue(there, cue)) { failed.push(`${n.name}: cue ${cue.number} there is “${there.name}”, not “${cue.name}”. Nothing was done there. Copy the list first.`); return; }
    }
    const r = await window.center.action(n.id, 'POST', `/api/cue/${encodeURIComponent(n.id === id ? cue.id : String(cue.number))}/${suffix}`, body);
    if (!r.ok) failed.push(`${n.name}: ${r.error || 'did not work'}`);
  }));
  if (failed.length) notice(failed.join('\n'));
}

function linkedNames() {
  return nodes.filter((n) => linked.has(n.id)).map((n) => n.name);
}

// Linked computers play by position, so their lists should match.
// The same presentations in the same order, with the same full-screen and timer settings.
const listOf = (n) => JSON.stringify(n.state.cues.map((c) => [c.name, c.file, !!c.fullscreen, c.duration || 0]));
function listsDiffer() {
  return new Set(nodes.filter((n) => linked.has(n.id) && n.online && n.state).map(listOf)).size > 1;
}
// Is a different cue next on the linked computers? (After a restart a computer starts again at cue 1.)
function nextDiffers() {
  return new Set(nodes.filter((n) => linked.has(n.id) && n.online && n.state).map((n) => (n.state.next ? n.state.next.number : 0))).size > 1;
}

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

// Makes the targets identical to the source: files, cues, saved timers.
let copyRunning = false;
async function copyList(source, targets) {
  if (copyRunning) return notice('A copy is still running. Wait for it to finish.');
  copyRunning = true;
  notice(`Copying the list of ${source.name} to ${targets.map((t) => t.name).join(', ')}…`, 'info');
  try {
    const r = await window.center.copyShow(source.id, targets.map((t) => t.id));
    if (r.ok) notice(`${targets.map((t) => t.name).join(', ')} now ${targets.length === 1 ? 'has' : 'have'} the same list as ${source.name}.`, 'info');
    else notice(r.error);
  } finally { copyRunning = false; }
}

// A computer was just linked: if its list differs from the others, offer to copy one across, so a backup does
// not have to be loaded by hand. When both have a list, the operator says which one is right.
async function offerCopy(id) {
  const me = nodeById(id);
  const others = nodes.filter((n) => n.id !== id && linked.has(n.id) && n.online && n.state);
  if (!me || !me.state || !others.length || listOf(me) === listOf(others[0])) return;
  const other = others[0];
  const mine = me.state.cues.length;
  const theirs = other.state.cues.length;
  if (!mine && !theirs) return;
  if (mine && theirs) {
    const ans = await choose({
      title: 'These two have different lists',
      lines: [`${me.name}: ${plural(mine, 'presentation')}. ${other.name}: ${plural(theirs, 'presentation')}.`, 'Linked computers play by position, so their lists should be the same. Which list is the right one? The other computer gets a copy of it, and its own list is replaced.'],
      buttons: [{ id: 'theirs', label: `Use the list of ${other.name}`, kind: 'go' }, { id: 'mine', label: `Use the list of ${me.name}` }, { id: 'cancel', label: 'Leave both as they are', kind: 'ghost' }],
    });
    if (ans.id === 'theirs') copyList(other, [me]);
    else if (ans.id === 'mine') copyList(me, others);
    return;
  }
  const [source, targets] = mine ? [me, others] : [other, [me]];
  const names = targets.map((t) => t.name).join(' and ');
  const ans = await choose({
    title: `Copy the list to ${names}?`,
    lines: [`${source.name} has ${plural(source.state.cues.length, 'presentation')}; ${names} has none. The files, the cues with their settings and the saved timers are copied across.`],
    buttons: [{ id: 'copy', label: 'Copy the list', kind: 'go' }, { id: 'cancel', label: 'Not now', kind: 'ghost' }],
  });
  if (ans.id === 'copy') copyList(source, targets);
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
  return ts.forced ? (['clock', 'card'].includes(ts.content) ? ts.content : 'timer') : 'slides';
}

// ---------- editing a presentation, and telling versions apart ----------
let edits = []; // files open for editing on this computer: { key, nodeId, cueId, name, state, savedAt, sentAt, error }
const editFor = (nodeId, cueId) => edits.find((e) => e.nodeId === nodeId && e.cueId === cueId);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Fetch the cue's file from its computer and open it here. Changes saved here are sent with one click (sendEdit).
async function editCue(id, c) {
  let r = await window.center.editStart(id, c.id, false);
  if (r.unsent) {
    const ans = await choose({
      title: 'You have changes that were not sent',
      lines: [`${r.name} was changed on this computer and has not been sent to the show computers yet.`, 'Starting again fetches the file from the show computer and your changes here are lost.'],
      buttons: [{ id: 'keep', label: 'Keep my changes', kind: 'go' }, { id: 'again', label: 'Start again' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
    });
    if (ans.id === 'cancel') return;
    r = ans.id === 'again' ? await window.center.editStart(id, c.id, true) : await window.center.editOpen(`${id}|${c.id}`);
  }
  if (!r.ok) notice(r.error || 'The file could not be opened.');
}

// The saved file goes to this computer and to the linked ones that have the same presentation in that place.
async function sendEdit(id, c) {
  const e = editFor(id, c.id);
  if (!e) return;
  const all = group(id);
  const targets = all.filter((n) => n.id === id || (n.state && sameCue(n.state.cues[c.number - 1], c)));
  const skipped = all.filter((n) => !targets.includes(n)).map((n) => n.name);
  const r = await window.center.editSend(e.key, targets.map((n) => n.id));
  if (!r.ok) notice(r.error || 'The new version was not sent.');
  else if (skipped.length) notice(`${skipped.join(' and ')} ${skipped.length === 1 ? 'has' : 'have'} a different cue ${c.number}, so the new version was not sent there.`);
}

// The line under a cue whose file is open for editing here.
function editStrip(n, c) {
  const e = editFor(n.id, c.id);
  if (!e) return '';
  const where = group(n.id).length > 1 ? 'the linked computers' : esc(n.name);
  let text;
  let buttons = '<button class="btn ghost small" data-act="edit-done" title="Stop watching this file. It stays in the Editing folder on this computer.">Done</button>';
  if (e.state === 'fetching') { text = 'Fetching the file…'; buttons = ''; }
  else if (e.state === 'sending') { text = 'Sending the new version…'; buttons = ''; }
  else if (e.state === 'changed') {
    text = `Saved here at ${clock(e.savedAt)}. Not on ${where} yet.${e.error ? ` ${esc(e.error)}` : ''}`;
    buttons = `<button class="btn go small" data-act="edit-send">Send the new version</button>${buttons}`;
  } else if (e.state === 'sent') text = `New version sent at ${clock(e.sentAt)}.${c.state === 'live' ? ' The live show still has the old one: play the cue again to show the new version.' : ''}`;
  else text = 'Open on this computer. Change it, save it, then send it from here.';
  return `<div class="c-edit ${e.state}"><span>${text}</span><span class="c-edit-btns">${buttons}</span></div>`;
}

// Linked computers that have the same cue in a place (same name, same file name) but not the same file: someone
// changed the presentation on one of them. Computers that do not report a fingerprint yet are left out.
function versionDiffs() {
  const on = nodes.filter((n) => linked.has(n.id) && n.online && n.state);
  if (on.length < 2) return [];
  const out = [];
  on[0].state.cues.forEach((c, i) => {
    const there = on.map((n) => n.state.cues[i]);
    if (!there.every((x) => sameCue(x, c)) || there.some((x) => !x.sig) || new Set(there.map((x) => x.sig)).size < 2) return;
    let newest = 0;
    there.forEach((x, k) => { if ((x.fileDate || 0) > (there[newest].fileDate || 0)) newest = k; });
    out.push({ number: i + 1, name: c.name, source: on[newest].id, sourceName: on[newest].name, date: there[newest].fileDate, targets: on.filter((n, k) => there[k].sig !== there[newest].sig).map((n) => n.id) });
  });
  return out;
}
async function copyNewest() {
  for (const d of versionDiffs()) {
    const r = await window.center.copyVersion(d.source, d.number, d.targets);
    if (!r.ok) { notice(r.error || 'The file was not copied.'); return; }
  }
}

function versionBanner() {
  const diffs = versionDiffs();
  const d = diffs[0];
  const more = diffs.length > 1 ? ` The same goes for ${diffs.length - 1} more.` : '';
  return `<div class="pc-banner">The linked computers do not have the same file for cue ${d.number} “${esc(d.name)}”: it was changed on one of them. The newest is on ${esc(d.sourceName)}${d.date ? ` (saved ${clock(d.date)})` : ''}.${more} <button class="btn small" data-act="copy-version">Copy the newest to the others</button></div>`;
}

// ---------- event card, small timer, output ----------
// Choose an image and send it to the computer (and the ones linked to it) as its event card.
// Flash on or off, the same on every linked computer. Deck Cue before 0.7.5 can only blink a message that is
// showing, and only by being sent that message again.
function flashGroup(id, on) {
  const old = [];
  for (const t of group(id)) {
    const sm = (t.state && t.state.stageMessage) || {};
    const v = t.state && t.state.player ? t.state.player.version : '0';
    let path = `/api/flash?state=${on ? 'on' : 'off'}`;
    if (versionNewer('0.7.5', v)) {
      if (!sm.text) { if (on) old.push(t.name); continue; }
      path = `/api/message?text=${encodeURIComponent(sm.text)}&flash=${on ? 1 : 0}`;
    }
    window.center.action(t.id, 'POST', path).then((r) => { if (!r.ok) notice(`${t.name}: ${r.error || 'did not work'}`); });
  }
  if (old.length) notice(`${old.join(' and ')}: Flash without a message needs Deck Cue 0.7.5 or newer there. Update ${old.length === 1 ? 'it' : 'them'}, or send a message first.`);
}

// Identify came with Deck Cue 0.7.6.
const canIdentify = (n) => !!(n.state && n.state.player && !versionNewer('0.7.6', n.state.player.version));

async function sendCard(id) {
  const file = await window.center.pickCard();
  if (!file) return false;
  const targets = group(id);
  const results = await Promise.all(targets.map((n) => window.center.sendCard(n.id, file)));
  const failed = results.map((r, i) => (r.ok ? null : `${targets[i].name}: ${r.error || 'the image was not sent'}`)).filter(Boolean);
  if (failed.length) notice(failed.join('\n'));
  return !failed.length;
}

// Nine places for the small timer, and three sizes (its height as a part of the screen's height).
const PLACES = [['t', 'Top'], ['m', 'Middle'], ['b', 'Bottom']].flatMap(([v, vn]) => [['l', 'left'], ['c', 'centre'], ['r', 'right']].map(([h, hn]) => ({ id: v + h, name: v === 'm' && h === 'c' ? 'Centre of the screen' : `${vn} ${hn}` })));
const SIZES = [{ id: 'S', h: 0.08, name: 'Small' }, { id: 'M', h: 0.12, name: 'Medium' }, { id: 'L', h: 0.18, name: 'Large' }];
function pipCell(ts) {
  const p = ts.pip || { x: 0.9, y: 0.1 };
  return `${p.y < 1 / 3 ? 't' : p.y > 2 / 3 ? 'b' : 'm'}${p.x < 1 / 3 ? 'l' : p.x > 2 / 3 ? 'r' : 'c'}`;
}
function pipSize(ts) {
  const h = (ts.pip || {}).h || 0.12;
  return SIZES.reduce((best, z) => (Math.abs(z.h - h) < Math.abs(best.h - h) ? z : best), SIZES[1]).h;
}
// The screens of one computer, as its own Deck Cue names them.
function outputOptions(s) {
  const outs = s.outputs || [];
  const cur = s.output || 'auto';
  const chosen = typeof cur === 'object' ? cur : null;
  let html = `<option value="auto"${cur === 'auto' ? ' selected' : ''}>Let the app choose</option>`;
  html += outs.map((d, i) => `<option value="${esc(String(d.id))}"${chosen && chosen.id === d.id ? ' selected' : ''}>${esc(`Screen ${i + 1}: ${d.label || 'Display'}${d.internal ? ' (built in)' : d.primary ? ' (main)' : ''}, ${d.width}×${d.height}`)}</option>`).join('');
  if (chosen && chosen.id === null) html += `<option value="missing" selected>${esc(`${chosen.label} (not connected)`)}</option>`;
  html += `<option value="window"${cur === 'window' ? ' selected' : ''}>Program window (for NDI / OBS)</option>`;
  return html;
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

// The lines under a card for files on their way. They are redrawn on their own (see the 'upload' event):
// rebuilding the whole card for every progress step made its buttons miss clicks during a transfer.
function sendingHtml(id) {
  return [...(uploads.get(id) || new Map()).entries()].map(([name, u]) => (u.error
    ? `<div class="up err"><span>Could not send ${esc(name)}: ${esc(u.error)}</span><button class="btn ghost small" data-act="dismiss-up" data-name="${esc(name)}" title="Remove this message">✕</button></div>`
    : `<div class="up">${u.done ? `${esc(name)} sent` : `Sending ${esc(name)}`}${u.done ? '' : `<div class="bar"><i style="width:${Math.round((u.sent / Math.max(1, u.total)) * 100)}%"></i></div>`}</div>`)).join('');
}
function drawSending(id) {
  const el = document.querySelector(`.pc[data-id="${CSS.escape(id)}"] [data-sending]`);
  if (el) el.innerHTML = sendingHtml(id);
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
  else if (isLinked && nextDiffers()) banner = 'NEXT';
  else if (isLinked && versionDiffs().length) banner = 'VERSION';
  const clash = n.clash ? '<div class="pc-banner bad">Two computers are answering with this one\'s identity (their settings were copied from one to the other). Only one of them is shown here. On the copy, close Deck Cue, delete its settings folder and open it again.</div>' : '';

  if (!s) {
    return `<header class="pc-head"><span class="dot${n.online ? ' on' : ''}"></span>
      <div class="pc-title"><div class="pc-name">${esc(n.name)}</div><div class="pc-sub">${esc(sub)}</div></div>
      <button class="btn ghost small" data-act="remove">Remove</button></header>
      ${banner ? `<div class="pc-banner">${esc(banner)}</div>` : ''}`;
  }

  const mode = screenMode(s);
  const ts = s.timerScreen || {};
  const manage = canManage(n);
  const sm = s.stageMessage || {}; // what the speaker is being told now
  const differs = new Set(isLinked ? versionDiffs().map((d) => d.number) : []);
  const cues = s.cues.map((c) => `
    <li class="cue ${c.state}${c.missing ? ' missing' : ''}" data-cue="${esc(c.id)}" data-num="${c.number}" draggable="${manage}" style="--cue-color:${esc(c.color || '#3a3d43')}" title="Click to make this the next cue">
      <span class="n">${c.number}</span>
      <div class="c-name">${esc(c.name)}</div>
      <div class="c-file${differs.has(c.number) ? ' differs' : ''}" title="${esc(c.file || '')}">${c.missing ? 'Missing: ' : ''}${esc(c.file || 'No file')}${differs.has(c.number) ? ', not the same on all' : c.changed ? ', updated' : ''}</div>
      <button class="btn ghost small" data-act="edit" ${manage && c.file && !c.missing ? '' : 'disabled'} title="Change this presentation: it opens on this computer; after you save it, one click sends the new version" aria-label="Edit this presentation">✎</button>
      <button class="btn small" data-act="fire" title="Play this cue now">Play</button>
      <button class="btn ghost small" data-act="del" ${manage ? '' : 'disabled'} title="Remove this cue from this computer" aria-label="Remove cue">✕</button>
      <div class="c-opts">
        <button class="chip${c.fullscreen ? ' on' : ''}" data-act="fs" ${manage ? '' : 'disabled'} title="${c.fullscreen ? 'Starts the slideshow full screen. Click to only open the file.' : 'Only opens the file. Click to start the slideshow full screen.'}">${c.fullscreen ? 'Full screen' : 'Just open'}</button>
        <label class="cue-timer" title="Timer for this presentation, in minutes. It starts by itself when the cue plays.">Timer
          <input data-cue-timer inputmode="decimal" value="${c.duration || ''}" placeholder="none" ${manage ? '' : 'disabled'}> min</label>
      </div>
      ${(c.missing ? [] : c.problems || []).map((p) => `<div class="c-warn ${p.level === 'error' ? 'error' : ''}" title="Found by the check on ${esc(n.name)}">${p.level === 'error' ? 'Problem' : 'Check'}: ${esc(p.text)}</div>`).join('')}
      ${editStrip(n, c)}
    </li>`).join('');
  const presets = (s.timerPresets || []).map((p, i) => `<button class="preset" data-preset="${i + 1}" title="Start a ${p.minutes}-minute timer${p.name ? ` (${esc(p.name)})` : ''}">${esc(`${p.name ? `${p.name} ` : ''}${p.minutes}`)}</button>`).join('');

  return `
    <header class="pc-head"><span class="dot${n.online ? ' on' : ''}"></span>
      <div class="pc-title"><div class="pc-name">${esc(n.name)}</div><div class="pc-sub">${esc(sub)}</div></div>
      ${n.online ? linkBtn : '<button class="btn ghost small" data-act="remove">Remove</button>'}
    </header>
    ${banner === 'DIFFER'
    ? `<div class="pc-banner">The linked computers have different lists. They play by position, so they should match. ${s.cues.length ? '<button class="btn small" data-act="copy-from">Copy this list to the others</button>' : ''}</div>`
    : banner === 'NEXT' ? `<div class="pc-banner">The linked computers do not have the same cue next. GO plays the Next of the computer you press it on, on all of them. <button class="btn small" data-act="same-next">Make Next the same as here</button></div>`
    : banner === 'VERSION' ? versionBanner()
    : banner ? `<div class="pc-banner">${esc(banner)}</div>` : ''}
    ${clash}
    ${s.message ? `<div class="pc-msg ${esc(s.messageLevel || 'info')}">${esc(s.message)}</div>` : ''}
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
        <button data-screen="card" class="${mode === 'card' ? 'on' : ''}" title="${ts.card ? `The event card: ${esc(ts.card)}` : 'The event card: an image for the screen, for example the event’s logo slide. Click to choose it.'}">Card</button>
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
      <div class="pc-say">
        <input class="say${sm.text ? ' sent' : ''}" data-say maxlength="280" value="${esc(sm.text || '')}" placeholder="Message to the speaker" title="Type a message for the speaker and press Return. It shows on the stage display, the phone remote and the timer on the screen.">
        <button class="btn small flash${sm.flash ? ' on' : ''}" data-act="flash" aria-pressed="${sm.flash ? 'true' : 'false'}" title="${sm.flash ? 'It is blinking now. Click to stop.' : 'Blink to get the speaker’s attention: the message, or the timer when there is no message. It blinks until you click again.'}">Flash</button>
        <button class="btn ghost small" data-act="say-clear" ${sm.text || sm.flash ? '' : 'disabled'} title="Take the message away and stop the blinking">Clear</button>
      </div>
      <div class="pc-go">
        <button class="btn go" data-act="go">GO</button>
        <button class="btn" data-act="prev">◀ Slide</button>
        <button class="btn" data-act="next">Slide ▶</button>
        <button class="btn stop" data-act="stop">Stop</button>
      </div>
    </div>
    <ol class="cues">${cues}${manage ? '<li class="drop">Drop presentations here, <button data-act="pick">or choose files</button></li>' : ''}</ol>
    <div class="sending" data-sending>${sendingHtml(n.id)}</div>
    <details class="more"${n.moreOpen ? ' open' : ''}>
      <summary>More for this computer</summary>
      <div class="line"><span>Between presentations, show</span>
        <select data-idle ${manage ? '' : 'disabled'}>
          <option value="off"${ts.idle === 'off' ? ' selected' : ''}>Nothing</option>
          <option value="timer"${ts.idle === 'timer' ? ' selected' : ''}>The timer</option>
          <option value="clock"${ts.idle === 'clock' ? ' selected' : ''}>The current time</option>
          <option value="card"${ts.idle === 'card' ? ' selected' : ''}>The event card</option>
        </select></div>
      ${ts.note ? `<div class="line why">${esc(ts.note)}</div>` : ''}
      <div class="line"><span>Event card</span>
        <span class="card-name${ts.card ? ' set' : ''}" title="${esc(ts.card || '')}">${esc(ts.card || 'No image yet')}</span>
        <button class="btn small" data-act="card-pick" ${manage ? '' : 'disabled'} title="An image for the screen, for example the event’s logo slide (PNG or JPG, ideally the size of the screen)">${ts.card ? 'Change' : 'Choose image'}</button>
        ${ts.card ? `<button class="btn ghost small" data-act="card-clear" ${manage ? '' : 'disabled'} title="Take the event card away from this computer" aria-label="Remove the event card">✕</button>` : ''}</div>
      ${ts.title !== undefined ? `<div class="line"><span>Title above the timer</span>
        <input class="title-in" data-title maxlength="60" value="${esc(ts.title)}" placeholder="For example: Starting in" ${manage ? '' : 'disabled'} title="A line above the full-screen timer or clock. Type it and press Return."></div>
      <div class="line"><label class="check"><input type="checkbox" data-clock ${ts.showClock ? 'checked' : ''} ${manage ? '' : 'disabled'}><span>Current time under the full-screen timer</span></label></div>` : ''}
      <div class="line"><label class="check"><input type="checkbox" data-pip ${ts.livePip ? 'checked' : ''} ${manage ? '' : 'disabled'}><span>Small timer on top of the slides</span></label></div>
      <div class="line"><span>Small timer place and size</span>
        <div class="pip-set">
          <div class="pos-grid" role="group" aria-label="Where the small timer sits on the screen">${PLACES.map((p) => `<button data-place="${p.id}" class="${pipCell(ts) === p.id ? 'on' : ''}" title="${p.name}" aria-label="${p.name}" ${manage ? '' : 'disabled'}></button>`).join('')}</div>
          <div class="seg sizes" role="group" aria-label="Size of the small timer">${SIZES.map((z) => `<button data-size="${z.h}" class="${pipSize(ts) === z.h ? 'on' : ''}" title="${z.name}" ${manage ? '' : 'disabled'}>${z.id}</button>`).join('')}</div>
        </div></div>
      ${ts.pip && ts.pip.content ? `<div class="line"><span>Small timer shows</span>
        <div class="pair">
          <select data-pip-content ${manage ? '' : 'disabled'} title="What the small timer shows"><option value="timer"${ts.pip.content === 'timer' ? ' selected' : ''}>The timer</option><option value="clock"${ts.pip.content === 'clock' ? ' selected' : ''}>The current time</option></select>
          <select data-pip-bg ${manage ? '' : 'disabled'} title="The box behind the figures"><option value="solid"${ts.pip.bg === 'solid' ? ' selected' : ''}>Solid box</option><option value="glass"${ts.pip.bg === 'glass' ? ' selected' : ''}>See-through box</option><option value="none"${ts.pip.bg === 'none' ? ' selected' : ''}>Figures only</option></select>
        </div></div>` : ''}
      ${ts.messages ? `<div class="line"><span>Messages and Flash on the screen</span>
        <select data-msgs ${manage ? '' : 'disabled'} title="A message and Flash are for the speaker. Choose whether the screen shows them too: it may be the one the audience sees.">
          <option value="off"${ts.messages === 'off' ? ' selected' : ''}>Never</option>
          <option value="full"${ts.messages === 'full' ? ' selected' : ''}>With the full-screen timer or clock</option>
          <option value="always"${ts.messages === 'always' ? ' selected' : ''}>Always, also on top of the slides</option>
        </select></div>` : ''}
      <div class="line"><span>Slideshows go to</span>
        <div class="pair">
          <select data-output ${manage ? '' : 'disabled'} title="The screen of this computer that the slideshows (and the timer and the card) appear on">${outputOptions(s)}</select>
          ${canIdentify(n) ? '<button class="btn ghost small" data-act="identify" title="Show each screen’s number on it for a moment, so you can tell which is which. Someone at that computer has to look.">Identify</button>' : ''}
        </div></div>
      ${s.presenter && s.presenter.enabled ? `<div class="line"><span>Presenter’s phone remote</span><button class="btn small${s.presenter.muted ? ' warn-on' : ''}" data-act="phone" title="${s.presenter.muted ? 'The presenter’s phone cannot change slides now. Click to allow it again.' : 'Stop the presenter’s phone from changing slides for now.'}">${s.presenter.muted ? 'Paused. Allow again' : 'Pause'}</button></div>` : ''}
      <div class="line"><span>Show mode</span><button class="btn small${s.showMode ? ' warn-on' : ''}" data-act="showmode" title="Show mode keeps that computer awake and its notifications quiet during the show.">${s.showMode ? 'Show mode is on' : 'Switch on'}</button></div>
      <div class="line"><span>Black screen</span><button class="btn black small${s.blackout ? ' on' : ''}" data-act="blackout">${s.blackout ? 'Blackout is on' : 'Blackout'}</button></div>
    </details>`;
}

// Everything that changes what a card looks like (the running timer is drawn separately by tick()).
function signature(n) {
  const s = n.state;
  return JSON.stringify([updateSig(n), linked.has(n.id), linked.has(n.id) && listsDiffer(), linked.has(n.id) && nextDiffers(), n.clash, n.name, n.online, n.manage, n.keyOk, n.platform, edits.filter((e) => e.nodeId === n.id), linked.has(n.id) && versionDiffs(), s && [s.show, s.live, s.next, s.blackout, s.timerScreen, s.outputs, s.output, s.timer.running, s.timerPresets, s.cues, s.message, s.messageLevel, s.stageMessage, s.showMode, s.presenter]]);
}

function render() {
  const board = $('board');
  renderUpdates();
  $('empty').hidden = nodes.length > 0;
  board.hidden = nodes.length === 0;
  const online = nodes.filter((n) => n.online).length;
  const names = linkedNames();
  const gone = nodes.filter((n) => linked.has(n.id) && !n.online);
  $('summary').textContent = nodes.length
    ? `${online} of ${nodes.length} computer${nodes.length === 1 ? '' : 's'} connected${gone.length ? '' : names.length > 1 ? `. Linked: ${names.join(' + ')} play together.` : names.length === 1 ? `. ${names[0]} is waiting for a second linked computer.` : ''}`
    : '';
  // A linked computer that dropped out gets nothing of what is done now: files, cues, GO.
  $('summary').classList.toggle('alarm', gone.length > 0);
  if (gone.length) $('summary').textContent += `. LINKED BUT NOT CONNECTED: ${gone.map((n) => n.name).join(', ')}. ${gone.length === 1 ? 'It is' : 'They are'} not getting what you do now.`;

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
    const ae = document.activeElement;
    const typing = el.contains(ae) && ae.tagName === 'INPUT' && ae.type !== 'checkbox';
    const busy = typing || (dragging && dragging.nodeId === n.id);
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
    else if (mode === 'card' && !group(id).every((x) => x.state && x.state.timerScreen && x.state.timerScreen.card)) {
      // No image on (one of) the computers yet: choose it, send it, then show it.
      if (await sendCard(id)) actGroup(id, '/api/timerscreen?state=on&content=card');
    } else actGroup(id, `/api/timerscreen?state=on&content=${mode}`);
    return;
  }
  const place = e.target.closest('[data-place]');
  if (place) { actGroup(id, '/api/timerscreen/config', { pip: { place: place.dataset.place } }); return; }
  const size = e.target.closest('[data-size]');
  if (size) { actGroup(id, '/api/timerscreen/config', { pip: { h: Number(size.dataset.size) } }); return; }
  const preset = e.target.closest('[data-preset]');
  if (preset) {
    // The saved timers can differ between computers, so the others get the time itself, not "timer number 3".
    const p = n.state.timerPresets[Number(preset.dataset.preset) - 1];
    window.center.action(id, 'POST', `/api/timer/preset?n=${preset.dataset.preset}`).then((r) => { if (!r.ok) notice(`${n.name}: ${r.error}`); });
    if (p) for (const other of group(id).filter((x) => x.id !== id)) window.center.action(other.id, 'POST', `/api/timer/set?seconds=${Math.round(p.minutes * 60)}&start=1`).then((r) => { if (!r.ok) notice(`${other.name}: ${r.error}`); });
    return;
  }
  if (e.target.closest('.cue-timer')) return; // typing in a cue's timer box, not choosing the cue
  if (e.target.closest('.c-edit') && !e.target.closest('[data-act]')) return; // reading the editing line, not choosing the cue
  if (actEl) {
    const a = actEl.dataset.act;
    const c = row && n.state ? n.state.cues.find((x) => x.id === row.dataset.cue) : null;
    if (a === 'link') toggleLink(id);
    else if (a === 'update') updatePlayer(id);
    else if (a === 'copy-from') {
      const others = nodes.filter((x) => x.id !== id && linked.has(x.id) && x.online);
      const k = n.state.cues.length;
      if (others.length) {
        const ans = await choose({
          title: `Copy this list to ${others.map((x) => x.name).join(' and ')}?`,
          lines: [`The list on ${others.map((x) => x.name).join(' and ')} is replaced with the ${plural(k, 'presentation')} and cues from ${n.name}.`],
          buttons: [{ id: 'copy', label: 'Copy the list', kind: 'go' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
        });
        if (ans.id === 'copy') copyList(n, others);
      }
    }
    else if (a === 'same-next') {
      if (n.state.next) actCue(id, n.state.cues[n.state.next.number - 1], 'arm');
    }
    else if (a === 'dismiss-up') {
      const map = uploads.get(id);
      if (map) { map.delete(actEl.dataset.name); drawSending(id); }
    }
    else if (a === 'go') {
      // Linked: every computer plays the cue that is next HERE, by position. Sending each one its own GO
      // could start a different presentation on the backup.
      const next = n.state.next ? n.state.cues[n.state.next.number - 1] : null;
      if (group(id).length < 2) actGroup(id, '/api/go');
      else if (next) actCue(id, next, 'fire');
      else notice('That was the last cue. Nothing is next.', 'info');
    }
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
    else if (a === 'flash') flashGroup(id, !(n.state.stageMessage && n.state.stageMessage.flash));
    else if (a === 'say-clear') actGroup(id, '/api/message/clear');
    else if (a === 'identify') act(id, '/api/identify'); // that computer's own screens only
    else if (a === 'showmode') actGroup(id, `/api/showmode?state=${n.state.showMode ? 'off' : 'on'}`);
    else if (a === 'phone') actGroup(id, `/api/presenter/mute?state=${n.state.presenter && n.state.presenter.muted ? 'off' : 'on'}`);
    else if (a === 'fire') actCue(id, c, 'fire');
    else if (a === 'edit') editCue(id, c);
    else if (a === 'edit-send') sendEdit(id, c);
    else if (a === 'edit-done') { const e = editFor(id, c.id); if (e) window.center.editDone(e.key); }
    else if (a === 'copy-version') copyNewest();
    else if (a === 'fs') actCue(id, c, 'update', { autoSlideshow: !c.fullscreen });
    else if (a === 'del') {
      const where = group(id).map((x) => x.name).join(' and ');
      if (confirm(`Remove cue ${c.number} “${c.name}” from ${where}?\nThe file stays on the computer.`)) actCue(id, c, 'delete');
    } else if (a === 'pick') {
      const files = await window.center.pickFiles();
      if (files.length) send(id, files, null);
    } else if (a === 'card-pick') {
      sendCard(id);
    } else if (a === 'card-clear') {
      actGroup(id, '/api/card/clear');
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
  if (e.target.matches('[data-cue-timer], [data-title]')) { e.target.blur(); return; } // saved on change
  if (e.target.matches('[data-say]')) {
    // The message goes to every linked computer, blinking or not as on this one. An empty box takes the message away.
    const id = e.target.closest('.pc').dataset.id;
    const text = e.target.value.trim();
    const me = nodeById(id);
    const on = !!(me && me.state && me.state.stageMessage && me.state.stageMessage.flash);
    for (const t of group(id)) {
      window.center.action(t.id, 'POST', `/api/message?text=${encodeURIComponent(text)}&flash=${on ? 1 : 0}`).then((r) => { if (!r.ok) notice(`${t.name}: ${r.error || 'did not work'}`); });
    }
    e.target.blur();
    return;
  }
  if (!e.target.matches('[data-timer-set]')) return;
  const id = e.target.closest('.pc').dataset.id;
  const text = e.target.value.trim();
  if (!text) return; // Return in the empty box must not wipe a running timer
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
  if (e.target.matches('[data-idle]')) {
    const id = card.dataset.id;
    const value = e.target.value;
    // "The event card" on computers that have no image yet: choose it first.
    const ready = value !== 'card' || group(id).every((n) => n.state && n.state.timerScreen && n.state.timerScreen.card) ? Promise.resolve(true) : sendCard(id);
    ready.then((ok) => { if (ok) actGroup(id, '/api/timerscreen/config', { idle: value }); else { signatures.delete(id); render(); } }); // no image chosen: show the old choice again
  }
  // The screens belong to that one computer, so this is never passed on to the linked ones.
  if (e.target.matches('[data-output]') && e.target.value !== 'missing') act(card.dataset.id, '/api/output', { output: e.target.value });
  if (e.target.matches('[data-pip]')) actGroup(card.dataset.id, '/api/timerscreen/config', { livePip: e.target.checked });
  if (e.target.matches('[data-msgs]')) actGroup(card.dataset.id, '/api/timerscreen/config', { messages: e.target.value });
  if (e.target.matches('[data-title]')) actGroup(card.dataset.id, '/api/timerscreen/config', { title: e.target.value.trim() });
  if (e.target.matches('[data-clock]')) actGroup(card.dataset.id, '/api/timerscreen/config', { showClock: e.target.checked });
  if (e.target.matches('[data-pip-content]')) actGroup(card.dataset.id, '/api/timerscreen/config', { pip: { content: e.target.value } });
  if (e.target.matches('[data-pip-bg]')) actGroup(card.dataset.id, '/api/timerscreen/config', { pip: { bg: e.target.value } });
  if (e.target.matches('[data-cue-timer]')) {
    const n = nodeById(card.dataset.id);
    const cue = n.state.cues.find((x) => x.id === e.target.closest('.cue').dataset.cue);
    const raw = e.target.value.trim().replace(',', '.');
    // "2:30" is not minutes: say so instead of quietly clearing the cue's timer.
    if (raw !== '' && !/^\d+(\.\d+)?$/.test(raw)) {
      e.target.value = cue.duration || '';
      return notice('A cue timer is in whole minutes, for example 12. Leave the box empty for no timer.');
    }
    actCue(card.dataset.id, cue, 'update', { duration: Number(raw) || 0 });
  }
  // A menu or a tick box keeps the focus after it is used; let it go so the card keeps up to date.
  if (e.target.matches('select, input[type=checkbox]')) e.target.blur();
});

// Files go to every linked computer, so a main and its backup get the same list in one drop.
// target: null (add at the end) or { replaceCueId, number } (dropped on a cue).
async function send(id, files, target) {
  const targets = group(id);
  const closed = targets.filter((n) => !canManage(n));
  if (closed.length) return notice(`${closed.map((n) => n.name).join(' and ')} ${closed.length === 1 ? 'is' : 'are'} not accepting files, so nothing was sent.`);
  const where = targets.map((n) => n.name).join(' and ');
  const base = (f) => f.split(/[\\/]/).pop();
  // Is a file with this name already on any of the computers it goes to?
  const check = (name) => Promise.all(targets.map(async (n) => ({ n, r: await window.center.checkFile(n.id, name) })));
  // "Deck (2).pptx": a name that is free on every one of them, so linked computers keep identical lists.
  const freeName = async (name) => {
    const m = /^(.*?)(\.[^.]+)?$/.exec(name);
    for (let i = 2; i < 60; i++) {
      const candidate = `${m[1]} (${i})${m[2] || ''}`;
      if (!(await check(candidate)).some((x) => x.r.ok && x.r.exists)) return candidate;
    }
    return `${m[1]} (${Date.now()})${m[2] || ''}`;
  };
  const items = [];
  let loose = files;

  if (target) {
    // Dropped on a cue: its file is replaced, on the computer and in its folder.
    const cue = nodeById(id).state.cues[target.number - 1];
    const wrong = targets.filter((n) => n.id !== id).map((n) => [n, n.state && n.state.cues[target.number - 1]]).filter(([, c]) => !sameCue(c, cue));
    if (wrong.length) return notice(`${wrong.map(([n, c]) => `${n.name}: cue ${target.number} there is ${c ? `“${c.name}”` : 'missing'}, not “${cue.name}”.`).join('\n')}\nNothing was replaced. Copy the list first.`);
    const f = files[0];
    const name = base(f);
    const ans = await choose({
      title: `Replace the file of cue ${target.number}?`,
      lines: [`Cue ${target.number} “${cue.name}” on ${where} will play ${name} from now on.`, 'The file it plays now goes to the Trash on that computer, so its folder keeps only the latest version.'],
      buttons: [{ id: 'replace', label: 'Replace', kind: 'go' }, { id: 'cancel', label: 'Cancel', kind: 'ghost' }],
    });
    if (ans.id !== 'replace') return;
    const found = (await check(name)).filter((x) => x.r.ok && x.r.exists);
    // A file with that name that belongs to another cue, or to no cue, is a different presentation: leave it alone.
    const foreign = found.some(({ r }) => !(r.usedBy.length === 1 && r.usedBy[0] === target.number));
    if (foreign) {
      items.push({ file: f, as: await freeName(name) });
    } else {
      const info = await window.center.fileInfo(f);
      if (info && found.some(({ r }) => info.date < r.date - 2000)) {
        const older = await choose({
          title: 'That file is older',
          lines: [`The file cue ${target.number} plays now: ${when(found[0].r.date)}.`, `The file you dropped: ${when(info.date)}.`],
          warn: 'The file you dropped is OLDER than the one the cue plays now.',
          buttons: [{ id: 'cancel', label: 'Keep the newer one', kind: 'go' }, { id: 'replace', label: 'Use the older file' }],
        });
        if (older.id !== 'replace') return;
      }
      items.push(found.length ? { file: f, as: found[0].r.name } : f);
    }
    loose = files.slice(1); // more files in the same drop follow as new cues
  }

  let rule = null; // the answer given "for the other files too"
  for (let i = 0; i < loose.length; i++) {
    const f = loose[i];
    const name = base(f);
    const hits = (await check(name)).filter((x) => x.r.ok && x.r.exists);
    if (!hits.length) { items.push(f); continue; }
    let mode = rule;
    if (!mode) {
      const info = await window.center.fileInfo(f);
      const used = hits.filter(({ r }) => r.usedBy.length);
      const older = !!info && hits.some(({ r }) => info.date < r.date - 2000);
      const likelyNewVersion = used.length > 0 && !older;
      const ans = await choose({
        title: `“${hits[0].r.name}” is already on ${hits.map(({ n }) => n.name).join(' and ')}`,
        lines: [
          used.length ? `It is the file of ${used.map(({ n, r }) => `cue ${r.usedBy.join(', ')} on ${n.name}`).join(' and ')}.` : 'No cue uses it at the moment.',
          `On the computer: ${when(hits[0].r.date)}. The one you are sending: ${info ? when(info.date) : 'date unknown'}.`,
          'Replace makes this the new version there (the old one goes to the Trash on that computer). Keep both adds it as a separate presentation.',
        ],
        warn: older ? 'The file you are sending is OLDER than the one on the computer.' : '',
        all: loose.length - i - 1 > 0 ? 'Do the same for the other files in this drop' : '',
        buttons: likelyNewVersion
          ? [{ id: 'replace', label: 'Replace', kind: 'go' }, { id: 'keep', label: 'Keep both' }, { id: 'cancel', label: 'Skip this file', kind: 'ghost' }]
          : [{ id: 'keep', label: 'Keep both', kind: 'go' }, { id: 'replace', label: 'Replace' }, { id: 'cancel', label: 'Skip this file', kind: 'ghost' }],
      });
      if (ans.id === 'cancel') continue;
      mode = ans.id;
      if (ans.all) rule = mode;
    }
    items.push({ file: f, as: mode === 'keep' ? await freeName(name) : hits[0].r.name });
  }
  if (!items.length) return;

  const results = await Promise.all(targets.map((n) => {
    const t = target ? { replaceCueId: n.id === id ? target.replaceCueId : String(target.number), index: target.number + 1 } : null;
    return window.center.send(n.id, items, t);
  }));
  const failed = results.filter((r) => !r.ok).map((r) => r.error);
  const gone = linked.has(id) ? nodes.filter((n) => linked.has(n.id) && !n.online) : [];
  if (gone.length) failed.push(`${gone.map((n) => n.name).join(' and ')} ${gone.length === 1 ? 'is' : 'are'} linked but not connected, so ${gone.length === 1 ? 'it' : 'they'} did not get ${items.length === 1 ? 'this file' : 'these files'}.`);
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
  m.addEventListener('click', (e) => {
    // The question dialog must always get an answer; a click beside it means "cancel".
    if (m.id === 'chooseModal') { if (e.target === m && chooseDone) chooseDone('cancel'); return; }
    if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
  });
});
$('chooseButtons').onclick = (e) => { const b = e.target.closest('[data-choice]'); if (b && chooseDone) chooseDone(b.dataset.choice); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (chooseDone) { chooseDone('cancel'); return; }
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
});

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
window.center.on('edits', (list) => { edits = list; render(); });
window.center.edits().then((list) => { edits = list; render(); });
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
  // A finished line goes away after a moment. An error stays until it is dismissed.
  if (u.done && !u.error) setTimeout(() => { if (map.get(u.name) === u) { map.delete(u.name); drawSending(u.id); } }, 2500);
  drawSending(u.id);
});
window.center.prefs().then((p) => { linked = new Set(p.linked || []); signatures.clear(); render(); });
window.center.nodes().then(setNodes);
setInterval(tick, 250);
