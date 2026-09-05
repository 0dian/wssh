# wssh — SSH into Windows with a working terminal

SSH to a Windows host and get a shell where **mouse input actually works**. Run
any TUI in it — click, scroll, drag — the way you would locally.

```sh
wssh my-box              # interactive remote shell
wssh my-box -- herdr     # or go straight into a TUI
```

*(Read this in [中文](README.zh.md).)*

## The problem

Run a mouse-driven TUI over `ssh -t` to a Windows host and the mouse is dead.
Keyboard works, rendering works, but clicks go nowhere.

The cause is on the server. Win32-OpenSSH creates its pty through the **system
ConPTY**, and on Windows 10 that path runs the legacy `conhost.exe` from
System32. That conhost drops mouse sequences **in both directions**: the SGR
mouse bytes your terminal sends never reach the application, and the
`?1003;1006h` mouse-reporting mode the application tries to enable never makes
it back to your terminal. Neither end ever learns the other supports a mouse.

Background:

- [microsoft/terminal#9970](https://github.com/microsoft/terminal/pull/9970) — ConPTY mouse-input passthrough
- [PowerShell/Win32-OpenSSH#1835](https://github.com/PowerShell/Win32-OpenSSH/issues/1835) — mouse events not forwarded
- [PowerShell/Win32-OpenSSH#1990](https://github.com/PowerShell/Win32-OpenSSH/issues/1990) — ConPTY / terminal handling

Newer ConPTY builds fixed this, but the sshd on an unpatched Windows 10 box
still binds the old one, and you generally cannot swap it out.

## The fix

Don't let sshd allocate the pty at all. Connect with `ssh -T` (no pty), and have
a small relay on the far side build its **own** ConPTY from the modern
`conpty.dll` that ships inside `node-pty`:

```
your terminal ──raw bytes──> ssh -T (no pty) ──> relay.js ──ConPTY(conpty.dll)──> bash / TUI
```

Because `ssh -T` never requests a pty, nothing in the SSH path rewrites the byte
stream, and the relay owns a ConPTY new enough to pass mouse sequences through.

The tradeoff: no remote pty means no `SIGWINCH`, so window resizes travel
[in band](#in-band-resize-protocol) instead.

## Requirements

**Client** — Node.js (any recent version) and an `ssh` binary. macOS, Linux and
Windows are all supported; on a Windows client see
[the client-side console mode](#the-windows-client-has-the-same-bug) for one
extra thing wssh has to fix locally.

**Remote** — Windows with Node.js on `PATH`, and a copy of **node-pty built with
the bundled new ConPTY**, i.e. one containing
`build/Release/conpty/conpty.dll`. The system ConPTY is the thing being routed
around, so a node-pty without that file will not help. Two ways to get one:

1. **Copy from a VS Code Remote server install** (easiest — no build tools).
   `wssh --deploy` does this automatically, pulling the newest
   `~/.vscode-server/bin/*/node_modules/node-pty` that contains `conpty.dll`.
2. **Install it yourself**: `cd ~/wssh-relay && npm install node-pty`
   (needs node-pty ≥ 1.1).

## Install

```sh
npm install -g github:0dian/wssh   # then: wssh --deploy my-box
```

This needs Node.js ≥ 18 and `git` on the client. (An npm package will follow;
the GitHub install is the supported path for now.)

Or, without npm — clone the repo:

```sh
git clone https://github.com/0dian/wssh.git ~/wssh
chmod +x ~/wssh/wssh
ln -s ~/wssh/wssh /usr/local/bin/wssh     # or anywhere on your PATH
```

The shim resolves symlinks, so it can live anywhere.

Then push the remote half (idempotent, re-run it any time):

```sh
wssh --deploy my-box
```

This creates `~/wssh-relay/` on the remote, uploads `relay.js` and
`run-remote.sh` over the SSH connection you already have, sorts out node-pty as
described above, and verifies the result by `require()`-ing it. On Windows,
the npm install gives you `wssh` directly as the entry point; with the git
clone, use `wssh.cmd` instead.

## Usage

```
wssh [options] [user@]host [-- command [args...]]
```

With no command you get the remote login shell. Anything after `--` runs
instead.

### ssh config is a first-class citizen

`wssh` **never parses `~/.ssh/config`**. The host token and every connection
option are handed to the system `ssh` verbatim, so `Host` aliases, `User`,
`Port`, `IdentityFile`, `ProxyJump`, `ControlMaster` and the rest apply exactly
as they do when you type `ssh` yourself.

| Option | Meaning |
|---|---|
| `-p <port>` | remote port |
| `-i <keyfile>` | identity file |
| `-J <jump>` | ProxyJump target |
| `-o <opt=value>` | any ssh option (repeatable) |

Your `-o` is placed ahead of the tool's own defaults, so it always wins — ssh
keeps the first value it sees for a given parameter. `wssh` forces only `-T` (no
remote pty, the premise of the whole design) and `-e none` (no escape character,
so every byte belongs to the remote program).

### Tool options

| Option | Meaning |
|---|---|
| `--remote-dir <path>` | remote bundle dir, relative to the remote HOME (default `wssh-relay`) |
| `--deploy` | install/refresh the remote bundle, then exit |
| `--debug` | relay diagnostics on stderr (will scribble over a TUI) |
| `--dump-stdin` | diagnostic: no ssh at all, just hex-dump what this terminal delivers to stdin, plus the console modes around it. Quit with Ctrl-]. |
| `-h`, `--help` | help |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `WSSH_NODE` | first `node` on PATH | node binary for the client shim |
| `WSSH_REMOTE` | `wssh-relay` | remote bundle dir (same as `--remote-dir`) |

### Examples

```sh
wssh my-box                                   # interactive remote shell
wssh my-box -- herdr                          # straight into a TUI
wssh my-box -- powershell
wssh my-box -- cmd.exe
wssh -p 2022 -i ~/.ssh/id_ed25519 user@192.0.2.10
wssh -J bastion my-box
wssh --remote-dir tools/wssh-relay my-box
```

Exit the way the remote program exits (`exit` in a shell). Note that in raw mode
Ctrl-C is delivered to the remote program as byte `0x03` — correct behaviour for
a shell or TUI — so it will not kill the client.

## How it works

### The Windows client has the same bug

Fixing the remote is only half the job: on a Windows *client* the click dies
before it ever leaves the machine, and for a reason that has nothing to do with
which terminal emulator you use.

Node's `stdin.setRawMode(true)` — which any interactive client must call — is
implemented by libuv as a flat overwrite of the console input mode:

```
CONIN$ mode  0x01F7  ──setRawMode(true)──>  0x0008   (ENABLE_WINDOW_INPUT only)
```

That drops `ENABLE_MOUSE_INPUT` and never sets
`ENABLE_VIRTUAL_TERMINAL_INPUT`, which closes both routes a mouse event could
take into the process: the console will not hand it over as VT bytes, and
libuv's reader only turns `KEY_EVENT` records into stdin data — `MOUSE_EVENT`
records are dropped. Keyboard keeps working, so the failure looks like a remote
problem. It is not; the bytes never existed locally.

So on win32, right after raw mode is set, wssh ORs the mode with
`ENABLE_VIRTUAL_TERMINAL_INPUT`:

```
0x0008  ──|= 0x0200──>  0x0208
```

and the console stops interpreting and simply forwards what the terminal sent,
so `ESC [ < 0 ; col ; row M` arrives in stdin verbatim and is piped to the relay
like any keystroke. There is no `SetConsoleMode` in stock Node, so this is one
`powershell -EncodedCommand` round trip using P/Invoke — no dependency, no
build step, ~200 ms. If it fails, wssh prints one warning and connects anyway:
you get a working session without a mouse rather than no session.

The original mode is captured beforehand and restored on exit. That restore is
worth doing on its own: libuv does not put back what it found either, it assigns
a fixed `0x0007`, so plain Node silently costs the console its quick-edit and
insert-mode bits. wssh hands the console back exactly as it was.

Windows Terminal is still the recommendation — but as a terminal it was never
the problem here, and this fix is independent of it.

### In-band resize protocol

With no remote pty there is no `SIGWINCH` to forward, so size changes are
encoded into the input stream:

```
ESC ] 77577 ; <cols> ; <rows> BEL
```

The client emits this whenever the window changes; `relay.js` **strips** it back
out and calls `pty.resize()`, passing every other byte through untouched. The
scanner handles a sequence split across reads and caps its hold-back at 64 bytes
so a truncated sequence can never swallow your input. 77577 is a private OSC
number — xterm assigns nothing above 10000.

The client hooks `process.stdout.on('resize')` (fires on macOS, Linux and
Windows Terminal alike) with `SIGWINCH` as a POSIX-only backstop, deduplicated
by last known size.

### UTF-8 fidelity

`relay.js` decodes stdin through `StringDecoder('utf8')` before writing to the
pty, and node-pty re-encodes it as UTF-8 — a lossless round trip. A multi-byte
character split across TCP reads is reassembled correctly. (Decoding as
`latin1`, the obvious shortcut, mangles every non-ASCII character.)

The relay also sets `TERM=xterm-256color` for the child: `ssh -T` sets no `TERM`
at all, and node-pty does not export one on Windows, so without this a shell
would believe it was on a dumb terminal — no colours, crippled readline.

### Path independence

The remote bundle hardcodes no user name or install path. `run-remote.sh`
locates itself via `$(dirname "$0")` and converts that to a native Windows path
with `pwd -W` (Git Bash reports `/c/Users/...`, which Node on Windows cannot
resolve); the relay's cwd comes from `$USERPROFILE`. The same bundle works under
any Windows account.

## wsshd — the same fix on the server side

`wssh` needs Node on the *client*. When you do not control the client — a phone
app such as Moshi or Termius, or a plain `ssh -t` from a machine you cannot
install things on — run the fix on the Windows host instead: **`wsshd`** is a
small SSH server (`server/wsshd.js`, built on `ssh2`) that answers pty requests
with a session inside the same modern ConPTY relay.js uses. Any stock client
that asks for a pty then gets a shell where TUIs receive mouse input.

```
phone / ssh -t  ──SSH──►  wsshd :2222  ──ConPTY(conpty.dll)──►  bash / herdr
```

It runs **next to** the stock sshd, never instead of it: port 22 keeps serving
scp, VS Code Remote and automation. wsshd is public-key only (it reads the same
`authorized_keys` files as sshd), does shell / exec / pty / env / window-change,
and deliberately has no sftp, port forwarding or agent forwarding. Full deploy
notes, the required `RunLevel Highest` scheduled task, and the `npm install`
trap that deletes the bundled node-pty are in [server/README.md](server/README.md).
`server/mousetest.js` is a probe that proves mouse bytes arrive without a human.

## Limitations

- **Cold start.** A fresh ConPTY plus the SSH handshake takes roughly 6–11
  seconds before the first prompt appears. The client prints a
  `connecting ... (first paint takes ~10s)` line meanwhile. This is ConPTY's own
  startup cost, not the network.
- **Windows remotes only.** The whole design is about ConPTY. Against a Linux
  remote, plain `ssh -t` already works.
- **Aimed at Windows 10 / unpatched Win32-OpenSSH.** On a system whose ConPTY
  already forwards mouse input, you do not need this.
- **A Windows client needs PowerShell on PATH.** That is where the one-shot
  `SetConsoleMode` helper runs; see
  [the client-side console mode](#the-windows-client-has-the-same-bug). Without
  it you still get a session, just no mouse, and a warning saying so. Windows
  Terminal remains the recommended host, but the console-mode fix is what makes
  the mouse work and it is independent of the terminal.
- **TUI capability probes.** Some applications only enable mouse reporting after
  the terminal answers `ESC [ c` (Device Attributes). Real terminals always do,
  so interactive use is fine — but piping the output to a file will not get you
  a mouse.
- **Ctrl-C cannot kill the client** (raw mode gives it to the remote program).
  To force-quit, `pkill -f wssh.js` from another terminal.
- If a session dies abnormally the client still disables mouse reporting and
  restores the cursor; `stty sane` always works as a last resort.

## Uninstall

```sh
rm -f /usr/local/bin/wssh
rm -rf ~/wssh
ssh my-box 'rm -rf "$HOME/wssh-relay"'
# if wsshd was deployed: also unregister its scheduled task on the host
# powershell Unregister-ScheduledTask -TaskName wsshd -Confirm:$false
```

## License

MIT — see [LICENSE](LICENSE).
