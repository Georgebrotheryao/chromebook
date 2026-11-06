const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_LIMIT = 200;
const MAX_TEXT = 1000;
const MAX_BODY = 8 * 1024;
const MAX_SIGNAL = 64 * 1024;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 5;
const MAX_CALL = 8;
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const PENDING_MAX = 20;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

process.on('uncaughtException', err => console.error('Uncaught error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// ---------- State ----------
const users = new Map();          // id -> { id, email, name, salt, hash }
const usersByEmail = new Map();   // email -> id
const sessions = new Map();       // token -> id
const loginLog = new Map();       // ip -> [timestamps]
const rateLog = new Map();        // key -> [timestamps]
const participants = new Map();   // vid -> { vid, name, uid }
const clients = new Map();        // chat SSE response -> user id
const notifyClients = new Map();  // user id -> Set of notification SSE responses
const pendingInvites = new Map(); // user id -> [invites waiting for them to connect]
let nextMsgId = 1;
let nextCallMsgId = 1;
const history = [];

// ---------- Accounts storage ----------
function loadUsers() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8'));
    list.forEach(u => { users.set(u.id, u); usersByEmail.set(u.email, u.id); });
    console.log('Loaded ' + users.size + ' accounts');
  } catch (e) {
    // No saved accounts yet
  }
}
function saveUsers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'users.json'), JSON.stringify([...users.values()]));
  } catch (e) {
    console.error('Could not save accounts:', e.message);
  }
}
loadUsers();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt: salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, u) {
  const test = crypto.scryptSync(pw, u.salt, 64);
  const want = Buffer.from(u.hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(test, want);
}

// ---------- Helpers ----------
function loadFile(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name));
  } catch (e) {
    console.error('Missing file: ' + name);
    return Buffer.from('<!DOCTYPE html><title>LocalChat</title><p>File ' + name + ' is missing on the server.</p>');
  }
}
const chromebookHtml = loadFile('chromebook.html');
const chatHtml = loadFile('chat.html');
const videoHtml = loadFile('video.html');
const loginHtml = loadFile('login.html');
const adminHtml = loadFile('admin.html');

function safeWrite(res, data) {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(data);
  } catch (e) {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach((uid, res) => safeWrite(res, payload));
}

function sendJson(res, code, obj, headers) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}));
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

function isRateLimited(key) {
  const now = Date.now();
  const recent = (rateLog.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX;
  if (!limited) recent.push(now);
  rateLog.set(key, recent);
  return limited;
}

function tooManyLogins(ip) {
  const now = Date.now();
  const recent = (loginLog.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  recent.push(now);
  loginLog.set(ip, recent);
  return recent.length > LOGIN_MAX;
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).sid;
  const id = token && sessions.get(token);
  return (id && users.get(id)) || null;
}

function publicUser(u) {
  return { id: u.id, name: u.name };
}

function startSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, user.id);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', 'sid=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (SESSION_DAYS * 86400) + secure);
}

function onlineUids() {
  const set = new Set(clients.values());
  notifyClients.forEach((conns, uid) => { if (conns.size) set.add(uid); });
  return set;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) sendJson(res, 401, { ok: false, error: 'Sign in first' });
  return user;
}

