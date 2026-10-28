var BASE_URL = "https://music.bugs.co.kr";
var PROVIDER_ID = "bugs-music";
var TOP100_CACHE = [];
var TOP100_CACHE_TIME = 0;
var FEED_CACHE = {};
var TRACK_CACHE = {};
var ALBUM_CACHE = {};
var CACHE_TTL_MS = 5 * 60 * 1000;
var DURATION_LOOKUP_LIMIT = 50;
var DURATION_LOOKUP_BUDGET_MS = 10 * 1000;

function initialize() {
  return {
    success: true
  };
}

function cleanup() {
  TOP100_CACHE = [];
  TOP100_CACHE_TIME = 0;
  FEED_CACHE = {};
  TRACK_CACHE = {};
  ALBUM_CACHE = {};
  return {
    success: true
  };
}

function cleanText(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, function(match, value) {
      var code = value.charAt(0).toLowerCase() === "x" ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code <= 0xffff) return String.fromCharCode(code);
      code -= 0x10000;
      return String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    })
    .replace(/\s+/g, " ")
    .trim();
}

function absoluteUrl(url) {
  if (!url) {
    return "";
  }

  url = String(url)
    .replace(/&amp;/gi, "&")
    .trim();

  if (url.indexOf("//") === 0) {
    return "https:" + url;
  }

  if (
    url.indexOf("http://") === 0 ||
    url.indexOf("https://") === 0
  ) {
    return url;
  }

  if (url.indexOf("/") === 0) {
    return BASE_URL + url;
  }

  return BASE_URL + "/" + url;
}

function firstMatch(text, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var match = text.match(patterns[i]);

    if (match && match[1]) {
      return cleanText(match[1]);
    }
  }

  return "";
}

