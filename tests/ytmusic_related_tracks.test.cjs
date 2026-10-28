const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/ytmusic-spotiflac/index.js'), 'utf8');
const PROVIDER = 'ytmusic-spotiflac';

function browse(id, pageType) {
  return {
    browseEndpoint: {
      browseId: id,
      browseEndpointContextSupportedConfigs: {
        browseEndpointContextMusicConfig: { pageType },
      },
    },
  };
}

function bylineRuns(artist, album) {
  return [
    { text: artist, navigationEndpoint: browse(`UC${artist.replace(/\W/g, '')}`, 'MUSIC_PAGE_TYPE_ARTIST') },
    { text: ' • ' },
    { text: album, navigationEndpoint: browse(`MPREb_${album.replace(/\W/g, '')}`, 'MUSIC_PAGE_TYPE_ALBUM') },
    { text: ' • ' },
    { text: '2020' },
  ];
}

function queueRow(id, name, { artist = 'Example artist', type = 'MUSIC_VIDEO_TYPE_ATV' } = {}) {
  return {
    playlistPanelVideoRenderer: {
      title: { runs: [{ text: name }] },
      longBylineText: { runs: bylineRuns(artist, 'Example album') },
      lengthText: { runs: [{ text: '3:20' }] },
      videoId: id,
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
      navigationEndpoint: {
        watchEndpoint: {
          videoId: id,
          watchEndpointMusicSupportedConfigs: {
            watchEndpointMusicConfig: { musicVideoType: type },
          },
        },
      },
    },
  };
}

function nextResponse(rows) {
  return {
    contents: {
      singleColumnMusicWatchNextResultsRenderer: {
        tabbedRenderer: {
          watchNextTabbedResultsRenderer: {
            tabs: [{
              tabRenderer: {
                content: {
                  musicQueueRenderer: {
                    content: { playlistPanelRenderer: { contents: rows } },
                  },
                },
              },
            }],
          },
        },
      },
    },
  };
}

function searchRow(id, name, artist, duration) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: name }] } } },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [...bylineRuns(artist, 'Example album').slice(0, 4), { text: duration }] },
          },
        },
      ],
      playlistItemData: { videoId: id },
    },
  };
}

function searchResponse(rows) {
  return {
    contents: {
      tabbedSearchResultsRenderer: {
        tabs: [{
          tabRenderer: {
            content: {
              sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows } }] },
            },
          },
        }],
      },
    },
  };
}

