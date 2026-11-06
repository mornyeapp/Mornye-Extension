const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { providers, names, meta, row, table, detail, artist, artistAlbums, runtime } = require('./helpers/k_music.cjs');

for (const provider of providers) {
  test(`${provider}: track detail follows the host contract and ignores recommendations`, () => {
    const { extension } = runtime(provider);
    const track = extension.getTrack('12345');
    assert.equal(track.id, '12345');
    assert.equal(track.name, names.track);
    assert.equal(track.artists, names.artist);
    assert.equal(track.album_id, '70000');
    assert.equal(track.album_name, names.album);
    assert.equal(track.duration_ms, 225000);
    assert.equal(track.provider_id, provider);
    assert.equal(typeof track.images, 'string');
    assert.equal(track.track, undefined);
    assert.equal(track.success, undefined);
    assert.ok(track.album_url);
    assert.ok(track.artist_url);
  });

  test(`${provider}: a different canonical track is rejected`, () => {
    const { extension } = runtime(provider, () => detail(provider, '99999'));
    assert.throws(() => extension.getTrack('12345'), /another track|different track/);
  });

  test(`${provider}: HTTP failure never becomes placeholder metadata or an empty search`, () => {
    const { extension } = runtime(provider, () => ({ ok: false, status: 503, body: '' }));
    assert.throws(() => extension.getTrack('12345'), /HTTP/);
    assert.throws(() => extension.searchTracks('Signal'), /HTTP/);
    assert.throws(() => extension.enrichTrack({ id: '12345' }), /HTTP/);
  });

  test(`${provider}: unrecognized HTML does not become a successful track`, () => {
    const { extension } = runtime(provider, () => '<html><h1>Maintenance</h1></html>');
    assert.throws(() => extension.getTrack('12345'), /metadata|unavailable/);
  });

  test(`${provider}: search preserves titles, artists, IDs, and the caller limit`, () => {
    const { extension, calls } = runtime(provider, () => `<html>${table(provider,
      row(provider) + row(provider, '12346', 'Second song'))}</html>`);
    const results = extension.customSearch('Signal & Sound', { limit: 1 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, '12345');
    assert.equal(results[0].name, names.track);
    assert.equal(results[0].artists, names.artist);
    assert.ok(calls[0].url.includes('Signal%20%26%20Sound'));
    if (provider === 'melon-music') assert.ok(calls[0].url.includes('/search/song/index.htm'));
  });

  test(`${provider}: album tracks exclude recommendations and retain album metadata`, () => {
    const { extension } = runtime(provider, () => detail(provider, '70000', 'album'));
    const album = extension.getAlbum('70000');
    assert.equal(album.id, '70000');
    assert.equal(album.name, names.album);
    assert.equal(album.artists, names.artist);
    assert.equal(album.total_tracks, 1);
    assert.equal(album.tracks[0].id, '12345');
    assert.equal(album.tracks[0].album_id, '70000');
    assert.equal(album.tracks[0].album_name, names.album);
    assert.equal(album.tracks[0].track_number, 1);
    assert.ok(album.cover_url.startsWith('https://'));
  });

  test(`${provider}: an album response for another ID is rejected`, () => {
    const { extension } = runtime(provider, () => detail(provider, '88888', 'album'));
    assert.throws(() => extension.getAlbum('70000'), /another album/);
  });

  test(`${provider}: enrichment uses the source and retains current caller fields and cross-links`, () => {
    const { extension, calls } = runtime(provider);
    const original = { id: '12345', provider_id: provider, name: 'Search result', comment: 'Old note',
      external_links: { example: 'https://example.invalid/one' } };
    const first = extension.enrichTrack(original);
    assert.equal(first.name, names.track);
    assert.equal(first.duration_ms, 225000);
    assert.equal(first.comment, 'Old note');
    assert.equal(original.name, 'Search result');
    const second = extension.enrichTrack({ ...original, comment: 'New note', isrc: 'USAAA2600001',
      external_links: { example: 'https://example.invalid/two' } });
    assert.equal(second.comment, 'New note');
    assert.equal(second.isrc, 'USAAA2600001');
    assert.equal(second.external_links.example, 'https://example.invalid/two');
    assert.equal(calls.length, 1);
    assert.equal(calls.some(({ url }) => url.includes('song.link')), false);
  });

  test(`${provider}: another provider's track is not looked up by a coinciding numeric ID`, () => {
    const { extension, calls } = runtime(provider);
    const track = { id: '12345', provider_id: 'example.metadata', name: 'Another song' };
    assert.equal(extension.enrichTrack(track), track);
    assert.equal(calls.length, 0);
  });

  test(`${provider}: detail cache expires and cleanup releases it`, () => {
    let title = 'First title';
    const r = runtime(provider, () => detail(provider).replaceAll('Signal &amp; Sound', title));
    assert.equal(r.extension.getTrack('12345').name, 'First title');
    title = 'Updated title';
    r.advance(5 * 60 * 1000 + 1);
    assert.equal(r.extension.getTrack('12345').name, 'Updated title');
    r.extension.cleanup();
    r.extension.getTrack('12345');
    assert.equal(r.calls.length, 3);
  });

  test(`${provider}: loading many different tracks does not retain an unbounded cache`, () => {
    const r = runtime(provider, (url) => {
      const id = new URL(url).pathname.match(/\/track\/(\d+)/)?.[1]
        || new URL(url).searchParams.get(provider === 'melon-music' ? 'songId' : 'xgnm');
      return detail(provider, id);
    });
    for (let id = 10000; id < 10070; id++) r.extension.getTrack(String(id));
    assert.ok(Object.keys(r.c.TRACK_CACHE).length <= 64);
  });

  test(`${provider}: malformed resource IDs are rejected before requesting the service`, () => {
    const { extension, calls } = runtime(provider);
    for (const id of ['', '../12345', '12345&other=1', '__proto__', '1bugs:track:2', '1melon-music:track:2']) {
      assert.throws(() => extension.getTrack(id));
    }
    assert.equal(calls.length, 0);
  });

  test(`${provider}: manifest grants only needed network access and supports imports`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../sources', provider, 'manifest.json')));
    assert.equal(manifest.permissions.file || false, false);
    assert.equal(manifest.permissions.storage || false, false);
    assert.equal(manifest.permissions.network.includes('api.song.link'), false);
    assert.equal(manifest.urlHandler.enabled, true);
    assert.ok(manifest.urlHandler.patterns.length > 0);
    assert.equal(manifest.skipBuiltInFallback, false);
    const { extension } = runtime(provider);
    assert.equal(typeof extension.handleUrl, 'function');
    const source = fs.readFileSync(path.join(__dirname, '../sources', provider, 'index.js'), 'utf8');
    assert.doesNotMatch(source, /api\.song\.link/);
  });

  test(`${provider}: entity decoding tolerates invalid numeric code points`, () => {
    const { c } = runtime(provider);
    assert.equal(c.cleanText('Signal &#38; Sound'), names.track);
    assert.doesNotThrow(() => c.cleanText('&#999999999999; &#xFFFFFF;'));
  });
}

