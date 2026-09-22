#!/usr/bin/env python3
"""c3_phone_view_replay.py -- 4.2c deterministic replay test.

Why this exists: 4.2b (c2_phone_view_live.py) drives the real algorithm
against a real pane, but a real pane isn't guaranteed to be producing
output when the test runs -- round 2's live probe measured delta=0 on all
three available panes and reported PASS anyway, which is not evidence the
algorithm works, only that nothing happened. This test instead replays a
*controlled* corpus (real text captured from a live pane, so it has the
same box-drawing/blank-line noise that broke round 2's alignment) through
a deterministic simulator, so the exact "real" scroll sequence is known
and can be compared to what phone-view.py's split_by_viewport /
stable_increment_with_marker actually emit, line for line.

Simulator model
----------------
`EXT` is the fixture corpus extended so any scenario's growth fits inside
it. A virtual read position `p` walks forward through `EXT`; each round's
raw snapshot is `window = EXT[p-n:p]` (n = the window size under test),
with the *last v* lines of that window rewritten to carry a `[tick i]`
suffix -- this is the "Claude Code repaints the whole viewport every
refresh" behaviour from the contract's 5a rationale. Because
split_by_viewport is purely positional (stable = window[:-v]), that
mutation only ever touches what gets classified as active and can never
leak into the stable region or its increment, which is exactly the
property 5a exists to guarantee -- scenario A below is the direct proof.

Scenarios E/F additionally model the thing that broke round 3 on a real
pane: Claude Code rewriting content that scrolled out of the viewport
long ago (folding a finished tool output into `... +N lines (ctrl+o to
expand)`). 5a's premise says that never happens; in reality it does, it
breaks alignment, and it is the sole trigger of the round-3 flood. See
deep_rewrite() below.

Everything goes through pv.stable_increment_with_marker(), never
pv.align_increment() directly, because the former is what follow()
actually prints and is the only place 5b-4's bound on resync cost lives.

Run: python tests/c3_phone_view_replay.py
Exits 0 and prints "ALL PASS" iff every assertion below holds.
"""

import importlib.util
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(os.path.dirname(HERE), 'phone-view.py')
CORPUS_PATH = os.path.join(HERE, 'fixtures', 'replay_corpus.txt')
SYNTHETIC_MIN_LINES = 700  # >= the real fixture's 696 lines, so window derivations don't get starved
SYNTHETIC_SEED = 20260922

spec = importlib.util.spec_from_file_location('phone_view', TARGET)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

failures = []


def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print('[%s] %s%s' % (status, name, (' -- ' + detail) if detail and not cond else ''))
    if not cond:
        failures.append(name)


def synthetic_corpus(min_lines=SYNTHETIC_MIN_LINES, seed=SYNTHETIC_SEED):
    """Deterministic stand-in for tests/fixtures/replay_corpus.txt (not
    committed to the public repo -- see server/README.md to capture a real
    one). Not a copy of any real pane output: built from a fixed seed so
    every run of this test produces byte-identical content, but carrying
    the same structural noise a real Claude Code pane capture has, since
    that noise is exactly what this replay test exercises:
      - long Chinese lines, mixed Chinese/English lines, pure-ASCII lines
      - box-drawing character lines
      - blank lines
      - "... +N lines (ctrl+o to expand)" fold markers (scenario E's
        retroactive-rewrite mechanism needs these already present in the
        corpus, not only the ones it plants itself)
    """
    rng = random.Random(seed)
    box_chars = '─│┌┐└┘├┤┬┴┼═║╔╗╚╝'
    cjk_pool = ('终端会话缓存刷新滚动窗口稳定对齐检测重放增量标记补丁修复'
                '请求响应命令执行结果输出捕获日志文件进程管道协议连接')
    ascii_words = ['fn', 'const', 'return', 'await', 'promise', 'buffer', 'stream', 'socket',
                   'pane', 'session', 'attach', 'detach', 'resize', 'scroll', 'viewport',
                   'terminal', 'exec', 'spawn', 'client', 'server']
    lines = []
    i = 0
    while len(lines) < min_lines:
        i += 1
        kind = i % 7
        if kind == 0:
            lines.append('')
        elif kind == 1:
            lines.append(''.join(rng.choice(cjk_pool) for _ in range(rng.randint(20, 60))))
        elif kind == 2:
            zh = ''.join(rng.choice(cjk_pool) for _ in range(rng.randint(5, 20)))
            en = ' '.join(rng.choice(ascii_words) for _ in range(rng.randint(2, 6)))
            lines.append(zh + ' ' + en + ' ' + zh)
        elif kind == 3:
            lines.append(' '.join(rng.choice(ascii_words) for _ in range(rng.randint(8, 20))))
        elif kind == 4:
            lines.append(rng.choice(box_chars) * rng.randint(20, 60))
        elif kind == 5:
            lines.append('  ... +%d lines (ctrl+o to expand)' % rng.randint(3, 400))
        else:
            tail = ''.join(rng.choice(cjk_pool + ' ') for _ in range(rng.randint(10, 40)))
            lines.append('L%d: %s' % (i, tail))
    return lines


