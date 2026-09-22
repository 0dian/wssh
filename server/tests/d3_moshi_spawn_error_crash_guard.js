// D3: 20260921-wsshd-moshi-powershell round 2 -- crash-guard regression.
//
// runInPipes() spawns powershell.exe (Moshi probes) or bash.exe (everything
// else). child_process.spawn() does not throw synchronously for a failure
// that only shows up once libuv actually tries to launch the executable
// (ENOENT, EACCES, ...) -- that surfaces as an async 'error' event instead.
// Before this round, nothing listened for it: an EventEmitter 'error' with
// no listener either crashes the process (if nothing else catches it) or,
// worse, leaves the exec channel with no response ever sent to the client
// (hung forever) even where wsshd.js's global uncaughtException handler
// happens to swallow the throw. Either way every OTHER SSH client on this
// wsshd (not just the one that triggered the bad spawn) is at risk.
//
// This test reproduces the failure deterministically by pointing
// WSSHD_POWERSHELL at a path that does not exist, on a TEMPORARY port --
// never touches the production instance on 2222 (PID checked before/after).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

function cmdOf(line) {
  const s = line.indexOf(' exec ') + 6;
  const e = line.lastIndexOf('"') + 1;
  return JSON.parse(line.slice(s, e));
}
const prodLog = fs.readFileSync(RELAY + '/wsshd.log', 'utf8').split('\n');
const muxLine = [...prodLog].reverse().find(l => l.includes('__MOSHI_MULTIPLEXER_SNAPSHOT_V1__') && l.includes(' exec "'));
if (!muxLine) { console.log('FAIL: could not find Moshi multiplexer probe line in wsshd.log'); process.exit(1); }
const MUX_PROBE = cmdOf(muxLine);

const key = path.join(dir, 'd3_client_ed25519');
const hostkey = path.join(dir, 'd3_host_ed25519');
for (const k of [key, hostkey]) {
  if (fs.existsSync(k)) continue;
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('keygen failed: ' + (r.stderr || r.error)); process.exit(1); }
}
const authfile = path.join(dir, 'd3_authorized_keys');
fs.writeFileSync(authfile, fs.readFileSync(key + '.pub'));
const logf = path.join(dir, 'd3_wsshd.log');
try { fs.unlinkSync(logf); } catch (e) {}

