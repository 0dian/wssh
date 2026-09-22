# wsshd — server-side wssh

A minimal SSH server for a Windows host whose sessions run in a *new* ConPTY
(node-pty with `useConptyDll: true`) instead of the System32 conhost that
Win32-OpenSSH uses. Same fix as `wssh`, opposite end: **the client needs
nothing installed**. Any stock SSH client that asks for a pty — a phone app
such as Moshi, plain `ssh -t` — gets a shell where TUIs (herdr, …) receive
mouse input.

Use `wssh` when you control the client and want to keep using port 22.
Use `wsshd` when you don't control the client.

## What it does / does not do

- Listens on `WSSHD_BIND` (default `127.0.0.1`) port `WSSHD_PORT` (2222).
  Bind it to loopback and the tailnet IP only; never to a public interface.
  To reach it from a phone or other device, add your tailnet IP to `WSSHD_BIND`,
  e.g. `WSSHD_BIND=127.0.0.1,100.x.y.z`.
- **Public-key auth only**, against the same files sshd reads
  (`C:\ProgramData\ssh\administrators_authorized_keys` and `~/.ssh/authorized_keys`),
  re-read on every attempt. Passwords are never accepted.
- `shell`, `exec`, `pty-req`, `env` (TERM / LANG / LC_* / COLORTERM), `window-change`.
- Shell is Git Bash (`bash -l -i`; `exec` runs `bash -lc "<cmd>"`). Override with `WSSHD_SHELL`.
- **No** sftp/scp, port forwarding, agent forwarding, X11. Keep using port 22 for
  VS Code Remote and scp. The one narrow exception to "no forwarding" is
  herdr's own session API sockets, for TermRover's herdr fleet — see
  [TermRover herdr fleet](#termrover-herdr-fleet) below. `exec` only goes through ConPTY (control sequences,
  CRLF) when the client also requests a pty; without a pty-req it runs over a
  clean pipe with stdout/stderr kept separate and the real exit code passed
  through, same as stock sshd, so it can be parsed by scripts. `exec` also
  turns off MSYS/Git Bash's argv path-rewriting for the command it runs
  (`MSYS_NO_PATHCONV=1` and `MSYS2_ARG_CONV_EXCL=*`), so a Windows-style
  command's own switches — e.g. `cmd.exe /d /s /c "..."` — reach it intact
  instead of being mangled as POSIX paths, matching stock sshd's behavior;
  the interactive shell is unaffected and keeps Git Bash's usual path
  conversion.
- Host key: `~/.ssh/wsshd_host_ed25519`, generated with `ssh-keygen` on first start.
- Log: `wsshd.log` next to the script (`WSSHD_LOG`).
- **Only relays mouse bytes it receives — cannot conjure ones a client never
  sends.** wsshd fixes the server-to-TUI half of the path; most Android SSH
  apps do not turn touch input into xterm mouse reporting (`ESC [ < ... M`) by
  default, so look for a "mouse reporting" / "mouse mode" / touch-as-mouse
  toggle in the app's settings, and as a fallback try pairing a Bluetooth/USB
  mouse to see whether the app forwards that instead. Use `mousetest.js`
  below to find out which case you're in — we have no data on specific apps,
  so this list intentionally names none as working or not.

## Layout on the host

```
~/wssh-relay/
  relay.js, run-remote.sh      # wssh remote half (managed by `wssh --deploy`)
  node_modules/node-pty/       # the node-pty that ships build/Release/conpty/conpty.dll
  wsshd.js, mousetest.js       # this
  termrover-attach.js          # `herdr terminal attach` shim for TermRover (see below)
  termrover-attach             # its sh wrapper (must stay executable, next to wsshd.js)
  deps/package.json            # {"dependencies": {"ssh2": "1.17.0"}}
  deps/node_modules/ssh2       # installed with `cd deps && npm install`
```

`ssh2` lives in `deps/` on purpose: running `npm install` in the relay dir itself
prunes the bundled `node-pty` as "extraneous" — and with it the `conpty.dll`
everything depends on. Never `npm install` in `~/wssh-relay` directly.

The `ssh2` version is pinned exactly (no `^`) on purpose: `runInPipes()` in
`wsshd.js` reaches into a handful of ssh2-internal private fields
(`_chunk`/`_chunkcb`/`_chunkErr`/`_chunkcbErr`) to work around a bug in ssh2
1.17.0's `CHANNEL_WINDOW_ADJUST` resume path. A `^1.x` range would let a
routine `npm install` silently pick up a different ssh2 build whose internals
don't match, and because assigning to a property that no longer exists does
not throw, the workaround would become a silent no-op — bringing back
truncated stderr / hung execs with no error anywhere. wsshd checks the
installed `ssh2` version against a verified whitelist at startup and logs a
loud warning (never a hard exit) if it doesn't match, plus a one-time
structural warning if a live channel object is missing the expected private
fields — watch `wsshd.log` for `WARNING` after any ssh2 upgrade.

