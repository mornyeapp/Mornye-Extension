const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sources/beatport/index.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'sources/beatport/manifest.json')));
const raw = { id: '30759768', title: 'Zoolander', mix_name: 'Extended Mix', album_id: '7506773', album: 'Zoolander',
  artists: [{ id: '537125', name: 'Beave' }], available: true, duration_ms: 396614, isrc: 'GBLV62606472', bpm: 132, key: 'E Minor', camelot: '9A' };
function runtime(reply) {
  let extension; const calls = [], downloads = [], saved = {};
  const c = vm.createContext({ registerExtension(x) { extension = x; }, session: { signedFetch(method, route, body, headers) {
    calls.push({ method, route, body, headers });
    const data = reply ? reply({ method, route, body, headers }) : {};
    return data && (data.statusCode || data.needsVerification || data.error) ? data : { statusCode: 200, body: JSON.stringify(data) };
  }, completeGrant(...args) { return { success: true, args }; } },
  utils: { sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); } },
  storage: { get(k, f) { return saved[k] || f; }, set(k, v) { saved[k] = v; } },
  file: { download(url, dest, opts) { downloads.push({ url, dest, opts }); return { success: true, path: dest }; }, getSize() { return { success: true, size: 100 }; } } });
  vm.runInContext(source, c); return { extension, calls, downloads, c };
}
function result(q = 'lossless') { return { track: raw, requested_quality: q, fulfilled_quality: q, quality_changed: false, format: q === 'lossless' ? 'flac' : 'm4a',
 audio: { codec: q === 'lossless' ? 'flac' : 'aac', bit_depth: q === 'lossless' ? 16 : null, sample_rate: 44100 }, size: 100,
 download_url: 'https://api.zarz.moe/v2/media/btp/' + 'a'.repeat(48) + '?token=abc.def', expires_at: new Date(Date.now() + 3500000).toISOString() }; }
