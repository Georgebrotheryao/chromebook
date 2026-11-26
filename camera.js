// Camera sharing: consent, authorization and WebRTC signaling only. No video ever touches the server.
const crypto = require('crypto');

const POLICY_VERSION = '1.0';
const GRACE_MS = 6000;          // allows page navigation without killing a stream
const MAX_PER_VIEWER = 4;
const MAX_SIGNAL = 64 * 1024;
const ADMIN_ONLY = process.env.CAMERA_ADMIN_ONLY === '1';
let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
try { if (process.env.CAMERA_ICE_SERVERS) ICE = JSON.parse(process.env.CAMERA_ICE_SERVERS); } catch (e) { console.error('Bad CAMERA_ICE_SERVERS'); }

module.exports = function (ctx) {
  const { users, currentUser, isAdmin, sendJson, readBody, isRateLimited, saveUsers, safeWrite } = ctx;
  const camClients = new Map();  // uid -> Set(res)   (pages that are open and can answer)
  const sessions = new Map();    // sid -> { sid, owner, viewer, state }
  const timers = new Map();      // uid -> grace timer
  const startedAt = Date.now();

  const hasAgreed = u => !!(u.policy && u.policy.version === POLICY_VERSION);
  const isOnline = uid => !!(camClients.get(uid) && camClients.get(uid).size);
  const nameOf = uid => (users.get(uid) || {}).name || 'Unknown';

  function sendCam(uid, event, data) {
    const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    (camClients.get(uid) || []).forEach(res => safeWrite(res, payload));
  }
  function broadcastAvail() {
    camClients.forEach((set, uid) => sendCam(uid, 'camavail', {}));
  }
  function view(s, me) {
    return { sid: s.sid, state: s.state, owner: s.owner, ownerName: nameOf(s.owner), viewer: s.viewer,
      viewerName: nameOf(s.viewer), ownerOnline: isOnline(s.owner), mine: s.viewer === me };
  }
  function closeSession(sid, reason) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    const d = { sid: sid, reason: reason || 'closed', ownerName: nameOf(s.owner), viewerName: nameOf(s.viewer) };
    sendCam(s.owner, 'camclosed', d);
    sendCam(s.viewer, 'camclosed', d);
  }
  function closeWhere(fn, reason) {
    [...sessions.values()].filter(fn).forEach(s => closeSession(s.sid, reason));
  }
  function dropUser(uid, reason) {
    closeWhere(s => s.owner === uid || s.viewer === uid, reason);
  }
  function requestOwner(s) {
    sendCam(s.owner, 'camopen', { sid: s.sid, viewerName: nameOf(s.viewer) });
  }

  // ----- event stream (also marks the user as "connected" for camera purposes) -----
  function handleEvents(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    if (!camClients.has(me.id)) camClients.set(me.id, new Set());
    const wasOnline = isOnline(me.id);
    camClients.get(me.id).add(res);
    clearTimeout(timers.get(me.id)); timers.delete(me.id);
    safeWrite(res, 'event: hello\ndata: ' + JSON.stringify({ sessions: [...sessions.values()].filter(s => s.owner === me.id || s.viewer === me.id).map(s => view(s, me.id)) }) + '\n\n');
    // The owner came back within the grace period: ask again so the stream restarts
    if (me.camShare) sessions.forEach(s => { if (s.owner === me.id) { s.state = 'requested'; requestOwner(s); } });
    if (!wasOnline) broadcastAvail();
    const ping = setInterval(() => safeWrite(res, ': ping\n\n'), 25000);
    const cleanup = () => {
      clearInterval(ping);
      const set = camClients.get(me.id);
      if (!set) return;
      set.delete(res);
      if (set.size) return;
      camClients.delete(me.id);
      broadcastAvail();
      const t = setTimeout(() => { timers.delete(me.id); if (!isOnline(me.id)) dropUser(me.id, 'offline'); }, GRACE_MS);
      timers.set(me.id, t);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  // ----- consent -----
  function handleSharing(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    readBody(req, res, 8192, d => {
      const on = d.on === true;
      if (on) {
        if (!hasAgreed(me)) {
          if (d.policy !== true) return sendJson(res, 400, { ok: false, needPolicy: true, error: 'You must accept the Camera Access Policy first.' });
          me.policy = { version: POLICY_VERSION, agreedAt: new Date().toISOString() };
        }
        me.camShare = true;
      } else {
        me.camShare = false;
        closeWhere(s => s.owner === me.id, 'sharing-off');   // ends every active stream immediately
      }
      saveUsers();
      broadcastAvail();
      sendJson(res, 200, { ok: true, camShare: me.camShare });
    });
  }

  // ----- viewer actions -----
  function findByName(name) {
    const n = String(name || '').trim().toLowerCase();
    const hits = [...users.values()].filter(u => u.name.toLowerCase() === n);
    return hits.length === 1 ? hits[0] : null;
  }
  function handleOpen(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    if (isRateLimited('camopen:' + me.id)) return sendJson(res, 429, { ok: false, error: 'Slow down a little' });
    readBody(req, res, 8192, d => {
      if (ADMIN_ONLY && !isAdmin(me)) return sendJson(res, 403, { ok: false, error: 'You are not allowed to open cameras.' });
      if (!hasAgreed(me)) return sendJson(res, 403, { ok: false, needPolicy: true, error: 'Accept the Camera Access Policy first (run /camera sharing on, or sign up again).' });
      const owner = d.id ? users.get(String(d.id)) : findByName(d.name);
      if (!owner) return sendJson(res, 404, { ok: false, error: 'No single user with that name.' });
      if (owner.id === me.id) return sendJson(res, 400, { ok: false, error: 'You cannot open your own camera here.' });
      if (!owner.camShare || !hasAgreed(owner)) return sendJson(res, 403, { ok: false, error: owner.name + ' has not enabled camera sharing.' });
      if (!isOnline(owner.id)) return sendJson(res, 409, { ok: false, error: owner.name + ' is offline.' });
      let s = [...sessions.values()].find(x => x.owner === owner.id && x.viewer === me.id);
      if (!s) {
        if ([...sessions.values()].filter(x => x.viewer === me.id).length >= MAX_PER_VIEWER) return sendJson(res, 409, { ok: false, error: 'You can open at most ' + MAX_PER_VIEWER + ' cameras at once.' });
        s = { sid: crypto.randomBytes(16).toString('hex'), owner: owner.id, viewer: me.id, state: 'requested' };
        sessions.set(s.sid, s);
      } else s.state = 'requested';
      requestOwner(s);
      sendJson(res, 200, { ok: true, sid: s.sid, ownerName: owner.name });
    });
  }
  function handleClose(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    readBody(req, res, 8192, d => {
      const reason = ['denied', 'permission', 'error'].includes(d.reason) ? d.reason : 'closed';
      let n = 0;
      [...sessions.values()].forEach(s => {
        const mine = s.owner === me.id || s.viewer === me.id;
        if (!mine) return;
        let hit = false;
        if (d.sid) hit = s.sid === String(d.sid);
        else if (d.name) hit = s.viewer === me.id && nameOf(s.owner).toLowerCase() === String(d.name).trim().toLowerCase();
        else if (d.all) hit = d.as === 'owner' ? s.owner === me.id : s.viewer === me.id;
        if (hit) { closeSession(s.sid, reason); n++; }
      });
      sendJson(res, 200, { ok: true, closed: n });
    });
  }

  // ----- owner reports media is live -----
  function handleReady(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    readBody(req, res, 8192, d => {
      const s = sessions.get(String(d.sid || ''));
      if (!s || s.owner !== me.id) return sendJson(res, 403, { ok: false, error: 'Not allowed' });
      if (!me.camShare) { closeSession(s.sid, 'sharing-off'); return sendJson(res, 403, { ok: false, error: 'Sharing is off' }); }
      if (s.state === 'ready') return sendJson(res, 409, { ok: false, error: 'Already answered by another tab' });
      s.state = 'ready';
      sendCam(s.viewer, 'camready', { sid: s.sid, ownerName: me.name });
      sendJson(res, 200, { ok: true });
    });
  }
  function handleSignal(req, res) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    readBody(req, res, MAX_SIGNAL, d => {
      const s = sessions.get(String(d.sid || ''));
      const kind = String(d.kind || '');
      if (!s || (s.owner !== me.id && s.viewer !== me.id) || !['offer', 'answer', 'ice'].includes(kind)) return sendJson(res, 403, { ok: false, error: 'Not allowed' });
      if (kind === 'offer' && s.viewer !== me.id) return sendJson(res, 403, { ok: false, error: 'Not allowed' });
      if (kind === 'answer' && s.owner !== me.id) return sendJson(res, 403, { ok: false, error: 'Not allowed' });
      if (!users.get(s.owner).camShare) { closeSession(s.sid, 'sharing-off'); return sendJson(res, 403, { ok: false, error: 'Sharing is off' }); }
      sendCam(s.owner === me.id ? s.viewer : s.owner, 'camsignal', { sid: s.sid, kind: kind, data: d.data });
      sendJson(res, 200, { ok: true });
    });
  }

  // ----- info -----
  function available(me) {
    return [...users.values()].filter(u => u.id !== me.id && u.camShare && hasAgreed(u) && isOnline(u.id))
      .map(u => ({ id: u.id, name: u.name, open: [...sessions.values()].some(s => s.owner === u.id && s.viewer === me.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function handleInfo(req, res, p) {
    const me = currentUser(req);
    if (!me) return sendJson(res, 401, { ok: false, error: 'Sign in first' });
    if (p === '/api/camera/available') return sendJson(res, 200, { ok: true, cameras: ADMIN_ONLY && !isAdmin(me) ? [] : available(me) });
    if (p === '/api/camera/mine') return sendJson(res, 200, { ok: true, sessions: [...sessions.values()].filter(s => s.viewer === me.id).map(s => view(s, me.id)) });
    if (p === '/api/camera/config') return sendJson(res, 200, { ok: true, iceServers: ICE, policyVersion: POLICY_VERSION, camShare: !!me.camShare, agreed: hasAgreed(me), adminOnly: ADMIN_ONLY });
    if (p === '/api/status') {
      const live = [...sessions.values()];
      return sendJson(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), users: users.size,
        online: camClients.size, sharing: [...users.values()].filter(u => u.camShare).length, streams: live.filter(s => s.viewer === me.id).length,
        memoryMB: Math.round(process.memoryUsage().rss / 1048576) });
    }
  }

  function handle(req, res, p) {
    const get = req.method === 'GET', post = req.method === 'POST';
    if (get && p === '/api/cam/events') { handleEvents(req, res); return true; }
    if (get && ['/api/camera/available', '/api/camera/mine', '/api/camera/config', '/api/status'].includes(p)) { handleInfo(req, res, p); return true; }
    if (post && p === '/api/camera/sharing') { handleSharing(req, res); return true; }
    if (post && p === '/api/camera/open') { handleOpen(req, res); return true; }
    if (post && p === '/api/camera/close') { handleClose(req, res); return true; }
    if (post && p === '/api/camera/ready') { handleReady(req, res); return true; }
    if (post && p === '/api/camera/signal') { handleSignal(req, res); return true; }
    return false;
  }
  return { handle, dropUser, POLICY_VERSION, hasAgreed, broadcastAvail };
};
