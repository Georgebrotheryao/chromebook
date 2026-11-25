'use strict';
// Android phone: one shared Android guest booted by QEMU (software emulation, no KVM needed) and shown
// in /mobile through noVNC. The browser's WebSocket is bridged straight to QEMU's local VNC port.
// Needs: qemu-system-x86_64 + qemu-img installed (the Dockerfile does this) and an Android-x86 / BlissOS ISO.
//
// Environment variables (all optional):
//   ANDROID_ISO_URL        direct https link to an Android-x86/BlissOS .iso, downloaded once into the data folder
//   ANDROID_ISO            path to an ISO you placed yourself (default <DATA_DIR>/android/android.iso)
//   ANDROID_RAM_MB         guest RAM (default 1536)       ANDROID_CPUS    guest CPUs (default 2)
//   ANDROID_DISK_SIZE      virtual disk size (default 4G) ANDROID_IDLE_MINUTES  power off after no viewers (default 30)
//   ANDROID_ACCEL          'tcg' (default) or 'kvm' when /dev/kvm exists
//   ANDROID_FORCE=1        start even if the memory limit looks too small (risks the whole site being OOM-killed)
//   ANDROID_QEMU_BOOT_ARGS replaces the ISO/disk boot arguments (debugging)

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (e) { console.error('Android disabled: ' + e.message); }

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DIR = path.join(DATA_DIR, 'android');
const ISO = process.env.ANDROID_ISO || path.join(DIR, 'android.iso');
const ISO_URL = process.env.ANDROID_ISO_URL || '';
const DISK = path.join(DIR, 'android.qcow2');
const INSTALLED = path.join(DIR, 'installed');
const DISK_SIZE = process.env.ANDROID_DISK_SIZE || '4G';
const RAM_MB = parseInt(process.env.ANDROID_RAM_MB, 10) || 1536;
const CPUS = parseInt(process.env.ANDROID_CPUS, 10) || 2;
const IDLE_MS = (parseInt(process.env.ANDROID_IDLE_MINUTES, 10) || 30) * 60 * 1000;
const ACCEL = process.env.ANDROID_ACCEL === 'kvm' ? 'kvm' : 'tcg,thread=multi,tb-size=128';
const FORCE = process.env.ANDROID_FORCE === '1';
const BOOT_OVERRIDE = (process.env.ANDROID_QEMU_BOOT_ARGS || '').trim();
const VNC_DISPLAY = 7;                       // QEMU VNC on 127.0.0.1:5907 (never exposed outside the container)
const VNC_PORT = 5900 + VNC_DISPLAY;
const MAX_VIEWERS = 2;
const QEMU_OVERHEAD_MB = 400;                // QEMU + translation cache on top of the guest RAM
const NOVNC_ROOT = path.join(__dirname, 'node_modules', '@novnc', 'novnc');

const haveQemu = ['qemu-system-x86_64', 'qemu-img'].every(b => {
  try { return spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0; } catch (e) { return false; }
});
const enabled = !!(WebSocketServer && haveQemu) && process.env.ANDROID_DISABLED !== '1';   // ANDROID_DISABLED=1 switches the feature off

let vm = null;                // { proc, startedAt, exited }
let viewers = 0;
let idleTimer = null;
let download = null;          // { pct, error }

// ---------- Memory the container really has ----------
function memoryLimitMb() {
  let limit = os.totalmem();
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const v = parseInt(fs.readFileSync(f, 'utf8'), 10);
      if (v > 0 && v < limit) limit = v;
    } catch (e) {}
  }
  return Math.floor(limit / 1048576);
}

function isInstalled() { return fs.existsSync(INSTALLED) && fs.existsSync(DISK); }
function hasIso() { return fs.existsSync(ISO); }

