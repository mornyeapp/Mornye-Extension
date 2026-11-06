const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { providers, meta, row, table, runtime } = require('./helpers/k_music.cjs');

test('Bugs: realtime, daily and weekly charts keep their own identities', () => {
  const r = runtime('bugs-music', (url) => table('bugs-music', row('bugs-music',
    url.includes('/week/') ? '33333' : url.includes('/day/') ? '22222' : '11111')));
  for (const [id, song] of [['top100-realtime', '11111'], ['top100-day', '22222'], ['top100-week', '33333']]) {
    assert.equal(r.extension.getAlbum(id).tracks[0].id, song);
    r.extension.getAlbum(id);
  }
  assert.equal(r.calls.length, 3);
  r.extension.cleanup();
  r.extension.getAlbum('top100-week');
  assert.equal(r.calls.length, 4);
});

test('Bugs: Music PD imports its primary list and keeps recommendations out', () => {
  const page = meta('og:url', 'https://music.bugs.co.kr/musicpd/albumview/55555')
    + meta('og:title', 'Theme &amp; Sound / Curator')
    + table('bugs-music') + `<table>${row('bugs-music', '99999')}</table>`;
  const r = runtime('bugs-music', (url) => url.endsWith('/musicpd')
    ? '<figure class="musicPDAlbumInfo"><a href="/musicpd/albumview/55555">'
      + '<img src="https://image.bugsm.co.kr/cover.jpg" alt="Theme 대표이미지"></a></figure>'
    : page);
  assert.equal(r.c.musicPdAlbums()[0].id, 'pd-55555');
  const result = r.extension.handleUrl('https://music.bugs.co.kr/musicpd/albumview/55555');
  assert.equal(result.type, 'album');
  assert.equal(result.id, 'pd-55555');
  assert.equal(result.name, 'Theme & Sound');
  assert.deepEqual(Array.from(result.tracks, (track) => track.id), ['12345']);
  r.extension.getAlbum('pd-55555');
  assert.equal(r.calls.length, 2);
});

test('Bugs: Music PD rejects a different canonical playlist', () => {
  const r = runtime('bugs-music', () => meta('og:url',
    'https://music.bugs.co.kr/musicpd/albumview/99999') + table('bugs-music'));
  assert.throws(() => r.extension.getAlbum('pd-55555'), /another Music PD/);
});

test('Melon: period charts and genre albums open without first loading Home', () => {
  const ids = {
    '/chart/index.htm': '11111', '/chart/day/index.htm': '22222',
    '/chart/week/index.htm': '33333', '/chart/month/index.htm': '44444',
    '/chart/rise/index.htm': '55555', '/genre/song_list.htm': '66666',
  };
  const r = runtime('melon-music', (url) => table('melon-music',
    row('melon-music', ids[new URL(url).pathname])));
  for (const [album, song] of [
    ['melon-top100', '11111'], ['melon-top100-day', '22222'],
    ['melon-top100-week', '33333'], ['melon-top100-month', '44444'],
    ['melon-top100-rise', '55555'], ['melon-genre-GN0200', '66666'],
  ]) assert.equal(r.extension.getAlbum(album).tracks[0].id, song);
  assert.equal(r.calls.length, 6);
});

test('Melon: an unavailable chart is retried on the next explicit request', () => {
  let available = false;
  const r = runtime('melon-music', () => available ? table('melon-music')
    : { ok: false, status: 429, body: '' });
  assert.throws(() => r.extension.getAlbum('melon-top100-week'), /HTTP 429/);
  assert.equal(r.calls.length, 1, 'Do not immediately retry rate limits');
  available = true;
  assert.equal(r.extension.getAlbum('melon-top100-week').tracks.length, 1);
});

test('Melon: missing realtime rankings do not hide working daily rankings', () => {
  const r = runtime('melon-music', (url) => new URL(url).pathname === '/chart/day/index.htm'
    ? table('melon-music') : { ok: false, status: 503, body: '' });
  const feed = r.extension.getHomeFeed();
  const top = feed.sections.find((section) => section.uri.endsWith(':top100'));
  assert.deepEqual(Array.from(top.items, (item) => item.id), ['melon-top100-day']);
});

function genieChartPage(url) {
  const parsed = new URL(url);
  const page = Number(parsed.searchParams.get('pg'));
  const offset = parsed.searchParams.get('ditc') === 'W' ? 1000 : 0;
  return table('genie-music', Array.from({ length: 50 }, (_, index) =>
    row('genie-music', String(10000 + offset + (page - 1) * 50 + index))).join(''));
}

