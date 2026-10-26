const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHmac } = require('node:crypto');

const root = path.join(__dirname, '../sources/spotify-web');
const source = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const page = '<script id="appServerConfig" type="text/plain">' +
  Buffer.from(JSON.stringify({ clientVersion: 'test-version' })).toString('base64') + '</script>';
const json = body => ({ statusCode: 200, headers: {}, body: JSON.stringify(body) });

function runtime({ cached, get, post, sleep = () => true } = {}) {
  const saved = new Map(cached ? [['client_state', JSON.stringify(cached)]] : []);
  const calls = { get: [], post: [] };
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    atob: value => Buffer.from(value, 'base64').toString('utf8'),
    storage: { get: key => saved.get(key), set: (key, value) => saved.set(key, value) },
    utils: {
      randomUserAgent: () => 'Test', sleep,
      hmacSHA1: (key, data) => Array.from(createHmac('sha1', Buffer.from(key)).update(Buffer.from(data)).digest()),
    },
    http: {
      get(url, headers) {
        calls.get.push({ url, headers });
        if (get) return get(url, headers, calls.get.length);
        return url.includes('/api/token')
          ? json({ accessToken: 'test-access', clientId: 'test-client', accessTokenExpirationTimestampMs: Date.now() + 3600000 })
          : { statusCode: 200, headers: {}, body: page };
      },
      post(url, body, headers) {
        calls.post.push({ url, body: JSON.parse(body), headers });
        return post ? post(url, body) : json({
          response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE',
          granted_token: { token: 'test-client-token', expires_after_seconds: 3600 },
        });
      },
    },
  });
  vm.runInContext(source, context);
  registered.initialize({});
  return { context, registered, calls, saved, state: () => JSON.parse(saved.get('client_state')) };
}

test('missing sp_t creates a stable anonymous device and still obtains a client token', () => {
  const { context, calls, state } = runtime();
  assert.equal(context.getClientToken(), 'test-client-token');
  const device = calls.post[0].body.client_data.js_sdk_data.device_id;
  assert.match(device, /^[a-f0-9]{32}$/);
  assert.equal(state().deviceID, device);
  assert.equal(state().cookies.sp_t, undefined, 'do not invent a server cookie');
  assert.equal(calls.get.length, 2, 'fetch the session and access token only once');

  const restarted = runtime({ cached: state() });
  assert.equal(restarted.context.getClientToken(), 'test-client-token');
  assert.equal(restarted.calls.post[0].body.client_data.js_sdk_data.device_id, device);
  assert.equal(restarted.calls.get.length, 0, 'reuse the saved session and unexpired access token');
});

test('server cookies take priority over generating a device identifier', () => {
  const { context, calls, state } = runtime({
    get: url => url.includes('/api/token')
      ? json({ accessToken: 'access', clientId: 'client' })
      : { statusCode: 200, headers: { 'Set-Cookie': ['other=value; Path=/', 'sp_t=server-device; Path=/'] }, body: page },
  });
  context.getClientToken();
  assert.equal(calls.post[0].body.client_data.js_sdk_data.device_id, 'server-device');
  assert.equal(state().deviceID, 'server-device');
});

test('public search reaches the catalog without sp_t or duplicate session requests', () => {
  const { registered, calls } = runtime({ post: url => url.includes('clienttoken')
    ? json({ response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: { token: 'test-client-token' } })
    : json({ data: { searchV2: { tracksV2: { items: [] } } } }),
  });
  assert.equal(registered.customSearch('example', { filter: 'tracks' }).length, 0);
  assert.equal(calls.get.length, 2);
  assert.equal(calls.post.length, 2);
  assert.equal(calls.post[1].headers['Client-Token'], 'test-client-token');
});

