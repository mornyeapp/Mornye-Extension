const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime(total, { pageLimit = 1000, unavailable = false, unknownTotal = false, page } = {}) {
  const offsets = [];
  let cancelled = false;
  const c = vm.createContext({
    registerExtension() {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    utils: { isRequestCancelled: () => cancelled },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources/spotify-web/index.js'), 'utf8'), c);
  c.fetchPlaylistPage = (id, offset, limit) => {
    offsets.push(offset);
    if (page) {
      const result = page(offset);
      if (result) return result;
    }
    const size = Math.max(0, Math.min(limit, pageLimit, total - offset));
    const items = Array.from({ length: size }, (_, index) => {
      const position = offset + index;
      return { itemV2: { data: unavailable && position % 97 === 0 ? null : {
        uri: 'spotify:track:' + String(position % 300).padStart(22, '0'),
        name: 'Track ' + position,
        artists: { items: [{ profile: { name: 'Artist' } }] },
        albumOfTrack: { name: 'Album' },
        trackDuration: { totalMilliseconds: 180000 },
      } } };
    });
    return { data: { playlistV2: {
      name: 'Large playlist', description: 'Description',
      ownerV2: { data: { name: 'Owner' } },
      content: { items, ...(unknownTotal ? {} : { totalCount: total }) },
    } } };
  };
  return { c, offsets, cancel: () => { cancelled = true; } };
}

test('a ten-thousand-song playlist preserves order, metadata and repeated songs', () => {
  const app = runtime(10000);
  const result = app.c.fetchPlaylist('playlist');
  assert.equal(result.track_list.length, 10000);
  assert.equal(result.playlist_info.totalTracks, 10000);
  assert.equal(result.playlist_info.name, 'Large playlist');
  assert.equal(result.playlist_info.owner, 'Owner');
  assert.equal(result.track_list[9999].name, 'Track 9999');
  assert.equal(result.track_list[0].id, result.track_list[300].id);
  assert.deepEqual(app.offsets, Array.from({ length: 10 }, (_, i) => i * 1000));
});

test('server-capped pages continue to the declared playlist total', () => {
  const app = runtime(8085, { pageLimit: 200 });
  const result = app.c.fetchPlaylist('playlist');
  assert.equal(result.track_list.length, 8085);
  assert.equal(result.track_list.at(-1).name, 'Track 8084');
  assert.equal(app.offsets.at(-1), 8000);
});

test('unavailable playlist entries advance the raw page offset', () => {
  const app = runtime(8500, { unavailable: true });
  const result = app.c.fetchPlaylist('playlist');
  assert.equal(result.track_list.length, 8500 - Math.ceil(8500 / 97));
  assert.equal(result.playlist_info.totalTracks, 8500);
  assert.equal(result.track_list.at(-1).name, 'Track 8499');
});

test('an unknown playlist total loads through the final empty page', () => {
  const app = runtime(1500, { unknownTotal: true });
  assert.equal(app.c.fetchPlaylist('playlist').track_list.length, 1500);
  assert.deepEqual(app.offsets, [0, 1000, 1500]);
});

test('empty playlists retain their metadata', () => {
  const app = runtime(0);
  const result = app.c.fetchPlaylist('playlist');
  assert.equal(result.playlist_info.name, 'Large playlist');
  assert.equal(result.track_list.length, 0);
});

test('a failed later page does not return a partial playlist as success', () => {
  const app = runtime(8000, { page: offset => offset === 1000
    ? { errors: [{ message: 'Catalog temporarily unavailable' }] } : null });
  assert.throws(() => app.c.fetchPlaylist('playlist'), /Catalog temporarily unavailable/);
});

test('a premature empty page is reported instead of silently truncating', () => {
  const app = runtime(8000, { page: offset => offset === 1000
    ? { data: { playlistV2: { content: { totalCount: 8000, items: [] } } } } : null });
  assert.throws(() => app.c.fetchPlaylist('playlist'), /incomplete/i);
});

test('cancellation stops before requesting another page', () => {
  const app = runtime(8000, { page: offset => {
    if (offset === 0) app.cancel();
    return null;
  } });
  assert.throws(() => app.c.fetchPlaylist('playlist'), /cancel/i);
  assert.deepEqual(app.offsets, [0]);
});
