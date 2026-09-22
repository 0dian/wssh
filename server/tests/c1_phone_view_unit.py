#!/usr/bin/env python3
"""c1_phone_view_unit.py -- unit tests for phone-view.py.

Covers dispatch contract 20260920-phone-view.md section 4.2:
  4.2.4 CJK-width-aware wrapping (every wrapped segment <= width)
  4.2.5 stable/active split + incremental-tail computation
  4.2.8 --print-cmd command construction (spaces / Chinese / quotes)

Run: python tests/c1_phone_view_unit.py
Exits 0 and prints "ALL PASS" iff every assertion below holds.
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(os.path.dirname(HERE), 'phone-view.py')

spec = importlib.util.spec_from_file_location('phone_view', TARGET)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

failures = []


def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print('[%s] %s%s' % (status, name, (' -- ' + detail) if detail and not cond else ''))
    if not cond:
        failures.append(name)


# --- 4.2.4: CJK-width-aware wrapping ---

WRAP_WIDTH = 50
WRAP_INPUTS = {
    'ascii_long': 'the quick brown fox jumps over the lazy dog ' * 5,
    'cjk_long': '汉字段落测试内容重复重复' * 8,
    'mixed': ('hello 你好 world 世界 mix ' * 6),
    'borders': '┌─┼┐' * 20,
    'empty': '',
}

for name, line in WRAP_INPUTS.items():
    segments = pv.wrap_line(line, WRAP_WIDTH)
    ok = all(pv.display_width(seg) <= WRAP_WIDTH for seg in segments)
    # round-trip: concatenating segments must reproduce the original line
    ok = ok and (''.join(segments) == line)
    check('4.2.4 wrap_line width<=%d: %s' % (WRAP_WIDTH, name), ok,
          'segments=%r widths=%r' % (segments, [pv.display_width(s) for s in segments]))

check('4.2.4 wrap_line empty -> [""]', pv.wrap_line('', WRAP_WIDTH) == [''])


# --- 4.2.5 (round 2): viewport-based stable/active split + sliding-window
# alignment + in-place-redraw erase count. The old border/glyph heuristic
# (ACTIVE_BORDER_CHARS / ACTIVE_GLYPHS / line_is_active / split_stable_active)
# is gone -- Claude Code repaints the *whole viewport*, not just an input
# box, so the split is now purely positional: stable = snapshot[:-V],
# active = snapshot[-V:].

V = 3  # viewport_rows for these fixtures
STABLE_BODY = ['line %d of stable output' % i for i in range(1, 6)]  # 5 lines
ACTIVE_A = ['╭input box╮', '│ ❯        │', '╰──────────╯']  # 3 lines == V
ACTIVE_B = ['', '◐ working...', '  esc to interrupt']       # different 3 lines

round1 = STABLE_BODY + ACTIVE_A
stable1, active1 = pv.split_by_viewport(round1, V)
check('4.2.5a split_by_viewport: stable == STABLE_BODY', stable1 == STABLE_BODY, 'got %r' % stable1)
check('4.2.5a split_by_viewport: active == last V lines', active1 == ACTIVE_A, 'got %r' % active1)

# Case 1: two consecutive identical snapshots -> empty increment.
stableA, _ = pv.split_by_viewport(round1, V)
stableB, _ = pv.split_by_viewport(list(round1), V)  # fresh list, same content
inc1, resync1 = pv.align_increment(stableA, stableB)
check('4.2.5b case1: identical snapshots -> empty increment', inc1 == [], 'got %r' % inc1)
check('4.2.5b case1: not flagged as resync', resync1 is False)

# Case 2: pane scrolled 2 lines -> stable window shifts by exactly 2, the
# increment is exactly those 2 new lines.
round2 = STABLE_BODY[2:] + ['line 6 of stable output', 'line 7 of stable output'] + ACTIVE_A
stable2, active2 = pv.split_by_viewport(round2, V)
check('4.2.5b case2 setup: stable2 same length as stable1', len(stable2) == len(stable1))
inc2, resync2 = pv.align_increment(stable1, stable2)
check('4.2.5b case2: scroll +2 -> increment is exactly those 2 lines',
      inc2 == ['line 6 of stable output', 'line 7 of stable output'], 'got %r' % inc2)
check('4.2.5b case2: not flagged as resync', resync2 is False)

# Case 3: active region changes shape/content but the stable region
# (everything scrolled out of the viewport) is byte-identical -> empty
# increment, because the split no longer looks at active-region content at
# all.
round3 = STABLE_BODY + ACTIVE_B
stable3, active3 = pv.split_by_viewport(round3, V)
check('4.2.5a case3: stable identical despite different active region',
      stable3 == stable1, 'got %r' % stable3)
check('4.2.5a case3: active differs as constructed', active3 != active1)
inc3, resync3 = pv.align_increment(stable1, stable3)
check('4.2.5b case3: increment empty when only active region differed', inc3 == [], 'got %r' % inc3)
check('4.2.5b case3: not flagged as resync', resync3 is False)

# Case 4: a jump too large to reconcile (e.g. /compact truncated history,
# or more scrolled past in one poll than the stable window holds) -> no d
# aligns, degrade to a full reprint and flag resync=True.
prev_disjoint = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
new_disjoint = ['zeta', 'eta', 'theta', 'iota', 'kappa']
inc4, resync4 = pv.align_increment(prev_disjoint, new_disjoint)
check('4.2.5b case4: disjoint content -> full reprint', inc4 == new_disjoint, 'got %r' % inc4)
check('4.2.5b case4: flagged as resync', resync4 is True)

# Case 5: erase_lines (L) for the in-place active-region redraw must be
# computed from the *wrapped* (post-wrap, display-width-aware) row count,
# not the raw logical line count. One CJK logical line, wrapped at width 20
# (10 chars/line since each CJK glyph is 2 columns), must expand to more
# rows than the single raw line it started as.
CJK_ACTIVE = ['汉字汉字汉字汉字汉字汉字汉字汉字汉字汉字']  # 20 CJK chars = 40 display cols
rendered5 = pv.render_active(CJK_ACTIVE, 20, max_rows=10)
raw_row_count = len(CJK_ACTIVE)
wrapped_row_count = len(rendered5)
check('4.2.5c case5: wrapped row count != raw line count',
      wrapped_row_count != raw_row_count, 'raw=%d wrapped=%d rows=%r' % (raw_row_count, wrapped_row_count, rendered5))
check('4.2.5c case5: wrapped row count is exactly 2 (40 cols / 20-wide)',
      wrapped_row_count == 2, 'rows=%r' % rendered5)
check('4.2.5c case5: every wrapped row fits within width 20',
      all(pv.display_width(r) <= 20 for r in rendered5), 'rows=%r' % rendered5)


# --- 方案丁 (round 5): the round-to-round comparison window is capped at
# MAX_STABLE, decoupled from --lines N. `--lines N` still sets how deep the
# one-time priming dump goes (that path calls split_by_viewport with
# max_stable=None); only the window that prev_stable / new_stable are diffed
# over is pinned, because 5b-3 measured that a deeper window just catches more
# of Claude Code's retroactive rewrites and turns each one into a resync.

check('丁-0 MAX_STABLE is a positive int', isinstance(pv.MAX_STABLE, int) and pv.MAX_STABLE > 0,
      'got %r' % (pv.MAX_STABLE,))

# (1) stable region deeper than MAX_STABLE -> only the last MAX_STABLE rows.
DEEP_BODY = ['deep line %d' % i for i in range(pv.MAX_STABLE + 40)]
deep_snapshot = DEEP_BODY + ACTIVE_A
stable_deep, active_deep = pv.split_by_viewport(deep_snapshot, V)
check('丁-1 split_by_viewport caps the stable region at MAX_STABLE (%d)' % pv.MAX_STABLE,
      len(stable_deep) == pv.MAX_STABLE,
      'stable region was %d rows, got %d back' % (len(DEEP_BODY), len(stable_deep)))
check('丁-1 the rows kept are the LAST MAX_STABLE rows (newest), not the first',
      stable_deep == DEEP_BODY[-pv.MAX_STABLE:],
      'first kept=%r last kept=%r' % (stable_deep[:1], stable_deep[-1:]))
check('丁-1 the active region is untouched by the cap', active_deep == ACTIVE_A,
      'got %r' % active_deep)

# (2) stable region at or under MAX_STABLE -> returned verbatim.
SHALLOW_BODY = ['shallow line %d' % i for i in range(pv.MAX_STABLE - 10)]
stable_shallow, active_shallow = pv.split_by_viewport(SHALLOW_BODY + ACTIVE_A, V)
check('丁-2 a stable region under the cap is returned unchanged',
      stable_shallow == SHALLOW_BODY,
      'len got=%d want=%d' % (len(stable_shallow), len(SHALLOW_BODY)))
check('丁-2 the active region is unchanged too', active_shallow == ACTIVE_A,
      'got %r' % active_shallow)

# (3) the priming escape hatch: max_stable=None returns the uncapped region,
# so `--lines 600` / `:n 600` still backfills that much history on entry.
stable_prime, _active_prime = pv.split_by_viewport(deep_snapshot, V, max_stable=None)
check('丁-3 priming (max_stable=None) is NOT capped -- --lines N still controls entry depth',
      stable_prime == DEEP_BODY, 'len got=%d want=%d' % (len(stable_prime), len(DEEP_BODY)))


# --- 4.2.8: --print-cmd command construction ---

TARGET_ID = 'wQ:p27'

cmd_plain = pv.agent_prompt_cmd(TARGET_ID, 'hello world')
check('4.2.8 prompt cmd shape (plain)',
      cmd_plain == [pv.HERDR_BIN, 'agent', 'prompt', TARGET_ID, 'hello world'],
      'got %r' % cmd_plain)

TEXT_SPACES = 'run the build now'
TEXT_CJK = '你好，请先执行测试'
TEXT_QUOTES = 'say "hi" and it\'s done'

for label, text in [('spaces', TEXT_SPACES), ('cjk', TEXT_CJK), ('quotes', TEXT_QUOTES)]:
    cmd = pv.agent_prompt_cmd(TARGET_ID, text)
    rendered = pv.cmd_to_str(cmd)
    # the printed line must still carry `text` as one shell-safe token, and
    # shlex.split() must recover exactly the original argv when re-parsed.
    import shlex as _shlex
    recovered = _shlex.split(rendered)
    check('4.2.8 print-cmd round-trip: %s' % label, recovered == cmd,
          'rendered=%r recovered=%r want=%r' % (rendered, recovered, cmd))

sendkeys_cmd = pv.agent_sendkeys_cmd(TARGET_ID, ['down', 'enter'])
check('4.2.8 send-keys cmd shape',
      sendkeys_cmd == [pv.HERDR_BIN, 'agent', 'send-keys', TARGET_ID, 'down', 'enter'],
      'got %r' % sendkeys_cmd)

wait_cmd = pv.agent_wait_cmd(TARGET_ID)
check('4.2.8 wait cmd shape',
      wait_cmd == [pv.HERDR_BIN, 'agent', 'wait', TARGET_ID, '--until', 'idle'],
      'got %r' % wait_cmd)

# run_write under --print-cmd must only print, never execute (no subprocess
# actually spawned -- verified by monkeypatching subprocess.run to explode).
import subprocess as _subprocess


def _boom(*a, **kw):
    raise AssertionError('subprocess.run must not be called when print_cmd=True')


_orig_run = _subprocess.run
_subprocess.run = _boom
try:
    result = pv.run_write(cmd_plain, True)
    check('4.2.8 run_write(print_cmd=True) does not execute', result is None)
finally:
    _subprocess.run = _orig_run


# --- summary ---

if failures:
    print('FAILED: %d assertion(s): %s' % (len(failures), ', '.join(failures)))
    sys.exit(1)
print('ALL PASS')
sys.exit(0)