// ---------- Status shown on the page ----------
function status() {
  const s = { enabled: enabled, ramMb: RAM_MB, installed: isInstalled(), running: !!(vm && !vm.exited), viewers: viewers };
  if (!enabled) { s.state = 'unavailable'; s.message = haveQemu ? 'Android is not available on this server.' : 'QEMU is not installed on this server.'; return s; }
  const limit = memoryLimitMb();
  if (!s.running && !FORCE && limit < RAM_MB + QEMU_OVERHEAD_MB) {
    s.state = 'lowmem';
    s.message = 'This server only has about ' + limit + ' MB of memory. The Android guest needs about ' + (RAM_MB + QEMU_OVERHEAD_MB) + ' MB, so it is not started to protect the rest of the site. Use a plan with 2 GB or more, or lower ANDROID_RAM_MB.';
    return s;
  }
  if (download) {
    s.state = download.error ? 'error' : 'downloading';
    s.message = download.error ? 'Download failed: ' + download.error : 'Downloading the Android image... ' + download.pct + '%';
    return s;
  }
  if (!BOOT_OVERRIDE && !hasIso() && !isInstalled()) {
    s.state = ISO_URL ? 'needs-download' : 'needs-iso';
    s.message = ISO_URL ? 'The Android image has not been downloaded yet.' : 'No Android image yet. Set ANDROID_ISO_URL (direct link to an Android-x86 or BlissOS .iso) or put the file at ' + ISO + '.';
    return s;
  }
  s.state = s.running ? 'on' : 'off';
  s.mode = isInstalled() ? 'disk' : 'installer';
  return s;
}

// ---------- Image download (follows redirects, https only) ----------
function downloadIso(url, redirects) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad ANDROID_ISO_URL')); }
    if (u.protocol !== 'https:') return reject(new Error('ANDROID_ISO_URL must be https'));
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadIso(new URL(res.headers.location, u).href, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'], 10) || 0;
      if (total > 4 * 1024 ** 3) { res.resume(); return reject(new Error('file too large')); }
      fs.mkdirSync(DIR, { recursive: true });
      const part = ISO + '.part';
      const out = fs.createWriteStream(part);
      let got = 0;
      res.on('data', c => { got += c.length; if (total) download.pct = Math.floor(got * 100 / total); });
      res.pipe(out);
      out.on('finish', () => { fs.renameSync(part, ISO); resolve(); });
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

function kickDownload() {
  if (download || BOOT_OVERRIDE || hasIso() || isInstalled() || !ISO_URL) return;
  download = { pct: 0, error: '' };
  downloadIso(ISO_URL, 0).then(() => { download = null; }, e => {
    console.error('Android image download failed:', e.message);
    download.error = e.message;
    setTimeout(() => { download = null; }, 60000);
  });
}

// ---------- The virtual machine ----------
function startVm() {
  if (vm && !vm.exited) return;
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(DISK)) {
    const r = spawnSync('qemu-img', ['create', '-f', 'qcow2', DISK, DISK_SIZE], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('qemu-img failed: ' + r.stderr);
  }
  const boot = BOOT_OVERRIDE ? BOOT_OVERRIDE.split(/\s+/) : (isInstalled() ? ['-boot', 'c'] : ['-cdrom', ISO, '-boot', 'd']);
  const args = [
    '-accel', ACCEL, '-cpu', 'max', '-smp', String(CPUS), '-m', String(RAM_MB),
    '-drive', 'file=' + DISK + ',if=virtio,format=qcow2,cache=writeback',
    ...boot,
    '-vga', 'std',
    '-device', 'qemu-xhci', '-device', 'usb-tablet',   // absolute mouse; keyboard is the built-in PS/2 one
    '-nic', 'user,model=virtio-net-pci',
    '-display', 'none', '-vnc', '127.0.0.1:' + VNC_DISPLAY,
    '-monitor', 'unix:' + path.join(DIR, 'monitor.sock') + ',server,nowait'
  ];
  try { fs.unlinkSync(path.join(DIR, 'monitor.sock')); } catch (e) {}
  console.log('Starting Android guest: qemu-system-x86_64 ' + args.join(' '));
  const proc = spawn('qemu-system-x86_64', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const cur = { proc: proc, startedAt: Date.now(), exited: false };
  vm = cur;
  proc.stderr.on('data', d => { const t = String(d).trim(); if (t && !/pw\.conf|client\.conf/.test(t)) console.error('[qemu] ' + t.slice(0, 300)); });
  proc.on('exit', code => { cur.exited = true; console.log('Android guest stopped (' + code + ')'); });
  proc.on('error', e => { cur.exited = true; console.error('Could not start QEMU:', e.message); });
}

function stopVm() {
  const cur = vm;
  if (!cur || cur.exited) return;
  // Ask Android to shut down cleanly (ACPI power button), then force it after a short grace period
  try {
    const m = net.connect(path.join(DIR, 'monitor.sock'));
    m.on('connect', () => { m.write('system_powerdown\n'); setTimeout(() => m.destroy(), 500); });
    m.on('error', () => {});
  } catch (e) {}
  setTimeout(() => { if (!cur.exited) cur.proc.kill('SIGTERM'); }, 20000);
}

function viewerChange(delta) {
  viewers = Math.max(0, viewers + delta);
  clearTimeout(idleTimer);
  if (viewers === 0) idleTimer = setTimeout(stopVm, IDLE_MS);
}

process.on('exit', () => { try { if (vm && !vm.exited) vm.proc.kill('SIGKILL'); } catch (e) {} });

function waitForVnc(timeoutMs) {
  const end = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function tryOnce() {
      const s = net.connect(VNC_PORT, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => {
        s.destroy();
        if (vm && vm.exited) return reject(new Error('QEMU exited'));
        if (Date.now() > end) return reject(new Error('VNC not ready'));
        setTimeout(tryOnce, 500);
      });
    })();
  });
}

