// Remote control for show controllers: HTTP actions, a WebSocket that pushes state, and OSC over UDP.
// Used by the Bitfocus Companion module (companion-module/) and by any OSC-capable controller.
//
// HTTP   GET  /api/state                  full state (JSON)
//        POST /api/go | /api/stop | /api/next | /api/prev
//        POST /api/blackout[?state=on|off] (toggle without state)
//        POST /api/cue/<number|id>/fire | /api/cue/<number|id>/arm
//        POST /api/arm/next | /api/arm/prev
//        POST /api/timer/start | pause | reset, /api/timer/set?seconds=N, /api/timer/add?seconds=N
//        POST /api/message?text=...&flash=1, /api/message/clear
//        POST /api/showmode[?state=on|off]     show-machine mode (toggle without state)
//        GET  /api/cue/<ref>/file             the cue's PDF (for stage display previews)
//        GET  /api/cue/<ref>/thumb            first-slide thumbnail image
//        GET  /stage                           stage display / confidence monitor page
//        GET  /remote                          presenter phone remote (NEXT / PREV, PIN protected)
//        POST /api/presenter/check | next | prev   with header X-Presenter-Pin (5 wrong PINs: 1 min lockout)
//        POST /api/presenter/mute[?state=on|off]   operator: pause the presenter remote
//        GET  /api/show                        the show file (cues and settings), for a backup to copy
// WS     /api/ws                          sends {type:"state", state} on connect and on every change, and
//                                         {type:"event", event} the moment an action happens (fire, stop,
//                                         nav, blackout, arm), so a backup machine can follow in step.
//                                         A backup connects with ?role=backup&name=<computer name>.
// OSC    /deckcue/go, /stop, /next, /prev, /blackout [0|1], /cue/fire <n|id>, /cue/arm <n|id>,
//        /cue/<n>/fire, /cue/<n>/arm, /arm/next, /arm/prev, /state (replies to the sender),
//        /timer/start, /timer/pause, /timer/reset, /timer/set <seconds>, /timer/add <seconds>,
//        /message <text> [flash 0|1], /message/clear
//        Feedback to the configured host:port and to /state requesters:
//        /deckcue/live/number i, /live/name s, /next/number i, /next/name s, /blackout i,
//        /slide i i, /cue/<n>/state s ("live" | "next" | "loading" | "missing" | "idle")
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');
const { WebSocketServer } = require('ws');
const osc = require('./osc');

const PREFIX = '/deckcue';

