// F1: end-to-end coverage for 20261005-wsshd-exec-tree-kill against a REAL,
// already-patched wsshd.js on a TEMPORARY port (2296, loopback only) -- never
// the production instance on 2222.
//
// The bug: a pipe-mode exec that is still running when the client goes away
// (channel closed, or the whole connection dropped) was only "killed" via
// child.kill(), which on Windows ends just the Git for Windows launcher
// (bin\bash.exe). Its descendants (usr\bin\bash.exe, the command itself) kept
// running as orphans. The fix is taskkill /T on the launcher.
//
// The decisive check is NOT "the log says channel closed" (it said that while
// the orphans were alive): from the test wsshd's own pid we walk
// ParentProcessId links downwards, snapshot EVERY descendant (pid + creation
// time, so a recycled pid is never mistaken for the old process), close the
// channel / connection, and then require all of them to be gone within 5 s.
//
//   1. native exe left behind:  `ping -n 600 127.0.0.1`, stream.close()
//   2. MSYS program left behind: `sleep 600`, stream.close()
//   3. whole connection dropped: `ping -n 600 127.0.0.1`, conn.end()
//      (3b: same, but conn.destroy() = socket torn down without a goodbye)
//   4. other sessions untouched: A and B running, close A -> only A's tree
//      gone, B's still fully alive; then close B -> B gone too
//   5. normal exit regression:   `echo hi`, `exit 3`, `printf abc | cat`
//      with client stdin, `cat` fed through client stdin
//   6. normal exit never reaches killTree: the wsshd log segment written
//      during (5) has no "taskkill failed" line and no "channel closed" line
//      for the case-5 commands
//   7. channel closed between the direct child's 'exit' and 'close': bash is
//      made to exit at once (`sleep 37 & read x`, client sends EOF) while the
//      backgrounded sleep keeps stdout open; once the launcher pid is gone the
//      channel is closed. Its pid may already be recycled, so killTree() must
//      NOT call taskkill: no "taskkill failed" log line for that command, and
//      its "channel closed" line is there. (The background sleep ends by itself
//      after 37 s; it is not part of any snapshot and is not cleaned up.)
//   INFO: pty path (runInPty / node-pty) is only MEASURED, never counted in
//      `failures` and never modified here: pty-req + `sleep 600`, close the
//      channel, report how many snapshot pids are still alive after 5 s.
//
// At the end the test wsshd is killed and every snapshot pid is checked once
// more; leftovers are printed, count as FAIL (pty-path ones are INFO only) and
// are then terminated by pid -- only pids this test itself saw being started.
//
// Windows-only (needs Get-CimInstance, taskkill, Git Bash as wsshd's shell).
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const ssh2 = require(RELAY + '/deps/node_modules/ssh2');
const dir = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(dir, { recursive: true });

const USERNAME = os.userInfo().username;
const SYSROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const POWERSHELL = path.join(SYSROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TASKKILL = path.join(SYSROOT, 'System32', 'taskkill.exe');
const PORT = 2296;
const GONE_WITHIN_MS = 5000;

// --- throwaway wsshd on a temp port ----------------------------------------
const key = path.join(dir, 'f1_client_ed25519');
const hostkey = path.join(dir, 'f1_host_ed25519');
for (const k of [key, hostkey]) {
  if (fs.existsSync(k)) continue;
  const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', k], { encoding: 'utf8' });
  if (r.status !== 0) { console.log('keygen failed: ' + (r.stderr || r.error)); process.exit(1); }
}
const authfile = path.join(dir, 'f1_authorized_keys');
fs.writeFileSync(authfile, fs.readFileSync(key + '.pub'));
const logf = path.join(dir, 'f1_wsshd.log');
try { fs.unlinkSync(logf); } catch (e) {}

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + ' ...' : s);

// --- process table ----------------------------------------------------------
// pid | ppid | creation ticks | name | command line, one line per process.
// Passed as -EncodedCommand (base64 UTF-16LE) so no quoting layer can mangle it.
const PS_TABLE = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  "$c = ''; if ($_.CreationDate) { $c = $_.CreationDate.Ticks }; " +
  "'{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, $_.ParentProcessId, $c, $_.Name, " +
  "(([string]$_.CommandLine) -replace '\\s+', ' ') }";
const PS_ENCODED = Buffer.from(PS_TABLE, 'utf16le').toString('base64');

