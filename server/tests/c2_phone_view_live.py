#!/usr/bin/env python3
"""c2_phone_view_live.py -- 4.2b / 8c / 8d / 8e regression against a real,
currently-working herdr pane: prove the algorithm does not flood the
scrollback the way round 1's border/glyph heuristic did, and that round 4's
5b-4 bound holds on real data at both window sizes.

This is deliberately NOT a unit test with constructed fixtures -- round 1's
three static-snapshot unit tests were all green while the real algorithm
flooded a live pane (wZ:p0: 7800 lines / 40 rounds, one line repeated 78
times). Only a live pane exposes that: real Claude Code output streams
mid-repaint, and -- the round-3 discovery -- Claude Code rewrites content
that scrolled out of the viewport long ago (folding a finished tool output
into `... +N lines (ctrl+o to expand)`), which breaks 5a's premise that the
stable region is immutable.

What this drives (changed in round 4): the probe calls
pv.stable_increment_with_marker(prev_stable, stable, viewport) -- the exact
call follow() makes. Rounds 1-3 called pv.align_increment() directly, which
skips 5b-4's cap on resync cost entirely, so the probe could not observe
the single most important behaviour of this round. align_increment() still
returns the whole stable window on a jump (c1 case4 pins that); what gets
*printed* is capped, and printing is what floods a phone.

Test discipline (contract 6a, stated three rounds running): a pane that
isn't producing output proves nothing. Before any timed run this script
samples scroll.max_offset_from_bottom twice, GATE_SETTLE_SEC apart, and
refuses to start until some pane shows delta > 0. After each run it checks
the run's own delta and marks the result VOID (retrying on a fresh gate)
if the pane went quiet mid-run.

READ-ONLY w.r.t. every pane a human might be using: this script calls only
`herdr agent list`, `herdr agent read`, and `herdr pane get` against those.
It never calls agent_prompt_cmd / agent_sendkeys_cmd and never imports/uses
anything that would send a prompt or a keypress to any agent, in any pane
-- including the panes named in dispatch contract 20260920-phone-view.md
section 5 (禁区), which are read (never written) if they happen to be the
only producing panes available.

10.6 (round 6 patch) exception, scoped tightly: this script also shells out
to `herdr --session sbtest pane get/read` against the one-off named session
"sbtest" that `node tests/start_sbtest.js` brings up out of band (never
"default", never a pane a human is using) -- purely to READ the pane a
producer was separately dispatched into via `herdr --session sbtest pane
run` (also out of band, before this script runs, per contract step). This
script itself never calls `pane run`, `session attach/stop`, or anything
else that would start or stop the sbtest session or its producer.

Run: python tests/c2_phone_view_live.py
Exits 0 and prints "ALL PASS" iff every assertion below holds. Prints the
full report block (pane id / delta / V / totals / top-5 repeated lines) to
stdout regardless of pass/fail, for the dispatch report to paste verbatim.
"""

import collections
import importlib.util
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(os.path.dirname(HERE), 'phone-view.py')

spec = importlib.util.spec_from_file_location('phone_view', TARGET)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)

ROUNDS = 40
INTERVAL_SEC = 1.0
NARROW_LINES = pv.DEFAULT_LINES  # 200, the shipped default (5b-3)
WIDE_LINES = 600                 # 8d's second column: the window 5b-3 reverted away from
GATE_SETTLE_SEC = 5.0            # contract 6a: two samples this far apart
MAX_RESYNCS_PER_40 = 3           # 10.2 gate 2 (frequency bound, new this round)
SBTEST_SESSION = 'sbtest'        # 10.6(甲): the one-off session this test manufactures
                                  # its own producing pane in (never touches "default")
# How many times to re-gate before giving up. Each attempt costs
# GATE_SETTLE_SEC. The default is enough for a machine that already has a
# busy pane; pass a larger number as argv[1] to let the probe sit and wait
# for one to appear (e.g. `python tests/c2_phone_view_live.py 120` waits up
# to ~10 minutes). This matters because contract 6a forbids counting a
# delta==0 run as evidence, and a machine whose agents are all idle simply
# cannot produce 8b/8d evidence at that moment.
MAX_GATE_ATTEMPTS = int(sys.argv[1]) if len(sys.argv) > 1 else 3