test('rejected catalog tokens refresh once without changing the fallback device', () => {
  let queries = 0;
  const { registered, calls } = runtime({ post: url => {
    if (url.includes('clienttoken')) return json({
      response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: { token: 'test-client-token' },
    });
    return ++queries === 1 ? { statusCode: 401 } : json({ data: { searchV2: {} } });
  } });
  assert.equal(registered.customSearch('example', { filter: 'tracks' }).length, 0);
  const devices = calls.post.filter(call => call.url.includes('clienttoken'))
    .map(call => call.body.client_data.js_sdk_data.device_id);
  assert.equal(devices.length, 2);
  assert.equal(devices[0], devices[1]);
  assert.equal(queries, 2);
  assert.equal(calls.get.length, 3);
});

test('cached sp_t restores a missing device identifier without another page request', () => {
  const { context, calls } = runtime({ cached: {
    clientVersion: 'version', clientID: 'client', accessToken: 'access', cookies: { sp_t: 'cached-device' },
  } });
  context.getClientToken();
  assert.equal(calls.get.length, 0);
  assert.equal(calls.post[0].body.client_data.js_sdk_data.device_id, 'cached-device');
});

test('session transport errors retain their cause and retry only once', () => {
  const { context, calls } = runtime({ get: () => ({ error: 'client error (Connect): connection timeout' }) });
  assert.throws(() => context.getClientToken(), /Failed to get session info: client error \(Connect\): connection timeout/);
  assert.equal(calls.get.length, 2);
  assert.equal(calls.post.length, 0);
});

test('a transient session page failure recovers on the bounded retry', () => {
  const { context, calls } = runtime({ get: (url, headers, count) => {
    if (count === 1) return { error: 'connection reset' };
    return url.includes('/api/token') ? json({ accessToken: 'access', clientId: 'client' })
      : { statusCode: 200, headers: {}, body: page };
  } });
  assert.equal(context.getClientToken(), 'test-client-token');
  assert.equal(calls.get.length, 3);
});

test('access and client token requests recover once from transport errors', () => {
  let accessAttempts = 0;
  let clientAttempts = 0;
  const { context } = runtime({
    get: url => url.includes('/api/token')
      ? (++accessAttempts === 1 ? { error: 'connection timeout' } : json({ accessToken: 'access', clientId: 'client' }))
      : { statusCode: 200, headers: {}, body: page },
    post: () => ++clientAttempts === 1 ? { error: 'connection reset' }
      : json({ response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: { token: 'test-client-token' } }),
  });
  assert.equal(context.getClientToken(), 'test-client-token');
  assert.equal(accessAttempts, 2);
  assert.equal(clientAttempts, 2);
});

for (const response of [{ statusCode: 403 }, { statusCode: 429 }, { error: 'request cancelled' },
  { error: 'network access denied' }, { error: 'invalid certificate' }]) {
  test(`permanent session rejection does not retry: ${JSON.stringify(response)}`, () => {
    const { context, calls } = runtime({ get: () => response });
    assert.throws(() => context.getClientToken(), /Failed to get session info/);
    assert.equal(calls.get.length, 1);
  });
}

test('cancellation during retry delay stops before another request', () => {
  const { context, calls } = runtime({ get: () => ({ error: 'connection timeout' }), sleep: () => false });
  assert.throws(() => context.getClientToken(), /request cancelled/);
  assert.equal(calls.get.length, 1);
});

test('an invalid session page fails clearly instead of manufacturing a client version', () => {
  const { context, calls } = runtime({ get: () => ({ statusCode: 200, headers: {}, body: '<html>Unavailable</html>' }) });
  assert.throws(() => context.getClientToken(), /session page did not include a client version/);
  assert.equal(calls.post.length, 0);
});

test('invalid token responses cannot mark the session initialized', () => {
  for (const kind of ['access', 'client']) {
    const { context, state } = runtime({
      get: url => url.includes('/api/token') ? json({}) : { statusCode: 200, headers: {}, body: page },
      ...(kind === 'client' ? {
        cached: { clientVersion: 'version', clientID: 'client', accessToken: 'access', deviceID: 'device' },
        post: () => json({ response_type: 'RESPONSE_GRANTED_TOKEN_RESPONSE', granted_token: {} }),
      } : {}),
    });
    assert.throws(() => context.getClientToken(), /token response is incomplete/);
    assert.notEqual(state()?.initialized, true);
  }
});