// ---------- Accounts ----------
function handleSignup(req, res) {
  readBody(req, res, MAX_BODY, data => {
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    const name = String(data.name || '').trim().slice(0, 24);
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { ok: false, error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return sendJson(res, 400, { ok: false, error: 'The password must be at least 8 characters.' });
    if (!name) return sendJson(res, 400, { ok: false, error: 'Enter a name.' });
    if (usersByEmail.has(email)) return sendJson(res, 409, { ok: false, error: 'An account with that email already exists.' });

    const id = crypto.randomBytes(8).toString('hex');
    const pw = hashPassword(password);
    const user = { id: id, email: email, name: name, salt: pw.salt, hash: pw.hash };
    users.set(id, user);
    usersByEmail.set(email, id);
    saveUsers();
    startSession(req, res, user);
    sendJson(res, 200, { ok: true, user: publicUser(user) });
  });
}

function handleLogin(req, res) {
  if (tooManyLogins(req.socket.remoteAddress)) return sendJson(res, 429, { ok: false, error: 'Too many attempts. Try again in a few minutes.' });
  readBody(req, res, MAX_BODY, data => {
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    const user = users.get(usersByEmail.get(email));
    if (!user || !checkPassword(password, user)) return sendJson(res, 401, { ok: false, error: 'Wrong email or password.' });
    startSession(req, res, user);
    sendJson(res, 200, { ok: true, user: publicUser(user) });
  });
}

function handleLogout(req, res) {
  const token = parseCookies(req).sid;
  if (token) sessions.delete(token);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
}

function isAdmin(u) {
  return !!u && !!ADMIN_EMAIL && u.email === ADMIN_EMAIL;
}

function handleMe(req, res) {
  const user = currentUser(req);
  sendJson(res, 200, { user: user ? publicUser(user) : null, admin: isAdmin(user), adminConfigured: !!ADMIN_EMAIL });
}

// ---------- Support (admin) ----------
function requireAdmin(req, res) {
  const me = currentUser(req);
  if (!me) { sendJson(res, 401, { ok: false, error: 'Sign in first' }); return null; }
  if (!isAdmin(me)) { sendJson(res, 403, { ok: false, error: 'Admins only' }); return null; }
  return me;
}

function sendToUser(uid, event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  clients.forEach((u, res) => { if (u === uid) safeWrite(res, payload); });
}

function handleAdminUsers(req, res) {
  if (!requireAdmin(req, res)) return;
  const online = onlineUids();
  const inCall = new Set([...participants.values()].map(p => p.uid));
  const list = [...users.values()]
    .map(u => ({ id: u.id, name: u.name, email: u.email, online: online.has(u.id), inCall: inCall.has(u.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, { ok: true, users: list });
}

function handleAdminRename(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, res, MAX_BODY, data => {
    const user = users.get(String(data.id || ''));
    const name = String(data.name || '').trim().slice(0, 24);
    if (!user) return sendJson(res, 404, { ok: false, error: 'Account not found' });
    if (!name) return sendJson(res, 400, { ok: false, error: 'Enter a name' });
    user.name = name;
    saveUsers();
    participants.forEach(p => { if (p.uid === user.id) p.name = name; });
    history.forEach(m => { if (m.uid === user.id) m.name = name; });
    sendJson(res, 200, { ok: true });
  });
}

// Asks the person to change their camera. It only shows a request they can accept or ignore.
function handleAdminCamera(req, res) {
  if (!requireAdmin(req, res)) return;
  readBody(req, res, MAX_BODY, data => {
    const uid = String(data.id || '');
    const action = String(data.action || '');
    if (action !== 'off') return sendJson(res, 400, { ok: false, error: 'Unknown request' });
    const inCall = [...participants.values()].some(p => p.uid === uid);
    if (!inCall) return sendJson(res, 409, { ok: false, error: 'That person is not in the video call.' });
    sendToUser(uid, 'camrequest', { action: action, from: 'Support' });
    sendJson(res, 200, { ok: true });
  });
}

function handleVideoCaption(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    const text = String(data.text || '').trim().slice(0, 300);
    const final = data.final !== false;
    const p = participants.get(vid);
    if (!p || p.uid !== me.id) return sendJson(res, 403, { ok: false, error: 'Not in the call' });
    if (!text) return sendJson(res, 400, { ok: false, error: 'Empty caption' });
    broadcast('vcaption', { vid: vid, name: p.name, text: text, final: final });
    sendJson(res, 200, { ok: true });
  });
}

function handleVideoChat(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    const text = String(data.text || '').trim().slice(0, 500);
    const p = participants.get(vid);
    if (!p || p.uid !== me.id) return sendJson(res, 403, { ok: false, error: 'Not in the call' });
    if (!text) return sendJson(res, 400, { ok: false, error: 'Empty message' });
    if (isRateLimited('vchat:' + me.id)) return sendJson(res, 429, { ok: false, error: 'Slow down a little' });
    const id = nextCallMsgId++;
    broadcast('vchat', { id: id, vid: vid, name: p.name, text: text, ts: Date.now() });
    sendJson(res, 200, { ok: true, id: id });
  });
}