# Round 10.3: "the pane the probe runs in is never a valid subject" (proven
# in rounds 4/5 -- an agent's own tool output renders inside a Task block
# that stays in the viewport and never scrolls into scrollback, so
# max_offset_from_bottom sits still no matter how much work this script
# does) has now cost three rounds of manual bookkeeping. Stop relying on a
# human to remember it: auto-detect our own pane and exclude it.
#
# Claude Code sets CLAUDE_CODE_SESSION_ID for every agent process, including
# a forked task subagent like this one, and `herdr agent list` reports each
# pane's `agent_session.value` -- the same id when the pane is this session.
# Verified live on this machine: pane w0:pN carries
# agent_session.value == 38831ef2-8cdf-40a8-94ff-99bcdbc0c577, which is
# exactly this process's CLAUDE_CODE_SESSION_ID and its cwd (G:\Claude) and
# terminal title ("Direct terminal attach Windows support") match this very
# task. If the env var is absent (a different harness), auto-detection is a
# no-op and PHONE_VIEW_TEST_EXCLUDE_PANES is the only line of defense --
# same as before this round.
OWN_SESSION_ID = os.environ.get('CLAUDE_CODE_SESSION_ID', '').strip() or None


def auto_excluded_panes():
    """10.3: panes whose agent_session.value equals this process's own
    session id. Returns (set_of_pane_ids, evidence_rows) so the caller can
    print what got excluded and why, for the report."""
    if not OWN_SESSION_ID:
        return set(), []
    found, evidence = set(), []
    for a in pv.agent_list():
        sid = (a.get('agent_session') or {}).get('value')
        if sid == OWN_SESSION_ID:
            found.add(a['pane_id'])
            evidence.append((a['pane_id'], sid, a.get('cwd'),
                              a.get('terminal_title_stripped') or a.get('terminal_title')))
    return found, evidence


AUTO_EXCLUDED_PANES, AUTO_EXCLUDED_EVIDENCE = auto_excluded_panes()

# Manual supplement, kept from round 5: comma-separated pane ids in
# PHONE_VIEW_TEST_EXCLUDE_PANES. Default empty.
MANUAL_EXCLUDE_PANES = {p.strip() for p in os.environ.get('PHONE_VIEW_TEST_EXCLUDE_PANES', '').split(',')
                         if p.strip()}

EXCLUDE_PANES = AUTO_EXCLUDED_PANES | MANUAL_EXCLUDE_PANES

failures = []
resync_events = []   # (label, round_index, emitted_lines, V) across all live runs


def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print('[%s] %s%s' % (status, name, (' -- ' + detail) if detail and not cond else ''))
    if not cond:
        failures.append(name)


def offset_of(pane_id):
    d = pv.pane_get(pane_id)
    try:
        return d['result']['pane']['scroll']['max_offset_from_bottom']
    except (KeyError, TypeError):
        return None


def gate_producing_pane(settle=GATE_SETTLE_SEC, verbose=True):
    """Contract 6a gate: return (agent, gate_delta) for the working pane with
    the largest scrollback growth over `settle` seconds, or (None, table) if
    nothing is producing. Samples every pane so the report can show why a
    given pane was chosen."""
    agents = pv.agent_list()
    working = [a for a in agents
               if a.get('agent_status') == 'working' and a['pane_id'] not in EXCLUDE_PANES]
    if not working:
        return None, []
    first = {a['pane_id']: offset_of(a['pane_id']) for a in working}
    time.sleep(settle)
    table = []
    for a in working:
        pid = a['pane_id']
        o0, o1 = first[pid], offset_of(pid)
        delta = (o1 - o0) if (o0 is not None and o1 is not None) else 0
        table.append((pid, a.get('terminal_title_stripped') or pid, o0, o1, delta))
    table.sort(key=lambda row: row[4], reverse=True)
    best = table[0]
    if verbose or best[4] > 0:
        print('gate: working-pane scrollback growth over %.0fs' % settle)
        for pid, title, o0, o1, delta in table:
            print('  %-8s off %s -> %s  delta=%-4d  %s' % (pid, o0, o1, delta, title))
    if best[4] <= 0:
        return None, table
    chosen = next(a for a in working if a['pane_id'] == best[0])
    return chosen, best[4]


def pick_pane(status):
    for a in pv.agent_list():
        if a.get('agent_status') == status and a['pane_id'] not in EXCLUDE_PANES:
            return a
    return None


