const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../sources/amazon/index.js'), 'utf8');
const ok = body => ({ statusCode: 200, body: JSON.stringify(body) });
const KEY = '0123456789abcdef0123456789abcdef';

const customStream = (codecs = 'flac') => ok({ success: true, operation: 'select_stream', request_id: 'r', data: {
  requested_quality: 'Max',
  stream: {
    base_url: 'https://offline.invalid/custom.mp4', codecs, pssh: 'AAAApssh',
    audio_sampling_rate: 192000, bit_depth: 24, segments: [],
  },
} });
const customKey = key => ok({ success: true, operation: 'widevine_key', request_id: 'r', data: { key } });
const zarzAudio = ok({ audio: { url: 'https://offline.invalid/zarz.flac', codec: 'flac', bitDepth: 16, sampleRate: 44100 } });

function load({ get, post, signed = () => zarzAudio, transfer } = {}) {
  const gets = [], posts = [], signedCalls = [], transfers = [];
  let extension;
  const context = vm.createContext({
    URL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: {
      sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
      sleep() { return true; },
      isDownloadCancelled: () => false,
    },
    http: {
      get(url, headers) { gets.push({ url, headers }); return get ? get(url, headers) : { statusCode: 404, body: '' }; },
      post(url, body, headers) { posts.push({ url, body, headers }); return post ? post(url, body, headers) : { statusCode: 404, body: '' }; },
    },
    session: { signedFetch(method, url, body, headers) {
      if (url === '/tickets') return ok({ ticket_id: 'ticket' });
      signedCalls.push({ method, url, body, headers });
      return signed({ method, url, body, headers });
    } },
    file: { download(url, output) {
      transfers.push(url);
      return transfer ? transfer(url, output) : { success: true, path: output };
    } },
  });
  vm.runInContext(source, context, { filename: 'amazon/index.js' });
  return {
    context, gets, posts, signedCalls, transfers,
    init: settings => extension.initialize({ settings }),
    download: (quality = 'best') => extension.download('B000000001', quality, '/offline.flac', null, {
      preparedContext: { web_metadata: { title: 'Offline track' } },
    }),
  };
}

test('amazon uses the custom amazon-music endpoint with the Bearer token', () => {
  const app = load({ get: () => customStream(), post: () => customKey(KEY) });
  app.init({ customEndpoint: ' https://amz.example.test/ ', customEndpointApiKey: ' jwt ' });
  const result = app.download('best');
  assert.equal(result.success, true);
  assert.equal(result.decryption_key, KEY);
  assert.equal(result.decryption.strategy, 'ffmpeg.mov_key');
  assert.equal(result.bit_depth, 24);
  assert.equal(result.sample_rate, 192000);
  assert.equal(app.gets[0].url, 'https://amz.example.test/tracks/B000000001/streams/Max');
  assert.equal(app.gets[0].headers.Authorization, 'Bearer jwt');
  assert.equal(app.posts[0].url, 'https://amz.example.test/widevine/key');
  assert.deepEqual(JSON.parse(app.posts[0].body), { pssh: 'AAAApssh' });
  assert.deepEqual(app.transfers, ['https://offline.invalid/custom.mp4']);
  assert.equal(app.signedCalls.length, 0);
});

test('amazon maps qualities to the server selector names and reads kid:key', () => {
  for (const [quality, name, codecs, ext] of [
    ['opus', 'Normal', 'opus', '.m4a'], ['eac3', 'Atmos_EC-3', 'ec-3', '.m4a'], ['ac4', 'Atmos_AC-4', 'ac-4.02.01.01', '.mp4'],
  ]) {
    const app = load({ get: () => customStream(codecs), post: () => customKey('ffffffffffffffffffffffffffffffff:' + KEY.toUpperCase()) });
    app.init({ customEndpoint: 'https://amz.example.test' });
    const result = app.download(quality);
    assert.equal(app.gets[0].url, `https://amz.example.test/tracks/B000000001/streams/${name}`);
    assert.equal(app.gets[0].headers.Authorization, undefined);
    assert.equal(result.decryption_key, KEY);
    assert.equal(result.output_extension, ext);
  }
});

test('amazon falls back to the default API when the custom endpoint fails', () => {
  for (const [get, post] of [
    [() => ({ statusCode: 401, body: '' }), undefined],
    [() => customStream(), () => customKey('not-a-key')],
    [() => ok({ success: true, data: { requested_quality: 'Max', stream: null } }), undefined],
  ]) {
    const app = load({ get, post });
    app.init({ customEndpoint: 'https://amz.example.test' });
    const result = app.download();
    assert.equal(result.success, true);
    assert.equal(app.signedCalls.length, 1);
    assert.deepEqual(app.transfers, ['https://offline.invalid/zarz.flac']);
  }
});

