const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const API = 'https://amp-api.music.apple.com/v1/catalog/us/';

function song(id, name, extra = {}) {
  return {
    id: String(id),
    type: 'songs',
    attributes: {
      name,
      artistName: extra.artist || 'Example artist',
      albumName: extra.albumName || 'Example album',
      durationInMillis: 200000,
      isrc: extra.isrc || `ISRC${id}`,
      url: `https://music.apple.com/us/album/example/${extra.albumId || 900}?i=${id}`,
      previews: [{ url: `https://example.test/preview/${id}.m4a` }],
      artwork: { url: 'https://example.test/art/{w}x{h}.jpg' },
    },
    ...(extra.relationships ? { relationships: extra.relationships } : {}),
  };
}

function album(id, name, songs) {
  return {
    id: String(id),
    type: 'albums',
    attributes: { name, artistName: 'Example artist', releaseDate: '2020-01-01', trackCount: songs.length },
    relationships: {
      tracks: { data: songs },
      artists: { data: [{ id: `artist-${id}`, type: 'artists', attributes: { url: 'https://example.test/artist' } }] },
    },
  };
}

function runtime(routes) {
  const calls = [];
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: {
      get() { return JSON.stringify({ token: 'test-token', tokenExpiry: Date.now() + 3600000 }); },
      set() {},
    },
    utils: { randomUserAgent() { return 'test'; } },
    matching: {
      compareStrings(a, b) { return String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0; },
      compareDuration() { return 1; },
    },
    http: {
      get(url) {
        const relative = url.slice(API.length);
        calls.push(relative);
        for (const [prefix, handler] of routes) {
          if (relative.startsWith(prefix)) {
            const result = typeof handler === 'function' ? handler(relative) : handler;
            if (result && result.statusCode) return result;
            return { statusCode: 200, body: JSON.stringify(result) };
          }
        }
        return { statusCode: 404, body: '{}' };
      },
    },
  });
  vm.runInContext(fs.readFileSync(
    path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'
  ), context);
  context.initialize({ storefront: 'us' });
  return { context, calls, registered };
}

function view(albums) {
  return { data: albums };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('registers getRelatedTracks and declares the capability', () => {
  const { registered } = runtime([]);
  assert.equal(typeof registered.getRelatedTracks, 'function');
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../sources/apple-music/manifest.json'), 'utf8'
  ));
  assert.equal(manifest.capabilities.relatedTracks, true);
});

test('resolves a foreign seed by search and excludes the seed by ISRC', () => {
  const { context, calls } = runtime([
    ['search?', {
      results: { songs: { data: [
        song(11, 'Other song', { albumId: 500 }),
        song(10, 'Example song', { albumId: 501, isrc: 'SEEDISRC' }),
      ] } },
    }],
    ['albums/501/view/you-might-also-like', view([
      album(600, 'Related album', [
        song(20, 'First related', { albumId: 600 }),
        song(21, 'Seed copy', { albumId: 600, isrc: 'SEEDISRC' }),
      ]),
    ])],
  ]);

  const result = context.getRelatedTracks([{
    id: 'foreign-1', name: 'Example song', artists: 'Example artist',
    isrc: 'SEEDISRC', provider_id: 'other-provider',
  }]);

  assert.deepEqual(plain(result.map((t) => t.id)), ['20']);
  const track = result[0];
  assert.equal(track.provider_id, 'apple-music');
  assert.equal(track.album_id, '600');
  assert.equal(track.album_name, 'Related album');
  assert.equal(track.artist_id, 'artist-600');
  assert.equal(track.preview_url, 'https://example.test/preview/20.m4a');
  assert.equal(track.duration_ms, 200000);
  assert.ok(calls[1].includes('include%5Balbums%5D=tracks,artists'));
});

