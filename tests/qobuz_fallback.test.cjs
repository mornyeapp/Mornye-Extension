const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime() {
  const ctx = vm.createContext({
    registerExtension() {}, log: { info() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources/qobuz-web/index.js'), 'utf8'), ctx);
  return ctx;
}
const track = (id, extra = {}) => ({ id, title: 'Signal', performer: { name: 'Artist' },
  isrc: 'USAAA0000001', duration: 180, ...extra });

test('a recovered soundtrack is reused when the next song has different singers', () => {
  const c = runtime();
  const album = { id: 'jolly2', title: 'Jolly LLB 2', tracks: { items: [
    track('314150580', { title: 'Bawara Mann', isrc: 'INS181700030', performer: { name: 'Jubin Nautiyal' } }),
    track('314150581', { title: 'Jolly Good Fellow', isrc: 'INS181700033', performer: { name: 'Meet Bros' } }),
  ] } };
  const options = { duration_ms: 180000, track: {
    album_name: 'Jolly LLB 2 (Original Motion Picture Soundtrack)',
    album_artist: 'Manj Musik, Chirrantan Bhatt, Meet Bros & Vishal Khurana',
  } };
  c.searchTracksViaAPI = () => { throw new Error('HTTP 429'); };
  c.searchAlbumsViaAPI = query => {
    if (query === 'Jolly LLB 2 jubin nautiyal') return [{ id: album.id }];
    throw new Error('HTTP 429');
  };
  c.getMetadataJSON = () => album;
  c.hydrateGenreHierarchy = () => {};
  assert.equal(c.checkAvailability('INS181700030', 'Bawara Mann', 'Jubin Nautiyal & Neeti Mohan', options).track_id, '314150580');
  let requests = 0;
  c.searchTracksViaAPI = c.searchAlbumsViaAPI = c.getMetadataJSON = () => {
    requests++;
    throw new Error('HTTP 429');
  };
  assert.equal(c.checkAvailability('INS181700033', 'Jolly Good Fellow', 'Meet Bros, Shabbir Ahmed & Earl Edgar', options).track_id, '314150581');
  assert.equal(requests, 0);
  c.searchTracksViaAlbumSearch = c.searchTracksViaStore = () => [];
  for (const [title, artist, duration] of [
    ['Jolly Good Fellow (Remix)', 'Meet Bros', 180000],
    ['Jolly Good Fellow', 'Unrelated Singer', 180000],
    ['Jolly Good Fellow', 'Meet Bros', 300000],
  ]) {
    assert.equal(c.checkAvailability('', title, artist, { ...options, duration_ms: duration }).available, false);
  }
});

test('failed metadata sources report the rate limit instead of a catalog miss', () => {
  const c = runtime();
  c.searchTracksViaAPI = c.searchAlbumsViaAPI = () => { throw new Error('HTTP 429: Upstream request failed'); };
  c.searchTracksViaAlbumSearch = c.searchTracksViaStore = () => { throw new Error('HTTP 403'); };
  const result = c.checkAvailability('INS181700033', 'Jolly Good Fellow', 'Meet Bros', {
    duration_ms: 180000, track: { album_name: 'Jolly LLB 2' },
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /429/);
  assert.doesNotMatch(result.reason, /No verified/);
});

test('source album recovery precedes expensive hydration and reuses a cached release', () => {
  const c = runtime();
  const album = { id: 'ix7jv0x73q4sa', title: 'Race', tracks: { items: [
    track('129598571', { title: 'Zara Zara Touch Me', isrc: 'INT100700315', duration: 285, performer: { name: 'Monali Thakur' } }),
    track('129598572', { title: 'Zara Zara Touch Me (Asian Rnb Mix)', isrc: 'INT100700312', duration: 240, performer: { name: 'Monali Thakur' } }),
    track('129598573', { title: 'Zara Zara Touch Me (Remix)', isrc: 'INT100700319', duration: 271, performer: { name: 'Monali Thakur' } }),
  ] } };
  const queries = [];
  c.searchTracksViaAPI = query => { queries.push(query); return []; };
  c.searchTracksViaAlbumSearch = () => assert.fail('deep track hydration must wait for the source album');
  c.searchTracksViaStore = () => assert.fail('store hydration must wait for the source album');
  c.searchAlbumsViaAPI = query => {
    assert.equal(query, 'Race Pritam');
    return [{ id: album.id }];
  };
  c.metadataCacheSet('album:' + album.id, album);
  c.getMetadataJSON = () => assert.fail('the complete album is already cached');
  const options = { duration_ms: 240000, track: { album_name: 'Race (Original Motion Picture Soundtrack)', album_artist: 'Pritam' } };
  const title = 'Zara Zara Touch Me (Asian Rnb Mix)';
  const artists = 'Monali Thakur, Earl Edgar & Pritam';
  assert.equal(c.checkAvailability('INT100700312', title, artists, options).track_id, '129598572');
  assert.equal(queries.length, 1, 'source album is checked after the first track query');
  queries.length = 0;
  assert.equal(c.checkAvailability('INT100700312', title, artists, options).track_id, '129598572');
  assert.equal(queries.length, 0, 'cached release is checked before any track search');
  assert.equal(c.qobuzTrackMatchesRequest(album.tracks.items[0], '', title, artists, 240000), false);
  assert.equal(c.qobuzTrackMatchesRequest(album.tracks.items[2], '', title, artists, 240000), false);
});

test('availability skips repeated slow metadata attempts and restores manual retry policy', () => {
  const c = runtime();
  let signedCalls = 0;
  c.session = { signedFetch() {
    signedCalls++;
    return { error: 'network timeout' };
  } };
  c.getPublicQobuzJSON = () => ({ tracks: { items: [track('1')] } });
  c.waitBeforeRetry = () => assert.fail('availability must try a distinct source instead of retrying');
  assert.equal(request(c).track_id, '1');
  assert.equal(signedCalls, 1);
  assert.equal(c.CONFIG.metadataAttempts, 3);
  c.waitBeforeRetry = () => {};
  assert.throws(() => c.getMetadataJSON('track/search', {}), /network timeout/);
  assert.equal(signedCalls, 4, 'manual metadata calls retain all three attempts');
});

test('an expired runtime deadline does not issue public, album, or store requests', () => {
  const c = runtime();
  let signedCalls = 0;
  c.session = { signedFetch() {
    signedCalls++;
    return { error: 'execution timeout exceeded' };
  } };
  c.getPublicQobuzJSON = () => assert.fail('the runtime deadline is terminal');
  c.searchTracksViaAlbumSearch = () => assert.fail('the runtime deadline is terminal');
  c.searchTracksViaStore = () => assert.fail('the runtime deadline is terminal');
  const result = c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
    duration_ms: 180000, track: { album_name: 'Collection' },
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'execution timeout exceeded');
  assert.equal(signedCalls, 1);
  assert.equal(c.CONFIG.metadataAttempts, 3);
});
const request = c => c.checkAvailability('USAAA0000001', 'Signal', 'Artist', { duration_ms: 180000 });
function sources(c, api, album = () => [], store = () => []) {
  c.searchTracksViaAPI = api;
  c.searchTracksViaAlbumSearch = album;
  c.searchTracksViaStore = store;
}

test('download metadata includes duration for host matching across release editions', () => {
  const c = runtime();
  const result = c.applyTrackMetadataToDownloadResult({ success: true }, {
    name: 'Signal', artists: 'Composer, Singer', album_name: 'Compilation', duration_ms: 305000,
  });
  assert.equal(result.duration_ms, 305000);
  assert.equal(c.applyTrackMetadataToDownloadResult({}, {}).duration_ms, 0);
});

test('store recovery reads plain and HTML-encoded cart links in document order', () => {
  const c = runtime();
  const html = '<button data-url="&#x2F;v4&#x2F;ajax&#x2F;popin-add-cart&#x2F;track&#x2F;12"></button>' +
    '<a href="/v4/ajax/popin-add-cart/track/13"></a>' +
    '<button data-url="&#00047;v4&#47;ajax&#47;popin-add-cart&#47;track&#47;12"></button>' +
    '<button data-url="&#X002F;v4&#X2F;ajax&#X2F;popin-add-cart&#X2F;track&#X2F;14"></button>' +
    '<a href="/v4/ajax/popin-add-cart/album/99"></a>';
  assert.deepEqual(Array.from(c.extractTrackIDsFromStoreSearchHTML(html)), ['12', '13', '14']);
  c.fetchText = () => html;
  const hydrated = [];
  c.fetchTrackRaw = id => { hydrated.push(id); return track(id); };
  assert.equal(c.searchTracksViaStore('Signal', 2).length, 2);
  assert.deepEqual(hydrated, ['12', '13']);
});

test('partial album recovery hydrates encoded storefront links without duplicating tracks', () => {
  const c = runtime();
  c.fetchText = () => '<button data-url="&#x2F;v4&#x2F;ajax&#x2F;popin-add-cart&#x2F;track&#x2F;1"></button>' +
    '<button data-url="&#x2F;v4&#x2F;ajax&#x2F;popin-add-cart&#x2F;track&#x2F;2"></button>';
  c.getPublicQobuzJSON = (resource, params) => {
    assert.equal(resource, 'widget/getTrackById');
    assert.equal(params.track_id, '2');
    return track('2', { track_number: 2 });
  };
  const album = c.completePublicAlbumTracks({
    id: 'album', tracks_count: 2, tracks: { items: [track('1', { track_number: 1 })] },
  });
  assert.equal(c.albumTracksComplete(album), true);
  assert.deepEqual(Array.from(album.tracks.items, t => t.id), ['1', '2']);
});

test('Race recordings accept Apple artist punctuation and retain recording identity', () => {
  const c = runtime();
  const recordings = [
    ['129598562', 'Mujh Pe Toh Jadoo (Remix)', 'INT100700318', 'Taz Stereo Nation',
      'TAZ-Stereo Nation, Sunidhi Chauhan, Apache Indian & Pritam', 261, 261322],
    ['129598568', 'Race Is On My Mind (Remix)', 'INT100700322', 'Sunidhi Chauhan',
      'Sunidhi Chauhan, Neeraj Shridhar & Pritam', 268, 268760],
    ['129598572', 'Zara Zara Touch Me (Asian Rnb Mix)', 'INT100700312', 'Monali Thakur',
      'Monali Thakur, Earl Edgar & Pritam', 240, 240992],
  ];
  for (const [id, title, isrc, performer, artists, duration, durationMs] of recordings) {
    const candidate = track(id, { title, isrc, performer: { name: performer }, duration });
    assert.equal(c.qobuzTrackMatchesRequest(candidate, isrc, title, artists, durationMs), true);
    assert.equal(c.qobuzTrackMatchesRequest(candidate, '', title, artists, durationMs), true);
    assert.equal(c.qobuzTrackMatchesRequest(candidate, '', title + ' (Live)', artists, durationMs), false);
    assert.equal(c.qobuzTrackMatchesRequest(candidate, '', title, 'Unrelated Artist', durationMs), false);
  }
  assert.equal(c.artistNamesMatch('TAZ-Stereo Nation', 'Taz Stereo Nation'), true);
  assert.equal(c.artistNamesMatch('Taz Stereo Nation', 'TAZ-Stereo Nation'), true);
});

test('short soundtrack titles retain artist qualification before searching ambiguous albums', () => {
  for (const albumArtist of ['', 'Pritam']) {
    const c = runtime();
    sources(c, () => []);
    const queries = [];
    c.searchAlbumsViaAPI = query => {
      queries.push(query);
      return query === (albumArtist ? 'Race Pritam' : 'Race taz stereo nation')
        ? [{ id: 'race' }] : [];
    };
    c.fetchAlbumRaw = id => ({ id, title: 'Race', tracks: { items: [track('129598562', {
      title: 'Mujh Pe Toh Jadoo (Remix)', isrc: 'INT100700318',
      performer: { name: 'Taz Stereo Nation' }, duration: 261,
    })] } });
    const result = c.checkAvailability('INT100700318', 'Mujh Pe Toh Jadoo (Remix)',
      'TAZ-Stereo Nation, Sunidhi Chauhan, Apache Indian & Pritam', {
        duration_ms: 261322,
        track: { album_name: 'Race (Original Motion Picture Soundtrack)', album_artist: albumArtist },
      });
    assert.equal(result.track_id, '129598562');
    if (albumArtist) assert.equal(queries.at(-1), 'Race Pritam');
    else assert.equal(queries.at(-1), 'Race taz stereo nation');
    assert.ok(!queries.includes('Race'), 'qualified recovery finishes before the ambiguous title query');
  }
});

test('exact ISRC outranks a name match and prefers a matching catalog duration', () => {
  const c = runtime();
  const name = track('1', { isrc: 'different', maximum_bit_depth: 24 });
  const exact = track('2', { isrc: ' usaaa0000001 ', maximum_bit_depth: 16 });
  const long = track('3', { duration: 210 });
  assert.equal(c.selectBestSearchTrack([name, long, exact], 'USAAA0000001', 'Signal', 'Artist', 180000).id, '2');
  assert.equal(c.selectBestSearchTrack([long], 'USAAA0000001', 'Signal', 'Artist', 180000).id, '3');
  assert.equal(c.selectBestSearchTrack([long], '', 'Signal', 'Artist', 180000), null);
  assert.equal(c.validateDownloadedDuration(180000, 30).valid, false);
  assert.equal(c.validateDownloadedDuration(180000, 191).valid, false);
});

test('ISRC-only searches reject unrelated results, including direct IDs', () => {
  const c = runtime();
  const unrelated = track('1', { isrc: 'different' });
  sources(c, () => [unrelated]);
  c.fetchTrackRaw = () => unrelated;
  assert.equal(c.checkAvailability('USAAA0000001', '', '', { qobuz_id: '1' }).available, false);
});

test('invalid API candidates allow album and store fallbacks', () => {
  for (const matchSource of ['album', 'store']) {
    const c = runtime();
    const calls = [];
    sources(c, () => { calls.push('api'); return [track('1', { isrc: '', duration: 240 })]; },
      () => { calls.push('album'); return matchSource === 'album' ? [track('2')] : [track('3', { isrc: '', title: 'Other' })]; },
      () => { calls.push('store'); return [track('4')]; });
    assert.equal(request(c).track_id, matchSource === 'album' ? '2' : '4');
    assert.deepEqual(calls, matchSource === 'album' ? ['api', 'album'] : ['api', 'album', 'store']);
  }
});

test('an ISRC alternate query can match even when a name was supplied', () => {
  const c = runtime();
  const calls = [];
  sources(c, q => { calls.push(q); return q === 'USAAA0000001' ? [track('2')] : [track('1', { isrc: '', duration: 220 })]; });
  assert.equal(request(c).track_id, '2');
  assert.deepEqual(calls, ['Signal Artist', 'USAAA0000001']);
});

test('search remains bounded and deduplicates alternate queries', () => {
  const c = runtime();
  const calls = [];
  const empty = q => { calls.push(q); return []; };
  sources(c, empty, empty, empty);
  assert.equal(request(c).available, false);
  assert.equal(calls.length, 9);
  assert.equal(request(c).available, false);
  assert.equal(calls.length, 9, 'negative source caches avoid repeating requests');
  c.cleanup();
  calls.length = 0;
  assert.equal(c.checkAvailability('', 'Signal', '', {}).available, false);
  assert.equal(calls.length, 3, 'identical title and title+artist queries run once');
});

test('raw cache results are revalidated for each request and shared with normal search', () => {
  const c = runtime();
  let apiCalls = 0;
  let albumCalls = 0;
  sources(c, () => { apiCalls++; return [track('1', { isrc: '', duration: 210 })]; },
    () => { albumCalls++; return [track('2')]; });
  assert.equal(c.searchTracksWithFallback('Signal Artist', 8)[0].id, '1');
  assert.equal(request(c).track_id, '2');
  assert.equal(apiCalls, 1);
  assert.equal(albumCalls, 1);
  assert.equal(request(c).track_id, '2');
  assert.equal(albumCalls, 1);
});

test('verification halts fallback search and direct-ID verification propagates', () => {
  const c = runtime();
  let fallbackCalls = 0;
  sources(c, () => { throw new Error('VERIFY_REQUIRED'); }, () => { fallbackCalls++; return []; });
  assert.throws(() => request(c), /VERIFY_REQUIRED/);
  assert.equal(fallbackCalls, 0);
  c.fetchTrackRaw = () => { throw new Error('VERIFY_REQUIRED'); };
  assert.throws(() => c.checkAvailability('USAAA0000001', 'Signal', 'Artist', { qobuz_id: '1' }), /VERIFY_REQUIRED/);
});

test('native signed-session challenges propagate from availability and manual search', () => {
  const c = runtime();
  let signedCalls = 0;
  c.session = {
    signedFetch() {
      signedCalls++;
      return { needsVerification: true, auth_url: 'https://auth.example.test/verify' };
    },
  };
  c.http = { get() { assert.fail('verification must not fall through to public search'); } };
  assert.throws(() => request(c), /VERIFY_REQUIRED/);
  assert.throws(() => c.customSearch('Signal', { filter: 'track' }), /VERIFY_REQUIRED/);
  assert.equal(signedCalls, 2);
});

test('verification errors are not cached as unavailable after a grant', () => {
  const c = runtime();
  let granted = false;
  let signedCalls = 0;
  c.session = {
    signedFetch() {
      signedCalls++;
      if (!granted) return { needsVerification: true };
      return { statusCode: 200, body: JSON.stringify({ tracks: { items: [track('1')] } }) };
    },
  };
  assert.throws(() => request(c), /VERIFY_REQUIRED/);
  granted = true;
  assert.equal(request(c).track_id, '1');
  assert.equal(signedCalls, 2);
});

test('cached misses do not contact the session while a manual search can request verification', () => {
  const c = runtime();
  const originalSources = [c.searchTracksViaAPI, c.searchTracksViaAlbumSearch, c.searchTracksViaStore];
  sources(c, () => [], () => [], () => []);
  assert.equal(request(c).available, false);
  sources(c, ...originalSources);
  let signedCalls = 0;
  c.session = {
    signedFetch() {
      signedCalls++;
      return { needsVerification: true };
    },
  };
  assert.equal(request(c).available, false);
  assert.equal(signedCalls, 0, 'the host must prepare the session before accepting cached availability');
  assert.throws(() => c.customSearch('Signal', { filter: 'track' }), /VERIFY_REQUIRED/);
  assert.equal(signedCalls, 1);
});

for (const method of ['fetchTrackRaw', 'fetchAlbumRaw', 'fetchPlaylistPage']) {
  test(`${method} preserves native verification instead of caching public fallback metadata`, () => {
    const c = runtime();
    let publicCalls = 0;
    c.session = { signedFetch: () => ({ needsVerification: true }) };
    c.getPublicQobuzJSON = () => {
      publicCalls++;
      return { ...track('1'), tracks_count: 1, tracks: { items: [track('1')] } };
    };
    c.ensureAlbumUPC = album => album;
    c.hydrateGenreHierarchy = () => {};
    assert.throws(() => c[method]('1', 10, 0), /VERIFY_REQUIRED/);
    assert.equal(publicCalls, 0);
    assert.equal(c.METADATA_CACHE.size, 0);
  });

  test(`${method} still uses public metadata for ordinary API failures`, () => {
    const c = runtime();
    let publicCalls = 0;
    c.getMetadataJSON = () => { throw new Error('HTTP 503'); };
    c.getPublicQobuzJSON = () => {
      publicCalls++;
      return { ...track('1'), tracks_count: 1, tracks: { items: [track('1')] } };
    };
    c.ensureAlbumUPC = album => album;
    c.hydrateGenreHierarchy = () => {};
    assert.equal(c[method]('1', 10, 0).id, '1');
    assert.equal(publicCalls, 1);
  });
}

test('only a successful grant clears search misses before retrying availability', () => {
  const c = runtime();
  const originalSources = [c.searchTracksViaAPI, c.searchTracksViaAlbumSearch, c.searchTracksViaStore];
  sources(c, () => [], () => [], () => []);
  assert.equal(request(c).available, false);
  sources(c, ...originalSources);
  let granted = false;
  let signedCalls = 0;
  c.session = {
    completeGrant: () => ({ success: granted }),
    signedFetch() {
      signedCalls++;
      return { statusCode: 200, body: JSON.stringify({ tracks: { items: [track('1')] } }) };
    },
  };
  assert.equal(c.completeGrant().success, false);
  assert.equal(request(c).available, false);
  assert.equal(signedCalls, 0);
  granted = true;
  assert.equal(c.completeGrant().success, true);
  assert.equal(request(c).track_id, '1');
  assert.equal(signedCalls, 1);
});

test('download resolution stops at a verification challenge without trying other qualities', () => {
  const c = runtime();
  let calls = 0;
  c.fetchProviderDownloadInfo = () => { calls++; throw new Error('VERIFY_REQUIRED'); };
  assert.throws(() => c.resolveDownloadInfo('1', 'HI_RES_LOSSLESS'), /VERIFY_REQUIRED/);
  assert.equal(calls, 1);
});

test('the native download response can request verification without an error string', () => {
  const c = runtime();
  let calls = 0;
  c.signedTicket = () => 'fixture-ticket';
  c.session = { signedFetch() { calls++; return { needsVerification: true }; } };
  assert.throws(() => c.resolveDownloadInfo('1', 'HI_RES_LOSSLESS'), /VERIFY_REQUIRED/);
  assert.equal(calls, 1);
});

test('a challenge after a preview download retains its verification error type', () => {
  const c = runtime();
  let resolutions = 0;
  c.gobackend = {};
  c.resolveDownloadInfo = () => {
    if (++resolutions === 2) throw new Error('VERIFY_REQUIRED');
    return { directURL: 'https://audio.example.test/preview.flac', candidateKey: 'fixture@27' };
  };
  c.downloadDirectFile = () => ({ success: true, path: '/preview.flac' });
  c.readDownloadedAudioQuality = () => ({ duration: 30 });
  c.deleteQuietly = () => {};
  const result = c.download('1', 'HI_RES_LOSSLESS', '/song.flac', null, {
    preparedContext: { host_track: { name: 'Signal', artists: 'Artist', duration_ms: 180000 } },
  });
  assert.equal(result.success, false);
  assert.equal(result.error_type, 'verification_required');
  assert.equal(resolutions, 2);
});

test('cancellation stops requests before search and between sources', () => {
  const c = runtime();
  let calls = 0;
  let cancelled = true;
  c.utils.isDownloadCancelled = () => cancelled;
  sources(c, () => { calls++; cancelled = true; return []; }, () => { calls++; return []; });
  assert.match(request(c).reason, /cancelled/);
  assert.equal(calls, 0);
  cancelled = false;
  assert.match(request(c).reason, /cancelled/);
  assert.equal(calls, 1);
});

test('album and store hydration do not swallow verification', () => {
  const c = runtime();
  c.fetchAlbumRaw = () => { throw new Error('VERIFY_REQUIRED'); };
  assert.throws(() => c.selectTracksFromAlbumSearch('Signal', [{ id: '1' }], 8), /VERIFY_REQUIRED/);
  c.fetchText = () => '';
  c.extractTrackIDsFromStoreSearchHTML = () => ['1'];
  c.fetchTrackRaw = () => { throw new Error('VERIFY_REQUIRED'); };
  assert.throws(() => c.searchTracksViaStore('Signal', 8), /VERIFY_REQUIRED/);
});

test('ordinary source errors permit the next source and alternate queries', () => {
  const c = runtime();
  sources(c, () => { throw new Error('HTTP 503'); }, () => [track('2')]);
  assert.equal(request(c).track_id, '2');
  c.cleanup();
  sources(c, q => { if (q === 'USAAA0000001') return [track('3')]; throw new Error('HTTP 503'); },
    () => { throw new Error('HTTP 503'); }, () => { throw new Error('HTTP 503'); });
  assert.equal(request(c).track_id, '3');
});

test('title-only alternate keeps artist and duration validation', () => {
  const c = runtime();
  sources(c, q => q === 'Signal' ? [track('1', { isrc: '', performer: { name: 'Someone else' } }),
    track('2', { isrc: '', duration: 230 }), track('3', { isrc: '' })] : []);
  assert.equal(request(c).track_id, '3');
});

test('album metadata recovers a final remix omitted from track search', () => {
  const c = runtime();
  const queries = [];
  c.searchTracksViaAPI = () => [];
  c.searchTracksViaStore = () => [];
  c.searchAlbumsViaAPI = (query, limit) => {
    queries.push({ query, limit });
    return query === 'Original Soundtrack' ? [{ id: 'album-one' }] : [];
  };
  c.fetchAlbumRaw = () => ({
    id: 'album-one', title: 'Original Soundtrack',
    tracks: { items: [
      ...Array.from({ length: 10 }, (_, index) => track(String(index + 1), { isrc: '', title: 'Signal', duration: 234 })),
      track('11', { isrc: '', title: 'Signal', version: 'Remix', duration: 234 }),
    ] },
  });
  const result = c.checkAvailability('', 'Signal - Remix', 'Artist', {
    duration_ms: 234000, track: { album_name: 'Original Soundtrack' },
  });
  assert.equal(result.available, true);
  assert.equal(result.track_id, '11');
  assert.equal(result.prepared_context.raw_track.version, 'Remix');
  assert.equal(queries.at(-1).query, 'Original Soundtrack');
  assert.ok(queries.at(-1).limit <= 3);
});

test('album recovery rejects a different recording and propagates verification', () => {
  const c = runtime();
  c.searchTracksViaAPI = () => [];
  c.searchTracksViaStore = () => [];
  c.searchAlbumsViaAPI = query => query === 'Original Soundtrack' ? [{ id: 'album-one' }] : [];
  c.fetchAlbumRaw = () => ({ id: 'album-one', tracks: { items: [track('1', { isrc: '', duration: 280 })] } });
  const options = { duration_ms: 234000, track: { album_name: 'Original Soundtrack' } };
  assert.equal(c.checkAvailability('', 'Signal - Remix', 'Artist', options).available, false);
  c.fetchAlbumRaw = () => { throw new Error('VERIFY_REQUIRED'); };
  assert.throws(() => c.checkAvailability('', 'Signal - Remix', 'Artist', options), /VERIFY_REQUIRED/);
});

test('album recovery qualifies common album titles with the requested artist', () => {
  const c = runtime();
  sources(c, () => []);
  const queries = [];
  c.searchAlbumsViaAPI = (query, limit) => {
    queries.push([query, limit]);
    return query === 'Twelve Bilal Saeed' ? [{ id: 'matching-album' }] :
      [{ id: 'unrelated-one' }, { id: 'unrelated-two' }, { id: 'unrelated-three' }];
  };
  c.fetchAlbumRaw = id => {
    assert.equal(id, 'matching-album');
    return { id, tracks: { items: [track('411608895', {
      title: 'Ku Ku', performer: { name: 'Bilal Saeed' }, isrc: 'GBUQQ1262402', duration: 202,
    })] } };
  };
  const result = c.checkAvailability('GBUQQ1262402', 'Ku Ku (feat. Dr Zeus & Young Fateh)', 'Bilal Saeed', {
    duration_ms: 202000, track: { album_name: 'Twelve' },
  });
  assert.equal(result.track_id, '411608895');
  assert.deepEqual(queries, [['Twelve Bilal Saeed', 3]]);
});

test('qualified album misses retain title fallback and separate cache entries', () => {
  const c = runtime();
  sources(c, () => []);
  const queries = [];
  c.searchAlbumsViaAPI = query => {
    queries.push(query);
    return query === 'Collection' ? [{ id: 'album' }] : [];
  };
  c.fetchAlbumRaw = id => ({ id, tracks: { items: [track('2')] } });
  const options = { duration_ms: 180000, track: { album_name: 'Collection' } };
  assert.equal(c.checkAvailability('USAAA0000001', 'Signal', 'Artist', options).track_id, '2');
  assert.equal(c.checkAvailability('USAAA0000001', 'Signal', 'Artist', options).track_id, '2');
  assert.deepEqual(queries, ['Collection Artist', 'Collection']);
  c.checkAvailability('', 'Signal', 'Someone Else', options);
  assert.equal(queries.at(-1), 'Collection Someone Else');
});

test('album recovery handles featured artists without weakening track validation', () => {
  const c = runtime();
  sources(c, () => []);
  const queries = [];
  c.searchAlbumsViaAPI = query => {
    queries.push(query);
    return query === 'Twelve bilal saeed' ? [{ id: 'album' }] : [];
  };
  c.fetchAlbumRaw = id => ({ id, tracks: { items: [
    track('411608897', { title: '2 Number', performer: { name: 'Bilal Saeed' }, isrc: 'GBUQQ1262404', duration: 243 }),
    track('411608903', { title: 'Dil', performer: { name: 'Bilal Saeed' }, isrc: 'GBUQQ1262410', duration: 192 }),
  ] } });
  const artist = 'Bilal Saeed & Amrinder Gill';
  const options = duration => ({ duration_ms: duration, track: { album_name: 'Twelve' } });
  assert.equal(c.checkAvailability('GBUQQ1262404', '2 Number (feat. Dr Zeus & Young Fateh)', artist, options(243150)).track_id, '411608897');
  assert.equal(c.checkAvailability('GBUQQ1262410', 'Dil', artist, options(192006)).track_id, '411608903');
  assert.deepEqual(queries, ['Twelve Bilal Saeed & Amrinder Gill', 'Twelve bilal saeed']);
  assert.equal(c.checkAvailability('', 'Dil - Remix', artist, options(192006)).available, false);
  assert.equal(c.checkAvailability('', 'Dil', artist, options(240000)).available, false);
  assert.equal(c.checkAvailability('', 'Dil', 'Someone Else', options(192006)).available, false);
});

test('album recovery retries a soundtrack title without its catalog annotation', () => {
  const c = runtime();
  sources(c, () => []);
  const queries = [];
  c.searchAlbumsViaAPI = (query, limit) => {
    queries.push([query, limit]);
    return query === 'Collection' ? [{ id: 'soundtrack' }] : [];
  };
  c.fetchAlbumRaw = id => ({ id, tracks: { items: [
    track('1', { performer: { name: 'Artist, Guest' }, duration: 197 }),
    track('2', { title: 'Another Signal', isrc: 'USAAA0000002', duration: 239 }),
  ] } });
  const album = 'Collection (Original Motion Picture Soundtrack)';
  const first = c.checkAvailability('USAAA0000001', 'Signal', 'Artist & Guest', {
    duration_ms: 197718, track: { album_name: album },
  });
  const second = c.checkAvailability('USAAA0000002', 'Another Signal', 'Artist', {
    duration_ms: 239189, track: { album_name: album },
  });
  assert.equal(first.track_id, '1');
  assert.equal(second.track_id, '2');
  assert.equal(queries.filter(([query]) => query === 'Collection').length, 1,
    'the recovered album search remains shared between its tracks');
  assert.ok(queries.every(([, limit]) => limit === 3));
  assert.equal(c.checkAvailability('', 'Signal (Live)', 'Artist', {
    duration_ms: 197718, track: { album_name: album },
  }).available, false);
  assert.equal(c.checkAvailability('', 'Signal', 'Different Singer', {
    duration_ms: 197718, track: { album_name: album },
  }).available, false);
  assert.equal(c.checkAvailability('', 'Signal', 'Artist', {
    duration_ms: 280000, track: { album_name: album },
  }).available, false);
});

test('soundtrack recovery preserves edition names and does not search an empty title', () => {
  for (const title of ['Collection (Deluxe)', 'Collection (Live)', '(Original Soundtrack)']) {
    const c = runtime();
    sources(c, () => []);
    const queries = [];
    c.searchAlbumsViaAPI = query => { queries.push(query); return []; };
    assert.equal(c.checkAvailability('', 'Signal', 'Artist', {
      track: { album_name: title },
    }).available, false);
    assert.deepEqual(queries, [title + ' Artist', title]);
  }
});

test('unmatched or failed qualified album searches retain bounded title recovery', () => {
  for (const fails of [false, true]) {
    const c = runtime();
    sources(c, () => []);
    const queries = [];
    const hydrated = [];
    c.searchAlbumsViaAPI = (query, limit) => {
      queries.push([query, limit]);
      if (query === 'Collection') return [{ id: 'matching' }];
      if (fails) throw new Error('HTTP 503');
      return Array.from({ length: 8 }, (_, id) => ({ id: String(id) }));
    };
    c.fetchAlbumRaw = id => {
      hydrated.push(id);
      return { id, tracks: { items: [track(id, id === 'matching' ? {} : { isrc: '', duration: 280 })] } };
    };
    const result = c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
      duration_ms: 180000, track: { album_name: 'Collection' },
    });
    assert.equal(result.track_id, 'matching');
    assert.deepEqual(queries, [['Collection Artist', 3], ['Collection', 3]]);
    assert.deepEqual(hydrated, fails ? ['matching'] : ['0', '1', '2', 'matching']);
  }
});

test('empty album searches stay cached without repeating requests', () => {
  const c = runtime();
  sources(c, () => []);
  const queries = [];
  c.searchAlbumsViaAPI = query => { queries.push(query); return []; };
  c.fetchAlbumRaw = () => assert.fail('empty search must not hydrate albums');
  const options = { duration_ms: 180000, track: { album_name: 'Collection' } };
  assert.equal(c.checkAvailability('USAAA0000001', 'Signal', 'Artist', options).available, false);
  assert.equal(c.checkAvailability('USAAA0000001', 'Signal', 'Artist', options).available, false);
  assert.deepEqual(queries, ['Collection Artist', 'Collection']);
});

test('source album identity outranks an earlier title match from another release', () => {
  const c = runtime();
  sources(c, () => [track('other-release', { isrc: 'OTHER', album: { title: 'Compilation' } })]);
  const queries = [];
  c.searchAlbumsViaAPI = query => { queries.push(query); return [{ id: 'source' }]; };
  c.fetchAlbumRaw = () => ({ id: 'source', title: 'Collection', tracks: { items: [track('original')] } });
  const result = c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
    duration_ms: 181000, track: { album_name: 'Collection' },
  });
  assert.equal(result.track_id, 'original');
  assert.equal(result.prepared_context.raw_track.isrc, 'USAAA0000001');
  assert.deepEqual(queries, ['Collection Artist']);
});

