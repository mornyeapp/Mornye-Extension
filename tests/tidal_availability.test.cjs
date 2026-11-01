const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../sources/tidal-web/index.js'), 'utf8');
const title = 'Bas Ek Kinng - Tiger Style Mix';
const artists = 'Pritam, Mika Singh, Neeraj Shridhar, Ashish Pandit, Hard Kaur & Mayur Puri';
const track = {
  id: '76216862', title: 'Bas Ek Kinng', version: 'Tiger Style Mix',
  artists: [{ name: 'Pritam' }, { name: 'Mika Singh' }],
  isrc: 'INT130800416', duration: 280,
};

function load(search) {
  const queries = [], fetched = [];
  const context = vm.createContext({
    registerExtension() {},
    log: { info() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false },
  });
  vm.runInContext(source, context);
  context.searchEndpoint = (kind, query) => {
    queries.push(query);
    return { items: search(query) };
  };
  context.fetchTrack = id => { fetched.push(id); return track; };
  context.fetchTrackCredits = () => [];
  return {
    context, queries, fetched,
    check: () => context.checkAvailability('INT130800416', title, artists, { duration_ms: 243000 }),
  };
}

test('empty full-credit search retries title and prepares the matching recording', () => {
  const app = load(query => query === title ? [track] : []);
  const result = app.check();
  assert.equal(result.available, true);
  assert.equal(result.track_id, track.id);
  assert.equal(result.prepared_context.formatted_track.isrc, track.isrc);
  assert.deepEqual(app.queries, [title + ' ' + artists, title]);
  assert.deepEqual(app.fetched, [track.id]);
});

test('unmatched results retry punctuation-normalized title without losing mix identity', () => {
  const wrongMix = { ...track, version: 'Club Mix', isrc: '', duration: 243 };
  const app = load(query => query === 'bas ek kinng tiger style mix' ? [track] : [wrongMix]);
  assert.equal(app.check().available, true);
  assert.deepEqual(app.queries, [title + ' ' + artists, title, 'bas ek kinng tiger style mix']);
});

test('successful first query needs no extra searches', () => {
  const app = load(() => [track]);
  assert.equal(app.check().available, true);
  assert.equal(app.queries.length, 1);
});

test('simplified queries cannot accept another mix, artist, or unsupported duration', () => {
  for (const candidate of [
    { ...track, version: 'Club Mix', isrc: '', duration: 243 },
    { ...track, artists: [{ name: 'Unrelated Singer' }], isrc: '', duration: 243 },
    { ...track, isrc: '', duration: 310 },
  ]) {
    const app = load(() => [candidate]);
    assert.equal(app.check().available, false);
    assert.equal(app.queries.length, 3);
    assert.deepEqual(app.fetched, []);
  }
});

test('search errors stop rather than issuing more requests', () => {
  const app = load(() => { throw new Error('HTTP 429'); });
  assert.equal(app.check().reason, 'HTTP 429');
  assert.equal(app.queries.length, 1);
});

test('cancellation between queries prevents further searches', () => {
  const app = load(() => {
    app.context.utils.isDownloadCancelled = () => true;
    return [];
  });
  assert.equal(app.check().reason, 'download cancelled');
  assert.equal(app.queries.length, 1);
});

test('identical fallback queries are not repeated', () => {
  const app = load(() => []);
  assert.equal(app.context.checkAvailability('', 'signal', '', {}).available, false);
  assert.deepEqual(app.queries, ['signal']);
});

test('Apple with credits do not hide the matching TIDAL recording from search', () => {
  const raw = {
    id: '76', title: 'Dovein Nain', artists: [{ name: 'Jenny Johal' }],
    isrc: 'UKC5K1600606', duration: 188,
  };
  const app = load(query => query === 'Dovein Nain Jenny Johal' ? [raw] : []);
  app.context.fetchTrack = () => raw;
  const result = app.context.checkAvailability(raw.isrc, 'Dovein Nain (with Jatinder Shah)', 'Jenny Johal', { duration_ms: 188000 });
  assert.equal(result.available, true);
  assert.equal(result.track_id, raw.id);
  assert.deepEqual(app.queries, [
    'Dovein Nain (with Jatinder Shah) Jenny Johal',
    'Dovein Nain (with Jatinder Shah)',
    'Dovein Nain Jenny Johal',
  ]);
});
