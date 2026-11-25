'use strict';
// Virtual browser: a real headless Chromium on the server, streamed to /browser over a WebSocket.
// Needs: npm install (ws + playwright-core) and Chromium installed (the Dockerfile handles that).

const dns = require('dns').promises;
const net = require('net');

let WebSocketServer = null;
let chromium = null;
try {
  WebSocketServer = require('ws').WebSocketServer;
  chromium = require('playwright-core').chromium;
} catch (e) {
  console.error('Virtual browser disabled (run "npm install"): ' + e.message);
}

// ---------- Settings (all optional environment variables on Railway) ----------
const MAX_SESSIONS = parseInt(process.env.BROWSER_MAX_SESSIONS, 10) || 2;               // browsers at once
const IDLE_MS = (parseInt(process.env.BROWSER_IDLE_MINUTES, 10) || 5) * 60 * 1000;      // close after no input
const MAX_MS = (parseInt(process.env.BROWSER_MAX_MINUTES, 10) || 90) * 60 * 1000;       // hard time limit
const HOME_URL = process.env.BROWSER_HOME || 'https://www.bing.com/';
// Used when something typed in the address bar is not a web address
const SEARCH_URL = process.env.BROWSER_SEARCH || 'https://www.bing.com/search?q=';
const MAX_W = 1280;   // capped: bigger viewports eat RAM/CPU and cause lag + crashes
const MAX_H = 720;
const QUALITY = parseInt(process.env.BROWSER_QUALITY, 10) || 50;
const FRAME_SKIP = parseInt(process.env.BROWSER_FRAME_SKIP, 10) || 2;   // 2 = about 30 fps max, halves CPU vs 60
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sessions = new Map(); // user id -> session
let browserPromise = null;
let shutdownTimer = null;

// ---------- Keep the virtual browser away from the server's own network ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const a = p[0], b = p[1];
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    if (l.startsWith('::ffff:')) {
      const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
      return m ? isPrivateIp(m[1]) : true;
    }
    return false;
  }
  return true;
}

const hostCache = new Map(); // host -> { blocked, t }
const hostPending = new Map(); // host -> Promise (one lookup per host at a time)
async function hostBlocked(host) {
  host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.t < 300000) return hit.blocked;
  if (hostPending.has(host)) return hostPending.get(host);
  const p = (async () => {
    let blocked = false;
    try {
      const addrs = await dns.lookup(host, { all: true });
      blocked = addrs.some(a => isPrivateIp(a.address));
    } catch (e) {
      blocked = false; // does not resolve: Chromium will show its own error page
    }
    if (hostCache.size > 500) hostCache.clear();
    hostCache.set(host, { blocked: blocked, t: Date.now() });
    return blocked;
  })().finally(() => hostPending.delete(host));
  hostPending.set(host, p);
  return p;
}


// ---------- Local filtering proxy ----------
// Chromium sends all traffic through this tiny in-process proxy instead of Playwright's per-request
// route() hook (which round-trips EVERY request through Node and was a big source of lag).
// The proxy also connects to the IP it checked (no DNS-rebinding trick) and drops ad/tracker hosts,
// which saves a lot of CPU/RAM on a 1 vCPU / 0.5 GB Railway free instance.
const http = require('http');
const BLOCK_HOSTS = (process.env.BROWSER_BLOCK_ADS === '0') ? [] : [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'adnxs.com', 'adsrvr.org',
  'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'scorecardresearch.com', 'quantserve.com',
  'hotjar.com', 'facebook.net', 'connect.facebook.net', 'ads-twitter.com', 'amazon-adsystem.com',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'moatads.com', 'adform.net',
  'mathtag.com', 'bluekai.com', 'demdex.net', 'krxd.net', 'yieldmo.com', 'smartadserver.com',
  'mgid.com', 'popads.net', 'propellerads.com', 'exoclick.com', 'adsterra.com', 'clarity.ms',
  'segment.io', 'segment.com', 'mixpanel.com', 'newrelic.com', 'nr-data.net', 'sentry.io'
];
function adHost(host) {
  for (let i = 0; i < BLOCK_HOSTS.length; i++) {
    const b = BLOCK_HOSTS[i];
    if (host === b || host.endsWith('.' + b)) return true;
  }
  return false;
}

const ipCache = new Map(); // host -> { ip, t }
async function resolvePublic(host) {
  host = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return null;
  if (adHost(host)) return null;
  if (net.isIP(host)) return isPrivateIp(host) ? null : host;
  const hit = ipCache.get(host);
  if (hit && Date.now() - hit.t < 60000) return hit.ip;
  let ip = null;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.length && !addrs.some(a => isPrivateIp(a.address))) ip = addrs[0].address;
  } catch (e) {}
  if (ipCache.size > 500) ipCache.clear();
  ipCache.set(host, { ip: ip, t: Date.now() });
  return ip;
}