const PORT = 2297;
const BOGUS_POWERSHELL = 'C:\\this\\path\\does\\not\\exist\\powershell.exe';
const srv = spawn(process.execPath, [RELAY + '/wsshd.js'], {
  env: Object.assign({}, process.env, {
    WSSHD_PORT: String(PORT), WSSHD_BIND: '127.0.0.1',
    WSSHD_HOSTKEY: hostkey, WSSHD_AUTHKEYS: authfile, WSSHD_LOG: logf,
    WSSHD_POWERSHELL: BOGUS_POWERSHELL,
  }),
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
srv.stderr.on('data', d => process.stdout.write('[srv stderr] ' + d));

let failures = 0;
function ok(cond, label, extra) {
  console.log((cond ? 'OK ' : 'FAIL ') + label + (extra ? ' -- ' + extra : ''));
  if (!cond) failures++;
}
function execCmd(conn, cmd) {
  return new Promise(res => conn.exec(cmd, (err, stream) => {
    if (err) return res({ stdout: '', stderr: '', code: 'ERR ' + err.message });
    let out = '', errOut = '', code;
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', d => { errOut += d; });
    stream.on('exit', c => { code = c; });
    stream.on('close', () => res({ stdout: out, stderr: errOut, code }));
  }));
}
function pidAlive(pid) {
  // Independent-of-Node OS-level check: Windows tasklist, not srv.exitCode
  // (which only reflects what THIS process's child_process bookkeeping
  // believes -- checking via a separate OS query is the stronger claim
  // "the process is actually still running" the contract asked for).
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return (r.stdout || '').includes(String(pid));
}

let torndown = false;
let clientErrored = false;
function done(code) {
  torndown = true;
  try { srv.kill(); } catch (e) {}
  setTimeout(() => {
    let l = '';
    try { l = fs.readFileSync(logf, 'utf8'); } catch (e) {}
    console.log('--- e2e wsshd log (temp instance, port ' + PORT + ') ---\n' + l);
    console.log(failures === 0 && code === 0 ? 'D3 OVERALL: OK' : ('D3 OVERALL: FAIL (' + failures + ' failure(s))'));
    process.exit(failures === 0 && code === 0 ? 0 : 1);
  }, 500);
}
setTimeout(() => { ok(false, 'overall timeout'); done(3); }, 60000);

let started = false;
srv.stdout.on('data', async d => {
  if (started || !/listening on/.test(String(d))) return;
  started = true;
  console.log('[srv stdout] ' + d);
  console.log('temp wsshd pid=' + srv.pid);

  const conn = new ssh2.Client();
  conn.on('error', e => {
    // A double response to the same ssh2 channel (e.g. exit()/end() called
    // twice) surfaces on the CLIENT side as a protocol-level error here --
    // that is what item 3 (channel responded to exactly once) is checking
    // for, in addition to grepping the server log.
    clientErrored = true;
    ok(false, 'client-side connection error (would indicate a double channel response / ssh2 protocol violation): ' + e.message);
    if (!torndown) done(4);
  });
  conn.on('ready', async () => {
    // --- item 2: the bad-spawn exec must fail cleanly, not hang ----------
    const bad = await execCmd(conn, MUX_PROBE);
    console.log('--- bad-spawn exec stdout ---\n' + bad.stdout);
    console.log('--- bad-spawn exec stderr ---\n' + bad.stderr);
    ok(bad.code !== 0 && bad.code !== 'ERR' && typeof bad.code === 'number',
      '2a. Moshi probe with bogus WSSHD_POWERSHELL returns a non-zero exit code (client gets a clean failure, not a hang)',
      'code=' + JSON.stringify(bad.code));
    ok(/spawn error/.test(bad.stderr), '2b. stderr tells the client this was a spawn error', 'stderr=' + JSON.stringify(bad.stderr));

    // --- item 2: the wsshd process itself must still be alive ------------
    await new Promise(r => setTimeout(r, 500));
    const nodeSaysAlive = srv.exitCode === null && srv.signalCode === null;
    const osSaysAlive = pidAlive(srv.pid);
    ok(nodeSaysAlive, '2c. srv.exitCode/signalCode still null (Node process object never saw child exit)',
      'exitCode=' + srv.exitCode + ' signalCode=' + srv.signalCode);
    ok(osSaysAlive, '2d. OS-level check (tasklist) confirms pid=' + srv.pid + ' is still a running process');

    // --- item 2: the wsshd process must still serve OTHER commands -------
    const after = await execCmd(conn, 'echo hi');
    ok(after.code === 0 && after.stdout.trim() === 'hi',
      '2e. a normal bash exec (echo hi) right after the bad spawn still works (exit 0, stdout "hi")',
      'code=' + after.code + ' stdout=' + JSON.stringify(after.stdout));

    // --- item 3: channel responded to exactly once ------------------------
    // No client-side conn 'error' event fired (checked above via the
    // listener, asserted here after the round-trip has had time to surface
    // one), and the server log shows exactly one spawn-error line for the
    // bad exec, not a channel-closed-twice symptom.
    await new Promise(r => setTimeout(r, 300));
    ok(!clientErrored, '3a. no client-side connection error observed (no double channel response detected by ssh2)');
    let logText = '';
    try { logText = fs.readFileSync(logf, 'utf8'); } catch (e) {}
    const spawnErrorLines = (logText.match(/spawn error/g) || []).length;
    const uncaughtLines = (logText.match(/^.*uncaught:.*$/gm) || []);
    ok(spawnErrorLines === 1, '3b. exactly one "spawn error" log line for the one bad exec', 'count=' + spawnErrorLines);
    ok(uncaughtLines.length === 0, '3c. no "uncaught:" lines in the log (global uncaughtException handler never had to catch anything)',
      'lines=' + JSON.stringify(uncaughtLines));

    conn.end();
    done(0);
  });
  conn.connect({ host: '127.0.0.1', port: PORT, username: os.userInfo().username, privateKey: fs.readFileSync(key), strictVendor: false });
});
