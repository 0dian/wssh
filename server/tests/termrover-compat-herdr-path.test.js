// Regression test for termroverCompat()'s herdr-path substitution in
// wsshd.js. herdr 0.9.1-preview moved its install path from a fixed
// AppData\...\bin\herdr.exe location to a version-hashed release directory
// under ~/.herdr/packages/standalone/releases/<version>/herdr; the old code
// compared the command text against a single HERDR_MSYS_PATH constant
// derived from HERDR_BIN, so the moment herdr's real path stopped matching
// that constant, the whole replacement silently no-op'd and TermRover ran
// the real (Windows-unsupported) `herdr terminal attach` instead of the
// termrover-attach shim. The fix pulls the herdr path out of the command
// text itself (HERDR_PATH_IN_CMD) instead of comparing to a fixed constant.
//
// This does NOT require('../wsshd.js') -- that file binds SSH listeners and
// reads real host keys as soon as it is loaded (BIND.forEach(listen) at the
// bottom), which would start a second wsshd process fighting the live one
// for the port. Instead it slices the exact live source of the two
// self-contained blocks termroverCompat() depends on (toMsys, and
// PS_PPID..termroverCompat) straight out of wsshd.js by marker, and runs
// that slice in a vm sandbox. This still tests the real, current wsshd.js
// text -- just without executing the rest of the file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// Fixture strings below are reconstructed verbatim from a real wsshd.log
// (see comments at each fixture), which necessarily embeds the machine's
// Windows username in the herdr install path. Substituted at load time via
// a placeholder token so the source text itself never hardcodes a real
// username.
const USERNAME = os.userInfo().username;
function withUser(s) { return s.split('__WSSH_USER__').join(USERNAME); }

const WSSHD_PATH = path.join(__dirname, '..', 'wsshd.js');
const WSSHD_DIR = path.dirname(WSSHD_PATH);
const WSSHD_SRC = fs.readFileSync(WSSHD_PATH, 'utf8');

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error('marker not found: ' + startMarker);
  const end = src.indexOf(endMarker, start);
  if (end === -1) throw new Error('end marker not found: ' + endMarker);
  return src.slice(start, end);
}

const TOMSYS_SRC = sliceBetween(WSSHD_SRC, 'function toMsys(p) {', '\n\nfunction msysSocketPaths');
const COMPAT_SRC = sliceBetween(WSSHD_SRC, 'const PS_PPID = ', '\n\nfunction onStreamLocal');

function loadTermroverCompat() {
  const logs = [];
  const sandbox = {
    path,
    __dirname: WSSHD_DIR,
    log: (msg) => logs.push(msg),
  };
  vm.createContext(sandbox);
  // `const`/`let` at vm top level do NOT become sandbox properties (only
  // `var`/`function` do), so re-expose TERMROVER_ATTACH_MSYS_PATH via a var.
  vm.runInContext(
    TOMSYS_SRC + '\n\n' + COMPAT_SRC + '\nvar __shimPath__ = TERMROVER_ATTACH_MSYS_PATH;',
    sandbox,
    { filename: 'wsshd.js (sliced)' }
  );
  if (typeof sandbox.termroverCompat !== 'function') {
    throw new Error('termroverCompat did not materialize in sandbox -- source slice markers may be stale');
  }
  return { termroverCompat: sandbox.termroverCompat, logs, TERMROVER_ATTACH_MSYS_PATH: sandbox.__shimPath__ };
}

let failures = 0;
function ok(cond, label) {
  console.log((cond ? 'OK ' : 'FAIL ') + label);
  if (!cond) failures++;
}

// --- fixtures: real termrover-login commands, reconstructed byte-for-byte
// from wsshd.log (the log only ever records the command AFTER
// termroverCompat() already ran, so both the ps -o ppid= and the herdr
// substitutions were reversed back to what TermRover actually sent, using
// the exact PS_PPID/PS_PPID_MSYS and old/new herdr path strings confirmed
// present in the surrounding log lines). See the dispatch report for the
// line numbers and the reconstruction.

