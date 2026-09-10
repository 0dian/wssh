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
//   node wsshd.js            # listens on WSSHD_BIND:WSSHD_PORT (default 127.0.0.1:2222; set WSSHD_BIND to add a tailnet IP)
//
// Scope, deliberately small: publickey auth only (same authorized_keys files
// as sshd), shell / exec / pty / env / window-change. No sftp, no port
// forwarding, no agent forwarding, no passwords. It runs next to sshd, never
// instead of it: port 22 keeps serving scp, VS Code Remote and automation.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const HOME = process.env.USERPROFILE || os.homedir();
const PORT = parseInt(process.env.WSSHD_PORT || '2222', 10);
const BIND = (process.env.WSSHD_BIND || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean);
const HOSTKEY = process.env.WSSHD_HOSTKEY || path.join(HOME, '.ssh', 'wsshd_host_ed25519');
const AUTHKEYS = (process.env.WSSHD_AUTHKEYS ||
  [path.join(process.env.ProgramData || 'C:\\ProgramData', 'ssh', 'administrators_authorized_keys'),
   path.join(HOME, '.ssh', 'authorized_keys')].join(';')).split(';').map(s => s.trim()).filter(Boolean);
const LOGFILE = process.env.WSSHD_LOG || path.join(__dirname, 'wsshd.log');
const DEFAULT_COLS = 120, DEFAULT_ROWS = 40;
const ENV_ALLOW = /^(TERM|LANG|LC_[A-Z]+|COLORTERM)$/;
// exec-only: turn off MSYS/Git Bash's argv path-rewriting for the child
// process. Without this, a Windows-native command's own switches (e.g.
// `cmd.exe /d /s /c "..."`) get mangled as if they were POSIX paths and the
// intended flag is lost — see the dispatch note for the cmd.exe symptom.
// Interactive `shell` sessions must NOT get this: users rely on the
// rewriting there (e.g. `node ~/foo.js` resolving a POSIX-style path).
const EXEC_NO_PATHCONV = { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };

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