let proxyPromise = null;
function startProxy() {
  if (proxyPromise) return proxyPromise;
  proxyPromise = new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {          // plain http:// requests
      let u;
      try { u = new URL(req.url); } catch (e) { res.writeHead(400); return res.end(); }
      if (u.protocol !== 'http:') { res.writeHead(403); return res.end(); }
      const ip = await resolvePublic(u.hostname);
      if (!ip) { res.writeHead(403); return res.end(); }
      const headers = Object.assign({}, req.headers);
      delete headers['proxy-connection'];
      const up = http.request({ host: ip, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: headers, timeout: 30000 }, r => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', () => { try { res.writeHead(502); } catch (e) {} res.end(); });
      up.on('timeout', () => up.destroy());
      req.pipe(up);
    });
    srv.on('connect', async (req, client, head) => {              // https:// tunnels
      client.on('error', () => {});
      const m = /^(.+):(\d+)$/.exec(req.url || '');
      if (!m) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      const ip = await resolvePublic(m[1]);
      if (!ip) return client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      const up = net.connect({ host: ip, port: parseInt(m[2], 10), timeout: 30000 }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(client);
        client.pipe(up);
      });
      up.setNoDelay(true);
      client.setNoDelay(true);
      up.on('timeout', () => up.destroy());
      up.on('error', () => client.destroy());
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });
  return proxyPromise;
}

// ---------- Helpers ----------
function num(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function normalizeInput(text) {
  text = String(text || '').trim().slice(0, 2000);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^(javascript|data|file|blob|about|chrome|view-source|ftp):/i.test(text)) return null;
  if (!/\s/.test(text) && (text.indexOf('.') > 0 || /^localhost(:\d+)?(\/|$)/i.test(text))) return 'https://' + text;
  return SEARCH_URL + encodeURIComponent(text);
}

function getBrowser() {
  clearTimeout(shutdownTimer);
  if (!browserPromise) {
    browserPromise = startProxy().then(port => chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
        '--disable-extensions', '--disable-component-update', '--disable-default-apps',
        '--disable-background-networking', '--disable-sync', '--disable-translate',
        '--disable-breakpad', '--disable-crash-reporter', '--no-first-run', '--metrics-recording-only',
        '--disable-hang-monitor', '--disable-ipc-flooding-protection',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--renderer-process-limit=1', '--disable-site-isolation-trials',
        '--js-flags=--max-old-space-size=192 --max-lazy',
        '--enable-low-end-device-mode', '--disable-low-res-tiling', '--disable-lcd-text',
        '--disable-smooth-scrolling', '--autoplay-policy=user-gesture-required',
        '--disable-quic', '--disable-features=Translate,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,IsolateOrigins,site-per-process,BackForwardCache,PaintHolding,AutofillServerCommunication,CalculateNativeWinOcclusion',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-server=http://127.0.0.1:' + port, '--proxy-bypass-list=<-loopback>',
        '--force-color-profile=srgb', '--hide-scrollbars'
      ]
    })).then(b => {
      b.on('disconnected', () => {
        browserPromise = null;
        sessions.forEach(s => s.end('The browser stopped unexpectedly.', 4006));
      });
      return b;
    }).catch(e => {
      browserPromise = null;
      throw e;
    });
  }
  return browserPromise;
}

// Free the RAM when nobody is using it
function scheduleShutdown() {
  clearTimeout(shutdownTimer);
  if (sessions.size > 0 || !browserPromise) return;
  shutdownTimer = setTimeout(async () => {
    if (sessions.size > 0 || !browserPromise) return;
    const p = browserPromise;
    browserPromise = null;
    try { (await p).close(); } catch (e) {}
  }, 60000);
}

