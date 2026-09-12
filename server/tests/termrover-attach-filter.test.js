// B2: unit tests for the input filter exported by termrover-attach.js
// (require.main !== module here, so requiring it does NOT run main()/spawn
// anything -- it just returns { createInputFilter }).
const { createInputFilter } = require('../termrover-attach.js');

let failures = 0;
function ok(cond, label) {
  console.log((cond ? 'OK ' : 'FAIL ') + label);
  if (!cond) failures++;
}
function hex(buf) { return Buffer.isBuffer(buf) ? buf.toString('hex') : String(buf); }

function newFilter(rows) {
  const actions = [];
  const filter = createInputFilter({ rows: rows || 24, onAction: a => actions.push(a) });
  return { filter, actions };
}

// 1. 'a' -> input 61
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('a'));
  ok(actions.length === 1 && actions[0].input && hex(actions[0].input) === '61', "1. 'a' -> input 61");
}

// 2. ESC[<64;11;6M -> scroll up, lines=3, column=10, row=5, src=wheel
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<64;11;6M', 'binary'));
  const a = actions[0];
  ok(actions.length === 1 && a && a.scroll &&
    a.scroll.direction === 'up' && a.scroll.lines === 3 &&
    a.scroll.column === 10 && a.scroll.row === 5 && a.scroll.source === 'wheel',
    '2. ESC[<64;11;6M -> scroll up lines=3 column=10 row=5 src=wheel (got ' + JSON.stringify(a) + ')');
}

// 3. ESC[<65;1;1M -> scroll down
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<65;1;1M', 'binary'));
  const a = actions[0];
  ok(actions.length === 1 && a && a.scroll && a.scroll.direction === 'down',
    '3. ESC[<65;1;1M -> scroll down (got ' + JSON.stringify(a) + ')');
}

// 4. ESC[<0;11;6M -> no action, mouse_dropped += 1
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<0;11;6M', 'binary'));
  ok(actions.length === 0 && filter.stats.mouseDropped === 1,
    '4. ESC[<0;11;6M -> no action, mouse_dropped=1 (got actions=' + actions.length + ' dropped=' + filter.stats.mouseDropped + ')');
}

// 5. ESC[<64;11;6m (release) -> no action
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<64;11;6m', 'binary'));
  ok(actions.length === 0, '5. ESC[<64;11;6m (release) -> no action (got ' + actions.length + ')');
}

// 6. ESC[5~ (rows=24) -> scroll up, lines=23, src=page_key
{
  const { filter, actions } = newFilter(24);
  filter.feed(Buffer.from('\x1b[5~', 'binary'));
  const a = actions[0];
  ok(actions.length === 1 && a && a.scroll && a.scroll.direction === 'up' &&
    a.scroll.lines === 23 && a.scroll.source === 'page_key',
    '6. ESC[5~ rows=24 -> scroll up lines=23 src=page_key (got ' + JSON.stringify(a) + ')');
}

// 7. ESC[200~one + 0x02q\ntwo + ESC[201~ in three chunks -> input concatenation
// equals the original bytes exactly, no detach.
{
  const { filter, actions } = newFilter();
  const c1 = Buffer.from('\x1b[200~one', 'binary');
  const c2 = Buffer.concat([Buffer.from([0x02]), Buffer.from('q\ntwo', 'binary')]);
  const c3 = Buffer.from('\x1b[201~', 'binary');
  const original = Buffer.concat([c1, c2, c3]);
  filter.feed(c1);
  filter.feed(c2);
  filter.feed(c3);
  const inputActions = actions.filter(a => a.input);
  const detachActions = actions.filter(a => a.detach);
  const reassembled = Buffer.concat(inputActions.map(a => a.input));
  ok(reassembled.equals(original) && detachActions.length === 0,
    '7. bracketed paste split across 3 chunks reassembles byte-for-byte, no detach ' +
    '(reassembled=' + hex(reassembled) + ' original=' + hex(original) + ' detach=' + detachActions.length + ')');
}

// 8. 0x02 then q -> detach
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from([0x02]));
  filter.feed(Buffer.from('q'));
  ok(actions.length === 1 && actions[0].detach === true, '8. 0x02 then q -> detach (got ' + JSON.stringify(actions) + ')');
}

// 9. 0x02 then 0x02 -> input 02
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from([0x02]));
  filter.feed(Buffer.from([0x02]));
  ok(actions.length === 1 && actions[0].input && hex(actions[0].input) === '02',
    '9. 0x02 then 0x02 -> input 02 (got ' + JSON.stringify(actions.map(a => a.input && hex(a.input))) + ')');
}

// 10. 0x02 then x -> input 0278
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from([0x02]));
  filter.feed(Buffer.from('x'));
  ok(actions.length === 1 && actions[0].input && hex(actions[0].input) === '0278',
    '10. 0x02 then x -> input 0278 (got ' + JSON.stringify(actions.map(a => a.input && hex(a.input))) + ')');
}

// 11. ESC[<6 and 4;2;3M in two chunks -> scroll up, column=1, row=2
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<6', 'binary'));
  ok(actions.length === 0, '11a. first partial chunk produces no action yet');
  filter.feed(Buffer.from('4;2;3M', 'binary'));
  const a = actions[0];
  ok(actions.length === 1 && a && a.scroll && a.scroll.direction === 'up' &&
    a.scroll.column === 1 && a.scroll.row === 2,
    '11. ESC[<6 + 4;2;3M split across 2 chunks -> scroll up column=1 row=2 (got ' + JSON.stringify(a) + ')');
}

// 12. a lone ESC, after 60ms -> input 1b
{
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from([0x1b]));
  setTimeout(() => {
    const ok12 = actions.length === 1 && actions[0].input && hex(actions[0].input) === '1b';
    ok(ok12, '12. lone ESC, after 60ms -> input 1b (got ' + JSON.stringify(actions.map(a => a.input && hex(a.input))) + ')');
    finishAfter12();
  }, 60);
}

function finishAfter12() {
  // 13. ESC[<68;11;6M (shift bit set) -> modifiers=1
  const { filter, actions } = newFilter();
  filter.feed(Buffer.from('\x1b[<68;11;6M', 'binary'));
  const a = actions[0];
  ok(actions.length === 1 && a && a.scroll && a.scroll.modifiers === 1,
    '13. ESC[<68;11;6M -> modifiers=1 (got ' + JSON.stringify(a) + ')');

  console.log(failures === 0 ? 'B2 OVERALL: OK' : ('B2 OVERALL: FAIL (' + failures + ' failure(s))'));
  process.exit(failures === 0 ? 0 : 1);
}