function procTable() {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', PS_ENCODED],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) return reject(new Error('process table query failed: ' + err.message + ' ' + stderr));
        const table = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^(\d+)\|(\d+)\|(\d*)\|([^|]*)\|(.*)$/.exec(line);
          if (m) table.set(+m[1], { pid: +m[1], ppid: +m[2], created: m[3], name: m[4], cmd: m[5] });
        }
        if (table.size < 10) return reject(new Error('process table suspiciously small (' + table.size + '): ' + trunc(stdout, 200)));
        resolve(table);
      });
  });
}
const keyOf = e => e.pid + ':' + e.created;
const stamp = e => e.pid + ' ' + e.name + ' [' + trunc(e.cmd, 70) + ']';

// Every descendant of rootPid (root itself excluded). A child only counts if it
// was created after its parent: a stale ParentProcessId pointing at a recycled
// pid must not drag unrelated processes into the walk.
function descendants(table, rootPid) {
  const out = [], seen = new Set([rootPid]), queue = [table.get(rootPid)].filter(Boolean);
  while (queue.length) {
    const parent = queue.shift();
    for (const e of table.values()) {
      if (e.ppid !== parent.pid || seen.has(e.pid)) continue;
      if (e.created && parent.created && BigInt(e.created) < BigInt(parent.created)) continue;
      seen.add(e.pid); out.push(e); queue.push(e);
    }
  }
  return out;
}

async function baselineKeys() {
  return new Set(descendants(await procTable(), srv.pid).map(keyOf));
}

// Wait until the tree of the command we just started is fully up: at least
// minCount new descendants of srv and one of them satisfies isLeaf (the
// command's own program).
async function snapshotTree(baseline, isLeaf, minCount) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const fresh = descendants(await procTable(), srv.pid).filter(e => !baseline.has(keyOf(e)));
    if (fresh.length >= minCount && fresh.some(isLeaf)) return fresh;
    await sleep(250);
  }
  return null;
}

// Entries (pid + creation time) that are still alive according to the process
// table -- a recycled pid has a different creation time and does not count.
async function aliveOf(entries) {
  const table = await procTable();
  return entries.filter(e => { const cur = table.get(e.pid); return cur && cur.created === e.created; });
}

// Poll cheaply (process.kill(pid, 0): only ESRCH means "gone") for up to
// GONE_WITHIN_MS after closeAt. At the deadline confirm with the authoritative
// table, so a pid recycled by an unrelated process cannot produce a false FAIL.
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function waitGone(entries, closeAt, limitMs) {
  limitMs = limitMs || GONE_WITHIN_MS;
  while (Date.now() - closeAt < limitMs) {
    if (!entries.some(e => pidAlive(e.pid))) return { survivors: [], ms: Date.now() - closeAt };
    await sleep(100);
  }
  return { survivors: await aliveOf(entries), ms: Date.now() - closeAt };
}

// --- ssh2 helpers -----------------------------------------------------------
function connect() {
  return new Promise((resolve, reject) => {
    const c = new ssh2.Client();
    c.on('ready', () => resolve(c));
    c.on('error', e => reject(e));
    c.connect({ host: '127.0.0.1', port: PORT, username: USERNAME, privateKey: fs.readFileSync(key), strictVendor: false });
  });
}
function execLong(conn, cmd, opts) {
  return new Promise((resolve, reject) => conn.exec(cmd, opts || {}, (err, stream) => {
    if (err) return reject(err);
    stream.on('data', () => {});
    stream.stderr.on('data', () => {});
    resolve(stream);
  }));
}
function execCmd(conn, cmd, stdin) {
  const run = new Promise(res => conn.exec(cmd, (err, stream) => {
    if (err) return res({ stdout: '', stderr: '', code: 'ERR ' + err.message });
    let out = '', errOut = '', code;
    stream.on('data', d => { out += d; });
    stream.stderr.on('data', d => { errOut += d; });
    stream.on('exit', c => { code = c; });
    stream.on('close', () => res({ stdout: out, stderr: errOut, code }));
    if (stdin !== undefined) stream.end(stdin);
  }));
  return Promise.race([run, sleep(20000).then(() => ({ stdout: '', stderr: '', code: 'TIMEOUT' }))]);
}

// Every snapshot taken for cases 1-4 / pty, kept for the final residual check.
const killSnaps = [];
let ptySnap = [];

