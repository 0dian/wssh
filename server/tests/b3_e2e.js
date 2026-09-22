// B3: full end-to-end replay of TermRover's parking/attach/detach scripts
// against the REAL, already-patched wsshd.js and REAL termrover-attach shim,
// targeting the named herdr session "sbtest" only (never "default"),
// exercising the new emulate-mode terminal init/restore sequences and the
// input filter's scroll/keystroke paths (20260912-termrover-attach-input).
//
// Scripts lifted verbatim from production wsshd.log (same source as
// a4_e2e_real_attach.js), with exactly three substitutions: tr_dir id,
// 'default' -> 'sbtest', term id -> the real sbtest pane's terminal_id
// (fetched live via `herdr --session sbtest pane list`, not hardcoded).
//
// The 200-line scrollback fixture is filled BEFORE attach, directly via
// `herdr pane run`/`wait-output` (out of band, not through this attached
// client's stdin/stdout). That keeps the "LINE<k> currently on screen"
// baseline clean: parkOut, up to the point we're about to scroll, then only
// ever contains the initial attach frame's rendering of the (already full)
// pane -- never the transient scroll-by of each line being echoed live --
// so any earlier LINE<j> appearing in the frames received AFTER we send the
// scroll commands can only have come from the scroll itself.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

const HERDR = process.env.HERDR_BIN_PATH || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const HERDR_UNIX_NOEXT = '/' + HERDR[0].toLowerCase() + HERDR.slice(2).replace(/\\/g, '/').replace(/\.exe$/i, '');
function herdrSb(args) { return spawnSync(HERDR, ['--session', 'sbtest'].concat(args), { encoding: 'utf8' }); }

const paneList = herdrSb(['pane', 'list']);
let SBTEST_TERM_ID = null, SBTEST_PANE_ID = null;
try {
  const parsed = JSON.parse(paneList.stdout);
  SBTEST_PANE_ID = parsed.result.panes[0].pane_id;
  SBTEST_TERM_ID = parsed.result.panes[0].terminal_id;
} catch (e) {}
if (!SBTEST_TERM_ID) {
  console.log('could not fetch sbtest terminal_id (is the sbtest session running with a pane? run tests/start_sbtest.js first): ' +
    JSON.stringify(paneList.stdout) + ' ' + JSON.stringify(paneList.stderr));
  process.exit(1);
}
console.log('sbtest pane_id=' + SBTEST_PANE_ID + ' terminal_id=' + SBTEST_TERM_ID);

// Fill scrollback with 200 lines out of band, before attach.
const runR = herdrSb(['pane', 'run', SBTEST_PANE_ID, 'for /L %i in (1,1,200) do @echo LINE%i']);
if (runR.status !== 0) { console.log('pane run failed: ' + runR.stdout + runR.stderr); process.exit(1); }
const waitR = herdrSb(['pane', 'wait-output', SBTEST_PANE_ID, '--match', 'LINE200', '--timeout', '30000']);
const filledOk = waitR.status === 0 && /LINE200/.test(waitR.stdout || '');
console.log('scrollback pre-fill (200 lines, out of band via herdr pane run): ' + filledOk + (filledOk ? '  OK' : '  FAIL'));
if (!filledOk) { console.log(waitR.stdout + waitR.stderr); process.exit(1); }

const OLD_ID = 'd4049bff9e814ac1851e5fc4f7653e9f';
const OLD_TERM = 'term_65b3219ef04833';
const NEW_ID = crypto.randomBytes(16).toString('hex');

const prod = fs.readFileSync(RELAY + '/wsshd.log', 'utf8').split('\n');
function cmdOf(line) {
  const s = line.indexOf(' exec ') + 6;
  const e = line.trim().lastIndexOf(' ');
  return JSON.parse(line.slice(s, e));
}
const find = re => prod.find(l => l.includes(OLD_ID) && re.test(l));
const parkLine = find(/termrover-login.* \d+x\d+\s*$/);
const attachLine = find(/attach 7e86bc0fb6cc4f1fb43b8f1b80f67289.* pipe\s*$/);
const detachLine = find(/detach 2076bcf2947f46599b1cc0ad0e637733.* pipe\s*$/);
if (!parkLine || !attachLine || !detachLine) { console.log('missing logged scripts', !!parkLine, !!attachLine, !!detachLine); process.exit(1); }

