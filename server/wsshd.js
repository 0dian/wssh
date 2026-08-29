// wsshd — the server-side half of wssh.
//
// A minimal SSH server for a Windows host whose sessions run inside a *new*
// ConPTY (node-pty with useConptyDll:true) instead of the System32 conhost that
// Win32-OpenSSH's own pty session uses. The old conhost drops mouse sequences
// in both directions; the bundled conpty.dll does not. wssh fixes that from
// the client side (`ssh -T` + relay.js) and needs Node on the client; wsshd
// fixes it on the server side so that any stock SSH client that asks for a pty
// (a phone app, plain `ssh -t`) gets a mouse-capable shell with nothing
// installed locally.
//
//   node wsshd.js            # listens on WSSHD_BIND:WSSHD_PORT (127.0.0.1,<tailnet ip>:2222)
//
// Scope, deliberately small: publickey auth only (same authorized_keys files
// as sshd), shell / exec / pty / env / window-change. No sftp, no port
// forwarding, no agent forwarding, no passwords. It runs next to sshd, never
// instead of it: port 22 keeps serving scp, VS Code Remote and automation.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || os.homedir();
const PORT = parseInt(process.env.WSSHD_PORT || '2222', 10);
const BIND = (process.env.WSSHD_BIND || '127.0.0.1,100.81.19.53').split(',').map(s => s.trim()).filter(Boolean);
const HOSTKEY = process.env.WSSHD_HOSTKEY || path.join(HOME, '.ssh', 'wsshd_host_ed25519');
const AUTHKEYS = (process.env.WSSHD_AUTHKEYS ||
  [path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys'),
   path.join(HOME, '.ssh', 'authorized_keys')].join(';')).split(';').map(s => s.trim()).filter(Boolean);
const LOGFILE = process.env.WSSHD_LOG || path.join(__dirname, 'wsshd.log');
const DEFAULT_COLS = 120, DEFAULT_ROWS = 40;
const ENV_ALLOW = /^(TERM|LANG|LC_[A-Z]+|COLORTERM)$/;

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------
function log(s) {
  const line = new Date().toISOString() + ' ' + s + '\n';
  try { fs.appendFileSync(LOGFILE, line); } catch (e) {}
  try { process.stdout.write(line); } catch (e) {}
}
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack || e)));

// ---------------------------------------------------------------------------
// deps: ssh2 and the bundled node-pty (the one that carries conpty.dll)
// ---------------------------------------------------------------------------
// ssh2 is installed under deps/ (its own package.json) rather than next to
// node-pty: a plain `npm install` in the relay dir prunes the bundled node-pty
// as "extraneous", and with it the conpty.dll this whole thing depends on.
let ssh2, pty;
try { ssh2 = require(path.join(__dirname, 'deps', 'node_modules', 'ssh2')); }
catch (e) { log('cannot load ssh2 (run: cd ' + path.join(__dirname, 'deps') + ' && npm install): ' + e); process.exit(96); }
try { pty = require(path.join(__dirname, 'node_modules', 'node-pty')); } catch (e) { log('cannot load bundled node-pty: ' + e); process.exit(96); }

// ---------------------------------------------------------------------------
// shell: Git Bash. C:\Windows\System32\bash.exe is WSL and must never win.
// ---------------------------------------------------------------------------
function findShell() {
  if (process.env.WSSHD_SHELL) return process.env.WSSHD_SHELL;
  const fixed = ['D:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'];
  for (const f of fixed) if (fs.existsSync(f)) return f;
  try {
    const r = spawnSync('where.exe', ['sh.exe'], { encoding: 'utf8' });
    for (const l of (r.stdout || '').split(/\r?\n/)) {
      if (/[\\\/]Git[\\\/]/i.test(l)) {
        const b = path.join(path.dirname(l.trim()), 'bash.exe');
        if (fs.existsSync(b)) return b;
      }
    }
  } catch (e) {}
  return null;
}
const SHELL = findShell();
if (!SHELL) { log('no Git Bash found; set WSSHD_SHELL'); process.exit(95); }