function report(label, snap, r) {
  ok(r.survivors.length === 0, label,
    r.survivors.length === 0
      ? snap.length + ' pids (' + snap.map(e => e.name).join(',') + ') all gone after ' + r.ms + ' ms'
      : r.survivors.length + '/' + snap.length + ' still alive after ' + GONE_WITHIN_MS + ' ms: ' + r.survivors.map(stamp).join(' ; '));
}

// Cases 1-3: one connection, one long command, close it one way or the other.
async function killCase(label, cmd, isLeaf, how) {
  const conn = await connect();
  try {
    const baseline = await baselineKeys();
    const stream = await execLong(conn, cmd);
    const snap = await snapshotTree(baseline, isLeaf, 2);
    if (!snap) return ok(false, label, 'process tree for ' + JSON.stringify(cmd) + ' never showed up under wsshd pid ' + srv.pid);
    killSnaps.push(...snap);
    const closeAt = Date.now();
    if (how === 'stream') stream.close();
    else if (how === 'end') conn.end();
    else conn.destroy();
    report(label, snap, await waitGone(snap, closeAt));
  } finally { try { conn.end(); } catch (e) {} }
}

async function main() {
  const PING = e => /^ping\.exe$/i.test(e.name), SLEEP = e => /^sleep\.exe$/i.test(e.name);

  await killCase('1. native exe (ping.exe): stream.close() takes the whole tree down', 'ping -n 600 127.0.0.1', PING, 'stream');
  await killCase('2. MSYS program (sleep): stream.close() takes the whole tree down', 'sleep 600', SLEEP, 'stream');
  await killCase('3. connection dropped (conn.end()): the whole tree goes', 'ping -n 600 127.0.0.1', PING, 'end');
  await killCase('3b. socket destroyed (conn.destroy()): the whole tree goes', 'ping -n 600 127.0.0.1', PING, 'destroy');

  // --- 4. another session must be left alone -------------------------------
  {
    const connA = await connect(), connB = await connect();
    try {
      const baseA = await baselineKeys();
      const streamA = await execLong(connA, 'ping -n 600 127.0.0.1');
      const snapA = await snapshotTree(baseA, PING, 2);
      if (!snapA) { ok(false, '4. session A tree never showed up'); }
      else {
        killSnaps.push(...snapA);
        const baseB = new Set([...baseA, ...snapA.map(keyOf)]);
        const streamB = await execLong(connB, 'sleep 600');
        const snapB = await snapshotTree(baseB, SLEEP, 2);
        if (!snapB) { ok(false, '4. session B tree never showed up'); }
        else {
          killSnaps.push(...snapB);
          const closeA = Date.now();
          streamA.close();
          report('4a. closing session A takes all of A\'s tree down', snapA, await waitGone(snapA, closeA));
          const bAlive = await aliveOf(snapB);
          ok(bAlive.length === snapB.length, '4b. session B untouched while A was closed',
            bAlive.length + '/' + snapB.length + ' of B\'s pids alive: ' + snapB.map(e => e.pid + (bAlive.includes(e) ? '+' : '-')).join(' '));
          const closeB = Date.now();
          streamB.close();
          report('4c. closing session B then takes all of B\'s tree down', snapB, await waitGone(snapB, closeB));
        }
      }
    } finally { try { connA.end(); } catch (e) {} try { connB.end(); } catch (e) {} }
  }

  // --- 5. normal exits are unaffected --------------------------------------
  const logBefore5 = fs.existsSync(logf) ? fs.statSync(logf).size : 0;
  const case5 = ['echo hi', 'exit 3', 'printf abc | cat', 'cat'];
  {
    const conn = await connect();
    try {
      const r1 = await execCmd(conn, case5[0]);
      ok(r1.code === 0 && r1.stdout === 'hi\n', '5a. `echo hi` -> stdout exactly "hi\\n", exit 0',
        'code=' + r1.code + ' stdout=' + JSON.stringify(r1.stdout) + ' stderr=' + JSON.stringify(r1.stderr));
      const r2 = await execCmd(conn, case5[1]);
      ok(r2.code === 3, '5b. `exit 3` -> exit code 3', 'code=' + r2.code);
      const r3 = await execCmd(conn, case5[2], 'abc');
      ok(r3.code === 0 && r3.stdout === 'abc', '5c. `printf abc | cat` with client stdin "abc"+EOF -> stdout "abc", exit 0',
        'code=' + r3.code + ' stdout=' + JSON.stringify(r3.stdout));
      const r4 = await execCmd(conn, case5[3], 'abc');
      ok(r4.code === 0 && r4.stdout === 'abc', '5d. `cat` fed "abc"+EOF through client stdin -> stdout "abc", exit 0',
        'code=' + r4.code + ' stdout=' + JSON.stringify(r4.stdout));
    } finally { try { conn.end(); } catch (e) {} }
  }

  // --- 6. normal exits never reach killTree --------------------------------
  await sleep(700);
  {
    const full = fs.readFileSync(logf);
    const seg = full.slice(logBefore5).toString('utf8').split('\n');
    const tkLines = seg.filter(l => /taskkill failed/.test(l));
    ok(tkLines.length === 0, '6a. no "taskkill failed" line in the wsshd log while case 5 ran',
      tkLines.length ? tkLines.map(l => trunc(l, 200)).join(' | ') : 'segment had ' + seg.filter(Boolean).length + ' lines');
    const closedLines = seg.filter(l => / channel closed/.test(l) && case5.some(c => l.includes(' exec ' + JSON.stringify(c) + ' ')));
    ok(closedLines.length === 0, '6b. no "channel closed" line for any case-5 command (they finished, not killed)',
      closedLines.length ? closedLines.map(l => trunc(l, 200)).join(' | ') : 'none');
    const all = full.toString('utf8').split('\n');
    console.log('INFO whole-run "taskkill failed" lines in wsshd log: ' + all.filter(l => /taskkill failed/.test(l)).length +
      ', "channel closed" lines: ' + all.filter(l => / channel closed/.test(l)).length);
  }

  // --- 7. channel closed after the direct child exited, before 'close' -----
  // `sleep 37 & read x`: bash blocks on stdin until the client sends EOF, then
  // exits at once while the backgrounded sleep keeps the inherited stdout open
  // -- so wsshd has seen the launcher's 'exit' but not its 'close'. Closing the
  // channel now must not run taskkill against the dead (maybe recycled) pid.
  // The background sleep is NOT reachable from wsshd by walking ParentProcessId
  // (MSYS fork leaves a dead intermediate parent), so it is found by its own
  // command line (`sleep.exe 37`, newer than anything present beforehand).
  {
    const cmd7 = 'sleep 37 & read x';
    const tag7 = ' exec ' + JSON.stringify(cmd7) + ' ';
    const isBg = e => /^sleep\.exe$/i.test(e.name) && /\b37\b/.test(e.cmd);
    const conn = await connect();
    try {
      const stale = new Set([...(await procTable()).values()].filter(isBg).map(keyOf));
      const logBefore7 = fs.statSync(logf).size;
      const stream = await execLong(conn, cmd7);
      let launcher, bg;
      for (const deadline = Date.now() + 25000; Date.now() < deadline && !(launcher && bg); ) {
        const all = [...(await procTable()).values()];
        launcher = all.find(e => e.ppid === srv.pid && /^bash\.exe$/i.test(e.name) && e.cmd.includes(cmd7));
        bg = all.find(e => isBg(e) && !stale.has(keyOf(e)));
        if (!(launcher && bg)) await sleep(250);
      }
      if (!launcher || !bg) ok(false, '7a. launcher and background sleep for ' + JSON.stringify(cmd7) + ' never both showed up',
        'launcher=' + (launcher ? launcher.pid : 'none') + ' background sleep=' + (bg ? bg.pid : 'none'));
      else {
        stream.end();                                  // EOF on stdin -> `read x` returns -> bash exits
        const g = await waitGone([launcher], Date.now(), 10000);
        const bgAlive = (await aliveOf([bg])).length === 1;
        ok(g.survivors.length === 0 && bgAlive, '7a. launcher exited while the background sleep still holds stdout open (channel still open)',
          'launcher pid ' + launcher.pid + (g.survivors.length ? ' still alive after 10 s' : ' gone after ' + g.ms + ' ms') + ', background sleep pid ' + bg.pid + (bgAlive ? ' alive' : ' ALREADY GONE'));
        stream.close();
        await sleep(1500);                             // taskkill, if wrongly called, fails asynchronously
        const seg7 = fs.readFileSync(logf).slice(logBefore7).toString('utf8').split('\n').filter(l => l.includes(tag7));
        const tk7 = seg7.filter(l => /taskkill failed/.test(l));
        const closed7 = seg7.filter(l => / channel closed/.test(l));
        ok(tk7.length === 0, '7b. no "taskkill failed" log line for the command (taskkill never run on the exited launcher pid)',
          tk7.length ? tk7.map(l => trunc(l, 240)).join(' | ') : 'lines for this command: ' + seg7.length);
        ok(closed7.length === 1, '7c. "channel closed" log line present for the command', closed7.length + ' line(s): ' + closed7.map(l => trunc(l, 160)).join(' | '));
      }
    } finally { try { conn.end(); } catch (e) {} }
  }

  // --- INFO: pty path, measure only ---------------------------------------
  {
    const conn = await connect();
    try {
      const baseline = await baselineKeys();
      const stream = await execLong(conn, 'sleep 600', { pty: true });
      const snap = await snapshotTree(baseline, SLEEP, 1);
      if (!snap) console.log('INFO pty-path: sleep tree never showed up under wsshd pid ' + srv.pid + ', nothing to measure');
      else {
        ptySnap = snap;
        console.log('INFO pty-path snapshot: ' + snap.map(stamp).join(' ; '));
        const closeAt = Date.now();
        stream.close();
        await sleep(GONE_WITHIN_MS);
        const left = await aliveOf(snap);
        console.log('INFO pty-path survivors=' + left.length + (left.length ? ' ' + left.map(e => e.pid).join(',') : ''));
        if (left.length) console.log('INFO pty-path survivor detail: ' + left.map(stamp).join(' ; '));
      }
    } finally { try { conn.end(); } catch (e) {} }
  }
}

