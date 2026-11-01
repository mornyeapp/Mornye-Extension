const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(provider, respond) {
  let extension;
  const queries = [];
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const c = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {} },
    utils: { isDownloadCancelled: () => false },
    matching: {
      normalizeString: normalize,
      compareStrings: (a, b) => normalize(a) === normalize(b) ? 1 : 0,
      compareDuration: (a, b) => Math.abs(a - b) <= 15000 ? 1 : 0,
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources', provider, 'index.js'), 'utf8'), c);
  function search(query) {
    queries.push(query);
    return respond(query).map(track => {
      const common = { id: 'track001', name: 'Signal', artists: 'Lead Artist', duration_ms: 180000, ...track };
      if (provider === 'deezer') return { id: 7, title: common.name, artist: { name: common.artists }, duration: common.duration_ms / 1000 };
      if (provider === 'soundcloud') return { id: 70000, title: common.name, publisher_metadata: { artist: common.artists }, duration: common.duration_ms, access: 'playable', streamable: true };
      if (provider === 'qobuz-web') return { id: '7', title: common.name, performer: { name: common.artists }, duration: common.duration_ms / 1000 };
      return { ...common, item_type: 'track', preview_url: 'https://example.test/audio.m4a' };
    });
  }
  if (provider === 'deezer') {
    c.deezerGet = url => ({ data: search(new URL(url, 'https://example.test').searchParams.get('q')) });
  } else if (provider === 'soundcloud') {
    c.scGet = url => ({ collection: search(new URL(url, 'https://example.test/').searchParams.get('q')) });
  } else if (provider === 'jiosaavn') {
    c.searchSongsService = search;
  } else if (provider === 'qobuz-web') {
    c.searchTracksViaAPI = search;
    c.searchTracksViaAlbumSearch = () => [];
    c.searchTracksViaStore = () => [];
  } else {
    c.performSearchSync = search;
  }
  return {
    c,
    extension,
    queries,
    check: (title = 'Signal (with Guest Artist)', options = {}) => extension.checkAvailability('', title, 'Lead Artist', { duration_ms: 180000, ...options }),
  };
}

for (const provider of ['soundcloud', 'ytmusic-spotiflac']) {
  test(`${provider}: a foreign numeric catalog ID is not a direct track ID`, () => {
    for (const track of [{ provider_id: 'apple-music' }, {}]) {
      const app = runtime(provider, () => [{}]);
      const result = app.check('Signal', { spotify_id: '12345678901', track });
      assert.equal(result.available, true);
      assert.notEqual(result.track_id, '12345678901');
      assert.equal(result.skip_fallback, undefined);
      assert.equal(app.queries.length, 1);
    }
  });

  test(`${provider}: owned IDs and metadata-free legacy IDs still resolve directly`, () => {
    for (const own of [false, true]) {
      const app = runtime(provider, () => assert.fail('direct ID should not search'));
      app.c.fetchTrackData = id => ({ id, access: 'playable', streamable: true });
      const result = app.extension.checkAvailability('', own ? 'Signal' : '', own ? 'Lead Artist' : '', {
        spotify_id: '12345678901', track: own ? { provider_id: provider } : {},
      });
      assert.equal(result.available, true);
      assert.equal(result.track_id, '12345678901');
      assert.equal(app.queries.length, 0);
    }
  });
}

for (const provider of ['deezer', 'soundcloud', 'ytmusic-spotiflac', 'jiosaavn', 'qobuz-web']) {
  test(`${provider}: empty Apple credit search retries the base title with its artist`, () => {
    const app = runtime(provider, query => /^(?:Signal Lead Artist|Lead Artist Signal)$/.test(query) ? [{}] : []);
    assert.equal(app.check().available, true);
    assert.ok(app.queries.some(query => /^(?:Signal Lead Artist|Lead Artist Signal)$/.test(query)));
  });

  test(`${provider}: credit differences in search results do not require extra requests`, () => {
    const app = runtime(provider, () => [{ name: 'Signal (with Guest Artist)' }]);
    assert.equal(app.check('Signal').available, true);
    assert.equal(app.queries.length, 1);
  });

  test(`${provider}: credit simplification rejects another version, artist or preview`, () => {
    for (const candidate of [
      { name: 'Signal (Live)' },
      { name: 'Signal (with Live Band)' },
      { artists: 'Unrelated Singer' },
      { duration_ms: 30000 },
    ]) {
      const app = runtime(provider, () => [candidate]);
      assert.equal(app.check().available, false, JSON.stringify(candidate));
    }
  });
}

test('YouTube Music recording validation preserves non-Latin titles and artist names', () => {
  const app = runtime('ytmusic-spotiflac', () => [{ name: '悲しみがとまらない', artists: '杏里' }]);
  const result = app.extension.checkAvailability('', '悲しみがとまらない', '杏里', { duration_ms: 180000 });
  assert.equal(result.available, true);
  assert.equal(app.queries.length, 1);
});

for (const provider of ['deezer', 'soundcloud', 'ytmusic-spotiflac', 'jiosaavn']) {
  test(`${provider}: cancellation stops before issuing the simplified search`, () => {
    const app = runtime(provider, () => []);
    app.c.utils.isDownloadCancelled = () => app.queries.length > 0;
    assert.equal(app.check().available, false);
    assert.equal(app.queries.length, 1);
  });
}
