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
const SESSION = 'session';
const TRACK = 'https://tidal.com/v1/tracks/1';
const WEB_APP = 'https://desktop.tidal.com/';
const BUILT_IN = /webClientID: "([^"]+)"/.exec(source)[1];
const MOVED = { id: 'MovedClient12345', key: 'TW92ZWRDbGllbnRLZXlNb3ZlZENsaWVudEtleTEyMzQ=' };
const HOUR = 60 * 60 * 1000;
const found = { statusCode: 200, body: JSON.stringify({ items: [], totalNumberOfItems: 0 }) };
const userRequired = {
  statusCode: 401,
  body: JSON.stringify({ status: 401, subStatus: 6007, userMessage: 'A user is required for this endpoint' }),
};
const refused = { statusCode: 400, body: '{"error":"invalid_client"}' };
const granted = count => ({
  statusCode: 200,
  body: JSON.stringify({ access_token: 'access-' + count, expires_in: 14400 }),
});

// The web app as TIDAL serves it: a page of scripts, one of which declares
// the client. The name of the id is used again in another scope before it.
function webApp(client) {
  return {
    [WEB_APP]: '<script type="module" src="/assets/vendor-A1.js"></script>' +
      '<script type="module" crossorigin src="/assets/index-B2.js"></script>',
    [WEB_APP + 'assets/vendor-A1.js']: 'var lib=1;',
    [WEB_APP + 'assets/index-B2.js']: 'function q(){var pvt=`OtherScope123456`;return pvt}' +
      'var filler=`' + 'x'.repeat(400) + '`;' +
      'var fvt=`StageClient12345`,pvt=`' + client.id + '`,mvt=new Map([' +
      '[`PkceClient1234567890`,{authType:`PKCE`,env:`STAGE`}],' +
      '[pvt,{authType:`clientCredentials`,env:`PROD`,publicKey:`' + client.key + '`}],' +
      '[fvt,{authType:`clientCredentials`,env:`STAGE`,publicKey:`U3RhZ2VLZXlTdGFnZUtleVN0YWdlS2V5MTIzNDU2Nzg=`}]]);',
  };
}

// respond(credential, url) answers each request: the credential is a public
// token, or SESSION plus the number of the access token sent. calls lists
// them, grants the requests for an access token (grant(count, clientId)
// answers them), pages the requests to the web app in options.site.
function load(respond, settings = {}, options = {}) {
  const grant = options.grant || granted;
  const site = options.site || {};
  const store = options.store || new Map();
  const calls = [];
  const grants = [];
  const pages = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { randomUserAgent: () => 'Test', appUserAgent: () => 'Test' },
    storage: {
      get: (key, fallback) => (store.has(key) ? JSON.parse(store.get(key)) : fallback),
      set: (key, value) => store.set(key, JSON.stringify(value)) && true,
    },
    http: {
      get(url, headers) {
        if (url.startsWith(WEB_APP)) {
          pages.push(url);
          return url in site ? { statusCode: 200, body: site[url] } : { statusCode: 404, body: '' };
        }
        const bearer = /^Bearer access-(\d+)$/.exec(headers.Authorization || '');
        const credential = bearer ? SESSION + bearer[1] : headers['x-tidal-token'];
        calls.push(credential);
        return respond(credential, url);
      },
      post(url, body, headers) {
        const id = new URLSearchParams(body).get('client_id');
        grants.push({ url, body, id, type: headers['Content-Type'] });
        return grant(grants.length, id);
      },
    },
  });
  vm.runInContext(source, context, { filename: 'tidal-web/index.js' });
  context.initialize(settings);
  // The extension reads its own realm's clock, so that is the one moved on.
  const later = ms => vm.runInContext(`Date.now = (now => () => now() + ${ms})(Date.now)`, context);
  return { context, calls, grants, pages, store, later };
}

test('search asks with the signed-out web session, on one access token', () => {
  assert.ok(manifest.permissions.network.includes('auth.tidal.com'));
  const { context, calls, grants, pages } = load(credential => (credential.startsWith(SESSION) ? found : userRequired));
  assert.deepEqual(Array.from(context.searchEndpoint('tracks', 'example song', 5).items), []);
  context.searchEndpoint('albums', 'example album', 5);
  assert.deepEqual(calls, [SESSION + 1, SESSION + 1]);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].url, 'https://auth.tidal.com/v1/oauth2/token');
  assert.equal(grants[0].type, 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(grants[0].body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_id'), BUILT_IN);
  assert.ok(form.get('client_secret'));
  assert.deepEqual(pages, []);
});

