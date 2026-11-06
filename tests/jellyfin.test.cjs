const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '../sources/jellyfin');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const SERVER = 'http://192.168.1.20:8096';
const TRACK = '0123456789abcdef0123456789abcdef';
const ok = body => ({ ok: true, status: 200, statusCode: 200, body: JSON.stringify(body) });

function runtime(settings, respond) {
  let extension;
  const requests = [], downloads = [], stored = {};
  const fallback = (method, url) => {
    if (url.endsWith('/Users/AuthenticateByName')) return ok({ AccessToken: 'user-token', User: { Id: 'user-1', Name: 'Listener' } });
    if (url.endsWith('/Users')) return ok([{ Id: 'user-2', Name: 'Listener' }]);
    if (url.includes('/Items?')) return ok({ Items: [{ Id: TRACK, Name: 'Song', Path: '/music/song.flac' }] });
    return { ok: false, status: 404, statusCode: 404, body: '' };
  };
  const request = method => (url, ...rest) => {
    requests.push({ method, url, rest });
    return (respond && respond(method, url)) || fallback(method, url);
  };
  const context = vm.createContext({
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { md5: value => crypto.createHash('md5').update(value).digest('hex') },
    gobackend: { sanitizeFilename: value => value },
    http: { get: request('GET'), post: request('POST') },
    storage: { get: () => null, set() {} },
    credentials: {
      get: key => stored[key],
      store(key, value) { stored[key] = value; },
      remove(key) { delete stored[key]; },
    },
    file: { download(url, output, options) { downloads.push({ url, output, options }); return { success: true, path: output }; } },
  });
  vm.runInContext(source, context, { filename: 'jellyfin/index.js' });
  extension.initialize({ server_url: SERVER, username: 'Listener', password: 'secret', ...settings });
  return { extension, requests, downloads, stored };
}

test('the manifest allows any self-hosted server and plain HTTP home servers', () => {
  assert.deepEqual(manifest.permissions.network, ['*']);
  assert.equal(manifest.permissions.allowHttp, true);
  assert.equal(manifest.minAppVersion, '5.3.0');
});

test('a password login caches the token and sends the password only to the server', () => {
  const app = runtime();
  assert.equal(app.extension.searchTracks('song', 5).length, 1);
  const login = app.requests.find(request => request.url.endsWith('/Users/AuthenticateByName'));
  assert.equal(login.method, 'POST');
  assert.equal(login.rest[0].Pw, 'secret');
  assert.equal(app.stored.session.token, 'user-token');
  assert.ok(app.requests.every(request => request.url.startsWith(SERVER)));
});

test('an API key skips the password login', () => {
  const app = runtime({ password: '', api_key: 'server-key' });
  app.extension.searchTracks('song', 5);
  assert.ok(app.requests.some(request => request.url.endsWith('/Users')));
  assert.ok(!app.requests.some(request => request.url.endsWith('/Users/AuthenticateByName')));
});

test('a download stays on the configured server and keeps the original extension', () => {
  const app = runtime();
  const result = app.extension.download(TRACK, 'ORIGINAL', '/music/out.m4a', null);
  assert.equal(result.success, true, result.error);
  assert.equal(app.downloads.length, 1);
  assert.ok(app.downloads[0].url.startsWith(`${SERVER}/Items/${TRACK}/Download`));
  assert.equal(app.downloads[0].options.headers['X-Emby-Token'], 'user-token');
  assert.equal(app.downloads[0].output, '/music/out.flac');
});

test('an expired token logs in again once', () => {
  let expired = true;
  const app = runtime({}, (method, url) => {
    if (expired && url.includes('/Items?')) {
      expired = false;
      return { ok: false, status: 401, statusCode: 401, body: '' };
    }
    return null;
  });
  assert.equal(app.extension.searchTracks('song', 5).length, 1);
  assert.equal(app.requests.filter(request => request.url.endsWith('/Users/AuthenticateByName')).length, 2);
});