test('Genie: weekly charts load all four pages and cache the complete list', () => {
  const r = runtime('genie-music', genieChartPage);
  const album = r.extension.getAlbum('genie-top200-week');
  assert.equal(album.tracks.length, 200);
  assert.equal(album.tracks[0].id, '11000');
  assert.equal(album.tracks[199].id, '11199');
  assert.equal(r.calls.length, 4);
  r.extension.getAlbum('genie-top200-week');
  assert.equal(r.calls.length, 4);
});

test('Genie: failed later pages do not become a cached partial chart', () => {
  let fail = true;
  const r = runtime('genie-music', (url) => fail && url.endsWith('pg=2')
    ? { ok: false, status: 503, body: '' } : genieChartPage(url));
  assert.throws(() => r.extension.getAlbum('genie-top200-week'), /page is unavailable/);
  fail = false;
  assert.equal(r.extension.getAlbum('genie-top200-week').tracks.length, 200);
});

test('Genie: genre albums use an allowlisted genre code and cache their songs', () => {
  const r = runtime('genie-music', () => table('genie-music'));
  const album = r.extension.getAlbum('genie-genre-M0100');
  assert.equal(album.id, 'genie-genre-M0100');
  assert.equal(album.tracks.length, 1);
  assert.equal(new URL(r.calls[0].url).searchParams.get('genrecode'), 'M0100');
  r.extension.getAlbum('genie-genre-M0100');
  assert.equal(r.calls.length, 1);
  assert.throws(() => r.extension.getAlbum('genie-genre-M0100&other=1'), /Invalid/);
  assert.equal(r.calls.length, 1);
});

test('Genie: DJ URL imports and virtual albums retain the host return shape', () => {
  const page = meta('og:title', 'Theme &amp; Sound - genie')
    + table('genie-music') + `<table>${row('genie-music', '99999')}</table>`;
  const r = runtime('genie-music', () => page);
  const result = r.extension.handleUrl('https://www.genie.co.kr/playlist/detailView?plmSeq=55555');
  assert.equal(result.type, 'playlist');
  assert.equal(result.id, '55555');
  assert.equal(result.playlist.id, '55555');
  assert.equal(result.name, 'Theme & Sound');
  assert.deepEqual(Array.from(result.tracks, (track) => track.id), ['12345']);
  const album = r.extension.getAlbum('genie-dj-55555');
  assert.equal(album.type, 'album');
  assert.equal(album.id, 'genie-dj-55555');
  assert.equal(album.tracks.length, 1);
  assert.equal(r.calls.length, 1);
});

test('Genie: Home exposes DJ cards without fetching each playlist', () => {
  const r = runtime('genie-music', (url) => new URL(url).pathname === '/'
    ? '<html><a href="/playlist/detailView?plmSeq=55555">DJ</a>'
      + '<a href="/playlist/detailView?plmSeq=55555">Duplicate</a></html>'
    : table('genie-music'));
  const feed = r.extension.getHomeFeed();
  assert.equal(feed.sections.find((section) => section.uri.endsWith(':dj-playlists')).items.length, 1);
  assert.equal(r.calls.some(({ url }) => url.includes('/playlist/detailView')), false);
  assert.equal(r.calls.filter(({ url }) => url.includes('/chart/top200')).length, 1);
});

for (const provider of providers) {
  test(`${provider}: virtual IDs cannot inject URLs or extra query parameters`, () => {
    const r = runtime(provider);
    for (const id of ['__proto__', 'pd-12345&other=1', 'genie-dj-12345&other=1', 'https://example.invalid/file']) {
      assert.throws(() => r.extension.getAlbum(id), /Invalid|invalid|must be numeric/);
    }
    assert.equal(r.calls.length, 0);
  });

  test(`${provider}: release grants no cross-service, file, or persistent storage access`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../sources', provider, 'manifest.json')));
    assert.equal(manifest.permissions.file, false);
    assert.equal(manifest.permissions.storage, false);
    assert.ok(manifest.permissions.network.every((host) => /(?:bugs\.co\.kr|bugsm\.co\.kr|melon\.com|genie\.co\.kr)$/.test(host)));
    const source = fs.readFileSync(path.join(__dirname, '../sources', provider, 'index.js'), 'utf8');
    assert.doesNotMatch(source, /\b(?:eval|Function|require|fetch|WebSocket)\s*\(|\b(?:storage|file|process|Deno|Bun)\s*\./);
    assert.doesNotMatch(source, /api\.song\.link|api\.deezer\.com|itunes\.apple\.com/);
  });
}