## Deploy (Windows host)

1. `wssh --deploy <host>` first, so `~/wssh-relay/node_modules/node-pty` exists.
2. Copy `wsshd.js`, `mousetest.js`, `termrover-attach.js` and `termrover-attach`
   into `~/wssh-relay/`.
3. `mkdir deps`, write the `package.json` above, `cd deps && npm install`.
4. Run it under the user's logon as a Scheduled Task (`Register-ScheduledTask`,
   action `node.exe C:\Users\<u>\wssh-relay\wsshd.js`, hidden, restart on failure,
   no execution time limit). It must run in the user's session, not as a service.
   **Principal must be `-RunLevel Highest`**: `administrators_authorized_keys` is
   ACL'd to Administrators + SYSTEM, and a task with a UAC-filtered token cannot
   read it — every key that lives only there is then rejected as "no matching
   key". The startup log line `authorized keys loaded at startup:` tells you
   which keys it actually sees; `authorized_keys UNREADABLE` means this.
5. Client side: `ssh -p 2222 <user>@<tailnet-ip>`, or through a jump host /
   reverse tunnel that targets `127.0.0.1:2222` (there is no `::1` listener, so
   do not write `localhost:2222` in an `ssh -R`).

## TermRover herdr fleet

TermRover's "herdr agents fleet" works against a Mac out of the box but not
against Windows: the app assumes a Unix host, and herdr's Windows build lacks
`terminal attach`. wsshd papers over each gap, narrowly, and only for herdr:

| Gap | What wsshd does |
|---|---|
| `herdr session list --json` reports `socket_path` as `C:\...`; TermRover rejects anything non-POSIX ("herdr didn't provide a session API socket") | For exactly that exec, rewrites each `socket_path` to its MSYS spelling (`/c/...`) |
| TermRover opens the socket by exec'ing `nc -U <sock>` (or ncat/socat/python3); on Windows the API is really the named pipe `\\.\pipe\<socket_path>` | Bridges that exec channel straight to the pipe; also accepts `direct-streamlocal@openssh.com`. Only paths `herdr session list` itself reports are allowed |
| The attach script checks its child with `ps -o ppid=`; Git Bash's `ps` has no `-o` | Rewrites that one check to an MSYS `ps` equivalent |
| herdr 0.9.x on Windows refuses `terminal attach` ("not supported on Windows yet") | Points that one invocation at `termrover-attach` |

`termrover-attach` probes the real herdr on **every** run (a throwaway attach
to a nonexistent id). If herdr still says "not supported on Windows" it
emulates attach on top of `herdr terminal session control`: frames go to the
terminal, keys go back, the alternate screen / mouse reporting / bracketed
paste are set up like herdr's own attach client, wheel and PageUp/PageDown
become herdr scrollback, `Ctrl+B q` detaches. Any other answer means herdr
has grown native support, and the shim hands the original argv to it
untouched — no change needed here the day upstream fixes Windows.

- Force a mode with `TERMROVER_ATTACH_MODE=official|emulate`; point at a
  different herdr with `HERDR_BIN_PATH`.
- Log: `termrover-attach.log` next to the script (`TERMROVER_ATTACH_LOG`).
  The `mode=` line says which path was taken; `in` / `scroll` / `stats` lines
  show what the phone actually sent.
- Known limitation: on detach TermRover's script kills the shim with MSYS
  `kill`, which for a native `node.exe` is sometimes a hard terminate, so the
  terminal-restore sequence may not be written. The next attach re-initialises
  the terminal, so nothing visible sticks.
- Unit test for the input filter: `node tests/termrover-attach-filter.test.js`.

## Tests

Run a `.js` test with `node tests/<file>.js` and a `.py` test with
`python tests/<file>.py` (Windows: `python`, not `python3`; set
`PYTHONIOENCODING=utf-8` for the phone-view ones). Paths inside every test
are derived from `__dirname` / `os.homedir()` / `process.env.HERDR_BIN_PATH`,
never hardcoded, so they run the same way from this repo's `server/tests/`
or from the `~/wssh-relay` deploy layout.