if os.path.exists(CORPUS_PATH):
    with open(CORPUS_PATH, 'r', encoding='utf-8', errors='replace') as f:
        CORPUS = f.read().splitlines()
else:
    CORPUS = synthetic_corpus()
    print('fixture not found at %s -- using built-in deterministic synthetic corpus '
          '(%d lines, seed=%d). See server/README.md to capture the real one.' %
          (CORPUS_PATH, len(CORPUS), SYNTHETIC_SEED))

assert len(CORPUS) > 50, 'fixture corpus too small: %d lines' % len(CORPUS)

N = pv.DEFAULT_LINES          # the shipped --lines default (200 after 5b-3)
WIDE_N = 600                  # 8d's second column: the window 5b-3 reverted away from
V = pv.DEFAULT_VIEWPORT_ROWS  # 45
ROUNDS = 40
JUMP_ROUND = 20   # "第 20 轮" (1-indexed among the 40 measured rounds)

# 4.2c scenario D needs a jump the alignment genuinely *cannot* reconcile.
# It must therefore be derived from the window actually under test, never
# written as a literal: the contract's original "+400" was calibrated
# against a different window size, and at the round-3 default of 600 it was
# *smaller* than the 555-line stable window, so align_increment found ~155
# lines of surviving overlap, realigned cleanly, and the scenario silently
# tested nothing. At the current default of 200 a literal 700 would be
# 4.5x more than needed -- equally arbitrary, just in the harmless
# direction.
#
# The real threshold: prev and new stable windows stop overlapping at all
# once p advances by the size of the window that is actually compared.
# Advancing by a further v guarantees that even the rows adjacent to the old
# viewport boundary are gone, so there is nothing left for any d to latch onto.
#
# Round 5 (方案丁): that compared window is no longer n - v. 5a still
# classifies n - v rows as stable, but split_by_viewport now hands back only
# the last pv.MAX_STABLE of them for diffing, so the size that matters here is
# min(n - v, MAX_STABLE), and the jump has to be derived from *that*. Deriving
# it from n - v would still produce an unreconcilable jump (so D would pass),
# but at n=600 it would be 555+45=600 -- 4x the threshold it is meant to sit
# just above, i.e. an arbitrary number again, which is the whole thing this
# derivation exists to avoid.
def stable_window(n, v=V):
    """Rows of a size-n snapshot that phone-view actually diffs round to
    round: 5a's scrolled-out region (n - v), capped by 方案丁's MAX_STABLE."""
    return min(n - v, pv.MAX_STABLE)


def jump_amount(n, v=V):
    """A jump large enough that no alignment can survive it, for window n."""
    return stable_window(n, v) + v


