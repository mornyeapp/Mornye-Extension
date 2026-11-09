const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(provider, respond) {
  let extension;
  const queries = [];
  const searchParams = [];
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
  function search(query, params) {
    queries.push(query);
    searchParams.push(params);
    return respond(query, params).map(track => {
      const common = { id: 'track001', name: 'Signal', artists: 'Lead Artist', duration_ms: 180000, ...track };
      if (provider === 'deezer') return { id: 7, title: common.name, artist: { name: common.artists }, duration: common.duration_ms / 1000 };
      if (provider === 'soundcloud') return { id: 70000, title: common.name, publisher_metadata: { artist: common.artists }, duration: common.duration_ms, access: 'playable', streamable: true };
      if (provider === 'qobuz-web') return { id: '7', title: common.name, performer: { name: common.artists }, duration: common.duration_ms / 1000 };
      if (provider === 'ytmusic-spotiflac') {
        return {
          id: common.id,
          title: common.name,
          artist: common.artists,
          duration: common.duration_ms / 1000,
          item_type: 'track',
          preview_url: 'https://example.test/audio.m4a',
        };
      }
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
    searchParams,
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

test('YouTube Music validates real parser-shaped romanized/native matches', () => {
  for (const track of [
    { title: 'fated', duration: 334 },
    { title: 'MOON', duration: 346 },
    { title: 'blossom', duration: 245 },
  ]) {
    const app = runtime('ytmusic-spotiflac', () => [{
      name: track.title,
      artists: '浜崎あゆみ',
      duration_ms: track.duration * 1000,
    }]);
    const result = app.extension.checkAvailability('', track.title, 'Ayumi Hamasaki', {
      duration_ms: track.duration * 1000,
    });
    assert.equal(result.available, true, track.title);
  }
});

test('YouTube Music retries a native title without a romanized artist and validates the native artist by duration', () => {
  const app = runtime('ytmusic-spotiflac', query => {
    if (query === '春よ、来い') {
      return [{
        name: '春よ、来い',
        artists: '浜崎あゆみ',
        duration_ms: 310000,
      }];
    }
    return [];
  });
  const result = app.extension.checkAvailability('', '春よ、来い', 'Ayumi Hamasaki', {
    duration_ms: 310000,
  });
  assert.equal(result.available, true);
  assert.ok(app.queries.includes('春よ、来い'));
});

test('YouTube Music cross-script artist fallback rejects the wrong-duration recording', () => {
  const app = runtime('ytmusic-spotiflac', () => [{
    name: '春よ、来い',
    artists: '松任谷由実',
    duration_ms: 279000,
  }]);
  const result = app.extension.checkAvailability('', '春よ、来い', 'Ayumi Hamasaki', {
    duration_ms: 310000,
  });
  assert.equal(result.available, false);
});

test('YouTube Music same-script wrong artist remains rejected at the same duration', () => {
  const app = runtime('ytmusic-spotiflac', () => [{
    name: 'Signal',
    artists: 'Different Singer',
    duration_ms: 180000,
  }]);
  assert.equal(app.check('Signal').available, false);
});

test('YouTube Music retries the video index for an exact remix with an artist prefix and matching duration', () => {
  const videoFilter = 'EgWKAQIQAQ%3D%3D';
  const app = runtime('ytmusic-spotiflac', (query, params) => {
    if (params === videoFilter && query.includes('snowy kiss')) {
      return [{
        name: '浜崎あゆみ/snowy kiss (Shohei Matsumoto remix)',
        artists: '大熊雄太',
        duration_ms: 423000,
      }];
    }
    return [];
  });
  const result = app.extension.checkAvailability('', 'snowy kiss - Shohei Matsumoto remix', 'Ayumi Hamasaki', {
    duration_ms: 418000,
  });
  assert.equal(result.available, true);
  assert.ok(app.searchParams.includes(videoFilter));
});

test('YouTube Music video fallback rejects karaoke and short versions', () => {
  const videoFilter = 'EgWKAQIQAQ%3D%3D';
  for (const candidate of [
    {
      name: '浜崎あゆみ (Ayumi Hamasaki) / Sweet Scar KARAOKE version instrumental',
      artists: 'JpopKARAOKE',
      duration_ms: 247000,
    },
    {
      name: 'snowy kiss - Shohei Matsumoto remix - short ver.',
      artists: 'Linza AyuAngel',
      duration_ms: 87000,
    },
  ]) {
    const app = runtime('ytmusic-spotiflac', (query, params) => params === videoFilter ? [candidate] : []);
    const title = candidate.name.includes('KARAOKE')
      ? 'Sweet scar - Instrumental'
      : 'snowy kiss - Shohei Matsumoto remix';
    const duration_ms = title.startsWith('Sweet') ? 250000 : 418000;
    assert.equal(app.extension.checkAvailability('', title, 'Ayumi Hamasaki', { duration_ms }).available, false);
  }
});

for (const provider of ['deezer', 'soundcloud', 'ytmusic-spotiflac', 'jiosaavn']) {
  test(`${provider}: cancellation stops before issuing the simplified search`, () => {
    const app = runtime(provider, () => []);
    app.c.utils.isDownloadCancelled = () => app.queries.length > 0;
    assert.equal(app.check().available, false);
    assert.equal(app.queries.length, 1);
  });
}
