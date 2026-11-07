const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ok = body => ({ statusCode: 200, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

function load(name, { get = () => ({ statusCode: 404, body: '' }), signedFetch = () => ({ statusCode: 500, body: '' }) } = {}) {
  const gets = [], signed = [];
  let tickets = 0;
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: {
      sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
      base64Decode: value => Buffer.from(value, 'base64').toString('utf8'),
      sleep() { return true; },
      isDownloadCancelled: () => false,
    },
    http: { get(url, headers) { gets.push({ url, headers }); return get(url, headers); } },
    session: { signedFetch(method, url, body, headers) {
      signed.push({ method, url, body, headers });
      if (url === '/tickets') return ok({ ticket_id: `ticket-${++tickets}` });
      return signedFetch({ method, url, body, headers });
    } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, `../sources/${name}/index.js`), 'utf8'), context);
  return { context, gets, signed: () => signed.filter(call => call.url !== '/tickets') };
}

function tidalFlac(quality) {
  return ok({ version: '2.0', data: {
    audioQuality: quality, bitDepth: quality === 'LOSSLESS' ? 16 : 24, sampleRate: quality === 'LOSSLESS' ? 44100 : 96000,
    manifest: Buffer.from(JSON.stringify({ urls: ['https://offline.invalid/audio.flac'], mimeType: 'audio/flac' })).toString('base64'),
  } });
}

test('tidal-web tries the custom hifi-api endpoint before the default API and keeps http', () => {
  const app = load('tidal-web', { get: () => tidalFlac('HI_RES_LOSSLESS') });
  app.context.initialize({ customEndpoint: ' http://192.168.1.20:8000/ ' });
  const info = app.context.fetchDownloadInfo('123456', 'HI_RES_LOSSLESS');
  assert.equal(info.resolvedQuality, 'HI_RES_LOSSLESS');
  assert.equal(info.mirrorBaseURL, 'http://192.168.1.20:8000');
  assert.deepEqual(app.gets.map(call => call.url), ['http://192.168.1.20:8000/track/?id=123456&quality=HI_RES_LOSSLESS']);
  assert.deepEqual(app.signed(), []);
});

test('tidal-web falls back to the default API when the custom endpoint fails', () => {
  const app = load('tidal-web', {
    get: () => ({ statusCode: 502, body: '' }),
    signedFetch: () => tidalFlac('HI_RES_LOSSLESS'),
  });
  app.context.initialize({ customEndpoint: 'https://hifi.example.test' });
  assert.equal(app.context.fetchDownloadInfo('123456', 'HI_RES_LOSSLESS').resolvedQuality, 'HI_RES_LOSSLESS');
  assert.equal(app.gets.length, 1);
  assert.equal(app.signed().length, 1);
});

test('tidal-web ignores an invalid endpoint and keeps the default order', () => {
  const app = load('tidal-web', { signedFetch: () => tidalFlac('HI_RES_LOSSLESS') });
  for (const value of ['', 'ftp://hifi.example.test', 'hifi.example.test']) {
    app.context.initialize({ customEndpoint: value });
    assert.equal(app.context.fetchDownloadInfo('123456', 'HI_RES_LOSSLESS').resolvedQuality, 'HI_RES_LOSSLESS');
  }
  assert.deepEqual(app.gets, []);
});

test('qobuz-web uses the custom qobuz-rest-api endpoint with the API key', () => {
  const app = load('qobuz-web', { get: () => ok({
    track_id: '420232043', quality: 'hi24', bit_depth: 24, sampling_rate: 48.0,
    url: 'https://streaming.qobuz.com/file?uid=1',
  }) });
  app.context.initialize({ customEndpoint: 'http://127.0.0.1:8000/', customEndpointApiKey: ' secret ' });
  const info = app.context.resolveDownloadInfo('420232043', 'HI_RES');
  assert.equal(info.provider, 'custom');
  assert.equal(info.directURL, 'https://streaming.qobuz.com/file?uid=1');
  assert.equal(info.sampleRate, 48000);
  assert.equal(app.gets[0].url, 'http://127.0.0.1:8000/download-url/420232043?quality=hi24');
  assert.equal(app.gets[0].headers['X-API-Key'], 'secret');
  assert.deepEqual(app.signed(), []);
});