def run_probe(pane_id, read_lines, label, rounds=ROUNDS, interval=INTERVAL_SEC):
    """Drives the real 5a/5b/5b-4 pipeline read-only against `pane_id`.

    Connects once (one untimed priming read, exactly follow()'s "first"
    branch: "首次进入时把当前稳定区全部打印一遍作为起点" -- a mandatory,
    legitimate one-time backfill, not part of the flood behaviour under
    test), then runs `rounds` timed follow-polls and measures those.

    Why priming is excluded from the count: it is bounded by
    len(stable-region-at-connect-time), i.e. read_lines - V, regardless of
    whether the pane is busy or idle. Counting it would make even "0 lines
    across N follow-polls" (8c) mathematically impossible for any pane with
    existing content, independent of algorithm correctness.

    emitted_lines holds every RAW (not line-wrapped) line that follow()
    would have printed into scrollback -- exactly what
    `for out_line in wrap_lines(increment, term_width): print(out_line)`
    is fed, before wrapping. Counting pre-wrap keeps this comparable to
    delta (herdr's own row count, which knows nothing about our terminal
    width) and to what round 1's failure actually was (repeated *content*,
    not wrap-induced splitting).
    """
    viewport = pv.viewport_rows(pane_id) or pv.DEFAULT_VIEWPORT_ROWS

    snapshot = pv.agent_read(pane_id, read_lines)
    prev_stable, _active = pv.split_by_viewport(snapshot, viewport)
    priming_line_count = len(prev_stable)
    final_snapshot = snapshot

    start_offset = offset_of(pane_id)
    emitted_lines = []
    resyncs = []

    for i in range(1, rounds + 1):
        time.sleep(interval)
        snapshot = pv.agent_read(pane_id, read_lines)
        if snapshot is None:
            continue
        final_snapshot = snapshot
        stable, _active = pv.split_by_viewport(snapshot, viewport)
        # The exact call follow() makes, cap included (5b-4).
        increment, resynced = pv.stable_increment_with_marker(prev_stable, stable, viewport)
        if resynced:
            resyncs.append((i, len(increment)))
            resync_events.append((label, i, len(increment), viewport))
        emitted_lines.extend(increment)
        prev_stable = stable

    end_offset = offset_of(pane_id)

    return {
        'pane_id': pane_id,
        'label': label,
        'read_lines': read_lines,
        'viewport': viewport,
        'priming': priming_line_count,
        'emitted': emitted_lines,
        'resyncs': resyncs,
        'start_offset': start_offset,
        'end_offset': end_offset,
        'delta': (end_offset - start_offset) if (start_offset is not None and end_offset is not None) else 0,
        'final_snapshot': final_snapshot,
    }


# --- 10.6(甲): self-manufactured "sbtest" session producing pane ----------
#
# 10.6 patch: 10.3's auto-exclusion and contract 6a's "must gate Δ>0" are
# mutually exclusive on an idle machine -- on a machine where the ONLY
# producing pane is this test's own session (auto-excluded by design), the
# gate below (8b/8d "丙") can wait forever and never gets real evidence.
# Fix: manufacture a producing pane instead of waiting for one. Same
# approach as tests/b3_e2e.js -- a one-off named herdr session "sbtest"
# (never "default", never a pane a human is using), started out of band via
# `node tests/start_sbtest.js` before this script runs, with a continuous
# producer already dispatched into its one pane via `herdr --session sbtest
# pane run`.
#
# sbtest's pane runs a plain shell loop, not a classified herdr "agent"
# (claude/codex/pi) -- `herdr --session sbtest agent list` reports
# agents: [] for it, so pv.agent_read()/pv.pane_get() (which shell out to
# `herdr agent read` / `herdr pane get`, with no --session flag, always
# against the "default" session) cannot see it at all: wrong socket AND
# wrong command family. `herdr pane read`/`herdr pane get` take the same
# --source/--lines/--format shape and work against any pane regardless of
# agent classification, so that's the only I/O substitution here. The
# algorithm under test -- pv.split_by_viewport() and
# pv.stable_increment_with_marker(), 5a/5b-4/方案丁 exactly as shipped -- is
# called completely unmodified, identical to run_probe() above.
def sbtest_herdr(args):
    return subprocess.run(
        [pv.HERDR_BIN, '--session', SBTEST_SESSION] + args,
        capture_output=True, text=True, encoding='utf-8', errors='replace',
    )


def sbtest_pane_get(pane_id):
    r = sbtest_herdr(['pane', 'get', pane_id])
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except (json.JSONDecodeError, ValueError):
        return None


def sbtest_viewport_rows(pane_id):
    d = sbtest_pane_get(pane_id)
    try:
        return d['result']['pane']['scroll']['viewport_rows']
    except (KeyError, TypeError):
        return None


def sbtest_offset(pane_id):
    d = sbtest_pane_get(pane_id)
    try:
        return d['result']['pane']['scroll']['max_offset_from_bottom']
    except (KeyError, TypeError):
        return None


def sbtest_read(pane_id, lines):
    r = sbtest_herdr(['pane', 'read', pane_id,
                       '--source', 'recent-unwrapped', '--lines', str(lines), '--format', 'text'])
    if r.returncode != 0:
        return None
    return r.stdout.splitlines()


