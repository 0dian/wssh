// Starts the (pre-existing, currently stopped) named herdr session "sbtest"
// under a ConPTY so it keeps running headless in the background, detached
// from this script. Never touches the "default" session.
//
// Must run with the HERDR_* env vars for the CURRENT (default) session
// stripped -- herdr refuses "nested herdr" otherwise ("inception detected").
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require(path.join(__dirname, '..', 'node_modules', 'node-pty'));

const HERDR = process.env.HERDR_BIN_PATH || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe');
const TMPDIR = path.join(os.tmpdir(), 'termrover-attach-tests');
fs.mkdirSync(TMPDIR, { recursive: true });
const logf = path.join(TMPDIR, 'sbtest_session.log');
const out = fs.createWriteStream(logf, { flags: 'w' });

const env = Object.assign({}, process.env);
for (const k of ['HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_SOCKET_PATH']) delete env[k];

const p = pty.spawn(HERDR, ['session', 'attach', 'sbtest'], {
  name: 'xterm-256color',
  cols: 100, rows: 40,
  cwd: process.env.USERPROFILE,
  env,
  useConptyDll: true,
});
console.log('spawned sbtest attach pid=' + p.pid);
fs.writeFileSync(path.join(TMPDIR, 'sbtest_session.pid'), String(p.pid));
p.onData(d => out.write(d));
p.onExit(({ exitCode }) => { out.end('\n[exited ' + exitCode + ']\n'); });

// stay alive so the ConPTY (and the herdr client attached to it) keeps
// running; the caller kills this node process directly when done. The
// headless *server* sbtest started persists independently of this client and
// is stopped explicitly with `herdr session stop sbtest`.
setInterval(() => {}, 60000);
