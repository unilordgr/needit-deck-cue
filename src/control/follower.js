// Backup role: follows a main Deck Cue over its WebSocket (/api/ws?role=backup) and hands its events
// and state to the app, which replays them. Reconnects on its own until stopped.
const os = require('os');
const WebSocket = require('ws');

function createFollower({ onEvent, onState, onStatus }) {
  let target = null;
  let ws = null;
  let timer = null;
  let status = { state: 'off', host: null, since: null };

  function setStatus(state, error) {
    if (status.state !== state || status.error !== error) {
      status = { state, host: target ? `${target.host}:${target.port}` : null, since: Date.now(), error: error || null };
      onStatus(status);
    }
  }

  function connect() {
    if (!target) return;
    setStatus(status.state === 'connected' ? 'lost' : status.state === 'lost' ? 'lost' : 'connecting');
    const url = `ws://${target.host}:${target.port}/api/ws?role=backup&name=${encodeURIComponent(os.hostname())}`;
    const sock = new WebSocket(url, { handshakeTimeout: 3000 });
    ws = sock;
    // A missing heartbeat means the main machine or the network died without closing the socket.
    let alive = true;
    const beat = setInterval(() => {
      if (!alive) return sock.terminate();
      alive = false;
      try { sock.ping(); } catch { /* closing */ }
    }, 2000);
    sock.on('pong', () => { alive = true; });
    sock.on('open', () => setStatus('connected'));
    sock.on('message', (data) => {
      alive = true;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'event') onEvent(msg.event);
      else if (msg.type === 'state') onState(msg.state);
    });
    sock.on('error', (e) => { if (status.state !== 'lost') setStatus(status.state, e.message); });
    sock.on('close', () => {
      clearInterval(beat);
      if (ws !== sock) return;
      ws = null;
      if (target) {
        setStatus(status.state === 'connected' || status.state === 'lost' ? 'lost' : 'connecting', status.error);
        timer = setTimeout(connect, 1500);
      }
    });
  }

  function stop() {
    target = null;
    clearTimeout(timer);
    if (ws) { const s = ws; ws = null; s.removeAllListeners(); s.on('error', () => {}); s.terminate(); }
    setStatus('off');
  }

  function start(host, port) {
    stop();
    if (!host) return;
    target = { host, port: Number(port) || 9640 };
    connect();
  }

  // To the main, when connected (for example what this backup thinks of its own state).
  function send(msg) {
    try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch { /* the link is closing */ }
  }

  return { start, stop, send, getStatus: () => status };
}

module.exports = { createFollower };