// New herdr path (bug repro): wsshd.log line 15146, 2026-09-22T04:11:39Z.
// Real command, only the ps -o ppid= substitution reversed back to raw.
const NEW_PATH_CMD = withUser("/bin/sh -c 'exec \"${SHELL:-/bin/sh}\" -lc \"$1\"' termrover-login '/bin/sh -c '\\''umask 077\ntr_dir=\"$HOME/.cache/termrover/fleet/19c31d44b22e408e961481e4839a77ad\"\nmkdir -p \"$HOME/.cache/termrover/fleet\" || exit 1\nmkdir \"$tr_dir\" || exit 1\ntr_child=\ntr_tty=$(stty -g)\ntr_running() {\n    [ -n \"$tr_child\" ] &&\n        [ \"$(ps -o ppid= -p \"$tr_child\" 2>/dev/null | tr -d '\\''\\'\\'''\\''[:space:]'\\''\\'\\'''\\'')\" = \"$$\" ]\n}\ntr_stop() {\n    if [ -n \"$tr_child\" ]; then\n        # A client can exit or be taken over. Never signal a recycled PID.\n        if tr_running; then kill \"$tr_child\" 2>/dev/null || true; fi\n        wait \"$tr_child\" 2>/dev/null || true\n        tr_child=\n    fi\n    stty \"$tr_tty\" -echo\n}\ntr_cleanup() { tr_stop; rm -rf \"$tr_dir\"; }\ntrap tr_cleanup 0\ntrap '\\''\\'\\'''\\''exit 0'\\''\\'\\'''\\'' 1 2 15\nmkfifo \"$tr_dir/control\" || exit 1\nexec 3<> \"$tr_dir/control\"\nstty -echo\nwhile read -r tr_action tr_request <&3; do\n    case \"$tr_request\" in '\\''\\'\\'''\\'''\\''\\'\\'''\\''|*[!a-f0-9]*) continue;; esac\n    case \"$tr_action\" in\n        attach)\n            if ! tr_running; then\n                tr_stop\n                sh -c '\\''\\'\\'''\\''exec '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''/c/Users/__WSSH_USER__/.herdr/packages/standalone/releases/0.9.1-preview.2026-09-21-0ff0f27e2226-x86_64-pc-windows-msvc/herdr'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''--session'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''default'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''terminal'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''attach'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''term_65c0a212e20915e'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''--takeover'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'''\\''\\'\\'''\\'' < /dev/tty 3>&- &\n                tr_child=$!\n                sleep 0.1\n            fi\n            if tr_running; then tr_state=attached; else tr_state=failed; fi\n            ;;\n        detach) tr_stop; tr_state=parked;;\n        *) continue;;\n    esac\n    printf '\\''\\'\\'''\\''%s\\n'\\''\\'\\'''\\'' \"$tr_state\" > \"$tr_dir/.reply\"\n    mv \"$tr_dir/.reply\" \"$tr_dir/$tr_request\"\ndone'\\'''");
const NEW_HERDR_PATH = withUser('/c/Users/__WSSH_USER__/.herdr/packages/standalone/releases/0.9.1-preview.2026-09-21-0ff0f27e2226-x86_64-pc-windows-msvc/herdr');

// Old herdr path (worked before the upgrade): wsshd.log line 13688,
// 2026-09-21T15:58:46Z, right after the "compat: herdr -> termrover-attach"
// log line at 13687. The exec log there already shows the POST-compat
// command (wsshd logs exec after termroverCompat runs), so this fixture
// reverses BOTH substitutions termroverCompat applied (termrover-attach path
// -> old herdr path, msys ps -> ps -o ppid=) back to what TermRover actually
// sent, using the exact PS_PPID_MSYS/TERMROVER_ATTACH_MSYS_PATH strings
// confirmed present in that logged output.
const OLD_PATH_CMD = withUser("/bin/sh -c 'exec \"${SHELL:-/bin/sh}\" -lc \"$1\"' termrover-login '/bin/sh -c '\\''umask 077\ntr_dir=\"$HOME/.cache/termrover/fleet/55ec31837aaa4e5ca731685346ffbc05\"\nmkdir -p \"$HOME/.cache/termrover/fleet\" || exit 1\nmkdir \"$tr_dir\" || exit 1\ntr_child=\ntr_tty=$(stty -g)\ntr_running() {\n    [ -n \"$tr_child\" ] &&\n        [ \"$(ps -o ppid= -p \"$tr_child\" 2>/dev/null | tr -d '\\''\\'\\'''\\''[:space:]'\\''\\'\\'''\\'')\" = \"$$\" ]\n}\ntr_stop() {\n    if [ -n \"$tr_child\" ]; then\n        # A client can exit or be taken over. Never signal a recycled PID.\n        if tr_running; then kill \"$tr_child\" 2>/dev/null || true; fi\n        wait \"$tr_child\" 2>/dev/null || true\n        tr_child=\n    fi\n    stty \"$tr_tty\" -echo\n}\ntr_cleanup() { tr_stop; rm -rf \"$tr_dir\"; }\ntrap tr_cleanup 0\ntrap '\\''\\'\\'''\\''exit 0'\\''\\'\\'''\\'' 1 2 15\nmkfifo \"$tr_dir/control\" || exit 1\nexec 3<> \"$tr_dir/control\"\nstty -echo\nwhile read -r tr_action tr_request <&3; do\n    case \"$tr_request\" in '\\''\\'\\'''\\'''\\''\\'\\'''\\''|*[!a-f0-9]*) continue;; esac\n    case \"$tr_action\" in\n        attach)\n            if ! tr_running; then\n                tr_stop\n                sh -c '\\''\\'\\'''\\''exec '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''/c/Users/__WSSH_USER__/AppData/Local/Programs/Herdr/bin/herdr'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''--session'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''default'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''terminal'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''attach'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''term_65bf90b6828784e'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'' '\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\''--takeover'\\''\\'\\'''\\''\\'\\''\\'\\'''\\'''\\''\\'\\'''\\'''\\''\\'\\'''\\'' < /dev/tty 3>&- &\n                tr_child=$!\n                sleep 0.1\n            fi\n            if tr_running; then tr_state=attached; else tr_state=failed; fi\n            ;;\n        detach) tr_stop; tr_state=parked;;\n        *) continue;;\n    esac\n    printf '\\''\\'\\'''\\''%s\\n'\\''\\'\\'''\\'' \"$tr_state\" > \"$tr_dir/.reply\"\n    mv \"$tr_dir/.reply\" \"$tr_dir/$tr_request\"\ndone'\\'''");
const OLD_HERDR_PATH = withUser('/c/Users/__WSSH_USER__/AppData/Local/Programs/Herdr/bin/herdr');

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// a. new (version-hashed release dir) herdr path gets replaced
{
  const { termroverCompat, logs, TERMROVER_ATTACH_MSYS_PATH } = loadTermroverCompat();
  const before = countOccurrences(NEW_PATH_CMD, NEW_HERDR_PATH);
  const out = termroverCompat(NEW_PATH_CMD, 'peer');
  ok(before > 0, 'a0. fixture actually contains the new herdr path (' + before + ' occurrence(s))');
  ok(!out.includes(NEW_HERDR_PATH), 'a1. new-path fixture: raw herdr path fully removed from output');
  ok(!/\/herdr'/.test(out), "a2. new-path fixture: output contains no residual real herdr invocation (no /herdr' left)");
  ok(countOccurrences(out, TERMROVER_ATTACH_MSYS_PATH) === before,
    'a3. new-path fixture: shim path appears once per original herdr-path occurrence (' +
    countOccurrences(out, TERMROVER_ATTACH_MSYS_PATH) + ' vs ' + before + ')');
  ok(logs.some(l => l.includes('compat: herdr -> termrover-attach')),
    'a4. new-path fixture: compat log line emitted (got ' + JSON.stringify(logs) + ')');
}

