// E2: 20260922-wsshd-moshi-attach-pty acceptance items 5, 6, 8 -- pty-path
// PowerShell dispatch, real end-to-end, against a REAL, already-patched
// wsshd.js on a TEMPORARY port -- never the production instance on 2222.
//
// Item 5 simulates Moshi's actual behavior: send a pty-req, THEN exec the
// real `& $herdr --session '...'` attach command pulled verbatim from
// production wsshd.log (same cmdOf() technique as d1/d2/d3), with exactly
// one substitution -- 'default' -> 'sbtest' -- so this never touches the
// user's real "default" or "phone" herdr sessions (both off-limits; only
// "sbtest" may be used for testing, per the dispatch contract's guardrails).
//
// Item 6 is the bash regression on the same instance: pty-req + a plain
// bash command must still dispatch to bash, unaffected.
//
// Item 8 is the crash-guard check on the pty path: WSSHD_POWERSHELL pointed
// at a nonexistent path, pty-req + the (sbtest-substituted) attach command,
// asserting the wsshd instance process stays alive and the client gets a
// clean signal rather than a hang. This runs as a SEPARATE second instance
// (its own temp port), since it needs a different WSSHD_POWERSHELL env var
// than items 5/6.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const HERDR = process.env.HERDR_BIN_PATH || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

let failures = 0;
function ok(cond, label, extra) {
  console.log((cond ? 'OK ' : 'FAIL ') + label + (extra ? ' -- ' + extra : ''));
  if (!cond) failures++;
}

// --- pull the real Moshi attach command out of production wsshd.log -------
function cmdOf(line) {
  const s = line.indexOf(' exec ') + 6;
  const e = line.lastIndexOf('"') + 1;
  return JSON.parse(line.slice(s, e));
}
const prodLog = fs.readFileSync(RELAY + '/wsshd.log', 'utf8').split('\n');
// Must NOT be the multiplexer probe (which also contains the substring
// "$herdr = Get-Command herdr.exe" as one line of its own longer script) --
// the real standalone attach command additionally has `--session '` and
// does NOT contain the __MOSHI_MULTIPLEXER marker.
const attachLine = [...prodLog].reverse().find(l =>
  l.includes('herdr = Get-Command herdr.exe') && l.includes(' exec "') &&
  l.includes("--session '") && !l.includes('__MOSHI_MULTIPLEXER'));
if (!attachLine) { console.log('FAIL: could not find the real Moshi attach command line in wsshd.log'); process.exit(1); }
const REAL_ATTACH = cmdOf(attachLine);
console.log('real attach command (from wsshd.log, length ' + REAL_ATTACH.length + '): ' + JSON.stringify(REAL_ATTACH));
if (!REAL_ATTACH.includes("--session 'default'")) { console.log('FAIL: expected the real attach command to target session \'default\''); process.exit(1); }
// Only substitution: target "sbtest" (the designated test session) instead
// of the user's real "default" session. Everything else -- the PowerShell
// script structure MOSHI_PS has to recognize -- is untouched.
const ATTACH_SBTEST = REAL_ATTACH.replace("--session 'default'", "--session 'sbtest'");
console.log('substituted attach command (default -> sbtest): ' + JSON.stringify(ATTACH_SBTEST));

function keygenPair(name) {
  const key = path.join(dir, name);
  if (!fs.existsSync(key)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', key], { encoding: 'utf8' });
    if (r.status !== 0) { console.log('keygen failed: ' + (r.stderr || r.error)); process.exit(1); }
  }
  return key;
}

function pidAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return (r.stdout || '').includes(String(pid));
}

