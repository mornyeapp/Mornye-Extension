const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/ytmusic-spotiflac/index.js'), 'utf8');

// The app URL exposes a read-only query; only URLSearchParams is mutable.
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
  let extension;
  const calls = { downloads: [], players: [], warnings: [] };
  const c = vm.createContext({
    URL: RuntimeURL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, error() {}, warn(...args) { calls.warnings.push(args); } },
    utils: { isDownloadCancelled: () => false, sleep() {} },
    storage: { get() {}, set() {} },
    file: {
      download(url, output) {
        calls.downloads.push({ url, output });
        return { success: true, path: output };
      },
    },
    fetch() { throw new Error('Unexpected network request'); },
  });
  vm.runInContext(source, c);
  return { c, calls, extension };
}

const audio = (itag, codec, extra = {}) => ({
  itag,
  mimeType: codec === 'opus' ? 'audio/webm; codecs="opus"' : 'audio/mp4; codecs="mp4a.40.2"',
  url: `https://media.example.test/audio?itag=${itag}`,
  bitrate: 128000,
  ...extra,
});

test('token query updates work with the app URL contract', () => {
  const { c } = runtime();
  const result = new URL(c.updateUrlQuery(
    'https://media.example.test/audio?existing=a%2Bb&pot=old#part',
    { pot: 'fresh_token', empty: '', absent: null },
  ));
  assert.equal(result.searchParams.get('pot'), 'fresh_token');
  assert.equal(result.searchParams.get('existing'), 'a+b');
  assert.equal(result.hash, '#part');
  assert.equal(result.searchParams.has('empty'), false);
});

test('cipher signatures and n challenges are written into the download URL', () => {
  const { c } = runtime();
  c.solveYouTubePlayerChallenge = () => ({ sig: 'solved+signature', n: 'new_n' });
  const cipher = new URLSearchParams({
    url: 'https://media.example.test/audio?keep=a%2Bb&n=old_n',
    s: 'encrypted', sp: 'sig',
  });
  const result = new URL(c.buildYouTubeFormatURL({ signatureCipher: cipher.toString() }, 'player'));
  assert.equal(result.searchParams.get('sig'), 'solved+signature');
  assert.equal(result.searchParams.get('n'), 'new_n');
  assert.equal(result.searchParams.get('keep'), 'a+b');
});

test('unsigned cipher URLs are not used after solving fails', () => {
  const { c } = runtime();
  c.solveYouTubePlayerChallenge = () => ({});
  const cipher = new URLSearchParams({ url: 'https://media.example.test/audio', s: 'encrypted' });
  assert.equal(c.buildYouTubeFormatURL({ signatureCipher: cipher.toString() }, 'player'), '');
});

test('a broken signature on the first format does not discard other Opus audio', () => {
  const { c } = runtime();
  const broken = audio(251, 'opus', { url: '', signatureCipher: 's=encrypted&url=https%3A%2F%2Fmedia.example.test%2Fbroken' });
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [broken, audio(250, 'opus'), audio(140, 'aac')] },
  }) });
  const result = c._tryInnerTubeClient('test-video', c.INNERTUBE_CLIENTS[0], {});
  assert.equal(result.itag, 250);
  assert.equal(result.extension, '.opus');
});

test('Opus from a later client wins over earlier AAC without downloading AAC', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'second' }];
  c._tryInnerTubeClient = (_, client) => {
    calls.players.push(client.name);
    const opus = client.name === 'second';
    return { clientName: client.name, itag: opus ? 251 : 140,
      extension: opus ? '.opus' : '.m4a', url: `https://media.example.test/${client.name}` };
  };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'opus');
  assert.deepEqual(calls.players, ['first', 'second']);
  assert.deepEqual(calls.downloads.map(d => d.output), ['/music/song.opus']);
});

test('failed Opus downloads can fall back to truthful AAC after trying all clients', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'second' }];
  c._tryInnerTubeClient = (_, client) => client.name === 'first'
    ? { clientName: 'first', itag: 251, extension: '.opus', url: 'https://media.example.test/opus' }
    : { clientName: 'second', itag: 140, extension: '.m4a', url: 'https://media.example.test/aac' };
  c.file.download = (url, output) => {
    calls.downloads.push({ url, output });
    return output.endsWith('.opus') ? { success: false, error: 'HTTP 403' } : { success: true, path: output };
  };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'aac');
  assert.equal(result.actual_extension, '.m4a');
  assert.deepEqual(calls.downloads.map(d => d.output), ['/music/song.opus', '/music/song.m4a']);
});

test('a single client retains AAC as fallback if its preferred Opus transfer fails', () => {
  const { c } = runtime();
  c.INNERTUBE_CLIENTS = [c.INNERTUBE_CLIENTS[0]];
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [audio(251, 'opus'), audio(140, 'aac')] },
  }) });
  c.file.download = (url, output) => output.endsWith('.opus')
    ? { success: false, error: 'HTTP 403' }
    : { success: true, path: output };
  const result = c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '');
  assert.equal(result.audio_codec, 'aac');
});