function runtime({ next = {}, search = {}, failNext = false } = {}) {
  let extension;
  const calls = [];
  const c = vm.createContext({
    URL,
    URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, error() {}, warn() {} },
    utils: { sleep() {} },
    storage: { get() {}, set() {} },
    fetch(url, options) {
      const body = JSON.parse(options.body);
      calls.push({ url, body });
      if (url.includes('/youtubei/v1/next')) {
        if (failNext) return { ok: false, status: 503, json: () => ({}) };
        assert.equal(body.playlistId, `RDAMVM${body.videoId}`);
        return { ok: true, status: 200, json: () => nextResponse(next[body.videoId] || []) };
      }
      if (url.includes('/youtubei/v1/search')) {
        return { ok: true, status: 200, json: () => searchResponse(search[body.query] || []) };
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  vm.runInContext(source, c);
  return { extension, calls };
}

// Arrays come from the vm realm, so copy them before deep comparisons.
const ids = list => Array.from(list, track => track.id);

test('own seed ids are used directly and the seed is excluded', () => {
  const { extension, calls } = runtime({
    next: {
      seedVideo01: [
        queueRow('seedVideo01', 'Example song'),
        queueRow('relatedA001', 'Example song A'),
        queueRow('relatedA002', 'Example song B'),
      ],
    },
  });
  const result = extension.getRelatedTracks(
    [{ id: 'seedVideo01', name: 'Example song', artists: 'Example artist', provider_id: PROVIDER }],
    { limit: 10 },
  );
  assert.deepEqual(ids(result), ['relatedA001', 'relatedA002']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.videoId, 'seedVideo01');
  const track = result[0];
  assert.equal(track.name, 'Example song A');
  assert.equal(track.artists, 'Example artist');
  assert.equal(track.album_name, 'Example album');
  assert.equal(track.duration_ms, 200000);
  assert.equal(track.provider_id, PROVIDER);
  assert.equal(track.item_type, 'track');
  assert.ok(track.cover_url.startsWith('https://i.ytimg.com/'));
});

test('foreign seeds resolve through a confident song search', () => {
  const { extension, calls } = runtime({
    search: {
      'Example artist Example song': [
        searchRow('wrongArtist', 'Example song', 'Other artist', '3:20'),
        searchRow('resolvedId1', 'Example song (Remastered)', 'Example artist', '3:21'),
      ],
    },
    next: {
      resolvedId1: [queueRow('resolvedId1', 'Example song'), queueRow('relatedB001', 'Example song C')],
    },
  });
  const result = extension.getRelatedTracks(
    [{ id: 'foreign-1', name: 'Example song', artists: 'Example artist', duration_ms: 200500, provider_id: 'other' }],
    {},
  );
  assert.deepEqual(ids(result), ['relatedB001']);
  assert.equal(calls[0].body.params, 'EgWKAQIIAQ%3D%3D');
  assert.equal(calls[1].body.videoId, 'resolvedId1');
});

test('unmatched foreign seeds are skipped without a related request', () => {
  const { extension, calls } = runtime({
    search: {
      'Example artist Example song': [searchRow('otherSong01', 'Different song', 'Example artist', '3:20')],
    },
  });
  const result = extension.getRelatedTracks(
    [{ id: 'foreign-1', name: 'Example song', artists: 'Example artist', provider_id: 'other' }],
    {},
  );
  assert.deepEqual(ids(result), []);
  assert.equal(calls.length, 1);
});

test('results interleave across seeds, dedupe, exclude seeds and honor the limit', () => {
  const { extension } = runtime({
    next: {
      seedVideo01: [
        queueRow('seedVideo01', 'Seed one'),
        queueRow('sharedId001', 'Shared song'),
        queueRow('oneSecond01', 'One second'),
        queueRow('oneThird001', 'One third'),
      ],
      seedVideo02: [
        queueRow('seedVideo02', 'Seed two'),
        queueRow('twoFirst001', 'Two first'),
        queueRow('sharedId001', 'Shared song'),
        queueRow('seedVideo01', 'Seed one'),
        queueRow('twoThird001', 'Two third'),
      ],
    },
  });
  const seeds = [
    { id: 'seedVideo01', name: 'Seed one', artists: 'Example artist', provider_id: PROVIDER },
    { id: 'seedVideo02', name: 'Seed two', artists: 'Example artist', provider_id: PROVIDER },
  ];
  assert.deepEqual(ids(extension.getRelatedTracks(seeds, { limit: 50 })), [
    'sharedId001', 'twoFirst001', 'oneSecond01', 'oneThird001', 'twoThird001',
  ]);
  assert.deepEqual(ids(extension.getRelatedTracks(seeds, { limit: 3 })), [
    'sharedId001', 'twoFirst001', 'oneSecond01',
  ]);
});

test('songs are preferred over music videos in the radio queue', () => {
  const { extension } = runtime({
    next: {
      seedVideo01: [
        queueRow('videoOnly01', 'Video', { type: 'MUSIC_VIDEO_TYPE_OMV' }),
        queueRow('songOnly001', 'Song'),
      ],
      seedVideo02: [queueRow('videoOnly02', 'Video two', { type: 'MUSIC_VIDEO_TYPE_OMV' })],
    },
  });
  assert.deepEqual(ids(extension.getRelatedTracks(
    [{ id: 'seedVideo01', name: 'Seed', artists: 'Example artist', provider_id: PROVIDER }], {},
  )), ['songOnly001']);
  assert.deepEqual(ids(extension.getRelatedTracks(
    [{ id: 'seedVideo02', name: 'Seed', artists: 'Example artist', provider_id: PROVIDER }], {},
  )), ['videoOnly02']);
});

test('empty input returns nothing and failed related requests throw', () => {
  assert.deepEqual(ids(runtime().extension.getRelatedTracks([], {})), []);
  const { extension } = runtime({ failNext: true });
  assert.throws(() => extension.getRelatedTracks(
    [{ id: 'seedVideo01', name: 'Seed', artists: 'Example artist', provider_id: PROVIDER }], {},
  ), /related tracks unavailable/);
});

test('at most five seeds are attempted', () => {
  const { extension, calls } = runtime();
  const seeds = Array.from({ length: 10 }, (_, i) => ({
    id: `seedVideo${String(i).padStart(2, '0')}`,
    name: 'Seed',
    artists: 'Example artist',
    provider_id: PROVIDER,
  }));
  assert.deepEqual(ids(extension.getRelatedTracks(seeds, {})), []);
  assert.equal(calls.length, 5);
});
