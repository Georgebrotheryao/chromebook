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
const QUALITY = parseInt(process.env.BROWSER_QUALITY, 10) || 35;
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
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio',
        '--disable-extensions', '--disable-component-update', '--disable-default-apps',
        '--disable-background-networking', '--disable-sync', '--disable-translate',
        '--disable-breakpad', '--disable-crash-reporter', '--no-first-run', '--metrics-recording-only',
        '--disable-hang-monitor', '--disable-ipc-flooding-protection',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=Translate,MediaRouter,OptimizationHints,AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
        '--renderer-process-limit=2',
        '--js-flags=--max-old-space-size=256',
        '--force-color-profile=srgb', '--hide-scrollbars'
      ]
    }).then(b => {
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

  // Every request goes through this check: only normal web pages, never the server's own network
  await context.route('**/*', async route => {
    let u;
    try { u = new URL(route.request().url()); } catch (e) { return route.abort().catch(() => {}); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return route.continue().catch(() => {});
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort().catch(() => {});
    const rt = route.request().resourceType();
    if (rt === 'media') return route.abort().catch(() => {});
    if (await hostBlocked(u.hostname)) return route.abort('blockedbyclient').catch(() => {});
    return route.continue().catch(() => {});
  });

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

  // Screen: ack a frame only after the previous one has left the socket, so frames never pile up
  let sw = w, sh = h;
  function wireScreencast() {
    const c = cdp;
    c.on('Page.screencastFrame', ev => {
      const ack = () => c.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      if (ended || ws.readyState !== 1) return ack();
      if (ws.bufferedAmount > 200000) return setTimeout(ack, 40); // client is behind: skip this frame
      ws.send(Buffer.from(ev.data, 'base64'), { binary: true }, ack);
    });
  }
  function startScreencast() {
    return cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: sw, maxHeight: sh, everyNthFrame: 1 });
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
    if (idle) enqueue(async () => { const m = moveSlot; moveSlot = null; await page.mouse.move(m.x, m.y); });
  }
  function accWheel(x, y, dx, dy) {
    const idle = !wheelAcc;
    if (idle) wheelAcc = { x: x, y: y, dx: 0, dy: 0 };
    wheelAcc.x = x; wheelAcc.y = y;
    wheelAcc.dx = Math.max(-2000, Math.min(2000, wheelAcc.dx + dx));
    wheelAcc.dy = Math.max(-2000, Math.min(2000, wheelAcc.dy + dy));
    if (idle) enqueue(async () => { const m = wheelAcc; wheelAcc = null; await page.mouse.move(m.x, m.y); await page.mouse.wheel(m.dx, m.dy); });
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
        else if (m.a === 'down') enqueue(async () => { await page.mouse.move(x, y); await page.mouse.down({ button: button, clickCount: clickCount }); });
        else if (m.a === 'up') enqueue(async () => { await page.mouse.move(x, y); await page.mouse.up({ button: button, clickCount: clickCount }); });
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
    if (url.pathname !== '/browser/ws') return socket.destroy();

    // Only signed-in users, and only from this site's own pages
    const user = currentUser(req);
    let sameOrigin = false;
    try { sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch (e) {}
    if (!user || !sameOrigin) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

    const size = { w: url.searchParams.get('w'), h: url.searchParams.get('h') };
    wss.handleUpgrade(req, socket, head, ws => {
      run(ws, user, size).catch(e => {
        console.error('Virtual browser error:', e);
        try { ws.close(); } catch (err) {}
      });
    });
  });
}

module.exports = { attach: attach, enabled: !!(WebSocketServer && chromium) };