test('new direct clients replace the broken Android VR first choice', () => {
  const { c } = runtime();
  // The client that needs no player script and no ad wait is asked first.
  assert.equal(c.INNERTUBE_CLIENTS[0].name, 'visionos');
  assert.equal(c.INNERTUBE_CLIENTS[0].requiresJsPlayer, false);
  assert.equal(c.INNERTUBE_CLIENTS[1].name, 'tv_samsung');
  assert.equal(c.INNERTUBE_CLIENTS.find(client => client.name === 'web_embedded').requiresGvsPoToken, true);
  assert.ok(!c.INNERTUBE_CLIENTS.some(client => client.name === 'android_vr'));
});

// A cut-down player: one top-level statement per line, as YouTube ships it.
// `guarded`, `later` and the class only mention the marker; `wrong` has the
// plain statement but is no URL builder; `build` is the real one, and its
// body runs over two lines.
const PLAYER = [
  'var _yt_player={};(function(g){var window=this;var wrong,build,later;',
  'var Url=function(a){this.q={};this.raw=a};Url.prototype.set=function(k,v){this.q[k]=v};Url.prototype.get=function(k){return this.q[k]};Url.prototype.zz=function(){this.q.n=String(this.q.n).split("").reverse().join("")};',
  'g.guarded=function(a,b){var d=new Url(a);d.get("alr")||d.set("alr","yes");return d};',
  'wrong=function(a,b,c){a.set("alr","yes");return a};',
  'later=async function(a){var c=new Url(a);c.set("alr","yes");return c};',
  'build=function(a,b="",c=""){a=new Url(a);',
  'a.set("alr","yes");c&&a.set(b,encodeURIComponent(decodeURIComponent(c).toUpperCase()));return a};',
  'var Request=class{constructor(a){this.url=new Url(a);',
  'this.url.set("alr","yes")}};',
  '})(_yt_player);',
].join('\n');

test('every plain marker statement names a candidate, guarded and async ones do not', () => {
  const { c } = runtime();
  assert.deepEqual([...c.findYouTubeURLTransformFunctions(PLAYER)], ['wrong', 'build']);
});

test('the solver passes over a candidate that is not the URL builder', () => {
  const { c } = runtime();
  const solver = c.buildYouTubeChallengeSolver(PLAYER);
  assert.deepEqual({ ...solver('a+b/c', 'abc') }, { sig: 'A+B/C', n: 'cba' });
  assert.deepEqual({ ...solver('', 'xyz') }, { n: 'zyx' });
});

test('the player is always read in its plain build', () => {
  const { c } = runtime();
  for (const page of [
    '"jsUrl":"\\/s\\/player\\/ab12cd34\\/player_es6.vflset\\/id_ID\\/base.js"',
    '"PLAYER_JS_URL":"/s/player/ab12cd34/player_ias_tce.vflset/en_US/base.js"',
  ]) {
    assert.equal(c.extractYouTubePlayerURL(page),
      'https://www.youtube.com/s/player/ab12cd34/player_ias.vflset/en_US/base.js');
  }
});

const instream = ad => ({ instreamVideoAdRenderer: ad });

test('the ad before a song sets how long its media URLs stay refused', () => {
  const { c } = runtime();
  assert.equal(c.prerollWaitMs({}), 0);
  const start = renderer => ({ adPlacementRenderer: {
    config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } }, renderer,
  } });
  // A skippable ad counts until its skip button, another one by its length.
  assert.equal(c.prerollWaitMs({ adPlacements: [
    start(instream({ skipOffsetMilliseconds: 5000, playerVars: 'length_seconds=30' })),
    start(instream({ playerVars: 'a=1&length_seconds=15' })),
    { adPlacementRenderer: { config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_END' } },
      renderer: instream({ playerVars: 'length_seconds=60' }) } },
  ] }), 21000);
  const slot = renderingContent => ({ adSlotRenderer: {
    adSlotMetadata: { triggerEvent: 'SLOT_TRIGGER_EVENT_BEFORE_CONTENT' },
    fulfillmentContent: { fulfilledLayout: { playerBytesAdLayoutRenderer: { renderingContent } } },
  } });
  assert.equal(c.prerollWaitMs({ adSlots: [
    slot(instream({ skipOffsetMilliseconds: 2000 })),
    slot({ playerBytesSequentialLayoutRenderer: { sequentialLayouts: [
      { playerBytesAdLayoutRenderer: { renderingContent: instream({ playerVars: 'length_seconds=6' }) } },
    ] } }),
  ] }), 9000);
  // A long unskippable break does not hold a download for ever.
  assert.equal(c.prerollWaitMs({ adPlacements: [start(instream({ playerVars: 'length_seconds=600' }))] }),
    c.MAX_PREROLL_WAIT_MS);
});