test('manifest uses Mornye 5.3 signed sessions and host callback; no credentials or direct provider networking', () => {
 assert.equal(manifest.minAppVersion, '5.3.0'); assert.equal(manifest.signedSession.appVersion, 'beatport@1.0.0');
 assert.equal(manifest.signedSession.callbackUrl, undefined); assert.deepEqual(manifest.qualityOptions.map(q => q.id), ['LOSSLESS', 'HIGH']);
 assert.ok(!manifest.permissions.network.includes('api.beatport.com')); assert.doesNotMatch(source, /Bearer |client_secret|access_token|refresh_token|@edugit/);
});
test('mixed search and filters preserve artwork and original mix identity with Unicode query encoding', () => {
 const r = runtime(() => ({ tracks: [raw], artists: [{ id: '537125', name: 'Beave', image: 'https://geo-media.beatport.com/a.jpg' }], releases: [{ id: '7506773', name: 'Release', artists: raw.artists }] }));
 const items = r.extension.customSearch('Béave & X', { limit: 20 }); assert.equal(items.length, 3);
 assert.equal(items[0].name, 'Zoolander (Extended Mix)'); assert.equal(items[1].item_type, 'artist'); assert.equal(items[2].item_type, 'album');
 assert.equal(r.calls[0].route, '/btp/catalog'); assert.equal(r.calls[0].body.q, 'Béave & X');
 r.extension.customSearch('Beave', { filter: 'artist', offset: 20, limit: 20 }); assert.equal(r.calls[1].body.type, 'artists'); assert.equal(r.calls[1].body.page, 2);
});
test('artist details, top tracks and opaque continuation retrieve the next release page', () => {
 const r = runtime(({ body }) => body.action === 'artist-releases' ? { releases: [{ id: '7506773', name: 'Release' }], has_more: true }
  : body.action === 'artist-tracks' ? { tracks: [raw] } : { id: '537125', name: 'Beave', image: 'https://geo-media.beatport.com/a.jpg' });
 const artist = r.extension.getArtist('beatport:537125'); assert.equal(artist.name, 'Beave'); assert.equal(artist.top_tracks.length, 1);
 assert.equal(artist.albums_next, 'artist-albums:537125:2'); r.extension.getArtist(artist.albums_next); assert.equal(r.calls.at(-1).body.page, 2);
});
test('URL handler rejects lookalikes and routes track, artist and release URLs', () => {
 const r = runtime(({ body }) => body.action === 'release' ? { id: '7506773', name: 'Zoolander', tracks: [raw] } : raw);
 assert.equal(r.extension.handleUrl('https://www.beatport.com/track/zoolander/30759768').track.isrc, raw.isrc);
 assert.equal(r.extension.handleUrl('https://www.beatport.com/release/zoolander/7506773').tracks.length, 1);
 for (const value of ['https://beatport.com.evil/track/x/1', 'https://user@beatport.com/track/x/1', 'http://beatport.com/track/x/1']) assert.throws(() => r.extension.handleUrl(value));
});
test('cross-provider matching requires ISRC or exact recording, mix, artist and duration', () => {
 const r = runtime(() => ({ tracks: [raw] }));
 assert.equal(r.extension.checkAvailability('GBLV62606472', 'Title', 'Artist').available, true);
 assert.equal(r.extension.checkAvailability('WRONG', 'Zoolander (Extended Mix)', 'Beave').available, false);
 assert.equal(r.extension.checkAvailability('', 'Zoolander (Radio Mix)', 'Beave').available, false);
 assert.equal(r.extension.checkAvailability('', 'Zoolander (Extended Mix)', 'Beave', { duration_ms: 1000 }).available, false);
});
for (const [label, q, ext] of [['LOSSLESS', 'lossless', '.flac'], ['HIGH', 'high', '.m4a']]) test(label + ' uses signed ticket, preserves codec, and resumes prepared file without another quota request', () => {
 const r = runtime(({ route }) => route === '/tickets' ? { ticket_id: 'ticket' } : result(q));
 const a = r.extension.download('beatport:30759768', label, '/tmp/test.flac', () => {});
 assert.equal(a.success, true); assert.equal(a.actual_extension, ext); assert.equal(a.audio_codec, q === 'lossless' ? 'flac' : 'aac');
 assert.equal(r.calls[0].body.resource_hash, crypto.createHash('sha256').update('beatport:track:30759768').digest('hex'));
 assert.equal(r.calls[1].headers['X-Zarz-Ticket'], 'ticket'); assert.equal(r.calls[1].body.allow_fallback, false);
 assert.equal(r.downloads[0].opts.resume, true); assert.ok(r.downloads[0].dest.endsWith(ext)); assert.equal(r.downloads[0].opts.headers['User-Agent'], 'Mornye/5.3.0');
 r.extension.download('30759768', label, '/tmp/test.flac', () => {}); assert.equal(r.calls.length, 2);
});
test('silent quality downgrade and foreign media origins fail before file transfer', () => {
 for (const mutate of [r => { r.fulfilled_quality = 'high'; }, r => { r.download_url = r.download_url.replace('api.zarz.moe', 'evil.example'); }]) {
  const data = result(); mutate(data); const r = runtime(({ route }) => route === '/tickets' ? { ticket_id: 'ticket' } : data);
  assert.equal(r.extension.download('30759768', 'LOSSLESS', '/tmp/t.flac').success, false); assert.equal(r.downloads.length, 0);
 }
});
test('verification is preserved as a native UI error and callback comes from the host app', () => {
 const r = runtime(() => ({ needsVerification: true, error: 'Verify' }));
 assert.throws(() => r.extension.customSearch('x'), /Verification required/);
 const d = r.extension.download('30759768', 'LOSSLESS', '/tmp/x.flac'); assert.equal(d.error_type, 'verification_required');
 assert.equal(r.extension.completeGrant().args.length, 0); assert.equal(r.extension.completeGrant('abc').args[0], 'abc');
});
test('truncated file does not get reported as a successful download', () => {
 const r = runtime(({ route }) => route === '/tickets' ? { ticket_id: 'ticket' } : result());
 r.c.file.getSize = () => ({ success: true, size: 99 }); assert.equal(r.extension.download('30759768', 'LOSSLESS', '/tmp/x.flac').success, false);
});

