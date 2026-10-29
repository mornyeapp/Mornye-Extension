const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../sources/amazon/index.js'), 'utf8');
function runtime() {
  let extension;
  const context = vm.createContext({
    URL, URLSearchParams,
    registerExtension(value) { extension = value; },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false, sleep: () => true },
  });
  vm.runInContext(code, context, { filename: 'amazon/index.js' });
  return { context, extension };
}
function row(id, qualities) {
  return {
    interface: 'Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.DescriptiveRowItemElement',
    primaryText: 'Song ' + id, secondaryText1: 'Artist',
    primaryTextLink: { deeplink: '/albums/B000000003?trackAsin=' + id },
    ...(qualities === undefined ? {} : { audioQualities: qualities }),
  };
}
test('Amazon track-specific audioQualities yields Tidal-compatible DOLBY_ATMOS mode', () => {
  const { context } = runtime();
  const track = context.formatAmazonTrackMetadata({
    id: 'B000000001', title: 'Track',
    audioQualities: ['HD', 'UHD', 'ATMOS'],
  }, null, 1);
  assert.equal(track.audio_modes, 'DOLBY_ATMOS');
  assert.equal(context.formatAmazonTrackMetadata({
    id: 'B000000002', title: 'Stereo', audioQualities: ['HD', 'UHD', '360RA'],
  }, null, 1).audio_modes, '');
});
test('Search and album rows do not inherit Atmos from adjacent tracks', () => {
  const { context } = runtime();
  const rows = [row('B000000001', ['ATMOS']), row('B000000002', ['HD'])];
  const parsed = context.parseDescriptiveRows({ methods: rows });
  assert.equal(parsed[0].audio_modes, 'DOLBY_ATMOS');
  assert.equal(parsed[1].audio_modes, '');
  const search = context.parseSearchResults({ methods: [
    { interface: 'Web.TemplatesInterface.v1_0.Touch.WidgetsInterface.VisualShovelerWidgetElement',
      primaryText: 'Songs', items: rows },
  ] }, 'songs');
  assert.equal(search.length, 2);
  assert.equal(search[0].audio_modes, 'DOLBY_ATMOS');
  assert.equal(search[1].audio_modes, '');
});
test('AC-4 codec / global download tier / unrelated album quality do not prove Atmos', () => {
  const { context } = runtime();
  for (const qualities of [['AC-4'], ['E-AC-3'], ['360RA'], ['UHD'], undefined]) {
    const track = { id: 'B000000003', title: 'Song', audioQualities: qualities,
      album: { audioQualities: ['ATMOS'] }, quality: 'ac4' };
    assert.equal(context.formatAmazonTrackMetadata(track, null, 1).audio_modes, '');
  }
  assert.equal(context.amazonTrackAudioModes({
    attributes: { audioQualities: ['ATMOS'] },
  }), 'DOLBY_ATMOS');
  assert.equal(context.amazonTrackAudioModes({
    metadata: { audio_modes: 'DOLBY ATMOS' },
  }), 'DOLBY_ATMOS');
});
test('Amazon recording details retain explicitly reported audio modes', () => {
  const { context } = runtime();
  const response = { methods: [row('B000000001', ['ATMOS']), row('B000000002', ['HD'])] };
  const a = context.parseTrackFromResponse(response, JSON.stringify(response), 'B000000001');
  const b = context.parseTrackFromResponse(response, JSON.stringify(response), 'B000000002');
  assert.equal(a.audio_modes, 'DOLBY_ATMOS');
  assert.equal(b.audio_modes, '');
});
test('explicit Amazon AC-4 requests never silently fall back to FLAC', () => {
  const { context, extension } = runtime();
  const requested = [];
  context.callZarzMedia = (_id, codec) => {
    requested.push(codec);
    if (codec === 'ac4') {
      throw Object.assign(new Error('Requested quality unavailable'),
        { code: 'QUALITY_UNAVAILABLE', retryable: false });
    }
    return { streamUrl: 'https://offline.invalid/audio.flac', codec: 'flac' };
  };
  const out = extension.download('B000000001', 'ac4', '/audio.mp4', null, {
    preparedContext: { web_metadata: { name: 'Song', id: 'B000000001' } },
  });
  assert.equal(out.success, false);
  assert.equal(out.error_type, 'not_found');
  assert.deepEqual(requested, ['ac4']);
});