JUMP_AMOUNT = jump_amount(N)  # N=200, V=45, MAX_STABLE=150 -> 150 + 45 = 195

# Extend the corpus so EXT covers every scenario's worst-case growth at the
# widest window used: WIDE_N (initial window) + ROUNDS*6 (scenario C's
# random step) + the largest jump, plus headroom. The first len(CORPUS)
# lines are the pristine real capture. Beyond that, cycle back through
# CORPUS but tag each recycled line with its absolute index. A *literal*
# repeat of the corpus (plain tiling) makes scenario D's post-jump window
# land on a spurious exact match against an earlier tile purely because the
# jump size happens to fall near a multiple of len(CORPUS) -- the test would
# then "resync" (or fail to) for a reason having nothing to do with
# align_increment's behaviour, and nothing to do with real terminal output
# either (real scrollback never repeats itself verbatim forever). Tagging
# recycled lines with their absolute position makes every line past the
# first corpus length globally unique, so any match found is a genuine
# positional overlap, not an artifact of this fixture's construction.
NEEDED = WIDE_N + ROUNDS * 6 + jump_amount(WIDE_N) + 200
EXT = list(CORPUS)
while len(EXT) < NEEDED:
    idx = len(EXT)
    EXT.append('%s [[fill %d]]' % (CORPUS[idx % len(CORPUS)], idx))


def mutate_active(window, v, tick):
    """Simulate Claude Code repainting the viewport: tag alternating
    lines in the last `v` lines of `window` with a per-round marker.
    Never touches window[:-v] (the stable part)."""
    w = list(window)
    v = min(v, len(w))
    start = len(w) - v
    for i in range(start, len(w)):
        if (i - start) % 2 == 0:
            w[i] = w[i] + (' [tick %d]' % tick)
    return w


# Depths (rows above the viewport boundary) at which a retroactive fold is
# planted. Derived from V so they stay meaningful if V changes. Several
# depths, because depth relative to the compared window is the whole story:
# a fold at 2*V=90 lands inside the window (90 < MAX_STABLE=150) and forces a
# resync; folds at 4*V=180 and 8*V=360 are above the window's top edge, never
# enter it, and are invisible.
#
# Before 方案丁 this set produced 8d's asymmetry: at n=200 the window was 155
# rows so only the 90-deep folds registered, while at n=600 it was 555 rows so
# all three did -- the wider window caught more retroactive rewrites and paid
# a resync for each, which is exactly what round 3 measured on a live pane.
# With the window pinned at MAX_STABLE the two columns see the same folds and
# the asymmetry is gone by construction; scenario F below is the assertion
# that it stays gone.
FOLD_DEPTHS = (2 * V, 4 * V, 8 * V)


def plant_fold(folds, p, v, depth, tick):
    """Record a retroactive rewrite at an absolute corpus position.

    Simulates Claude Code rewriting content that scrolled out of the
    viewport long ago -- e.g. collapsing a finished tool output into
    `... +N lines (ctrl+o to expand)`. This is the mechanism behind round
    3's flood: it violates 5a's premise that the stable region is
    immutable, so no d can align the two stable windows and the occurrence
    forces a resync.

    Folds are keyed by *absolute* corpus index and persist for the rest of
    the run, because a real fold is permanent. An earlier draft of this
    test rewrote the line positionally and let it revert the following
    round, which double-counted every resync (round 5 for the fold, round 6
    for the un-fold) -- an artifact of the harness, not of phone-view.py.
    """
    idx = p - v - depth           # `depth` rows above the viewport boundary
    if idx >= 0:
        folds[idx] = '... +%d lines (ctrl+o to expand) [fold %d]' % (12 + tick, tick)


def apply_folds(window, base_idx, folds):
    """Overlay recorded folds onto a window starting at absolute index base_idx."""
    if not folds:
        return window
    w = list(window)
    for abs_idx, text in folds.items():
        rel = abs_idx - base_idx
        if 0 <= rel < len(w):
            w[rel] = text
    return w


