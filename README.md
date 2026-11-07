# Mornye Extension Store

## Submit Your Extension

1. Fork this repository
2. Add your `.sflx` package to the `extensions/` folder
3. Add your icon image (PNG/JPG, 512x512 recommended) to `icons/` folder
4. Add entry to `registry.json`
   - Ensure `icon_url` points to the raw file in the repository (e.g. `https://raw.githubusercontent.com/mornyeapp/Mornye-Extension/main/icons/your-icon.png`)
5. Create Pull Request

## Requirements

- Extension must follow [Extension Development Guide](https://spotiflac.zarz.moe/docs)
- No malicious code
- Clear description of what extension does
- Working download URL and icon URL

## Developing the bundled providers

Spotify, Amazon, Apple Music, YouTube Music, SoundCloud, Tidal, Qobuz, Deezer, JioSaavn, Bugs Music,
Melon, Genie, Beatport, and Jellyfin have reviewable source in `sources/<provider>/` and
offline regression tests in `tests/`. Edit the source, bump its manifest
version, and run:

```sh
node --test tests/*.test.cjs
python3 scripts/build_packages.py
python3 scripts/build_packages.py --check
```

The tests use Node.js 22 or newer and mock provider responses; they do not
contact music services. The Python 3 script creates reproducible `.sflx`
archives and updates their versions and SHA-256 digests in `registry.json`.
Pass provider directory names to rebuild a subset, for example
`python3 scripts/build_packages.py amazon tidal-web`.

Commit source, tests, packages, and registry changes together. Other providers
remain package-only until their source is added to this layout.

`utilities.sflx` is for the Python version of Mornye (Mornye-Python) only. It
uses the Python runtime and provides the Spotify/Tidal metadata, browser solver,
and signed-session modules that Mornye-Python loads at startup. It stays in
`registry-python.json`; `registry.json` stays JavaScript-only so existing app
versions never offer an incompatible Python package. The Python package is
not built by `scripts/build_packages.py`.

`registry-unified.json` is an opt-in shared catalog generated from those two
registries. It marks Python packages with `"runtime": "python"`. Mornye-Python
can point `MORNYE_REGISTRIES` at its raw URL to use one catalog. Only Mornye app
versions containing [mornyeapp/Mornye#846](https://github.com/mornyeapp/Mornye/pull/846)
can safely use it, because they filter unsupported runtimes. Do not switch the
app's default registry until that support has reached its users.

Package builds also refresh the shared catalog. After manually updating a
package-only extension and its registry, run `python3 scripts/build_unified_registry.py`.
CI checks that the generated versions and checksums still match both inputs.

`tidal-web` and `qobuz-web` have an optional **Custom download endpoint**
setting. It is tried before the default download API, and the default API is
still used if it fails. `tidal-web` expects a server compatible with
[hifi-api](https://github.com/binimum/hifi-api) (`/track/?id=…&quality=…`).
`qobuz-web` expects one compatible with
[qobuz-rest-api](https://github.com/BartolomeoRusso9/qobuz-rest-api)
(`/download-url/{id}?quality=…`, with an optional `X-API-Key`). The setting
uses `"grantsNetwork": true`, so the app allows the host typed in it; a server
on a home network also needs Allow Local Network Access.

Signed-session providers omit `callbackUrl` so the host application supplies
its own session-grant callback. This lets Mornye and older host versions
return to the application that started verification. Package-only fixes keep
the gateway's `appVersion` unchanged to preserve its existing session scope.

Beatport requires Mornye 5.3.0 and the existing Beatport signed V2 gateway.
Its original FLAC and AAC downloads are prepared on that server. See
[`sources/beatport/README.md`](sources/beatport/README.md) for its runtime
requirements and the bundled host-contract fixture provenance.

Bugs Music, Melon, and Genie provide catalog metadata and URL imports. Their
enrichment reads their own track details; it does not call the deprecated
Songlink public API. Audio downloads and cross-service matching remain the
responsibility of the app's configured download providers. None of the three
services publishes ISRC codes, so matching relies on titles, artists, and
running times. Track and album lookups read running times from each service's
player or mobile metadata; search results and charts do not carry them.

### K-Music 2.0.7 review

The third-party 2.0.6 archive was reviewed before updating these providers.
Its SHA-256 is `8b629c145f44ad857fe7e48a661f7e09950d65b09354e8b8006bd1f6b1150c5c`.
The archive contains readable JavaScript, manifests, and the same PNG icons
already in this repository. No native executables, install scripts, dynamic
code loading, file access, or persistent storage are included.

The original submission fails 28 of the 97 existing provider regression tests.
The reviewed update retains running times, mobile imports, complete album
lists, source metadata, artwork fallbacks, and Bugs related tracks. It adds
period charts, Bugs Music PD albums, and Genie DJ playlist imports. Genie home
cards defer playlist and additional chart reads until opened.

The submission's automatic cross-service ISRC/link search is excluded: relaxed
artist-and-duration matching can select another recording and rewrite source
titles. Requests remain on the declared service domains, and rate limits are
not immediately retried. Source changes are rebuilt locally as `.sflx` packages
with matching registry digests, rather than distributing the original archives.

Run the offline checks and explicit read-only service checks separately:

```sh
node --test tests/k_music_*.test.cjs tests/bugs-music_related_tracks.test.cjs
node scripts/check_k_music_live.cjs bugs-music melon-music genie-music
node scripts/check_k_music_live.cjs --home bugs-music melon-music genie-music
```

Live checks never run as part of the offline tests. Cold home feeds took
approximately 19 to 21 seconds on the review connection; these pages make
multiple service requests and retain their existing five-minute cache.

The ZIP and upstream repository do not include a license. On 2026-11-06 the
Mornye maintainer confirmed that the author has granted redistribution
permission. Static review establishes the inspected code paths; it is not a
malware certification. The 114 K-Music regression tests pass, and live read-only
checks verified search, track running times, daily/weekly charts, Bugs Music PD
albums, and Genie DJ playlists. The locally rebuilt archives pass the package
reproducibility and registry checksum checks.

## Review Process

All submissions are reviewed before being added to the store.

## License

Copyright 2026 zarzet

This project is licensed under the [GNU Lesser General Public License v3.0 only (LGPL-3.0-only)](LICENSE), together with the incorporated [GNU GPL v3.0 terms](COPYING).

Source-backed extension packages include LICENSE, COPYING, and NOTICE. Third-party components retain their own license notices.
