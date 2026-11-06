// Explicit, read-only service checks. Offline tests never invoke this script.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { providers, runtime } = require('../tests/helpers/k_music.cjs');

const homeOnly = process.argv.includes('--home');
const selected = process.argv.slice(2).filter((argument) => argument !== '--home');
if (!selected.length || selected.some((provider) => !providers.includes(provider))) {
  throw new Error('Specify bugs-music, melon-music, or genie-music');
}

const reports = [];
for (const provider of selected) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../sources', provider, 'manifest.json')));
  const started = Date.now();
  const calls = [];
  let instance;
  instance = runtime(provider, (url, headers) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !manifest.permissions.network.includes(target.hostname)) {
      throw new Error('Live check blocked an unapproved origin');
    }
    if (Date.now() - started > 60000) throw new Error('Live check time budget exhausted');
    const args = ['-q', '--silent', '--show-error', '--max-time', '12', '--proto', '=https',
      '--max-filesize', '6000000', '--user-agent', 'Mozilla/5.0'];
    for (const [key, value] of Object.entries(headers || {})) args.push('-H', `${key}: ${value}`);
    args.push('-w', '\n%{http_code}', url);
    const requestStarted = Date.now();
    const response = spawnSync('/usr/bin/curl', args, {
      encoding: 'utf8', maxBuffer: 6500000, timeout: 14000,
    });
    instance.advance(Date.now() - requestStarted);
    const output = response.stdout || '';
    const separator = output.lastIndexOf('\n');
    const status = Number(output.slice(separator + 1));
    calls.push({ path: target.pathname, status });
    return { ok: response.status === 0 && status >= 200 && status < 300,
      status, body: output.slice(0, separator) };
  });
  const checks = [];
  function check(operation, action) {
    try { checks.push({ operation, ...action() }); }
    catch (error) { checks.push({ operation, error: String(error.message || error) }); }
  }
  if (homeOnly) {
    check('home-feed', () => {
      const feed = instance.extension.getHomeFeed();
      return { sections: feed.sections.length,
        items: feed.sections.reduce((total, section) => total + section.items.length, 0) };
    });
    reports.push({ provider, elapsed_ms: Date.now() - started, checks, calls });
    continue;
  }
  let daily;
  check('daily-chart', () => {
    daily = instance.extension.getAlbum(provider === 'bugs-music' ? 'top100-day'
      : provider === 'melon-music' ? 'melon-top100-day' : 'genie-top200');
    return { count: daily.tracks.length };
  });
  if (daily && daily.tracks[0]) check('track-detail', () => {
    const track = instance.extension.getTrack(daily.tracks[0].id);
    return { hasTitle: !!track.name, hasArtist: !!track.artists, duration_ms: track.duration_ms };
  });
  check('search', () => ({ count: instance.extension.customSearch('IU', { limit: 2 }).length }));
  check('weekly-chart', () => {
    const weekly = instance.extension.getAlbum(provider === 'bugs-music' ? 'top100-week'
      : provider === 'melon-music' ? 'melon-top100-week' : 'genie-top200-week');
    return { count: weekly.tracks.length,
      sameAsDaily: daily && weekly.tracks.map((track) => track.id).join(',') === daily.tracks.map((track) => track.id).join(',') };
  });
  if (provider === 'bugs-music' || provider === 'genie-music') check('curated-playlist', () => {
    const items = provider === 'bugs-music' ? instance.c.musicPdAlbums() : instance.c.genieDjItems();
    if (!items.length) throw new Error('No curated playlist was found');
    const album = instance.extension.getAlbum(items[0].id);
    return { count: album.tracks.length, hasTitle: !!album.name };
  });
  reports.push({ provider, elapsed_ms: Date.now() - started, checks, calls });
}
process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
