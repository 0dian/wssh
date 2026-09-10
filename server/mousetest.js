// mousetest — prove (or disprove) that mouse input reaches a program through a
// given SSH path, without a human at the keyboard.
//
//   ssh -tt host node mousetest.js        # then the client sends ESC [ < 0;10;5 M
//
// Enables xterm mouse reporting (?1003;1006), prints MOUSETEST-READY, dumps every
// chunk it receives as hex, and prints MOUSE-OK the moment a chunk carries
// ESC [ <  (an SGR mouse report). Exits 0 on MOUSE-OK, 1 after MOUSETEST_TIMEOUT ms
// (default 8 s) without it. Through the stock Win32-OpenSSH pty on an old conhost
// the bytes never arrive.

'use strict';
const ENABLE = '\x1b[?1003;1006h';
const DISABLE = '\x1b[?1003;1006l';
const envTimeout = Number(process.env.MOUSETEST_TIMEOUT);
const TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 8000;
let ok = false;

function finish(code) {
  try { process.stdout.write(DISABLE); } catch (e) {}
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (e) {}
  setTimeout(() => process.exit(code), 100);
}

if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch (e) {} }
process.stdin.resume();
process.stdout.write(ENABLE + 'MOUSETEST-READY\r\n');

process.stdin.on('data', b => {
  process.stdout.write('RX ' + b.toString('hex') + '\r\n');
  if (!ok && b.indexOf(Buffer.from([0x1b, 0x5b, 0x3c])) !== -1) {
    ok = true;
    process.stdout.write('MOUSE-OK\r\n');
    finish(0);
  }
});
setTimeout(() => { if (!ok) { process.stdout.write('MOUSE-TIMEOUT\r\n'); finish(1); } }, TIMEOUT_MS);