// ---------- Server ----------

function handleUsers(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  const online = onlineUids();
  const list = [...users.values()]
    .filter(u => u.id !== me.id)
    .map(u => ({ id: u.id, name: u.name, online: online.has(u.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  sendJson(res, 200, { ok: true, users: list });
}

// ---------- Invites and notifications ----------
function deliverInvite(uid, inv) {
  const conns = notifyClients.get(uid);
  if (conns && conns.size) {
    const payload = 'event: invite\ndata: ' + JSON.stringify(inv) + '\n\n';
    conns.forEach(res => safeWrite(res, payload));
    return true;
  }
  const queue = pendingInvites.get(uid) || [];
  queue.push(inv);
  if (queue.length > PENDING_MAX) queue.shift();
  pendingInvites.set(uid, queue);
  return false;
}

function handleInvite(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  if (isRateLimited('invite:' + me.id)) return sendJson(res, 429, { ok: false, error: 'Slow down a little' });
  readBody(req, res, MAX_BODY, data => {
    const kind = String(data.kind || '');
    if (kind !== 'chat' && kind !== 'call') return sendJson(res, 400, { ok: false, error: 'Unknown invite type' });
    const to = Array.isArray(data.to) ? data.to.slice(0, 50).map(String) : [];
    if (!to.length) return sendJson(res, 400, { ok: false, error: 'Choose at least one person' });
    let delivered = 0;
    let queued = 0;
    to.forEach(uid => {
      if (uid === me.id || !users.has(uid)) return;
      const inv = { from: publicUser(me), kind: kind, ts: Date.now() };
      if (deliverInvite(uid, inv)) delivered++;
      else queued++;
    });
    sendJson(res, 200, { ok: true, delivered: delivered, queued: queued });
  });
}

function handleNotify(req, res) {
  const me = currentUser(req);
  if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const pending = pendingInvites.get(me.id) || [];
  pendingInvites.delete(me.id);
  safeWrite(res, 'event: hello\ndata: ' + JSON.stringify({ pending: pending }) + '\n\n');
  if (!notifyClients.has(me.id)) notifyClients.set(me.id, new Set());
  notifyClients.get(me.id).add(res);
  const ping = setInterval(() => safeWrite(res, ': ping\n\n'), 25000);
  const cleanup = () => {
    clearInterval(ping);
    const conns = notifyClients.get(me.id);
    if (conns) {
      conns.delete(res);
      if (!conns.size) notifyClients.delete(me.id);
    }
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

// ---------- Chat ----------
function handleEvents(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  res.on('error', () => clients.delete(res));
  req.on('error', () => clients.delete(res));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  safeWrite(res, 'event: hello\ndata: ' + JSON.stringify({ history: history, online: clients.size + 1 }) + '\n\n');
  clients.set(res, me.id);
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
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const text = String(data.text || '').trim();
    if (!text) return sendJson(res, 400, { ok: false, error: 'Empty message' });
    if (text.length > MAX_TEXT) return sendJson(res, 400, { ok: false, error: 'Message too long (max 1000 characters)' });
    if (isRateLimited('msg:' + me.id)) return sendJson(res, 429, { ok: false, error: 'Slow down a little' });
    const msg = { id: nextMsgId++, ts: Date.now(), name: me.name, text: text, uid: me.id };
    history.push(msg);
    if (history.length > HISTORY_LIMIT) history.shift();
    broadcast('message', msg);
    sendJson(res, 200, { ok: true, id: msg.id });
  });
}

function handleDelete(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const id = Number(data.id);
    const idx = history.findIndex(m => m.id === id);
    if (idx === -1) return sendJson(res, 404, { ok: false, error: 'Message not found' });
    if (history[idx].uid !== me.id) return sendJson(res, 403, { ok: false, error: 'You can only delete your own messages' });
    history.splice(idx, 1);
    broadcast('delete', { id: id });
    sendJson(res, 200, { ok: true });
  });
}

// ---------- Video call (signaling only; video goes peer to peer) ----------
function handleVideoJoin(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    if (!vid) return sendJson(res, 400, { ok: false, error: 'Missing id' });
    if (!participants.has(vid) && participants.size >= MAX_CALL) {
      return sendJson(res, 409, { ok: false, error: 'The call is full (' + MAX_CALL + ' people).' });
    }
    participants.set(vid, { vid: vid, name: me.name, uid: me.id });
    const peers = [...participants.values()].filter(p => p.vid !== vid).map(p => ({ vid: p.vid, name: p.name }));
    broadcast('vjoin', { vid: vid, name: me.name });
    sendJson(res, 200, { ok: true, peers: peers });
  });
}

