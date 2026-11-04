const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '../sources/deezer');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));

function runtime({
  probe = { bitDepth: 24, sampleRate: 44100, codec: 'flac' }, noProbe = false,
  sourceFormat = 'FLAC_24', format = 'FLAC', encrypted = true, mediaTrack = '123',
  transformError = false, verification = false,
} = {}) {
  let extension;
  const calls = { sequence: [], deleted: [], md5: [], signed: [], transforms: [] };
  const descriptor = {
    success: true, download_url: 'https://media.test/audio', deezer_encrypted: encrypted,
    deezer_format: format, deezer_source_format: sourceFormat, deezer_track_id: mediaTrack,
  };
  const context = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: {
      appUserAgent: () => 'Mornye/Test', randomUserAgent: () => 'Test',
      sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
      md5(value) {
        calls.md5.push(value);
        return crypto.createHash('md5').update(value).digest('hex');
      },
    },
    session: {
      signedFetch(method, url, body, headers) {
        calls.signed.push({ method, url, body, headers });
        if (verification) return { error: 'VERIFY_REQUIRED', needsVerification: true };
        return {
          statusCode: 200,
          body: JSON.stringify(url === '/tickets' ? { ticket_id: 'test-ticket' } : descriptor),
        };
      },
    },
    file: {
      download(url, filePath) {
        calls.sequence.push('download');
        return { success: true, path: filePath };
      },
      transformPatternedBlocks(input, output, options) {
        calls.sequence.push('decrypt');
        calls.transforms.push(options);
        return transformError
          ? { success: false, error: 'test transform error' }
          : { success: true, path: output };
      },
      delete(filePath) { calls.deleted.push(filePath); },
    },
    gobackend: noProbe ? undefined : {
      getAudioQuality(filePath) {
        calls.sequence.push('probe');
        calls.probedPath = filePath;
        return typeof probe === 'function' ? probe(filePath) : probe;
      },
    },
  });
  vm.runInContext(source, context);
  function download() {
    return extension.download('deezer:123', 'flac', '/tmp/song.flac', () => {}, {
      preparedContext: { track: { name: 'Track', artists: 'Artist', audio_quality: '16bit/44.1kHz' } },
    });
  }
  return { extension, context, calls, descriptor, download };
}

test('manifest advertises variable Hi-Res quality and keeps the signed-session scope', () => {
  assert.equal(manifest.version, '1.3.10');
  assert.equal(manifest.qualityOptions[0].id, 'flac');
  assert.match(manifest.qualityOptions[0].label, /Hi-Res/);
  assert.match(manifest.qualityOptions[0].description, /up to 24-bit\/192 kHz/);
  assert.equal(manifest.signedSession.appVersion, 'deezer@1.3.5');
});

for (const [depth, rate, label] of [
  [24, 44100, '24bit/44.1kHz'], [24, 96000, '24bit/96kHz'],
  [24, 192000, '24bit/192kHz'], [16, 44100, '16bit/44.1kHz'], [16, 48000, '16bit/48kHz'],
]) {
  test(`download reports the measured ${depth}-bit/${rate} Hz file`, () => {
    const r = runtime({ probe: { bitDepth: depth, sampleRate: rate, codec: 'flac' } });
    const result = r.download();
    assert.equal(result.success, true);
    assert.equal(result.bit_depth, depth);
    assert.equal(result.sample_rate, rate);
    assert.equal(result.audio_quality, label);
    assert.equal(result.audio_codec, 'flac');
    assert.equal(result.actual_container, 'flac');
    assert.equal(result.file_path, '/tmp/song.flac');
    assert.deepEqual(r.calls.sequence, ['download', 'decrypt', 'probe']);
    assert.equal(r.calls.probedPath, result.file_path);
    assert.equal(r.calls.transforms[0].segmentSize, 2048);
    assert.equal(r.calls.transforms[0].transformEvery, 3);
    assert.equal(r.calls.transforms[0].iv, '0001020304050607');
  });
}

