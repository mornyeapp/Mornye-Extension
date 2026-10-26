const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/soundcloud/index.js'), 'utf8');
const client = 'c'.repeat(32);
const json = body => ({ statusCode: 200, body: JSON.stringify(body) });

function runtime(get, { cached = false, sleep = () => true } = {}) {
  const calls = [];
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {} },
    utils: { randomUserAgent: () => 'Test', sleep },
    http: { get(url, headers) { calls.push(url); return get(url, headers, calls.length); } },
  });
  vm.runInContext(source, context);
  if (cached) {
    context.state.clientId = client;
    context.state.clientIdExpiry = Date.now() + 60000;
  }
  return { context, calls, registered };
}

test('unavailable bootstrap preserves the timeout and does not repeat for every search category', () => {
  const { registered, calls } = runtime(() => ({ error: 'client error (Connect): connection timeout' }));
  assert.throws(() => registered.customSearch('example', {}), /Failed to fetch soundcloud.com: client error \(Connect\): connection timeout/);
  assert.equal(calls.length, 2);
});

test('transient bootstrap failure recovers on retry and an empty search stays a success', () => {
  const { registered, calls } = runtime((url, headers, count) => {
    if (count === 1) throw new Error('connection reset');
    return url === 'https://soundcloud.com/'
      ? { statusCode: 200, body: 'client_id:"' + client + '"' } : json({ collection: [] });
  });
  assert.equal(registered.customSearch('example', {}).length, 0);
  assert.equal(calls.filter(url => url === 'https://soundcloud.com/').length, 2);
  assert.equal(calls.length, 6);
});

test('all failed search categories propagate an error instead of reporting no matches', () => {
  const { registered, calls } = runtime(() => ({ error: 'connection timeout' }), { cached: true });
  assert.throws(() => registered.customSearch('example', {}), /SoundCloud API failed: connection timeout/);
  assert.equal(calls.length, 8);
});

test('one failed category preserves results from another category', () => {
  const { registered } = runtime(url => url.includes('/search/users') ? json({ collection: [
    { id: 42, username: 'Example artist', avatar_url: 'https://example.test/cover.jpg' },
  ] }) : { statusCode: 404 }, { cached: true });
  const result = registered.customSearch('example', {});
  assert.equal(result.length, 1);
  assert.equal(result[0].item_type, 'artist');
});

test('filtered search failure is not swallowed', () => {
  const { registered } = runtime(() => ({ statusCode: 503 }), { cached: true });
  assert.throws(() => registered.customSearch('example', { filter: 'tracks' }), /HTTP 503/);
});

for (const statusCode of [401, 403]) {
  test(`rejected client ID refreshes once before retrying search: ${statusCode}`, () => {
    let apiCalls = 0;
    const fresh = 'n'.repeat(32);
    const { registered, calls } = runtime(url => {
      if (url === 'https://soundcloud.com/') return { statusCode: 200, body: 'client_id:"' + fresh + '"' };
      return ++apiCalls === 1 ? { statusCode } : json({ collection: [] });
    }, { cached: true });
    assert.equal(registered.customSearch('example', { filter: 'tracks' }).length, 0);
    assert.equal(calls.length, 3);
    assert.equal(new URL(calls[0]).searchParams.get('client_id'), client);
    assert.equal(new URL(calls[2]).searchParams.get('client_id'), fresh);
  });
}

test('bundle connection failure retains the cause when no client ID is available', () => {
  const { registered } = runtime(url => url === 'https://soundcloud.com/'
    ? { statusCode: 200, body: '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>' }
    : { error: 'connection timeout' });
  assert.throws(() => registered.customSearch('example', {}), /Could not find SoundCloud client_id.*connection timeout/);
});

for (const response of [{ statusCode: 403 }, { statusCode: 429 }, { error: 'request cancelled' },
  { error: 'network access denied' }, { error: 'invalid certificate' }]) {
  test(`permanent bootstrap rejection does not retry: ${JSON.stringify(response)}`, () => {
    const { registered, calls } = runtime(() => response);
    assert.throws(() => registered.customSearch('example', {}), /Failed to fetch soundcloud.com/);
    assert.equal(calls.length, 1);
  });
}

test('cancellation during backoff stops bootstrap', () => {
  const { registered, calls } = runtime(() => ({ error: 'connection timeout' }), { sleep: () => false });
  assert.throws(() => registered.customSearch('example', {}), /request cancelled/);
  assert.equal(calls.length, 1);
});
