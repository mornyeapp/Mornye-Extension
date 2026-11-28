const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../sources/amazon/index.js'), 'utf8');
const ok = body => ({ statusCode: 200, body: JSON.stringify(body) });

function download(options, { bitDepth = 16, sampleRate = 44100 } = {}) {
  const transfers = [];
  let extension;
  const context = vm.createContext({
    URL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: {
      sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
      sleep: () => true, isDownloadCancelled: () => false,
    },
    http: { get: () => ({ statusCode: 404, body: '' }), post: () => ({ statusCode: 404, body: '' }) },
    session: { signedFetch(method, url) {
      if (url === '/tickets') return ok({ ticket_id: 'ticket' });
      return ok({ audio: { url: 'https://offline.invalid/zarz.flac', codec: 'flac', bitDepth, sampleRate } });
    } },
    file: { download(url, output) { transfers.push(url); return { success: true, path: output }; } },
  });
  vm.runInContext(source, context, { filename: 'amazon/index.js' });
  const result = extension.download('B000000001', 'best', '/offline.flac', null, {
    preparedContext: { web_metadata: { title: 'Offline track' } }, ...options,
  });
  return { result, transfers };
}

test('amazon skips a CD-quality stream in strict hi-res mode', () => {
  for (const requestedQuality of ['HI_RES_LOSSLESS', 'HI_RES']) {
    for (const sampleRate of [44100, 44.1]) {
      const { result, transfers } = download({ allowFallback: false, requestedQuality }, { sampleRate });
      assert.equal(result.success, false);
      assert.equal(result.error_type, 'quality_unavailable');
      assert.deepEqual(transfers, []);
    }
  }
});

test('amazon transfers CD quality when it was requested or is acceptable', () => {
  for (const options of [
    { allowFallback: false, requestedQuality: 'LOSSLESS' },
    { allowFallback: true, requestedQuality: 'HI_RES_LOSSLESS' },
    // A host that does not say which tier it asked for.
    { allowFallback: false },
    {},
  ]) {
    const { result, transfers } = download(options);
    assert.equal(result.success, true, JSON.stringify(options));
    assert.equal(transfers.length, 1);
  }
});

test('amazon transfers hi-res and unknown quality in strict hi-res mode', () => {
  for (const stream of [{ bitDepth: 24, sampleRate: 44100 }, { bitDepth: 0, sampleRate: 0 }]) {
    const { result, transfers } = download({ allowFallback: false, requestedQuality: 'HI_RES_LOSSLESS' }, stream);
    assert.equal(result.success, true, JSON.stringify(stream));
    assert.equal(transfers.length, 1);
  }
});