// ---------------------------------------------------------------------------
// host key
// ---------------------------------------------------------------------------
if (!fs.existsSync(HOSTKEY)) {
  fs.mkdirSync(path.dirname(HOSTKEY), { recursive: true });
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', HOSTKEY], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(HOSTKEY)) { log('host key generation failed: ' + (r.stderr || r.error)); process.exit(94); }
  log('generated host key ' + HOSTKEY);
}
const HOSTKEYS = [fs.readFileSync(HOSTKEY)];

// ---------------------------------------------------------------------------
// authorized_keys: re-read on every attempt so adding a key needs no restart.
// A line may start with an options field ("restrict,command=..." etc.); the
// key proper begins at the first token that looks like a key type.
// ---------------------------------------------------------------------------
const KEYTYPE = /^(ssh-|ecdsa-|sk-)/;
// administrators_authorized_keys is ACL'd to Administrators + SYSTEM. A task
// started with a UAC-filtered (non-elevated) token cannot read it, and every
// key that lives only there then "does not exist". Say so in the log instead
// of failing silently — and register the task with RunLevel Highest.
const unreadable = new Set();
function loadAuthorizedKeys() {
  const out = [];
  for (const file of AUTHKEYS) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code !== 'ENOENT' && !unreadable.has(file)) { unreadable.add(file); log('authorized_keys UNREADABLE ' + file + ': ' + e.code + ' (run wsshd elevated: task RunLevel Highest)'); }
      continue;
    }
    unreadable.delete(file);
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const toks = line.split(/\s+/);
      const at = toks.findIndex(t => KEYTYPE.test(t));
      if (at === -1) continue;
      const parsed = ssh2.utils.parseKey(toks.slice(at).join(' '));
      const keys = Array.isArray(parsed) ? parsed : [parsed];
      for (const k of keys) {
        if (k instanceof Error || !k || !k.type) continue;
        out.push({ key: k, comment: toks.slice(at + 2).join(' ') || '(no comment)', file });
      }
    }
  }
  return out;
}

// ssh2 hands us the *signature* algorithm name; map it back to the key type
// so an RSA key offered as rsa-sha2-256 still matches an "ssh-rsa" line.
function keyTypeOf(algo) {
  if (algo === 'rsa-sha2-256' || algo === 'rsa-sha2-512') return 'ssh-rsa';
  return algo;
}
function hashOf(ctx) {
  if (ctx.hashAlgo) return ctx.hashAlgo;
  if (ctx.key.algo === 'rsa-sha2-256') return 'sha256';
  if (ctx.key.algo === 'rsa-sha2-512') return 'sha512';
  return undefined;
}

function authenticate(ctx, peer) {
  if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
  const want = keyTypeOf(ctx.key.algo);
  const match = loadAuthorizedKeys().find(a => a.key.type === want && a.key.getPublicSSH().equals(ctx.key.data));
  if (!match) { log(peer + ' auth reject user=' + ctx.username + ' algo=' + ctx.key.algo + ' (no matching key)'); return ctx.reject(['publickey']); }
  if (ctx.signature === undefined) return ctx.accept(); // key query phase, no signature yet
  let ok = false;
  try { ok = match.key.verify(ctx.blob, ctx.signature, hashOf(ctx)) === true; } catch (e) { log(peer + ' verify error: ' + e); }
  if (!ok) { log(peer + ' auth reject user=' + ctx.username + ' key=' + match.comment + ' (bad signature)'); return ctx.reject(['publickey']); }
  log(peer + ' auth ok user=' + ctx.username + ' key=' + match.comment);
  ctx.accept();
}

