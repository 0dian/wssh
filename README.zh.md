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

## 环境要求

**客户端** — Node.js（较新版本即可）和 `ssh`。macOS、Linux 或 Windows Terminal。

**远端** — Windows，`PATH` 里有 Node.js，以及一份**带新版 ConPTY 的 node-pty**，
也就是包含 `build/Release/conpty/conpty.dll` 的那种。系统自带的 ConPTY 正是我们要
绕开的东西，所以缺这个文件的 node-pty 没有用。两条获取路径：

1. **从 VS Code Remote server 装的那份复制**（最省事，不需要编译工具链）。
   `wssh --deploy` 会自动做：挑 `~/.vscode-server/bin/*/node_modules/node-pty` 里
   最新的、且含 `conpty.dll` 的那份。
2. **自己装**：`cd ~/wssh-relay && npm install node-pty`（需要 node-pty ≥ 1.1）。

## 安装

```sh
git clone https://github.com/<you>/wssh.git ~/wssh
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

## 已知限制

- **冷启动慢**。新建 ConPTY 加上 SSH 握手，第一个提示符大约要 6–11 秒。客户端会先
  打一行 `connecting ... (first paint takes ~10s)`。这是 ConPTY 本身的开销，不是网络
  问题。
- **只针对 Windows 远端**。整个设计是围绕 ConPTY 的；对 Linux 远端，`ssh -t` 本来
  就好使。
- **面向 Windows 10 / 未打补丁的 Win32-OpenSSH**。如果你的系统 ConPTY 已经能转发
  鼠标，就不需要这个工具。
- **Windows *客户端*必须用 Windows Terminal**（或其他支持 VT 的宿主）。传统 conhost
  窗口会在客户端这一侧重现同样的鼠标丢失——远端修好了，本地终端瞎了也没用。
  *（未实测：Windows 客户端整条路径没有端到端跑过。）*
- **TUI 的终端能力探测**。有些程序只有在终端回应了 `ESC [ c`（Device Attributes）
  之后才开启鼠标上报。真实终端都会回应，所以交互使用没问题；但把输出重定向到文件
  就没有鼠标。
- **Ctrl-C 杀不掉客户端**（raw 模式下它归远端程序）。要强杀请从另一个终端
  `pkill -f wssh.js`。
- 会话异常结束时客户端仍会关掉鼠标上报、恢复光标；实在不行 `stty sane` 总能救。

## 卸载

```sh
rm -f /usr/local/bin/wssh
rm -rf ~/wssh
ssh my-box 'rm -rf "$HOME/wssh-relay"'
```

## 许可证

MIT — 见 [LICENSE](LICENSE)。
