// wssh — Windows ssh: an interactive remote shell (or any program) on a
// Windows host, running in a ConPTY that actually forwards mouse input.
//
//   wssh [options] [user@]host [-- command [args...]]
//
// Opens a *non-pty* SSH session (`ssh -T`) and lets a small relay on the remote
// side own the ConPTY instead. Putting the pty on the remote side is the whole
// point: OpenSSH's Windows pty runs on the System32 conhost, which silently
// drops mouse sequences in both directions.
//
// Because there is no remote pty, there is no SIGWINCH to propagate, so terminal
// resizes are encoded in-band and stripped back out by relay.js.
//
// ssh(1) config is a first-class citizen: the host token and every connection
// option are handed to the system `ssh` untouched, so Host aliases, User, Port,
// IdentityFile, ProxyJump, ControlMaster and friends all just work. This tool
// never parses ~/.ssh/config itself.

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Invoked through the shim, argv[1] is wssh.js; show the command the user typed.
const SELF = path.basename(process.argv[1] || 'wssh').replace(/\.js$/, '');
// Relative to the login shell's HOME on the remote (Git Bash lands in %USERPROFILE%).
const DEFAULT_REMOTE_DIR = 'wssh-relay';
const REMOTE_ENTRY_NAME = 'run-remote.sh';

const USAGE = `Usage: ${SELF} [options] [user@]host [-- command [args...]]

Opens an interactive remote shell on a Windows host, running inside a ConPTY
that actually forwards mouse input. Launch any TUI from that shell and its
mouse support just works. With no command, you get the shell.

The host token and all connection options are passed straight to ssh, so
~/.ssh/config Host aliases, User, Port, IdentityFile and ProxyJump apply.

Connection options (forwarded to ssh):
  -p <port>          remote port
  -i <keyfile>       identity file
  -J <jump>          ProxyJump target
  -o <opt=value>     any ssh option (repeatable; wins over our defaults)

Tool options:
  --remote-dir <p>   remote bundle dir (default: ~/${DEFAULT_REMOTE_DIR})
  --deploy           install/refresh the remote bundle, then exit
  --debug            enable relay diagnostics on stderr (pollutes the TUI)
  -h, --help         this text

Environment:
  WSSH_NODE          node binary to use (default: first on PATH)
  WSSH_REMOTE        remote bundle dir (same as --remote-dir)

Examples:
  ${SELF} my-box                         # interactive remote shell
  ${SELF} my-box -- herdr                # straight into a TUI
  ${SELF} my-box -- powershell
  ${SELF} -p 2022 -i ~/.ssh/id_ed25519 user@192.0.2.10
  ${SELF} --deploy my-box
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const sshOpts = [];
  let host = null;
  let remoteDir = null;
  let deploy = false;
  let debug = false;
  const rest = [];

  const takesValue = { '-p': 1, '-i': 1, '-J': 1, '-o': 1 };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (host === null) {
      if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
      if (a === '--deploy') { deploy = true; continue; }
      if (a === '--debug') { debug = true; continue; }
      if (a === '--remote-dir') {
        remoteDir = argv[++i];
        if (remoteDir === undefined) die('--remote-dir needs a value');
        continue;
      }
      if (takesValue[a]) {
        const v = argv[++i];
        if (v === undefined) die(`${a} needs a value`);
        sshOpts.push(a, v);
        continue;
      }
      // Combined short form, e.g. -p2022
      const m = /^(-[piJo])(.+)$/.exec(a);
      if (m) { sshOpts.push(m[1], m[2]); continue; }
      if (a === '--') die('missing host before --');
      if (a.startsWith('-')) die(`unknown option: ${a}\n\n${USAGE}`);
      host = a;
      continue;
    }
    // Everything after the host is the remote command.
    if (a === '--' && rest.length === 0) continue;
    rest.push(a);
  }
  if (!host) {
    // No baked-in default host: this is a general-purpose tool, and a personal
    // one belongs in ~/.ssh/config or a shell alias, not in the source.
    die(argv.length === 0
      ? `no host given.\n\n  ${SELF} <host>            # e.g. a Host alias from ~/.ssh/config\n  ${SELF} --help\n`
      : `missing host\n\n${USAGE}`);
  }
  return { sshOpts, host, remoteDir, deploy, debug, rest };
}