test('exact search identity avoids extra source album requests', () => {
  const c = runtime();
  sources(c, () => [track('exact')]);
  c.searchAlbumsViaAPI = () => assert.fail('exact match should finish immediately');
  assert.equal(c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
    duration_ms: 180000, track: { album_name: 'Collection' },
  }).track_id, 'exact');
});

test('unavailable source album retains a validated alternate but never hides verification or cancellation', () => {
  for (const mode of ['empty', 'error', 'verification', 'cancel']) {
    const c = runtime();
    sources(c, () => [track('alternate', { isrc: 'OTHER' })]);
    let cancelled = false;
    c.utils.isDownloadCancelled = () => cancelled;
    c.searchAlbumsViaAPI = () => {
      if (mode === 'verification') throw new Error('VERIFY_REQUIRED');
      if (mode === 'error') throw new Error('HTTP 503');
      cancelled = mode === 'cancel';
      return [];
    };
    const run = () => c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
      duration_ms: 180000, track: { album_name: 'Collection' },
    });
    if (mode === 'verification') assert.throws(run, /VERIFY_REQUIRED/);
    else if (mode === 'cancel') assert.match(run().reason, /cancelled/);
    else assert.equal(run().track_id, 'alternate');
  }
});

test('album recovery stops after cancellation during search or hydration', () => {
  for (const stage of ['search', 'hydration']) {
    const c = runtime();
    sources(c, () => []);
    let cancelled = false;
    let searches = 0;
    let hydrated = 0;
    c.utils.isDownloadCancelled = () => cancelled;
    c.searchAlbumsViaAPI = () => {
      searches++;
      cancelled = stage === 'search';
      return [{ id: 'first' }, { id: 'second' }];
    };
    c.fetchAlbumRaw = id => {
      hydrated++;
      cancelled = true;
      return { id, tracks: { items: [track('1')] } };
    };
    const result = c.checkAvailability('USAAA0000001', 'Signal', 'Artist', {
      duration_ms: 180000, track: { album_name: 'Collection' },
    });
    assert.match(result.reason, /cancelled/);
    assert.equal(searches, 1);
    assert.equal(hydrated, stage === 'search' ? 0 : 1);
  }
});
