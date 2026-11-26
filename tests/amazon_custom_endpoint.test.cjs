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
  app.init({ customEndpoint: ' http://192.168.1.20:8000/ ', customEndpointApiKey: ' jwt ' });
  const result = app.download('best');
  assert.equal(result.success, true);
  assert.equal(result.decryption_key, KEY);
  assert.equal(result.decryption.strategy, 'ffmpeg.mov_key');
  assert.equal(result.bit_depth, 24);
  assert.equal(result.sample_rate, 192000);
  assert.equal(app.gets[0].url, 'http://192.168.1.20:8000/tracks/B000000001/streams/Max');
  assert.equal(app.gets[0].headers.Authorization, 'Bearer jwt');
  assert.equal(app.posts[0].url, 'http://192.168.1.20:8000/widevine/key');
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
