const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;
const MAX_TEXT = 1000;
const MAX_BODY = 8 * 1024;
const MAX_SIGNAL = 64 * 1024;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;
const MAX_CALL = 8;

process.on('uncaughtException', err => console.error('Uncaught error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

let nextId = 1;
const history = [];
const clients = new Set();
const rateLog = new Map();
const participants = new Map();

function loadFile(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name));
  } catch (e) {
    console.error('Missing file: ' + name + '. Files found in ' + __dirname + ': ' + fs.readdirSync(__dirname).join(', '));
    return Buffer.from('<!DOCTYPE html><title>LocalChat</title><p>File ' + name + ' is missing on the server.</p>');
  }
}
const chromebookHtml = loadFile('chromebook.html');
const chatHtml = loadFile('chat.html');
const videoHtml = loadFile('video.html');

function safeWrite(res, data) {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(data);
  } catch (e) {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(res => safeWrite(res, payload));
}

function sendJson(res, code, obj) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function readBody(req, res, limit, handler) {
  const chunks = [];
  let total = 0;
  let done = false;
  req.on('error', () => {});
  req.on('data', chunk => {
    if (done) return;
    total += chunk.length;
    if (total > limit) {
      done = true;
      sendJson(res, 413, { ok: false, error: 'Request too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (done) return;
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'Bad request' });
    }
    handler(data);
  });
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (rateLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX;
  if (!limited) recent.push(now);
  rateLog.set(ip, recent);
  return limited;
}

// ---------- Chat ----------

function handleEvents(req, res) {
  res.on('error', () => clients.delete(res));
  req.on('error', () => clients.delete(res));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  safeWrite(res, 'event: hello\ndata: ' + JSON.stringify({ history: history, online: clients.size + 1 }) + '\n\n');
  clients.add(res);
  broadcast('online', { online: clients.size });

  const ping = setInterval(() => safeWrite(res, ': ping\n\n'), 25000);
  const cleanup = () => {
    clearInterval(ping);
    if (clients.delete(res)) broadcast('online', { online: clients.size });
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

function handleSend(req, res) {
  readBody(req, res, MAX_BODY, data => {
    const name = String(data.name || '').trim().slice(0, 24) || 'Guest';
    const text = String(data.text || '').trim();
    const sid = String(data.sid || '').slice(0, 64);
    if (!text) return sendJson(res, 400, { ok: false, error: 'Empty message' });
    if (text.length > MAX_TEXT) return sendJson(res, 400, { ok: false, error: 'Message too long (max 1000 characters)' });
    if (isRateLimited(req.socket.remoteAddress)) return sendJson(res, 429, { ok: false, error: 'Slow down a little' });

    const msg = { id: nextId++, ts: Date.now(), name: name, text: text, sid: sid };
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history.shift();
    broadcast('message', msg);
    sendJson(res, 200, { ok: true, id: msg.id });
  });
}

function handleDelete(req, res) {
  readBody(req, res, MAX_BODY, data => {
    const id = Number(data.id);
    const sid = String(data.sid || '');
    const idx = history.findIndex(m => m.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: 'Message not found' });
    if (!sid || history[idx].sid !== sid) return sendJson(res, 403, { ok: false, error: 'You can only delete your own messages' });
    history.splice(idx, 1);
    broadcast('delete', { id: id });
    sendJson(res, 200, { ok: true });
  });
}

// ---------- Video call (WebRTC signaling only; video goes peer to peer) ----------

function handleVideoJoin(req, res) {
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    const name = String(data.name || '').trim().slice(0, 24) || 'Guest';
    if (!vid) return sendJson(res, 400, { ok: false, error: 'Missing id' });
    if (!participants.has(vid) && participants.size >= MAX_CALL) {
      return sendJson(res, 409, { ok: false, error: 'The call is full (' + MAX_CALL + ' people).' });
    }
    participants.set(vid, { vid: vid, name: name });
    const peers = [...participants.values()].filter(p => p.vid !== vid);
    broadcast('vjoin', { vid: vid, name: name });
    sendJson(res, 200, { ok: true, peers: peers });
  });
}

function handleVideoLeave(req, res) {
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    if (participants.delete(vid)) broadcast('vleave', { vid: vid });
    sendJson(res, 200, { ok: true });
  });
}

function handleVideoSignal(req, res) {
  readBody(req, res, MAX_SIGNAL, data => {
    const to = String(data.to || '').slice(0, 64);
    const from = String(data.from || '').slice(0, 64);
    const kind = String(data.kind || '');
    if (!to || !from || !['offer', 'answer', 'ice'].includes(kind)) return sendJson(res, 400, { ok: false, error: 'Bad signal' });
    if (!participants.has(from)) return sendJson(res, 403, { ok: false, error: 'Not in the call' });
    broadcast('vsignal', { to: to, from: from, kind: kind, data: data.data });
    sendJson(res, 200, { ok: true });
  });
}

// ---------- Server ----------

const server = http.createServer((req, res) => {
  res.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/') return sendHtml(res, chromebookHtml);
  if (req.method === 'GET' && p === '/chat') return sendHtml(res, chatHtml);
  if (req.method === 'GET' && p === '/video') return sendHtml(res, videoHtml);
  if (req.method === 'GET' && p === '/events') return handleEvents(req, res);
  if (req.method === 'POST' && p === '/send') return handleSend(req, res);
  if (req.method === 'POST' && p === '/delete') return handleDelete(req, res);
  if (req.method === 'POST' && p === '/video/join') return handleVideoJoin(req, res);
  if (req.method === 'POST' && p === '/video/leave') return handleVideoLeave(req, res);
  if (req.method === 'POST' && p === '/video/signal') return handleVideoSignal(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', err => console.error('Server error:', err));

server.listen(PORT, '0.0.0.0', () => {
  console.log('LocalChat running on port ' + PORT);
});
