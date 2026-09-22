// termrover-attach — Windows compatibility shim for `herdr terminal attach`.
//
// TermRover's "herdr agents fleet" feature execs, per attached agent:
//   sh -c 'exec <herdr> [--session <S>] terminal attach <term_id> [--takeover]
//          < /dev/tty 3>&- &'
// and 0.1s later checks whether that child is still alive to decide
// "attached" vs "failed". The Windows build of herdr 0.9.0-preview hard-fails
// `terminal attach` (src/client/startup.rs, #[cfg(windows)]):
//   Error: Custom { kind: Unsupported, error: "direct terminal attach is not
//   supported on Windows yet" }   (exit=1)
// but `herdr terminal session control <id>` works: it speaks a simple
// newline-delimited JSON protocol on stdin/stdout (frames in, input/resize/
// release out) — see src/client/terminal_sessions.rs. This shim impersonates
// `herdr terminal attach` for exactly that argv shape: it probes whether the
// *real* herdr binary has grown native support (so this shim retires itself
// automatically the day upstream fixes Windows), and only falls back to
// bridging `terminal session control` when the real binary still refuses.
//
// wsshd.js rewrites the herdr path inside TermRover's `termrover-login`
// scripts to point at this shim instead (see termroverCompat()); nothing
// else about those scripts changes.
//
// Usage the shim actually receives (via the `termrover-attach` sh wrapper):
//   termrover-attach [--session <S>] terminal attach <term_id> [--takeover]
// Any other argv shape is passed through to the real herdr untouched.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = process.env.USERPROFILE || os.homedir();
const LOGFILE = process.env.TERMROVER_ATTACH_LOG || path.join(__dirname, 'termrover-attach.log');
const DEFAULT_HERDR_BIN = path.join(HOME, 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const PROBE_TIMEOUT_MS = 5000;
const PROBE_TERM_ID = '__termrover_probe_nonexistent__';
const NOT_SUPPORTED_RE = /not supported on windows/i;

function log(s) {
  const line = new Date().toISOString() + ' ' + s + '\n';
  try { fs.appendFileSync(LOGFILE, line); } catch (e) {}
}
process.on('uncaughtException', e => { log('uncaught: ' + (e && e.stack || e)); try { process.exit(1); } catch (e2) {} });

// --- terminal init/restore sequences (emulate mode only) ---
//
// Real herdr attach clients (terminal_setup.rs/terminal_modes.rs) enter the
// alternate screen and turn on SGR mouse reporting + bracketed paste before
// the first frame, and restore all of it on the way out. Our stdin/stdout
// here are the phone client's real TTY (via TermRover's parking pty), so we
// have to do the same thing ourselves -- otherwise the phone's own local
// terminal has no alt-screen/scrollback boundary and no mouse reporting, so
// scrolling and (later) any semantic key handling on the client side has
// nothing to hook into.
const INIT_SEQ = '\x1b[?1049h' + '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1016l' + '\x1b[?2004h';
const RESTORE_SEQ = '\x1b[?2004l' + '\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l' + '\x1b[?1049l' + '\x1b[?25h\x1b[0 q';

// Set true the instant INIT_SEQ is actually written (i.e. only once we're
// really in emulate mode and the control-plane child spawned). Gates both
// the restore write and the stats log line below so official-mode/passthrough
// runs -- which never touch this flag -- are byte-for-byte unaffected.
let emulateInitDone = false;
// Set by runEmulate() to a zero-arg function returning the current counters;
// read once, here, at actual process exit.
let emulateStats = null;

// Single choke point for "every exit path restores the terminal exactly
// once": process 'exit' fires exactly once per process lifetime no matter
// whether we got here via a clean finish(), a signal, stdin EOF, a
// terminal.closed from the control child, the child dying, or an uncaught
// exception (whose handler above calls process.exit()) -- and unlike those
// call sites, we don't have to enumerate them here or risk writing the
// restore sequence twice. fs.writeSync (not process.stdout.write) because
// 'exit' handlers must be synchronous and a stream write is not guaranteed
// to flush before the process actually dies.
process.on('exit', () => {
  if (!emulateInitDone) return;
  try { fs.writeSync(1, Buffer.from(RESTORE_SEQ, 'binary')); } catch (e) {}
  try {
    const s = (emulateStats && emulateStats()) || {};
    log('stats in_chunks=' + (s.inChunks || 0) + ' in_bytes=' + (s.inBytes || 0) +
      ' inputs_sent=' + (s.inputsSent || 0) + ' scrolls=' + (s.scrolls || 0) +
      ' mouse_dropped=' + (s.mouseDropped || 0) + ' frames=' + (s.frames || 0) +
      ' full_frames=' + (s.fullFrames || 0) + ' last_seq=' + (s.lastSeq || 0));
  } catch (e) {}
});

function resolveHerdrBin() {
  return process.env.HERDR_REAL || process.env.HERDR_BIN_PATH || DEFAULT_HERDR_BIN;
}

// Parse argv for the exact shape `[--session <S>] terminal attach <term_id>
// [--takeover]`. Returns null for anything else -- the caller must then exec
// the ORIGINAL argv untouched (rule: only this one shape is ours to shim).
function parseAttachArgs(argv) {
  let i = 0;
  let session = null;
  if (argv[i] === '--session') {
    if (argv.length < i + 2 || !argv[i + 1]) return null;
    session = argv[i + 1];
    i += 2;
  }
  if (argv[i] !== 'terminal' || argv[i + 1] !== 'attach') return null;
  i += 2;
  const termId = argv[i];
  if (!termId) return null;
  i += 1;
  let takeover = false;
  if (argv[i] === '--takeover') { takeover = true; i += 1; }
  if (i !== argv.length) return null; // trailing junk: not our shape, pass through
  return { session, termId, takeover };
}

// Run the real herdr binary with the given argv, stdio inherited, exit code
// passed through verbatim. Used both for "official support" mode and for any
// argv shape we don't recognize as ours.
function execReal(herdrBin, argv) {
  let child;
  try {
    child = spawn(herdrBin, argv, { stdio: 'inherit', windowsHide: false });
  } catch (e) {
    log('exec real herdr failed: ' + (e && e.stack || e));
    process.exit(1);
    return;
  }
  child.on('error', e => { log('exec real herdr failed: ' + (e && e.stack || e)); process.exit(1); });
  child.on('exit', (code, signal) => process.exit(code === null ? 1 : code));
}

// Detect whether the installed herdr already supports `terminal attach` on
// Windows. Always run unless overridden by TERMROVER_ATTACH_MODE. A probe
// attach against a nonexistent term id is cheap (herdr just reports "not
// found") and identical either way; only the failure MESSAGE tells us
// whether Windows support is still missing.
function probeOfficialSupport(herdrBin, session, cb) {
  const args = [];
  if (session) args.push('--session', session);
  args.push('terminal', 'attach', PROBE_TERM_ID);

  let out = '';
  let done = false;
  let child;
  try {
    child = spawn(herdrBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return cb('official', '(probe spawn failed: ' + (e && e.message || e) + ')');
  }
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    try { child.kill(); } catch (e) {}
    cb('official', '(probe timeout after ' + PROBE_TIMEOUT_MS + 'ms)');
  }, PROBE_TIMEOUT_MS);
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', e => {
    if (done) return; done = true; clearTimeout(timer);
    cb('official', '(probe spawn error: ' + (e && e.message || e) + ')');
  });
  child.on('exit', () => {
    if (done) return; done = true; clearTimeout(timer);
    const mode = NOT_SUPPORTED_RE.test(out) ? 'emulate' : 'official';
    const firstLine = (out.split(/\r?\n/).find(l => l.trim().length > 0) || '(no probe output)').trim();
    cb(mode, firstLine);
  });
  try { child.stdin.end(); } catch (e) {}
}

