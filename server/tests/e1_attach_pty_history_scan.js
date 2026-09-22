// E1: 20260922-wsshd-moshi-attach-pty acceptance item 3 -- full-history
// zero-false-positive scan. Every "exec <JSON string>" command ever logged
// to production wsshd.log, deduplicated, tested against the new MOSHI_PS.
// Asserts: only the three known Moshi PowerShell shapes match (the two
// probes plus the attach command); every other historical shape -- notably
// TermRover's sh -c 'command -v herdr ...', herdr session list --json
// variants, nc -U, termrover-login, the cmd.exe platform-detect, the "true"
// heartbeat, Moshi's own sh -lc POSIX probe, and any bash-invoked
// `powershell.exe ...` / `powershell -NoProfile -Command ...` command --
// still does NOT match.
const fs = require('fs');
const path = require('path');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const src = fs.readFileSync(path.join(RELAY, 'wsshd.js'), 'utf8');
const m = /^const MOSHI_PS = (\/.*\/);$/m.exec(src);
if (!m) { console.log('FAIL: could not find "const MOSHI_PS = /.../;" line in wsshd.js'); process.exit(1); }
const MOSHI_PS = eval(m[1]);
console.log('extracted MOSHI_PS from wsshd.js source: ' + m[1]);

// Pull every logged "... exec <JSON string> ..." line's command text,
// JSON.parse'd back to the original bytes -- same technique as d1/d2/d3's
// cmdOf(), just applied to the whole file instead of grepping for one marker.
function cmdOf(line) {
  const i = line.indexOf(' exec "');
  if (i === -1) return null;
  const s = i + 6; // start at the opening quote
  // Find the matching closing quote by scanning for an unescaped ".
  let j = s + 1;
  while (j < line.length) {
    if (line[j] === '\\') { j += 2; continue; }
    if (line[j] === '"') break;
    j++;
  }
  const jsonStr = line.slice(s, j + 1);
  try { return JSON.parse(jsonStr); } catch (e) { return undefined; }
}

const logText = fs.readFileSync(path.join(RELAY, 'wsshd.log'), 'utf8');
const lines = logText.split('\n');
const seen = new Set();
const forms = [];
let parseFailures = 0;
for (const line of lines) {
  const cmd = cmdOf(line);
  if (cmd === null) continue; // not an exec line
  if (cmd === undefined) { parseFailures++; continue; } // exec line whose JSON string didn't parse cleanly (should not happen)
  if (seen.has(cmd)) continue;
  seen.add(cmd);
  forms.push(cmd);
}

console.log('total exec lines scanned: (see below), distinct command forms: ' + forms.length + ', JSON parse failures: ' + parseFailures);

let failures = 0;
function ok(cond, label) {
  console.log((cond ? 'OK ' : 'FAIL ') + label);
  if (!cond) failures++;
}

// The three known-good Moshi PowerShell shapes (substring markers, robust to
// exact whitespace).
function isKnownMoshiPs(cmd) {
  if (cmd.includes('__MOSHI_HOOK_PROBE_V2__') && cmd.startsWith('$marker')) return 'hook-probe';
  if (cmd.includes('__MOSHI_MULTIPLEXER_SNAPSHOT_V1__') && cmd.startsWith('$marker')) return 'multiplexer-probe';
  if (cmd.startsWith('$herdr = Get-Command herdr.exe') && cmd.includes("--session '")) return 'attach';
  return null;
}

const hits = [];
const falsePositives = [];
const knownKinds = new Set();
for (const cmd of forms) {
  const known = isKnownMoshiPs(cmd);
  const matched = MOSHI_PS.test(cmd);
  if (matched) {
    hits.push({ cmd, known });
    if (known) knownKinds.add(known);
    else falsePositives.push(cmd);
  }
}

ok(knownKinds.has('hook-probe'), '1. known __MOSHI_HOOK_PROBE_V2__ form present in history and matched by MOSHI_PS');
ok(knownKinds.has('multiplexer-probe'), '2. known __MOSHI_MULTIPLEXER_SNAPSHOT_V1__ form present in history and matched by MOSHI_PS');
ok(knownKinds.has('attach'), '3. known attach ($herdr = Get-Command ... --session) form present in history and matched by MOSHI_PS');
ok(falsePositives.length === 0, '4. zero false positives: no form outside the three known Moshi PowerShell shapes matches MOSHI_PS');
if (falsePositives.length) {
  console.log('--- FALSE POSITIVES (' + falsePositives.length + ') ---');
  for (const f of falsePositives) console.log(JSON.stringify(f));
}

// Point-name the specific historical shapes the contract calls out.
function anyForm(pred) { return forms.some(pred); }
// isKnownMoshiPs(c) excludes the multiplexer probe from the "herdr session
// list --json" check below: that probe legitimately CONTAINS the substring
// "herdr session list --json" as one line of its own script (it is itself
// one of the three things MOSHI_PS is supposed to match), so without this
// exclusion the point-name check below would flag a true positive as if it
// were TermRover's unrelated `herdr session list --json` invocation.
const checks = [
  ['sh -c \'command -v herdr', c => /command -v herdr/.test(c) && /^sh -c/.test(c)],
  ['herdr session list --json variants (TermRover, not the Moshi probes)', c => !isKnownMoshiPs(c) && /herdr(?:\.exe)?'?\s+session\s+list\s+--json/.test(c)],
  ['nc -U ...', c => /\bnc\s+-U\s+/.test(c)],
  ['termrover-login', c => c.includes('termrover-login')],
  ['cmd.exe /d /s /c "echo __MOSHI_WINDOWS__"', c => c.includes('__MOSHI_WINDOWS__') && c.startsWith('cmd.exe')],
  ['true heartbeat', c => c === 'true'],
  ["sh -lc 'export PATH=...' (Moshi POSIX probe)", c => /^sh -lc/.test(c) || (c.includes('export PATH=') && !c.startsWith('$'))],
  ['bash-invoked powershell.exe ...', c => /powershell(\.exe)?\s/.test(c) && !c.startsWith('$')],
];
console.log('--- point-named historical shapes: present in history? matched by MOSHI_PS? (must be false) ---');
for (const [label, pred] of checks) {
  const matchingForms = forms.filter(pred);
  const present = matchingForms.length > 0;
  const anyMatched = matchingForms.some(c => MOSHI_PS.test(c));
  console.log((present ? 'present(' + matchingForms.length + ')' : 'ABSENT') + ' matched=' + anyMatched + '  ' + label);
  if (present) ok(!anyMatched, '5. "' + label + '" present in history and NOT matched by MOSHI_PS');
}

// Dump the full deduped form list with match verdict for the report.
console.log('--- full deduped form list (' + forms.length + ' forms) ---');
forms.forEach((cmd, i) => {
  const matched = MOSHI_PS.test(cmd);
  console.log('[' + i + '] matched=' + matched + ' len=' + cmd.length + ' preview=' + JSON.stringify(cmd.slice(0, 90)));
});

console.log(failures === 0 ? 'E1 OVERALL: OK' : ('E1 OVERALL: FAIL (' + failures + ' failure(s))'));
process.exit(failures === 0 ? 0 : 1);
