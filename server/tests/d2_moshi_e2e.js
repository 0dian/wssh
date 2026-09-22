// D2: end-to-end coverage for 20260921-wsshd-moshi-powershell against a
// REAL, already-patched wsshd.js on a TEMPORARY port -- never the production
// instance on 2222. Covers dispatch contract acceptance items 2-6:
//   2. Moshi multiplexer-snapshot probe runs via powershell.exe, exit 0
//   3. Moshi hook probe runs via powershell.exe, exit 0
//   4. Moshi's cmd.exe platform-detect and heartbeat ("true") still exit 0
//      via bash, unaffected
//   5. plain bash regression: `echo hi`, and a multi-line pipe+var script
//   6. TermRover regression: HERDR_SESSION_LIST socket_path rewrite,
//      NC_UNIX -> execToHerdrPipe (hit and refuse), termroverCompat ps
//      replacement
//
// Probe scripts are pulled verbatim from production wsshd.log (same
// technique as tests/b3_e2e.js's cmdOf()), never hand-retyped.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

const USERNAME = os.userInfo().username;
const HERDR = process.env.HERDR_BIN_PATH || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const HERDR_UNIX_NOEXT = '/' + HERDR[0].toLowerCase() + HERDR.slice(2).replace(/\\/g, '/').replace(/\.exe$/i, '');
const herdrList = spawnSync(HERDR, ['session', 'list', '--json'], { encoding: 'utf8' });
let SESSIONS = null;
try { SESSIONS = JSON.parse(herdrList.stdout).sessions; } catch (e) {}
if (!SESSIONS) { console.log('could not fetch real herdr session list: ' + JSON.stringify(herdrList.stdout) + ' ' + JSON.stringify(herdrList.stderr)); process.exit(1); }
const DEFAULT_SOCK = (SESSIONS.find(s => s.name === 'default') || {}).socket_path;
if (!DEFAULT_SOCK) { console.log('no "default" herdr session socket_path found'); process.exit(1); }
console.log('real herdr sessions: ' + JSON.stringify(SESSIONS.map(s => ({ name: s.name, running: s.running }))));

// --- pull the real Moshi probe scripts out of production wsshd.log --------
function cmdOf(line) {
  const s = line.indexOf(' exec ') + 6;
  const e = line.lastIndexOf('"') + 1;
  return JSON.parse(line.slice(s, e));
}
const prodLog = fs.readFileSync(RELAY + '/wsshd.log', 'utf8').split('\n');
const muxLine = [...prodLog].reverse().find(l => l.includes('__MOSHI_MULTIPLEXER_SNAPSHOT_V1__') && l.includes(' exec "'));
const hookLine = [...prodLog].reverse().find(l => l.includes('__MOSHI_HOOK_PROBE_V2__') && l.includes(' exec "'));
if (!muxLine || !hookLine) { console.log('FAIL: could not find Moshi probe lines in wsshd.log'); process.exit(1); }
const MUX_PROBE = cmdOf(muxLine);
const HOOK_PROBE = cmdOf(hookLine);

// --- start a throwaway wsshd on a temp port --------------------------------
const key = path.join(dir, 'd2_client_ed25519');
const hostkey = path.join(dir, 'd2_host_ed25519');
for (const k of [key, hostkey]) {
  if (fs.existsSync(k)) continue;
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('keygen failed: ' + (r.stderr || r.error)); process.exit(1); }
}
const authfile = path.join(dir, 'd2_authorized_keys');
fs.writeFileSync(authfile, fs.readFileSync(key + '.pub'));
const logf = path.join(dir, 'd2_wsshd.log');
try { fs.unlinkSync(logf); } catch (e) {}