// Static files for the stage display. Only these exact paths are served.
const STAGE_DIR = path.join(__dirname, '..', 'stage');
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));
const STATIC = {
  '/stage': [path.join(STAGE_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/stage/': [path.join(STAGE_DIR, 'index.html'), 'text/html; charset=utf-8'],
  '/stage/stage.js': [path.join(STAGE_DIR, 'stage.js'), 'text/javascript; charset=utf-8'],
  '/stage/stage.css': [path.join(STAGE_DIR, 'stage.css'), 'text/css; charset=utf-8'],
  '/remote': [path.join(__dirname, '..', 'remote', 'index.html'), 'text/html; charset=utf-8'],
  '/remote/': [path.join(__dirname, '..', 'remote', 'index.html'), 'text/html; charset=utf-8'],
  '/remote/remote.js': [path.join(__dirname, '..', 'remote', 'remote.js'), 'text/javascript; charset=utf-8'],
  '/remote/remote.css': [path.join(__dirname, '..', 'remote', 'remote.css'), 'text/css; charset=utf-8'],
  '/stage/pdf.min.mjs': [path.join(PDFJS_DIR, 'build', 'pdf.min.mjs'), 'text/javascript; charset=utf-8'],
  '/stage/pdf.worker.min.mjs': [path.join(PDFJS_DIR, 'build', 'pdf.worker.min.mjs'), 'text/javascript; charset=utf-8'],
};

function createControlServer({ getState, getShow, actions, onStatus, onFollowers }) {
  let config = null;
  let httpServer = null;
  let wss = null;
  let udp = null;
  let status = { http: 'off', osc: 'off' };
  let lastOsc = new Map(); // address -> last sent value, so feedback only goes out on change
  const oscRequesters = new Map(); // "host:port" -> expiry time
  const pinFailures = new Map(); // remote address -> { count, until }

  function setStatus(patch) {
    status = { ...status, ...patch };
    onStatus(status);
  }

  // ---------- actions shared by HTTP and OSC ----------
  function run(action, arg) {
    switch (action) {
      case 'go': return actions.go();
      case 'stop': return actions.stop();
      case 'next': return actions.nav('next');
      case 'prev': return actions.nav('previous');
      case 'blackout': return actions.blackout(arg);
      case 'fire': return actions.fire(arg);
      case 'arm': return actions.arm(arg);
      case 'arm-next': return actions.armStep(1);
      case 'arm-prev': return actions.armStep(-1);
      case 'timer': return actions.timer(arg.cmd, arg.seconds);
      case 'message': return actions.stageMessage(arg.text, arg.flash);
      case 'showmode': return actions.showMode(arg);
      case 'presenter-mute': return actions.presenterMute(arg);
      default: throw Object.assign(new Error(`Unknown action ${action}`), { code: 404 });
    }
  }

  // ---------- HTTP + WebSocket ----------
  function send(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function route(method, pathname, query) {
    const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ["api", ...]
    if (parts[0] !== 'api') return null;
    const [, a, b, c] = parts;
    if (method === 'GET' && a === 'state' && !b) return { state: true };
    if (method === 'GET' && a === 'show' && !b) return { show: true };
    if (method === 'GET' && a === 'cue' && b && c === 'file') return { file: decodeURIComponent(b) };
    if (method === 'GET' && a === 'cue' && b && c === 'thumb') return { thumb: decodeURIComponent(b) };
    if (method !== 'POST') return null;
    if (['go', 'stop', 'next', 'prev'].includes(a) && !b) return { action: a };
    if (a === 'blackout' && !b) {
      const s = query.get('state');
      return { action: 'blackout', arg: s === 'on' ? true : s === 'off' ? false : undefined };
    }
    if (a === 'cue' && b && (c === 'fire' || c === 'arm')) return { action: c, arg: decodeURIComponent(b) };
    if (a === 'arm' && (b === 'next' || b === 'prev') && !c) return { action: `arm-${b}` };
    if (a === 'timer' && ['start', 'pause', 'reset', 'set', 'add'].includes(b) && !c) return { action: 'timer', arg: { cmd: b, seconds: query.get('seconds') } };
    if (a === 'message' && !b) return { action: 'message', arg: { text: query.get('text') || '', flash: ['1', 'true', 'on'].includes(query.get('flash')) } };
    if (a === 'message' && b === 'clear' && !c) return { action: 'message', arg: { text: '', flash: false } };
    if (a === 'presenter' && ['check', 'next', 'prev'].includes(b) && !c) return { presenter: b };
    if (a === 'presenter' && b === 'mute' && !c) {
      const st = query.get('state');
      return { action: 'presenter-mute', arg: st === 'on' ? true : st === 'off' ? false : undefined };
    }
    if (a === 'showmode' && !b) {
      const st = query.get('state');
      return { action: 'showmode', arg: st === 'on' ? true : st === 'off' ? false : undefined };
    }
    return null;
  }

  function sendFile(res, file, type) {
    fs.stat(file, (err, st) => {
      if (err) return send(res, 404, { ok: false, error: 'Not found' });
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    });
  }

  function onRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && STATIC[url.pathname]) return sendFile(res, ...STATIC[url.pathname]);
    const r = route(req.method, url.pathname, url.searchParams);
    if (!r) return send(res, 404, { ok: false, error: 'Not found' });
    if (r.state) return send(res, 200, getState());
    if (r.show) return send(res, 200, getShow());
    if (r.presenter) {
      const who = req.socket.remoteAddress || '?';
      const f = pinFailures.get(who);
      if (f && f.until > Date.now()) return send(res, 429, { ok: false, error: 'Too many wrong PINs. Wait a minute.' });
      const result = actions.presenter(r.presenter, req.headers['x-presenter-pin'] || '');
      if (result.code === 403) {
        // Count wrong PINs within a minute; the fifth locks this device out for a minute.
        const now = Date.now();
        const recent = f && now - f.first < 60000;
        const count = recent ? f.count + 1 : 1;
        pinFailures.set(who, { count, first: recent ? f.first : now, until: count >= 5 ? now + 60000 : 0 });
      } else if (result.ok) pinFailures.delete(who);
      return send(res, result.code || 200, result);
    }
    if (r.thumb) {
      try {
        const t = actions.cueThumb(r.thumb);
        res.writeHead(200, { 'Content-Type': t.type, 'Content-Length': t.data.length, 'Cache-Control': 'no-store' });
        return res.end(t.data);
      } catch (e) { return send(res, e.code || 400, { ok: false, error: e.message }); }
    }
    if (r.file) {
      try { return sendFile(res, actions.cueFile(r.file), 'application/pdf'); } catch (e) { return send(res, e.code || 400, { ok: false, error: e.message }); }
    }
    Promise.resolve()
      .then(() => run(r.action, r.arg))
      .then(() => send(res, 200, { ok: true }))
      .catch((e) => send(res, e.code || 400, { ok: false, error: e.message }));
  }

  // ---------- OSC ----------
  function oscCueArg(args) {
    if (!args.length) throw new Error('Missing cue number or id');
    return typeof args[0] === 'number' ? Math.round(args[0]) : String(args[0]);
  }

  function onOsc(msg, rinfo) {
    let messages;
    try { messages = osc.decode(msg); } catch { return; }
    for (const { address, args } of messages) {
      if (!address.startsWith(`${PREFIX}/`)) continue;
      const parts = address.slice(PREFIX.length + 1).split('/');
      try {
        if (parts[0] === 'state' && parts.length === 1) {
          oscRequesters.set(`${rinfo.address}:${rinfo.port}`, Date.now() + 60 * 60 * 1000);
          sendFullFeedback([{ address: rinfo.address, port: rinfo.port }]);
        } else if (['go', 'stop', 'next', 'prev'].includes(parts[0]) && parts.length === 1) run(parts[0]);
        else if (parts[0] === 'blackout' && parts.length === 1) run('blackout', args.length ? Boolean(args[0]) : undefined);
        else if (parts[0] === 'cue' && (parts[1] === 'fire' || parts[1] === 'arm') && parts.length === 2) run(parts[1], oscCueArg(args));
        else if (parts[0] === 'cue' && (parts[2] === 'fire' || parts[2] === 'arm') && parts.length === 3) run(parts[2], parts[1]);
        else if (parts[0] === 'arm' && (parts[1] === 'next' || parts[1] === 'prev') && parts.length === 2) run(`arm-${parts[1]}`);
        else if (parts[0] === 'timer' && ['start', 'pause', 'reset', 'set', 'add'].includes(parts[1]) && parts.length === 2) run('timer', { cmd: parts[1], seconds: args[0] });
        else if (parts[0] === 'message' && parts.length === 1) run('message', { text: args.length ? String(args[0]) : '', flash: args.length > 1 && Boolean(args[1]) });
        else if (parts[0] === 'message' && parts[1] === 'clear' && parts.length === 2) run('message', { text: '', flash: false });
        else if (parts[0] === 'showmode' && parts.length === 1) run('showmode', args.length ? Boolean(args[0]) : undefined);
      } catch { /* ignore bad OSC input */ }
    }
  }

  function feedbackMessages(state) {
    const msgs = [
      [`${PREFIX}/live/number`, state.live ? state.live.number : 0],
      [`${PREFIX}/live/name`, state.live ? state.live.name : ''],
      [`${PREFIX}/next/number`, state.next ? state.next.number : 0],
      [`${PREFIX}/next/name`, state.next ? state.next.name : ''],
      [`${PREFIX}/blackout`, state.blackout ? 1 : 0],
      [`${PREFIX}/slide`, state.live && state.live.slide ? state.live.slide : 0, state.live && state.live.slides ? state.live.slides : 0],
    ];
    for (const c of state.cues) msgs.push([`${PREFIX}/cue/${c.number}/state`, c.state]);
    return msgs;
  }

  function oscTargets() {
    const now = Date.now();
    const targets = [];
    if (config.oscFeedbackHost && config.oscFeedbackPort) targets.push({ address: config.oscFeedbackHost, port: Number(config.oscFeedbackPort) });
    for (const [key, expiry] of oscRequesters) {
      if (expiry < now) { oscRequesters.delete(key); continue; }
      const i = key.lastIndexOf(':');
      targets.push({ address: key.slice(0, i), port: Number(key.slice(i + 1)) });
    }
    return targets;
  }

  function sendOsc(targets, address, args) {
    const buf = osc.encode(address, args);
    for (const t of targets) udp.send(buf, t.port, t.address, () => {});
  }

  function sendFullFeedback(targets) {
    if (!udp) return;
    for (const [address, ...args] of feedbackMessages(getState())) sendOsc(targets, address, args);
  }

  // ---------- lifecycle ----------
  function stop() {
    if (wss) { for (const c of wss.clients) c.terminate(); wss.close(); wss = null; }
    onFollowers([]);
    if (httpServer) { httpServer.close(); httpServer = null; }
    if (udp) { udp.close(); udp = null; }
    lastOsc = new Map();
    setStatus({ http: 'off', osc: 'off' });
  }

  function start(next) {
    stop();
    config = next;
    if (!config.enabled) return;
    const host = config.allowNetwork ? '0.0.0.0' : '127.0.0.1';

    httpServer = http.createServer(onRequest);
    wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://localhost').pathname !== '/api/ws') return socket.destroy();
      const url = new URL(req.url, 'http://localhost');
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (url.searchParams.get('role') === 'backup') {
          ws.backupName = (url.searchParams.get('name') || req.socket.remoteAddress || 'backup').slice(0, 64);
          ws.on('close', reportFollowers);
          reportFollowers();
        }
        ws.send(JSON.stringify({ type: 'state', state: getState() }));
      });
    });
    httpServer.on('error', (e) => setStatus({ http: `error: ${e.code === 'EADDRINUSE' ? `port ${config.httpPort} is in use` : e.message}` }));
    httpServer.listen(Number(config.httpPort), host, () => setStatus({ http: `listening on ${host}:${config.httpPort}` }));

    udp = dgram.createSocket('udp4');
    udp.on('message', onOsc);
    udp.on('error', (e) => setStatus({ osc: `error: ${e.code === 'EADDRINUSE' ? `port ${config.oscPort} is in use` : e.message}` }));
    udp.bind(Number(config.oscPort), host, () => setStatus({ osc: `listening on ${host}:${config.oscPort}` }));
  }

  function reportFollowers() {
    if (!wss) return onFollowers([]);
    onFollowers([...wss.clients].filter((c) => c.backupName && c.readyState === 1).map((c) => c.backupName));
  }

  // Sent the moment an action happens on this machine (before it finishes), for backups to follow.
  function event(ev) {
    if (!wss) return;
    const msg = JSON.stringify({ type: 'event', event: ev });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  }

  // Called by the app whenever cues, live/next cue, slide or blackout change.
  function update() {
    if (!config || !config.enabled) return;
    const state = getState();
    if (wss) {
      const msg = JSON.stringify({ type: 'state', state });
      for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
    }
    if (udp) {
      const targets = oscTargets();
      if (!targets.length) return;
      for (const [address, ...args] of feedbackMessages(state)) {
        const key = JSON.stringify(args);
        if (lastOsc.get(address) === key) continue;
        lastOsc.set(address, key);
        sendOsc(targets, address, args);
      }
    }
  }

  return { start, stop, update, event, getStatus: () => status };
}

// Addresses another computer on the network can use to reach this one.
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

module.exports = { createControlServer, localAddresses };