def run_scenario(step_fn, jump_round=None, jump_amt=0, rounds=ROUNDS,
                 n=None, v=V, deep_rewrite_every=0, fold_depths=FOLD_DEPTHS):
    """Drives phone-view.py's real functions over `rounds` measured polls.

    step_fn(round_index_1_based) -> int, how far p advances this round
    (before any jump is added).

    Returns a dict with the emitted line sequence, the ground-truth scrolled
    sequence, the resync count, and the per-round emitted counts (needed for
    8e's bound on the cost of a single resync).
    """
    n = N if n is None else n
    p = n  # priming: window = EXT[0:n], fully populated, not measured
    window = mutate_active(EXT[p - n:p], v, 0)
    prev_stable, _active = pv.split_by_viewport(window, v)
    start_p = p

    emitted = []
    per_round = []       # (round_index, resynced, emitted_this_round)
    resync_count = 0
    folds = {}           # absolute corpus index -> replacement text (permanent)
    fold_events = 0

    for i in range(1, rounds + 1):
        p += step_fn(i)
        if jump_round is not None and i == jump_round:
            p += jump_amt
        if deep_rewrite_every and i % deep_rewrite_every == 0:
            plant_fold(folds, p, v, fold_depths[fold_events % len(fold_depths)], i)
            fold_events += 1
        window = mutate_active(apply_folds(EXT[p - n:p], p - n, folds), v, i)
        stable, _active = pv.split_by_viewport(window, v)
        # follow() calls exactly this, passing its live viewport count as
        # the 5b-4 cap. Calling align_increment() directly here would skip
        # the cap and test code that never reaches a terminal.
        increment, resynced = pv.stable_increment_with_marker(prev_stable, stable, v)
        if resynced:
            resync_count += 1
        per_round.append((i, resynced, len(increment)))
        emitted.extend(increment)
        prev_stable = stable

    return {
        'emitted': emitted,
        'real': EXT[start_p - v:p - v],
        'resync_count': resync_count,
        'per_round': per_round,
        'fold_events': fold_events,
        'n': n,
        'v': v,
    }


# --- Scenario A: content doesn't move, viewport repainted every round ---

a = run_scenario(step_fn=lambda i: 0)
print('=== scenario A: step=0, 40 rounds (n=%d V=%d) ===' % (a['n'], a['v']))
print('emitted=%d real_scrolled=%d resync_count=%d' %
      (len(a['emitted']), len(a['real']), a['resync_count']))
check('A: emitted == 0 (content never moved, only the repainted viewport changed)',
      len(a['emitted']) == 0, 'emitted=%r' % a['emitted'][:10])
check('A: no resync', a['resync_count'] == 0)


# --- Scenario B: steady scroll, 3 lines/round ---

b = run_scenario(step_fn=lambda i: 3)
print()
print('=== scenario B: step=3, 40 rounds (n=%d V=%d) ===' % (b['n'], b['v']))
print('emitted=%d real_scrolled=%d resync_count=%d' %
      (len(b['emitted']), len(b['real']), b['resync_count']))
check('B: emitted line-for-line equals real scrolled sequence',
      b['emitted'] == b['real'],
      'len emitted=%d len real=%d first mismatch at %s' % (
          len(b['emitted']), len(b['real']),
          next((i for i in range(min(len(b['emitted']), len(b['real'])))
                if b['emitted'][i] != b['real'][i]), 'n/a')))
check('B: no resync', b['resync_count'] == 0)


# --- Scenario C: random scroll 0-6 lines/round, fixed seed ---

_rng_c = random.Random(42)
_steps_c = [_rng_c.randint(0, 6) for _ in range(ROUNDS)]
c = run_scenario(step_fn=lambda i: _steps_c[i - 1])
print()
print('=== scenario C: step=random(0,6) seed=42, 40 rounds (n=%d V=%d) ===' % (c['n'], c['v']))
print('steps=%r' % _steps_c)
print('emitted=%d real_scrolled=%d resync_count=%d' %
      (len(c['emitted']), len(c['real']), c['resync_count']))
