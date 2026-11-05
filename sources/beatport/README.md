# Beatport

Imported from the supplied `mornye-beatport-1.0.0.zip` and updated to 1.0.1.
Requires Mornye 5.3.0, signed session features and the existing Beatport V2
gateway at `api.zarz.moe`. Account credentials remain on that server.
The signed identity stays `beatport@1.0.0` to retain its session scope.

Search supports tracks, artists and releases. Artist releases use paginated
cursors. Downloads preserve original FLAC or AAC in M4A without transcoding
or a silent quality downgrade. ISRC matching takes priority; matching without
an ISRC requires exact title/mix, artist and known durations within 3 seconds.

Prepared media URLs are retained through ordinary network failures and pause.
An expired or rejected capability is removed from memory and storage, and the
download attempts one fresh resolve before returning the transfer error.
HTTP 429 remains `rate_limited` with the server's retry delay.

Validation:

```sh
node --test tests/beatport.test.cjs
python3 scripts/build_packages.py beatport
python3 scripts/build_packages.py beatport --check
```

The offline host fixture in `tests/fixtures/mornye-5.3.0/` came with the supplied
archive. Its `prelude.js` and `provider.js` are from Mornye release commit
`afee4332a257f1b6aeb288229eddf04ac0777b3c`. It verifies that released host's
bridge and result schema without calling a live service. Worker sources and
deployment configuration remain outside this extension repository.
