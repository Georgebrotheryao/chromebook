'use strict';
// Spawndroid cloud Android for /mobile (what opens when you type "secretmobile").
// The API key stays on the server. The browser only gets a share-link URL to put in an iframe.
//
// Environment variables (set them in Railway -> Variables):
//   SPAWNDROID_API_KEY       required. API key with at least "upload" scope (API & CI/CD -> API keys)
//   SPAWNDROID_APP_SLUG      required. slug of the uploaded APK (Spawndroid console -> your build)
//   SPAWNDROID_PROFILE       optional. device profile, e.g. android-14-phone
//   SPAWNDROID_SHARE_URL     optional. a share link you made by hand in the console. Used instead of
//                            creating one through the API (needed if the API refuses to create links)
//   SPAWNDROID_MAX_MINUTES   optional. hard stop for one session (default 20)
//   SPAWNDROID_IDLE_MINUTES  optional. stop when nobody has the page open (default 3)

const BASE = 'https://app.spawndroid.io';
const KEY = process.env.SPAWNDROID_API_KEY || '';
const SLUG = process.env.SPAWNDROID_APP_SLUG || '';
const PROFILE = process.env.SPAWNDROID_PROFILE || '';
const MANUAL_URL = process.env.SPAWNDROID_SHARE_URL || '';
const MAX_MS = (parseInt(process.env.SPAWNDROID_MAX_MINUTES, 10) || 20) * 60 * 1000;
const IDLE_MS = (parseInt(process.env.SPAWNDROID_IDLE_MINUTES, 10) || 3) * 60 * 1000;
const enabled = !!(KEY && SLUG);

let current = null;   // { id, url, startedAt, lastSeen }
let link = null;      // { url, expiresAt } cached share link
let starting = null;  // promise while a start is in progress

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method: method,
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data: data || {} };
}

function sessionId(s) { return s && (s.id || s.sessionId || s.session_id) || null; }

function friendlyError(r) {
  const code = r.data && r.data.code;
  if (r.status === 402 || code === 'device-minutes') return 'The monthly device minutes are used up.';
  if (r.status === 429 || code === 'concurrency') return 'The emulator is already busy. Try again in a minute.';
  if (r.status === 401) return 'The Spawndroid API key was rejected.';
  if (r.status === 404) return 'The app slug was not found in the Spawndroid workspace.';
  return (r.data && r.data.error) || ('Spawndroid error ' + r.status);
}

async function getShareUrl() {
  if (MANUAL_URL) return MANUAL_URL;
  if (link && Date.parse(link.expiresAt) - Date.now() > 60 * 60 * 1000) return link.url;
  const r = await api('POST', '/api/apps/' + encodeURIComponent(SLUG) + '/share', { expiry: '24h', viewOnly: false });
  if (r.status !== 201 || !r.data.link || !r.data.link.url) {
    throw new Error('Could not create a share link (' + friendlyError(r) + '). Create one in the Spawndroid console and set SPAWNDROID_SHARE_URL.');
  }
  link = { url: r.data.link.url, expiresAt: r.data.link.expiresAt || new Date(Date.now() + 24 * 3600 * 1000).toISOString() };
  return link.url;
}

async function stop() {
  const c = current;
  current = null;
  if (!c || !c.id) return;
  try { await api('DELETE', '/api/sessions/' + encodeURIComponent(c.id)); } catch (e) { console.error('Spawndroid stop failed:', e.message); }
}

async function doStart() {
  // A session may already be live (for example after the site restarted); reuse it
  const live = await api('GET', '/api/apps/' + encodeURIComponent(SLUG) + '/session');
  let id = live.status === 200 ? sessionId(live.data.session) : null;
  if (!id) {
    const body = PROFILE ? { profileId: PROFILE } : {};
    const r = await api('POST', '/api/apps/' + encodeURIComponent(SLUG) + '/stream', body);
    if (r.status >= 300) throw new Error(friendlyError(r));
    id = sessionId(r.data.session);
  }
  const url = await getShareUrl();
  current = { id: id, url: url, startedAt: Date.now(), lastSeen: Date.now() };
  return current;
}

function start() {
  if (current) { current.lastSeen = Date.now(); return Promise.resolve(current); }
  if (!starting) starting = doStart().finally(() => { starting = null; });
  return starting;
}

function publicState() {
  if (!current) return { enabled: true, running: false };
  return { enabled: true, running: true, url: current.url, secondsLeft: Math.max(0, Math.round((current.startedAt + MAX_MS - Date.now()) / 1000)) };
}

// Stops sessions nobody is watching, and anything older than the hard limit
setInterval(() => {
  if (!current) return;
  const now = Date.now();
  if (now - current.lastSeen > IDLE_MS || now - current.startedAt > MAX_MS) stop();
}, 15000).unref();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Routes under /mobile/sd/. Returns true when it handled the request.
function handle(req, res, p, me) {
  if (!p.startsWith('/mobile/sd/')) return false;
  if (!me) { sendJson(res, 401, { ok: false, error: 'Sign in first' }); return true; }
  const post = req.method === 'POST';
  if (req.method === 'GET' && p === '/mobile/sd/status') { sendJson(res, 200, Object.assign({ ok: true }, publicState())); return true; }
  if (post && p === '/mobile/sd/start') {
    start().then(() => sendJson(res, 200, Object.assign({ ok: true }, publicState())))
      .catch(e => sendJson(res, 502, { ok: false, error: e.message }));
    return true;
  }
  if (post && p === '/mobile/sd/ping') {
    if (current) {
      current.lastSeen = Date.now();
      api('POST', '/api/sessions/' + encodeURIComponent(current.id) + '/heartbeat').catch(() => {});
    }
    sendJson(res, 200, Object.assign({ ok: true }, publicState()));
    return true;
  }
  if (post && p === '/mobile/sd/stop') {
    stop().then(() => sendJson(res, 200, { ok: true, running: false }));
    return true;
  }
  sendJson(res, 404, { ok: false, error: 'Not found' });
  return true;
}

module.exports = { enabled, handle };