for (const status of [401, 403, 404, 410]) test('HTTP ' + status + ' refreshes the media capability once and caches the replacement', () => {
 let resolves = 0;
 const r = runtime(({ route }) => {
  if (route === '/tickets') return { ticket_id: 'ticket' };
  const data = result(); data.download_url = data.download_url.replace('abc.def', 'fresh.' + ++resolves); return data;
 });
 const urls = [];
 r.c.file.download = (url, dest) => {
  urls.push(url);
  return urls.length === 1 ? { success: false, error: 'HTTP ' + status, error_type: 'expired_stream', http_status: status }
   : { success: true, path: dest };
 };
 assert.equal(r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac').success, true);
 assert.equal(resolves, 2); assert.notEqual(urls[0], urls[1]);
 assert.equal(r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac').success, true);
 assert.equal(resolves, 2); assert.equal(urls[2], urls[1]);
});

test('repeated media rejection is bounded and clears persisted prepared state', () => {
 let resolves = 0;
 const r = runtime(({ route }) => { if (route === '/tickets') return { ticket_id: 'ticket' }; resolves++; return result(); });
 let transfers = 0;
 r.c.file.download = () => { transfers++; return { success: false, error: 'denied', error_type: 'http_error', http_status: 403 }; };
 assert.equal(r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac').success, false);
 assert.equal(transfers, 2); assert.equal(resolves, 2);
 r.extension.cleanup();
 r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac');
 assert.equal(resolves, 4, 'the rejected URL is not restored from storage');
});

for (const kind of ['transient_network', 'cancelled']) test(kind + ' retains the prepared file without another resolve', () => {
 const r = runtime(({ route }) => route === '/tickets' ? { ticket_id: 'ticket' } : result());
 let transfers = 0;
 r.c.file.download = () => { transfers++; return { success: false, error: kind, error_type: kind }; };
 assert.equal(r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac').error_type, kind);
 assert.equal(transfers, 1); assert.equal(r.calls.length, 2);
 r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac');
 assert.equal(transfers, 2); assert.equal(r.calls.length, 2);
});

test('signed request rate limiting preserves its retry classification and delay', () => {
 const r = runtime(() => ({ statusCode: 429, body: '{"code":"RATE_LIMITED","error":"try later"}', retryAfterSeconds: 12 }));
 const value = r.extension.download(raw.id, 'LOSSLESS', '/tmp/test.flac');
 assert.equal(value.error_type, 'rate_limited'); assert.equal(value.retry_after_seconds, 12);
 assert.equal(r.downloads.length, 0);
});

test('matching without an ISRC requires both known durations', () => {
 const candidate = { ...raw, isrc: '', duration_ms: 0 };
 const r = runtime(() => ({ tracks: [candidate] }));
 const title = 'Zoolander (Extended Mix)';
 assert.equal(r.extension.checkAvailability('', title, 'Beave', { duration_ms: raw.duration_ms }).available, false);
 candidate.duration_ms = raw.duration_ms;
 assert.equal(r.extension.checkAvailability('', title, 'Beave').available, false);
 assert.equal(r.extension.checkAvailability('', title, 'Beave', { duration_ms: raw.duration_ms }).available, true);
 candidate.isrc = raw.isrc; candidate.duration_ms = 0;
 assert.equal(r.extension.checkAvailability(raw.isrc, title, 'Beave').available, true);
});

test('Mornye 5.3.0 actual JavaScript host bridge and provider parsers preserve both download formats', () => {
 for (const q of ['lossless', 'high']) {
  const calls = [], files = [];
  const host = { networkEnabled: true, sessionEnabled: true, filesEnabled: true,
   logOpaqueType: () => '', providerTrim: s => String(s || '').trim(), providerInteger: n => String(Math.trunc(n)),
   appUserAgent: () => 'Mornye/5.3.0', sortKeys: keys => keys.sort(), quoteJSON: JSON.stringify, providerAudioTraits: () => [], sha256: s => crypto.createHash('sha256').update(s).digest('hex'),
   sessionCall(method, args) { const [verb, route, body] = JSON.parse(args); calls.push({ method, verb, route, body });
    return JSON.stringify({ statusCode: 200, body: JSON.stringify(route === '/tickets' ? { ticket_id: 'ticket' } : result(q)) }); },
   downloadCall(url, dest) { files.push(dest); return JSON.stringify({ success: true, path: dest }); },
   fileCall() { return { success: true, size: 100 }; }
  };
  const c = vm.createContext({});
  const prelude = vm.runInContext(fs.readFileSync(path.join(root, 'tests/fixtures/mornye-5.3.0/prelude.js'), 'utf8'), c)(host);
  const provider = vm.runInContext(fs.readFileSync(path.join(root, 'tests/fixtures/mornye-5.3.0/provider.js'), 'utf8'), c)(host, prelude.providerHelpers);
  vm.runInContext(source, c);
  const value = prelude.getExtension().download('30759768', q === 'lossless' ? 'LOSSLESS' : 'HIGH', '/tmp/Track.flac');
  assert.equal(value.success, true, JSON.stringify(value));
  const parsed = JSON.parse(provider.parse('download', value)).value;
  assert.equal(parsed.actual_extension, q === 'lossless' ? '.flac' : '.m4a');
  assert.equal(parsed.title, 'Zoolander (Extended Mix)'); assert.equal(parsed.artist, 'Beave'); assert.equal(parsed.album, 'Zoolander');
  assert.equal(JSON.parse(calls[1].body).quality, q);
 }
});
