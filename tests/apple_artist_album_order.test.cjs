const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const context = vm.createContext({ registerExtension() {}, log: { info() {}, warn() {}, error() {}, debug() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sources/apple-music/index.js'), 'utf8'), context);
  return context;
}
const album = (id, releaseDate) => ({ id, attributes: { name: 'Album ' + id, releaseDate } });
const ids = list => list.map(item => item.id);

test('artist albums are listed newest first', () => {
  const context = load();
  const result = context.formatArtistAlbums([
    album('2005', '2005-03-01'), album('2024', '2024-10-18'), album('1999', '1999'), album('2015', '2015-06-30'),
  ], '1', { name: 'Artist' });
  assert.deepEqual(ids(result), ['2024', '2015', '2005', '1999']);
});

test('albums without a date come last and equal dates keep Apple order', () => {
  const context = load();
  const result = context.formatArtistAlbums([
    album('undated-a', undefined), album('b', '2020-01-01'), album('a', '2020-01-01'), album('new', '2023-05-05'), album('undated-b', ''),
  ], '1', { name: 'Artist' });
  assert.deepEqual(ids(result), ['new', 'b', 'a', 'undated-a', 'undated-b']);
});

test('sorting does not change the input list or the album fields', () => {
  const context = load();
  const input = [album('old', '2001-01-01'), album('new', '2022-02-02')];
  const result = context.formatArtistAlbums(input, '7', { name: 'Artist', url: 'https://music.apple.com/a' });
  assert.deepEqual(input.map(item => item.id), ['old', 'new']);
  assert.equal(result[0].release_date, '2022-02-02');
  assert.equal(result[0].artist_id, '7');
});
