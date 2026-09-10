# wssh — 让 Windows 远端的终端真正好用

SSH 到 Windows 机器，拿到一个**鼠标真正能用**的 shell。在里面跑任何 TUI，点击、
滚动、拖拽，和本地一样。

```sh
wssh my-box              # 交互式远程 shell
wssh my-box -- herdr     # 或者直接进某个 TUI
```

*（English version: [README.md](README.md)）*

## 问题

用 `ssh -t` 连到 Windows 机器跑一个鼠标驱动的 TUI，鼠标是死的。键盘正常、渲染正常，
就是点了没反应。

根因在服务端。Win32-OpenSSH 通过**系统 ConPTY** 创建 pty，而在 Windows 10 上这条
路径用的是 System32 里的老 `conhost.exe`。那个 conhost **双向丢弃鼠标序列**：你的
终端发出的 SGR 鼠标字节到不了远端程序，远端程序想开启的 `?1003;1006h` 鼠标上报模式
也传不回你的终端。两端谁也不知道对方支持鼠标。

相关资料：

- [microsoft/terminal#9970](https://github.com/microsoft/terminal/pull/9970) — ConPTY 鼠标输入透传
- [PowerShell/Win32-OpenSSH#1835](https://github.com/PowerShell/Win32-OpenSSH/issues/1835) — 鼠标事件未转发
- [PowerShell/Win32-OpenSSH#1990](https://github.com/PowerShell/Win32-OpenSSH/issues/1990) — ConPTY / 终端处理

新版 ConPTY 已经修了这个问题，但没打补丁的 Windows 10 上 sshd 绑定的还是老的那个，
而且一般换不掉。

## 解法

干脆不让 sshd 分配 pty。用 `ssh -T`（无 pty）连接，让远端的一个小中继自己用
`node-pty` 里附带的**新版 `conpty.dll`** 建一个 ConPTY：

```
本地终端 ──raw bytes──> ssh -T (无 pty) ──> relay.js ──ConPTY(conpty.dll)──> bash / TUI
```

因为 `ssh -T` 根本不申请 pty，SSH 链路上没有任何东西会改写字节流；而中继手里那个
ConPTY 足够新，鼠标序列能正常通过。

代价：没有远程 pty 就没有 `SIGWINCH`，所以窗口缩放改走[带内协议](#带内-resize-协议)。

## 你需要哪一半

同一个修复分成两半，分别处理连接的两端——按你实际能控制哪一端来选：

- **你能控制客户端，且客户端能装 Node** —— 用下面的 `wssh`，走标准的 22
  端口，远端只需要 Node + node-pty，不需要别的。
- **你控制不了客户端**（手机上的 SSH App、装不了任何东西的机器）——改用
  [`wsshd`](#wsshd--同一个修法搬到服务端)，**客户端零安装**；配置方法见
  [server/README.md](server/README.md)。

这是同一个修复的两端，不是二选一的竞品——同一台主机上两个都部署也没问题。

## 环境要求（wssh）

以下要求只针对 `wssh` 这条路径——还没想好选哪条的话，先看
[你需要哪一半](#你需要哪一半)。走 wsshd 的话客户端什么都不需要装。

**客户端** — Node.js（较新版本即可）和 `ssh`。macOS、Linux、Windows 都支持；
Windows 客户端另有一处必须在本地修掉的东西，见
[Windows 客户端也有同一个 bug](#windows-客户端也有同一个-bug)。

**远端** — Windows，`PATH` 里有 Node.js，以及一份**带新版 ConPTY 的 node-pty**，
也就是包含 `build/Release/conpty/conpty.dll` 的那种。系统自带的 ConPTY 正是我们要
绕开的东西，所以缺这个文件的 node-pty 没有用。两条获取路径：

1. **从 VS Code Remote server 装的那份复制**（最省事，不需要编译工具链）。
   `wssh --deploy` 会自动做：挑 `~/.vscode-server/bin/*/node_modules/node-pty` 里
   最新的、且含 `conpty.dll` 的那份。
2. **自己装**：`cd ~/wssh-relay && npm install node-pty`（需要 node-pty ≥ 1.1）。

## 安装

```sh
npm install -g github:0dian/wssh   # 然后：wssh --deploy my-box
```

客户端需要 Node.js ≥ 18 和 git。（npm 包稍后跟上，目前以 GitHub 安装为准。）

或者不用 npm，直接 clone 仓库：

```sh
git clone https://github.com/0dian/wssh.git ~/wssh
chmod +x ~/wssh/wssh
ln -s ~/wssh/wssh /usr/local/bin/wssh     # 或者 PATH 里任何位置
```

薄壳会自己解引用软链，所以放哪儿都行。

然后部署远端那一半（幂等，随时可重跑）：

```sh
wssh --deploy my-box
```

它会在远端建 `~/wssh-relay/`，用已有的这条 SSH 连接上传 `relay.js` 和
`run-remote.sh`，按上面说的方式解决 node-pty，最后用 `require()` 验证一次。
用 npm 安装的话 Windows 上直接用 `wssh` 作为入口；用 git clone 的话，
Windows 上用 `wssh.cmd` 作为入口。

## 用法

```
wssh [选项] [user@]host [-- 命令 [参数...]]
```

**不给命令就是进远端登录 shell**。`--` 之后可以指定要跑的程序。

### ssh config 是一等公民

`wssh` **不解析 `~/.ssh/config`**，而是把 host token 和所有连接选项**原样交给系统
`ssh`**。因此 `Host` 别名、`User`、`Port`、`IdentityFile`、`ProxyJump`、
`ControlMaster` 等全部照常生效，和你平时敲 `ssh` 完全一致。

| 选项 | 说明 |
|---|---|
| `-p <port>` | 远端端口 |
| `-i <keyfile>` | 身份文件 |
| `-J <jump>` | ProxyJump |
| `-o <opt=value>` | 任意 ssh 选项，可重复 |

你给的 `-o` 排在工具自己的默认值前面，所以**永远优先**（ssh 对同一参数取第一个出现
的值）。工具只强制 `-T`（不要远程 pty，整个方案的前提）和 `-e none`（不要转义字符，
每个字节都属于远端程序）。

### 工具自己的选项

| 选项 | 说明 |
|---|---|
| `--remote-dir <path>` | 远端 bundle 目录，相对远端 HOME，默认 `wssh-relay` |
| `--deploy` | 安装/刷新远端组件后退出 |
| `--debug` | 远端 relay 诊断输出到 stderr（会画花 TUI） |
| `--dump-stdin` | 诊断用：完全不连 ssh，只把本地终端送进 stdin 的字节按十六进制打出来，并打印前后的控制台模式。Ctrl-] 退出。 |
| `-h`, `--help` | 帮助 |

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WSSH_NODE` | PATH 里第一个 `node` | 客户端薄壳用的 node |
| `WSSH_REMOTE` | `wssh-relay` | 远端 bundle 目录（同 `--remote-dir`） |

### 例子

```sh
wssh my-box                                   # 交互式远程 shell
wssh my-box -- herdr                          # 直接进某个 TUI
wssh my-box -- powershell
wssh my-box -- cmd.exe
wssh -p 2022 -i ~/.ssh/id_ed25519 user@192.0.2.10
wssh -J bastion my-box
wssh --remote-dir tools/wssh-relay my-box
```

退出方式就是远端程序自己的退出方式（shell 里 `exit`）。注意 raw 模式下 Ctrl-C 会
作为 `0x03` 字节交给远端程序（shell / TUI 应有的行为），不会杀掉客户端。

## 原理

### Windows 客户端也有同一个 bug

只修远端只做了一半：在 Windows *客户端*上，鼠标点击根本没能离开这台机器，而且原因
跟你用哪个终端模拟器毫无关系。

任何交互式客户端都必须调用的 `stdin.setRawMode(true)`，libuv 在 win32 上的实现是
把控制台输入模式整个覆盖掉：

```
CONIN$ mode  0x01F7  ──setRawMode(true)──>  0x0008   （只剩 ENABLE_WINDOW_INPUT）
```

这既丢掉了 `ENABLE_MOUSE_INPUT`，也从没开过
`ENABLE_VIRTUAL_TERMINAL_INPUT`，于是鼠标事件进入进程的两条路同时被堵死：控制台
不会把它当作 VT 字节交出来，而 libuv 的读取端只把 `KEY_EVENT` 翻译成 stdin 数据，
`MOUSE_EVENT` 直接丢弃。键盘照常工作，所以现象看起来像是远端的问题——不是，那些
字节在本地就不曾存在过。

所以在 win32 上，raw 模式设好之后，wssh 紧接着把模式或上
`ENABLE_VIRTUAL_TERMINAL_INPUT`：

```
0x0008  ──|= 0x0200──>  0x0208
```

控制台就不再自作主张翻译，而是原样转发终端发来的东西，`ESC [ < 0 ; 列 ; 行 M`
逐字节落进 stdin，然后和普通按键一样被送给 relay。Node 本身没有 `SetConsoleMode`，
所以这里是一次 `powershell -EncodedCommand` 的 P/Invoke 往返——零依赖、无需编译、
约 200 毫秒。万一失败，wssh 只打一行警告然后照常连接：宁可给你一个没有鼠标的可用
会话，也不要没有会话。

原始模式会在动手之前记下来，退出时还回去。这个还原本身就值得做：libuv 也不还原它
看到的模式，而是写死成 `0x0007`，所以裸 Node 会悄悄让控制台丢掉快速编辑和插入模式
这些位。wssh 把控制台原样交还。

Windows Terminal 仍然是推荐的宿主——但在这件事上它从来不是问题所在，这个修复也跟
它无关。

### 带内 resize 协议

没有远程 pty 就没有 `SIGWINCH` 可转发，所以尺寸变化编码进输入流：

```
ESC ] 77577 ; <cols> ; <rows> BEL
```

客户端在窗口变化时发送，`relay.js` 把它从流里**剥离**并调用 `pty.resize()`，其余
字节原样透传。扫描逻辑处理跨 read 切开的序列，并把暂存上限设为 64 字节，保证残缺
序列不会永久吞掉输入。77577 是私有 OSC 号——xterm 在 10000 以上没有分配。

客户端主钩子是 `process.stdout.on('resize')`（macOS / Linux / Windows Terminal 都
触发），POSIX 上额外挂 `SIGWINCH` 兜底，按上次尺寸去重。

### UTF-8 保真

`relay.js` 用 `StringDecoder('utf8')` 解码 stdin 再写进 pty，node-pty 会按 UTF-8
重新编码——往返无损。被 TCP 切在多字节字符中间的输入也能正确拼回。（用 `latin1`
这个看起来省事的写法会把所有非 ASCII 字符打烂。）

中继还会给子进程设 `TERM=xterm-256color`：`ssh -T` 根本不设 `TERM`，node-pty 在
Windows 上也不导出，不补的话 shell 会以为自己在哑终端里——没颜色、readline 残废。

### 路径无关

远端组件不含任何硬编码用户名或安装路径。`run-remote.sh` 用 `$(dirname "$0")` 定位
自己，再用 `pwd -W` 转成 Windows 原生路径（Git Bash 报的是 `/c/Users/...`，Node 在
Windows 上解析不了）；中继的 cwd 用 `$USERPROFILE`。同一份 bundle 拷到任何 Windows
账户下都能用。

## wsshd —— 同一个修法搬到服务端

`wssh` 要求**客户端**有 Node。客户端不由你掌控时——手机上的 Moshi、Termius，
或者一台装不了东西的机器上的普通 `ssh -t`——就把修法放到 Windows 主机上：
**`wsshd`**（`server/wsshd.js`，基于 `ssh2`）是一个小 SSH 服务，收到 pty 请求后
用和 relay.js 相同的新版 ConPTY 起会话。任何申请 pty 的普通客户端连上来，TUI
里的鼠标都能用。

```
手机 / ssh -t  ──SSH──►  wsshd :2222  ──ConPTY(conpty.dll)──►  bash / herdr
```

它和系统自带的 sshd **并排跑**，不是替代：22 端口照旧服务 scp、VS Code Remote
和自动化。wsshd 只认公钥（读的是 sshd 同一份 `authorized_keys`），支持
shell / exec / pty / env / window-change，刻意不做 sftp、端口转发和 agent 转发。
部署步骤、必须以 `RunLevel Highest` 运行的计划任务、以及 `npm install` 会删掉
自带 node-pty 的坑，都在 [server/README.md](server/README.md)。
`server/mousetest.js` 是一个探针，不用人手就能证明鼠标字节到没到。

### 手机快速上手

1. 手机上**什么都不装**，只在 App 里新建一个主机：host = 主机的 tailnet
   IP，port = 2222，认证方式 = 公钥。
2. 把 App 生成的公钥加进主机的 `authorized_keys`（和 sshd 读的是同一批
   文件）。
3. **`WSSHD_BIND` 默认是 `127.0.0.1`**——必须把 tailnet IP 也加进去手机才
   连得上，例如 `WSSHD_BIND=127.0.0.1,100.x.y.z`。这是最常见的“连不上”
   原因。

## 已知限制

- **冷启动慢**。新建 ConPTY 加上 SSH 握手，第一个提示符大约要 6–11 秒。客户端会先
  打一行 `connecting ... (first paint takes ~10s)`。这是 ConPTY 本身的开销，不是网络
  问题。
- **只针对 Windows 远端**。整个设计是围绕 ConPTY 的；对 Linux 远端，`ssh -t` 本来
  就好使。
- **面向 Windows 10 / 未打补丁的 Win32-OpenSSH**。如果你的系统 ConPTY 已经能转发
  鼠标，就不需要这个工具。
- **Windows 客户端需要 PATH 上有 PowerShell**。那次性的 `SetConsoleMode` helper
  就在那儿跑，见 [Windows 客户端也有同一个 bug](#windows-客户端也有同一个-bug)。
  没有它你照样能开会话，只是没有鼠标，并且会看到一行警告。Windows Terminal 依然是
  推荐宿主，但让鼠标能用的是那个控制台模式修复，跟终端本身无关。
- **TUI 的终端能力探测**。有些程序只有在终端回应了 `ESC [ c`（Device Attributes）
  之后才开启鼠标上报。真实终端都会回应，所以交互使用没问题；但把输出重定向到文件
  就没有鼠标。
- **wsshd 补不出客户端压根没发的鼠标字节。** wsshd 只修了“服务端到 TUI”
  这一段；如果 SSH App 本身不发送 SGR 鼠标序列，就没有字节可中继。多数
  安卓 SSH 客户端在触屏上默认不实现 xterm 鼠标上报——先去 App 设置里找
  “mouse reporting”/“mouse mode”/触摸当鼠标 这类开关。如果确实没有，
  退而求其次可以给手机接蓝牙/USB 鼠标，看 App 会不会把它转成鼠标序列。
  怎么判定见 server/README.md 的
  [Proving the mouse works without a human](server/README.md#proving-the-mouse-works-without-a-human)
  一节——我们没有具体 App 的实测数据，所以这里刻意不点名任何一个 App 支持
  或不支持。
- **Ctrl-C 杀不掉客户端**（raw 模式下它归远端程序）。要强杀请从另一个终端
  `pkill -f wssh.js`。
- 会话异常结束时客户端仍会关掉鼠标上报、恢复光标；实在不行 `stty sane` 总能救。

## 卸载

```sh
rm -f /usr/local/bin/wssh
rm -rf ~/wssh
ssh my-box 'rm -rf "$HOME/wssh-relay"'
# 部署过 wsshd 的话，主机上再注销它的计划任务
# powershell Unregister-ScheduledTask -TaskName wsshd -Confirm:$false
```

## 许可证

MIT — 见 [LICENSE](LICENSE)。