test('uses an own seed id directly and looks up its album', () => {
  const { context, calls } = runtime([
    ['songs/123', { data: [song(123, 'Example song', {
      albumId: 700,
      relationships: { albums: { data: [{ id: '700', type: 'albums' }] } },
    })] }],
    ['albums/700/view/you-might-also-like', view([
      album(800, 'Related album', [song(30, 'Related song', { albumId: 800 })]),
    ])],
  ]);

  const result = context.getRelatedTracks([{
    id: '123', name: 'Example song', artists: 'Example artist', provider_id: 'apple-music',
  }], { limit: 5 });

  assert.deepEqual(plain(result.map((t) => t.id)), ['30']);
  assert.ok(calls.every((call) => !call.startsWith('search')));
  assert.equal(calls[0], 'songs/123');
});

test('interleaves seeds, dedupes, excludes seed ids and honours the limit', () => {
  const { context } = runtime([
    ['albums/1/view/you-might-also-like', view([
      album(101, 'A1', [song(1001, 'A1')]),
      album(102, 'A2', [song(1002, 'A2')]),
      album(103, 'A3', [song(3000, 'Shared')]),
      album(104, 'A4', [song(2, 'Seed two')]),
    ])],
    ['albums/2/view/you-might-also-like', view([
      album(201, 'B1', [song(2001, 'B1')]),
      album(202, 'B2', [song(3000, 'Shared')]),
      album(203, 'B3', [song(2003, 'B3')]),
    ])],
  ]);
  const seeds = [
    { id: '1', album_id: '1', name: 'Seed one', artists: 'Example artist', provider_id: 'apple-music' },
    { id: '2', album_id: '2', name: 'Seed two', artists: 'Example artist', provider_id: 'apple-music' },
  ];

  const all = context.getRelatedTracks(seeds, { limit: 50 });
  assert.deepEqual(plain(all.map((t) => t.id)), ['1001', '2001', '1002', '3000', '2003']);

  const limited = context.getRelatedTracks(seeds, { limit: 3 });
  assert.deepEqual(plain(limited.map((t) => t.id)), ['1001', '2001', '1002']);
});

test('puts the title track of each related album first', () => {
  const { context } = runtime([
    ['albums/1/view/you-might-also-like', view([
      album(101, 'Big Song - Single', [song(1, 'Intro'), song(2, 'Big Song')]),
      album(102, 'Other', [song(3, 'Opener'), song(4, 'Second')]),
    ])],
  ]);
  const result = context.getRelatedTracks([
    { id: '9', album_id: '1', name: 'Seed', artists: 'Example artist', provider_id: 'apple-music' },
  ]);
  assert.deepEqual(plain(result.map((t) => t.id)), ['2', '3', '1', '4']);
});

test('returns an empty list when nothing is related or no seed matches', () => {
  const { context } = runtime([
    ['search?', { results: { songs: { data: [] } } }],
    ['albums/1/view/you-might-also-like', view([])],
  ]);
  assert.deepEqual(plain(context.getRelatedTracks([
    { id: '9', album_id: '1', name: 'Seed', artists: 'Example artist', provider_id: 'apple-music' },
  ])), []);
  assert.deepEqual(plain(context.getRelatedTracks([
    { id: 'x', name: 'Unknown song', artists: 'Unknown artist', provider_id: 'other' },
  ])), []);
  assert.deepEqual(plain(context.getRelatedTracks([])), []);
});

test('throws only when every attempted request failed', () => {
  const failing = runtime([
    ['albums/', { statusCode: 400, body: '{}' }],
  ]);
  assert.throws(() => failing.context.getRelatedTracks([
    { id: '9', album_id: '1', name: 'Seed', artists: 'Example artist', provider_id: 'apple-music' },
  ]), /related tracks failed/);

  const partial = runtime([
    ['albums/1/view/', { statusCode: 400, body: '{}' }],
    ['albums/2/view/you-might-also-like', view([album(201, 'B1', [song(2001, 'B1')])])],
  ]);
  const result = partial.context.getRelatedTracks([
    { id: '9', album_id: '1', name: 'Seed', artists: 'Example artist', provider_id: 'apple-music' },
    { id: '8', album_id: '2', name: 'Seed two', artists: 'Example artist', provider_id: 'apple-music' },
  ]);
  assert.deepEqual(plain(result.map((t) => t.id)), ['2001']);
});