// ---------- One viewer = one isolated browser context ----------
async function run(ws, user, size) {
  let ended = false;
  let context = null;
  let timer = null;
  let lastActive = Date.now();
  const started = Date.now();
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const s = { end: null };

  async function end(msg, code) {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    if (sessions.get(user.id) === s) sessions.delete(user.id);
    if (msg) send({ t: 'end', msg: msg });
    try { ws.close(code || 1000); } catch (e) {}
    if (context) await context.close().catch(() => {});
    scheduleShutdown();
  }
  s.end = end;
  ws.on('close', () => end());
  ws.on('error', () => end());

  // One session per account, and a limit for the whole server
  const old = sessions.get(user.id);
  if (old) old.end('Opened in another window.', 4003);
  if (sessions.size >= MAX_SESSIONS) {
    return end('All virtual browsers are busy right now. Try again in a minute.', 4001);
  }
  sessions.set(user.id, s);

  timer = setInterval(() => {
    if (Date.now() - lastActive > IDLE_MS) end('Session closed because it was idle.', 4002);
    else if (Date.now() - started > MAX_MS) end('Session time limit reached.', 4005);
  }, 15000);

  const w = Math.round(num(size.w, 320, MAX_W));
  const h = Math.round(num(size.h, 240, MAX_H));

  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      viewport: { width: w, height: h },
      userAgent: UA,
      locale: 'en-US',
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
      acceptDownloads: false
    });
  } catch (e) {
    console.error('Virtual browser failed to start:', e.message);
    return end('The browser could not start. Try again in a moment.', 4004);
  }
  if (ended) { await context.close().catch(() => {}); return; }

  // Network filtering (private IPs, ads) is done by the local proxy, not per request in Node.

  let page, cdp;
  try {
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  } catch (e) {
    return end('The browser could not start. Try again in a moment.', 4004);
  }

  // Links that try to open a new tab load in the same tab instead
  context.on('page', async p => {
    if (p === page) return;
    try {
      await p.waitForURL(u => u.href !== 'about:blank', { timeout: 5000, waitUntil: 'commit' }).catch(() => {});
      const u = p.url();
      await p.close().catch(() => {});
      if (/^https?:/.test(u)) page.goto(u, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    } catch (e) {}
  });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  let crashes = 0;
  page.on('crash', async () => {
    if (ended || ++crashes > 3) return end('The page crashed.', 4006);
    try {
      const u = page.url();
      await page.close().catch(() => {});
      page = await context.newPage();
      cdp = await context.newCDPSession(page);
      page.on('dialog', d => d.dismiss().catch(() => {}));
      wireScreencast();
      await startScreencast();
      if (/^https?:/.test(u)) page.goto(u, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
      send({ t: 'err', msg: 'Page ran out of memory and was restarted.' });
    } catch (e) { end('The page crashed.', 4006); }
  });

  // Address bar + back/forward state
  let metaTimer = null;
  function pushMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
      if (ended) return;
      try {
        const hist = await cdp.send('Page.getNavigationHistory');
        const url = page.url();
        send({
          t: 'meta',
          url: url === 'about:blank' ? '' : url,
          back: hist.currentIndex > 0,
          fwd: hist.currentIndex < hist.entries.length - 1
        });
      } catch (e) {}
    }, 80);
  }
  page.on('framenavigated', f => { if (f === page.mainFrame()) pushMeta(); });
  page.on('domcontentloaded', pushMeta);
  page.on('load', pushMeta);

  // Screen: ack a frame only after the previous one has left the socket, so frames never pile up.
  // Quality adapts: if the link/CPU is slow we send smaller frames, if it is fast we sharpen again.
  let sw = w, sh = h;
  let q = QUALITY, sendMs = 0, lastAdapt = 0;
  function adapt() {
    const now = Date.now();
    if (now - lastAdapt < 3000 || ended) return;
    let nq = q;
    if (sendMs > 70) nq = Math.max(25, q - 8);
    else if (sendMs < 20) nq = Math.min(QUALITY, q + 4);
    if (nq === q) return;
    lastAdapt = now; q = nq;
    cdp.send('Page.stopScreencast').then(startScreencast).catch(() => {});
  }
  function wireScreencast() {
    const c = cdp;
    c.on('Page.screencastFrame', ev => {
      const ack = () => c.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      if (ended || ws.readyState !== 1) return ack();
      if (ws.bufferedAmount > 60000) { sendMs = Math.max(sendMs, 100); adapt(); return setTimeout(ack, 30); } // client behind: drop frame
      const t0 = Date.now();
      ws.send(Buffer.from(ev.data, 'base64'), { binary: true }, () => {
        sendMs = sendMs * 0.8 + (Date.now() - t0) * 0.2;
        ack();
        adapt();
      });
    });
  }
  function startScreencast() {
    return cdp.send('Page.startScreencast', { format: 'jpeg', quality: q, maxWidth: sw, maxHeight: sh, everyNthFrame: FRAME_SKIP });
  }
  wireScreencast();
  try {
    await startScreencast();
  } catch (e) {
    return end('The browser could not start. Try again in a moment.', 4004);
  }

  // Mouse and keyboard run one after another, in order
  let queue = Promise.resolve();
  let queued = 0;
  function enqueue(fn, droppable) {
    if (droppable && queued > 8) return;
    queued++;
    queue = queue.then(fn).catch(() => {}).then(() => { queued--; });
  }
  // Only the newest mouse position matters: keep one pending move instead of a backlog
  let moveSlot = null, wheelAcc = null;
  function latestMove(x, y) {
    const idle = !moveSlot;
    moveSlot = { x: x, y: y };
    if (idle) enqueue(async () => { const m = moveSlot; moveSlot = null; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: m.x, y: m.y }); });
  }
  function accWheel(x, y, dx, dy) {
    const idle = !wheelAcc;
    if (idle) wheelAcc = { x: x, y: y, dx: 0, dy: 0 };
    wheelAcc.x = x; wheelAcc.y = y;
    wheelAcc.dx = Math.max(-2000, Math.min(2000, wheelAcc.dx + dx));
    wheelAcc.dy = Math.max(-2000, Math.min(2000, wheelAcc.dy + dy));
    if (idle) enqueue(async () => { const m = wheelAcc; wheelAcc = null; await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.dx, deltaY: m.dy }); });
  }

  async function navigate(text) {
    const target = normalizeInput(text);
    let u = null;
    try { u = target && new URL(target); } catch (e) {}
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
      return send({ t: 'err', msg: 'Enter a web address or a search.' });
    }
    if (await hostBlocked(u.hostname)) return send({ t: 'err', msg: 'That address is not allowed.' });
    page.goto(u.href, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
  }

  function handle(m) {
    switch (m.t) {
      case 'mouse': {
        const x = num(m.x, 0, MAX_W);
        const y = num(m.y, 0, MAX_H);
        const button = ['left', 'middle', 'right'][m.b] || 'left';
        const clickCount = Math.round(num(m.n || 1, 1, 3));
        if (m.a === 'move') latestMove(x, y);
        else if (m.a === 'down') enqueue(() => cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x, y: y, button: button, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4, clickCount: clickCount }));
        else if (m.a === 'up') enqueue(() => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x, y: y, button: button, buttons: 0, clickCount: clickCount }));
        break;
      }
      case 'wheel': {
        const x = num(m.x, 0, MAX_W);
        const y = num(m.y, 0, MAX_H);
        const dx = num(m.dx, -1000, 1000);
        const dy = num(m.dy, -1000, 1000);
        accWheel(x, y, dx, dy);
        break;
      }
      case 'key': {
        const key = String(m.key || '').slice(0, 20);
        if (!key) break;
        const k = key === ' ' ? 'Space' : key;
        enqueue(() => (m.a === 'up' ? page.keyboard.up(k) : page.keyboard.down(k)));
        break;
      }
      case 'text':
        enqueue(() => page.keyboard.insertText(String(m.text || '').slice(0, 10000)));
        break;
      case 'copy':
        enqueue(async () => {
          const read = page.evaluate(() => {
            const a = document.activeElement;
            if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number' && a.selectionStart !== a.selectionEnd) {
              try { return a.value.slice(a.selectionStart, a.selectionEnd); } catch (e) {}
            }
            return String(window.getSelection());
          });
          const text = await Promise.race([read, new Promise(r => setTimeout(() => r(''), 2000))]);
          send({ t: 'clip', text: String(text || '').slice(0, 20000) });
        });
        break;
      case 'goto': navigate(m.url); break;
      case 'back': page.goBack({ waitUntil: 'commit', timeout: 15000 }).catch(() => {}); break;
      case 'fwd': page.goForward({ waitUntil: 'commit', timeout: 15000 }).catch(() => {}); break;
      case 'reload': page.reload({ waitUntil: 'commit', timeout: 15000 }).catch(() => {}); break;
      case 'size': {
        const nw = Math.round(num(m.w, 320, MAX_W));
        const nh = Math.round(num(m.h, 240, MAX_H));
        if (nw === sw && nh === sh) break;
        sw = nw; sh = nh;
        page.setViewportSize({ width: nw, height: nh })
          .then(() => cdp.send('Page.stopScreencast').then(startScreencast))
          .catch(() => {});
        break;
      }
    }
  }

  ws.on('message', (raw, isBinary) => {
    if (isBinary || ended) return;
    lastActive = Date.now();
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m && typeof m === 'object') handle(m);
  });

  send({ t: 'ready' });
  page.goto(HOME_URL, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
}

// ---------- Hook into the existing HTTP server ----------
function attach(server, currentUser) {
  if (!WebSocketServer || !chromium) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
    if (url.pathname !== '/browser/ws') return; // other paths (e.g. /mobile/ws) are handled by android.js

    // Only signed-in users, and only from this site's own pages
    const user = currentUser(req);
    let sameOrigin = false;
    try { sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch (e) {}
    if (!user || !sameOrigin) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

    const size = { w: url.searchParams.get('w'), h: url.searchParams.get('h') };
    socket.setNoDelay(true);   // send input/frames immediately instead of waiting to batch
    wss.handleUpgrade(req, socket, head, ws => {
      run(ws, user, size).catch(e => {
        console.error('Virtual browser error:', e);
        try { ws.close(); } catch (err) {}
      });
    });
  });
}

module.exports = { attach: attach, enabled: !!(WebSocketServer && chromium) };
