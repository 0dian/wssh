// A2: HERDR_REAL points at a fake herdr that reports the probe target "not
// found" (ordinary failure, no "not supported on windows" text) and, for a
// real attach, prints OFFICIAL_ATTACH_OK and exits 7. termrover-attach must
// classify this as official support and exec straight through to it.
//
// Compiled test fixtures, generated keys and logs live under the system temp
// dir (see TMPDIR below), not in this tests/ directory -- only the test
// scripts themselves belong here.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const BASH = 'D:\\Program Files\\Git\\bin\\bash.exe';
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const dir = __dirname;
const TMPDIR = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(TMPDIR, { recursive: true });

const FAKE_SRC = path.join(dir, 'fakeherdr-official.cs');
const FAKE = path.join(TMPDIR, 'fakeherdr-official.exe');
const build = spawnSync(CSC, ['/nologo', '/out:' + FAKE, FAKE_SRC], {
  encoding: 'utf8', windowsHide: true,
  env: Object.assign({}, process.env, { MSYS_NO_PATHCONV: '1' }),
});
if (build.status !== 0 || !fs.existsSync(FAKE)) {
  console.log('failed to build fake herdr fixture: ' + (build.stdout || '') + (build.stderr || ''));
  process.exit(1);
}

const logf = path.join(TMPDIR, 'a2_termrover-attach.log');
try { fs.unlinkSync(logf); } catch (e) {}

// Invoke exactly the way wsshd/TermRover do: SHELL -lc '<argv joined>', not
// a direct CreateProcess of the extensionless shebang script (Windows has no
// shebang support at that layer -- this is why the real flow always goes
// through Git Bash).
const cmd = "exec '" + RELAY + "/termrover-attach' '--session' 'sbtest' 'terminal' 'attach' 'term_x' '--takeover'";
const r = spawnSync(BASH, ['-lc', cmd], {
  env: Object.assign({}, process.env, { HERDR_REAL: FAKE, TERMROVER_ATTACH_LOG: logf }),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15000,
});

console.log('stdout: ' + JSON.stringify(r.stdout));
console.log('stderr: ' + JSON.stringify(r.stderr));
console.log('exit code: ' + r.status);
const okOutput = /OFFICIAL_ATTACH_OK/.test(r.stdout || '');
const okExit = r.status === 7;
console.log('A2 output contains OFFICIAL_ATTACH_OK: ' + okOutput + (okOutput ? '  OK' : '  FAIL'));
console.log('A2 exit code is 7: ' + okExit + (okExit ? '  OK' : '  FAIL'));

let log = '';
try { log = fs.readFileSync(logf, 'utf8'); } catch (e) {}
console.log('--- termrover-attach.log ---\n' + log);
const okLog = /mode=official/.test(log);
console.log('A2 log contains mode=official: ' + okLog + (okLog ? '  OK' : '  FAIL'));

// B4 regression (20260912-termrover-attach-input): official mode/passthrough
// must be byte-for-byte untouched by the emulate-mode terminal init sequence
// (alt-screen/mouse-reporting/bracketed-paste enable codes).
const okNoInit = !/\x1b\[\?1049h/.test(r.stdout || '');
console.log('A2 stdout does NOT contain emulate-mode init sequence (ESC[?1049h): ' + okNoInit + (okNoInit ? '  OK' : '  FAIL'));

process.exit(okOutput && okExit && okLog && okNoInit ? 0 : 1);
