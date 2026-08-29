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

- Listens on `WSSHD_BIND` (default `127.0.0.1,100.81.19.53`) port `WSSHD_PORT` (2222).
  Bind it to loopback and the tailnet IP only; never to a public interface.
- **Public-key auth only**, against the same files sshd reads
  (`C:\ProgramData\ssh\administrators_authorized_keys` and `~/.ssh/authorized_keys`),
  re-read on every attempt. Passwords are never accepted.
- `shell`, `exec`, `pty-req`, `env` (TERM / LANG / LC_* / COLORTERM), `window-change`.
- Shell is Git Bash (`bash -l -i`; `exec` runs `bash -lc "<cmd>"`). Override with `WSSHD_SHELL`.
- **No** sftp/scp, port forwarding, agent forwarding, X11. Keep using port 22 for
  VS Code Remote, scp and automation — `exec` output here carries ConPTY control
  sequences and CRLF, it is for humans, not scripts.
- Host key: `~/.ssh/wsshd_host_ed25519`, generated with `ssh-keygen` on first start.
- Log: `wsshd.log` next to the script (`WSSHD_LOG`).

## Layout on the host

```
~/wssh-relay/
  relay.js, run-remote.sh      # wssh remote half (managed by `wssh --deploy`)
  node_modules/node-pty/       # the node-pty that ships build/Release/conpty/conpty.dll
  wsshd.js, mousetest.js       # this
  deps/package.json            # {"dependencies": {"ssh2": "^1.16.0"}}
  deps/node_modules/ssh2       # installed with `cd deps && npm install`
```

`ssh2` lives in `deps/` on purpose: running `npm install` in the relay dir itself
prunes the bundled `node-pty` as "extraneous" — and with it the `conpty.dll`
everything depends on. Never `npm install` in `~/wssh-relay` directly.

## Deploy (Windows host)

1. `wssh --deploy <host>` first, so `~/wssh-relay/node_modules/node-pty` exists.
2. Copy `wsshd.js` and `mousetest.js` into `~/wssh-relay/`.
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

## Proving the mouse works without a human

```
ssh -tt -p 2222 user@host node C:/Users/<u>/wssh-relay/mousetest.js
```
prints `MOUSETEST-READY`; send the bytes `ESC [ < 0;10;5 M` from the client
(expect: `send "\x1b\[<0;10;5M"`). `MOUSE-OK` means they arrived. The same
probe through port 22 on an old conhost ends in `MOUSE-TIMEOUT`.