function getTrackId(row) {
  return firstMatch(row, [
    /href=["'][^"']*\/track\/(\d+)[^"']*["']/i,
    /data-track-id\s*=\s*["'](\d+)["']/i,
    /data-trackid\s*=\s*["'](\d+)["']/i,
    /trackId\s*=\s*["']?(\d+)/i,
    /trackid\s*=\s*["']?(\d+)/i,
    /trackNo\s*=\s*["']?(\d+)/i
  ]);
}

function getTrackName(row) {
  return firstMatch(row, [
    /<p[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /<a[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*trackTitle[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
    /title\s*=\s*["']([^"']+)["']/i
  ]);
}

function getArtistName(row) {
  var artistCell = row.match(/<p[^>]*class=["'][^"']*\bartist\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i);
  if (artistCell) return multiArtistNames(artistCell[1]) || linkNames(artistCell[1], "artist");
  return firstMatch(row, [
    /<p[^>]*class=["'][^"']*\bartist\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /<p[^>]*class=["'][^"']*artistName[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*artist[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*artist[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  ]);
}

function getAlbumId(row) {
  return firstMatch(row, [
    /href=["'][^"']*\/album\/(\d+)[^"']*["']/i,
    /data-album-id\s*=\s*["'](\d+)["']/i,
    /albumId\s*=\s*["']?(\d+)/i
  ]);
}

function getAlbumName(row) {
  return firstMatch(row, [
    /<a[^>]*class=["'][^"']*\balbum\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*\balbumName\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i
  ]);
}

function linkNames(html, kind) {
  var names = [], seen = {};
  var pattern = new RegExp("<a[^>]*href=[\"'][^\"']*/" + kind + "/\\d+[^\"']*[\"'][^>]*>([\\s\\S]*?)</a>", "gi");
  var match;
  while ((match = pattern.exec(html))) {
    var name = cleanText(match[1]);
    if (name && !seen[name]) { names.push(name); seen[name] = true; }
  }
  return names.join(", ");
}

// List rows link only the first artist of a collaboration; the rest are in
// the "name||name||id||status" entries of the artist popup handler.
function multiArtistNames(cell) {
  var match = cell.match(/openMultiArtistSearchResultPopLayer\(\s*this\s*,\s*'((?:[^'\\]|\\.)*)'/i);
  if (!match) return "";
  var names = [], seen = {};
  match[1].split(/\\+n/).forEach(function(entry) {
    var name = cleanText(entry.split("||")[0].replace(/\\(.)/g, "$1"));
    if (name && !seen[name]) { names.push(name); seen[name] = true; }
  });
  return names.length > 1 ? names.join(", ") : "";
}

function getArtistId(html) {
  return firstMatch(html, [
    /artistId\s*=\s*["'](\d+)["']/i,
    /href=["'][^"']*\/artist\/(\d+)[^"']*["']/i
  ]);
}

function getInfoCell(html, label) {
  var match = html.match(new RegExp("<th[^>]*>\\s*" + label + "\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>", "i"));
  return match ? match[1] : "";
}

function pageTitle(html) {
  return firstMatch(html, [
    /<header[^>]*class=["'][^"']*\bpgTitle\b[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i
  ]).replace(/\s*-\s*벅스\s*$/, "");
}

function structuredData(html, type) {
  var scripts = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  function find(value) {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value)) {
      for (var j = 0; j < value.length; j++) { var item = find(value[j]); if (item) return item; }
    } else {
      if (value["@type"] === type || (Array.isArray(value["@type"]) && value["@type"].indexOf(type) >= 0)) return value;
      if (value["@graph"]) return find(value["@graph"]);
    }
    return null;
  }
  for (var i = 0; i < scripts.length; i++) {
    try {
      var data = find(JSON.parse(scripts[i].replace(/^[\s\S]*?>/, "").replace(/<\/script>[\s\S]*$/i, "")));
      if (data) return data;
    } catch (error) {}
  }
  return {};
}

function artistNames(value) {
  if (Array.isArray(value)) return value.map(artistNames).filter(Boolean).join(", ");
  return cleanText(value && typeof value === "object" ? value.name : value);
}

function normalizeId(value, kind) {
  var id = String(value || "").replace(new RegExp("^bugs:" + kind + ":"), "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Invalid Bugs " + kind + " ID");
  return id;
}


function normalizeCoverUrl(url) {
  if (!url) return "";
  url = absoluteUrl(url).replace(/\?[^#]*$/, "");
  // Bugs serves the same cover in 50/60/100/130/148/200/500/1000 sizes.
  // Prefer the largest album image while preserving the album folder and id.
  url = url.replace(/\/album\/images\/(?:50|60|100|130|148|170|200|500)\//i, "/album/images/1000/");
  url = url.replace(/\/essential\/images\/(?:50|60|100|120|130|200|500)\//i, "/essential/images/500/");
  return url;
}

function getCoverUrl(row) {
  var patterns = [
    /<a[^>]*class=["'][^"']*thumbnail[^"']*["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["']/i,
    /<a[^>]*class=["'][^"']*thumbnail[^"']*["'][^>]*>[\s\S]*?<img[^>]*data-original=["']([^"']+)["']/i,
    /<img[^>]*data-original=["']([^"']+)["']/i,
    /<img[^>]*data-src=["']([^"']+)["']/i,
    /<img[^>]*src=["']([^"']+)["']/i,
    /background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = row.match(patterns[i]);

    if (!match || !match[1]) {
      continue;
    }

    var url = match[1]
      .replace(/&amp;/gi, "&")
      .split(",")[0]
      .trim()
      .split(" ")[0];

    if (!url) {
      continue;
    }

    if (
      url.indexOf("data:image") === 0 ||
      url.indexOf("blank.gif") >= 0 ||
      url.indexOf("transparent") >= 0
    ) {
      continue;
    }

    return normalizeCoverUrl(url);
  }

  return "";
}

function getDurationMs(row) {
  var ms = firstMatch(row, [/data-duration-ms\s*=\s*["'](\d+)["']/i]);
  if (ms) return Number(ms);
  var seconds = firstMatch(row, [/data-duration\s*=\s*["'](\d+)["']/i]);
  if (seconds) return Number(seconds) * 1000;
  return durationMs(cleanText(getInfoCell(row, "재생\\s*시간")));
}

function durationMs(value) {
  var iso = String(value || "").match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) return Math.round((Number(iso[1] || 0) * 3600 + Number(iso[2] || 0) * 60 + Number(iso[3] || 0)) * 1000);
  var parts = String(value || "").match(/^(?:(\d+):)?(\d+):(\d{2})$/);
  return parts ? (Number(parts[1] || 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3])) * 1000 : 0;
}

function getIsrc(row) {
  return firstMatch(row, [
    /^\s*([A-Z]{2}[A-Z0-9]{3}\d{7})\s*$/i,
    /\bISRC\b[^A-Z0-9]{0,30}([A-Z]{2}[A-Z0-9]{3}\d{7})/i,
    /isrc\s*[=:]\s*["']([^"']+)["']/i
  ]).toUpperCase();
}

function parseTrackRow(row) {
  var id = getTrackId(row);

  if (!id) {
    return null;
  }

  var name = getTrackName(row);
  var artists = getArtistName(row);
  var albumName = getAlbumName(row);
  var albumId = getAlbumId(row);
  var coverUrl = getCoverUrl(row);

  if (!name) return null;

  return {
    id: String(id),
    name: name,
    artists: artists,
    artist_id: getArtistId(row),
    album_name: albumName,
    album_id: albumId,
    cover_url: coverUrl,
    duration_ms: getDurationMs(row),
    track_number: Number(firstMatch(row, [/<p[^>]*class=["'][^"']*\btrackIndex\b[^"']*["'][^>]*>[\s\S]*?<em[^>]*>(\d+)<\/em>/i]) || 0),
    disc_number: Number(firstMatch(row, [/disc_id=["'](\d+)["']/i]) || 0),
    explicit: /adult_yn=["']Y["']/i.test(row),
    isrc: getIsrc(row)
  };
}

function parseTracks(html) {
  var tracks = [];
  var seen = {};

  if (!html) {
    return tracks;
  }

  var rows = html.match(
    /<tr[^>]*>[\s\S]*?<\/tr>/gi
  ) || [];

  for (var i = 0; i < rows.length; i++) {
    var track = parseTrackRow(rows[i]);

    if (!track || !track.id) {
      continue;
    }

    if (seen[track.id]) {
      continue;
    }

    seen[track.id] = true;
    tracks.push(track);
  }

  return tracks;
}

function makeTrackResult(track) {
  return {
    id: String(track.id),
    uri: "bugs:track:" + String(track.id),
    type: "track",
    name: track.name || "",
    artists: track.artists || "",
    artist_id: track.artist_id || "",
    artist_url: track.artist_id ? BASE_URL + "/artist/" + track.artist_id : "",
    album_name: track.album_name || "",
    album_id: track.album_id || "",
    album_url: track.album_id ? BASE_URL + "/album/" + track.album_id : "",
    album_artist: track.album_artist || "",
    external_urls: BASE_URL + "/track/" + String(track.id),
    release_date: track.release_date || "",
    track_number: Number(track.track_number || 0),
    disc_number: Number(track.disc_number || 0),
    total_tracks: Number(track.total_tracks || 0),
    explicit: Boolean(track.explicit),
    album_uri: track.album_id ? "bugs:album:" + String(track.album_id) : "",
    album: {
      id: String(track.album_id || ""),
      uri: track.album_id ? "bugs:album:" + String(track.album_id) : "",
      type: "album",
      name: track.album_name || "",
      cover_url: track.cover_url || "",
      images: track.cover_url || "",
      item_type: "album",
      provider_id: PROVIDER_ID
    },
    cover_url: track.cover_url || "",
    images: track.cover_url || "",
    item_type: "track",
    duration_ms: Number(track.duration_ms || 0),
    isrc: track.isrc || "",
    external_links: { bugs: "https://music.bugs.co.kr/track/" + String(track.id) },
    provider_id: PROVIDER_ID
  };
}

function makeSection(uri, title, tracks) {
  return {
    uri: uri,
    title: title,
    items: (tracks || []).map(makeTrackResult)
  };
}

function makeVirtualAlbum(id, name, tracks, cover) {
  var list = tracks || [];
  return {
    id: String(id),
    uri: "bugs:album:" + String(id),
    type: "album",
    item_type: "album",
    name: name,
    artists: "Bugs Music",
    album_type: "compilation",
    total_tracks: list.length,
    cover_url: cover || (list.length ? list[0].cover_url : ""),
    images: cover || (list.length ? list[0].cover_url : ""),
    provider_id: PROVIDER_ID,
    tracks: list.map(makeTrackResult)
  };
}

function fetchHtml(url) {
  var response = http.get(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml"
  });
  if (!response || !response.ok) {
    throw new Error("Bugs HTTP error " + (response ? response.status : "unavailable") + ": " + url);
  }
  return response.body || "";
}

function safeTracks(url) {
  try {
    return parseTracks(fetchHtml(url));
  } catch (error) {
    if (typeof log !== "undefined") log.warn(String(error));
    return [];
  }
}

// Album rows carry no running time; the web player's per-track JSON does.
// Lookups stop at a budget so a long album still opens within the host timeout.
function fillPlayerDurations(tracks) {
  var started = Date.now(), lookups = 0;
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i].duration_ms) continue;
    if (lookups >= DURATION_LOOKUP_LIMIT || Date.now() - started >= DURATION_LOOKUP_BUDGET_MS) return;
    lookups++;
    tracks[i].duration_ms = playerDuration(tracks[i].id);
  }
}

function playerDuration(id) {
  try {
    var response = http.get(BASE_URL + "/player/track/" + id, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    });
    var track = response && response.ok ? JSON.parse(response.body || "{}").track : null;
    return track && String(track.track_id) === String(id) ? durationMs(track.len) : 0;
  } catch (error) {
    return 0;
  }
}

function searchTracks(query) {
  if (!query || !String(query).trim()) return [];
  var tracks = parseTracks(fetchHtml(BASE_URL + "/search/track?q=" + encodeURIComponent(String(query).trim())));
  return tracks.map(makeTrackResult);
}

function getTrack(trackId) {
  var id = normalizeId(trackId, "track");
  var cached = TRACK_CACHE[id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.track;
  var html = fetchHtml(BASE_URL + "/track/" + id);
  var data = structuredData(html, "MusicRecording");
  var actualId = firstMatch(String(data.url || data["@id"] || ""), [/\/track\/(\d+)(?:[/?#]|$)/i]);
  var metaId = firstMatch(html, [/<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*\/track\/(\d+)(?:[/?#"'])/i]);
  if ((actualId && actualId !== id) || (metaId && metaId !== id)) throw new Error("Bugs returned another track");
  var artistCell = getInfoCell(html, "아티스트");
  var albumCell = getInfoCell(html, "앨범");
  var album = data.inAlbum || {};
  var track = {
    id: id,
    name: cleanText(data.name) || pageTitle(html),
    artists: linkNames(artistCell, "artist") || artistNames(data.byArtist),
    artist_id: getArtistId(artistCell),
    album_name: cleanText(album.name) || cleanText(albumCell),
    album_id: getAlbumId(albumCell) || firstMatch(String(album.url || ""), [/\/album\/(\d+)/]),
    cover_url: normalizeCoverUrl(data.image || firstMatch(html, [/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i])),
    duration_ms: durationMs(data.duration) || getDurationMs(html),
    release_date: cleanText(data.datePublished),
    isrc: getIsrc(cleanText(getInfoCell(html, "ISRC")))
  };
  if (!track.name || !track.artists) throw new Error("Bugs track metadata not found: " + id);
  var result = makeTrackResult(track);
  cacheStore(TRACK_CACHE, id, { time: Date.now(), track: result });
  return result;
}

function cacheStore(cache, id, value) {
  var now = Date.now();
  Object.keys(cache).forEach(function(key) {
    if (now - cache[key].time >= CACHE_TTL_MS) delete cache[key];
  });
  var keys = Object.keys(cache);
  if (!cache[id] && keys.length >= 64) {
    keys.sort(function(a, b) { return cache[a].time - cache[b].time; });
    delete cache[keys[0]];
  }
  cache[id] = value;
}

function enrichTrack(track) {
  if (!track || !track.id) throw new Error("Bugs enrichment requires a track ID");
  if (track.provider_id && track.provider_id !== PROVIDER_ID) return track;
  var detail = getTrack(track.id), result = Object.assign({}, track);
  Object.keys(detail).forEach(function(key) {
    if (detail[key] !== "" && detail[key] !== 0) result[key] = detail[key];
  });
  result.external_links = Object.assign({}, track.external_links || {}, detail.external_links);
  return result;
}

var RELATED_SEED_LIMIT = 5;
var RELATED_TITLE_MIN = 0.8;
var RELATED_ARTIST_MIN = 0.6;

function matchKey(value) {
  return String(value || "").toLowerCase().replace(/[^0-9a-zÀ-ɏ぀-ヿ㄰-㆏一-鿿가-힯]+/g, "");
}

function baseTitle(value) {
  return String(value || "").replace(/\s*[\(\[][^\)\]]*[\)\]]/g, "").trim() || String(value || "");
}

function similarity(a, b) {
  var left = matchKey(a), right = matchKey(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (typeof matching !== "undefined" && matching && typeof matching.compareStrings === "function") {
    return Number(matching.compareStrings(String(a), String(b))) || 0;
  }
  return 0;
}

// Bugs often shows a Korean name with the romanized one in parentheses, such
// as "Hangul(Latin)", so containment of either form also counts as a match.
function artistMatches(seedArtists, artists) {
  var seed = String(seedArtists || "").split(/\s*(?:,|&|\/|\bfeat\.?|\bft\.?)\s*/i)[0];
  var key = matchKey(seed), other = matchKey(artists);
  if (!key || !other) return false;
  if (other.indexOf(key) >= 0 || key.indexOf(other) >= 0) return true;
  return similarity(seed, artists) >= RELATED_ARTIST_MIN;
}

function resolveRelatedSeed(seed) {
  var name = cleanText(seed.name), artists = cleanText(seed.artists);
  if (!name || !artists) return "";
  var best = null, bestScore = 0;
  searchTracks(name + " " + artists).forEach(function(track) {
    if (!artistMatches(artists, track.artists)) return;
    var score = Math.max(similarity(name, track.name), similarity(baseTitle(name), baseTitle(track.name)));
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  });
  return best && bestScore >= RELATED_TITLE_MIN ? best.id : "";
}

// The track page fills its "함께 들으면 좋은 곡" section from this fragment.
function similarTracks(id) {
  var html = fetchHtml(BASE_URL + "/track/ajax/similarTrack?trackId=" + id + "&page=1&decorator=blank");
  return parseTracks(html).map(makeTrackResult);
}

function getRelatedTracks(seeds, options) {
  var limit = Math.floor(Number(options && options.limit) || 25);
  limit = Math.max(1, Math.min(50, limit));
  var list = Array.isArray(seeds) ? seeds.slice(0, 10) : [];
  var excluded = {}, seedIsrcs = {};
  list.forEach(function(seed) {
    if (!seed) return;
    var isrc = String(seed.isrc || "").trim().toUpperCase();
    if (isrc) seedIsrcs[isrc] = true;
    if (seed.provider_id === PROVIDER_ID && seed.id) excluded[String(seed.id).replace(/^bugs:track:/, "")] = true;
  });

  var groups = [], failures = 0, successes = 0, lastError = null;
  list.slice(0, RELATED_SEED_LIMIT).forEach(function(seed) {
    if (!seed) return;
    try {
      var id = seed.provider_id === PROVIDER_ID && seed.id ? normalizeId(seed.id, "track") : resolveRelatedSeed(seed);
      if (!id) {
        successes++;
        return;
      }
      excluded[id] = true;
      groups.push(similarTracks(id));
      successes++;
    } catch (error) {
      failures++;
      lastError = error;
      if (typeof log !== "undefined") log.warn("Bugs related tracks failed for a seed: " + String(error.message || error));
    }
  });
  if (!successes && failures) throw lastError || new Error("Bugs related tracks are unavailable");

  var results = [], seen = {};
  for (var index = 0; results.length < limit; index++) {
    var remaining = false;
    for (var g = 0; g < groups.length && results.length < limit; g++) {
      var track = groups[g][index];
      if (!track) continue;
      remaining = true;
      var isrc = String(track.isrc || "").toUpperCase();
      if (!track.id || excluded[track.id] || seen[track.id] || (isrc && seedIsrcs[isrc])) continue;
      seen[track.id] = true;
      results.push(track);
    }
    if (!remaining) break;
  }
  return results;
}

function customSearch(query, options) {
  var tracks = searchTracks(query);
  var limit = Number(options && typeof options === "object" ? options.limit : options);
  return limit > 0 ? tracks.slice(0, Math.floor(limit)) : tracks;
}

function getAlbum(albumId) {
  var id = String(albumId || "").replace("bugs:album:", "").trim();

  // TOP100은 벅스에 실제 앨범 ID가 없는 가상 앨범이므로
  // 홈피드에서 보관한 100곡을 그대로 앨범 객체로 반환한다.
  if (id === "top100") {
    var cached = Date.now() - TOP100_CACHE_TIME < CACHE_TTL_MS ? TOP100_CACHE : [];
    if (!cached.length) {
      cached = firstAvailableTop100();
      TOP100_CACHE = cached;
      TOP100_CACHE_TIME = Date.now();
    }
    if (!cached.length) throw new Error("Bugs chart is unavailable");
    return makeVirtualAlbum("top100", "Bugs (벅스) TOP 100", cached, cached[0].cover_url);
  }

  id = normalizeId(id, "album");
  var cachedAlbum = ALBUM_CACHE[id];
  if (cachedAlbum && Date.now() - cachedAlbum.time < CACHE_TTL_MS) return cachedAlbum.value;
  var html = fetchHtml(BASE_URL + "/album/" + id);
  var data = structuredData(html, "MusicAlbum");
  var actualId = firstMatch(String(data.url || data["@id"] || ""), [/\/album\/(\d+)(?:[/?#]|$)/i]);
  var metaId = firstMatch(html, [/<meta[^>]*property=["']og:url["'][^>]*content=["'][^"']*\/album\/(\d+)(?:[/?#"'])/i]);
  if ((actualId && actualId !== id) || (metaId && metaId !== id)) throw new Error("Bugs returned another album");
  var name = cleanText(data.name) || pageTitle(html);
  var artists = linkNames(getInfoCell(html, "아티스트"), "artist") || artistNames(data.byArtist);
  if (!name || !artists) throw new Error("Bugs album metadata not found: " + id);
  var cover = normalizeCoverUrl(data.image || firstMatch(html, [/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i]));
  var releaseDate = cleanText(data.datePublished) || cleanText(getInfoCell(html, "발매일")).replace(/\./g, "-");
  var albumType = cleanText(getInfoCell(html, "유형"));
  albumType = albumType.indexOf("싱글") >= 0 ? "single" : albumType.indexOf("EP") >= 0 ? "ep" : "album";
  var list = html.match(/<table[^>]*class=["'][^"']*\btrackList\b[^"']*\bbyAlbum\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i);
  var tracks = parseTracks(list ? list[0] : "");
  if (!tracks.length) throw new Error("Bugs album track list is unavailable: " + id);
  tracks = tracks.map(function(track, index) {
    track.album_id = id;
    track.album_name = name;
    track.album_artist = artists;
    track.cover_url = track.cover_url || cover;
    track.release_date = releaseDate;
    track.total_tracks = tracks.length;
    track.track_number = track.track_number || index + 1;
    track.disc_number = track.disc_number || 1;
    return track;
  });
  fillPlayerDurations(tracks);
  var result = {
    id: id,
    uri: "bugs:album:" + id,
    type: "album",
    item_type: "album",
    name: cleanText(name),
    artists: artists,
    artist_id: getArtistId(getInfoCell(html, "아티스트")),
    release_date: releaseDate,
    total_tracks: tracks.length,
    album_type: albumType,
    cover_url: cover,
    images: cover,
    provider_id: PROVIDER_ID,
    tracks: tracks.map(makeTrackResult)
  };
  cacheStore(ALBUM_CACHE, id, { time: Date.now(), value: result });
  return result;
}

function getArtist(artistId) {
  var id = normalizeId(artistId, "artist");
  var html = fetchHtml(BASE_URL + "/artist/" + id);
  var data = structuredData(html, "MusicGroup");
  var name = pageTitle(html) || cleanText(data.name);
  if (!name) throw new Error("Bugs artist metadata not found: " + id);
  var albums = [], seen = {};
  var figures = html.match(/<figure[^>]*class=["'][^"']*\balbumInfo\b[^"']*["'][^>]*>[\s\S]*?<\/figure>/gi) || [];
  for (var i = 0; i < figures.length; i++) {
    var albumId = getAlbumId(figures[i]);
    if (!albumId || seen[albumId]) continue;
    var title = firstMatch(figures[i], [/<div[^>]*class=["'][^"']*\balbumTitle\b[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i]);
    if (!title) continue;
    seen[albumId] = true;
    var albumArtists = linkNames(figures[i], "artist") || name;
    var albumType = firstMatch(figures[i], [/<span[^>]*class=["'][^"']*\balbumType\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
    albums.push({ id: albumId, name: title, artists: albumArtists, artist_id: getArtistId(figures[i]) || id, cover_url: getCoverUrl(figures[i]),
      release_date: firstMatch(figures[i], [/<time[^>]*>([\s\S]*?)<\/time>/i]).replace(/\./g, "-"),
      album_type: albumType.indexOf("싱글") >= 0 ? "single" : albumType.indexOf("EP") >= 0 ? "ep" : "album",
      item_type: "album", provider_id: PROVIDER_ID, total_tracks: 0, tracks: [] });
  }
  return { id: id, name: name, image_url: absoluteUrl(data.image || firstMatch(html, [/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i])),
    albums: albums, top_tracks: parseTracks(html).map(makeTrackResult), provider_id: PROVIDER_ID };
}

function handleUrl(url) {
  var match = String(url || "").match(/^https?:\/\/(?:music|m)\.bugs\.co\.kr\/(track|album|artist)\/(\d+)\/?(?:[?#].*)?$/i);
  if (!match) throw new Error("Unsupported Bugs URL");
  var type = match[1].toLowerCase(), id = match[2];
  var result = { type: type, id: id };
  result[type] = type === "track" ? getTrack(id) : type === "album" ? getAlbum(id) : getArtist(id);
  result.name = result[type].name;
  result.cover_url = result[type].cover_url || result[type].image_url || "";
  if (type === "album") result.tracks = result.album.tracks;
  return result;
}

function firstAvailableTop100() {
  var urls = [
    BASE_URL + "/chart/track/realtime/total",
    BASE_URL + "/chart/track/realtime/total?nation=KR",
    BASE_URL + "/chart/track/day/total"
  ];
  for (var i = 0; i < urls.length; i++) {
    var tracks = safeTracks(urls[i]);
    if (tracks.length) return tracks.slice(0, 100);
  }
  return [];
}

function getHomeFeed() {
  if (FEED_CACHE.feed && Date.now() - FEED_CACHE.time < CACHE_TTL_MS) return FEED_CACHE.feed;
  function firstAvailable(urls) {
    for (var i = 0; i < urls.length; i++) {
      var items = safeTracks(urls[i]);
      if (items.length) return items;
    }
    return [];
  }

  var top100 = firstAvailableTop100();
  TOP100_CACHE = top100.slice(0, 100);
  TOP100_CACHE_TIME = Date.now();
  var sections = [];

  // TOP100은 곡 카드 100개가 아니라 가상 앨범 하나로 표시한다.
  if (top100.length) {
    sections.push({
      uri: "bugs:top100",
      title: "벅스 TOP 100",
      items: [makeVirtualAlbum("top100", "Bugs (벅스) TOP 100", top100, top100[0].cover_url)]
    });
  }

  // /newest/track는 전체 국가라 외국곡이 섞일 수 있으므로 국내 최신곡 경로를 사용한다.
  var latest = firstAvailable([
    BASE_URL + "/newest/track/kpop",
    BASE_URL + "/newest/track/kpoppicked",
    BASE_URL + "/newest/track"
  ]);
  if (latest.length) sections.push(makeSection("bugs:latest", "최신음악", latest));

  // 국내 인기곡은 TOP100과 겹쳐도 별도 섹션으로 유지한다.
  var domestic = firstAvailable([
    BASE_URL + "/chart/track/day/kpop",
    BASE_URL + "/chart/track/realtime/kpop",
    BASE_URL + "/chart/track/week/kpop"
  ]);
  if (domestic.length) sections.push(makeSection("bugs:domestic", "국내 인기곡", domestic));

  var overseas = firstAvailable([
    BASE_URL + "/chart/track/day/pop",
    BASE_URL + "/chart/track/day/overseas"
  ]);
  if (overseas.length) sections.push(makeSection("bugs:overseas", "해외 인기곡", overseas));

  var ballad = firstAvailable([
    BASE_URL + "/chart/track/day/nb",
    BASE_URL + "/genre/chart/kpop/ballad/total/day"
  ]);
  if (ballad.length) sections.push(makeSection("bugs:ballad", "발라드", ballad));

  var dance = firstAvailable([
    BASE_URL + "/chart/track/day/ndp",
    BASE_URL + "/genre/chart/kpop/dance/total/day"
  ]);
  if (dance.length) sections.push(makeSection("bugs:dance", "댄스/팝", dance));

  var hiphop = firstAvailable([
    BASE_URL + "/chart/track/day/nrh",
    BASE_URL + "/genre/chart/kpop/rnh/total/day"
  ]);
  if (hiphop.length) sections.push(makeSection("bugs:hiphop", "랩/힙합", hiphop));

  var ost = firstAvailable([
    BASE_URL + "/chart/track/day/nost",
    BASE_URL + "/genre/chart/kpop/ost/total/day"
  ]);
  if (ost.length) sections.push(makeSection("bugs:ost", "OST", ost));

  // 장르별 일간 차트 (벅스 장르 차트 경로)
  var extraGenres = [
    ["kpop/idol", "아이돌"], ["kpop/rns", "알앤비/소울"], ["kpop/indie", "인디"],
    ["kpop/rock", "락/메탈"], ["kpop/folk", "포크/어쿠스틱"], ["kpop/elec", "일렉트로닉"],
    ["kpop/jazz", "재즈"], ["kpop/adultkpop", "성인가요"],
    ["pop/pop", "해외 팝"], ["pop/hiphop", "해외 랩/힙합"], ["pop/rnb", "해외 알앤비/소울"],
    ["etc/njpop", "J-POP"], ["etc/nnewage", "뉴에이지"]
  ];
  for (var gi = 0; gi < extraGenres.length; gi++) {
    var gTracks = safeTracks(BASE_URL + "/genre/chart/" + extraGenres[gi][0] + "/total/day");
    if (gTracks.length) sections.push(makeSection("bugs:genre:" + extraGenres[gi][0].replace("/", "-"), extraGenres[gi][1], gTracks.slice(0, 30)));
  }

  if (!sections.length) throw new Error("Bugs home feed is unavailable");
  var feed = { success: true, greeting: "Bugs Music", sections: sections };
  FEED_CACHE = { time: Date.now(), feed: feed };
  return feed;
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  searchTracks: searchTracks,
  customSearch: customSearch,
  getTrack: getTrack,
  enrichTrack: enrichTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  handleUrl: handleUrl,
  getHomeFeed: getHomeFeed,
  getRelatedTracks: getRelatedTracks
});
