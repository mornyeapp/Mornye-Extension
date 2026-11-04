const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/deezer');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const json = body => ({ statusCode: 200, body: JSON.stringify(body) });
// Arrays from the vm context have another realm's prototype.
const ids = list => Array.from(list, track => track.id);

const song = (id, extra = {}) => ({
  SNG_ID: String(id), SNG_TITLE: 'Example song ' + id, VERSION: '', DURATION: '200',
  ISRC: 'XX0000000' + id, ALB_ID: '9' + id, ALB_TITLE: 'Example album', ALB_PICTURE: 'abc' + id,
  ART_ID: '7' + id, ART_NAME: 'Example artist',
  ARTISTS: [{ ART_ID: '7' + id, ART_NAME: 'Example artist' }],
  MEDIA: [{ TYPE: 'preview', HREF: 'https://cdnt-preview.dzcdn.net/' + id + '.mp3' }],
  DIGITAL_RELEASE_DATE: '2020-01-02', EXPLICIT_LYRICS: '0',
  ...extra,
});

function runtime({ mixes = {}, get = () => json({ error: { code: 800 } }), mixError } = {}) {
  const calls = { gets: [], mixes: [] };
  let extension;
  const context = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { randomUserAgent: () => 'Test', appUserAgent: () => 'Test' },
    matching: {
      normalizeString: value => String(value || '').toLowerCase().trim(),
      compareStrings: (a, b) => (a === b ? 1 : 0),
    },
    http: {
      get(url) { calls.gets.push(url); return get(url); },
      post(url, body) {
        const method = new URL(url).searchParams.get('method');
        if (method === 'deezer.getUserData') return json({ error: [], results: { checkForm: 'token' } });
        const id = JSON.parse(body).sng_id;
        calls.mixes.push(id);
        if (mixError) return mixError;
        return json({ error: [], results: { data: mixes[id] || [] } });
      },
    },
  });
  vm.runInContext(source, context);
  return { extension, calls };
}

test('manifest declares related tracks', () => {
  assert.equal(manifest.version, '1.3.10');
  assert.equal(manifest.capabilities.relatedTracks, true);
});

test('own seed id is used directly and results map like search tracks', () => {
  const { extension, calls } = runtime({ mixes: { 100: [song(100), song(201, { VERSION: '(Radio Edit)' })] } });
  const result = extension.getRelatedTracks([{ id: 'deezer:100', name: 'Seed', artists: 'Example artist', provider_id: 'deezer' }], {});
  assert.equal(calls.gets.length, 0);
  assert.deepEqual(calls.mixes, ['100']);
  assert.equal(result.length, 1);
  const track = result[0];
  assert.equal(track.id, 'deezer:201');
  assert.equal(track.name, 'Example song 201 (Radio Edit)');
  assert.equal(track.artists, 'Example artist');
  assert.equal(track.album_name, 'Example album');
  assert.equal(track.album_id, 'deezer:9201');
  assert.equal(track.artist_id, 'deezer:7201');
  assert.equal(track.duration_ms, 200000);
  assert.equal(track.isrc, 'XX0000000201');
  assert.equal(track.provider_id, 'deezer');
  assert.equal(track.preview_url, 'https://cdnt-preview.dzcdn.net/201.mp3');
  assert.equal(track.release_date, '2020-01-02');
  assert.match(track.cover_url, /\/images\/cover\/abc201\/1400x1400-/);
});

test('foreign seed resolves by ISRC, without ISRC by search, and skips misses', () => {
  const { extension, calls } = runtime({
    mixes: { 300: [song(301)], 400: [song(401)] },
    get(url) {
      if (url.includes('/track/isrc:SEEDISRC1')) return json({ id: 300, isrc: 'SEEDISRC1' });
      if (url.includes('/track/isrc:')) return json({ error: { code: 800 } });
      if (url.includes('/search?')) return json({ data: [{ id: 400, title: 'Foreign song', artist: { name: 'Example artist' } }] });
      return { statusCode: 404 };
    },
  });
  const result = extension.getRelatedTracks([
    { id: 'x1', name: 'Seed one', artists: 'Example artist', isrc: 'seedisrc1', provider_id: 'other' },
    { id: 'x2', name: 'Missing', artists: 'Example artist', isrc: 'NOPE', provider_id: 'other' },
    { id: 'x3', name: 'Foreign song', artists: ['Example artist'], provider_id: 'other' },
  ], { limit: 10 });
  assert.deepEqual(calls.mixes, ['300', '400']);
  assert.equal(calls.gets.length, 3);
  assert.ok(calls.gets[2].includes('q=' + encodeURIComponent('Foreign song Example artist')));
  assert.deepEqual(ids(result), ['deezer:301', 'deezer:401']);
});

test('results interleave across seeds, dedupe, exclude seeds, and honor the limit', () => {
  const mixes = {
    1: [song(1), song(11), song(12), song(13), song(2)],
    2: [song(11), song(21, { ISRC: 'SEED3ISRC' }), song(22), song(23)],
  };
  const seeds = [
    { id: '1', name: 'A', artists: 'Example artist', provider_id: 'deezer' },
    { id: 'deezer:2', name: 'B', artists: 'Example artist', provider_id: 'deezer' },
    { id: 'x', name: 'C', artists: 'Example artist', isrc: 'SEED3ISRC', provider_id: 'other' },
  ];
  const { extension } = runtime({ mixes });
  assert.deepEqual(ids(extension.getRelatedTracks(seeds, { limit: 50 })),
    ['deezer:11', 'deezer:12', 'deezer:22', 'deezer:13', 'deezer:23']);
  assert.deepEqual(ids(runtime({ mixes }).extension.getRelatedTracks(seeds, { limit: 3 })),
    ['deezer:11', 'deezer:12', 'deezer:22']);
});

test('at most five seeds are resolved', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), name: 'S', artists: 'A', provider_id: 'deezer' }));
  const { extension, calls } = runtime();
  assert.equal(extension.getRelatedTracks(seeds, { limit: 0 }).length, 0);
  assert.equal(calls.mixes.length, 5);
});

test('empty input and empty mixes return an empty list', () => {
  const { extension } = runtime();
  assert.equal(extension.getRelatedTracks([], {}).length, 0);
  assert.equal(extension.getRelatedTracks(null).length, 0);
  assert.equal(extension.getRelatedTracks([{ id: '5', name: 'S', artists: 'A', provider_id: 'deezer' }], {}).length, 0);
});

test('throws only when every request failed', () => {
  const failing = runtime({ mixError: { error: 'connection timeout' } });
  assert.throws(() => failing.extension.getRelatedTracks([{ id: '5', name: 'S', artists: 'A', provider_id: 'deezer' }], {}),
    /connection timeout/);

  const partial = runtime({
    mixes: { 6: [song(61)] },
    get: () => ({ error: 'connection timeout' }),
  });
  const result = partial.extension.getRelatedTracks([
    { id: 'x', name: 'S', artists: 'A', isrc: 'ABC', provider_id: 'other' },
    { id: '6', name: 'T', artists: 'A', provider_id: 'deezer' },
  ], {});
  assert.deepEqual(ids(result), ['deezer:61']);
});
