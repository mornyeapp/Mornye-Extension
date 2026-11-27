const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/soundcloud/index.js'), 'utf8');
const json = body => ({ statusCode: 200, body: JSON.stringify(body) });
const album = id => ({ id, title: 'Example album ' + id, set_type: 'album', user: { id: 7, username: 'Example artist' } });
const albums = (from, count) => Array.from({ length: count }, (_, i) => album(from + i));

function runtime(get) {
  const calls = [];
  let registered;
  const context = vm.createContext({
    registerExtension(value) { registered = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    storage: { get() {}, set() {} },
    utils: { randomUserAgent: () => 'Test', sleep: () => true },
    matching: { compareStrings: () => 1, compareDuration: () => 1 },
    http: { get(url) { calls.push(new URL(url)); return get(new URL(url)); } },
  });
  vm.runInContext(source, context);
  context.state.clientId = 'c'.repeat(32);
  context.state.clientIdExpiry = Date.now() + 60000;
  return { calls, registered };
}

const pages = {
  '': { collection: albums(1, 50), next_href: 'https://api-v2.soundcloud.com/users/7/albums?offset=50&limit=50' },
  '50': { collection: albums(51, 33), next_href: null },
};

function artistApi(url) {
  if (url.pathname === '/users/7') return json({ id: 7, username: 'Example artist' });
  if (url.pathname === '/users/7/toptracks') return json({ collection: [] });
  if (url.pathname === '/users/7/albums') return json(pages[url.searchParams.get('offset') || '']);
  return { statusCode: 404, body: '{}' };
}

test('an artist with more than one page of albums offers the next page', () => {
  const { registered } = runtime(artistApi);
  const artist = registered.getArtist('7');
  assert.equal(artist.albums.length, 50);
  assert.equal(artist.albums_next, 'artist-albums:7:50');
});

test('the next page cursor loads the remaining albums and ends the list', () => {
  const { registered, calls } = runtime(artistApi);
  const page = registered.getArtist('artist-albums:7:50');
  assert.equal(page.albums.length, 33);
  assert.equal(page.albums[0].id, '51');
  assert.equal(page.albums_next, '');
  // A later page fetches only albums, not the profile again.
  assert.deepEqual(calls.map(url => url.pathname), ['/users/7/albums']);
  assert.equal(calls[0].searchParams.get('offset'), '50');
});

test('an opaque offset is passed back unchanged', () => {
  const offset = '2024-05-01T12%3A00%3A00.000Z%2Calbums%2C00123';
  const { registered, calls } = runtime(url => json({
    collection: albums(1, 2),
    next_href: 'https://api-v2.soundcloud.com/users/7/albums?offset=' + offset + '&limit=50',
  }));
  const page = registered.getArtist('artist-albums:7:' + offset);
  assert.equal(page.albums_next, 'artist-albums:7:' + offset);
  assert.match(calls[0].search, new RegExp('offset=' + offset + '(&|$)'));
});

test('an artist whose albums fit one page has no next page', () => {
  const { registered } = runtime(url => url.pathname === '/users/7/albums'
    ? json({ collection: albums(1, 3), next_href: null })
    : artistApi(url));
  const artist = registered.getArtist('7');
  assert.equal(artist.albums.length, 3);
  assert.equal(artist.albums_next, '');
});

test('a failed later page reaches the app so it can retry', () => {
  const { registered } = runtime(() => ({ statusCode: 500, body: '' }));
  assert.throws(() => registered.getArtist('artist-albums:7:50'));
});
