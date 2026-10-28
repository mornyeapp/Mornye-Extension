const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/jiosaavn');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
// Arrays from the vm context have another realm's prototype.
const ids = list => Array.from(list, track => track.id);

const song = (id, extra = {}, more = {}) => ({
  id, title: 'Example song ' + id, type: 'song',
  perma_url: 'https://www.jiosaavn.com/song/example/' + id + '-token',
  image: 'https://c.saavncdn.com/' + id + '-150x150.jpg',
  more_info: {
    album: 'Example album', album_id: 'a' + id, duration: '200',
    artistMap: { primary_artists: [{ id: 'p' + id, name: 'Example artist' }] },
    ...more,
  },
  ...extra,
});

function runtime(respond = () => ({})) {
  const calls = [];
  let extension;
  const context = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {}, remove() {} },
    http: { get(url) {
      const params = new URL(url).searchParams;
      calls.push(params);
      const result = respond(params.get('__call'), params);
      if (result && result.failure) return result.failure;
      return { ok: true, statusCode: 200, body: JSON.stringify(result) };
    } },
  });
  vm.runInContext(source, context);
  return { extension, calls };
}

const recoCalls = calls => calls.filter(p => p.get('__call') === 'reco.getreco').map(p => p.get('pid'));

test('manifest declares related tracks', () => {
  assert.equal(manifest.version, '1.0.9');
  assert.equal(manifest.capabilities.relatedTracks, true);
});

test('own seed id is used directly with the android recommendation context', () => {
  const { extension, calls } = runtime((call, params) => ({ [params.get('pid')]: [song('Seed0001'), song('Rel00001')] }));
  const result = extension.getRelatedTracks([{ id: 'Seed0001', name: 'Seed', artists: 'Example artist', provider_id: 'jiosaavn' }], {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get('ctx'), 'android');
  assert.equal(calls[0].get('api_version'), '4');
  assert.deepEqual(ids(result), ['Rel00001']);
  const track = result[0];
  assert.equal(track.name, 'Example song Rel00001');
  assert.equal(track.artists, 'Example artist');
  assert.equal(track.album_name, 'Example album');
  assert.equal(track.duration_ms, 200000);
  assert.equal(track.provider_id, 'jiosaavn');
  assert.equal(track.cover_url, 'https://c.saavncdn.com/Rel00001-500x500.jpg');
  assert.ok('preview_url' in track);
});

test('foreign seed resolves through search with name, artist, and duration checks', () => {
  const { extension, calls } = runtime((call, params) => {
    if (call === 'search.getResults') {
      return { results: [
        song('Wrong001', { title: 'Example song (Live)' }),
        song('Long0001', { title: 'Foreign song' }, { duration: '400' }),
        song('Match001', { title: 'Foreign song' }),
      ] };
    }
    return params.get('pid') === 'Match001' ? [song('Rel00002')] : [];
  });
  const result = extension.getRelatedTracks([
    { id: 'x1', name: 'Foreign song', artists: ['Example artist'], duration_ms: 201000, provider_id: 'other' },
  ], {});
  assert.equal(calls[0].get('q'), 'Foreign song Example artist');
  assert.deepEqual(recoCalls(calls), ['Match001']);
  assert.deepEqual(ids(result), ['Rel00002']);
});

test('foreign seed without a confident match is skipped', () => {
  const { extension, calls } = runtime(() => ({ results: [song('Other001', { title: 'Another song' })] }));
  assert.equal(extension.getRelatedTracks([{ name: 'Foreign song', artists: 'Example artist', provider_id: 'other' }], {}).length, 0);
  assert.equal(recoCalls(calls).length, 0);
});

test('results interleave across seeds, dedupe, exclude seeds, and honor the limit', () => {
  const mixes = {
    Seed0001: [song('Seed0001'), song('Rel00011'), song('Rel00012'), song('Rel00013'), song('Seed0002')],
    Seed0002: [song('Rel00011'), song('Rel00021', {}, { isrc: 'XXAAA2400001' }), song('Rel00022'), song('Rel00023')],
  };
  const respond = (call, params) => call === 'search.getResults' ? { results: [] } : { [params.get('pid')]: mixes[params.get('pid')] };
  const seeds = [
    { id: 'Seed0001', name: 'A', artists: 'Example artist', provider_id: 'jiosaavn' },
    { id: 'Seed0002', name: 'B', artists: 'Example artist', provider_id: 'jiosaavn' },
    { id: 'x', name: 'C', artists: 'Example artist', isrc: 'XX-AAA-24-00001', provider_id: 'other' },
  ];
  assert.deepEqual(ids(runtime(respond).extension.getRelatedTracks(seeds, { limit: 50 })),
    ['Rel00011', 'Rel00012', 'Rel00022', 'Rel00013', 'Rel00023']);
  assert.deepEqual(ids(runtime(respond).extension.getRelatedTracks(seeds, { limit: 2 })),
    ['Rel00011', 'Rel00012']);
});

test('at most five seeds are resolved and empty recommendations return an empty list', () => {
  const seeds = Array.from({ length: 8 }, (_, i) => ({ id: 'Seed000' + i, name: 'S', artists: 'A', provider_id: 'jiosaavn' }));
  const { extension, calls } = runtime(() => []);
  assert.equal(extension.getRelatedTracks(seeds, { limit: 99 }).length, 0);
  assert.equal(recoCalls(calls).length, 5);
  assert.equal(extension.getRelatedTracks([], {}).length, 0);
  assert.equal(extension.getRelatedTracks(null).length, 0);
});

test('throws only when every request failed', () => {
  const failing = runtime(() => ({ failure: { ok: false, statusCode: 0, error: 'connection timeout' } }));
  assert.throws(() => failing.extension.getRelatedTracks([
    { id: 'Seed0001', name: 'S', artists: 'A', provider_id: 'jiosaavn' },
    { name: 'Foreign song', artists: 'Example artist', provider_id: 'other' },
  ], {}), /connection timeout/);

  const partial = runtime((call, params) => call === 'search.getResults'
    ? { failure: { ok: false, statusCode: 503 } }
    : { [params.get('pid')]: [song('Rel00031')] });
  const result = partial.extension.getRelatedTracks([
    { name: 'Foreign song', artists: 'Example artist', provider_id: 'other' },
    { id: 'Seed0003', name: 'S', artists: 'A', provider_id: 'jiosaavn' },
  ], {});
  assert.deepEqual(ids(result), ['Rel00031']);
});
