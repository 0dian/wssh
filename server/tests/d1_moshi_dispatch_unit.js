// D1: unit tests for the Moshi-vs-bash dispatch judgment in runInPipes()
// (20260921-wsshd-moshi-powershell). wsshd.js has no module.exports and
// calls BIND.forEach(listen) unconditionally at load time, so it must never
// be require()'d by a test (it would try to bind the real port). Instead
// this pulls the MOSHI_PS regex literal straight out of the source text and
// eval's just that one line -- testing the actual regex in wsshd.js, not a
// hand-copied duplicate that could silently drift from it.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RELAY = path.join(__dirname, '..').replace(/\\/g, '/');
const src = fs.readFileSync(path.join(RELAY, 'wsshd.js'), 'utf8');
const m = /^const MOSHI_PS = (\/.*\/);$/m.exec(src);
if (!m) { console.log('FAIL: could not find "const MOSHI_PS = /.../;" line in wsshd.js'); process.exit(1); }
const MOSHI_PS = eval(m[1]);
console.log('extracted MOSHI_PS from wsshd.js source: ' + m[1]);

let failures = 0;
function ok(cond, label) {
  console.log((cond ? 'OK ' : 'FAIL ') + label);
  if (!cond) failures++;
}

// Real probe bodies, pulled from production wsshd.log the same way b3_e2e.js
// pulls TermRover's scripts (JSON.parse of the logged `exec "..."` text).
function cmdOf(line) {
  const s = line.indexOf(' exec ') + 6;
  let e = line.length;
  // trailing log suffix is one of: ' pipe', ' pipe(powershell)', or
  // ' pid=<n> exit=<n>[ signal=<s>]' -- strip back to the closing quote of
  // the JSON string instead of guessing the suffix shape.
  e = line.lastIndexOf('"') + 1;
  return JSON.parse(line.slice(s, e));
}
const logLines = fs.readFileSync(path.join(RELAY, 'wsshd.log'), 'utf8').split('\n');
const muxLine = [...logLines].reverse().find(l => l.includes('__MOSHI_MULTIPLEXER_SNAPSHOT_V1__') && l.includes(' exec "'));
const hookLine = [...logLines].reverse().find(l => l.includes('__MOSHI_HOOK_PROBE_V2__') && l.includes(' exec "'));
if (!muxLine || !hookLine) { console.log('FAIL: could not find Moshi probe lines in wsshd.log'); process.exit(1); }
const MUX_PROBE = cmdOf(muxLine);
const HOOK_PROBE = cmdOf(hookLine);

// 1. matches the real multiplexer-snapshot probe
ok(MOSHI_PS.test(MUX_PROBE), '1. MOSHI_PS matches real __MOSHI_MULTIPLEXER_SNAPSHOT_V1__ probe from wsshd.log');

// 2. matches the real hook probe
ok(MOSHI_PS.test(HOOK_PROBE), '2. MOSHI_PS matches real __MOSHI_HOOK_PROBE_V2__ probe from wsshd.log');

// 3. does not match a plain bash command
ok(!MOSHI_PS.test('echo hi'), "3. MOSHI_PS does not match 'echo hi'");

// 4. does not match a TermRover-style multi-line bash script
const trScript = "export PATH=\"$HOME/.local/bin\":\"$HOME/bin\"\nif command -v herdr >/dev/null 2>&1; then echo found; fi\n";
ok(!MOSHI_PS.test(trScript), '4. MOSHI_PS does not match a multi-line TermRover-style bash script');

// 5. does not match Moshi's own platform-detect command
ok(!MOSHI_PS.test('cmd.exe /d /s /c "echo __MOSHI_WINDOWS__"'), '5. MOSHI_PS does not match cmd.exe /d /s /c platform probe');

// 6. does not match Moshi's heartbeat
ok(!MOSHI_PS.test('true'), "6. MOSHI_PS does not match 'true'");

// 7. does not match a bash script that merely mentions the marker string
// inside a comment/echo, not as a leading PowerShell assignment
ok(!MOSHI_PS.test('echo "$marker = \'__MOSHI_FOO_V1__\'"'), '7. MOSHI_PS does not match the marker text when it is not the leading PowerShell assignment line');

// 8. does not match when '$marker=' has no space and no leading single-line anchor context missing quote
ok(!MOSHI_PS.test("marker = '__MOSHI_FOO_V1__'"), "8. MOSHI_PS does not match without the leading '$' sigil");

// 9. UTF-16LE base64 round-trip: what wsshd.js does with
// Buffer.from(command, 'utf16le').toString('base64') must decode back to
// the exact original command bytes.
const sample = MUX_PROBE;
const encoded = Buffer.from(sample, 'utf16le').toString('base64');
const decoded = Buffer.from(encoded, 'base64').toString('utf16le');
ok(decoded === sample, '9. UTF-16LE base64 round-trip reproduces the original probe text exactly (' + decoded.length + ' vs ' + sample.length + ' chars)');

// 10. the same base64 blob, fed to the REAL powershell.exe -EncodedCommand
// on this machine, decodes and runs correctly (belt-and-suspenders: proves
// the encoding matches what powershell.exe itself expects, not just a
// self-consistent Node round-trip).
const psScript = "$marker = '__D1_ENCODE_CHECK__'\nWrite-Output \"$marker`tok\"";
const psEncoded = Buffer.from(psScript, 'utf16le').toString('base64');
const r = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', psEncoded], { encoding: 'utf8' });
console.log('--- real powershell.exe -EncodedCommand output ---');
console.log('exit=' + r.status + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + JSON.stringify(r.stderr));
ok(r.status === 0 && /__D1_ENCODE_CHECK__\tok/.test(r.stdout || ''),
  '10. real powershell.exe -EncodedCommand decodes and runs the base64-encoded script correctly');

console.log(failures === 0 ? 'D1 OVERALL: OK' : ('D1 OVERALL: FAIL (' + failures + ' failure(s))'));
process.exit(failures === 0 ? 0 : 1);