check('C: emitted line-for-line equals real scrolled sequence',
      c['emitted'] == c['real'],
      'len emitted=%d len real=%d first mismatch at %s' % (
          len(c['emitted']), len(c['real']),
          next((i for i in range(min(len(c['emitted']), len(c['real'])))
                if c['emitted'][i] != c['real'][i]), 'n/a')))
check('C: no resync', c['resync_count'] == 0)


# --- Scenario D: steady step=3 plus an unreconcilable jump at round 20
# (simulates e.g. /compact truncating/rewriting history mid-stream) ---

d = run_scenario(step_fn=lambda i: 3, jump_round=JUMP_ROUND, jump_amt=JUMP_AMOUNT)
print()
print('=== scenario D: step=3 + jump(+%d, derived: stable_window(%d)=%d plus V=%d) '
      'at round %d, 40 rounds ===' % (JUMP_AMOUNT, N, stable_window(N), V, JUMP_ROUND))
print('emitted=%d real_scrolled=%d resync_count=%d' %
      (len(d['emitted']), len(d['real']), d['resync_count']))
marker_present = pv.RESYNC_MARKER in d['emitted']

check('D-1: resynced fired at least once', d['resync_count'] >= 1,
      'resync_count=%d' % d['resync_count'])
check('D-2: resync marker is present in emitted output', marker_present,
      'RESYNC_MARKER=%r not found in %d emitted lines' % (pv.RESYNC_MARKER, len(d['emitted'])))
# D-3: the failure mode round 3 existed to kill -- emitting far less than
# what really scrolled by, with nothing to show for it. Content *is*
# legitimately skipped on a resync now (5b-4 caps the catch-up at one
# screen); what is forbidden is skipping it silently.
silently_lost = (len(d['emitted']) < len(d['real'])) and not marker_present
check('D-3: no silent loss (emitted < real_scrolled only ever happens with a marker present)',
      not silently_lost,
      'emitted=%d real=%d marker_present=%s' % (len(d['emitted']), len(d['real']), marker_present))
# D-4 (= 8e): 5b-4's bound. A resync must cost the marker plus at most one
# screen, never the whole stable window (which at n=200 would be 155 lines
# and at n=600 would be 555 -- the latter is where round 3's 2887 lines
# came from).
d_resync_rounds = [(i, k) for (i, r, k) in d['per_round'] if r]
print('resync rounds (round, emitted_lines): %r' % d_resync_rounds)
print('bound V+1 = %d; stable window that the old code would have reprinted = %d'
      % (V + 1, stable_window(N)))
check('D-4 (8e): every resync emits <= V+1 lines, not the whole stable window',
      all(k <= V + 1 for (_i, k) in d_resync_rounds),
      'over-budget rounds: %r' % [(i, k) for (i, k) in d_resync_rounds if k > V + 1])


# --- Scenario E (= 8e, deterministic): a retroactive rewrite deep inside
# the stable region -- the real mechanism behind round 3's flood ---

e = run_scenario(step_fn=lambda i: 3, deep_rewrite_every=5, fold_depths=(2 * V,))
e_resync_rounds = [(i, k) for (i, r, k) in e['per_round'] if r]
print()
print('=== scenario E: step=3 + retroactive deep rewrite every 5 rounds at depth 2V=%d '
      '(n=%d V=%d) ===' % (2 * V, e['n'], e['v']))
print('emitted=%d real_scrolled=%d resync_count=%d fold_events=%d' %
      (len(e['emitted']), len(e['real']), e['resync_count'], e['fold_events']))
print('resync rounds (round, emitted_lines): %r' % e_resync_rounds)
check('E-1: a rewrite above the viewport boundary is detected as a resync, not absorbed silently',
      e['resync_count'] >= 1, 'resync_count=%d' % e['resync_count'])