for (const [provider, url] of [
  ['bugs-music', 'https://music.bugs.co.kr/track/12345'],
  ['bugs-music', 'https://m.bugs.co.kr/track/12345?source=share'],
  ['melon-music', 'https://www.melon.com/song/detail.htm?source=share&amp;songId=12345'],
  ['genie-music', 'https://www.genie.co.kr/detail/songInfo?source=share&xgnm=12345'],
]) {
  test(`${provider}: URL import returns the requested track (${url})`, () => {
    const { extension } = runtime(provider);
    const value = extension.handleUrl(url);
    assert.equal(value.type, 'track');
    assert.equal(value.id, '12345');
    assert.equal(value.track.name, names.track);
  });
}

for (const provider of providers) {
  test(`${provider}: album URL imports expose the track list consumed by the app`, () => {
    const { extension } = runtime(provider, () => detail(provider, '70000', 'album'));
    const urls = {
      'bugs-music': 'https://music.bugs.co.kr/album/70000',
      'melon-music': 'https://www.melon.com/album/detail.htm?albumId=70000',
      'genie-music': 'https://www.genie.co.kr/detail/albumInfo?axnm=70000',
    };
    const result = extension.handleUrl(urls[provider]);
    assert.equal(result.type, 'album');
    assert.equal(result.name, names.album);
    assert.ok(result.cover_url.startsWith('https://'));
    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].id, '12345');
    assert.equal(result.album.id, '70000');
  });

  test(`${provider}: URL imports reject lookalike hosts without network requests`, () => {
    const { extension, calls } = runtime(provider);
    const result = () => extension.handleUrl('https://example.invalid/detail/songInfo?xgnm=12345');
    if (provider === 'genie-music') assert.equal(result(), null);
    else assert.throws(result, /Unsupported/);
    assert.equal(calls.length, 0);
  });
}