const PORT = 2298;
const srv = spawn(process.execPath, [RELAY + '/wsshd.js'], {
  env: Object.assign({}, process.env, {
    WSSHD_PORT: String(PORT), WSSHD_BIND: '127.0.0.1',
    WSSHD_HOSTKEY: hostkey, WSSHD_AUTHKEYS: authfile, WSSHD_LOG: logf,
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

let torndown = false;
function done(code) {
  torndown = true;
  try { srv.kill(); } catch (e) {}
  setTimeout(() => {
    try {
      const l = fs.readFileSync(logf, 'utf8').split('\n').map(s => s.length > 260 ? s.slice(0, 260) + ' ...' : s);
      console.log('--- e2e wsshd log (temp instance, port ' + PORT + ') ---\n' + l.join('\n'));
    } catch (e) {}
    console.log(failures === 0 && code === 0 ? 'D2 OVERALL: OK' : ('D2 OVERALL: FAIL (' + failures + ' failure(s))'));
    process.exit(failures === 0 && code === 0 ? 0 : 1);
  }, 500);
}
setTimeout(() => { ok(false, 'overall timeout'); done(3); }, 60000);

let started = false;
srv.stdout.on('data', d => {
  if (started || !/listening on/.test(String(d))) return;
  started = true;
  console.log('[srv stdout] ' + d);
  const conn = new ssh2.Client();
  conn.on('error', e => {
    if (torndown) return;
    ok(false, 'client error: ' + e.message); done(4);
  });
  conn.on('ready', async () => {
    // --- item 2: Moshi multiplexer-snapshot probe -------------------------
    const mux = await execCmd(conn, MUX_PROBE);
    console.log('--- multiplexer probe stdout ---\n' + mux.stdout);
    console.log('--- multiplexer probe stderr ---\n' + mux.stderr);
    ok(mux.code === 0, '2a. multiplexer probe exit code 0', 'got ' + mux.code);
    ok(mux.stdout.includes('__MOSHI_MULTIPLEXER_SNAPSHOT_V1__\therdr_installed\t1'), '2b. stdout has marker+TAB+herdr_installed+TAB+1');
    ok(/"name":"default"[^}]*"running":true/.test(mux.stdout), '2c. stdout has "name":"default" ... "running":true');
    ok(/"name":"phone"[^}]*"running":true/.test(mux.stdout), '2d. stdout has "name":"phone" ... "running":true');
    ok(/"socket_path":"C:\\\\Users\\\\/.test(mux.stdout), '2e. socket_path in JSON is C:\\\\Users\\\\... form, not /c/...',
      'sample: ' + (mux.stdout.match(/"socket_path":"[^"]*"/) || [])[0]);
    ok(!/"socket_path":"\/c\//.test(mux.stdout), '2f. socket_path is NOT /c/... form');

    // --- item 3: Moshi hook probe ------------------------------------------
    const hook = await execCmd(conn, HOOK_PROBE);
    console.log('--- hook probe stdout ---\n' + hook.stdout);
    console.log('--- hook probe stderr ---\n' + hook.stderr);
    ok(hook.code === 0, '3a. hook probe exit code 0', 'got ' + hook.code);
    ok(hook.stdout.includes('__MOSHI_HOOK_PROBE_V2__') && hook.stdout.includes('missing'), '3b. stdout has marker and "missing"');

    // --- item 4: Moshi's other two commands, unaffected --------------------
    const winDetect = await execCmd(conn, 'cmd.exe /d /s /c "echo __MOSHI_WINDOWS__"');
    ok(winDetect.code === 0 && /__MOSHI_WINDOWS__/.test(winDetect.stdout), '4a. cmd.exe platform-detect exit 0, stdout has marker',
      'code=' + winDetect.code + ' stdout=' + JSON.stringify(winDetect.stdout));
    const heartbeat = await execCmd(conn, 'true');
    ok(heartbeat.code === 0, '4b. "true" heartbeat exit 0', 'got ' + heartbeat.code);

    // --- item 5: bash regression --------------------------------------------
    const echoHi = await execCmd(conn, 'echo hi');
    ok(echoHi.code === 0 && echoHi.stdout.trim() === 'hi', '5a. echo hi -> exit 0, stdout "hi"',
      'code=' + echoHi.code + ' stdout=' + JSON.stringify(echoHi.stdout));
    const multiline = "x=3\necho start | cat\nfor i in 1 2 3; do echo n$i; done\necho \"x=$x\"\n";
    const ml = await execCmd(conn, multiline);
    const mlOk = ml.code === 0 && /^start$/m.test(ml.stdout) && /^n1$/m.test(ml.stdout) && /^n2$/m.test(ml.stdout) && /^n3$/m.test(ml.stdout) && /^x=3$/m.test(ml.stdout);
    ok(mlOk, '5b. multi-line bash script (pipe + var + loop) behaves as a normal bash script',
      'code=' + ml.code + ' stdout=' + JSON.stringify(ml.stdout));

    // --- item 6: TermRover regression ---------------------------------------
    // 6a. HERDR_SESSION_LIST rewrite still fires and rewrites socket_path to
    // MSYS spelling for the real herdr binary invocation TermRover uses.
    const herdrList6 = await execCmd(conn, "'" + HERDR_UNIX_NOEXT + "' session list --json 2>/dev/null");
    console.log('--- 6a herdr session list --json stdout ---\n' + herdrList6.stdout);
    const rewritten = new RegExp('"socket_path":"\\/c\\/users\\/' + USERNAME.toLowerCase(), 'i').test(herdrList6.stdout);
    ok(herdrList6.code === 0 && rewritten, '6a. herdr session list --json: socket_path rewritten to /c/... form (HERDR_SESSION_LIST intact)',
      'code=' + herdrList6.code);

    // 6b. NC_UNIX -> execToHerdrPipe: a real herdr socket is bridged (log
    // line "-> pipe"), a bogus path is refused with exit 1.
    conn.exec("nc -U '" + DEFAULT_SOCK + "'", (err, stream) => {
      if (err) { ok(false, '6b. nc -U <real herdr socket> exec failed: ' + err.message); return afterNc(); }
      let closed = false;
      stream.on('close', () => { closed = true; });
      setTimeout(async () => {
        try { stream.close(); } catch (e) {}
        await sleep(300);
        let log6b = '';
        try { log6b = fs.readFileSync(logf, 'utf8'); } catch (e) {}
        const bridged = /exec nc -U[\s\S]*?-> pipe/.test(log6b);
        console.log('6b bridged=' + bridged);
        ok(bridged, '6b. nc -U <real herdr socket> is bridged by execToHerdrPipe (log has "-> pipe")');
        await afterNc();
      }, 800);
    });

    async function afterNc() {
      const bogusSock = path.join(os.homedir(), 'not-a-herdr-socket', 'herdr.sock');
      const ncBogus = await execCmd(conn, "nc -U '" + bogusSock + "'");
      ok(ncBogus.code === 1, '6c. nc -U <non-herdr path> refused with exit 1', 'got code=' + ncBogus.code);

      // 6d. termroverCompat ps -o ppid= replacement still fires.
      const psCmd = 'tr_child=$$; ps -o ppid= -p "$tr_child"';
      const psRes = await execCmd(conn, psCmd);
      let log6d = '';
      try { log6d = fs.readFileSync(logf, 'utf8'); } catch (e) {}
      const compatLogged = /compat: ps -o ppid= -> msys ps/.test(log6d);
      ok(psRes.code === 0 && compatLogged, '6d. termroverCompat ps -o ppid= -> msys ps still fires (log has "compat: ps -o ppid= -> msys ps")',
        'code=' + psRes.code + ' stdout=' + JSON.stringify(psRes.stdout));

      // --- pipe(powershell) log tag sanity ---------------------------------
      let fullLog = '';
      try { fullLog = fs.readFileSync(logf, 'utf8'); } catch (e) {}
      const hasPsTag = / pipe\(powershell\)/.test(fullLog);
      const hasPlainTag = / pipe$/m.test(fullLog);
      ok(hasPsTag, '7a. log contains " pipe(powershell)" tag for at least one exec');
      ok(hasPlainTag, '7b. log still contains plain " pipe" tag for bash execs');

      conn.end();
      done(0);
    }
  });
  conn.connect({ host: '127.0.0.1', port: PORT, username: USERNAME, privateKey: fs.readFileSync(key), strictVendor: false });
});