def sbtest_snapshot_pane_id():
    """result.snapshot.panes[0] per contract 10.6(甲) step 2."""
    r = sbtest_herdr(['api', 'snapshot'])
    if r.returncode != 0:
        return None
    try:
        data = json.loads(r.stdout)
        return data['result']['snapshot']['panes'][0]['pane_id']
    except (KeyError, IndexError, TypeError, json.JSONDecodeError, ValueError):
        return None


def run_probe_sbtest(pane_id, read_lines, label, rounds=ROUNDS, interval=INTERVAL_SEC):
    """Identical shape and identical algorithm calls to run_probe() above;
    only the I/O helpers are swapped for the sbtest_* ones (see the block
    comment above)."""
    viewport = sbtest_viewport_rows(pane_id) or pv.DEFAULT_VIEWPORT_ROWS

    snapshot = sbtest_read(pane_id, read_lines) or []
    prev_stable, _active = pv.split_by_viewport(snapshot, viewport)
    priming_line_count = len(prev_stable)
    final_snapshot = snapshot

    start_offset = sbtest_offset(pane_id)
    emitted_lines = []
    resyncs = []

    for i in range(1, rounds + 1):
        time.sleep(interval)
        snapshot = sbtest_read(pane_id, read_lines)
        if snapshot is None:
            continue
        final_snapshot = snapshot
        stable, _active = pv.split_by_viewport(snapshot, viewport)
        increment, resynced = pv.stable_increment_with_marker(prev_stable, stable, viewport)
        if resynced:
            resyncs.append((i, len(increment)))
            resync_events.append((label, i, len(increment), viewport))
        emitted_lines.extend(increment)
        prev_stable = stable

    end_offset = sbtest_offset(pane_id)

    return {
        'pane_id': pane_id,
        'label': label,
        'read_lines': read_lines,
        'viewport': viewport,
        'priming': priming_line_count,
        'emitted': emitted_lines,
        'resyncs': resyncs,
        'start_offset': start_offset,
        'end_offset': end_offset,
        'delta': (end_offset - start_offset) if (start_offset is not None and end_offset is not None) else 0,
        'final_snapshot': final_snapshot,
    }


def top5(lines):
    return collections.Counter(lines).most_common(5)


def report_run(r, title):
    emitted, viewport = r['emitted'], r['viewport']
    print()
    print('=== %s ===' % title)
    print('pane id           : %s' % r['pane_id'])
    print('--lines (window)  : %d   (stable region = %d rows)'
          % (r['read_lines'], r['read_lines'] - viewport))
    print('V (viewport_rows) : %d' % viewport)
    print('priming dump (excluded, one-time connect backfill): %d lines' % r['priming'])
    print('start offset      : %s' % r['start_offset'])
    print('end offset        : %s' % r['end_offset'])
    print('delta             : %d' % r['delta'])
    print('total emitted (%d follow-polls, priming excluded): %d' % (ROUNDS, len(emitted)))
    print('resyncs           : %d  %r' % (len(r['resyncs']), r['resyncs']))
    print('top 5 repeated lines:')
    for line, n in top5(emitted):
        print('  x%-4d %r' % (n, line))
    print('=' * (len(title) + 8))


def assert_run(r, tag):
    """Contract 8b/10.2 assertions, applied to one probe run.

    Round 10.2 split the old single assertion 1 ("emitted <= delta + V")
    into two gates, because that single form is algebraically impossible to
    satisfy whenever even one resync fires: 5b-4 (round 4) *requires* a
    resync to emit V+1 lines (the marker + up to V stable lines), and those
    V+1 lines overlap with what delta already counts as normal growth, so
    `emitted = delta + (V+1) > delta + V` on the very first resync. The old
    assertion was measuring "did this 40s window happen to dodge a resync",
    not "does the algorithm flood". Splitting it:

      gate 1 (structural): emitted <= delta + V + resyncs*(V+1)
        -- the bound 5b-4 actually promises. A resync's V+1-line cost is
        booked explicitly instead of silently blowing the budget.
      gate 2 (frequency, new this round): resyncs <= MAX_RESYNCS_PER_40
        -- the thing no earlier round's assertion ever bounded. r3's 6
        resyncs/40 and r4's 10 resyncs/40 both fail this; r5's 0-1
        resyncs/40 passes it comfortably.

    Assertion 2 (per-line repeat count) is untouched by this round.
    """
    emitted, viewport = r['emitted'], r['viewport']
    abs_delta = abs(r['delta'])
    counts = collections.Counter(emitted)
    final_counts = collections.Counter(r['final_snapshot'])

    resyncs_n = len(r['resyncs'])
    structural_bound = abs_delta + viewport + resyncs_n * (viewport + 1)
    check('%s gate 1 (10.2 structural bound): total emitted (%d) <= '
          'delta (%d) + V (%d) + resyncs*(V+1) (%d*%d=%d) = %d'
          % (tag, len(emitted), abs_delta, viewport, resyncs_n, viewport + 1,
             resyncs_n * (viewport + 1), structural_bound),
          len(emitted) <= structural_bound)

    check('%s gate 2 (10.2 frequency bound, new this round): resyncs (%d) <= %d per %d rounds'
          % (tag, resyncs_n, MAX_RESYNCS_PER_40, ROUNDS),
          resyncs_n <= MAX_RESYNCS_PER_40)

    worst_over = None  # (line, emitted_count, allowed_count)
    for line, n in counts.items():
        allowed = final_counts.get(line, 0) + 2
        if n > allowed:
            if worst_over is None or (n - allowed) > (worst_over[1] - worst_over[2]):
                worst_over = (line, n, allowed)
    check('%s assertion 2: every emitted line count <= its final-snapshot count + 2' % tag,
          worst_over is None,
          ('worst offender: %r emitted %d times, allowed (final-snapshot count + 2) = %d'
           % worst_over) if worst_over else '')

    worst_n = counts.most_common(1)[0][1] if counts else 0
    print('  this run: %d lines, max repeat %d' % (len(emitted), worst_n))


