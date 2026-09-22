#!/usr/bin/env python3
"""phone-view -- text-only herdr client for phone SSH sessions.

Background: herdr panes have exactly one shared pty with one width. Whichever
client last focused/selected/interacted with a tab controls that pane's size
(see herdr's concepts.mdx). A phone client at ~50 columns and a desktop
client at 131/183 columns fighting over the same pane corrupts the desktop's
scrollback (already-wrapped lines baked in at phone width) and duplicates
screens (Claude Code repaints its whole view into scrollback on every resize).

The fix here is to never become a client at all. This script only shells out
to the handful of herdr CLI subcommands that are query/one-shot RPCs against
the running server and do not open a terminal session or touch pty size:

    herdr agent list
    herdr agent read   <target> --source recent-unwrapped --lines N --format text
    herdr pane get     <pane_id>
    herdr agent prompt <target> <text> [--wait --until STATUS --timeout MS]
    herdr agent send-keys <target> <key>...
    herdr agent wait   <target> [--until STATUS --timeout MS]

Stable/active split (contract 4.2.5, rewritten in round 2): Claude Code
repaints its *entire viewport* on every refresh, not just an input box at the
bottom, so no set of border/spinner characters reliably marks "the part that
might still be rewritten." The only thing that is reliably true is that
scrollback rows (everything that has scrolled out of the viewport) are never
rewritten, and viewport rows (the last `viewport_rows` lines of a snapshot,
from `herdr pane get`) can be rewritten in place at any time. So the split is
purely positional: stable = snapshot[:-V], active = snapshot[-V:].
Round 5 (方案丁) additionally pins the depth of the stable window used for
round-to-round diffing at MAX_STABLE rows, independent of `--lines N`; see
the comment on that constant.

Verified empirically (see dispatch report 20260920-phone-view.md): running
these produces zero new lines in herdr-server.log matching client-connect or
client-resize patterns. `herdr terminal attach` / `terminal session control`
/ `terminal session observe` are never called from this script, except the
explicit `:a` escape hatch below, which intentionally shells out to the
termrover-attach compatibility shim for a real-time view and is expected to
produce those log lines (that is the whole point of the escape hatch).
"""

import argparse
import json
import os
import queue
import shlex
import shutil
import subprocess
import sys
import threading
import time
import unicodedata

# --- herdr binary resolution (mirrors termrover-attach.js resolveHerdrBin()) ---

DEFAULT_HERDR_BIN = os.path.join(
    os.environ.get('USERPROFILE') or os.path.expanduser('~'),
    'AppData', 'Local', 'Programs', 'Herdr', 'bin', 'herdr.exe',
)


def resolve_herdr_bin():
    return os.environ.get('HERDR_REAL') or os.environ.get('HERDR_BIN_PATH') or DEFAULT_HERDR_BIN


HERDR_BIN = resolve_herdr_bin()

TERMROVER_ATTACH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'termrover-attach')

DEFAULT_LINES = 200  # 5b-3 (round 4): round 3 raised this to 600 on the theory
# that a bigger stable window lowers the chance of a resync. That theory
# assumed 5a's premise -- "content that has scrolled out of the viewport is
# never rewritten again" -- holds in practice. It doesn't: Claude Code
# repaints content well below the viewport (e.g. collapsing a tool output
# into `... +N lines (ctrl+o to expand)` well after it scrolled out), and a
# deeper window just means more of that gets caught and misread as an
# unreconcilable jump. Measured on a real busy pane (wQ:p4S, 40 rounds):
# 200-line window -> 4 lines emitted, 0 resyncs; 600-line window -> 2887
# lines emitted, 6 resyncs. Reverted to 200. See 5b-4 for the other half of
# the fix: even when a resync *does* happen, it must not reprint the whole
# window.
POLL_INTERVAL_SEC = 1.0
DEFAULT_VIEWPORT_ROWS = 45  # machine-measured fallback if `pane get` ever fails
# (moved up from its original spot near viewport_rows() so it's defined
# before stable_increment_with_marker's default arg below needs it)

# --- display-width-aware wrapping (CJK = 2 columns, everything else = 1) ---


def char_width(ch):
    return 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1


def display_width(s):
    return sum(char_width(ch) for ch in s)


