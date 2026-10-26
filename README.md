# Mornye Extension Store

## Submit Your Extension

1. Fork this repository
2. Add your `.sflx` package to the `extensions/` folder
3. Add your icon image (PNG/JPG, 512x512 recommended) to `icons/` folder
4. Add entry to `registry.json`
   - Ensure `icon_url` points to the raw file in the repository (e.g. `https://raw.githubusercontent.com/zarzet/SpotiFLAC-Extension/main/icons/your-icon.png`)
5. Create Pull Request

## Requirements

- Extension must follow [Extension Development Guide](https://spotiflac.zarz.moe/docs)
- No malicious code
- Clear description of what extension does
- Working download URL and icon URL

## Developing the bundled providers

Spotify, Amazon, Apple Music, YouTube Music, SoundCloud, Tidal, Qobuz, Deezer, JioSaavn, Bugs Music,
Melon, and Genie have reviewable source in `sources/<provider>/` and
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

Signed-session providers omit `callbackUrl` so the host application supplies
its own session-grant callback. This lets Mornye and older host versions
return to the application that started verification. Package-only fixes keep
the gateway's `appVersion` unchanged to preserve its existing session scope.

Bugs Music, Melon, and Genie provide catalog metadata and URL imports. Their
enrichment reads their own track details; it does not call the deprecated
Songlink public API. Audio downloads and cross-service matching remain the
responsibility of the app's configured download providers. None of the three
services publishes ISRC codes, so matching relies on titles, artists, and
running times. Track and album lookups read running times from each service's
player or mobile metadata; search results and charts do not carry them.

## Review Process

All submissions are reviewed before being added to the store.

## License

Copyright 2026 zarzet

This project is licensed under the [GNU Lesser General Public License v3.0 only (LGPL-3.0-only)](LICENSE), together with the incorporated [GNU GPL v3.0 terms](COPYING).

Source-backed extension packages include LICENSE, COPYING, and NOTICE. Third-party components retain their own license notices.