# --- 10.6(甲): self-manufactured "sbtest" pane -- MAIN evidence for 8b/8d ---
#
# 10.6 patch fixes the deadlock: 10.3's auto-exclusion correctly removes
# this session's own pane from the candidate pool, but on a machine where
# that pane is the ONLY one showing agent_status=="working", the 丙 gate
# below (unchanged from before this round) waits forever. Rather than wait,
# manufacture a producing pane: `node tests/start_sbtest.js` (run before
# this script, out of band, per contract step 1) brought up the one-off
# named session "sbtest" and `herdr --session sbtest pane run <pane> ...`
# (also run before this script, per contract step 3) dispatched a
# continuous producer into its one pane. This section only *measures* that
# pane -- 3x --lines 200 + 3x --lines 600, same 40-round/1s-interval shape,
# same gates as 丙 below.
#
# What this can and cannot prove (contract 10.6(甲) explicit disclaimer):
# sbtest's pane runs a plain shell loop, not Claude Code, so it CANNOT
# reproduce "a tool output folding into `... +N lines (ctrl+o to expand)`"
# -- the retroactive-repaint trigger that round 3 discovered and that drove
# a resync in the first place. This section proves the probe plumbing is
# correct end-to-end and that ordinary steady scrolling does not flood,
# independent of whether the machine happens to have a busy Claude Code
# pane at test time. It does NOT by itself prove the resync-frequency gate
# holds under retroactive repaint -- that is what 10.6(乙) below covers,
# using real Claude Code numbers already on file from round 5.

print('=== 10.6(甲): self-manufactured sbtest pane, main evidence for 8b/8d ===')
sbtest_pane_id = sbtest_snapshot_pane_id()
if sbtest_pane_id is None:
    print('FAIL: could not resolve sbtest pane id via `herdr --session sbtest api snapshot`. '
          'Was `node tests/start_sbtest.js` run first, and was a producer dispatched via '
          '`herdr --session sbtest pane run <pane_id> <cmd>`?')
    failures.append('10.6(甲): sbtest pane not found')
    sbtest_results = {}
else:
    print('sbtest pane_id = %s (via `herdr --session sbtest api snapshot`)' % sbtest_pane_id)
    d0, d1 = sbtest_offset(sbtest_pane_id), None
    time.sleep(GATE_SETTLE_SEC)
    d1 = sbtest_offset(sbtest_pane_id)
    print('sbtest producing-check: max_offset_from_bottom %s -> %s over %.0fs (must be > 0)'
          % (d0, d1, GATE_SETTLE_SEC))
    if not (d0 is not None and d1 is not None and d1 > d0):
        print('FAIL: sbtest pane is not actually producing (delta <= 0). The `pane run` '
              'producer from contract step 3 may have finished, died, or never started.')
        failures.append('10.6(甲): sbtest pane not producing (delta<=0 over %.0fs)' % GATE_SETTLE_SEC)
        sbtest_results = {}
    else:
        sbtest_results = {NARROW_LINES: [], WIDE_LINES: []}
        for lines in (NARROW_LINES, WIDE_LINES):
            for attempt in range(1, 4):
                print()
                print('10.6(甲) sbtest run: --lines %d, attempt %d/3, %d rounds @ %.0fs...'
                      % (lines, attempt, ROUNDS, INTERVAL_SEC))
                r = run_probe_sbtest(sbtest_pane_id, lines,
                                      'sbtest lines=%d run%d' % (lines, attempt))
                report_run(r, '10.6(甲) sbtest --lines %d run %d/3' % (lines, attempt))
                assert_run(r, '10.6(甲) sbtest lines=%d run%d' % (lines, attempt))
                sbtest_results[lines].append(r)

        print()
        print('=== 10.6(甲) sbtest summary: 3x --lines %d + 3x --lines %d, same pane %s ==='
              % (NARROW_LINES, WIDE_LINES, sbtest_pane_id))
        print('%-8s %-6s %-10s %-8s %-9s %-9s %s' %
              ('lines', 'run', 'stable win', 'delta', 'emitted', 'resyncs', 'max repeat'))
        for lines in (NARROW_LINES, WIDE_LINES):
            for i, r in enumerate(sbtest_results[lines], 1):
                cnt = collections.Counter(r['emitted'])
                print('%-8d %-6d %-10d %-8d %-9d %-9d %d' %
                      (lines, i, r['read_lines'] - r['viewport'], r['delta'],
                       len(r['emitted']), len(r['resyncs']),
                       cnt.most_common(1)[0][1] if cnt else 0))

