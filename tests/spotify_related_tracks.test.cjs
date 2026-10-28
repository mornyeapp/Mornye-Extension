const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/spotify-web');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const json = body => ({ statusCode: 200, headers: {}, body: JSON.stringify(body) });
const cachedSession = {
  accessToken: 'test-access',
  accessTokenExpiry: Date.now() + 3600000,
  clientToken: 'test-client-token',
  clientTokenExpiry: Date.now() + 3600000,
  clientID: 'test-client',
  deviceID: 'a'.repeat(32),
  clientVersion: 'test-version',
  cookies: {},
};

function trackData(id, name, artist, durationMs = 200000) {
  return {
    __typename: 'Track',
    uri: 'spotify:track:' + id,
    name,
    artists: { items: [{ profile: { name: artist }, uri: 'spotify:artist:artist' + id }] },
    albumOfTrack: {
      name: name + ' album',
      uri: 'spotify:album:album' + id,
      artists: { items: [{ profile: { name: artist }, uri: 'spotify:artist:artist' + id }] },
      coverArt: { sources: [{ url: 'https://i.scdn.co/image/ab67616d00001e02' + id, width: 300, height: 300 }] },
    },
    trackDuration: { totalMilliseconds: durationMs },
    previews: { audioPreviews: { items: [{ url: 'https://p.scdn.co/mp3-preview/' + id }] } },
    trackNumber: 1,
    discNumber: 1,
  };
}

function playlistItems(tracks) {
  return { data: { playlistV2: { content: { totalCount: tracks.length, items: tracks.map(data => ({ itemV2: { data } })) } } } };
}

function runtime({ radios = {}, search = [], failRadio = false } = {}) {
  const saved = new Map([['client_state', JSON.stringify(cachedSession)]]);
  const calls = { radio: [], playlist: [], search: [] };
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    atob: value => Buffer.from(value, 'base64').toString('utf8'),
    storage: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
    utils: { randomUserAgent: () => 'Test', sleep: () => true },
    matching: {
      compareStrings: (a, b) => (a === b ? 1 : a.includes(b) || b.includes(a) ? 0.9 : 0),
      compareDuration: () => 1,
    },
    http: {
      get(url) {
        const match = url.match(/seed_to_playlist\/spotify:track:([^?]+)/);
        assert.ok(match, 'unexpected GET ' + url);
        calls.radio.push(match[1]);
        if (failRadio) return { error: 'network down' };
        if (!radios[match[1]]) return { statusCode: 404, headers: {}, body: '' };
        return json({ total: 1, mediaItems: [{ uri: 'spotify:playlist:radio' + match[1] }] });
      },
      post(url, body) {
        assert.match(url, /pathfinder\/v2\/query/);
        const payload = JSON.parse(body);
        if (payload.operationName === 'searchDesktop') {
          calls.search.push(payload.variables.searchTerm);
          return json({ data: { searchV2: { tracksV2: { items: search.map(data => ({ item: { data } })) } } } });
        }
        assert.equal(payload.operationName, 'fetchPlaylist');
        assert.equal(payload.variables.limit, 50);
        const seedID = payload.variables.uri.replace('spotify:playlist:radio', '');
        calls.playlist.push(seedID);
        return json(playlistItems(radios[seedID] || []));
      },
    },
  });
  vm.runInContext(source, context);
  registered.initialize({});
  // Copy results out of the sandbox realm so strict deep equality compares values.
  const plain = value => JSON.parse(JSON.stringify(value));
  return {
    registered: {
      getRelatedTracks: (seeds, options) => plain(registered.getRelatedTracks(seeds, options)),
      customSearch: (query, options) => plain(registered.customSearch(query, options)),
    },
    calls,
  };
}

const ownSeed = (id, name = 'Seed song') => ({ id, name, artists: 'Example artist', provider_id: 'spotify-web' });