test('amazon falls back to the default API when the custom transfer fails', () => {
  const app = load({
    get: () => customStream(), post: () => customKey(KEY),
    transfer: (url, output) => url.includes('custom') ? { success: false, error: 'HTTP 403' } : { success: true, path: output },
  });
  app.init({ customEndpoint: 'https://amz.example.test' });
  const result = app.download();
  assert.equal(result.success, true);
  assert.equal(result.decryption_key, '');
  assert.deepEqual(app.transfers, ['https://offline.invalid/custom.mp4', 'https://offline.invalid/zarz.flac']);
});

test('amazon ignores an invalid endpoint', () => {
  for (const value of ['', 'ftp://amz.example.test', 'amz.example.test']) {
    const app = load();
    app.init({ customEndpoint: value });
    assert.equal(app.download().success, true);
    assert.deepEqual(app.gets, []);
  }
});

test('amazon declares the custom endpoint settings', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../sources/amazon/manifest.json'), 'utf8'));
  const byKey = Object.fromEntries(manifest.settings.map(s => [s.key, s]));
  assert.equal(byKey.customEndpoint.grantsNetwork, true);
  assert.equal(byKey.customEndpointApiKey.secret, true);
});

test('HTTP custom endpoints are used only without a session token', () => {
  const app = load({ get: () => customStream(), post: () => customKey(KEY) });
  const endpoint = 'http://192.168.1.20:8000';
  app.init({ customEndpoint: endpoint, customEndpointApiKey: 'secret' });
  assert.equal(app.download().success, true);
  assert.equal(app.gets.length, 0);
  assert.equal(app.posts.length, 0);
  assert.equal(app.signedCalls.length, 1);
  assert.equal(app.signedCalls[0].headers.Authorization, undefined);
  app.init({ customEndpoint: endpoint });
  assert.equal(app.download().success, true);
  assert.equal(app.gets.length, 1);
  assert.equal(app.gets[0].headers.Authorization, undefined);
  assert.equal(app.posts[0].headers.Authorization, undefined);
});

test('AC-4 uses the default provider when the custom codec is stereo or unknown', () => {
  for (const codec of ['flac', '']) {
    const app = load({
      get: () => customStream(codec),
      signed: () => ok({ audio: { url: 'https://offline.invalid/atmos.mp4', codec: 'ac4' } }),
    });
    app.init({ customEndpoint: 'https://amz.example.test' });
    const result = app.download('ac4');
    assert.equal(result.audio_codec, 'ac4');
    assert.equal(app.signedCalls.length, 1);
    assert.equal(app.signedCalls[0].body.codec, 'ac4');
    assert.equal(app.posts.length, 0);
    assert.deepEqual(app.transfers, ['https://offline.invalid/atmos.mp4']);
  }
});

test('AC-4 reports unavailable when neither provider confirms the codec', () => {
  for (const codec of ['flac', undefined]) {
    const app = load({
      get: () => customStream('flac'),
      signed: () => ok({ audio: { url: 'https://offline.invalid/default', codec } }),
    });
    app.init({ customEndpoint: 'https://amz.example.test' });
    assert.equal(app.download('ac4').error_type, 'not_found');
    assert.deepEqual(app.transfers, []);
  }
});

for (const reason of ['cancelled', 'timeout']) {
  test('custom requests stop on ' + reason + ' before and between network calls', () => {
    for (const stage of ['start', 'lookup', 'transfer']) {
      let stopped = stage === 'start';
      const app = load({
        get() { stopped = stage === 'lookup'; return customStream(); },
        post() { stopped = stage === 'transfer'; return customKey(KEY); },
      });
      app.init({ customEndpoint: 'https://amz.example.test' });
      app.context.utils.isDownloadCancelled = () => stopped && reason === 'cancelled';
      app.context.utils.getResolutionRemainingMs = () => stopped && reason === 'timeout' ? 0 : 1000;
      assert.equal(app.download().error_type, reason, stage);
      assert.equal(app.gets.length, stage === 'start' ? 0 : 1);
      assert.equal(app.posts.length, stage === 'transfer' ? 1 : 0);
      assert.equal(app.signedCalls.length, 0);
      assert.deepEqual(app.transfers, []);
    }
  });
}

test('a cancelled custom transfer keeps its error type and skips fallback', () => {
  const app = load({
    get: () => customStream(), post: () => customKey(KEY),
    transfer: () => ({ success: false, error: 'download cancelled', error_type: 'cancelled' }),
  });
  app.init({ customEndpoint: 'https://amz.example.test' });
  assert.equal(app.download().error_type, 'cancelled');
  assert.equal(app.signedCalls.length, 0);
  assert.equal(app.transfers.length, 1);
});