print()
print('=== 10.6(乙): r5\'s 6 real-Claude-Code-pane 8b/8d runs, re-judged under the new '
      '10.2 two-gate rule (NUMBERS ARE FROM ROUND 5\'S REPORT, NOT RE-RUN THIS ROUND) ===')
print('source: G:\\Claude\\.orchestrate\\reports\\20260920-phone-view.r5.md, lines 299-505')
# Transcribed verbatim from r5's report -- the only 6 real 8b/8d runs on a
# real, non-manufactured Claude Code pane this task has ever produced,
# because this round could not get any (10.6's whole reason for existing).
# (run_label, pane_id, lines, V, delta, emitted, resyncs, resync_detail)
R5_RUNS = [
    ('r5 run1 col-A', 'wQ:p51', 200, 51, 7,  62, 1, [(6, 52)]),
    ('r5 run1 col-B', 'wQ:p51', 600, 51, 4,   4, 0, []),
    ('r5 run2 col-A', 'w0:pW',  200, 51, 22, 72, 1, [(4, 52)]),
    ('r5 run2 col-B', 'w0:pW',  600, 51, 17, 17, 0, []),
    ('r5 run3 col-A', 'w0:pW',  200, 51, 57, 57, 0, []),
    ('r5 run3 col-B', 'w0:pW',  600, 51, 0,   0, 0, []),
]
print('%-16s %-8s %-6s %-4s %-6s %-8s %-8s %-14s %-14s %s' %
      ('run', 'pane', 'lines', 'V', 'delta', 'emitted', 'resyncs',
       'gate1(struct)', 'gate2(freq<=3)', 'old single-bound(r5)'))
for label, pane_id, lines, V, delta, emitted, resyncs, detail in R5_RUNS:
    structural_bound = delta + V + resyncs * (V + 1)
    gate1_pass = emitted <= structural_bound
    gate2_pass = resyncs <= MAX_RESYNCS_PER_40
    old_bound = delta + V
    old_pass = emitted <= old_bound
    print('%-16s %-8s %-6d %-4d %-6d %-8d %-8d %-14s %-14s %s' %
          (label, pane_id, lines, V, delta, emitted, resyncs,
           ('PASS(<=%d)' % structural_bound) if gate1_pass else ('FAIL(<=%d)' % structural_bound),
           ('PASS(%d<=%d)' % (resyncs, MAX_RESYNCS_PER_40)) if gate2_pass
           else ('FAIL(%d>%d)' % (resyncs, MAX_RESYNCS_PER_40)),
           ('PASS(<=%d)' % old_bound) if old_pass else ('FAIL(<=%d)' % old_bound)))
    check('10.6(乙) %s gate 1 (10.2 structural bound, r5 numbers)' % label, gate1_pass,
          'emitted=%d bound=%d' % (emitted, structural_bound))
    check('10.6(乙) %s gate 2 (10.2 frequency bound, r5 numbers)' % label, gate2_pass,
          'resyncs=%d max=%d' % (resyncs, MAX_RESYNCS_PER_40))
print('(assertion 2 -- per-line repeat count -- was independently checked PASS for all 6 of '
      'these runs in the r5 report; unaffected by the 10.2 split, not re-derived here.)')