// ---------------------------------------------------------------------------
// session: one ConPTY per shell/exec channel
// ---------------------------------------------------------------------------
function runInPty(channel, args, st, peer, what) {
  const cols = st.cols || DEFAULT_COLS, rows = st.rows || DEFAULT_ROWS;
  const env = Object.assign({}, process.env, { TERM: st.term || 'xterm-256color' }, st.env);
  let p;
  try {
    p = pty.spawn(SHELL, args, {
      name: st.term || 'xterm-256color',
      cols, rows,
      cwd: HOME,            // must be a Windows path; a bad cwd makes conpty.dll go silent
      env,
      useConptyDll: true,   // the whole point: not the System32 conhost
    });
  } catch (e) {
    log(peer + ' spawn failed: ' + (e && e.stack || e));
    try { channel.stderr.write('wsshd: spawn failed: ' + e + '\r\n'); channel.exit(97); channel.end(); } catch (e2) {}
    return;
  }
  st.pty = p;
  // p.pid is not populated until the conpty agent reports back, so it is only
  // meaningful in the exit line below.
  log(peer + ' ' + what + ' ' + cols + 'x' + rows);

  p.onData(d => { try { channel.write(Buffer.from(d, 'utf8')); } catch (e) {} });

  // UTF-8 safe: hold back a split multi-byte char until the rest arrives.
  const decoder = new StringDecoder('utf8');
  channel.on('data', b => { const s = decoder.write(b); if (s) { try { p.write(s); } catch (e) {} } });

  let done = false;
  p.onExit(({ exitCode }) => {
    if (done) return; done = true;
    log(peer + ' ' + what + ' pid=' + p.pid + ' exit=' + exitCode);
    // let the last output drain before the channel goes away
    setTimeout(() => { try { channel.exit(exitCode || 0); channel.end(); channel.close(); } catch (e) {} }, 150);
  });
  channel.on('close', () => { if (!done) { done = true; try { p.kill(); } catch (e) {} log(peer + ' ' + what + ' pid=' + p.pid + ' channel closed'); } });
  channel.on('error', e => log(peer + ' channel error: ' + e));
}

function onSession(client, peer, accept) {
  const session = accept();
  const st = { cols: 0, rows: 0, term: null, env: {}, pty: null };
  session.on('pty', (accept, reject, info) => {
    st.cols = info.cols; st.rows = info.rows; st.term = info.term;
    accept && accept();
  });
  session.on('env', (accept, reject, info) => {
    if (ENV_ALLOW.test(info.key)) st.env[info.key] = info.val;
    accept && accept();
  });
  session.on('window-change', (accept, reject, info) => {
    st.cols = info.cols; st.rows = info.rows;
    if (st.pty) { try { st.pty.resize(info.cols, info.rows); } catch (e) {} }
    accept && accept();
  });
  session.on('shell', (accept) => runInPty(accept(), ['-l', '-i'], st, peer, 'shell'));
  session.on('exec', (accept, reject, info) => runInPty(accept(), ['-lc', info.command], st, peer, 'exec ' + JSON.stringify(info.command)));
  session.on('subsystem', (accept, reject, info) => { log(peer + ' subsystem ' + info.name + ' refused'); reject && reject(); });
  session.on('x11', (accept, reject) => reject && reject());
  session.on('auth-agent', (accept, reject) => reject && reject());
  session.on('signal', (accept, reject) => accept && accept());
}

function onClient(client, info) {
  const peer = (info.ip || '?') + ':' + (info.port || '?');
  log(peer + ' connected ' + (info.header && info.header.identRaw || ''));
  client.on('authentication', ctx => authenticate(ctx, peer));
  client.on('ready', () => client.on('session', (accept, reject) => onSession(client, peer, accept)));
  client.on('request', (accept, reject) => reject && reject()); // tcpip-forward etc.
  client.on('error', e => log(peer + ' client error: ' + (e && e.message || e)));
  client.on('close', () => log(peer + ' closed'));
}

// ---------------------------------------------------------------------------
// listeners: one Server per bind address; an address that is not up yet
// (tailnet interface still coming up) is retried until it is.
// ---------------------------------------------------------------------------
function listen(addr) {
  const srv = new ssh2.Server({ hostKeys: HOSTKEYS, ident: 'SSH-2.0-wsshd_0.1' }, onClient);
  srv.on('error', e => {
    log('listen ' + addr + ':' + PORT + ' failed: ' + (e && e.code || e) + (e && e.code === 'EADDRNOTAVAIL' ? ' (retry in 30s)' : ''));
    if (e && e.code === 'EADDRNOTAVAIL') setTimeout(() => listen(addr), 30000);
  });
  srv.listen(PORT, addr, () => log('listening on ' + addr + ':' + PORT + ' shell=' + SHELL));
}
log('wsshd starting pid=' + process.pid + ' authkeys=' + AUTHKEYS.join(';'));
log('authorized keys loaded at startup: ' + loadAuthorizedKeys().map(a => a.comment).join(', '));
BIND.forEach(listen);
