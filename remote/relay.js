// wssh-relay / relay.js
//
// Runs on the Windows host. Reads raw terminal bytes on stdin, writes
// raw terminal bytes on stdout, and in between runs the target program inside a
// *new* ConPTY (node-pty with useConptyDll:true) instead of the System32 conhost
// that OpenSSH's own pty session uses. The old conhost drops mouse sequences in
// both directions; the new conpty.dll does not.
//
// Usage:  node relay.js <cols> <rows> <cmd> [args...]
//
// The Mac side runs `ssh -T` (no remote pty at all), so nothing on the SSH path
// can eat or rewrite the byte stream. Terminal resize therefore has no SIGWINCH
// to ride on and is carried in-band instead, see RESIZE PROTOCOL below.

'use strict';

const path = require('path');
const { StringDecoder } = require('string_decoder');

const DEBUG = process.env.WSSH_DEBUG === '1';
function dbg(s) {
  if (DEBUG) { try { process.stderr.write('[relay] ' + s + '\n'); } catch (e) {} }
}
function fatal(s) {
  try { process.stderr.write('[relay] ' + s + '\n'); } catch (e) {}
}

// ---------------------------------------------------------------------------
// RESIZE PROTOCOL
//
//   ESC ] 77577 ; <cols> ; <rows> BEL          (BEL = 0x07)
//
// The client emits this on SIGWINCH. The relay strips it out of the input
// stream and turns it into p.resize(); it never reaches the pty, so the child
// never sees it as keystrokes. 77577 is a private OSC number (xterm assigns
// nothing above 10000), chosen so it cannot collide with a real OSC.
// ---------------------------------------------------------------------------
const MARK = '\x1b]77577;';
const BEL = '\x07';
// If a partial marker never completes we must not swallow the user's input
// forever. A well-formed sequence is at most MARK + "99999;99999" + BEL.
const CARRY_MAX = 64;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.length < 3) {
  fatal('usage: node relay.js <cols> <rows> <cmd> [args...]');
  process.exit(2);
}
let cols = parseInt(argv[0], 10);
let rows = parseInt(argv[1], 10);
if (!Number.isFinite(cols) || cols < 2 || cols > 1000) cols = 120;
if (!Number.isFinite(rows) || rows < 2 || rows > 1000) rows = 40;
const cmd = argv[2];
const args = argv.slice(3);

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------
let pty;
try {
  // Bundled copy — deliberately NOT the VS Code server's, whose build/ dir is
  // deleted whenever VS Code updates its server commit.
  pty = require(path.join(__dirname, 'node_modules', 'node-pty'));
} catch (e) {
  fatal('cannot load bundled node-pty: ' + (e && e.stack || e));
  process.exit(96);
}

// cwd MUST be a Windows-style path. With useConptyDll:true a cwd that the
// conpty.dll cannot resolve makes the pty come up silently producing no output
// at all, with no error anywhere — so default to USERPROFILE and never to a
// POSIX-looking path.
const cwd = process.env.WSSH_CWD || process.env.USERPROFILE || 'C:\\';

// `ssh -T` leaves TERM unset (no pty was requested), and node-pty's `name`
// option does not export it on Windows. An interactive shell or TUI started in
// here would otherwise see a dumb terminal: no colors, crippled readline.
const childEnv = Object.assign({}, process.env, {
  TERM: process.env.TERM || 'xterm-256color',
});

let p;
try {
  p = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: cols,
    rows: rows,
    cwd: cwd,
    env: childEnv,
    useConptyDll: true, // required: the OS ConPTY on this box is too old
  });
} catch (e) {
  fatal('spawn failed: ' + (e && e.stack || e));
  process.exit(97);
}
dbg('up pid=' + p.pid + ' ' + cols + 'x' + rows + ' cwd=' + cwd + ' cmd=' + cmd);

