const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/jiosaavn');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
// Public catalog ciphertext: exercises the actual DES decoder offline.
const encrypted = 'ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDyzcLY6yrRsApkihRw82TxHKRkinU1Hk+UfTwvCNnk7H8tkwz1y6nPSRw7tS9a8Gtq';
const song = (extra = {}, more = {}) => ({
  id: 'track001', title: 'Signal &amp; Sound', subtitle: 'Wrong fallback - Album',
  type: 'song', perma_url: 'https://www.jiosaavn.com/song/signal/url-token',
  image: 'http://c.saavncdn.com/cover-150x150.jpg?cache=1', year: '2024',
  more_info: {
    album: 'Album', album_id: '123', album_url: 'https://www.jiosaavn.com/album/album/album-token',
    release_date: '2024-06-15', duration: '210', encrypted_media_url: encrypted,
    label: 'Label', copyright_text: 'Copyright', track_number: '7', total_tracks: '12',
    artistMap: {
      primary_artists: [
        { id: '456', name: 'Artist One', perma_url: 'https://www.jiosaavn.com/artist/one/artist-token' },
        { id: '457', name: 'Artist Two' },
      ],
      featured_artists: [{ id: '458', name: 'Guest' }],
      artists: [{ name: 'Composer', role: 'music' }, { name: 'Writer', role: 'lyricist' }],
    },
    ...more,
  },
  ...extra,
});
function runtime(respond = () => ({ songs: [song()] })) {
  const calls = { requests: [], downloads: [] };
  const store = new Map();
  let extension;
  const c = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: {
      get(key) { return store.get(key); }, set(key, value) { store.set(key, value); },
      remove(key) { store.delete(key); },
    },
    http: { get(url) {
      const params = new URL(url).searchParams;
      calls.requests.push(params);
      return { ok: true, status: 200, body: JSON.stringify(respond(params.get('__call'), params)) };
    } },
    file: { download(url, output, options) {
      calls.downloads.push({ url, output });
      options.onProgress?.(20, 100);
      return { success: true, path: output };
    } },
  });
  vm.runInContext(source, c);
  return { c, extension, calls, store };
}