### Moshi PowerShell dispatch (20260921-wsshd-moshi-powershell)

- `d1_moshi_dispatch_unit.js` -- unit tests for the `MOSHI_PS` regex in
  `wsshd.js` that decides whether an exec'd command is one of Moshi's
  PowerShell probes (dispatch to `powershell.exe`) or an ordinary bash
  command; includes a UTF-16LE `-EncodedCommand` round-trip check against
  the real `powershell.exe` on the host.
- `d2_moshi_e2e.js` -- end-to-end: starts a real, patched `wsshd.js` on a
  temporary port and runs Moshi's real probe scripts (pulled verbatim from
  `wsshd.log`) through it, alongside bash and TermRover regression checks
  on the same instance.
- `d3_moshi_spawn_error_crash_guard.js` -- crash-guard regression: points
  `WSSHD_POWERSHELL` at a nonexistent path and asserts the one bad spawn
  fails cleanly, without crashing wsshd or hanging any other client.

### TermRover herdr fleet coverage (backfill for the feature shipped in 4506d0d)

These test the official/emulate detection and the e2e attach/detach replay
above; they existed on disk since that change but were never added to git.

- `a2_official_detect.js` / `a3_emulate_detect.js` -- termrover-attach's
  official-vs-emulate mode detection, against a fake herdr build
  (`fakeherdr-official.cs`, compiled on the fly) and the real one.
- `a4_e2e_real_attach.js` / `b3_e2e.js` -- full end-to-end TermRover
  attach/detach replay (scripts lifted verbatim from `wsshd.log`) against a
  real wsshd + termrover-attach, targeting the named herdr session `sbtest`
  only, never `default`. `b3_e2e.js` additionally exercises the
  emulate-mode terminal init/restore sequences and the input filter's
  scroll/keystroke paths.
- `start_sbtest.js` -- brings the named herdr session `sbtest` up headless
  so a4/b3/e2 have a real session to attach to. Run it first; when done,
  `herdr session stop sbtest` and kill this script's node process (it
  `setInterval`s to stay alive).

Known flaky: `b3_e2e.js`'s post-detach assertions (`ESC[?1049l` /
`ESC[?1000l` / the `stats` log line) fail roughly half the time --
TermRover kills the shim with MSYS `kill` on detach, which for a native
`node.exe` is sometimes a hard terminate before the restore sequence gets
written (see "Known limitation" above). Not a regression; re-run if it
fails alone.

### Moshi pty-path dispatch (20260922-wsshd-moshi-attach-pty)

- `e1_attach_pty_history_scan.js` -- full-history zero-false-positive scan:
  every distinct `exec` command ever logged to `wsshd.log`, deduplicated
  and tested against `MOSHI_PS`, asserting only the three known Moshi
  PowerShell shapes match it.
- `e2_attach_pty_e2e.js` -- pty-path dispatch end-to-end: sends a pty-req
  then execs Moshi's real attach command (pulled from `wsshd.log`, targeting
  `sbtest`) against a real wsshd instance, plus the bash regression and the
  crash-guard check on the pty path.

## Proving the mouse works without a human

```
ssh -tt -p 2222 user@host node C:/Users/<u>/wssh-relay/mousetest.js
```
prints `MOUSETEST-READY`; send the bytes `ESC [ < 0;10;5 M` from the client
(expect: `send "\x1b\[<0;10;5M"`). `MOUSE-OK` means they arrived. The same
probe through port 22 on an old conhost ends in `MOUSE-TIMEOUT`.

### Doing it by hand, from a phone

The 8 s timeout above is sized for the automated form; a human tapping a
touchscreen needs longer, so it is configurable via `MOUSETEST_TIMEOUT`
(milliseconds, default 8000):

```sh
# once the phone app is connected to wsshd, at the bash prompt:
cd ~/wssh-relay && MOUSETEST_TIMEOUT=30000 node mousetest.js
```

(`cd` first and use the relative filename on purpose — Git Bash's `/c/...`
path is not one `node.exe` can resolve.) Wait for `MOUSETEST-READY`, then
tap/drag on the screen, and read the result:

| Output | Meaning |
|---|---|
| `MOUSE-OK` | The server-side path is fine; the problem is in the TUI itself (see "TUI capability probes" in the main README's Limitations). |
| `RX …` lines appear, but no `1b5b3c` in the hex | The app sends *some* bytes, just not SGR mouse ones (could be X10 `1b5b4d`, or arrow keys). |
| No `RX` line at all when you tap | The app never sends mouse bytes; there is nothing wsshd can do about that. |