test('Melon: TOP100 and HOT100 keep distinct contents, including direct opening and expiry', () => {
  const r = runtime('melon-music', (url) => `<html>${table('melon-music',
    url.includes('/chart/hot100/') ? row('melon-music', '22222', 'HOT song') : row('melon-music', '11111', 'TOP song'))}</html>`);
  assert.equal(r.extension.getAlbum('melon-hot100').tracks[0].id, '22222');
  assert.equal(r.extension.getAlbum('melon-top100').tracks[0].id, '11111');
  const feed = r.extension.getHomeFeed();
  assert.equal(feed.sections.find((s) => s.uri.endsWith(':hot100')).items[0].tracks[0].id, '22222');
  assert.equal(r.calls.filter(({ url }) => new URL(url).pathname === '/chart/index.htm').length, 1);
  assert.equal(r.calls.filter(({ url }) => url.includes('/chart/hot100/')).length, 1);
  r.advance(5 * 60 * 1000 + 1);
  r.extension.getAlbum('melon-hot100');
  assert.equal(r.calls.filter(({ url }) => url.includes('/chart/hot100/')).length, 2);
});

test('Melon: DJ playlist fallback reads its own title and tracks, then imports the URL', () => {
  const { extension } = runtime('melon-music', (url) => url.includes('/landing/')
    ? { ok: false, status: 404, body: '' }
    : `<html>${meta('og:title', 'Example playlist')}${table('melon-music')}</html>`);
  assert.equal(extension.getPlaylist('55555').name, 'Example playlist');
  const result = extension.handleUrl('https://www.melon.com/landing/playList.htm?plylstSeq=55555');
  assert.equal(result.type, 'playlist');
  assert.equal(result.tracks[0].id, '12345');
});

test('Melon: a successful fallback replaces the generic landing page title', () => {
  const { extension } = runtime('melon-music', (url) => url.includes('/landing/')
    ? `<html>${meta('og:title', 'Melon')}<p>Loading</p></html>`
    : `<html>${meta('og:title', 'Example playlist')}${table('melon-music')}</html>`);
  assert.equal(extension.getPlaylist('55555').name, 'Example playlist');
});

for (const provider of providers) {
  test(`${provider}: artist overview retains albums and popular tracks`, () => {
    const { extension } = runtime(provider, (url) => url.includes('artistAlbum')
      ? artistAlbums() : artist(provider));
    const value = extension.getArtist('90000');
    assert.equal(value.id, '90000');
    assert.equal(value.name, names.artist);
    assert.ok(value.albums.length > 0);
    assert.equal(value.albums[0].id, '70000');
    assert.equal(value.top_tracks[0].id, '12345');
  });
}