// b. old (fixed bin/ dir) herdr path still gets replaced -- backward compat
{
  const { termroverCompat, logs, TERMROVER_ATTACH_MSYS_PATH } = loadTermroverCompat();
  const before = countOccurrences(OLD_PATH_CMD, OLD_HERDR_PATH);
  const out = termroverCompat(OLD_PATH_CMD, 'peer');
  ok(before > 0, 'b0. fixture actually contains the old herdr path (' + before + ' occurrence(s))');
  ok(!out.includes(OLD_HERDR_PATH), 'b1. old-path fixture: raw herdr path fully removed from output');
  ok(!/\/herdr'/.test(out), "b2. old-path fixture: output contains no residual real herdr invocation (no /herdr' left)");
  ok(countOccurrences(out, TERMROVER_ATTACH_MSYS_PATH) === before,
    'b3. old-path fixture: shim path appears once per original herdr-path occurrence (' +
    countOccurrences(out, TERMROVER_ATTACH_MSYS_PATH) + ' vs ' + before + ')');
  ok(logs.some(l => l.includes('compat: herdr -> termrover-attach')),
    'b4. old-path fixture: compat log line emitted (got ' + JSON.stringify(logs) + ')');
}

// c. a herdr command with no termrover-login marker (e.g. wsshd's own
// `herdr session list --json` probe) must pass through untouched, even
// though it contains a herdr path -- termroverCompat only ever touches
// termrover-login scripts.
{
  const { termroverCompat, logs } = loadTermroverCompat();
  const cmd = "'" + NEW_HERDR_PATH + "' session list --json";
  const out = termroverCompat(cmd, 'peer');
  ok(out === cmd, 'c1. non-termrover-login command with a herdr path returned unchanged');
  ok(logs.length === 0, 'c2. non-termrover-login command: no compat log emitted (got ' + JSON.stringify(logs) + ')');
}

// d. termrover-login present but no herdr path at all -> no herdr
// substitution; the unrelated ps -o ppid= compat (independent branch) still
// fires as before.
{
  const { termroverCompat, logs, TERMROVER_ATTACH_MSYS_PATH } = loadTermroverCompat();
  const cmd = 'echo termrover-login; ps -o ppid= -p "$tr_child"';
  const out = termroverCompat(cmd, 'peer');
  ok(out === 'echo termrover-login; ps -p "$tr_child" | sed -n 2p | cut -c10-17',
    'd1. termrover-login without a herdr path: ps -o ppid= still rewritten, output ' + JSON.stringify(out));
  ok(!out.includes(TERMROVER_ATTACH_MSYS_PATH), 'd2. no shim path introduced when there was no herdr path to replace');
  ok(logs.some(l => l.includes('compat: ps -o ppid=')), 'd3. ps compat log line emitted');
  ok(!logs.some(l => l.includes('compat: herdr ->')), 'd4. no herdr compat log line emitted (got ' + JSON.stringify(logs) + ')');
}

console.log(failures === 0 ? 'HERDR-PATH OVERALL: OK' : ('HERDR-PATH OVERALL: FAIL (' + failures + ' failure(s))'));
process.exit(failures === 0 ? 0 : 1);