def wrap_line(line, width):
    """Split one logical line into segments whose display width is <= width."""
    width = max(1, width)
    if line == '':
        return ['']
    segments = []
    cur = []
    cur_w = 0
    for ch in line:
        w = char_width(ch)
        if cur_w + w > width and cur:
            segments.append(''.join(cur))
            cur = []
            cur_w = 0
        cur.append(ch)
        cur_w += w
    if cur:
        segments.append(''.join(cur))
    return segments


def wrap_lines(lines, width):
    out = []
    for line in lines:
        out.extend(wrap_line(line, width))
    return out


# --- active-region / stable-region split (contract 4.2.5, round 2) ---


MAX_STABLE = 150  # 方案丁 (round 5): how deep the *comparison* window goes.
# 5b-3 established that a deeper window is strictly worse for alignment --
# Claude Code rewrites content far above the viewport boundary (folding a
# finished tool output into `... +N lines (ctrl+o to expand)`), and every
# such rewrite inside the window forces a resync. Before this round the
# depth was `--lines N` minus V, so one knob controlled two unrelated
# things: how much history the user gets on entry, and how brittle the
# round-to-round alignment is. They are now separate: `--lines N` still
# sets the priming depth (`:n 600` exists for exactly that), while the
# window used to diff one poll against the next is pinned here at the
# depth 5b-3 measured as good. Live evidence, same 41 real `w0:pH`
# snapshots, only `stable` differing: stable=150 -> 7 lines / 0 resyncs;
# stable=368 -> 153 lines / 3 resyncs.


def split_by_viewport(snapshot, viewport_rows, max_stable=MAX_STABLE):
    """5a: stable = everything that has scrolled out of the viewport,
    active = the current viewport (last `viewport_rows` lines). No
    heuristics on line content -- purely positional, because Claude Code
    repaints the whole viewport, not just an input box at the bottom.

    The stable half is then capped at `max_stable` rows (方案丁, see the
    constant above). Pass `max_stable=None` for the uncapped region --
    follow() does that for its one-time priming dump, which must honour
    `--lines N` in full."""
    if viewport_rows <= 0:
        stable, active = list(snapshot), []
    elif len(snapshot) <= viewport_rows:
        stable, active = [], list(snapshot)
    else:
        stable, active = snapshot[:-viewport_rows], snapshot[-viewport_rows:]
    return (list(stable) if max_stable is None else stable[-max_stable:]), active


