const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { row, runtime } = require('./helpers/k_music.cjs');

const PROVIDER = 'bugs-music';

function similarPage(ids, extra = '') {
  const rows = ids.map((id) => row(PROVIDER, id, `Related ${id}`)).join('');
  return `<div class="innerContainer"><h1>함께 들으면 좋은 곡</h1><table class="list trackList">${rows}${extra}</table></div>`;
}

function similarRuntime(pages, search = () => '<html>검색 결과가 없습니다</html>') {
  return runtime(PROVIDER, (url) => {
    const similar = url.match(/\/track\/ajax\/similarTrack\?trackId=(\d+)&page=1&decorator=blank$/);
    if (similar) {
      const page = pages[similar[1]];
      return page === undefined ? { ok: false, status: 500, body: '' } : page;
    }
    if (url.includes('/search/track?q=')) return search(decodeURIComponent(url.split('q=')[1]));
    throw new Error(`Unexpected URL: ${url}`);
  });
}

function ids(list) {
  return Array.from(list, (track) => track.id);
}

function ownSeed(id) {
  return { id, name: `Seed ${id}`, artists: 'Artist One', provider_id: PROVIDER };
}

test('Bugs related: manifest declares the capability', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../sources', PROVIDER, 'manifest.json')));
  assert.equal(manifest.capabilities.relatedTracks, true);
  assert.ok(manifest.permissions.network.includes('music.bugs.co.kr'));
});

test('Bugs related: own seed ids are used directly and mapped like search results', () => {
  const r = similarRuntime({ 100: similarPage(['201', '202']) });
  const results = r.extension.getRelatedTracks([ownSeed('100')], { limit: 10 });
  assert.deepEqual(ids(results), ['201', '202']);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://music.bugs.co.kr/track/ajax/similarTrack?trackId=100&page=1&decorator=blank');
  const track = results[0];
  assert.equal(track.name, 'Related 201');
  assert.equal(track.artists, 'Artist One');
  assert.equal(track.album_name, 'Example Album');
  assert.equal(track.album_id, '70000');
  assert.equal(track.cover_url, 'https://image.bugsm.co.kr/album/images/1000/700/70000.jpg');
  assert.equal(track.provider_id, PROVIDER);
  assert.equal(track.duration_ms, 0);
});

test('Bugs related: a foreign seed is resolved by a title and artist search', () => {
  const search = () => `<html><table>${row(PROVIDER, '300', 'Other song')}${row(PROVIDER, '301', 'Example song')}</table></html>`;
  const r = similarRuntime({ 301: similarPage(['401', '301', '402']) }, search);
  const results = r.extension.getRelatedTracks([
    { id: 'abc', name: 'Example song', artists: 'Artist One', provider_id: 'other-provider' },
  ], {});
  assert.deepEqual(ids(results), ['401', '402']);
  assert.match(r.calls[0].url, /\/search\/track\?q=Example%20song%20Artist%20One$/);
  assert.match(r.calls[1].url, /trackId=301&/);
});

test('Bugs related: an unconfident search match is skipped without a related request', () => {
  const search = () => `<html><table>${row(PROVIDER, '300', 'Another title')}</table></html>`;
  const r = similarRuntime({}, search);
  const results = r.extension.getRelatedTracks([
    { name: 'Example song', artists: 'Artist One', provider_id: 'other-provider' },
  ], { limit: 5 });
  assert.deepEqual(ids(results), []);
  assert.equal(r.calls.length, 1);
});

test('Bugs related: results interleave seeds, dedupe, exclude seeds, and stop at the limit', () => {
  const r = similarRuntime({
    100: similarPage(['201', '200', '202', '203']),
    200: similarPage(['301', '201', '100', '302']),
  });
  const seeds = [ownSeed('100'), ownSeed('200')];
  assert.deepEqual(ids(r.extension.getRelatedTracks(seeds, { limit: 50 })), ['201', '301', '202', '203', '302']);
  assert.deepEqual(ids(r.extension.getRelatedTracks(seeds, { limit: 3 })), ['201', '301', '202']);
});

test('Bugs related: tracks sharing a seed ISRC are excluded', () => {
  const tagged = row(PROVIDER, '205', 'Same recording').replace('<td>', '<td><span isrc="KRA000000001"></span>');
  const r = similarRuntime({ 100: similarPage(['201'], tagged) });
  const results = r.extension.getRelatedTracks([
    Object.assign(ownSeed('100'), { isrc: 'kra000000001' }),
  ], { limit: 10 });
  assert.deepEqual(ids(results), ['201']);
});

test('Bugs related: at most five seeds are queried', () => {
  const pages = {};
  for (let id = 1; id <= 7; id++) pages[id] = similarPage([String(500 + id)]);
  const r = similarRuntime(pages);
  const seeds = Array.from({ length: 7 }, (_, i) => ownSeed(String(i + 1)));
  assert.equal(r.extension.getRelatedTracks(seeds, { limit: 50 }).length, 5);
  assert.equal(r.calls.length, 5);
});

test('Bugs related: an empty fragment returns no tracks', () => {
  const r = similarRuntime({ 100: '' });
  assert.deepEqual(ids(r.extension.getRelatedTracks([ownSeed('100')], {})), []);
  assert.deepEqual(ids(r.extension.getRelatedTracks([], {})), []);
});

test('Bugs related: a failing seed is skipped, and only total failure throws', () => {
  const r = similarRuntime({ 200: similarPage(['301']) });
  assert.deepEqual(ids(r.extension.getRelatedTracks([ownSeed('100'), ownSeed('200')], {})), ['301']);
  assert.throws(() => r.extension.getRelatedTracks([ownSeed('100')], {}), /Bugs HTTP error 500/);
});