// --- teardown: kill the test wsshd, then audit every snapshot pid ----------
let tornDown = false;
async function finish(code) {
  if (tornDown) return;
  tornDown = true;
  try { srv.kill(); } catch (e) {}
  await sleep(1500);
  try {
    // pty-path pids are measured, not asserted: not part of this FAIL check.
    const ptyKeys = new Set(ptySnap.map(keyOf));
    const seen = new Set();
    const killSet = killSnaps.filter(e => !ptyKeys.has(keyOf(e)) && !seen.has(keyOf(e)) && seen.add(keyOf(e)));
    const leftover = await aliveOf(killSet);
    ok(leftover.length === 0, 'residual check: no snapshot pid from cases 1-4 survives wsshd shutdown',
      leftover.length ? leftover.length + '/' + killSet.length + ' alive: ' + leftover.map(stamp).join(' ; ') : killSet.length + ' pids checked');
    const ptyLeft = await aliveOf(ptySnap);
    const toKill = leftover.concat(ptyLeft);
    if (toKill.length) {
      // only pids this test saw being started, identity (creation time) re-checked just above
      const args = ['/F'];
      for (const e of toKill) args.push('/PID', String(e.pid));
      await new Promise(r => execFile(TASKKILL, args, { windowsHide: true }, err => {
        console.log('cleanup: taskkill ' + args.join(' ') + ' -> ' + (err ? 'exit ' + err.code : 'ok'));
        r();
      }));
      await sleep(800);
      const still = await aliveOf(toKill);
      console.log('cleanup: ' + still.length + ' of ' + toKill.length + ' leftover pid(s) still alive after taskkill' + (still.length ? ': ' + still.map(stamp).join(' ; ') : ''));
    }
  } catch (e) { ok(false, 'residual check threw: ' + (e && e.stack || e)); }
  try {
    const l = fs.readFileSync(logf, 'utf8').split('\n').map(s => trunc(s, 260));
    console.log('--- e2e wsshd log (temp instance, port ' + PORT + ') ---\n' + l.join('\n'));
  } catch (e) {}
  console.log('failures === ' + failures);
  console.log(failures === 0 && code === 0 ? 'F1 OVERALL: OK' : ('F1 OVERALL: FAIL (' + failures + ' failure(s))'));
  process.exit(failures === 0 && code === 0 ? 0 : 1);
}

const overall = setTimeout(() => { ok(false, 'overall timeout'); finish(3); }, 300000);
process.on('uncaughtException', e => { ok(false, 'uncaught: ' + (e && e.stack || e)); finish(5); });

let started = false;
srv.stdout.on('data', d => {
  if (started || !/listening on/.test(String(d))) return;
  started = true;
  console.log('[srv stdout] ' + String(d).trim());
  main().then(() => finish(0), e => { ok(false, 'test aborted: ' + (e && e.stack || e)); finish(4); }).then(() => clearTimeout(overall));
});
srv.on('exit', c => { if (!started && !tornDown) { ok(false, 'test wsshd exited before listening (code ' + c + ')'); finish(2); } });