test('Genie: scrolling requests one album page and stops after the last page', () => {
  const r = runtime('genie-music', (url) => url.includes('bArtistAlbumList') ? artistAlbums(2)
    : url.includes('artistAlbum') ? artistAlbums() : artist('genie-music'));
  const first = r.extension.getArtist('90000');
  assert.equal(first.albums.length, 10);
  assert.equal(first.albums_next, '90000:albums:2');
  assert.equal(r.calls.length, 2);
  const second = r.extension.getArtist(first.albums_next);
  assert.equal(second.id, '90000');
  assert.equal(second.albums.length, 1);
  assert.equal(second.albums[0].id, '70010');
  assert.equal(second.albums_next, '');
  assert.equal(r.calls.length, 3);
  assert.ok(r.calls[2].url.includes('bArtistAlbumList?xxnm=90000&pg=2'));
});

test('Genie: a page cursor survives a fresh runtime and rejects malformed pages', () => {
  const r = runtime('genie-music', (url) => url.includes('bArtistAlbumList') ? artistAlbums(2) : artist('genie-music'));
  assert.equal(r.extension.getArtist('90000:albums:2').albums[0].id, '70010');
  const before = r.calls.length;
  for (const id of ['90000:albums:0', '90000:albums:900719925474100', '90000:albums:bad', '90000&pg=2']) {
    assert.throws(() => r.extension.getArtist(id), /Invalid/);
  }
  assert.equal(r.calls.length, before);
});

test('Genie: a catalog beyond one thousand albums can follow the next cursor', () => {
  const r = runtime('genie-music', (url) => {
    const page = Number(new URL(url).searchParams.get('pg'));
    return url.includes('bArtistAlbumList') ? artistAlbums(page, 1001) : artist('genie-music');
  });
  const hundredth = r.extension.getArtist('90000:albums:100');
  assert.equal(hundredth.albums_next, '90000:albums:101');
  const last = r.extension.getArtist(hundredth.albums_next);
  assert.equal(last.albums.length, 1);
  assert.equal(last.albums_next, '');
  assert.ok(r.calls.at(-1).url.includes('&pg=101&'));
});

test('Genie: a page failure propagates so the app can retry the same cursor', () => {
  const r = runtime('genie-music', (url) => url.includes('bArtistAlbumList')
    ? { ok: false, status: 503, body: '' } : artist('genie-music'));
  assert.throws(() => r.extension.getArtist('90000:albums:2'), /HTTP/);
});

test('Genie: an unrecognized successful page stays retryable instead of ending pagination', () => {
  const r = runtime('genie-music', (url) => url.includes('bArtistAlbumList')
    ? '<html><div>Temporary error</div></html>' : artist('genie-music'));
  assert.throws(() => r.extension.getArtist('90000:albums:2'), /album list is unavailable/);
});

test('Genie: an explicitly empty artist catalog is valid', () => {
  const r = runtime('genie-music', (url) => url.includes('artistAlbum')
    ? artistAlbums(1, 0) : artist('genie-music'));
  const value = r.extension.getArtist('90000');
  assert.equal(value.albums.length, 0);
  assert.equal(value.albums_next, '');
});

test('Genie: formatted catalog totals do not stop pagination after the first page', () => {
  const r = runtime('genie-music', (url) => url.includes('artistAlbum')
    ? artistAlbums(1, 1200).replace('<strong>1200</strong>', '<strong> 1,200 </strong>') : artist('genie-music'));
  assert.equal(r.extension.getArtist('90000').albums_next, '90000:albums:2');
});

for (const provider of ['bugs-music', 'genie-music']) {
  test(`${provider}: home feed is cached briefly and cleanup releases it`, () => {
    const r = runtime(provider, () => `<html>${table(provider)}</html>`);
    const first = r.extension.getHomeFeed();
    const requests = r.calls.length;
    assert.ok(first.sections.length > 0);
    assert.equal(r.extension.getHomeFeed(), first);
    assert.equal(r.calls.length, requests);
    r.extension.cleanup();
    r.extension.getHomeFeed();
    assert.ok(r.calls.length > requests);
  });
}
