const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../sources/tidal-web/index.js'), 'utf8');

function raw(id, title, artist, isrc, duration) {
  return {
    id: id,
    title: title,
    artists: [{ id: id + 1000, name: artist }],
    album: { id: id + 2000, title: title + ' album', cover: 'aaaa-bbbb' },
    isrc: isrc || '',
    duration: duration || 200,
  };
}

function load(routes) {
  const requests = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    utils: {},
    http: {
      get(url) {
        requests.push(url);
        for (const route of routes) {
          if (url.indexOf(route[0]) >= 0) {
            const value = route[1];
            if (value instanceof Error) return { error: value.message };
            return { statusCode: 200, body: JSON.stringify(value) };
          }
        }
        return { statusCode: 404, body: '' };
      },
    },
  });
  vm.runInContext(source, context);
  return { context, requests };
}

const seedRaw = raw(100, 'Example song', 'Example artist', 'XX0000000001', 200);
const radioA = {
  items: [
    seedRaw,
    raw(201, 'Related one', 'Example artist', 'XX0000000201'),
    raw(202, 'Related two', 'Other artist', 'XX0000000202'),
    raw(203, 'Related three', 'Other artist', 'XX0000000203'),
  ],
};
const radioB = {
  items: [
    raw(300, 'Second seed', 'Second artist', 'XX0000000300'),
    raw(301, 'Related four', 'Second artist', 'XX0000000301'),
    raw(202, 'Related two', 'Other artist', 'XX0000000202'),
    raw(302, 'Seed copy', 'Example artist', 'XX0000000001'),
    raw(303, 'Related five', 'Second artist', 'XX0000000303'),
  ],
};

test('foreign seed resolves through search and returns mapped radio tracks', () => {
  const app = load([
    ['/search/tracks', { items: [seedRaw] }],
    ['/tracks/100/radio', radioA],
  ]);
  const result = app.context.getRelatedTracks([{
    id: 'spotify:abc', name: 'Example song', artists: 'Example artist',
    isrc: 'XX0000000001', duration_ms: 200000, provider_id: 'spotify',
  }], { limit: 10 });
  assert.deepEqual(Array.from(result, t => t.id), ['tidal:201', 'tidal:202', 'tidal:203']);
  assert.equal(result[0].provider_id, 'tidal-web');
  assert.equal(result[0].album_id, 'tidal:2201');
  assert.equal(result[0].duration_ms, 200000);
  assert.equal(result[0].isrc, 'XX0000000201');
  assert.ok(result[0].cover_url.indexOf('resources.tidal.com/images/aaaa/bbbb/') >= 0);
  assert.equal(app.requests.length, 2);
  assert.ok(app.requests[1].indexOf('countryCode=US') >= 0);
});

test('own seed id is used directly without searching', () => {
  const app = load([['/tracks/100/radio', radioA]]);
  const result = app.context.getRelatedTracks([
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', provider_id: 'tidal-web' },
  ], {});
  assert.equal(result.length, 3);
  assert.equal(app.requests.length, 1);
  assert.ok(app.requests[0].indexOf('/tracks/100/radio') >= 0);
});

test('interleaves seeds, dedupes and excludes seed ids and seed isrcs', () => {
  const app = load([
    ['/tracks/100/radio', radioA],
    ['/tracks/300/radio', radioB],
  ]);
  const result = app.context.getRelatedTracks([
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', isrc: 'XX0000000001', provider_id: 'tidal-web' },
    { id: '300', name: 'Second seed', artists: 'Second artist', provider_id: 'tidal-web' },
  ], { limit: 25 });
  assert.deepEqual(Array.from(result, t => t.id),
    ['tidal:201', 'tidal:301', 'tidal:202', 'tidal:203', 'tidal:303']);
});

test('limit caps the result', () => {
  const app = load([
    ['/tracks/100/radio', radioA],
    ['/tracks/300/radio', radioB],
  ]);
  const result = app.context.getRelatedTracks([
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', provider_id: 'tidal-web' },
    { id: 'tidal:300', name: 'Second seed', artists: 'Second artist', provider_id: 'tidal-web' },
  ], { limit: 2 });
  assert.deepEqual(Array.from(result, t => t.id), ['tidal:201', 'tidal:301']);
});

test('unmatched foreign seed and empty radio return an empty list', () => {
  const app = load([
    ['/search/tracks', { items: [raw(900, 'Unrelated', 'Someone else', '', 100)] }],
    ['/tracks/100/radio', { items: [] }],
  ]);
  assert.deepEqual(Array.from(app.context.getRelatedTracks([
    { name: 'Example song', artists: 'Example artist', provider_id: 'spotify' },
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', provider_id: 'tidal-web' },
  ], {})), []);
  assert.deepEqual(Array.from(app.context.getRelatedTracks([], {})), []);
});

test('throws only when every request failed', () => {
  const failing = load([['/tracks/100/radio', new Error('network down')]]);
  assert.throws(() => failing.context.getRelatedTracks([
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', provider_id: 'tidal-web' },
  ], {}), /network down/);

  const partial = load([
    ['/tracks/100/radio', new Error('network down')],
    ['/tracks/300/radio', radioB],
  ]);
  const result = partial.context.getRelatedTracks([
    { id: 'tidal:100', name: 'Example song', artists: 'Example artist', provider_id: 'tidal-web' },
    { id: 'tidal:300', name: 'Second seed', artists: 'Second artist', provider_id: 'tidal-web' },
  ], {});
  assert.equal(result[0].id, 'tidal:301');
});
