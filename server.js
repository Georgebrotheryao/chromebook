const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HISTORY_LIMIT = 200;
const MAX_TEXT = 1000;
const MAX_BODY = 8 * 1024;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;

let nextId = 1;
const history = [];
const clients = new Set();
const rateLog = new Map();

const chromebookHtml = fs.readFileSync(path.join(__dirname, 'chromebook.html'));
const chatHtml = fs.readFileSync(path.join(__dirname, 'chat.html'));

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach(res => res.write(payload));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (rateLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX;
  if (!limited) recent.push(now);
  rateLog.set(ip, recent);
  return limited;
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('event: hello\ndata: ' + JSON.stringify({ history: history, online: clients.size + 1 }) + '\n\n');
  clients.add(res);
  broadcast('online', { online: clients.size });

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    broadcast('online', { online: clients.size });
  });
}

function handleSend(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_BODY && !tooBig) {
      tooBig = true;
      sendJson(res, 413, { ok: false, error: 'Message too large' });
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: 'Bad request' });
    }
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, chromebookHtml);
  if (req.method === 'GET' && url.pathname === '/chat') return sendHtml(res, chatHtml);
  if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res);
  if (req.method === 'POST' && url.pathname === '/send') return handleSend(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('LocalChat running on port ' + PORT);
});