def align_increment(prev_stable, new_stable):
    """5b + 5b-2 (round 3): sliding-window alignment. Find the minimal
    d >= 0 such that prev_stable[d:] == new_stable[:len(new_stable) - d]
    (d is how many lines scrolled out of the stable window since last
    poll); the increment is new_stable[len(new_stable) - d:].

    Round 2's version accepted *any* d that matched, however short the
    overlap. Blank lines and box-drawing dividers (`────`, etc.) recur
    constantly, so after a large jump (e.g. `/compact` truncating
    history) it would routinely latch onto a single coincidentally-equal
    line at some large d, report resynced=False, and return a truncated
    "increment" -- 247 lines of real content silently vanished, with
    nothing in the output or stderr to show it happened.

    Fix (5b-2): only accept an alignment whose overlap length
    (q - d, which shrinks as d grows since d is searched smallest-first)
    is >= MIN_OVERLAP, which is half the previous window floored at 2 and
    capped at 10 -- never the whole window (that would misread legitimate
    scrolling in a small window as a jump) and never 1 (that would let a
    single coincidentally-equal line latch again). See the comment on
    min_overlap below. If no d in range
    clears that bar -- overlap_len is monotonically decreasing in d, so
    once one d falls below MIN_OVERLAP every larger d does too, and the
    scan can stop there -- this is an unreconcilable jump, not a
    coincidence. Fall back to reprinting new_stable in full and report
    resynced=True; the caller is responsible for making that visible
    (a marker line in the output, not just a log line -- see
    stable_increment_with_marker below) instead of dropping content
    silently.
    """
    q = len(new_stable)
    if q == 0:
        return [], False
    # The bar must never reach the whole window: the round-3 spec said
    # min(10, len(prev_stable)), so a 5-line window got a 5-line bar and any
    # real scroll was misread as an unreconcilable jump. It must also never
    # fall to 1, or a single coincidentally-equal line latches again -- the
    # very thing 5b-2 exists to stop. Half the window, floored at 2 and capped
    # at 10: 555-line window -> 10, 5-line startup window -> 2.
    min_overlap = min(10, max(2, len(prev_stable) // 2))
    for d in range(0, q):
        overlap_len = q - d
        if overlap_len < min_overlap:
            break
        if prev_stable[d:] == new_stable[:overlap_len]:
            return new_stable[q - d:], False
    return list(new_stable), True


RESYNC_MARKER = '⋯⋯ 输出过快或历史被截断,中间有内容未能显示 ⋯⋯'


def stable_increment_with_marker(prev_stable, new_stable, cap_rows=DEFAULT_VIEWPORT_ROWS):
    """5b-2 + 5b-4: align_increment(), plus the resync-visibility
    requirement -- when it resyncs, prepend RESYNC_MARKER to what gets
    printed so the marker itself scrolls into history (the caller must
    still log to stderr separately; that's a side effect, not something
    this pure function should do). Shared by follow() and the c3 replay
    test so both exercise the exact same "what actually gets printed"
    logic.

    5b-4 (round 4): align_increment() itself still returns the *entire*
    new_stable on an unreconcilable jump -- that return value is exercised
    directly by tests/c1_phone_view_unit.py case4 (frozen, not touched this
    round) and must keep meaning "here is everything the stable window
    currently holds". But reprinting the entire stable window into
    scrollback on every resync is exactly what turned 6 resyncs into 2887
    flooded lines on a real pane (round 3/4 measurement, 600-line window --
    2862 of those 2887 lines came from 6 full-window reprints). What
    actually gets *printed* is this function's job, and per 5b-4 that must
    be bounded: the marker line plus at most the last `cap_rows` lines of
    new_stable, never the whole window. `cap_rows` should be the caller's
    current viewport row count V (follow() passes its live value); the
    default here only covers callers -- e.g. the c3 replay test -- that
    call this with two positional args and reasonably run at V ==
    DEFAULT_VIEWPORT_ROWS themselves.
    """
    increment, resynced = align_increment(prev_stable, new_stable)
    if resynced:
        cap_rows = max(0, cap_rows)
        capped = new_stable[-cap_rows:] if cap_rows else []
        increment = [RESYNC_MARKER] + capped
    return increment, resynced


def trim_trailing_blank(lines):
    end = len(lines)
    while end > 0 and lines[end - 1].strip() == '':
        end -= 1
    return lines[:end]


def active_window(active, max_rows):
    """5c: from the active region's last non-blank line, walk backward at
    most max_rows lines."""
    trimmed = trim_trailing_blank(active)
    if max_rows <= 0:
        return []
    return trimmed[-max_rows:]


def render_active(active, width, max_rows):
    """5c: the wrapped rows actually drawn for the active region. Its
    length (post-wrap, not the raw line count) is what the caller must move
    the cursor up by to erase the previous redraw."""
    return wrap_lines(active_window(active, max_rows), width)


# --- herdr CLI wrappers ---


def run_herdr(args):
    return subprocess.run(
        [HERDR_BIN] + args, capture_output=True, text=True,
        encoding='utf-8', errors='replace',
    )


def agent_list():
    r = run_herdr(['agent', 'list'])
    data = json.loads(r.stdout)
    return data['result']['agents']


def agent_read(target, lines):
    r = run_herdr([
        'agent', 'read', target,
        '--source', 'recent-unwrapped', '--lines', str(lines), '--format', 'text',
    ])
    if r.returncode != 0:
        return None
    return r.stdout.splitlines()


def pane_get(target):
    r = run_herdr(['pane', 'get', target])
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        return None


def viewport_rows(target):
    """5a: result.pane.scroll.viewport_rows from `herdr pane get`. Returns
    None on any failure so the caller can fall back to a cached/default V."""
    data = pane_get(target)
    if data is None:
        return None
    try:
        return data['result']['pane']['scroll']['viewport_rows']
    except (KeyError, TypeError):
        return None


VIEWPORT_REFRESH_EVERY = 10  # 5a: "可缓存,每 10 轮刷新一次"


def agent_prompt_cmd(target, text):
    return [HERDR_BIN, 'agent', 'prompt', target, text]


def agent_sendkeys_cmd(target, keys):
    return [HERDR_BIN, 'agent', 'send-keys', target] + list(keys)


def agent_wait_cmd(target):
    return [HERDR_BIN, 'agent', 'wait', target, '--until', 'idle']


def cmd_to_str(cmd):
    return ' '.join(shlex.quote(part) for part in cmd)


def run_write(cmd, print_cmd):
    """agent prompt / agent send-keys: printed-not-executed under --print-cmd."""
    if print_cmd:
        print(cmd_to_str(cmd))
        return None
    return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')


def run_wait(target):
    """agent wait always executes for real -- it has no side effect, it only
    blocks until a state is observed, so --print-cmd does not gate it."""
    return subprocess.run(agent_wait_cmd(target), capture_output=True, text=True,
                           encoding='utf-8', errors='replace')


# --- list-mode formatting ---


def agent_title(agent):
    return agent.get('terminal_title_stripped') or agent.get('terminal_title') or agent.get('pane_id')


def format_agent_list(agents):
    lines = []
    for i, a in enumerate(agents, 1):
        status = a.get('agent_status', '?')
        lines.append('%2d. [%-7s] %s  %s' % (i, status, agent_title(a), a.get('cwd', '')))
    return lines


HELP_TEXT = '\n'.join([
    '命令:',
    '  <text> 回车      发送到当前 agent (agent prompt)',
    '  :k <key...>      发送按键 (agent send-keys), 例: :k down enter',
    '  :n <N>           修改回看行数 (默认 %d)' % DEFAULT_LINES,
    '  :w               等待 agent 进入 idle (agent wait --until idle)',
    '  :a               切到实时画面 (termrover-attach --takeover)',
    '                   退出实时画面用 ctrl+b q, 退出后自动回到本视图并重画',
    '  :q               跟随中: 回到列表; 列表中: 退出',
    '  :h               本帮助',
])


# --- interactive loop ---

_NO_MSG = object()


def stdin_reader(q):
    while True:
        line = sys.stdin.readline()
        if line == '':
            q.put(None)  # EOF sentinel
            return
        q.put(line.rstrip('\n'))


def select_agent(agents, q):
    print('\n'.join(format_agent_list(agents)))
    print('输入序号进入跟随, :q 退出, :h 帮助')
    while True:
        line = q.get()
        if line is None:
            return None
        line = line.strip()
        if line == '':
            continue
        if line == ':q':
            return None
        if line == ':h':
            print(HELP_TEXT)
            print('\n'.join(format_agent_list(agents)))
            continue
        if line.isdigit() and 1 <= int(line) <= len(agents):
            return agents[int(line) - 1]
        print('输入无效,请输入 1-%d 的序号' % len(agents))


def erase_rows(n):
    """Move the cursor up n rows and clear from there to end of screen --
    undoes exactly what draw_active(rows) with len(rows) == n drew."""
    if n > 0:
        sys.stdout.write('\x1b[%dA\x1b[J' % n)


def draw_active(rows):
    for row in rows:
        print(row)


def follow(agent, q, ns):
    """Follow mode for one agent. Returns 'back' (return to list) or 'eof'
    (stdin closed)."""
    target = agent['pane_id']
    term_id = agent.get('terminal_id')

    prev_stable = None      # None until the first snapshot is primed
    prev_active_rows = []   # last round's wrapped active-region rows
    erase_lines = 0         # L: rows to move up + clear before next redraw
    viewport = None         # V: cached, refreshed every VIEWPORT_REFRESH_EVERY rounds
    round_num = 0
    lines_too_small_warned = False

    while True:
        term_width, term_height = shutil.get_terminal_size(fallback=(80, 24))
        screen_disturbed = False  # something other than our own redraw printed this round

        # 1) drain at most one queued input line per loop iteration, non-blocking
        try:
            msg = q.get_nowait()
        except queue.Empty:
            msg = _NO_MSG

        if msg is None:
            return 'eof'
        if msg is not _NO_MSG:
            line = msg.strip()
            if line == '':
                pass
            elif line == ':q':
                return 'back'
            elif line == ':h':
                print(HELP_TEXT)
                screen_disturbed = True
            elif line.startswith(':k'):
                keys = line[2:].split()
                if keys:
                    run_write(agent_sendkeys_cmd(target, keys), ns.print_cmd)
                else:
                    print(':k 需要至少一个按键, 例: :k down enter')
                    screen_disturbed = True
            elif line.startswith(':n'):
                rest = line[2:].strip()
                if rest.isdigit():
                    ns.lines = int(rest)
                    print('回看行数改为 %d' % ns.lines)
                else:
                    print(':n 需要一个数字, 例: :n 300')
                screen_disturbed = True
            elif line == ':w':
                print('等待 %s 进入 idle...' % target)
                run_wait(target)
                print('等待结束')
                screen_disturbed = True
            elif line == ':a':
                if term_id:
                    print('切到实时画面 (退出用 ctrl+b q)...')
                    subprocess.call([TERMROVER_ATTACH, '--session', 'default',
                                      'terminal', 'attach', term_id, '--takeover'])
                    prev_stable = None  # force a full reprint on return
                    prev_active_rows = []
                    print('已回到文本视图')
                else:
                    print('这个 agent 没有 terminal_id, 无法使用 :a')
                screen_disturbed = True
            elif line.startswith(':'):
                print('未知命令: %s (:h 查看帮助)' % line)
                screen_disturbed = True
            else:
                run_write(agent_prompt_cmd(target, line), ns.print_cmd)

        if screen_disturbed:
            # Whatever we just printed already scrolled the previous active
            # redraw into normal history; there is nothing left "in place"
            # to erase for it.
            erase_lines = 0

        # 2) refresh V (5a: cached, refreshed every 10 rounds)
        if viewport is None or round_num % VIEWPORT_REFRESH_EVERY == 0:
            fetched = viewport_rows(target)
            viewport = fetched if fetched else (viewport or DEFAULT_VIEWPORT_ROWS)
        round_num += 1

        if not lines_too_small_warned and ns.lines <= viewport:
            print('警告: 回看行数 %d 应大于视口 %d, 否则稳定区会是空的' % (ns.lines, viewport))
            lines_too_small_warned = True

        # 3) poll one snapshot, split by viewport (5a), align (5b), redraw (5c)
        snapshot = agent_read(target, ns.lines)
        if snapshot is not None:
            stable, active = split_by_viewport(snapshot, viewport)

            if prev_stable is None:
                # 5b: first entry prints the whole stable region. 方案丁: the
                # priming dump is deliberately NOT capped at MAX_STABLE --
                # `--lines N` / `:n 600` exist to control exactly this depth.
                increment = split_by_viewport(snapshot, viewport, max_stable=None)[0]
            else:
                increment, resynced = stable_increment_with_marker(prev_stable, stable, viewport)
                if resynced:
                    # 5b-2: the marker line is already in `increment` (so it
                    # scrolls into history where the user can see it); this
                    # is the separate stderr record the contract also asks for.
                    print('resync: stable window realigned, marker printed', file=sys.stderr)
            prev_stable = stable

            max_active_rows = min(viewport, max(1, term_height - 2))
            new_active_rows = render_active(active, term_width, max_active_rows)

            if increment:
                erase_rows(erase_lines)
                for out_line in wrap_lines(increment, term_width):
                    print(out_line)
                draw_active(new_active_rows)
                erase_lines = len(new_active_rows)
            elif screen_disturbed or new_active_rows != prev_active_rows:
                erase_rows(erase_lines)
                draw_active(new_active_rows)
                erase_lines = len(new_active_rows)
            # else: active region unchanged and nothing else printed -- skip
            # the redraw entirely (5c: saves phone data, avoids flicker).

            prev_active_rows = new_active_rows
            sys.stdout.flush()

        time.sleep(POLL_INTERVAL_SEC)


def main(argv=None):
    parser = argparse.ArgumentParser(description='herdr 手机文本视图 (只读/无副作用 CLI, 不建客户端不发 resize)')
    parser.add_argument('--print-cmd', action='store_true',
                         help='写操作 (agent prompt / agent send-keys) 只打印命令,不执行')
    parser.add_argument('--lines', type=int, default=DEFAULT_LINES, help='跟随模式回看行数 (默认 %d)' % DEFAULT_LINES)
    ns = parser.parse_args(argv)

    q = queue.Queue()
    reader = threading.Thread(target=stdin_reader, args=(q,), daemon=True)
    reader.start()

    while True:
        try:
            agents = agent_list()
        except Exception as e:  # noqa: BLE001 -- surface any herdr/JSON failure to the user
            print('agent list 失败: %s' % e)
            return 1
        if not agents:
            print('没有 agent')
            return 0

        agent = select_agent(agents, q)
        if agent is None:
            return 0

        result = follow(agent, q, ns)
        if result == 'eof':
            return 0
        # result == 'back' -> loop back to list mode


if __name__ == '__main__':
    sys.exit(main())