test('an access token TIDAL no longer takes is renewed once', () => {
  const { context, calls, grants, pages } = load(credential => (credential === SESSION + 2 ? found : userRequired));
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(calls, [SESSION + 1, SESSION + 2]);
  assert.equal(grants.length, 2);
  assert.deepEqual(pages, []);
});

test('an access token is asked for again once it has run out', () => {
  const { context, grants, later } = load(() => found, {}, {
    grant: count => ({ statusCode: 200, body: JSON.stringify({ access_token: 'access-' + count, expires_in: 30 }) }),
  });
  context.searchEndpoint('tracks', 'first song', 5);
  context.searchEndpoint('tracks', 'second song', 5);
  assert.equal(grants.length, 1);
  later(61 * 1000);
  context.searchEndpoint('tracks', 'third song', 5);
  assert.equal(grants.length, 2);
});

test('the client is read from the script of the web app', () => {
  const { context } = load(() => found);
  const script = webApp(MOVED)[WEB_APP + 'assets/index-B2.js'];
  assert.deepEqual({ ...context.parseWebClient(script) }, MOVED);
  const literal = '[["' + MOVED.id + '",{env:"PROD",publicKey:"' + MOVED.key + '",authType:"clientCredentials"}]]';
  assert.deepEqual({ ...context.parseWebClient(literal) }, MOVED);
  assert.equal(context.parseWebClient('var a=`clientCredentials`;'), null);
  assert.equal(context.parseWebClient(''), null);
});

test('a client TIDAL refuses gives way to the one its web app uses now', () => {
  assert.ok(manifest.permissions.network.includes('desktop.tidal.com'));
  const options = {
    site: webApp(MOVED),
    grant: (count, id) => (id === MOVED.id ? granted(count) : refused),
  };
  const first = load(credential => (credential.startsWith(SESSION) ? found : userRequired), {}, options);
  first.context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(first.grants.map(grant => grant.id), [BUILT_IN, MOVED.id]);
  assert.equal(new URLSearchParams(first.grants[1].body).get('client_secret'), MOVED.key);
  assert.deepEqual(first.calls, [SESSION + 2]);
  // The page, then the app's own script ahead of the library listed first.
  assert.deepEqual(first.pages, [WEB_APP, WEB_APP + 'assets/index-B2.js']);

  // It is kept: the next start asks with it and does not read the app again.
  const next = load(credential => (credential.startsWith(SESSION) ? found : userRequired), {}, {
    ...options,
    store: first.store,
  });
  next.context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(next.grants.map(grant => grant.id), [MOVED.id]);
  assert.deepEqual(next.pages, []);
});

test('search refused with a new token asks with the client of the web app', () => {
  const tokens = [];
  const { context, calls, grants } = load(
    credential => (credential === SESSION + tokens.indexOf(MOVED.id) ? found : userRequired),
    {},
    {
      site: webApp(MOVED),
      grant: (count, id) => {
        tokens[count] = id;
        return granted(count);
      },
    },
  );
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(grants.map(grant => grant.id), [BUILT_IN, BUILT_IN, MOVED.id]);
  assert.deepEqual(calls, [SESSION + 1, SESSION + 2, SESSION + 3]);
});

test('the web app is read once per interval while nothing has changed', () => {
  const { context, pages, later } = load(() => userRequired, {}, {
    site: webApp({ id: BUILT_IN, key: /webClientKey: "([^"]+)"/.exec(source)[1] }),
  });
  assert.throws(() => context.searchEndpoint('tracks', 'first song', 5), /HTTP 401/);
  assert.throws(() => context.searchEndpoint('tracks', 'second song', 5), /HTTP 401/);
  assert.equal(pages.length, 2);
  later(5 * HOUR);
  assert.throws(() => context.searchEndpoint('tracks', 'third song', 5), /HTTP 401/);
  assert.equal(pages.length, 2);
  later(2 * HOUR);
  assert.throws(() => context.searchEndpoint('tracks', 'fourth song', 5), /HTTP 401/);
  assert.equal(pages.length, 4);
});

