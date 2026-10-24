const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime() {
  const ctx = vm.createContext({
    registerExtension() {}, log: { info() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources/qobuz-web/index.js'), 'utf8'), ctx);
  return ctx;
}
const SAMPLE = 'https://streaming.example.test/sample.mp3';
const track = (id, extra = {}) => ({ id, title: 'Signal', performer: { name: 'Artist' },
  duration: 180, album: { id: 'album1', title: 'Collection' }, ...extra });
const unplayable = { previewable: false, sampleable: false, streamable: false };

function sampleServer(c, payload = { url: SAMPLE, sample: true, duration: 30 }) {
  const calls = [];
  c.http = { get(url) {
    calls.push(url);
    return { statusCode: 200, body: JSON.stringify(payload) };
  } };
  return calls;
}

test('search results carry deferred preview links without sample lookups', () => {
  const c = runtime();
  c.searchTracksWithFallback = () => [track('101'), track('102', unplayable)];
  c.http = { get: () => assert.fail('a deferred preview must not be looked up during search') };
  for (const results of [c.customSearch('Signal', { filter: 'track' }), c.searchTracks('Signal', 2)]) {
    assert.equal(results[0].preview_url, 'mornye-preview:qobuz-web/101');
    assert.equal(results[1].preview_url, undefined);
  }
});

test('resolvePreview returns a cached sample link for a track', () => {
  const c = runtime();
  const calls = sampleServer(c);
  assert.equal(c.resolvePreview({ id: '101' }).preview_url, SAMPLE);
  assert.equal(c.resolvePreview({ id: 'qobuz:101' }).preview_url, SAMPLE);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/track\/getFileUrl\?.*track_id=101/);
});

test('resolvePreview rejects full streams and invalid IDs', () => {
  const c = runtime();
  const calls = sampleServer(c, { url: SAMPLE, sample: false, duration: 180 });
  assert.equal(c.resolvePreview({ id: '101' }).preview_url, '');
  assert.equal(c.resolvePreview({ id: 'album/101' }).preview_url, '');
  assert.equal(c.resolvePreview({}).preview_url, '');
  assert.equal(calls.length, 1);
});

test('a failed sample lookup is not cached', () => {
  const c = runtime();
  let calls = 0;
  c.http = { get() {
    calls++;
    return calls === 1 ? { statusCode: 503, body: '' }
      : { statusCode: 200, body: JSON.stringify({ url: SAMPLE, sample: true, duration: 30 }) };
  } };
  assert.equal(c.resolvePreview({ id: '101' }).preview_url, '');
  assert.equal(c.resolvePreview({ id: '101' }).preview_url, SAMPLE);
  assert.equal(calls, 2);
});