print()
print('10.2 gate-2 deterrence table (contract-specified, repeated here for the report):')
print('  r3 wQ:p4S --lines 600: 6 resyncs/40  -> gate 2 would BLOCK (6 > %d)' % MAX_RESYNCS_PER_40)
print('  r4 w0:pH  --lines 600: 10 resyncs/40 -> gate 2 would BLOCK (10 > %d)' % MAX_RESYNCS_PER_40)
print('  r5 --lines 600 x3: 0/0/0 resyncs -> gate 2 PASSES')
print('  r5 --lines 200 x3: 1/1/0 resyncs -> gate 2 PASSES')


# --- 10.6(丙): opportunistic bonus evidence IF a real, non-self pane happens ---
# --- to be producing right now. Per 10.6, this is no longer required and a  ---
# --- miss here is NOT a failure -- (甲)+(乙) above already cover 8b/8d.     ---

print()
print('=== 10.6(丙): opportunistic real (non-self, non-manufactured) working pane, if any ===')
print('contract 6a gate: refusing to start a timed run until a pane shows delta > 0')
if AUTO_EXCLUDED_EVIDENCE:
    print('10.3 auto-exclude: own CLAUDE_CODE_SESSION_ID=%s matched agent_session.value on:'
          % OWN_SESSION_ID)
    for pane_id, sid, cwd, title in AUTO_EXCLUDED_EVIDENCE:
        print('  %-8s agent_session.value=%s cwd=%s title=%r  <- this is the pane this test runs in'
              % (pane_id, sid, cwd, title))
elif OWN_SESSION_ID:
    print('10.3 auto-exclude: own CLAUDE_CODE_SESSION_ID=%s, no pane in `agent list` matched it'
          % OWN_SESSION_ID)
else:
    print('10.3 auto-exclude: CLAUDE_CODE_SESSION_ID not set in this process env; '
          'auto-exclusion is a no-op, relying on PHONE_VIEW_TEST_EXCLUDE_PANES only')
print('manual excludes (PHONE_VIEW_TEST_EXCLUDE_PANES): %s'
      % (', '.join(sorted(MANUAL_EXCLUDE_PANES)) or '(none)'))
print('effective excluded panes (auto | manual): %s'
      % (', '.join(sorted(EXCLUDE_PANES)) or '(none)'))

runs = []
gate_delta = None
chosen = None
for attempt in range(1, MAX_GATE_ATTEMPTS + 1):
    noisy = (attempt == 1 or attempt % 12 == 0)
    chosen, gate_delta = gate_producing_pane(verbose=noisy)
    if chosen is None:
        if noisy:
            print('gate attempt %d/%d: no working pane is producing output; retrying'
                  % (attempt, MAX_GATE_ATTEMPTS))
        continue
    print('gate attempt %d/%d: chose %s (gate delta=%d over %.0fs) -- %s'
          % (attempt, MAX_GATE_ATTEMPTS, chosen['pane_id'], gate_delta, GATE_SETTLE_SEC,
             chosen.get('terminal_title_stripped') or ''))
    pane_id = chosen['pane_id']

    print()
    print('8b/8d-A: probing %s with --lines %d for %d rounds @ %.0fs...'
          % (pane_id, NARROW_LINES, ROUNDS, INTERVAL_SEC))
    narrow = run_probe(pane_id, NARROW_LINES, 'lines=%d' % NARROW_LINES)
    print('8d-B: probing the SAME pane %s with --lines %d for %d rounds @ %.0fs...'
          % (pane_id, WIDE_LINES, ROUNDS, INTERVAL_SEC))
    wide = run_probe(pane_id, WIDE_LINES, 'lines=%d' % WIDE_LINES)

    if narrow['delta'] == 0 and wide['delta'] == 0:
        print('VOID: %s produced nothing during either timed run (delta=0 in both) -- '
              'contract 6a says this is not evidence; re-gating.' % pane_id)
        continue
    runs = [narrow, wide]
    break

if not runs:
    print()
    print('10.6(丙): 本次无可用的真实活跃 pane(%d 次 gate 尝试, %.0fs 间隔),已用 (甲)+(乙) 覆盖。'
          % (MAX_GATE_ATTEMPTS, GATE_SETTLE_SEC))
    print('10.6 patch: this is no longer treated as a failure -- 10.6(甲)+(乙) above are the '
          'required 8b/8d evidence this round; 丙 is opportunistic bonus evidence only, and '
          'per 10.6 explicitly "不许空等" (no more waiting out a long gate loop for this).')