test('a client found but refused by TIDAL is not taken over', () => {
  const { context, grants, store } = load(() => found, {}, { site: webApp(MOVED), grant: () => refused });
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(grants.map(grant => grant.id), [BUILT_IN, MOVED.id]);
  assert.equal(JSON.parse(store.get('webClient')).id, BUILT_IN);
});

test('a web app that did not answer is read again after a short while', () => {
  const { context, pages, later } = load(() => found, {}, { grant: () => refused });
  context.searchEndpoint('tracks', 'first song', 5);
  context.searchEndpoint('tracks', 'second song', 5);
  assert.deepEqual(pages, [WEB_APP]);
  later(11 * 60 * 1000);
  context.searchEndpoint('tracks', 'third song', 5);
  assert.deepEqual(pages, [WEB_APP, WEB_APP]);
});

test('a saved client of an older built-in one is dropped', () => {
  const store = new Map([['webClient', JSON.stringify({ base: 'OlderBuiltIn1234', ...MOVED, lookedAt: 1 })]]);
  const { context, grants } = load(() => found, {}, { store });
  context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(grants.map(grant => grant.id), [BUILT_IN]);
});

test('without a web session search falls back to the public tokens', () => {
  const open = load(() => found, {}, { grant: () => refused });
  open.context.searchEndpoint('tracks', 'example song', 5);
  assert.deepEqual(open.calls, [CURRENT]);
  const closed = load(() => userRequired, {}, { grant: () => refused });
  assert.throws(() => closed.context.searchEndpoint('tracks', 'example song', 5), /HTTP 401/);
  assert.deepEqual(closed.calls, [CURRENT, CLOSED]);
});

test('other requests keep the public token and ask for no session', () => {
  const setting = manifest.settings.find(item => item.key === 'publicToken');
  assert.equal(setting.default, CURRENT);
  const { context, calls, grants, pages } = load(() => found);
  context.getJSON(TRACK);
  assert.deepEqual(calls, [CURRENT]);
  assert.equal(grants.length, 0);
  assert.deepEqual(pages, []);
});

test('a stored token TIDAL closed gives way to the next one, once', () => {
  const { context, calls } = load(token => (token === CLOSED ? userRequired : found), { publicToken: CLOSED });
  context.getJSON(TRACK);
  assert.deepEqual(calls, [CLOSED, CURRENT]);
  // The token that answered is kept: later requests do not ask the closed one.
  context.getJSON('https://tidal.com/v1/albums/1');
  assert.deepEqual(calls, [CLOSED, CURRENT, CURRENT]);
});

test('a token of the user is tried first and the known ones after it', () => {
  const { context, calls } = load(token => (token === 'OwnToken' ? userRequired : found), { publicToken: 'OwnToken' });
  context.getJSON(TRACK);
  assert.deepEqual(calls, ['OwnToken', CURRENT]);
});

test('an endpoint that closes for every token moves to the web session', () => {
  const { context, calls } = load(credential => (credential.startsWith(SESSION) ? found : userRequired));
  context.getJSON(TRACK);
  assert.deepEqual(calls, [CURRENT, CLOSED, SESSION + 1]);
  // That kind of endpoint asks the session first from then on; others do not.
  context.getJSON('https://tidal.com/v1/tracks/2');
  assert.deepEqual(calls.slice(3), [SESSION + 1]);
});

test('every credential refused reports the 401', () => {
  const { context, calls } = load(() => userRequired);
  assert.throws(() => context.getJSON(TRACK), /HTTP 401/);
  assert.deepEqual(calls, [CURRENT, CLOSED, SESSION + 1, SESSION + 2]);
  assert.throws(() => context.searchEndpoint('tracks', 'example song', 5), /HTTP 401/);
});

test('an answer other than 401 is not asked again with another credential', () => {
  const { context, calls, pages } = load(() => ({ statusCode: 404, body: '{}' }));
  assert.throws(() => context.getJSON(TRACK), /HTTP 404/);
  assert.deepEqual(calls, [CURRENT]);
  assert.throws(() => context.searchEndpoint('tracks', 'example song', 5), /HTTP 404/);
  assert.deepEqual(calls, [CURRENT, SESSION + 1]);
  assert.deepEqual(pages, []);
});