test('manifest declares lossy quality kinds, home feed, and its bundled icon', () => {
  assert.equal(manifest.version, '1.0.9');
  assert.equal(manifest.capabilities.homeFeed, true);
  assert.equal(manifest.skipMetadataEnrichment, undefined);
  assert.ok(manifest.requiredRuntimeFeatures.includes('preparedContext@1'));
  assert.ok(manifest.qualityOptions.every(q => q.kind === 'lossy'));
  assert.equal(fs.readFileSync(path.join(root, manifest.icon)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('track metadata keeps canonical IDs, full dates, contributors, and navigation links', () => {
  const { c } = runtime();
  const result = c.formatSong(song());
  assert.equal(result.id, 'track001');
  assert.equal(result.isrc, '');
  assert.equal(result.release_date, '2024-06-15');
  assert.equal(result.artists, 'Artist One, Artist Two, Guest');
  assert.equal(result.album_artist, 'Artist One, Artist Two');
  assert.equal(result.artist_id, '456');
  assert.equal(result.album_id, '123');
  assert.equal(result.external_urls, song().perma_url);
  assert.equal(result.artist_url, song().more_info.artistMap.primary_artists[0].perma_url);
  assert.equal(result.composer, 'Composer');
  assert.equal(result.track_number, 7);
  assert.equal(result.total_tracks, 12);
  assert.equal(result.genre, '', 'language is not a genre');
  assert.equal(result.cover_url, 'https://c.saavncdn.com/cover-500x500.jpg?cache=1');
});

test('ISRC is normalized only for a real recording code', () => {
  const { c } = runtime();
  assert.equal(c.formatSong(song({}, { isrc: 'us-aaa-24-00001' })).isrc, 'USAAA2400001');
  assert.equal(c.formatSong(song({}, { isrc: 'url-token' })).isrc, '');
});

test('DES decodes a real catalog URL and missing audio preserves metadata', () => {
  const { c } = runtime();
  assert.match(c.decryptMediaUrl(encrypted), /^https:\/\/aac\.saavncdn\.com\/.+_96\.mp4$/);
  assert.equal(c.decryptMediaUrl(undefined), '');
  assert.equal(c.decryptMediaUrl('bad'), '');
  assert.equal(c.formatSong(song({}, { encrypted_media_url: undefined })).name, 'Signal & Sound');
});

for (const id of ['track001', 'url-token', 'https://www.jiosaavn.com/song/signal/url-token/?q=1']) {
  test(`getTrack accepts catalog IDs and legacy tokens: ${id}`, () => {
    const { extension, calls } = runtime();
    assert.equal(extension.getTrack(id).id, 'track001');
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.requests[0].get('__call'), id === 'track001' ? 'song.getDetails' : 'webapi.get');
  });
}

test('catalog lookup rejects another recording instead of taking the first song', () => {
  const { extension } = runtime(() => ({ songs: [song({ id: 'other001', perma_url: 'https://www.jiosaavn.com/song/other/other-token' })] }));
  assert.equal(extension.getTrack('track001'), null);
});

test('numeric and prefixed album IDs retain album numbering and full metadata', () => {
  for (const id of ['123', 'albumid_123']) {
    const { extension, calls } = runtime(() => ({
      id: '123', title: 'Album', type: 'album', list_count: '2',
      more_info: { release_date: '2024-06-15' },
      list: [song({}, { track_number: undefined, total_tracks: undefined }), song({ id: 'track002' }, { track_number: undefined, total_tracks: undefined })],
    }));
    const album = extension.getAlbum(id);
    assert.equal(calls.requests[0].get('__call'), 'content.getAlbumDetails');
    assert.equal(calls.requests[0].get('albumid'), '123');
    assert.equal(album.release_date, '2024-06-15');
    assert.deepEqual(Array.from(album.tracks, t => t.track_number), [1, 2]);
    assert.deepEqual(Array.from(album.tracks, t => t.total_tracks), [2, 2]);
  }
});

test('numeric and prefixed artist IDs preserve the artist lookup contract', () => {
  for (const id of ['456', 'artistid_456']) {
    const { extension, calls } = runtime(() => ({ artistId: '456', name: 'Artist', fan_count: '1,200' }));
    assert.equal(extension.getArtist(id).id, '456');
    assert.equal(calls.requests[0].get('__call'), 'artist.getArtistPageDetails');
    assert.equal(calls.requests[0].get('artistId'), '456');
  }
});

test('home songs use track type and read album metadata without a ReferenceError', () => {
  const { c, extension } = runtime(() => ({ modules: { trending: { title: 'Trending' } }, trending: [song({ album: 'Album' })] }));
  const result = extension.getHomeFeed();
  assert.equal(result.sections[0].items[0].type, 'track');
  assert.equal(result.sections[0].items[0].album_id, '123');
  assert.equal(result.sections[0].items[0].duration_ms, 210000);
  assert.equal(c.formatHomeFeedItem({ type: 'radio', id: 'unsupported' }), null);
});

test('filtered and autocomplete searches keep catalog IDs and legacy filter aliases', () => {
  const { extension } = runtime((call) => call === 'autocomplete.get'
    ? { songs: { data: [song()] }, artists: { data: [{ id: '456', title: 'Artist', type: 'artist' }] } }
    : { results: [song()] });
  assert.equal(extension.customSearch('Signal', 'songs')[0].id, 'track001');
  assert.deepEqual(Array.from(extension.customSearch('Signal', { filter: 'all' }), x => x.id), ['track001', '456']);
});

test('playlists fetch all pages and do not overwrite album track numbers', () => {
  const { extension, calls } = runtime((call, p) => ({
    id: '123', title: 'Playlist', list_count: '102',
    list: Array.from({ length: p.get('p') === '1' ? 100 : 2 }, (_, index) =>
      song({ id: 'id' + ((Number(p.get('p')) - 1) * 100 + index) })),
  }));
  const result = extension.getPlaylist('123');
  assert.equal(result.tracks.length, 102);
  assert.equal(result.total_tracks, 102);
  assert.equal(result.tracks[100].track_number, 7);
  assert.equal(result.tracks[100].total_tracks, 12);
  assert.deepEqual(calls.requests.map(p => p.get('p')), ['1', '2']);
});

test('community playlist URLs match the manifest and resolve the playlist token', () => {
  const url = 'https://www.jiosaavn.com/s/playlist/example-user/shared-mix/playlist-token';
  assert.ok(manifest.urlHandler.patterns.some(pattern => url.includes(pattern)));
  const { extension, calls } = runtime(() => ({
    id: '123', title: 'Shared Mix', list_count: '1', list: [song()],
  }));
  const result = extension.handleUrl(url);
  assert.equal(result.success, true);
  assert.equal(result.type, 'playlist');
  assert.equal(result.tracks.length, 1);
  assert.equal(calls.requests[0].get('__call'), 'webapi.get');
  assert.equal(calls.requests[0].get('token'), 'playlist-token');
});

for (const id of ['123', 'playlist-token']) {
  for (const total of [0, 99, 100, 101, 200, 300, 301]) {
    test(`playlist pagination stops at ${total} entries for ${id}`, () => {
      const { extension, calls } = runtime((call, p) => {
        const offset = (Number(p.get('p')) - 1) * 100;
        const count = Math.max(0, Math.min(100, total - offset));
        return {
          id: '123', title: 'Playlist', list_count: id === '123' ? total : String(total),
          list: offset >= total && offset > 0 ? '' : Array.from({ length: count }, (_, i) =>
            song({ id: 'id' + (offset + i) })),
        };
      });
      const result = extension.getPlaylist(id);
      assert.equal(result.tracks.length, total);
      assert.equal(result.total_tracks, total);
      assert.deepEqual(calls.requests.map(p => p.get('p')),
        Array.from({ length: Math.max(1, Math.ceil(total / 100)) }, (_, i) => String(i + 1)));
      assert.ok(calls.requests.every(p => p.get('__call') ===
        (id === '123' ? 'playlist.getDetails' : 'webapi.get')));
    });
  }
}

test('playlist pagination falls back to page sizes when the total is unavailable or invalid', () => {
  for (const total of [undefined, null, '', 'invalid', -1, 100.5]) {
    const { extension, calls } = runtime((call, p) => ({
      id: '123', title: 'Playlist', list_count: total,
      list: Array.from({ length: p.get('p') === '1' ? 100 : 2 }, (_, i) =>
        song({ id: 'id' + ((Number(p.get('p')) - 1) * 100 + i) })),
    }));
    assert.equal(extension.getPlaylist('123').tracks.length, 102);
    assert.deepEqual(calls.requests.map(p => p.get('p')), ['1', '2']);
  }
});

test('duplicate playlist entries count toward pagination before deduplication', () => {
  const { extension, calls } = runtime((call, p) => {
    const page = Number(p.get('p'));
    return {
      id: '123', title: 'Playlist', list_count: '200',
      list: page > 2 ? '' : Array.from({ length: 100 }, (_, i) =>
        song({ id: 'id' + (i === 0 ? 0 : (page - 1) * 100 + i) })),
    };
  });
  assert.equal(extension.getPlaylist('123').tracks.length, 199);
  assert.deepEqual(calls.requests.map(p => p.get('p')), ['1', '2']);
});

test('incomplete playlist pages fail when the advertised total has not been reached', () => {
  for (const list of ['', [], [song({ id: 'last001' })]]) {
    const { extension } = runtime((call, p) => ({
      id: '123', title: 'Playlist', list_count: '300',
      list: p.get('p') === '1'
        ? Array.from({ length: 100 }, (_, i) => song({ id: 'id' + i })) : list,
    }));
    assert.throws(() => extension.getPlaylist('123'), /playlist/);
  }
});

test('failed or repeated playlist pages report failure rather than silent truncation', () => {
  for (const invalid of [null, 'repeat']) {
    const rows = Array.from({ length: 100 }, (_, i) => song({ id: 'id' + i }));
    const { extension } = runtime((call, p) => p.get('p') === '1' || invalid === 'repeat'
      ? { id: '123', list: rows } : null);
    assert.throws(() => extension.getPlaylist('123'), /playlist page|repeated/);
  }
});

for (const quality of ['AAC_320', 'AAC_160', 'AAC_96', 'AAC_48', 'AAC_12']) {
  test(`${quality} downloads with an empty cache and publishes AAC as M4A`, () => {
    const { extension, calls } = runtime();
    const progress = [];
    const result = extension.download('track001', quality, '/music/folder.name/song.flac', p => progress.push(p));
    assert.equal(result.success, true);
    assert.equal(result.file_path, '/music/folder.name/song.m4a');
    assert.equal(result.actual_extension, 'm4a');
    assert.equal(result.audio_codec, 'aac');
    assert.equal(result.release_date, '2024-06-15');
    assert.equal(result.isrc, '');
    assert.equal(result.artist, 'Artist One, Artist Two, Guest');
    assert.ok(calls.downloads[0].url.endsWith('_' + quality.split('_')[1] + '.mp4'));
    assert.equal(progress.at(-1), 1);
    assert.equal(calls.requests.length, 1);
  });
}

test('warm cache, clearing it, and prepared downloads remain functional', () => {
  const { extension, calls } = runtime();
  const track = extension.enrichTrack({ id: 'track001' });
  extension.download('track001', 'AAC_320', '/music/song.flac');
  assert.equal(calls.requests.length, 1);
  extension.forceCleanup();
  extension.download('track001', 'AAC_320', '/music/song.flac');
  assert.equal(calls.requests.length, 2);
  extension.forceCleanup();
  extension.download('track001', 'AAC_320', '/music/song.flac', null, { preparedContext: { track } });
  assert.equal(calls.requests.length, 2, 'prepared metadata survives cache cleanup');
});

test('availability uses real recording matching and never treats a token as ISRC', () => {
  const { extension } = runtime(() => ({ results: [song()] }));
  assert.equal(extension.checkAvailability('url-token', 'Signal & Sound', 'Artist One', { duration_ms: 210000 }).track_id, 'track001');
  for (const [name, artist, duration] of [
    ['Signal & Sound (Live)', 'Artist One', 210000],
    ['Signal & Sound', 'Another Artist', 210000],
    ['Signal & Sound', 'Artist One', 30000],
    ['Signal & Sound', 'Artist One', 0],
  ]) {
    assert.equal(extension.checkAvailability('', name, artist, { duration_ms: duration }).available, false);
  }
});

test('conflicting real ISRCs reject a same-title candidate', () => {
  const { extension } = runtime(() => ({ results: [song({}, { isrc: 'USAAA2400001' })] }));
  assert.equal(extension.checkAvailability('USAAA2400002', 'Signal & Sound', 'Artist One', { duration_ms: 210000 }).available, false);
});

test('download failures preserve the host error and invalid qualities never transfer audio', () => {
  const { c, extension, calls } = runtime();
  c.file.download = () => ({ success: false, error: 'Transfer cancelled', error_type: 'cancelled' });
  const cancelled = extension.download('track001', 'AAC_96', '/music/song.flac');
  assert.equal(cancelled.error_message, 'Transfer cancelled');
  assert.equal(cancelled.error_type, 'cancelled');
  const invalid = extension.download('track001', 'FLAC', '/music/song.flac');
  assert.equal(invalid.error_type, 'quality_unavailable');
  assert.equal(calls.downloads.length, 0);
});
