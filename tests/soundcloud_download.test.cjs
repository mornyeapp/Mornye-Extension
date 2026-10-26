const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/soundcloud');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const stream = 'https://playback.media-streaming.soundcloud.cloud/track/aac_160k/playlist.m3u8?token=signed';
const mediaPlaylist = '#EXTM3U\n#EXTINF:3,\npart1.aac\n#EXTINF:3,\npart2.aac\n#EXT-X-ENDLIST';
const transcoding = (extra = {}) => ({
  url: 'https://api-v2.soundcloud.com/media/track/aac/hls',
  preset: 'aac_160k', quality: 'sq', snipped: false,
  format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
  ...extra,
});
const track = (transcodings = [transcoding()], extra = {}) => ({
  id: 123456, access: 'playable', streamable: true, duration: 6000,
  track_authorization: 'auth+/=', media: { transcodings }, ...extra,
});
// The app's URL object exposes a read-only query and a fixed href.
// Mutations are supported by a separate URLSearchParams instance only.
class RuntimeURL {
  constructor(input, base) {
    const parsed = new URL(input, base);
    for (const key of ['href', 'protocol', 'host', 'hostname', 'pathname', 'search', 'hash']) {
      this[key] = parsed[key];
    }
    this.searchParams = Object.fromEntries(['get', 'getAll', 'has', 'toString'].map(
      key => [key, parsed.searchParams[key].bind(parsed.searchParams)],
    ));
    this.toString = () => parsed.href;
  }
}
function runtime() {
  const calls = { requests: [], segments: [], downloads: [], conversions: [], deleted: [], progress: [] };
  const c = vm.createContext({
    URL: RuntimeURL, URLSearchParams, registerExtension() {}, log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {} },
    utils: { randomUserAgent: () => 'Test', isDownloadCancelled: () => false },
    http: { get(url) {
      calls.requests.push(url);
      return { statusCode: 200, body: url.includes('/media/') ? JSON.stringify({ url: stream }) : mediaPlaylist };
    } },
    file: {
      download(url, output, options) {
        calls.downloads.push({ url, output });
        options.onProgress?.(100, 100);
        return { success: true, path: output };
      },
      downloadSegments(segments, output, options) {
        calls.segments.push({ segments: JSON.parse(JSON.stringify(segments)), output, parallel: options.maxParallel });
        options.onProgress(0, 0, 1, segments.length);
        return { success: true, path: output };
      },
      delete(file) { calls.deleted.push(file); },
    },
    ffmpeg: { convert(input, output, options) {
      calls.conversions.push({ input, output, codec: options.codec });
      return { success: true };
    } },
  });
  vm.runInContext(source, c);
  c.state.clientId = 'c'.repeat(32);
  c.state.clientIdExpiry = Date.now() + 60000;
  return { c, calls };
}
const download = (c, data = track(), quality = 'aac_160', progress = () => {}) =>
  c.download(String(data.id), quality, '/music/folder.name/track.flac', progress, { preparedContext: { track: data } });

test('manifest enables segmented downloads and the modern CDN', () => {
  assert.equal(manifest.version, '1.0.12');
  assert.ok(manifest.requiredRuntimeFeatures.includes('downloadSegments@1'));
  assert.ok(manifest.permissions.network.includes('*.media-streaming.soundcloud.cloud'));
  assert.equal(manifest.qualityOptions[0].id, 'aac_160');
});

test('HLS-only tracks download ordered audio and remux to M4A without encoding', () => {
  const { c, calls } = runtime();
  const result = download(c, track(), 'aac_160', p => calls.progress.push(p));
  assert.equal(result.success, true);
  assert.equal(result.file_path, '/music/folder.name/track.m4a');
  assert.equal(calls.downloads.length, 0, 'never save a playlist as audio');
  assert.deepEqual(calls.segments[0].segments.map(s => s.url), [
    new URL('part1.aac', stream).href, new URL('part2.aac', stream).href,
  ]);
  assert.equal(calls.segments[0].parallel, 4);
  assert.equal(calls.conversions[0].codec, 'copy');
  assert.equal(calls.conversions[0].input, result.file_path + '.sc-stream');
  assert.deepEqual(calls.deleted, [result.file_path + '.sc-stream']);
  assert.equal(calls.progress.at(-1), 1);
  const info = new URL(calls.requests[0]);
  assert.equal(info.searchParams.get('track_authorization'), 'auth+/=');
});