test('a download starts only once the ad wait is over, and a cancel ends the wait', () => {
  const { c, calls } = runtime();
  let clock = 1000;
  let cancelAt = Infinity;
  c.now = () => clock;
  c.utils.sleep = ms => { clock += ms; return clock < cancelAt; };
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    adPlacements: [{ adPlacementRenderer: {
      config: { adPlacementConfig: { kind: 'AD_PLACEMENT_KIND_START' } },
      renderer: instream({ skipOffsetMilliseconds: 5000 }),
    } }],
    streamingData: { adaptiveFormats: [audio(251, 'opus')] },
  }) });
  c.INNERTUBE_CLIENTS = [c.INNERTUBE_CLIENTS[0]];
  c.file.download = (url, output) => {
    calls.downloads.push(clock);
    return { success: true, path: output };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
  assert.deepEqual(calls.downloads, [7000]);

  cancelAt = clock + 1000;
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', ''), null);
  assert.equal(calls.downloads.length, 1);
});

test('song links of every YouTube host and shape are read', () => {
  const { c } = runtime();
  for (const url of [
    'https://youtube.com/watch?v=abc123DEF_-&si=x',
    'https://m.youtube.com/watch?v=abc123DEF_-',
    'https://youtu.be/abc123DEF_-?si=x',
    'https://www.youtube.com/shorts/abc123DEF_-',
    'https://youtube.com/live/abc123DEF_-?feature=share',
  ]) {
    assert.equal(c.extractVideoId(url), 'abc123DEF_-', url);
  }
  assert.equal(c.extractVideoId('https://www.youtube.com/feed/library'), null);
  const patterns = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../sources/ytmusic-spotiflac/manifest.json'), 'utf8')).urlHandler.patterns;
  // No path limit: a playlist or a link without "www" has to reach the extension.
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']) {
    assert.ok(patterns.includes(host), host);
  }
});

test('video-only streams are never offered as Opus audio', () => {
  const { c } = runtime();
  const formats = [{ itag: 248, mimeType: 'video/webm; codecs="vp9"', url: 'https://media.example.test/video' }];
  assert.equal(c.chooseYouTubeFormat(formats, {}, false), null);
});

test('first working Opus skips the remaining client requests', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'first' }, { name: 'unused' }];
  c._tryInnerTubeClient = (_, client) => {
    calls.players.push(client.name);
    return { clientName: client.name, itag: 251, extension: '.opus', url: 'https://media.example.test/opus' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
  assert.deepEqual(calls.players, ['first']);
});

test('a client timeout does not skip a later working Opus source', () => {
  const { c } = runtime();
  c.INNERTUBE_CLIENTS = [{ name: 'timeout' }, { name: 'working' }];
  c._tryInnerTubeClient = (_, client) => {
    if (client.name === 'timeout') throw new Error('request timed out');
    return { clientName: client.name, itag: 251, extension: '.opus', url: 'https://media.example.test/opus' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
});

test('PO token refresh is inserted into the real media URL and can recover 403', () => {
  const { c, calls } = runtime();
  c.INNERTUBE_CLIENTS = [{ ...c.INNERTUBE_CLIENTS[0], requiresGvsPoToken: true }];
  c.getGvsPoToken = (_, __, ___, bypass) => bypass ? 'new_token' : 'old_token';
  c.fetch = () => ({ ok: true, json: () => ({
    playabilityStatus: { status: 'OK' },
    streamingData: { adaptiveFormats: [audio(251, 'opus')] },
  }) });
  c.file.download = (url, output) => {
    calls.downloads.push(url);
    return new URL(url).searchParams.get('pot') === 'new_token'
      ? { success: true, path: output } : { success: false, error: 'HTTP 403' };
  };
  assert.equal(c.tryInnerTubeDownloadsLazily('id', {}, '/music/song.flac', '', '').audio_codec, 'opus');
  assert.deepEqual(calls.downloads.map(url => new URL(url).searchParams.get('pot')), ['old_token', 'new_token']);
});

test('JS clients send the current player timestamp and share the player cache', () => {
  const { c } = runtime();
  let scripts = 0;
  let requests = 0;
  // The embedded client only offers audio with a token.
  c.getGvsPoToken = () => 'token';
  c.fetch = (url, options) => {
    if (url.endsWith('/base.js')) {
      scripts++;
      return { ok: true, text: () => 'var config={signatureTimestamp:20849};' };
    }
    requests++;
    assert.equal(JSON.parse(options.body).playbackContext.contentPlaybackContext.signatureTimestamp, 20849);
    return { ok: true, json: () => ({
      playabilityStatus: { status: 'OK' },
      streamingData: { adaptiveFormats: [audio(251, 'opus')] },
    }) };
  };
  const page = { playerUrl: 'https://www.youtube.com/s/player/example/base.js' };
  for (const client of c.INNERTUBE_CLIENTS.filter(client => client.requiresJsPlayer)) {
    assert.equal(c._tryInnerTubeClient('id', client, page).extension, '.opus');
  }
  assert.equal(scripts, 1);
  assert.equal(requests, 2);
});