else:
    narrow, wide = runs
    report_run(narrow, '10.6(丙) bonus: 8b / 8d column A (--lines %d), real pane' % NARROW_LINES)
    assert_run(narrow, '10.6(丙)-A(--lines %d)' % NARROW_LINES)
    report_run(wide, '10.6(丙) bonus: column B (--lines %d), same real pane' % WIDE_LINES)
    assert_run(wide, '10.6(丙)-B(--lines %d)' % WIDE_LINES)

    print()
    print('=== 8d side-by-side (same pane %s, 40 rounds each) ===' % narrow['pane_id'])
    print('%-12s %-10s %-8s %-9s %-9s %s' %
          ('--lines', 'stable win', 'delta', 'emitted', 'resyncs', 'max repeat'))
    for r in (narrow, wide):
        cnt = collections.Counter(r['emitted'])
        print('%-12d %-10d %-8d %-9d %-9d %d' %
              (r['read_lines'], r['read_lines'] - r['viewport'], r['delta'],
               len(r['emitted']), len(r['resyncs']),
               cnt.most_common(1)[0][1] if cnt else 0))
    print('round-3 failure baseline, same probe shape: wQ:p4S --lines 200 -> 4 lines / '
          '0 resyncs PASS; --lines 600 -> 2887 lines / 6 resyncs FAIL.')
    print('round-1 failure baseline: wZ:p0 -> 7800 lines, max repeat 78; '
          'wZ:p13 -> 3781 lines, max repeat 110.')


# --- 8c: an idle pane must emit exactly 0 lines across 40 rounds ---

idle = pick_pane('idle')
if idle is None:
    print()
    print('SKIP 8c: 没有 agent_status == "idle" 的 pane 可用')
else:
    pane_id = idle['pane_id']
    print()
    print('8c: probing idle pane %s (%s) for %d rounds @ %.0fs interval...' %
          (pane_id, idle.get('terminal_title_stripped') or pane_id, ROUNDS, INTERVAL_SEC))
    r = run_probe(pane_id, NARROW_LINES, 'idle')
    print('=== 8c report (idle pane) ===')
    print('pane id       : %s' % pane_id)
    print('V             : %d' % r['viewport'])
    print('priming dump (excluded): %d lines' % r['priming'])
    print('delta         : %d' % r['delta'])
    print('total emitted (%d follow-polls, priming excluded): %d' % (ROUNDS, len(r['emitted'])))
    print('=============================')
    check('8c: idle pane emits 0 lines across %d rounds' % ROUNDS, len(r['emitted']) == 0,
          'got %d: %r' % (len(r['emitted']), r['emitted'][:10]))


# --- 8e: the cost of a single resync is bounded by V+1 ---

print()
print('=== 8e: bound on the cost of one resync ===')
if resync_events:
    print('resyncs observed live (label, round, emitted_lines, V):')
    for ev in resync_events:
        print('  %r' % (ev,))
    over = [ev for ev in resync_events if ev[2] > ev[3] + 1]
    check('8e: every live resync emitted <= V+1 lines (not the whole stable window)',
          not over, 'over-budget: %r' % over)
else:
    print('no resync fired during the live runs above (the panes available were not '
          'jumping/rewriting history). Falling back to the contract-permitted '
          '"构造" path, using REAL captured pane text as the corpus.')
    # Build a genuine unreconcilable jump out of real pane text: two
    # non-overlapping slices of a real snapshot. This is the same code path
    # follow() takes, with a real V from a real pane.
    probe_pane = (chosen or pick_pane('idle') or pv.agent_list()[0])['pane_id']
    viewport = pv.viewport_rows(probe_pane) or pv.DEFAULT_VIEWPORT_ROWS
    snap = pv.agent_read(probe_pane, WIDE_LINES) or []
    stable_len = max(0, len(snap) - viewport)
    half = stable_len // 2
    prev_stable = snap[:half]
    new_stable = ['%s [[disjoint %d]]' % (snap[i % max(1, len(snap))], i) for i in range(half)]
    increment, resynced = pv.stable_increment_with_marker(prev_stable, new_stable, viewport)
    print('probe pane=%s V=%d snapshot=%d lines, stable region=%d, '
          'constructed windows of %d lines each' %
          (probe_pane, viewport, len(snap), stable_len, half))
    print('resynced=%s emitted=%d lines; first emitted line = %r' %
          (resynced, len(increment), increment[0] if increment else None))
    check('8e: constructed resync flagged', resynced is True)
    check('8e: resync emitted (%d) <= V+1 (%d), not the whole stable window (%d)'
          % (len(increment), viewport + 1, half),
          len(increment) <= viewport + 1)
    check('8e: resync output starts with the visible gap marker',
          bool(increment) and increment[0] == pv.RESYNC_MARKER,
          'got %r' % (increment[0] if increment else None))


# --- summary ---

if failures:
    print()
    print('FAILED: %d assertion(s): %s' % (len(failures), ', '.join(failures)))
    sys.exit(1)
print()
print('ALL PASS')
sys.exit(0)