test('stream query uses the app URL contract and preserves existing parameters', () => {
  const { c, calls } = runtime();
  assert.equal(typeof new c.URL(stream).searchParams.set, 'undefined');
  const result = download(c, track([transcoding({ url: transcoding().url + '?existing=a%2Bb&client_id=old#fragment' })]));
  assert.equal(result.success, true);
  const request = new URL(calls.requests[0]);
  assert.equal(request.searchParams.get('existing'), 'a+b');
  assert.deepEqual(request.searchParams.getAll('client_id'), ['c'.repeat(32)]);
  assert.equal(request.searchParams.get('track_authorization'), 'auth+/=');
  assert.equal(request.hash, '#fragment');
});

test('saved MP3 preferences and missing quality migrate to available AAC', () => {
  for (const quality of ['mp3_128', undefined, '']) {
    const { c } = runtime();
    assert.match(download(c, track(), quality).file_path, /\.m4a$/);
  }
  const { c } = runtime();
  assert.equal(c.audioOutputPath('/music/folder.name/track', 'm4a'), '/music/folder.name/track.m4a');
});

test('legacy progressive MP3 remains supported with correct extension', () => {
  const { c, calls } = runtime();
  const legacy = transcoding({ preset: 'mp3_128', format: { protocol: 'progressive', mime_type: 'audio/mpeg' } });
  assert.match(download(c, track([legacy]), 'mp3_128').file_path, /\.mp3$/);
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.segments.length, 0);
  assert.equal(calls.conversions.length, 0);
});

test('AAC 160 is preferred over 96 and preview/protected streams are excluded', () => {
  const { c } = runtime();
  const low = transcoding({ preset: 'aac_96k' });
  const high = transcoding();
  const ranked = c.rankTranscodings([low, transcoding({ snipped: true }),
    transcoding({ format: { protocol: 'hls_aes', mime_type: 'audio/mp4' } }), high], 'aac');
  assert.deepEqual(Array.from(ranked, t => t.preset), ['aac_160k', 'aac_96k']);
});

test('blocked tracks and preview-only tracks never download', () => {
  for (const data of [track([], { access: 'preview' }), track([], { streamable: false }), track([transcoding({ snipped: true })])]) {
    const { c, calls } = runtime();
    assert.equal(download(c, data).success, false);
    assert.equal(calls.downloads.length + calls.segments.length, 0);
  }
});

test('prepared context initializes a client ID in a new runtime', () => {
  const { c, calls } = runtime();
  c.state.clientId = null;
  const get = c.http.get;
  c.http.get = url => url === 'https://soundcloud.com/'
    ? { statusCode: 200, body: '"client_id": "' + 'n'.repeat(32) + '"' } : get(url);
  assert.equal(download(c).success, true);
  assert.equal(new URL(calls.requests[0]).searchParams.get('client_id'), 'n'.repeat(32));
});

test('authorization is refreshed once on 401 or 403 without discarding track identity', () => {
  for (const statusCode of [401, 403]) {
    const { c } = runtime();
    const seen = [];
    c.http.get = url => {
      if (url.includes('/media/')) {
        seen.push(new URL(url));
        return seen.length === 1 ? { statusCode } : { statusCode: 200, body: JSON.stringify({ url: stream }) };
      }
      if (url === 'https://soundcloud.com/') return { statusCode: 200, body: 'client_id:"' + 'r'.repeat(32) + '"' };
      if (url.includes('/tracks/123456')) return { statusCode: 200, body: JSON.stringify(track(undefined, { track_authorization: 'fresh' })) };
      return { statusCode: 200, body: mediaPlaylist };
    };
    assert.equal(download(c).success, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1].searchParams.get('client_id'), 'r'.repeat(32));
    assert.equal(seen[1].searchParams.get('track_authorization'), 'fresh');
  }
});

test('unchanged SoundCloud build renews expired client cache', () => {
  const { c } = runtime();
  c.state.scVersion = '1234567890';
  c.state.clientIdExpiry = 0;
  c.http.get = () => ({ statusCode: 200, body: '__sc_version="1234567890"' });
  c.ensureClientId();
  assert.ok(c.state.clientIdExpiry > Date.now());
});

