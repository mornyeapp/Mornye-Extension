const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const context = vm.createContext({ registerExtension() {}, log: { info() {}, warn() {}, error() {}, debug() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'), context);
  return context;
}
const ttml = (timing, lines) => `<tt xmlns="http://www.w3.org/ns/ttml" itunes:timing="${timing}"><body><div>${
  lines.map(([begin, text], i) => `<p begin="${begin}" end="${begin}" itunes:key="L${i + 1}">${text}</p>`).join('')
}</div></body></tt>`;
const convert = (context, xml) => JSON.parse(JSON.stringify(context.ttmlToLyricsResult(context.parseTTML(xml))));

test('lines that all start at 0 are reported as unsynced, not as 00:00.00 lyrics', () => {
  const context = load();
  const result = convert(context, ttml('Line', [['0s', 'first line'], ['0s', 'second line'], ['0s', 'third line']]));
  assert.equal(result.syncType, 'UNSYNCED');
  assert.equal(result.plainLyrics, 'first line\nsecond line\nthird line');
});

test('itunes:timing="None" is unsynced even if the lines carry different stamps', () => {
  const context = load();
  const result = convert(context, ttml('None', [['1s', 'a'], ['2s', 'b']]));
  assert.equal(result.syncType, 'UNSYNCED');
});

test('really timed lines stay line synced', () => {
  const context = load();
  const result = convert(context, ttml('Line', [['0s', 'first'], ['4.5s', 'second'], ['9s', 'third']]));
  assert.equal(result.syncType, 'LINE_SYNCED');
  assert.deepEqual(result.lines.map(line => line.startTimeMs), [0, 4500, 9000]);
});

test('a single line at 0 is not treated as missing timing', () => {
  const context = load();
  assert.equal(convert(context, ttml('Line', [['0s', 'only']])).syncType, 'LINE_SYNCED');
});
