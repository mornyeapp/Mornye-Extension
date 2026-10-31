const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../sources/deezer/index.js'), 'utf8');
const SECRET = 'g4el58wc0zvf9na1';

// Same derivation as the extension: md5(id) halves xor the secret.
function keyFor(id) {
  const md5 = crypto.createHash('md5').update(String(id)).digest('hex');
  let out = '';
  for (let i = 0; i < 16; i++) out += ((md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ SECRET.charCodeAt(i)) & 0xff).toString(16).padStart(2, '0');
  return out;
}

function run(downloadURL) {
  const transforms = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: {
      md5: value => crypto.createHash('md5').update(value).digest('hex'),
      sha256: value => crypto.createHash('sha256').update(value).digest('hex'),
      randomUserAgent: () => 'test-agent',
    },
    session: { signedFetch(method, url) {
      if (url === '/tickets') return { statusCode: 200, body: JSON.stringify({ ticket_id: 't-1' }) };
      return { statusCode: 200, body: JSON.stringify({
        success: true, download_url: downloadURL, deezer_format: 'flac', requires_client_decryption: true,
      }) };
    } },
    file: {
      download: (url, out) => ({ success: true, path: out }),
      transformPatternedBlocks: (input, output, options) => { transforms.push(options); return { success: true, path: output }; },
      delete() { return true; },
    },
  });
  vm.runInContext(source, context, { filename: 'deezer/index.js' });
  const result = context.download('4092501481', 'FLAC', '/tmp/out.flac', null, { preparedContext: { track: { name: 'Ignition', artists: 'HAAi' } } });
  return { result, transforms };
}

test('decrypts with the key of the song entry named in the served media path', () => {
  const url = 'https://f-cdnt-stream.dzcdn.net/media/1/9/5/3/4/4096289531/534db84ee1e2f65d47cb94c5d0eaa8b5.flac?hdnea=exp=1~acl=*';
  const { result, transforms } = run(url);
  assert.equal(result.success, true);
  assert.equal(transforms.length, 1);
  assert.equal(transforms[0].key, keyFor('4096289531'));
  assert.notEqual(transforms[0].key, keyFor('4092501481'));
});

test('keeps the looked-up id when the media path names the same song', () => {
  const url = 'https://f-cdnt-stream.dzcdn.net/media/1/9/5/3/4/4092501481/534db84ee1e2f65d47cb94c5d0eaa8b5.flac?hdnea=x';
  const { transforms } = run(url);
  assert.equal(transforms[0].key, keyFor('4092501481'));
});

test('falls back to the looked-up id when the URL has no media path', () => {
  const { result, transforms } = run('https://example.invalid/stream/abc.flac');
  assert.equal(result.success, true);
  assert.equal(transforms[0].key, keyFor('4092501481'));
});