const rawPark = cmdOf(parkLine);
function countOf(hay, needle) { return hay.split(needle).length - 1; }
const checks = [
  ['tr_dir id', rawPark, OLD_ID],
  ["'default' session arg", rawPark, "'default'"],
  ['term id', rawPark, OLD_TERM],
];
for (const [label, hay, needle] of checks) {
  const n = countOf(hay, needle);
  console.log('sanity: ' + label + ' occurs ' + n + ' time(s) in PARK script' + (n === 1 ? '  OK' : '  UNEXPECTED'));
  if (n !== 1) { process.exit(1); }
}

function swap(c) {
  return c.split(OLD_ID).join(NEW_ID).split("'default'").join("'sbtest'").split(OLD_TERM).join(SBTEST_TERM_ID);
}
const PARK = swap(rawPark);
const ATTACH = cmdOf(attachLine).split(OLD_ID).join(NEW_ID);
const DETACH = cmdOf(detachLine).split(OLD_ID).join(NEW_ID);
console.log('fresh tr_dir id: ' + NEW_ID + ', term id: ' + SBTEST_TERM_ID);
console.log('PARK herdr path untouched (termroverCompat must rewrite it): ' +
  PARK.includes(HERDR_UNIX_NOEXT));

const key = path.join(dir, 'e2e_client_ed25519');
const hostkey = path.join(dir, 'e2e_host_ed25519');
for (const k of [key, hostkey]) {
  if (fs.existsSync(k)) continue;
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('keygen failed: ' + (r.stderr || r.error)); process.exit(1); }
}
const authfile = path.join(dir, 'e2e_authorized_keys');
fs.writeFileSync(authfile, fs.readFileSync(key + '.pub'));
const logf = path.join(dir, 'b3_wsshd.log');
const attachLogf = path.join(dir, 'b3_termrover-attach.log');
try { fs.unlinkSync(logf); } catch (e) {}
try { fs.unlinkSync(attachLogf); } catch (e) {}