test('own seeds use the id directly and results match the search track shape', () => {
  const { registered, calls } = runtime({
    radios: { seedA: [trackData('seedA', 'Seed song', 'Example artist'), trackData('r1', 'Example song', 'Example artist')] },
  });
  const results = registered.getRelatedTracks([ownSeed('seedA')], {});
  assert.deepEqual(calls.search, [], 'own seeds need no resolution');
  assert.deepEqual(calls.radio, ['seedA']);
  assert.deepEqual(results.map(track => track.id), ['r1']);

  const searched = runtime({ search: [trackData('r1', 'Example song', 'Example artist')] })
    .registered.customSearch('Example song', { filter: 'tracks' });
  assert.deepEqual(Object.keys(results[0]), Object.keys(searched[0]));
  assert.deepEqual(results[0], searched[0]);
  assert.equal(results[0].provider_id, 'spotify-web');
  assert.equal(results[0].preview_url, 'https://p.scdn.co/mp3-preview/r1');
});

test('foreign seeds resolve through a title and artist search with duration guard', () => {
  const { registered, calls } = runtime({
    search: [
      trackData('wrongLength', 'Example song', 'Example artist', 400000),
      trackData('other', 'Different song', 'Example artist', 210000),
      trackData('match', 'Example song', 'Example artist', 210000),
    ],
    radios: { match: [trackData('match', 'Example song', 'Example artist'), trackData('r1', 'Related song', 'Another artist')] },
  });
  const results = registered.getRelatedTracks([
    { id: '999', name: 'Example song', artists: 'Example artist, Guest artist', duration_ms: 212000, provider_id: 'other-source' },
  ], { limit: 10 });
  assert.deepEqual(calls.search, ['Example song Example artist']);
  assert.deepEqual(calls.radio, ['match']);
  assert.deepEqual(results.map(track => track.id), ['r1']);
});

test('unmatched foreign seeds are skipped and an empty radio returns an empty list', () => {
  const { registered, calls } = runtime({ search: [trackData('x', 'Unrelated', 'Someone else')] });
  assert.deepEqual(registered.getRelatedTracks([{ name: 'Example song', artists: 'Example artist' }]), []);
  assert.deepEqual(calls.radio, []);
  assert.deepEqual(runtime().registered.getRelatedTracks([ownSeed('none')]), []);
  assert.deepEqual(runtime().registered.getRelatedTracks([]), []);
});

test('results interleave across seeds, dedupe, exclude seeds, and honor the limit', () => {
  const { registered, calls } = runtime({
    radios: {
      seedA: [trackData('seedA', 'A', 'Example artist'), trackData('a1', 'A1', 'X'), trackData('shared', 'S', 'X'), trackData('a3', 'A3', 'X')],
      seedB: [trackData('b1', 'B1', 'Y'), trackData('seedA', 'A', 'Example artist'), trackData('shared', 'S', 'X'), trackData('b3', 'B3', 'Y')],
    },
  });
  const seeds = [ownSeed('seedA'), ownSeed('seedB')];
  assert.deepEqual(registered.getRelatedTracks(seeds, { limit: 50 }).map(track => track.id), ['b1', 'a1', 'shared', 'a3', 'b3']);
  assert.deepEqual(registered.getRelatedTracks(seeds, { limit: 3 }).map(track => track.id), ['b1', 'a1', 'shared']);
  assert.deepEqual(calls.radio, ['seedA', 'seedB'], 'radio playlist ids are cached per seed');
  assert.equal(registered.getRelatedTracks(seeds, { limit: 0 }).length, 5, 'zero falls back to the default limit');
  assert.equal(registered.getRelatedTracks(seeds, { limit: -4 }).length, 1, 'limit clamps to at least one');
});

test('only the first five seeds are fetched', () => {
  const radios = {};
  const seeds = [];
  for (let i = 0; i < 8; i++) {
    radios['s' + i] = [trackData('t' + i, 'T' + i, 'X')];
    seeds.push(ownSeed('s' + i));
  }
  const { registered, calls } = runtime({ radios });
  assert.equal(registered.getRelatedTracks(seeds).length, 5);
  assert.deepEqual(calls.radio, ['s0', 's1', 's2', 's3', 's4']);
});

test('throws only when every attempted seed request failed', () => {
  const { registered } = runtime({ failRadio: true });
  assert.throws(() => registered.getRelatedTracks([ownSeed('seedA')]), /Spotify related tracks failed/);
});