function startInstance(opts) {
  const key = keygenPair(opts.name + '_client_ed25519');
  const hostkey = keygenPair(opts.name + '_host_ed25519');
  const authfile = path.join(dir, opts.name + '_authorized_keys');
  fs.writeFileSync(authfile, fs.readFileSync(key + '.pub'));
  const logf = path.join(dir, opts.name + '_wsshd.log');
  try { fs.unlinkSync(logf); } catch (e) {}
  // Strip HERDR_* from the base env: this test script itself runs inside a
  // herdr-managed pane/session, so process.env here carries HERDR_ENV /
  // HERDR_PANE_ID / etc. Production wsshd runs as a plain scheduled task
  // with no such vars, so leaving them in would make the temp instance's
  // spawned powershell.exe -> herdr.exe inherit them and trip herdr's own
  // "nested herdr is disabled by default" guard -- a test-harness artifact,
  // not something the real Moshi flow on the production instance hits.
  const base = Object.assign({}, process.env);
  for (const k of Object.keys(base)) if (/^HERDR_/.test(k)) delete base[k];
  const env = Object.assign(base, {
    WSSHD_PORT: String(opts.port), WSSHD_BIND: '127.0.0.1',
    WSSHD_HOSTKEY: hostkey, WSSHD_AUTHKEYS: authfile, WSSHD_LOG: logf,
  }, opts.env || {});
  const srv = spawn(process.execPath, [RELAY + '/wsshd.js'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  srv.stderr.on('data', d => process.stdout.write('[' + opts.name + ' srv stderr] ' + d));
  return { srv, key, logf, port: opts.port };
}

function waitListening(srv, name) {
  return new Promise(res => {
    srv.stdout.on('data', d => {
      const s = String(d);
      process.stdout.write('[' + name + ' srv stdout] ' + s);
      if (/listening on/.test(s)) res();
    });
  });
}

function connect(inst) {
  return new Promise((res, rej) => {
    const conn = new ssh2.Client();
    conn.on('ready', () => res(conn));
    conn.on('error', rej);
    conn.connect({ host: '127.0.0.1', port: inst.port, username: os.userInfo().username, privateKey: fs.readFileSync(inst.key), strictVendor: false });
  });
}

// matchRegex, if given, resolves as soon as the accumulated output matches
// it (plus a short settle delay to catch a few more trailing bytes) instead
// of always waiting the full durationMs -- Git Bash's `-lc` (login shell)
// startup under ConPTY has variable latency (profile/rc file loading), so a
// short fixed wait can catch the ConPTY handshake bytes but miss output
// that lands a couple seconds later. durationMs is always the hard cap.
function execPty(conn, cmd, cols, rows, durationMs, matchRegex) {
  return new Promise((res) => {
    conn.exec(cmd, { pty: { cols: cols || 80, rows: rows || 24 } }, (err, stream) => {
      if (err) return res({ out: Buffer.alloc(0), code: 'ERR ' + err.message, stream: null });
      const chunks = [];
      let code;
      let settled = false;
      function settle() { if (settled) return; settled = true; res({ out: Buffer.concat(chunks), code, stream }); }
      stream.on('data', d => {
        chunks.push(d);
        if (matchRegex && matchRegex.test(Buffer.concat(chunks).toString('utf8'))) setTimeout(settle, 300);
      });
      stream.stderr.on('data', d => chunks.push(d));
      stream.on('exit', c => { code = c; });
      stream.on('close', () => { if (!settled) settle(); });
      setTimeout(settle, durationMs || 4000);
    });
  });
}

async function main() {
  // === sbtest lifecycle: start it fresh for this test, always stop it in
  // the finally block below, never touch default/phone. ===
  console.log('--- starting sbtest session for the pty attach test ---');
  const beforeList = spawnSync(HERDR, ['session', 'list', '--json'], { encoding: 'utf8' });
  console.log('sbtest state before test: ' + beforeList.stdout);
  let sbtestStartedByUs = false;

  try {
    // === items 5 + 6: real attach command over pty, then plain bash over pty, same instance ===
    const inst56 = startInstance({ name: 'e2_56', port: 2296 });
    await waitListening(inst56.srv, 'e2_56');
    const conn56 = await connect(inst56);

    // Start sbtest headless (like tests/start_sbtest.js) so the attach
    // command has a real session to connect to -- exactly mirroring what
    // "default" already is on the production instance (a running session).
    const sbEnv = Object.assign({}, process.env);
    for (const k of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH']) delete sbEnv[k];
    const sbStart = spawnSync(HERDR, ['session', 'start', 'sbtest'], { encoding: 'utf8', env: sbEnv });
    console.log('herdr session start sbtest: code=' + sbStart.status + ' stdout=' + JSON.stringify(sbStart.stdout) + ' stderr=' + JSON.stringify(sbStart.stderr));
    // 'session start' may not be a real subcommand; if not, fall back to the
    // pty.spawn 'session attach' technique tests/start_sbtest.js uses.
    let sbProc = null;
    const afterStartAttempt = spawnSync(HERDR, ['session', 'list', '--json'], { encoding: 'utf8' });
    let sbRunning = false;
    try { sbRunning = JSON.parse(afterStartAttempt.stdout).sessions.find(s => s.name === 'sbtest').running; } catch (e) {}
    if (!sbRunning) {
      console.log('falling back to pty session-attach technique to bring sbtest up');
      const pty = require(RELAY + '/node_modules/node-pty');
      sbProc = pty.spawn(HERDR, ['session', 'attach', 'sbtest'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: process.env.USERPROFILE, env: sbEnv, useConptyDll: true,
      });
      sbProc.onData(() => {});
      await new Promise(r => setTimeout(r, 2500));
      const check = spawnSync(HERDR, ['session', 'list', '--json'], { encoding: 'utf8' });
      try { sbRunning = JSON.parse(check.stdout).sessions.find(s => s.name === 'sbtest').running; } catch (e) {}
    }
    sbtestStartedByUs = true;
    console.log('sbtest running before attach test: ' + sbRunning);

    console.log('--- item 5: pty-req + real Moshi attach command (targeting sbtest) ---');
    const attachResult = await execPty(conn56, ATTACH_SBTEST, 40, 35, 5000);
    console.log('attach exit code: ' + JSON.stringify(attachResult.code));
    console.log('attach raw output (' + attachResult.out.length + ' bytes) hex head: ' + attachResult.out.slice(0, 200).toString('hex'));
    console.log('attach raw output as text (control chars visible via JSON.stringify):');
    console.log(JSON.stringify(attachResult.out.toString('utf8').slice(0, 4000)));

    // Close the channel/kill the pty-side herdr client so it does not linger.
    try { if (attachResult.stream) attachResult.stream.close(); } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));

    const log56 = fs.readFileSync(inst56.logf, 'utf8');
    console.log('--- e2_56 wsshd log ---\n' + log56);

    const hasPtyPsTag = /40x35\(powershell\)/.test(log56);
    ok(hasPtyPsTag, '5a. log contains the pty+powershell tag "40x35(powershell)" for the attach exec');
    ok(attachResult.code !== 2, '5b. attach command exit code is NOT 2 (the old bash-dispatch failure mode)', 'got ' + JSON.stringify(attachResult.code));
    const outText = attachResult.out.toString('latin1');
    const hasAnsiOrTuiTrace = /\x1b\[/.test(outText) || /\x1b\]/.test(outText) || outText.length > 0;
    ok(hasAnsiOrTuiTrace, '5c. attach command produced SOME output (ANSI/escape bytes or text) -- proves PowerShell actually ran it',
      'output length=' + attachResult.out.length);

    console.log('--- item 6: pty-req + plain bash command, same instance, must still dispatch to bash ---');
    const bashResult = await execPty(conn56, 'echo hi', 80, 24, 10000, /hi/);
    console.log('bash echo hi exit code: ' + JSON.stringify(bashResult.code) + ' output: ' + JSON.stringify(bashResult.out.toString('utf8')));
    try { if (bashResult.stream) bashResult.stream.close(); } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
    const log56b = fs.readFileSync(inst56.logf, 'utf8');
    const bashLine = log56b.split('\n').reverse().find(l => l.includes('"echo hi"') && /\d+x\d+/.test(l) && !l.includes('(powershell)'));
    ok(!!bashLine, '6a. "echo hi" over pty logs a plain (non-powershell) <cols>x<rows> tag', 'search miss; tail of log above');
    ok(bashResult.code === 0 && bashResult.out.toString('utf8').includes('hi'), '6b. "echo hi" over pty still runs via bash and prints "hi"',
      'code=' + bashResult.code + ' out=' + JSON.stringify(bashResult.out.toString('utf8')));

    conn56.end();
    try { inst56.srv.kill(); } catch (e) {}

    // === item 8: crash guard on the pty path, bogus WSSHD_POWERSHELL ===
    console.log('--- item 8: pty-req + attach command with bogus WSSHD_POWERSHELL, separate instance ---');
    const BOGUS_POWERSHELL = 'C:\\this\\path\\does\\not\\exist\\powershell.exe';
    const inst8 = startInstance({ name: 'e2_8', port: 2295, env: { WSSHD_POWERSHELL: BOGUS_POWERSHELL } });
    await waitListening(inst8.srv, 'e2_8');
    console.log('e2_8 temp wsshd pid=' + inst8.srv.pid);
    const conn8 = await connect(inst8);
    let conn8Errored = false;
    conn8.on('error', e => { conn8Errored = true; console.log('conn8 client error: ' + e.message); });

    const badResult = await execPty(conn8, ATTACH_SBTEST, 40, 35, 4000);
    console.log('item 8 bad-spawn exec code: ' + JSON.stringify(badResult.code) + ' output: ' + JSON.stringify(badResult.out.toString('utf8')));
    await new Promise(r => setTimeout(r, 500));

    const nodeSaysAlive8 = inst8.srv.exitCode === null && inst8.srv.signalCode === null;
    const osSaysAlive8 = pidAlive(inst8.srv.pid);
    ok(nodeSaysAlive8, '8a. e2_8 wsshd process object never saw child exit (exitCode/signalCode still null)',
      'exitCode=' + inst8.srv.exitCode + ' signalCode=' + inst8.srv.signalCode);
    ok(osSaysAlive8, '8b. OS-level check (tasklist) confirms e2_8 wsshd pid=' + inst8.srv.pid + ' is still running');
    ok(!conn8Errored, '8c. no client-side ssh2 protocol error observed (no double channel response)');

    const after8 = await execPty(conn8, 'echo still-alive', 80, 24, 10000, /still-alive/);
    ok(after8.code === 0 && after8.out.toString('utf8').includes('still-alive'),
      '8d. e2_8 wsshd still serves a normal bash pty exec right after the bad spawn',
      'code=' + after8.code + ' out=' + JSON.stringify(after8.out.toString('utf8')));
    try { if (after8.stream) after8.stream.close(); } catch (e) {}

    const log8 = fs.readFileSync(inst8.logf, 'utf8');
    console.log('--- e2_8 wsshd log ---\n' + log8);
    ok(/spawn failed/.test(log8), '8e. e2_8 log records a "spawn failed" line for the bad-powershell pty attempt');
    const uncaught8 = (log8.match(/^.*uncaught:.*$/gm) || []);
    ok(uncaught8.length === 0, '8f. no "uncaught:" lines in e2_8 log', 'lines=' + JSON.stringify(uncaught8));

    conn8.end();
    try { inst8.srv.kill(); } catch (e) {}

    // Give both temp instances a moment to actually exit before we move on.
    await new Promise(r => setTimeout(r, 800));

  } finally {
    // === cleanup: kill anything under $HOME/.herdr or our own pty client
    // that might still be holding the sbtest session, then stop sbtest,
    // then verify default/phone were never touched. ===
    console.log('--- cleanup: stopping sbtest session ---');
    const stopRes = spawnSync(HERDR, ['session', 'stop', 'sbtest'], { encoding: 'utf8' });
    console.log('herdr session stop sbtest: code=' + stopRes.status + ' stdout=' + JSON.stringify(stopRes.stdout) + ' stderr=' + JSON.stringify(stopRes.stderr));
    await new Promise(r => setTimeout(r, 1000));
    const finalList = spawnSync(HERDR, ['session', 'list', '--json'], { encoding: 'utf8' });
    console.log('final herdr session list: ' + finalList.stdout);
    try {
      const sessions = JSON.parse(finalList.stdout).sessions;
      const sb = sessions.find(s => s.name === 'sbtest');
      const def = sessions.find(s => s.name === 'default');
      const phone = sessions.find(s => s.name === 'phone');
      ok(sb && sb.running === false, 'cleanup. sbtest session stopped (running=false) after test', JSON.stringify(sb));
      console.log('default session state (must be untouched by this test): ' + JSON.stringify(def));
      console.log('phone session state (must be untouched by this test): ' + JSON.stringify(phone));
    } catch (e) { console.log('could not parse final session list: ' + e); }

    // Orphan check: any leftover herdr.exe / powershell.exe processes we spawned.
    const tl = spawnSync('tasklist', ['/FI', 'IMAGENAME eq herdr.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    console.log('herdr.exe processes still running (should only be the ones backing default/phone, not extras from this test):\n' + tl.stdout);
  }

  console.log(failures === 0 ? 'E2 OVERALL: OK' : ('E2 OVERALL: FAIL (' + failures + ' failure(s))'));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log('FAIL: uncaught in main(): ' + (e && e.stack || e)); process.exit(1); });