const PORT = 2299;
const srv = spawn(process.execPath, [RELAY + '/wsshd.js'], {
  env: Object.assign({}, process.env, {
    WSSHD_PORT: String(PORT), WSSHD_BIND: '127.0.0.1',
    WSSHD_HOSTKEY: hostkey, WSSHD_AUTHKEYS: authfile, WSSHD_LOG: logf,
    TERMROVER_ATTACH_LOG: attachLogf,
  }),
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
srv.stderr.on('data', d => process.stdout.write('[srv stderr] ' + d));

let parkOut = '';
let allOk = true;
let torndown = false;
function fail(msg) { allOk = false; console.log('FAIL: ' + msg); }
function strip(s) {
  return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[^\x20-\x7e\n]/g, '');
}
function lineNumbersIn(text) { return [...strip(text).matchAll(/LINE(\d+)/g)].map(m => parseInt(m[1], 10)); }

function done(code) {
  torndown = true;
  try { srv.kill(); } catch (e) {}
  setTimeout(() => {
    let alog = '';
    try { alog = fs.readFileSync(attachLogf, 'utf8'); } catch (e) {}
    console.log('--- termrover-attach.log ---\n' + alog);
    try {
      const l = fs.readFileSync(logf, 'utf8').split('\n').map(s => s.length > 220 ? s.slice(0, 220) + ' ...' : s);
      console.log('--- e2e wsshd log ---\n' + l.join('\n'));
    } catch (e) {}
    console.log(allOk && code === 0 ? 'B3 OVERALL: OK' : 'B3 OVERALL: FAIL');
    process.exit(allOk ? 0 : 1);
  }, 800);
}
setTimeout(() => { fail('overall timeout'); done(3); }, 90000);

function execCmd(conn, cmd) {
  return new Promise(res => conn.exec(cmd, (err, stream) => {
    if (err) return res({ stdout: '', code: 'ERR ' + err.message });
    let out = '', code;
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', () => {});
    stream.on('exit', c => { code = c; });
    stream.on('close', () => res({ stdout: out, code }));
  }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let started = false;
srv.stdout.on('data', d => {
  if (started || !/listening on/.test(String(d))) return;
  started = true;
  const conn = new ssh2.Client();
  conn.on('error', e => {
    if (torndown) { console.log('(post-teardown conn error, ignored): ' + e.message); return; }
    fail('client error: ' + e.message); done(4);
  });
  conn.on('ready', () => {
    conn.exec(PARK, { pty: { rows: 30, cols: 100, term: 'xterm-256color' } }, async (err, park) => {
      if (err) { fail('parking exec failed: ' + err.message); conn.end(); return done(5); }
      park.on('data', b => { parkOut += b; });
      await sleep(2000); // login shell + mkfifo

      const a = await execCmd(conn, ATTACH);
      const attachOk = a.stdout.trim() === 'attached';
      console.log('attach reply (exit ' + a.code + '): [' + a.stdout.trim() + ']' + (attachOk ? '  OK' : '  FAIL'));
      if (!attachOk) fail('attach did not reply "attached"');

      // give the shim's probe + spawn of `terminal session control` + the
      // real herdr client's handshake a moment before checking the raw init
      // sequence bytes.
      await sleep(2000);

      const hasInit1049 = parkOut.includes('\x1b[?1049h');
      const hasInit1006 = parkOut.includes('\x1b[?1006h');
      const hasInit2004 = parkOut.includes('\x1b[?2004h');
      console.log('parking pty output contains raw ESC[?1049h: ' + hasInit1049 + (hasInit1049 ? '  OK' : '  FAIL'));
      console.log('parking pty output contains raw ESC[?1006h: ' + hasInit1006 + (hasInit1006 ? '  OK' : '  FAIL'));
      console.log('parking pty output contains raw ESC[?2004h: ' + hasInit2004 + (hasInit2004 ? '  OK' : '  FAIL'));
      if (!hasInit1049 || !hasInit1006 || !hasInit2004) fail('init sequence bytes missing from parking pty output after attach');

      // k = the minimum LINE<n> visible in the initial attach frame(s) --
      // parkOut up to this point has NOT been polluted by any live typing
      // yet, since the 200 lines were generated out of band before attach.
      const preScrollPos = parkOut.length;
      const visibleBefore = lineNumbersIn(parkOut.slice(0, preScrollPos));
      const k = visibleBefore.length ? Math.min(...visibleBefore) : NaN;
      console.log('minimum LINE<k> visible in the initial attach frame: k=' + k + ' (from ' + visibleBefore.length + ' occurrence(s))');

      for (let i = 0; i < 10; i++) {
        park.write('\x1b[<64;10;5M');
        await sleep(150);
      }
      await sleep(1500);
      // Delta frames only retransmit the screen cells that actually changed
      // (e.g. just the trailing digit(s) of "LINE142" -> "LINE141", not the
      // "LINE" prefix that didn't move), so they won't contain a literal
      // "LINE<n>" substring even when the scroll genuinely worked (verified
      // separately against the raw control-plane protocol). Force one full,
      // unambiguous redraw the same way A4 already does for its resize
      // check: a window-change through the SAME parking pty, which our shim
      // forwards as terminal.resize -- and confirmed by direct protocol probe
      // that this does NOT reset the scroll position back to the bottom.
      park.setWindow(28, 96, 0, 0); // rows, cols
      await sleep(2000);

      const newBytes = parkOut.slice(preScrollPos);
      const visibleAfter = lineNumbersIn(newBytes);
      const scrollWorked = visibleAfter.length > 0 && Number.isFinite(k) && Math.min(...visibleAfter) < k;
      console.log('LINE numbers seen in the frame(s) after scrolling (post-resize full redraw): ' + JSON.stringify(visibleAfter));
      console.log('scrolled to an earlier LINE<j> with j<k=' + k + ': ' + scrollWorked + (scrollWorked ? '  OK' : '  NOT PASSED'));
      if (!scrollWorked) fail('scrolling up did not reveal a LINE<j> earlier than k=' + k + ' -- see note in report about Windows herdr scrollback support');

      let alogAfterScroll = '';
      try { alogAfterScroll = fs.readFileSync(attachLogf, 'utf8'); } catch (e) {}
      const scrollLogged = /scroll up/.test(alogAfterScroll);
      console.log('termrover-attach.log contains "scroll up": ' + scrollLogged + (scrollLogged ? '  OK' : '  FAIL'));
      if (!scrollLogged) fail('no "scroll up" line in termrover-attach.log');

      // Type "echo KEYS%OS%\r" one byte at a time, >=100ms apart, through the
      // SAME parking pty (this is TermRover's whole trick: the shim's
      // stdin/stdout are that pty's /dev/tty).
      const marker = 'echo KEYS%OS%';
      for (const ch of marker) {
        park.write(ch);
        await sleep(110);
      }
      park.write('\r');
      await sleep(1500);
      const echoOk = /KEYSWindows_NT/.test(strip(parkOut));
      console.log('parking pty shows KEYSWindows_NT (byte-at-a-time keys reached real cmd.exe): ' + echoOk + (echoOk ? '  OK' : '  FAIL'));
      if (!echoOk) fail('KEYSWindows_NT not observed after byte-at-a-time typing');

      const preDetachPos = parkOut.length;
      const dt = await execCmd(conn, DETACH);
      const detachOk = dt.stdout.trim() === 'parked';
      console.log('detach reply (exit ' + dt.code + '): [' + dt.stdout.trim() + ']' + (detachOk ? '  OK' : '  FAIL'));
      if (!detachOk) fail('detach did not reply "parked"');
      await sleep(1500);

      const afterDetach = parkOut.slice(preDetachPos);
      const hasRestore1049 = afterDetach.includes('\x1b[?1049l');
      const hasRestore1000 = afterDetach.includes('\x1b[?1000l');
      console.log('parking pty output after detach contains raw ESC[?1049l: ' + hasRestore1049 + (hasRestore1049 ? '  OK' : '  FAIL'));
      console.log('parking pty output after detach contains raw ESC[?1000l: ' + hasRestore1000 + (hasRestore1000 ? '  OK' : '  FAIL'));
      if (!hasRestore1049 || !hasRestore1000) fail('restore sequence bytes missing from parking pty output after detach');

      let finalLog = '';
      try { finalLog = fs.readFileSync(attachLogf, 'utf8'); } catch (e) {}
      const hasIn = / in \d+B hex=/.test(finalLog);
      const hasFrame1 = /frame#1 /.test(finalLog);
      const hasStats = / stats /.test(finalLog);
      console.log('termrover-attach.log has "in " line: ' + hasIn + (hasIn ? '  OK' : '  FAIL'));
      console.log('termrover-attach.log has "frame#1" line: ' + hasFrame1 + (hasFrame1 ? '  OK' : '  FAIL'));
      console.log('termrover-attach.log has "stats" line: ' + hasStats + (hasStats ? '  OK' : '  FAIL'));
      if (!hasIn || !hasFrame1 || !hasStats) fail('missing one of in/frame#1/stats diagnostic log lines');

      // No `terminal session control` process left behind, checked within 5s
      // of detach.
      await sleep(5000);
      const psCheck = spawnSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'herdr.exe' -and $_.CommandLine -like '*session*control*' } | Select-Object ProcessId,CommandLine | Format-List"],
        { encoding: 'utf8' });
      const orphanText = (psCheck.stdout || '').trim();
      const noOrphan = orphanText.length === 0;
      console.log('--- orphan check (should be empty) ---\n' + (orphanText || '(none)'));
      console.log('no orphaned "terminal session control" process 5s after detach: ' + noOrphan + (noOrphan ? '  OK' : '  FAIL'));
      if (!noOrphan) fail('orphaned terminal session control process found after detach');

      try { park.close(); } catch (e) {}
      await sleep(500);
      conn.end();
      done(0);
    });
  });
  conn.connect({ host: '127.0.0.1', port: PORT, username: os.userInfo().username, privateKey: fs.readFileSync(key), strictVendor: false });
});