function handleVideoLeave(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_BODY, data => {
    const vid = String(data.vid || '').slice(0, 64);
    const p = participants.get(vid);
    if (p && p.uid === me.id) {
      participants.delete(vid);
      broadcast('vleave', { vid: vid });
    }
    sendJson(res, 200, { ok: true });
  });
}

function handleVideoSignal(req, res) {
  const me = requireUser(req, res);
  if (!me) return;
  readBody(req, res, MAX_SIGNAL, data => {
    const to = String(data.to || '').slice(0, 64);
    const from = String(data.from || '').slice(0, 64);
    const kind = String(data.kind || '');
    if (!to || !from || !['offer', 'answer', 'ice'].includes(kind)) return sendJson(res, 400, { ok: false, error: 'Bad signal' });
    const p = participants.get(from);
    if (!p || p.uid !== me.id) return sendJson(res, 403, { ok: false, error: 'Not in the call' });
    broadcast('vsignal', { to: to, from: from, kind: kind, data: data.data });
    sendJson(res, 200, { ok: true });
  });
}

// ---------- Server ----------
const server = http.createServer((req, res) => {
  res.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  if (get && p === '/') {
    if (!currentUser(req)) {
      res.writeHead(302, { 'Location': '/login?next=%2F' });
      return res.end();
    }
    return sendHtml(res, chromebookHtml);
  }
  if (get && p === '/chat') return sendHtml(res, chatHtml);
  if (get && p === '/video') return sendHtml(res, videoHtml);
  if (get && p === '/login') return sendHtml(res, loginHtml);
  if (get && p === '/admin') return sendHtml(res, adminHtml);
  if (get && p === '/api/admin/users') return handleAdminUsers(req, res);
  if (post && p === '/api/admin/rename') return handleAdminRename(req, res);
  if (post && p === '/api/admin/camera') return handleAdminCamera(req, res);
  if (get && p === '/api/me') return handleMe(req, res);
  if (get && p === '/api/users') return handleUsers(req, res);
  if (get && p === '/events') return handleEvents(req, res);
  if (get && p === '/notify') return handleNotify(req, res);
  if (post && p === '/api/signup') return handleSignup(req, res);
  if (post && p === '/api/login') return handleLogin(req, res);
  if (post && p === '/api/logout') return handleLogout(req, res);
  if (post && p === '/api/invite') return handleInvite(req, res);
  if (post && p === '/send') return handleSend(req, res);
  if (post && p === '/delete') return handleDelete(req, res);
  if (post && p === '/video/join') return handleVideoJoin(req, res);
  if (post && p === '/video/leave') return handleVideoLeave(req, res);
  if (post && p === '/video/signal') return handleVideoSignal(req, res);
  if (post && p === '/video/caption') return handleVideoCaption(req, res);
  if (post && p === '/video/chat') return handleVideoChat(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', err => console.error('Server error:', err));
server.listen(PORT, '0.0.0.0', () => {
  console.log('LocalChat running on port ' + PORT);
});
