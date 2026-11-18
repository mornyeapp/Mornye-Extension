const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '../sources/tidal-web');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

const CURRENT = 'CzET4vdadNUFQ5JU';
const CLOSED = '49YxDN9a2aFV6RTG';
const found = { statusCode: 200, body: JSON.stringify({ items: [], totalNumberOfItems: 0 }) };
const userRequired = {
  statusCode: 401,
  body: JSON.stringify({ status: 401, subStatus: 6007, userMessage: 'A user is required for this endpoint' }),
};

// respond(token, url) answers each request; calls lists the token of each.
function load(respond, settings = {}) {
  const calls = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { randomUserAgent: () => 'Test', appUserAgent: () => 'Test' },
    http: {
      get(url, headers) {
        calls.push(headers['x-tidal-token']);
        return respond(headers['x-tidal-token'], url);
      },
    },
  });
  vm.runInContext(source, context, { filename: 'tidal-web/index.js' });
  context.initialize(settings);
  return { context, calls };
}

test('the default token is one TIDAL still lets search', () => {
  const setting = manifest.settings.find(item => item.key === 'publicToken');
  assert.equal(setting.default, CURRENT);
  const { context, calls } = load(() => found);
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(calls, [CURRENT]);
});

test('a stored token TIDAL closed for search gives way to the next one, once', () => {
  const { context, calls } = load(token => (token === CLOSED ? userRequired : found), { publicToken: CLOSED });
  assert.deepEqual(Array.from(context.searchEndpoint('tracks', 'example song', 5).items), []);
  assert.deepEqual(calls, [CLOSED, CURRENT]);
  // The token that answered is kept: later requests do not ask the closed one.
  context.searchEndpoint('albums', 'example album', 5);
  context.getJSON('https://tidal.com/v1/tracks/1');
  assert.deepEqual(calls, [CLOSED, CURRENT, CURRENT, CURRENT]);
});

test('a token of the user is tried first and the known ones after it', () => {
  const { context, calls } = load(token => (token === 'OwnToken' ? userRequired : found), { publicToken: 'OwnToken' });
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(calls, ['OwnToken', CURRENT]);
});

test('every token refused reports the 401', () => {
  const { context, calls } = load(() => userRequired);
  assert.throws(() => context.searchEndpoint('tracks', 'example song', 5), /HTTP 401/);
  assert.deepEqual(calls, [CURRENT, CLOSED]);
});

test('an answer other than 401 is not asked again with another token', () => {
  const { context, calls } = load(() => ({ statusCode: 404, body: '{}' }));
  assert.throws(() => context.getJSON('https://tidal.com/v1/tracks/1'), /HTTP 404/);
  assert.deepEqual(calls, [CURRENT]);
});