function die(msg) {
  process.stderr.write(`${SELF}: ${msg}\n`);
  process.exit(2);
}

const opt = parseArgs(process.argv.slice(2));
const REMOTE_DIR = opt.remoteDir || process.env.WSSH_REMOTE || DEFAULT_REMOTE_DIR;

// POSIX single-quote quoting — the remote login shell is Git Bash, not cmd.
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Our defaults go last so a user-supplied -o of the same name wins: ssh keeps
// the first value it sees for any given parameter.
function sshArgv(extra) {
  return ['-T', '-e', 'none', ...opt.sshOpts, '-o', 'ConnectTimeout=10', opt.host, ...extra];
}

if (opt.deploy) { deploy(); } else { session(); }

// ---------------------------------------------------------------------------
// deploy — best effort, idempotent
// ---------------------------------------------------------------------------
function deploy() {
  const here = path.join(__dirname, 'remote');
  let relay, runner;
  try {
    relay = fs.readFileSync(path.join(here, 'relay.js')).toString('base64');
    runner = fs.readFileSync(path.join(here, REMOTE_ENTRY_NAME)).toString('base64');
  } catch (e) {
    die(`cannot read remote/ sources next to this script: ${e.message}`);
  }

  const D = shq(REMOTE_DIR);
  const script = `
set -e
MSYS2_ARG_CONV_EXCL="*"; export MSYS2_ARG_CONV_EXCL
DIR="$HOME"/${REMOTE_DIR.replace(/'/g, "'\\''")}

if ! command -v node >/dev/null 2>&1; then
  echo "DEPLOY_FAIL no 'node' on the remote PATH." >&2
  echo "DEPLOY_FAIL install Node.js on the remote host and retry." >&2
  exit 3
fi
echo "DEPLOY_NODE $(node --version)"

mkdir -p "$DIR"
base64 -d > "$DIR/relay.js" <<'__B64_RELAY__'
${relay}
__B64_RELAY__
base64 -d > "$DIR/${REMOTE_ENTRY_NAME}" <<'__B64_RUNNER__'
${runner}
__B64_RUNNER__
chmod +x "$DIR/${REMOTE_ENTRY_NAME}" 2>/dev/null || true
echo "DEPLOY_FILES relay.js=$(wc -c < "$DIR/relay.js") ${REMOTE_ENTRY_NAME}=$(wc -c < "$DIR/${REMOTE_ENTRY_NAME}")"

# Sweep up pre-rename leftovers so a stale copy cannot be invoked.
for stale in run-herdr.sh; do
  if [ -e "$DIR/$stale" ]; then rm -f "$DIR/$stale"; echo "DEPLOY_CLEAN removed obsolete $stale"; fi
done

# node-pty: keep an existing copy, otherwise borrow one from a VS Code server
# install. It must be a build that ships conpty.dll (the bundled new ConPTY);
# the OS ConPTY on Win10 is too old and is exactly what we are routing around.
if [ -f "$DIR/node_modules/node-pty/package.json" ]; then
  echo "DEPLOY_PTY keep existing"
else
  SRC=""
  for c in $(ls -dt "$HOME"/.vscode-server/bin/*/node_modules/node-pty 2>/dev/null); do
    if [ -f "$c/build/Release/conpty/conpty.dll" ]; then SRC="$c"; break; fi
  done
  if [ -n "$SRC" ]; then
    mkdir -p "$DIR/node_modules"
    cp -r "$SRC" "$DIR/node_modules/node-pty"
    echo "DEPLOY_PTY copied from $SRC"
  else
    echo "DEPLOY_FAIL no usable node-pty found." >&2
    echo "DEPLOY_FAIL need node-pty >=1.1 built with the bundled new ConPTY," >&2
    echo "DEPLOY_FAIL i.e. containing build/Release/conpty/conpty.dll." >&2
    echo "DEPLOY_FAIL install it into $DIR/node_modules/node-pty by hand:" >&2
    echo "DEPLOY_FAIL   cd $DIR && npm install node-pty" >&2
    echo "DEPLOY_FAIL or copy one out of any VS Code Remote server install." >&2
    exit 4
  fi
fi

WDIR=$(cd "$DIR" && { pwd -W 2>/dev/null || pwd; })
node -e "require('$WDIR/node_modules/node-pty'); console.log('DEPLOY_PTY_OK')"
echo "DEPLOY_DIR $WDIR"
echo "DEPLOY_OK"
`;

  process.stderr.write(`${SELF}: deploying to ${opt.host}:~/${REMOTE_DIR} ...\n`);
  const r = spawnSync('ssh', sshArgv(['sh -s']), {
    input: script,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.error) die(`failed to run ssh: ${r.error.message}`);
  if (r.status !== 0) {
    process.stderr.write(`${SELF}: deploy failed (exit ${r.status}).\n`);
    process.exit(r.status || 1);
  }
  process.stderr.write(`${SELF}: deploy OK. Run: ${SELF} ${opt.host}\n`);
  void D;
}

// ---------------------------------------------------------------------------
// interactive session
// ---------------------------------------------------------------------------
function session() {
  const isTTY = !!(process.stdout.isTTY && process.stdin.isTTY);
  const size = () => ({
    cols: (process.stdout.columns | 0) || 120,
    rows: (process.stdout.rows | 0) || 40,
  });
  const first = size();

  const entry = `${REMOTE_DIR}/${REMOTE_ENTRY_NAME}`;
  // No command means no command: the remote entry picks the login shell, since
  // only it knows what $SHELL is over there.
  const remoteCmd =
    (opt.debug ? 'WSSH_DEBUG=1 ' : '') +
    ['sh', shq(entry), String(first.cols), String(first.rows), ...opt.rest.map(shq)].join(' ');

  if (!isTTY) {
    process.stderr.write(`${SELF}: stdin/stdout is not a terminal; no raw mode or resize.\n`);
  }
  process.stderr.write(`${SELF}: connecting to ${opt.host} (first paint takes ~10s)...\n`);

  const ssh = spawn('ssh', sshArgv([remoteCmd]), { stdio: ['pipe', 'inherit', 'inherit'] });

  // -- terminal mode --------------------------------------------------------
  function setRaw(on) {
    if (!isTTY || !process.stdin.setRawMode) return;
    try { process.stdin.setRawMode(on); } catch (e) {}
  }
  // Raw mode also turns off ISIG, so Ctrl-C reaches the TUI as byte 0x03 rather
  // than killing this wrapper — which is what a TUI expects.
  setRaw(true);
  process.stdin.resume();
  process.stdin.pipe(ssh.stdin);
  ssh.stdin.on('error', () => {}); // EPIPE once the remote is gone

  // -- resize: ESC ] 77577 ; cols ; rows BEL  (see relay.js) ----------------
  let lastCols = first.cols, lastRows = first.rows;
  function sendResize() {
    const { cols, rows } = size();
    if (cols === lastCols && rows === lastRows) return; // both hooks can fire
    lastCols = cols; lastRows = rows;
    try { ssh.stdin.write(`\x1b]77577;${cols};${rows}\x07`); } catch (e) {}
  }
  // 'resize' on the stdout tty stream is the portable hook — macOS, Linux and
  // Windows Terminal all emit it. SIGWINCH is a POSIX-only backstop; the dedupe
  // above makes the overlap harmless.
  if (isTTY) process.stdout.on('resize', sendResize);
  if (process.platform !== 'win32') process.on('SIGWINCH', sendResize);

  // -- teardown -------------------------------------------------------------
  let done = false;
  function restore(abnormal) {
    if (done) return;
    done = true;
    setRaw(false);
    if (!isTTY) return;
    // Always undo mouse reporting and un-hide the cursor: if the remote died
    // mid-frame nobody else will. Only leave the alternate screen on an abnormal
    // exit — a clean quit already did that itself, and a redundant ?1049l would
    // clobber the restored scrollback.
    let s = '\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1004l\x1b[?25h';
    if (abnormal) s += '\x1b[?1049l';
    try { process.stdout.write(s); } catch (e) {}
  }
  process.on('exit', () => restore(false));

  ssh.on('error', e => {
    restore(true);
    process.stderr.write(`${SELF}: failed to run ssh: ${e && e.message || e}\n`);
    process.exit(127);
  });
  ssh.on('exit', (code, signal) => {
    restore(code !== 0 || !!signal);
    process.stdin.pause();
    process.exit(signal ? 128 : (code || 0));
  });
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { ssh.kill('SIGTERM'); } catch (e) {}
      restore(true);
      process.exit(129);
    });
  }
}