// ---------- HTTP routes (called from server.js) ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Returns true when the request was handled here.
function handle(req, res, p, user, admin) {
  if (p === '/mobile/status' && req.method === 'GET') {
    if (!user) return json(res, 401, { error: 'sign in' }), true;
    const s = status(); s.admin = !!admin;
    return json(res, 200, s), true;
  }
  if (p === '/mobile/start' && req.method === 'POST') {
    if (!user) return json(res, 401, { error: 'sign in' }), true;
    if (status().state === 'needs-download') kickDownload();
    return json(res, 200, status()), true;
  }
  if (p === '/mobile/installed' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' }), true;
    try {
      if (isInstalled()) fs.unlinkSync(INSTALLED); else if (fs.existsSync(DISK)) fs.writeFileSync(INSTALLED, String(Date.now()));
    } catch (e) {}
    return json(res, 200, status()), true;
  }
  if (p === '/mobile/stop' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' }), true;
    stopVm();
    return json(res, 200, status()), true;
  }
  if (p.startsWith('/mobile/novnc/') && req.method === 'GET') {
    const rel = p.slice('/mobile/novnc/'.length);
    if (!user || !/^(core|vendor)\/[A-Za-z0-9_./-]+\.js$/.test(rel) || rel.includes('..')) return json(res, 404, { error: 'not found' }), true;
    fs.readFile(path.join(NOVNC_ROOT, rel), (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return true;
  }
  return false;
}

// ---------- WebSocket bridge: browser <-> QEMU's VNC port ----------
function attach(server, currentUser) {
  if (!enabled) return;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Registered after cloudbrowser.attach, whose listener only handles /browser/ws and ignores the rest
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { return socket.destroy(); }
    if (url.pathname === '/browser/ws') return;
    if (url.pathname !== '/mobile/ws') return socket.destroy();

    const user = currentUser(req);
    let sameOrigin = false;
    try { sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch (e) {}
    if (!user || !sameOrigin) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    if (viewers >= MAX_VIEWERS) return socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    const st = status();
    if (st.state !== 'off' && st.state !== 'on') return socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');

    viewerChange(1);
    let counted = true;
    const release = () => { if (counted) { counted = false; viewerChange(-1); } };
    (async () => {
      startVm();
      const tcp = await waitForVnc(30000);
      wss.handleUpgrade(req, socket, head, ws => {
        tcp.on('data', d => { if (ws.readyState === 1) ws.send(d); });
        ws.on('message', d => { if (!tcp.destroyed) tcp.write(d); });
        tcp.on('close', () => { try { ws.close(); } catch (e) {} });
        tcp.on('error', () => { try { ws.close(); } catch (e) {} });
        ws.on('close', () => { tcp.destroy(); release(); });
        ws.on('error', () => { tcp.destroy(); release(); });
      });
    })().catch(e => {
      console.error('Android connect error:', e.message);
      release();
      try { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); } catch (err) {}
    });
  });
}

module.exports = { attach: attach, handle: handle, enabled: enabled, status: status };
