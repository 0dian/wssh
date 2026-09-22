// A4: full end-to-end TermRover fleet attach/detach replay against the REAL,
// already-patched wsshd.js and REAL termrover-attach shim, targeting the
// named herdr session "sbtest" only (never "default").
//
// Exact scripts lifted from production wsshd.log (05:04:39), same as
// e2e4.js, with exactly three substitutions:
//   - tr_dir id: fresh random id (old one is stale)
//   - 'default' -> 'sbtest' (the --session argument)
//   - term id: term_65b3219ef04833 -> the real sbtest pane's terminal_id
// The herdr path is left untouched -- termroverCompat() in the real,
// deployed wsshd.js is what must rewrite it to termrover-attach.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const HERDR_WIN = process.env.HERDR_BIN_PATH || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const HERDR_UNIX_NOEXT = '/' + HERDR_WIN[0].toLowerCase() + HERDR_WIN.slice(2).replace(/\\/g, '/').replace(/\.exe$/i, '');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

const SBTEST_TERM_ID = process.env.SBTEST_TERM_ID;
if (!SBTEST_TERM_ID) { console.log('SBTEST_TERM_ID env var required'); process.exit(1); }

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
// Guard the substitutions: each token must appear exactly once in the source
// before we touch it, so a stray match elsewhere in the script can't corrupt
// something we didn't mean to change.
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
const logf = path.join(dir, 'a4_wsshd.log');
const attachLogf = path.join(dir, 'a4_termrover-attach.log');
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
function fail(msg) { allOk = false; console.log('FAIL: ' + msg); }

function done(code) {
  try { srv.kill(); } catch (e) {}
  setTimeout(() => {
    const clean = parkOut.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[^\x20-\x7e\n]/g, '').trim();
    console.log('--- parking pty output (escape codes stripped) ---\n' + (clean || '(empty)'));
    let alog = '';
    try { alog = fs.readFileSync(attachLogf, 'utf8'); } catch (e) {}
    console.log('--- termrover-attach.log ---\n' + alog);
    try {
      const l = fs.readFileSync(logf, 'utf8').split('\n').map(s => s.length > 220 ? s.slice(0, 220) + ' ...' : s);
      console.log('--- e2e wsshd log ---\n' + l.join('\n'));
    } catch (e) {}
    console.log(allOk && code === 0 ? 'A4 OVERALL: OK' : 'A4 OVERALL: FAIL');
    process.exit(allOk ? 0 : 1);
  }, 800);
}
setTimeout(() => { fail('overall timeout'); done(3); }, 60000);

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
  conn.on('error', e => { fail('client error: ' + e.message); done(4); });
  conn.on('ready', () => {
    conn.exec(PARK, { pty: { rows: 52, cols: 50, term: 'xterm-256color' } }, async (err, park) => {
      if (err) { fail('parking exec failed: ' + err.message); conn.end(); return done(5); }
      park.on('data', b => { parkOut += b; });
      await sleep(2000); // login shell + mkfifo

      const a = await execCmd(conn, ATTACH);
      const attachOk = a.stdout.trim() === 'attached';
      console.log('attach reply (exit ' + a.code + '): [' + a.stdout.trim() + ']' + (attachOk ? '  OK' : '  FAIL'));
      if (!attachOk) fail('attach did not reply "attached"');

      // give the shim's probe + spawn of `terminal session control` + the
      // real herdr client's handshake a moment, then type into the SAME pty
      // (this is TermRover's whole trick: the shim's stdin/stdout are that
      // pty's /dev/tty, so keys typed here reach the real sbtest terminal).
      await sleep(1500);
      const marker = 'echo SHIM%OS%';
      park.write(marker + '\r');
      await sleep(2000);

      // Poll for the resize log line instead of a single fixed sleep: the
      // ConPTY resize -> Windows console notify -> Node 'resize' event chain
      // observed ~1-2s of latency in practice, and a fixed too-short wait
      // raced against it.
      park.setWindow(30, 60, 0, 0); // rows, cols
      let resizeOk = false;
      for (let i = 0; i < 20 && !resizeOk; i++) {
        await sleep(300);
        let alog = '';
        try { alog = fs.readFileSync(attachLogf, 'utf8'); } catch (e) {}
        resizeOk = /resize 60x30/.test(alog);
      }
      console.log('resize logged "resize 60x30": ' + resizeOk + (resizeOk ? '  OK' : '  FAIL'));
      if (!resizeOk) fail('no "resize 60x30" line in termrover-attach.log');

      const dt = await execCmd(conn, DETACH);
      const detachOk = dt.stdout.trim() === 'parked';
      console.log('detach reply (exit ' + dt.code + '): [' + dt.stdout.trim() + ']' + (detachOk ? '  OK' : '  FAIL'));
      if (!detachOk) fail('detach did not reply "parked"');

      const cleanNow = () => parkOut.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[^\x20-\x7e\n]/g, '');
      const echoOk = /SHIMWindows_NT/.test(cleanNow());
      console.log('parking pty shows SHIMWindows_NT (real cmd.exe executed it): ' + echoOk + (echoOk ? '  OK' : '  FAIL'));
      if (!echoOk) fail('SHIMWindows_NT not observed in parking pty output');

      // A4 last requirement: no `terminal session control` process left
      // behind, checked within 5s of detach.
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