// --- input filter: raw stdin bytes -> ordered semantic actions ---
//
// Pure-ish state machine, deliberately decoupled from any I/O: it never
// touches process.stdin/stdout or the control-plane child itself, only calls
// the `onAction` callback given at construction time with one of:
//   { input: Buffer }            -- forward these bytes as terminal.input
//   { scroll: {direction,lines,source,column?,row?,modifiers} }
//   { detach: true }             -- caller should send terminal.release and exit
// This lets tests/b2_filter_unit.js require() this module and drive it
// directly with byte chunks, independent of any spawned process or pty.
//
// Priority order per the dispatch contract:
//   a. bracketed paste (opaque, can span feed() calls)
//   b. SGR mouse wheel press -> scroll; other SGR mouse press -> dropped+counted;
//      SGR mouse release -> ignored outright
//   c. bare PageUp/PageDown (\x1b[5~ / \x1b[6~) -> scroll
//   d. Ctrl+B (0x02) prefix -> next byte decides: 'q'=detach, 0x02=literal 0x02,
//      anything else=literal 0x02+byte
//   e. everything else -> forwarded as input
//   f. a lone ESC or an incomplete CSI is held for at most 30ms waiting for
//      the rest to arrive on a later feed() call; on timeout it is flushed
//      as literal input bytes (never swallowed).
function createInputFilter(opts) {
  opts = opts || {};
  const emit = typeof opts.onAction === 'function' ? opts.onAction : function () {};
  let rows = opts.rows || 24;

  const stats = { inChunks: 0, inBytes: 0, inputsSent: 0, scrolls: 0, mouseDropped: 0 };

  let pendingPrefix = false; // saw Ctrl+B, waiting for the next byte
  let pasteActive = false;
  let pasteBuf = null; // accumulates from the opening \x1b[200~ onward
  let escBuf = null; // an ESC-led byte run that's still an ambiguous prefix
  let escTimer = null;

  const PASTE_START = Buffer.from('\x1b[200~', 'binary');
  const PASTE_END = Buffer.from('\x1b[201~', 'binary');
  const PAGE_UP = Buffer.from('\x1b[5~', 'binary');
  const PAGE_DOWN = Buffer.from('\x1b[6~', 'binary');
  const SGR_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
  const SGR_PREFIX_RE = /^\x1b\[<[0-9;]*$/;

  function clearEscTimer() { if (escTimer) { clearTimeout(escTimer); escTimer = null; } }

  function flushEscBufAsInput() {
    clearEscTimer();
    if (escBuf && escBuf.length) {
      const b = escBuf;
      escBuf = null;
      emitInput(b);
    }
    escBuf = null;
  }

  function armEscTimer() {
    clearEscTimer();
    escTimer = setTimeout(flushEscBufAsInput, 30);
    if (escTimer.unref) escTimer.unref();
  }

  function emitInput(buf) {
    if (!buf || !buf.length) return;
    stats.inputsSent++;
    emit({ input: buf });
  }

  function emitScroll(direction, lines, source, column, row, modifiers) {
    stats.scrolls++;
    const s = { direction: direction, lines: lines, source: source };
    if (column !== undefined) s.column = column;
    if (row !== undefined) s.row = row;
    s.modifiers = modifiers || 0;
    emit({ scroll: s });
  }

  function emitDetach() { emit({ detach: true }); }

  function setRows(n) { if (n) rows = n; }

  function startsWithPrefix(buf, prefix) {
    if (buf.length < prefix.length) return false;
    return buf.slice(0, prefix.length).equals(prefix);
  }
  function isStrictPrefixOf(buf, full) {
    if (buf.length >= full.length) return false;
    return buf.equals(full.slice(0, buf.length));
  }

  // Returns a leftover Buffer (possibly empty) once the terminator has been
  // seen, or null while still waiting for more data.
  function checkPasteTerminator() {
    const idx = pasteBuf.indexOf(PASTE_END);
    if (idx === -1) return null;
    const full = pasteBuf.slice(0, idx + PASTE_END.length);
    const leftover = pasteBuf.slice(idx + PASTE_END.length);
    pasteActive = false;
    pasteBuf = null;
    emitInput(full);
    return leftover;
  }

  // Classifies the escape-led run `rest` (rest[0] === 0x1b, guaranteed by
  // caller). Returns one of:
  //   {kind:'incomplete'}                          -- need more bytes
  //   {kind:'paste-start', consumed}
  //   {kind:'page', direction, consumed}
  //   {kind:'sgr-mouse', consumed, b, x, y}         -- press
  //   {kind:'sgr-mouse-release', consumed}
  //   {kind:'generic-csi', consumed}                -- any other complete CSI
  //   {kind:'esc-plain', consumed}                  -- ESC + one non-'[' byte
  function classifyEscape(rest) {
    if (rest.length === 1) return { kind: 'incomplete' };
    if (rest[1] === 0x4f /* 'O' */) return rest.length >= 3 ? { kind: 'esc-plain', consumed: 3 } : { kind: 'incomplete' }; // SS3 (ESC O A = app-cursor arrow): keep as one input
    if (rest[1] !== 0x5b /* '[' */) return { kind: 'esc-plain', consumed: 2 };

    if (startsWithPrefix(rest, PASTE_START)) return { kind: 'paste-start', consumed: PASTE_START.length };
    if (isStrictPrefixOf(rest, PASTE_START)) return { kind: 'incomplete' };

    if (startsWithPrefix(rest, PAGE_UP)) return { kind: 'page', direction: 'up', consumed: PAGE_UP.length };
    if (startsWithPrefix(rest, PAGE_DOWN)) return { kind: 'page', direction: 'down', consumed: PAGE_DOWN.length };
    if (isStrictPrefixOf(rest, PAGE_UP) || isStrictPrefixOf(rest, PAGE_DOWN)) return { kind: 'incomplete' };

    if (rest.length >= 3 && rest[2] === 0x3c /* '<' */) {
      const s = rest.toString('binary');
      const m = SGR_RE.exec(s);
      if (m) {
        const consumed = m[0].length;
        const b = parseInt(m[1], 10), x = parseInt(m[2], 10), y = parseInt(m[3], 10);
        return m[4] === 'M'
          ? { kind: 'sgr-mouse', consumed: consumed, b: b, x: x, y: y }
          : { kind: 'sgr-mouse-release', consumed: consumed };
      }
      if (SGR_PREFIX_RE.test(s)) return { kind: 'incomplete' };
      // malformed SGR-looking prefix: fall through to generic CSI below.
    }

    // Generic CSI: ESC '[' params... final-byte(0x40-0x7E). Forwarded whole,
    // uninterpreted -- arrow keys, function keys, modified page keys, etc.
    for (let k = 2; k < rest.length; k++) {
      const c = rest[k];
      if (c >= 0x40 && c <= 0x7e) return { kind: 'generic-csi', consumed: k + 1 };
    }
    return { kind: 'incomplete' };
  }

  function processBuf(buf) {
    let i = 0;
    let literalStart = -1;
    function flushLiteralRun(uptoExclusive) {
      if (literalStart !== -1 && uptoExclusive > literalStart) emitInput(buf.slice(literalStart, uptoExclusive));
      literalStart = -1;
    }

    while (i < buf.length) {
      const byte = buf[i];

      if (pendingPrefix) {
        flushLiteralRun(i);
        pendingPrefix = false;
        if (byte === 0x71 /* 'q' */) { emitDetach(); i += 1; continue; }
        if (byte === 0x02) { emitInput(Buffer.from([0x02])); i += 1; continue; }
        emitInput(Buffer.from([0x02, byte]));
        i += 1;
        continue;
      }

      if (byte === 0x02) {
        flushLiteralRun(i);
        pendingPrefix = true;
        i += 1;
        continue;
      }

      if (byte === 0x1b) {
        flushLiteralRun(i);
        const rest = buf.slice(i);
        const decision = classifyEscape(rest);
        if (decision.kind === 'incomplete') {
          escBuf = rest;
          armEscTimer();
          return; // whole remainder held back; wait for more data or timeout
        }
        if (decision.kind === 'paste-start') {
          pasteActive = true;
          pasteBuf = rest; // includes the opening marker and anything after it in this buf
          const leftover = checkPasteTerminator();
          if (leftover === null) return; // still waiting on the terminator
          if (leftover.length) processBuf(leftover);
          return;
        }
        if (decision.kind === 'page') {
          emitScroll(decision.direction, Math.max(1, rows - 1), 'page_key');
          i += decision.consumed;
          continue;
        }
        if (decision.kind === 'sgr-mouse') {
          const b = decision.b;
          if (b & 64) {
            const dir3 = b & 3;
            if (dir3 === 0 || dir3 === 1) {
              let mods = 0;
              if (b & 4) mods |= 1; // shift
              if (b & 8) mods |= 4; // alt
              if (b & 16) mods |= 2; // control
              emitScroll(dir3 === 0 ? 'up' : 'down', 3, 'wheel', decision.x - 1, decision.y - 1, mods);
            } else {
              stats.mouseDropped++;
            }
          } else {
            stats.mouseDropped++;
          }
          i += decision.consumed;
          continue;
        }
        if (decision.kind === 'sgr-mouse-release') {
          i += decision.consumed; // ignored outright, not even counted
          continue;
        }
        // generic-csi / esc-plain: forward the whole matched run verbatim.
        emitInput(rest.slice(0, decision.consumed));
        i += decision.consumed;
        continue;
      }

      if (literalStart === -1) literalStart = i;
      i += 1;
    }
    flushLiteralRun(buf.length);
  }

  function feed(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    stats.inChunks++;
    stats.inBytes += chunk.length;

    if (pasteActive) {
      pasteBuf = Buffer.concat([pasteBuf, chunk]);
      const leftover = checkPasteTerminator();
      if (leftover === null) return;
      if (leftover.length) processBuf(leftover);
      return;
    }

    let buf = chunk;
    if (escBuf) {
      buf = Buffer.concat([escBuf, chunk]);
      escBuf = null;
      clearEscTimer();
    }
    processBuf(buf);
  }

  return { feed: feed, setRows: setRows, stats: stats };
}

// --- emulate mode: bridge `terminal session control` <-> our own stdio ---
function runEmulate(herdrBin, session, termId, takeover, cols, rows) {
  const args = [];
  if (session) args.push('--session', session);
  args.push('terminal', 'session', 'control', termId);
  if (takeover) args.push('--takeover');
  args.push('--cols', String(cols), '--rows', String(rows));

  let child;
  try {
    child = spawn(herdrBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    log('exit reason=emulate spawn failed: ' + (e && e.message || e));
    process.exit(1);
    return;
  }

  // Init sequence: after spawn, before the first frame can possibly be
  // written (no frame can arrive before the next tick, and this write is
  // synchronous). emulateInitDone gates the matching restore + stats lines
  // at actual process exit (see the top-level process.on('exit', ...)).
  try { process.stdout.write(INIT_SEQ); } catch (e) {}
  emulateInitDone = true;

  const rawTty = !!(process.stdin.isTTY && typeof process.stdin.setRawMode === 'function');
  if (rawTty) { try { process.stdin.setRawMode(true); } catch (e) {} }
  try { process.stdin.resume(); } catch (e) {}

  let finished = false;
  let inLogCount = 0;
  let scrollLogCount = 0;
  let frames = 0, fullFrames = 0, lastSeq = 0, loggedFirstFrame = false;
  function finish(reason, code) {
    if (finished) return;
    finished = true;
    if (rawTty) { try { process.stdin.setRawMode(false); } catch (e) {} }
    try { process.stdin.pause(); } catch (e) {}
    log('exit reason=' + reason);
    process.exit(code || 0);
  }

  // Wait (briefly) for the child to exit on its own -- it self-terminates
  // once it sees ServerMessage::ServerShutdown (which follows either our
  // ClientMessage::Detach or the underlying stream simply closing) -- and
  // force-kill only as a failsafe so no `terminal session control` process
  // is ever left running after this shim exits.
  function waitChildThenFinish(reason, code, graceMs) {
    if (finished) return;
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, graceMs);
    child.once('exit', () => { clearTimeout(timer); finish(reason, code); });
  }

  function releaseAndExit(reason) {
    if (finished) return;
    try {
      child.stdin.write(JSON.stringify({ type: 'terminal.release' }) + '\n');
    } catch (e) {}
    waitChildThenFinish(reason, 0, 2000);
  }

  // Input filter output -> control-plane messages. Kept as a thin adapter so
  // the filter itself stays free of any reference to `child`/`finished`.
  function handleAction(action) {
    if (finished) return;
    if (action.input) {
      try { child.stdin.write(JSON.stringify({ type: 'terminal.input', bytes: action.input.toString('base64') }) + '\n'); } catch (e) {}
    } else if (action.scroll) {
      if (scrollLogCount < 50) {
        scrollLogCount++;
        log('scroll ' + action.scroll.direction + ' lines=' + action.scroll.lines + ' src=' + action.scroll.source);
      }
      const msg = Object.assign({ type: 'terminal.scroll' }, action.scroll);
      try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) {}
    } else if (action.detach) {
      releaseAndExit('ctrl-b detach');
    }
  }
  const filter = createInputFilter({ rows: rows, onAction: handleAction });
  emulateStats = () => ({
    inChunks: filter.stats.inChunks, inBytes: filter.stats.inBytes,
    inputsSent: filter.stats.inputsSent, scrolls: filter.stats.scrolls,
    mouseDropped: filter.stats.mouseDropped,
    frames: frames, fullFrames: fullFrames, lastSeq: lastSeq,
  });

  // child stdout: newline-delimited JSON control-plane messages.
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      if (msg && msg.type === 'terminal.frame') {
        const frameBytes = Buffer.from(msg.bytes, 'base64');
        frames++;
        if (msg.full) fullFrames++;
        lastSeq = msg.seq;
        if (!loggedFirstFrame) {
          loggedFirstFrame = true;
          log('frame#1 full=' + !!msg.full + ' ' + msg.width + 'x' + msg.height + ' bytes=' + frameBytes.length);
        }
        try { process.stdout.write(frameBytes); } catch (e) {}
      } else if (msg && msg.type === 'terminal.closed') {
        waitChildThenFinish('terminal.closed: ' + (msg.reason || ''), 0, 1500);
      }
    }
  });
  child.stderr.on('data', d => log('herdr control stderr: ' + d.toString('utf8').trim()));
  child.on('error', e => finish('child spawn error: ' + (e && e.message || e), 1));
  child.on('exit', (code, signal) => finish('child exited code=' + code + ' signal=' + signal, code || 0));

  // our stdin: raw keystroke bytes -> filtered actions -> terminal.input /
  // terminal.scroll / detach.
  process.stdin.on('data', d => {
    if (finished) return;
    if (inLogCount < 20) {
      inLogCount++;
      log('in ' + d.length + 'B hex=' + d.slice(0, 48).toString('hex'));
    }
    filter.feed(d);
  });
  process.stdin.on('end', () => releaseAndExit('stdin EOF'));

  // resize: forward the ssh channel's window-change (surfaced by wsshd as a
  // pty resize, which node reflects as a 'resize' event on process.stdout).
  // Every change is forwarded, rows included. 2026-09-20 tried swallowing
  // rows-only changes (assuming they were only the soft keyboard) and broke
  // the view: TermRover always opens the pty one size, then corrects the row
  // count ~0.4s later once its toolbar is laid out (50x52 -> 50x47 in every
  // session's log). Swallowing that correction leaves herdr rendering frames
  // taller than the phone's screen, and the bottom rows -- where the agent's
  // input box lives -- fall off it. The pty is shared either way: this shim
  // already resizes it at attach via `session control --cols --rows`.
  process.stdout.on('resize', () => {
    if (finished) return;
    const c = process.stdout.columns || cols;
    const r = process.stdout.rows || rows;
    filter.setRows(r);
    log('resize ' + c + 'x' + r);
    try { child.stdin.write(JSON.stringify({ type: 'terminal.resize', cols: c, rows: r }) + '\n'); } catch (e) {}
  });

  ['SIGTERM', 'SIGINT', 'SIGHUP'].forEach(sig => {
    try { process.on(sig, () => releaseAndExit('signal ' + sig)); } catch (e) {}
  });
}

function startWithMode(mode, reason, herdrBin, argv, session, termId, takeover) {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  log('start mode=' + mode + ' reason=' + JSON.stringify(reason) +
    ' session=' + (session || '-') + ' term=' + termId + ' size=' + cols + 'x' + rows);
  if (mode === 'official') execReal(herdrBin, argv);
  else runEmulate(herdrBin, session, termId, takeover, cols, rows);
}

function main() {
  const argv = process.argv.slice(2);
  const herdrBin = resolveHerdrBin();
  const parsed = parseAttachArgs(argv);
  if (!parsed) { execReal(herdrBin, argv); return; }

  const { session, termId, takeover } = parsed;
  const forced = process.env.TERMROVER_ATTACH_MODE;
  if (forced === 'official' || forced === 'emulate') {
    startWithMode(forced, '(forced by TERMROVER_ATTACH_MODE=' + forced + ')', herdrBin, argv, session, termId, takeover);
    return;
  }
  probeOfficialSupport(herdrBin, session, (mode, reason) => {
    startWithMode(mode, reason, herdrBin, argv, session, termId, takeover);
  });
}

if (require.main === module) {
  main();
} else {
  module.exports = { createInputFilter };
}