try {
  const ag = p._agent;
  if (ag && ag._onError) ag._onError.event(e => fatal('agent error: ' + (e && e.stack || e)));
} catch (e) {}
process.on('uncaughtException', e => fatal('uncaught: ' + (e && e.stack || e)));

// ---------------------------------------------------------------------------
// pty -> stdout
// ---------------------------------------------------------------------------
p.onData(d => {
  try { process.stdout.write(Buffer.from(d, 'utf8')); } catch (e) {}
});

// ---------------------------------------------------------------------------
// stdin -> pty  (UTF-8 safe, resize sequences stripped)
// ---------------------------------------------------------------------------
// StringDecoder holds back an incomplete multi-byte UTF-8 character until its
// remaining bytes arrive, so a CJK character split across two TCP reads still
// reaches the pty as one character. node-pty re-encodes the string as UTF-8 on
// the way in, making the round trip lossless. (Decoding as latin1 instead — the
// obvious shortcut — mangles every non-ASCII character.)
const decoder = new StringDecoder('utf8');
let carry = '';

function doResize(c, r) {
  if (!Number.isFinite(c) || !Number.isFinite(r)) return;
  if (c < 2 || r < 2 || c > 1000 || r > 1000) return;
  if (c === cols && r === rows) return;
  cols = c; rows = r;
  try { p.resize(c, r); dbg('resize ' + c + 'x' + r); }
  catch (e) { dbg('resize failed: ' + e); }
}

function feed(chunk) {
  const buf = carry + chunk;
  carry = '';
  let out = '';
  let i = 0;

  for (;;) {
    const at = buf.indexOf(MARK, i);
    if (at === -1) break;
    const bel = buf.indexOf(BEL, at + MARK.length);
    if (bel === -1) break; // incomplete — handled by the carry logic below
    out += buf.slice(i, at);
    const m = /^(\d+);(\d+)$/.exec(buf.slice(at + MARK.length, bel));
    if (m) doResize(parseInt(m[1], 10), parseInt(m[2], 10));
    else out += buf.slice(at, bel + 1); // malformed: pass through untouched
    i = bel + 1;
  }

  // Decide how much of the tail to hold back for the next chunk: either a
  // started-but-unterminated marker, or a suffix that is a prefix of MARK.
  const rest = buf.slice(i);
  let hold = -1;
  const full = rest.indexOf(MARK);
  if (full !== -1) {
    hold = full;
  } else {
    for (let k = Math.min(MARK.length - 1, rest.length); k > 0; k--) {
      if (rest.slice(rest.length - k) === MARK.slice(0, k)) { hold = rest.length - k; break; }
    }
  }

  if (hold === -1) {
    out += rest;
  } else {
    out += rest.slice(0, hold);
    carry = rest.slice(hold);
    if (carry.length > CARRY_MAX) { out += carry; carry = ''; } // never stall input
  }

  if (out) {
    try { p.write(out); }
    catch (e) { dbg('write failed: ' + e); }
  }
}

process.stdin.on('data', b => feed(decoder.write(b)));

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------
let exiting = false;
function bye(code) {
  if (exiting) return;
  exiting = true;
  // process.exit() discards whatever is still queued on the stdout pipe, which
  // silently truncates short sessions. Give the pipe a beat, then flush.
  setTimeout(() => {
    try { process.stdout.write('', () => process.exit(code || 0)); }
    catch (e) { process.exit(code || 0); }
    setTimeout(() => process.exit(code || 0), 1500);
  }, 400);
}

p.onExit(({ exitCode }) => { dbg('child exit ' + exitCode); bye(exitCode); });

function killChild() { try { p.kill(); } catch (e) {} }
process.stdin.on('end', () => { const t = decoder.end(); if (t) feed(t); killChild(); bye(0); });
process.stdin.on('error', () => { killChild(); bye(0); });
process.on('SIGTERM', () => { killChild(); bye(0); });
process.on('SIGHUP', () => { killChild(); bye(0); });
