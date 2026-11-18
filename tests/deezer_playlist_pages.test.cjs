const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/deezer/index.js'), 'utf8');

const song = (index, title) => ({
  id: 1000 + index, title: title || 'Example song ' + index, duration: 200, isrc: 'XX' + (1000 + index),
  link: 'https://www.deezer.com/track/' + (1000 + index), preview: '',
  artist: { id: 7, name: 'Example artist', link: 'https://www.deezer.com/artist/7' },
  album: { id: 9, title: 'Example album', cover_xl: 'https://example.invalid/cover.jpg' },
});

// A playlist the way Deezer serves it: the first `embedded` songs inside the
// playlist without a link to the rest, the tracks endpoint for any position.
function runtime({ total, declared = total, embedded = 400, title, secondsPerPage = 0 }) {
  const calls = [];
  const clock = { now: 1000000 };
  const songs = (from, count) => {
    const list = [];
    for (let i = from; i < Math.min(total, from + count); i++) list.push(song(i, title));
    return list;
  };
  let extension;
  const context = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { randomUserAgent: () => 'Test', appUserAgent: () => 'Test' },
    matching: {},
    Date: class extends Date { static now() { return clock.now; } },
    http: {
      get(url) {
        const target = new URL(url);
        calls.push(target.pathname + target.search);
        let body;
        if (target.pathname === '/playlist/55') {
          body = { id: 55, title: 'Example playlist', nb_tracks: declared, tracks: { data: songs(0, embedded) } };
        } else if (target.pathname === '/playlist/55/tracks') {
          clock.now += secondsPerPage * 1000;
          const index = Number(target.searchParams.get('index'));
          const limit = Number(target.searchParams.get('limit'));
          body = { data: songs(index, limit), total };
          if (index + limit < total) {
            body.next = 'https://api.deezer.com/playlist/55/tracks?limit=' + limit + '&index=' + (index + limit);
          }
        } else {
          body = { error: { code: 800 } };
        }
        return { statusCode: 200, body: JSON.stringify(body) };
      },
      post() { throw new Error('unexpected request'); },
    },
  });
  vm.runInContext(source, context);
  return { extension, calls };
}

// Arrays from the vm context have another realm's prototype.
const ids = playlist => Array.from(playlist.tracks, track => track.id);
const expected = count => Array.from({ length: count }, (_, index) => 'deezer:' + (1000 + index));

test('a playlist longer than 200 songs is not cut', () => {
  const { extension, calls } = runtime({ total: 243 });
  const playlist = extension.getPlaylist('55');
  assert.deepEqual(ids(playlist), expected(243));
  assert.equal(playlist.total_tracks, 243);
  assert.deepEqual(calls, ['/playlist/55']);
});

test('songs past the 400 Deezer embeds come from the tracks endpoint', () => {
  const { extension, calls } = runtime({ total: 1350 });
  const playlist = extension.getPlaylist('55');
  assert.deepEqual(ids(playlist), expected(1350));
  assert.deepEqual(Array.from(playlist.tracks, track => track.track_number).slice(398, 402), [399, 400, 401, 402]);
  assert.equal(playlist.tracks[1349].track_number, 1350);
  assert.deepEqual(calls, [
    '/playlist/55',
    '/playlist/55/tracks?limit=500&index=400',
    '/playlist/55/tracks?limit=500&index=900',
  ]);
});

test('a playlist of exactly 400 songs asks for nothing more', () => {
  const { extension, calls } = runtime({ total: 400 });
  assert.equal(extension.getPlaylist('55').tracks.length, 400);
  assert.deepEqual(calls, ['/playlist/55']);
});

test('a count that includes songs Deezer no longer serves ends after one empty page', () => {
  const { extension, calls } = runtime({ total: 400, declared: 420 });
  assert.deepEqual(ids(extension.getPlaylist('55')), expected(400));
  assert.deepEqual(calls, ['/playlist/55', '/playlist/55/tracks?limit=500&index=400']);
});

test('the longest playlists stop at the limits the app can hold', () => {
  const byCount = runtime({ total: 5600 });
  assert.deepEqual(ids(byCount.extension.getPlaylist('55')), expected(5000));
  assert.equal(byCount.calls[byCount.calls.length - 1], '/playlist/55/tracks?limit=500&index=4900');

  // 3000 songs of about 3400 characters each pass the size the app can hold.
  const bySize = runtime({ total: 3000, title: 'x'.repeat(3000) });
  const cut = bySize.extension.getPlaylist('55').tracks.length;
  assert.ok(cut > 1500 && cut < 2200, 'stopped at ' + cut);
  assert.ok(bySize.calls.length < 6);
});

test('a playlist Deezer serves too slowly keeps what arrived in time', () => {
  const { extension, calls } = runtime({ total: 5000, secondsPerPage: 6 });
  const playlist = extension.getPlaylist('55');
  // Pages at 6, 12, 18 and 24 seconds; the fourth is the last one asked for.
  assert.deepEqual(ids(playlist), expected(2400));
  assert.equal(calls.length, 5);
});
