/* Command Center + camera sharing host. Loaded on every page; only active when signed in. */
(function () {
  'use strict';
  var POLICY_HTML = '<h3>Camera Access Policy <small>(version 1.0)</small></h3>' +
    '<p><b>What this feature is.</b> This website has a camera-sharing feature. If you turn it on, authorized signed-in users can start a live view of your camera from the website\'s command center while you are online.</p>' +
    '<ul>' +
    '<li><b>It is opt-in.</b> Nothing happens unless camera sharing is enabled in your account settings (<code>/camera sharing on</code> or the switch in the Camera Gallery). You can turn it off at any time.</li>' +
    '<li><b>Your browser still asks.</b> You must grant the website browser camera permission. We never bypass browser permission systems. If you deny or revoke it, no stream can start or continue.</li>' +
    '<li><b>Only while you are online.</b> A camera can only be activated while you are signed in and have the website open. It stops when you log out, close the tab, lose connection, or leave the site.</li>' +
    '<li><b>You will always see it.</b> While your camera is being streamed, a clear red indicator is shown on every page of the website.</li>' +
    '<li><b>You are in control.</b> You can stop any stream, or all streams, from the indicator, and turning sharing off ends every active stream immediately.</li>' +
    '<li><b>No recording.</b> Camera footage is never recorded or stored. Video goes directly between browsers (peer to peer); the server only passes connection set-up messages. No audio is shared.</li>' +
    '<li><b>Limited access.</b> Streams are only available to authenticated, authorized users, and only to the user who opened them.</li>' +
    '<li><b>Think before enabling.</b> Do not enable camera sharing on devices or in places where you expect complete privacy.</li>' +
    '</ul><p>Agreeing to this policy does not turn your camera on. It only confirms that you understand how the feature works.</p>';

  function css() {
    if (document.getElementById('cc-css')) return;
    var s = document.createElement('style'); s.id = 'cc-css';
    s.textContent =
      '#cc-win{position:fixed;left:50%;bottom:14px;width:min(600px,calc(100vw - 16px));height:min(280px,50vh);z-index:2147483000;display:flex;flex-direction:column;background:#0c0c0c;color:#ccc;border:1px solid #6b6b6b;box-shadow:0 8px 30px rgba(0,0,0,.6);font:13px/1.35 Consolas,"Courier New",monospace;transform:translate(-50%,30px) scale(.97);opacity:0;pointer-events:none;transition:transform .18s ease,opacity .18s ease}' +
      '#cc-win.open{transform:translate(-50%,0) scale(1);opacity:1;pointer-events:auto}' +
      '#cc-win .tb{display:flex;align-items:center;height:26px;background:#fff;color:#000;font:12px "Segoe UI",system-ui,sans-serif;padding-left:8px;user-select:none}' +
      '#cc-win .tb span{flex:1}#cc-win .tb button{width:40px;height:26px;border:0;background:transparent;color:#000;font-size:13px;cursor:pointer}#cc-win .tb button:hover{background:#e81123;color:#fff}' +
      '#cc-out{flex:1;overflow:auto;padding:6px 8px;white-space:pre-wrap;word-break:break-word}#cc-out .e{color:#ff7b7b}#cc-out .o{color:#7bd88f}#cc-out .c{color:#fff}' +
      '#cc-in{display:flex;align-items:center;border-top:1px solid #333;padding:4px 8px}#cc-in b{font-weight:400;margin-right:6px;color:#fff}' +
      '#cc-in input{flex:1;background:transparent;border:0;outline:0;color:#fff;font:inherit;min-width:0}' +
      '#cc-win.light{background:#fff;color:#222;border-color:#999}#cc-win.light #cc-out .c,#cc-win.light #cc-in b,#cc-win.light #cc-in input{color:#000}#cc-win.light #cc-in{border-color:#ccc}#cc-win.light .tb{background:#e6e6e6}' +
      '#cc-fab{position:fixed;right:12px;bottom:12px;z-index:2147482990;height:30px;padding:0 10px;background:#0c0c0c;color:#fff;border:1px solid #6b6b6b;font:12px Consolas,monospace;cursor:pointer;opacity:.75}#cc-fab:hover{opacity:1}' +
      '#cc-live{position:fixed;top:0;left:0;right:0;z-index:2147483100;display:none;align-items:center;gap:10px;flex-wrap:wrap;background:#d00;color:#fff;padding:6px 12px;font:600 13px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.4)}' +
      '#cc-live i{width:10px;height:10px;border-radius:50%;background:#fff;animation:ccb 1s infinite}@keyframes ccb{50%{opacity:.2}}#cc-live span{flex:1;min-width:140px}#cc-live button{background:#fff;color:#900;border:0;border-radius:4px;padding:4px 10px;font:inherit;cursor:pointer}' +
      '#cc-modal{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px}' +
      '#cc-modal .box{width:min(560px,100%);max-height:88vh;display:flex;flex-direction:column;background:#1b1d24;color:#e7e9f0;border:1px solid #3a3f50;border-radius:10px;font:14px/1.5 system-ui,sans-serif}' +
      '#cc-modal .body{padding:16px 20px;overflow:auto}#cc-modal h3{margin-bottom:8px}#cc-modal small{color:#8a93a8;font-weight:400}#cc-modal ul{padding-left:18px;margin:8px 0}#cc-modal li{margin:6px 0}#cc-modal code{background:#0c0f16;padding:1px 5px;border-radius:4px}' +
      '#cc-modal .ft{display:flex;gap:8px;justify-content:flex-end;padding:10px 16px;border-top:1px solid #2a3040}#cc-modal button{border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer;background:#2a3040;color:#fff}#cc-modal button.p{background:#5a6df0}';
    document.head.appendChild(s);
  }

  // ---- policy modal (works signed out, e.g. on the signup page) ----
  window.CamPolicy = {
    show: function (needAccept) {
      css();
      return new Promise(function (resolve) {
        var m = document.createElement('div'); m.id = 'cc-modal';
        m.innerHTML = '<div class="box" role="dialog" aria-modal="true"><div class="body">' + POLICY_HTML + '</div><div class="ft"></div></div>';
        var ft = m.querySelector('.ft');
        function done(v) { m.remove(); resolve(v); }
        var close = document.createElement('button'); close.textContent = needAccept ? 'Decline' : 'Close'; close.onclick = function () { done(false); };
        ft.appendChild(close);
        if (needAccept) { var ok = document.createElement('button'); ok.className = 'p'; ok.textContent = 'I agree'; ok.onclick = function () { done(true); }; ft.appendChild(ok); }
        m.addEventListener('click', function (e) { if (e.target === m) done(false); });
        document.body.appendChild(m);
      });
    }
  };

  var me = null, cfg = null;
  var bus = {};
  window.CamBus = { on: function (t, f) { (bus[t] = bus[t] || []).push(f); }, emit: function (t, d) { (bus[t] || []).forEach(function (f) { try { f(d); } catch (e) {} }); } };

  function api(path, body) {
    var o = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(path, o).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'Could not reach the server.' }; });
  }
  window.CamApi = api;

  fetch('/api/me').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.user) return;
    me = d.user;
    api('/api/camera/config').then(function (c) { cfg = c; });
    start();
  }).catch(function () {});

  function start() {
    css();
    window.CamMe = me;
    // ================= owner side: camera host =================
    var live = document.createElement('div'); live.id = 'cc-live';
    live.innerHTML = '<i></i><span id="cc-livetxt"></span><button id="cc-stop">Stop all</button><button id="cc-off">Turn off sharing</button>';
    document.body.appendChild(live);
    var localStream = null, peers = {}, pend = {}, viewers = {};
    var baseTitle = document.title;

    function refreshIndicator() {
      var ids = Object.keys(peers), names = ids.map(function (k) { return viewers[k]; }).filter(Boolean);
      live.style.display = ids.length ? 'flex' : 'none';
      document.getElementById('cc-livetxt').textContent = '● Your camera is live' + (names.length ? ' — viewed by ' + names.join(', ') : '');
      document.title = ids.length ? '● LIVE · ' + baseTitle.replace(/^● LIVE · /, '') : baseTitle.replace(/^● LIVE · /, '');
      if (!ids.length && localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
    }
    function dropPeer(sid) {
      if (peers[sid]) { try { peers[sid].close(); } catch (e) {} delete peers[sid]; }
      delete pend[sid]; delete viewers[sid]; refreshIndicator();
    }
    function getStream() {
      if (localStream && localStream.getVideoTracks().some(function (t) { return t.readyState === 'live'; })) return Promise.resolve(localStream);
      return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } }, audio: false }).then(function (s) {
        localStream = s;
        s.getVideoTracks()[0].addEventListener('ended', function () {   // permission revoked / device unplugged
          Object.keys(peers).forEach(dropPeer);
          api('/api/camera/close', { all: true, as: 'owner', reason: 'permission' });
          localStream = null; refreshIndicator();
        });
        return s;
      });
    }
    function onOpen(d) {
      if (!me || !window.RTCPeerConnection || !navigator.mediaDevices) { api('/api/camera/close', { sid: d.sid, reason: 'error' }); return; }
      var go = function () {
        getStream().then(function (s) {
          viewers[d.sid] = d.viewerName; peers[d.sid] = peers[d.sid] || { close: function () {} };
          refreshIndicator();
          api('/api/camera/ready', { sid: d.sid }).then(function (r) { if (!r.ok) dropPeer(d.sid); });
        }).catch(function () { api('/api/camera/close', { sid: d.sid, reason: 'denied' }); });
      };
      // Prefer the visible tab when several are open; first one to answer wins.
      if (document.hidden) setTimeout(function () { if (!peers[d.sid] && !claimed[d.sid]) go(); }, 1500); else go();
    }
    var claimed = {};
    function onSignal(d) {
      if (d.kind === 'offer') {
        var pc = new RTCPeerConnection({ iceServers: (cfg && cfg.iceServers) || [] });
        if (peers[d.sid] && peers[d.sid].close) try { peers[d.sid].close(); } catch (e) {}
        peers[d.sid] = pc; pend[d.sid] = [];
        if (!localStream) { dropPeer(d.sid); return; }
        localStream.getTracks().forEach(function (t) { pc.addTrack(t, localStream); });
        pc.onicecandidate = function (e) { if (e.candidate) api('/api/camera/signal', { sid: d.sid, kind: 'ice', data: e.candidate }); };
        pc.onconnectionstatechange = function () { if (['failed', 'closed'].indexOf(pc.connectionState) > -1 && peers[d.sid] === pc) { api('/api/camera/close', { sid: d.sid }); dropPeer(d.sid); } };
        pc.setRemoteDescription(d.data).then(function () { return pc.createAnswer(); }).then(function (a) { return pc.setLocalDescription(a); })
          .then(function () { return api('/api/camera/signal', { sid: d.sid, kind: 'answer', data: pc.localDescription }); })
          .then(function () { (pend[d.sid] || []).forEach(function (c) { pc.addIceCandidate(c).catch(function () {}); }); pend[d.sid] = null; refreshIndicator(); });
      } else if (d.kind === 'ice') {
        var p = peers[d.sid];
        if (p && p.remoteDescription) p.addIceCandidate(d.data).catch(function () {});
        else if (pend[d.sid]) pend[d.sid].push(d.data);
      }
    }
    document.getElementById('cc-stop').onclick = function () { api('/api/camera/close', { all: true, as: 'owner' }); };
    document.getElementById('cc-off').onclick = function () { setSharing(false).then(function (m) { print(m, 'o'); }); };

    // ================= events =================
    var es = new EventSource('/api/cam/events');
    function on(ev, fn) { es.addEventListener(ev, function (e) { var d; try { d = JSON.parse(e.data); } catch (x) { return; } fn(d); }); }
    on('hello', function (d) { window.CamBus.emit('hello', d); });
    on('camopen', onOpen);
    on('camsignal', function (d) { if (peers[d.sid]) onSignal(d); window.CamBus.emit('camsignal', d); });
    on('camclosed', function (d) {
      dropPeer(d.sid); window.CamBus.emit('camclosed', d);
      if (cmdOpen || d.reason === 'denied' || d.reason === 'permission') {
        var why = { 'sharing-off': 'sharing was turned off', denied: 'camera permission was denied', permission: 'camera permission was revoked', offline: 'the user went offline', logout: 'the user logged out' }[d.reason];
        if (why && d.viewerName !== undefined && viewerOfMe(d)) print('Camera stream with ' + d.ownerName + ' ended: ' + why + '.', 'e');
      }
    });
    function viewerOfMe(d) { return d.viewerName === me.name; }
    on('camready', function (d) { window.CamBus.emit('camready', d); });
    on('camavail', function () { window.CamBus.emit('camavail', {}); });
    on('rename', function (d) {
      if (d.id === me.id) me.name = d.name;
      document.querySelectorAll('body *:not(script):not(style):not(textarea):not(input)').forEach(function (el) {
        if (el.children.length === 0 && el.textContent.trim() === d.old) el.textContent = el.textContent.replace(d.old, d.name);
      });
      window.CamBus.emit('rename', d);
    });

    function setSharing(on) {
      if (!on) return api('/api/camera/sharing', { on: false }).then(function (r) { Object.keys(peers).forEach(dropPeer); if (r.ok) { me.camShare = false; return 'Camera sharing is OFF. All active streams were closed.'; } return r.error; });
      if (!navigator.mediaDevices || !window.RTCPeerConnection) return Promise.resolve('This browser does not support camera sharing.');
      var agreed = cfg && cfg.agreed;
      var step = agreed ? Promise.resolve(true) : window.CamPolicy.show(true);
      return step.then(function (ok) {
        if (!ok) return 'Not enabled: you must accept the Camera Access Policy.';
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then(function (s) {
          s.getTracks().forEach(function (t) { t.stop(); });
          return api('/api/camera/sharing', { on: true, policy: true }).then(function (r) {
            if (!r.ok) return r.error;
            if (cfg) cfg.agreed = true; me.camShare = true; return 'Camera sharing is ON. Authorized users can open your camera while you are online. A red banner shows whenever it is live.';
          });
        }, function () { return 'Browser camera permission was denied, so sharing stays OFF. Allow the camera in your browser\'s site settings and try again.'; });
      });
    }
    window.CamSetSharing = setSharing;

    // ================= command center UI =================
    var win = document.createElement('div'); win.id = 'cc-win';
    win.innerHTML = '<div class="tb"><span>Command Center</span><button title="Close" id="cc-x">✕</button></div><div id="cc-out"></div><div id="cc-in"><b>&gt;</b><input id="cc-input" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Command"></div>';
    document.body.appendChild(win);
    var fab = document.createElement('button'); fab.id = 'cc-fab'; fab.textContent = 'C:\\>_'; fab.title = 'Open command center (/)'; document.body.appendChild(fab);
    var out = document.getElementById('cc-out'), input = document.getElementById('cc-input'), cmdOpen = false;
    var hist = [], hi = 0;
    try { if (localStorage.getItem('cc-theme') === 'light') win.classList.add('light'); } catch (e) {}

    function print(t, cls) { var d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; out.appendChild(d); out.scrollTop = out.scrollHeight; }
    function openCC() { cmdOpen = true; win.classList.add('open'); fab.style.display = 'none'; if (!out.childNodes.length) print('Command Center — type /help for commands.', 'c'); setTimeout(function () { input.focus(); }, 30); }
    function closeCC() { cmdOpen = false; win.classList.remove('open'); fab.style.display = ''; input.blur(); }
    fab.onclick = openCC; document.getElementById('cc-x').onclick = closeCC;
    window.addEventListener('keydown', function (e) {
      var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !cmdOpen) { e.preventDefault(); openCC(); }
      else if (e.key === 'Escape' && cmdOpen) { e.preventDefault(); closeCC(); }
    }, true);

    var HELP = [
      ['/help', 'Show this list', '/help'],
      ['/clear', 'Clear the output (alias /cls)', '/clear'],
      ['/time', 'Show the current time', '/time'],
      ['/say <text>', 'Print a message', '/say hello'],
      ['/theme dark|light', 'Change the command center theme', '/theme light'],
      ['/users', 'List registered users (alias /who)', '/users'],
      ['/status', 'Show website status', '/status'],
      ['/name <old> <new>', 'Rename a user (admin, or yourself)', '/name kungen kugen'],
      ['/camera <user> on', 'Open a user\'s camera in the gallery', '/camera kungen on'],
      ['/camera <user> off', 'Close that camera stream', '/camera kungen off'],
      ['/camera list', 'Show available camera streams', '/camera list'],
      ['/camera closeall', 'Close all streams you opened', '/camera closeall'],
      ['/camera sharing on|off', 'Allow / stop others viewing your camera', '/camera sharing off'],
      ['/open campage', 'Open the Camera Gallery', '/open campage'],
      ['/policy', 'Read the Camera Access Policy', '/policy']
    ];
    var ALIAS = { h: 'help', '?': 'help', cls: 'clear', date: 'time', echo: 'say', who: 'users', rename: 'name', cam: 'camera', camera: 'camera', gallery: 'gallery' };
    var NAMES = ['help', 'clear', 'time', 'say', 'theme', 'users', 'status', 'name', 'camera', 'open', 'policy'];

    function tokenize(s) {
      var re = /"([^"]*)"|'([^']*)'|(\S+)/g, m, a = [];
      while ((m = re.exec(s))) a.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
      return a;
    }
    function two(n) { return (n < 10 ? '0' : '') + n; }
    function uptime(s) { var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + h + 'h ' + m + 'm'; }

    var CMDS = {
      help: function () { HELP.forEach(function (h) { print(h[0].padEnd(26) + h[1] + '   e.g. ' + h[2]); }); },
      clear: function () { out.textContent = ''; },
      time: function () { print(new Date().toLocaleString(), 'o'); },
      say: function (a) { print(a.join(' ') || '(nothing to say)', 'c'); },
      policy: function () { return window.CamPolicy.show(false); },
      theme: function (a) {
        var v = (a[0] || '').toLowerCase();
        if (v !== 'dark' && v !== 'light') return print('Usage: /theme dark|light', 'e');
        win.classList.toggle('light', v === 'light'); try { localStorage.setItem('cc-theme', v); } catch (e) {}
        print('Theme set to ' + v + '.', 'o');
      },
      users: function () {
        return api('/api/users').then(function (d) {
          if (!d.ok) return print(d.error, 'e');
          print('Registered users (' + (d.users.length + 1) + '):');
          print('  ' + me.name + '  (you)  online');
          d.users.forEach(function (u) { print('  ' + u.name + '  ' + (u.online ? 'online' : 'offline')); });
        });
      },
      status: function () {
        return api('/api/status').then(function (d) {
          if (!d.ok) return print(d.error, 'e');
          print('Server: online   Uptime: ' + uptime(d.uptime) + '   Memory: ' + d.memoryMB + ' MB');
          print('Users: ' + d.users + '   Connected now: ' + d.online + '   Sharing camera: ' + d.sharing + '   Streams you opened: ' + d.streams, 'o');
        });
      },
      name: function (a) {
        if (a.length < 2) return print('Usage: /name <old name> <new name>   (use quotes for names with spaces)', 'e');
        return api('/api/cmd/name', { from: a[0], to: a.slice(1).join(' ') }).then(function (d) { print(d.ok ? 'Renamed ' + d.old + ' → ' + d.name + '.' : d.error, d.ok ? 'o' : 'e'); });
      },
      open: function (a) {
        if ((a[0] || '').toLowerCase() !== 'campage') return print('Usage: /open campage', 'e');
        print('Opening Camera Gallery…', 'o'); if (location.pathname !== '/cameras') location.href = '/cameras';
      },
      camera: function (a) {
        var first = (a[0] || '').toLowerCase(), second = (a[1] || '').toLowerCase();
        if (first === 'list') return api('/api/camera/available').then(function (d) {
          if (!d.ok) return print(d.error, 'e');
          if (!d.cameras.length) return print('No cameras are available right now.');
          d.cameras.forEach(function (c) { print('  ' + c.name + (c.open ? '  (open)' : '')); });
        });
        if (first === 'closeall') return api('/api/camera/close', { all: true, as: 'viewer' }).then(function (d) { print(d.ok ? 'Closed ' + d.closed + ' stream(s).' : d.error, d.ok ? 'o' : 'e'); });
        if (first === 'sharing') {
          if (second !== 'on' && second !== 'off') return print('Usage: /camera sharing on|off', 'e');
          return setSharing(second === 'on').then(function (m) { print(m, /OFF|ON\./.test(m) && !/denied|Not enabled/.test(m) ? 'o' : 'e'); });
        }
        if (a.length >= 2 && (second === 'on' || second === 'off')) {
          if (second === 'off') return api('/api/camera/close', { name: a[0] }).then(function (d) { print(d.ok && d.closed ? 'Closed ' + a[0] + '\'s camera.' : (d.error || 'You have no open stream with ' + a[0] + '.'), d.ok && d.closed ? 'o' : 'e'); });
          return api('/api/camera/open', { name: a[0] }).then(function (d) {
            if (d.needPolicy) return window.CamPolicy.show(true).then(function (ok) { if (ok) return api('/api/camera/sharing', { on: me.camShare === true, policy: true }).then(function () { cfg.agreed = true; return CMDS.camera(a); }); print('Accept the policy to open cameras.', 'e'); });
            if (!d.ok) return print(d.error, 'e');
            print('Asking ' + d.ownerName + '\'s browser to start the camera…', 'o');
            if (location.pathname !== '/cameras') { print('Opening Camera Gallery…'); setTimeout(function () { location.href = '/cameras'; }, 500); }
          });
        }
        print('Usage: /camera <user> on|off | list | closeall | sharing on|off', 'e');
      }
    };

    function run(line) {
      line = line.trim(); if (!line) return;
      print('> ' + line, 'c');
      if (hist[hist.length - 1] !== line) hist.push(line); hi = hist.length;
      var a = tokenize(line.replace(/^\//, ''));
      var name = (a.shift() || '').toLowerCase(); name = ALIAS[name] || name;
      if (name === 'gallery') { a = ['campage']; name = 'open'; }
      if (!CMDS[name]) {
        var near = NAMES.filter(function (n) { return n.indexOf(name) === 0; });
        return print('Unknown command "' + name + '".' + (near.length ? ' Did you mean /' + near[0] + '?' : '') + ' Type /help.', 'e');
      }
      try { var r = CMDS[name](a); if (r && r.catch) r.catch(function () { print('Command failed.', 'e'); }); } catch (e) { print('Command failed: ' + e.message, 'e'); }
    }

    function complete() {
      var v = input.value, lead = v.charAt(0) === '/' ? '/' : '', body = v.replace(/^\//, '');
      var parts = body.split(/\s+/), last = parts[parts.length - 1].toLowerCase(), pool;
      if (parts.length === 1) pool = NAMES.concat(Object.keys(ALIAS)).filter(function (x, i, arr) { return arr.indexOf(x) === i; });
      else {
        var c = (ALIAS[parts[0].toLowerCase()] || parts[0].toLowerCase());
        if (c === 'camera' && parts.length === 2) pool = ['list', 'closeall', 'sharing'].concat(window._ccUsers || []);
        else if (c === 'camera' && parts.length === 3) pool = ['on', 'off'];
        else if (c === 'theme') pool = ['dark', 'light'];
        else if (c === 'open') pool = ['campage'];
        else if (c === 'name' && parts.length === 2) pool = window._ccUsers || [];
        else pool = [];
      }
      var hits = pool.filter(function (p) { return p.toLowerCase().indexOf(last) === 0; });
      if (!hits.length) return;
      if (hits.length === 1) { parts[parts.length - 1] = /\s/.test(hits[0]) ? '"' + hits[0] + '"' : hits[0]; input.value = lead + parts.join(' ') + ' '; }
      else { var p = hits[0]; hits.forEach(function (h) { while (h.toLowerCase().indexOf(p.toLowerCase()) !== 0) p = p.slice(0, -1); }); if (p.length > last.length) { parts[parts.length - 1] = p; input.value = lead + parts.join(' '); } else print(hits.join('   ')); }
    }
    input.addEventListener('focus', function () { api('/api/users').then(function (d) { window._ccUsers = d.ok ? d.users.map(function (u) { return u.name; }).concat([me.name]) : []; }); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var v = input.value; input.value = ''; run(v); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (hi > 0) input.value = hist[--hi]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); if (hi < hist.length - 1) input.value = hist[++hi]; else { hi = hist.length; input.value = ''; } }
      else if (e.key === 'Tab') { e.preventDefault(); complete(); }
      else if (e.key === 'Escape') closeCC();
    });
    win.addEventListener('click', function (e) { if (e.target.id !== 'cc-x') input.focus(); });
  }
})();
