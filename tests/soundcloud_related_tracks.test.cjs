const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/soundcloud/index.js'), 'utf8');
const json = body => ({ statusCode: 200, body: JSON.stringify(body) });
const ids = list => Array.from(list, item => item.id);

function track(id, extra = {}) {
  return {
    id, title: 'Example song ' + id, duration: 200000,
    user: { id: 7, username: 'Example artist' }, ...extra,
  };
}

function runtime(get) {
  const calls = [];
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {} },
    utils: { randomUserAgent: () => 'Test', sleep: () => true },
    matching: {
      compareStrings: (a, b) => String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0,
      compareDuration: () => 1,
    },
    http: { get(url, headers) { calls.push(url); return get(new URL(url), calls.length); } },
  });
  vm.runInContext(source, context);
  context.state.clientId = 'c'.repeat(32);
  context.state.clientIdExpiry = Date.now() + 60000;
  return { calls, registered };
}

const own = id => ({ id, name: 'Seed ' + id, artists: 'Example artist', provider_id: 'soundcloud' });

test('own seed id is used directly and results map like search', () => {
  const { registered, calls } = runtime(url => json({ collection: [track(11, {
    publisher_metadata: { isrc: 'XX0000000011', album_title: 'Example album' },
  })] }));
  const result = registered.getRelatedTracks([own('10')], {});
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.pathname, '/tracks/10/related');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '11');
  assert.equal(result[0].name, 'Example song 11');
  assert.equal(result[0].artists, 'Example artist');
  assert.equal(result[0].album_name, 'Example album');
  assert.equal(result[0].isrc, 'XX0000000011');
  assert.equal(result[0].provider_id, 'soundcloud');
});

test('foreign seed resolves by title and artist search before the related call', () => {
  const { registered, calls } = runtime(url => {
    if (url.pathname === '/search/tracks') {
      return json({ collection: [track(1, { title: 'Other', user: { username: 'Someone' } }),
        track(5, { title: 'Wanted song' })] });
    }
    return json({ collection: [track(5), track(6)] });
  });
  const result = registered.getRelatedTracks([{
    id: 'abc', name: 'Wanted song', artists: 'Example artist', provider_id: 'other-source',
  }], { limit: 10 });
  assert.equal(new URL(calls[0]).searchParams.get('q'), 'Wanted song Example artist');
  assert.equal(new URL(calls[1]).pathname, '/tracks/5/related');
  assert.deepEqual(ids(result), ['6']);
});

test('foreign seed without a confident match is skipped', () => {
  const { registered, calls } = runtime(() => json({ collection: [
    track(1, { title: 'Unrelated', user: { username: 'Someone' } }),
  ] }));
  const result = registered.getRelatedTracks([{
    name: 'Wanted song', artists: 'Example artist', provider_id: 'other-source',
  }], {});
  assert.equal(calls.length, 1);
  assert.equal(result.length, 0);
});

test('results interleave seeds, dedupe, exclude seeds and respect the limit', () => {
  const related = {
    '/tracks/10/related': [track(20), track(11), track(21, { publisher_metadata: { isrc: 'SEEDISRC' } }), track(22)],
    '/tracks/11/related': [track(30), track(20), track(10), track(31)],
  };
  const { registered } = runtime(url => json({ collection: related[url.pathname] }));
  const seeds = [own('10'), { ...own('11'), isrc: 'seedisrc' }];
  assert.deepEqual(ids(registered.getRelatedTracks(seeds, { limit: 50 })), ['20', '30', '22', '31']);
  assert.deepEqual(ids(registered.getRelatedTracks(seeds, { limit: 3 })), ['20', '30', '22']);
});

test('at most five seeds are queried', () => {
  const { registered, calls } = runtime(() => json({ collection: [] }));
  const seeds = Array.from({ length: 10 }, (_, index) => own(String(index + 1)));
  assert.equal(registered.getRelatedTracks(seeds, { limit: 99 }).length, 0);
  assert.equal(calls.length, 5);
  assert.equal(new URL(calls[0]).searchParams.get('limit'), '50');
});

test('one failed seed keeps results from another, all failures throw', () => {
  const partial = runtime(url => url.pathname === '/tracks/1/related'
    ? { statusCode: 503 } : json({ collection: [track(9)] }));
  assert.deepEqual(ids(partial.registered.getRelatedTracks([own('1'), own('2')], {})), ['9']);

  const failed = runtime(() => ({ statusCode: 503 }));
  assert.throws(() => failed.registered.getRelatedTracks([own('1')], {}), /HTTP 503/);
});
