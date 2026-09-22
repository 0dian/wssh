// A3: with the REAL herdr binary and no forced mode, termrover-attach must
// probe it, see the Windows "not supported" refusal, and log mode=emulate.
// We invoke termrover-attach directly (not through the emulate bridge's
// stdin/stdout loop -- that's covered by A4) and kill it shortly after the
// probe+log line lands, since in emulate mode it would otherwise sit
// forwarding an interactive session forever.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const BASH = 'D:\\Program Files\\Git\\bin\\bash.exe';
const TMPDIR = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(TMPDIR, { recursive: true });
const logf = path.join(TMPDIR, 'a3_termrover-attach.log');
try { fs.unlinkSync(logf); } catch (e) {}

// Use a nonexistent term id and NOT --takeover: if detection is somehow
// wrong and this actually ran `terminal session control` for real, it will
// just fail fast against session "sbtest" with "not found" -- never touches
// the "default" session, never takes over anything.
const cmd = "exec '" + RELAY + "/termrover-attach' '--session' 'sbtest' 'terminal' 'attach' 'term_a3_probe_only'";
const child = spawn(BASH, ['-lc', cmd], {
  env: Object.assign({}, process.env, { TERMROVER_ATTACH_LOG: logf }),
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => out += d);
child.stderr.on('data', d => out += d);

const killer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 8000);
child.on('exit', (code, signal) => {
  clearTimeout(killer);
  setTimeout(finish, 300);
});

function finish() {
  let log = '';
  try { log = fs.readFileSync(logf, 'utf8'); } catch (e) {}
  console.log('--- child stdout/stderr ---\n' + out);
  console.log('--- termrover-attach.log ---\n' + log);
  const okMode = /mode=emulate/.test(log);
  const okReason = /not supported on Windows/i.test(log);
  console.log('A3 log contains mode=emulate: ' + okMode + (okMode ? '  OK' : '  FAIL'));
  console.log('A3 log reason mentions "not supported on Windows": ' + okReason + (okReason ? '  OK' : '  FAIL'));
  process.exit(okMode && okReason ? 0 : 1);
}