test('file measurements override a 24-bit hint when the file is 16-bit', () => {
  const result = runtime({
    sourceFormat: 'FLAC_24', probe: { bitDepth: 16, sampleRate: 44100, codec: 'flac' },
  }).download();
  assert.equal(result.bit_depth, 16);
  assert.equal(result.audio_quality, '16bit/44.1kHz');
});

test('older descriptors can still report 24-bit from the actual file', () => {
  const result = runtime({ sourceFormat: null }).download();
  assert.equal(result.bit_depth, 24);
  assert.equal(result.sample_rate, 44100);
});

test('a missing native probe preserves only known bit depth without inventing a sample rate', () => {
  const result = runtime({ noProbe: true }).download();
  assert.equal(result.success, true);
  assert.equal(result.bit_depth, 24);
  assert.equal(result.sample_rate, 0);
  assert.equal(result.audio_quality, '24-bit FLAC');
});

test('unknown source and probe errors never become a hardcoded 16-bit/44.1 result', () => {
  for (const probe of [{ error: 'probe unavailable' }, () => { throw new Error('unsupported runtime'); }]) {
    const result = runtime({ sourceFormat: null, probe }).download();
    assert.equal(result.success, true);
    assert.equal(result.bit_depth, 0);
    assert.equal(result.sample_rate, 0);
    assert.equal(result.audio_quality, 'FLAC');
  }
});

test('invalid probe values do not produce fictitious sampling rates', () => {
  const result = runtime({
    sourceFormat: null, probe: { bitDepth: 999, sampleRate: Infinity, codec: 'flac' },
  }).download();
  assert.equal(result.bit_depth, 0);
  assert.equal(result.sample_rate, 0);
});

test('the actual fallback track id is used for the unchanged file transform', () => {
  const r = runtime({ mediaTrack: '456' });
  assert.equal(r.download().success, true);
  assert.deepEqual(r.calls.md5, ['456']);
});

test('FLAC_24 is stored as .flac and MP3_320 as .mp3', () => {
  assert.equal(runtime({ format: 'FLAC_24' }).download().file_path, '/tmp/song.flac');
  const result = runtime({
    sourceFormat: 'MP3_320', format: 'MP3_320', probe: { bitDepth: 0, sampleRate: 44100, codec: 'mp3' },
  }).download();
  assert.equal(result.file_path, '/tmp/song.mp3');
  assert.equal(result.audio_codec, 'mp3');
  assert.equal(result.actual_container, 'mp3');
  assert.equal(result.bit_depth, 0);
});

test('already decrypted descriptors are probed without another transform', () => {
  const r = runtime({ encrypted: false });
  assert.equal(r.download().bit_depth, 24);
  assert.deepEqual(r.calls.sequence, ['download', 'probe']);
  assert.equal(r.calls.deleted.length, 0);
});

test('verification and decrypt failures do not probe a missing or encrypted file', () => {
  const verify = runtime({ verification: true });
  assert.equal(verify.download().error_type, 'verification_required');
  assert.equal(verify.calls.sequence.length, 0);
  const decrypt = runtime({ transformError: true });
  assert.equal(decrypt.download().error_type, 'decrypt_error');
  assert.equal(decrypt.calls.sequence.includes('probe'), false);
  assert.ok(decrypt.calls.deleted.length > 0);
});

test('catalog labels distinguish a 24-bit availability hint from an unknown resolution', () => {
  const r = runtime();
  const base = { id: 123, title: 'Track', artist: { id: 1, name: 'Artist' } };
  assert.equal(r.context.formatTrack(base, {}).audio_quality, 'FLAC');
  assert.equal(r.context.formatTrack(base, { gatewayTrack: { FILESIZE_FLAC_24: '1000' } }).audio_quality, '24-bit FLAC');
  assert.equal(r.calls.signed.length, 0);
  r.download();
  assert.equal(r.context.formatTrack(base, {}).audio_quality, '24bit/44.1kHz');
  r.extension.cleanup();
  assert.equal(r.context.formatTrack(base, {}).audio_quality, 'FLAC');
});