test('fallback tries another full transcoding after a failed endpoint', () => {
  const { c, calls } = runtime();
  const get = c.http.get;
  c.http.get = url => url.includes('/missing') ? { statusCode: 404 } : get(url);
  const result = download(c, track([transcoding({ url: 'https://api-v2.soundcloud.com/missing' }), transcoding({ preset: 'aac_96k' })]));
  assert.equal(result.success, true);
  assert.equal(calls.segments.length, 1);
});

test('master playlists, init maps and explicit/implicit byte ranges preserve order', () => {
  const { c } = runtime();
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=96000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nhigh.m3u8';
  const playlist = '#EXTM3U\n#EXT-X-MAP:URI="audio.mp4",BYTERANGE="100@0"\n#EXTINF:3,\n#EXT-X-BYTERANGE:200@100\naudio.mp4\n#EXTINF:3,\n#EXT-X-BYTERANGE:300\naudio.mp4\n#EXT-X-ENDLIST';
  const seen = [];
  c.http.get = url => { seen.push(url); return { statusCode: 200, body: url === stream ? master : playlist }; };
  const result = c.readHlsPlaylist(stream, 0);
  assert.match(seen[1], /high\.m3u8$/);
  assert.equal(result.duration, 6);
  assert.deepEqual(Array.from(result.segments, s => s.headers.Range), ['bytes=0-99', 'bytes=100-299', 'bytes=300-599']);
});

test('master playlists honor the default audio rendition', () => {
  const { c } = runtime();
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=NO,URI="other.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,DEFAULT=YES,URI="audio.m3u8"';
  const seen = [];
  c.http.get = url => { seen.push(url); return { statusCode: 200, body: url === stream ? master : mediaPlaylist }; };
  assert.equal(c.readHlsPlaylist(stream, 0).duration, 6);
  assert.match(seen[1], /audio\.m3u8$/);
});

test('invalid, live, encrypted, recursive and malformed range playlists fail explicitly', () => {
  for (const body of ['<html>error</html>', mediaPlaylist.replace('#EXT-X-ENDLIST', ''),
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n' + mediaPlaylist,
    '#EXTM3U\n#EXTINF:3,\n#EXT-X-BYTERANGE:100\na.aac\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=160000\nplaylist.m3u8']) {
    const { c } = runtime();
    c.http.get = () => ({ statusCode: 200, body });
    assert.throws(() => c.readHlsPlaylist(stream, 0), /playlist|range|Encrypted/i);
  }
});

test('short HLS playlists cannot silently pass as a full track', () => {
  const { c, calls } = runtime();
  const result = download(c, track(undefined, { duration: 180000 }));
  assert.equal(result.success, false);
  assert.match(result.error_message, /duration/);
  assert.equal(calls.segments.length, 0);
});

test('segment and remux failures clean up and never report completion', () => {
  for (const stage of ['segments', 'remux', 'throw']) {
    const { c, calls } = runtime();
    if (stage === 'segments') c.file.downloadSegments = () => ({ success: false, error: 'network failed' });
    else if (stage === 'remux') c.ffmpeg.convert = () => ({ success: false, error: 'remux failed' });
    else c.ffmpeg.convert = () => { throw new Error('remux failed'); };
    const result = download(c, track(), 'aac_160', p => calls.progress.push(p));
    assert.equal(result.success, false);
    assert.ok(calls.deleted.includes('/music/folder.name/track.m4a.sc-stream'));
    if (stage !== 'segments') assert.ok(calls.deleted.includes('/music/folder.name/track.m4a'));
    assert.equal(calls.progress.includes(1), false);
  }
});

test('cancellation halts fallback and removes downloaded segments', () => {
  const { c, calls } = runtime();
  let cancelled = false;
  c.utils.isDownloadCancelled = () => cancelled;
  c.file.downloadSegments = () => { cancelled = true; return { success: true }; };
  const result = download(c, track([transcoding(), transcoding({ preset: 'aac_96k' })]));
  assert.equal(result.error_type, 'cancelled');
  assert.equal(calls.requests.filter(url => url.includes('/media/')).length, 1);
  assert.equal(calls.conversions.length, 0);
  assert.equal(calls.deleted.length, 1);
});
