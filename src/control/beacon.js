// LAN discovery between players and a Command Center: each player broadcasts a small UDP "I'm here"
// message every two seconds; the Command Center listens for them. No server or configuration needed.
const dgram = require('dgram');
const os = require('os');

const BEACON_PORT = 9645;
const TAG = 'needit-deckcue';

// Broadcast address of every network this computer is on, plus loopback so a Command Center running
// on the same computer hears it too.
function targets() {
  const out = new Set(['127.0.0.1', '255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((n, i) => (n | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

// Player side. getInfo() returns { id, name, port, ... } or null while it shouldn't announce itself.
function createBeacon(getInfo) {
  let socket = null;
  let timer = null;
  const send = () => {
    const info = getInfo();
    if (!info || !socket) return;
    const msg = Buffer.from(JSON.stringify({ tag: TAG, ...info }));
    for (const host of targets()) socket.send(msg, BEACON_PORT, host, () => {});
  };
  return {
    start() {
      if (socket) return;
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('error', () => {});
      socket.bind(0, () => { try { socket.setBroadcast(true); } catch { /* not allowed on this network */ } send(); });
      timer = setInterval(send, 2000);
    },
    stop() {
      clearInterval(timer);
      if (socket) { try { socket.close(); } catch { /* already closed */ } socket = null; }
    },
    announce: send,
  };
}

// Command Center side: calls onBeacon(info, senderAddress) for every announcement heard.
function listenForBeacons(onBeacon, onError = () => {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', onError);
  socket.on('message', (msg, rinfo) => {
    let info;
    try { info = JSON.parse(msg.toString()); } catch { return; }
    if (info && info.tag === TAG && info.id && info.port) onBeacon(info, rinfo.address);
  });
  socket.bind(BEACON_PORT);
  return { close() { try { socket.close(); } catch { /* already closed */ } } };
}

module.exports = { createBeacon, listenForBeacons, BEACON_PORT };