// runInPipes() below reaches into a handful of ssh2-internal fields
// (`_chunk`/`_chunkcb`/`_chunkErr`/`_chunkcbErr`) to steer around a bug in
// ssh2 1.17.0's CHANNEL_WINDOW_ADJUST resume path (see the comment at the top
// of runInPipes for the full story). Assigning to a property that no longer
// exists on a future/older ssh2 build does NOT throw — it just silently
// becomes a no-op — so a version bump would bring back stderr truncation and
// the double-channel hang with zero error signal. This whitelist is the only
// thing standing between "ssh2 got upgraded" and "wsshd is broken and nobody
// notices". Before adding a version here, actually run it through the ssh2
// fixture in scratchpad (two channels, large output, md5 compare on both
// sides) and confirm the workaround still does something.
const SSH2_VERIFIED = ['1.17.0'];
(function checkSsh2Version() {
  let version;
  try {
    version = require(path.join(__dirname, 'deps', 'node_modules', 'ssh2', 'package.json')).version;
  } catch (e) {
    log('*** WARNING: could not read deps/node_modules/ssh2/package.json to verify its version (' +
      (e && e.message || e) + '). The private-field workaround in runInPipes() for the ' +
      'ssh2 1.17.0 CHANNEL_WINDOW_ADJUST bug may be silently broken: watch for truncated ' +
      'stderr or a hang when both stdout and stderr produce large output at once. ' +
      'Verified versions: ' + SSH2_VERIFIED.join(', '));
    return;
  }
  if (SSH2_VERIFIED.indexOf(version) === -1) {
    log('*** WARNING: ssh2 version ' + version + ' is not in the verified list (' +
      SSH2_VERIFIED.join(', ') + '). runInPipes() relies on ssh2-internal private fields ' +
      '(_chunk/_chunkcb/_chunkErr/_chunkcbErr) to work around a bug in ssh2 1.17.0; on a ' +
      'different version those fields may not exist or may mean something else, and the ' +
      'workaround silently becomes a no-op (no exception). Symptoms if this has regressed: ' +
      'truncated stderr on exec output, or a hung exec when stdout and stderr both produce ' +
      'large output at once. Pin ssh2 back to a verified version, or re-run the ssh2 fixture ' +
      '(scratchpad: two channels, large output, md5 compare) and add this version to ' +
      'SSH2_VERIFIED once confirmed.');
  }
})();

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
function runInPty(channel, args, st, peer, what, extraEnv) {
  const cols = st.cols || DEFAULT_COLS, rows = st.rows || DEFAULT_ROWS;
  const env = Object.assign({}, process.env, { TERM: st.term || 'xterm-256color' }, st.env, extraEnv);
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

// Set once runInPipes() has checked (and, if needed, warned about) whether
// the ssh2 Channel actually has the private chunk-slot fields the pump below
// relies on. The version check above is a proxy (a package.json string);
// this is the direct structural check on a real channel object — checked
// once per process, not once per connection, so a broken deploy logs one
// clear warning instead of spamming the log every exec.
let ssh2ChunkSlotsWarned = false;

// exec channel for a client that did NOT send pty-req: a clean pipe, not
// ConPTY. Stock sshd draws this same line on pty-req; TermRover (and any
// script-driven client) relies on it — no ConPTY banner/OSC bytes ahead of
// the command's own output, stdout and stderr kept apart, real exit code.
function runInPipes(channel, command, st, peer) {
  const env = Object.assign({}, process.env, { TERM: st.term || 'xterm-256color' }, st.env, EXEC_NO_PATHCONV);
  const tag = 'exec ' + JSON.stringify(command);
  let child;
  try {
    child = spawn(SHELL, ['-lc', command], {
      cwd: HOME,           // same cwd as the ConPTY path
      env,
      windowsHide: true,   // wsshd runs as a hidden scheduled task in the
                            // user's interactive session; without this every
                            // exec would flash a console window on screen.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(peer + ' spawn failed: ' + (e && e.stack || e));
    try { channel.stderr.write('wsshd: spawn failed: ' + e + '\r\n'); channel.exit(97); channel.end(); } catch (e2) {}
    return;
  }
  log(peer + ' ' + tag + ' pipe');

  // Raw bytes both ways — no StringDecoder, no ConPTY CRLF translation.
  //
  // stdout goes out as channel data, stderr as SSH extended-data; ssh2 exposes
  // them as two independent Writables (`channel` itself and `channel.stderr`)
  // that nevertheless share one flow-control window (~2 MB) and, in ssh2
  // 1.17.0, one pair of "pending chunk" slots on the channel object:
  // `_chunk`/`_chunkcb` for stdout and `_chunkErr`/`_chunkcbErr` for stderr
  // (lib/Channel.js). When a write does not fit in the remaining window the
  // rest is parked in the matching slot and the write callback is withheld;
  // the next CHANNEL_WINDOW_ADJUST resumes it (lib/server.js, the
  // `if (channel._waitWindow)` block). That resume path has two defects we
  // have to steer around, both reproduced in the local fixture:
  //
  //   a) it tests `_chunk` before `_chunkErr`, so if both sides have a parked
  //      chunk at the same moment stderr is never resumed — its callback never
  //      fires, its Writable never dispatches again, the child's stderr stays
  //      paused and the exec hangs forever;
  //   b) it never clears a slot after resuming it, so a stale `_chunk` left
  //      over from a finished stdout write both re-sends those bytes and
  //      double-calls a spent write callback.
  //
  // Both disappear if the two sides are never in flight at once. So instead of
  // writing from the two 'data' handlers independently, push every chunk onto
  // one FIFO and let a single pump own the channel: exactly one write is
  // outstanding at any time, the source stream that produced it stays paused
  // until it lands (that is the backpressure — no data is accepted that we
  // cannot yet send), and once it lands the stale slots are cleared so the next
  // CHANNEL_WINDOW_ADJUST can only ever pick a genuinely pending chunk.
  // Completion state, declared up here because the pump below consults it.
  let stdoutEnded = false, stderrEnded = false, childClosed = false;
  let exitCode = 0, exitSignal = null, finished = false;
  const queue = [];
  let writing = false;
  function pump() {
    if (writing || finished || queue.length === 0) return;
    const item = queue.shift();
    writing = true;
    try {
      (item.err ? channel.stderr : channel).write(item.data, () => {
        // This chunk is fully handed to the protocol. Drop ssh2's pending-chunk
        // slots so a later window adjustment cannot resurrect it (defect b).
        channel._chunk = undefined; channel._chunkcb = undefined;
        channel._chunkErr = undefined; channel._chunkcbErr = undefined;
        writing = false;
        try { item.src.resume(); } catch (e) {}
        pump();
        finish();
      });
    } catch (e) {
      writing = false;
      try { item.src.resume(); } catch (e2) {}
      finish();
    }
  }
  function forward(src, isErr) {
    src.on('data', d => {
      // One chunk per source in flight; resumed from the write callback above.
      try { src.pause(); } catch (e) {}
      queue.push({ data: d, err: isErr, src: src });
      pump();
    });
  }
  // Direct structural check, once per process: the version check above is a
  // proxy (it trusts a package.json string); this confirms the channel object
  // we are actually about to pump against still has the private slots the
  // cleanup in pump() clears. If it doesn't, that cleanup silently does
  // nothing on every exec from now on — no exception, no other signal — and
  // the CHANNEL_WINDOW_ADJUST defects described above are back in play.
  if (!ssh2ChunkSlotsWarned && !('_chunk' in channel)) {
    ssh2ChunkSlotsWarned = true;
    log('*** WARNING: ssh2 Channel object has no _chunk field. The private-field workaround ' +
      'in runInPipes() (see SSH2_VERIFIED / checkSsh2Version above) is a no-op on this ssh2 ' +
      'build: expect truncated stderr or a hang on exec commands with large stdout+stderr ' +
      'output at once. This is logged once per process, not per connection.');
  }
  forward(child.stdout, false);
  forward(child.stderr, true);
  // client -> child. This direction needs its own backpressure, and ssh2's
  // flow-control window does NOT supply it: lib/server.js CHANNEL_DATA pushes
  // the chunk into the channel's Readable and, whenever push() returns true,
  // immediately tops the receive window back up to 2 MB (windowAdjust). With a
  // 'data' listener attached the push is delivered synchronously, the Readable
  // never holds anything, push() therefore always returns true, and the window
  // is granted back for every byte no matter how far behind the child is. So
  // ignoring write()'s return value here does not park the data in ssh2 — it
  // parks it in child.stdin's unbounded Writable queue. Measured in the
  // fixture (client sends flat out, child reads nothing): 100 MB in -> peak
  // child.stdin.writableLength 99.94 MB, RSS 240 MB; 500 MB in -> 499.94 MB,
  // RSS 842 MB. Linear, i.e. one `cat > big` over a fast link is an OOM.
  // Pausing the channel is what actually stops the window from reopening.
  channel.on('data', b => {
    try {
      if (!child.stdin.write(b)) {
        channel.pause();
        child.stdin.once('drain', () => { try { channel.resume(); } catch (e) {} });
      }
    } catch (e) {}
  });
  // ConPTY has no EOF concept so runInPty never needs this; a pipe does, or
  // `echo x | ssh host cat` hangs forever waiting for stdin to close.
  // ssh2's Channel is a Duplex: a client EOF surfaces as the readable side
  // ending ('end'), and only some versions also emit 'eof'. Listen for both —
  // miss it and `echo x | ssh host cat` hangs forever with the data delivered.
  const closeStdin = () => { try { child.stdin.end(); } catch (e) {} };
  channel.on('eof', closeStdin);
  channel.on('end', closeStdin);
  // a write landing after the child is gone emits EPIPE asynchronously; without
  // a listener that is an unhandled 'error' event, not a caught exception.
  child.stdin.on('error', e => log(peer + ' ' + tag + ' stdin: ' + (e && e.code || e)));

  // Exit sequence: only tell the client the command is done once all three
  // of stdout-ended, stderr-ended, and child-closed have happened — in
  // whichever order they arrive. Because a source stream stays paused until
  // its last chunk has been written, 'end' on it means every byte it produced
  // is already inside ssh2.
  //
  // "Inside ssh2" is not "sent", though, and that is the second half of the
  // truncation bug. channel.end() turns into eof() + close() on the *server*
  // side of a Channel as soon as the Duplex pre-finishes (lib/Channel.js,
  // onFinish), and from then on outgoing.state is no longer 'open', which makes
  // ServerStderr._write() drop whatever is still queued — silently, with the
  // exit status already sent, so the client sees a clean exit on a truncated
  // stream. The Duplex's own finish logic covers stdout, but nothing covers
  // channel.stderr, which is a separate Writable with its own 2 MB buffer.
  // So end that stream first and only send exit-status + close the channel
  // once it has actually flushed ('finish' on a Writable with no _final means
  // every _write callback has fired, i.e. every byte reached the protocol).
  function closeChannel() {
    try { channel.exit(exitCode); channel.end(); } catch (e) {}
  }
  function finish() {
    if (finished || !stdoutEnded || !stderrEnded || !childClosed) return;
    // A source stream can emit 'end' while its last chunk is still sitting in
    // the FIFO above (pausing a readable does not un-schedule an 'end' that is
    // already due). Ending channel.stderr here would then make the pump write
    // after end — one lost chunk and no 'finish' event, i.e. a hang. Wait for
    // the pump to run dry; it calls finish() again after every chunk.
    if (writing || queue.length > 0) return;
    finished = true;
    log(peer + ' ' + tag + ' pid=' + child.pid + ' exit=' + exitCode + (exitSignal ? ' signal=' + exitSignal : ''));
    try {
      if (channel.stderr.writableFinished) closeChannel();
      else { channel.stderr.once('finish', closeChannel); channel.stderr.end(); }
    } catch (e) { closeChannel(); }
  }
  child.stdout.on('end', () => { stdoutEnded = true; finish(); });
  child.stderr.on('end', () => { stderrEnded = true; finish(); });
  child.on('close', (code, signal) => {
    if (finished) return;
    childClosed = true;
    // code is null when the child died from a signal; ssh2's channel.exit()
    // requires a number, so map that case to a conventional non-zero code
    // instead of passing null through.
    exitCode = (code === null) ? 128 : code;
    exitSignal = signal;
    finish();
  });
  channel.on('close', () => { if (!finished) { finished = true; try { child.kill(); } catch (e) {} try { child.stdout.destroy(); child.stderr.destroy(); } catch (e) {} log(peer + ' ' + tag + ' pid=' + child.pid + ' channel closed'); } });
  channel.on('error', e => log(peer + ' channel error: ' + e));
}

function onSession(client, peer, accept) {
  const session = accept();
  const st = { cols: 0, rows: 0, term: null, env: {}, pty: null, ptyRequested: false };
  session.on('pty', (accept, reject, info) => {
    st.cols = info.cols; st.rows = info.rows; st.term = info.term;
    st.ptyRequested = true;
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
  session.on('exec', (accept, reject, info) => {
    if (st.ptyRequested) {
      // client asked for a pty before exec (e.g. `ssh -tt ... mousetest.js`):
      // keep using the mouse-capable ConPTY path, unchanged.
      runInPty(accept(), ['-lc', info.command], st, peer, 'exec ' + JSON.stringify(info.command), EXEC_NO_PATHCONV);
    } else {
      // no pty-req: clean pipe, script-parsable output (stock sshd behavior).
      runInPipes(accept(), info.command, st, peer);
    }
  });
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