check('E-2 (8e): every resync emits <= V+1 = %d lines' % (V + 1),
      all(k <= V + 1 for (_i, k) in e_resync_rounds),
      'over-budget rounds: %r' % [(i, k) for (i, k) in e_resync_rounds if k > V + 1])
check('E-3: total emitted is bounded by real_scrolled + resyncs*(V+1)',
      len(e['emitted']) <= len(e['real']) + e['resync_count'] * (V + 1),
      'emitted=%d real=%d resyncs=%d bound=%d' % (
          len(e['emitted']), len(e['real']), e['resync_count'],
          len(e['real']) + e['resync_count'] * (V + 1)))


# --- Scenario F (deterministic backing for 8d): the same retroactive-rewrite
# load at both window sizes. Round 3's measurement was 200 -> 4 lines / 0
# resyncs, 600 -> 2887 lines / 6 resyncs, where 6 * 477 ~= 2862 of those
# lines were whole-window reprints. With 5b-4's cap the per-resync cost is
# V+1 regardless of window size, and with 方案丁's cap the resync *count* is
# the same at both sizes too (both diff the same MAX_STABLE rows), so the two
# columns must now land in the same order of magnitude -- in fact identical. ---

print()
print('=== scenario F (8d backing): identical load at n=%d vs n=%d ===' % (N, WIDE_N))
f_rows = []
for n_val in (N, WIDE_N):
    r = run_scenario(step_fn=lambda i: 3, n=n_val, deep_rewrite_every=5)
    rr = [(i, k) for (i, res, k) in r['per_round'] if res]
    f_rows.append((n_val, r, rr))
    print('n=%-4d stable_window=%-4d emitted=%-5d real_scrolled=%-4d folds_planted=%-2d '
          'resyncs=%-2d max_per_resync=%-3d  (pre-5b-4 cost would have been %d/resync)' % (
              n_val, stable_window(n_val), len(r['emitted']), len(r['real']),
              r['fold_events'], r['resync_count'],
              max([k for (_i, k) in rr], default=0), stable_window(n_val)))

for n_val, r, rr in f_rows:
    check('F: n=%d -- every resync emits <= V+1 = %d lines' % (n_val, V + 1),
          all(k <= V + 1 for (_i, k) in rr),
          'over-budget rounds: %r' % [(i, k) for (i, k) in rr if k > V + 1])
    check('F: n=%d -- total emitted <= real_scrolled + resyncs*(V+1)' % n_val,
          len(r['emitted']) <= len(r['real']) + r['resync_count'] * (V + 1),
          'emitted=%d real=%d resyncs=%d' % (
              len(r['emitted']), len(r['real']), r['resync_count']))

_small, _wide = f_rows[0][1], f_rows[1][1]
check('F: the wide window is no longer an order of magnitude worse than the narrow one '
      '(round 3: 4 vs 2887)',
      len(_wide['emitted']) <= len(_small['emitted']) * 3 + (V + 1),
      'n=%d emitted=%d, n=%d emitted=%d' % (
          N, len(_small['emitted']), WIDE_N, len(_wide['emitted'])))


print()
print('=== earlier-round baselines for comparison (different implementation/parameters, '
      'kept for context only) ===')
print('round 2: A 0/0 PASS, B 120/120 PASS, C 125/125 PASS, '
      'D real_scrolled=440 emitted=193 resync=0 FAIL')
print('round 3/4 live pane wQ:p4S, 40 rounds: n=200 -> 4 lines / 0 resyncs PASS; '
      'n=600 -> 2887 lines / 6 resyncs FAIL (6 * 477-line whole-window reprints)')


# --- summary ---

if failures:
    print()
    print('FAILED: %d assertion(s): %s' % (len(failures), ', '.join(failures)))
    sys.exit(1)
print()
print('ALL PASS')
sys.exit(0)