test('qobuz-web falls back to the default provider and drops the custom one when cleared', () => {
  const app = load('qobuz-web', {
    get: () => ({ statusCode: 401, body: '{"detail":"bad key"}' }),
    signedFetch: () => ok({ url: 'https://streaming-qobuz-std.akamaized.net/file', bit_depth: 16, sampling_rate: 44.1 }),
  });
  app.context.initialize({ customEndpoint: 'https://qobuz.example.test' });
  assert.equal(app.context.resolveDownloadInfo('1', 'LOSSLESS').provider, 'zarz-v2');
  assert.equal(app.gets.length, 1);
  app.context.initialize({ customEndpoint: '' });
  assert.equal(app.context.resolveDownloadInfo('1', 'LOSSLESS').provider, 'zarz-v2');
  assert.equal(app.gets.length, 1);
});

function transferRuntime(name, failedTransfer) {
  const app = load(name, {
    get: () => name === 'tidal-web' ? tidalFlac('LOSSLESS') : ok({ url: 'https://offline.invalid/audio.flac' }),
    signedFetch: () => name === 'tidal-web' ? tidalFlac('LOSSLESS') : ok({ url: 'https://offline.invalid/default.flac' }),
  });
  app.context.initialize({ customEndpoint: 'https://custom.example.test' });
  const transfers = [], deleted = [];
  app.context.file = {
    exists() { return true; },
    delete(path) { deleted.push(path); },
    download(url, output) {
      transfers.push(url);
      return transfers.length === 1 ? failedTransfer : { success: true, path: output };
    },
  };
  app.context.gobackend = { getAudioQuality: () => ({ duration: 180, bitDepth: 16, sampleRate: 44100 }) };
  const track = { name: 'Signal', artists: 'Artist', duration_ms: 180000 };
  const preparedContext = name === 'tidal-web'
    ? { track_id: '123', raw_track: { id: '123', audioQuality: 'LOSSLESS' }, formatted_track: track }
    : { host_track: track };
  return { ...app, transfers, deleted,
    download: () => app.context.download('123', 'LOSSLESS', '/output/song.flac', () => {}, { preparedContext }),
  };
}

for (const name of ['tidal-web', 'qobuz-web']) {
  for (const error of ['HTTP 403', 'connection reset']) {
    test(`${name} uses the default provider after a custom stream fails: ${error}`, () => {
      const app = transferRuntime(name, { success: false, error });
      const result = app.download();
      assert.equal(result.success, true, result.error_message);
      assert.equal(app.transfers.length, 2);
      assert.equal(app.gets.length, 1, 'do not retry the failed custom endpoint at another tier');
      assert.equal(app.signed().length, 1);
      assert.ok(app.deleted.includes('/output/song.flac'));
    });
  }

  test(`${name} does not fall back after cancellation`, () => {
    const app = transferRuntime(name, { success: false, error: 'download cancelled', error_type: 'cancelled' });
    assert.equal(app.download().success, false);
    assert.equal(app.transfers.length, 1);
    assert.equal(app.signed().length, 0);
  });

  test(`${name} reports an unsuccessful default transfer instead of succeeding`, () => {
    const app = transferRuntime(name, { success: false, error: 'HTTP 403' });
    app.context.file.download = () => ({ success: false, error: 'HTTP 503' });
    assert.equal(app.download().success, false);
    assert.equal(app.gets.length, 1);
    assert.equal(app.signed().length, 1);
  });
}

test('tidal-web can refresh an expired default stream after rejecting the custom one', () => {
  const app = transferRuntime('tidal-web', { success: false, error: 'HTTP 403' });
  app.context.file.download = (url, output) => {
    app.transfers.push(url);
    if (app.transfers.length === 1) return { success: false, error: 'HTTP 403' };
    if (app.transfers.length === 2) return { success: false, error: 'expired', error_type: 'expired_stream' };
    return { success: true, path: output };
  };
  assert.equal(app.download().success, true);
  assert.equal(app.gets.length, 1);
  assert.equal(app.signed().length, 2);
  assert.equal(app.transfers.length, 3);
});
