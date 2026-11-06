var PROVIDER_ID = "genie-music";
var TOP200_CACHE = [];
var TOP200_CACHE_TIME = 0;
var ALBUM_CACHE = {};
var ARTIST_CACHE = {};
var TRACK_CACHE = {};
var FEED_CACHE = {};
var CHART_CACHE = {};
var DJ_CACHE = {};
var CACHE_TTL_MS = 5 * 60 * 1000;
var DURATION_LOOKUP_LIMIT = 50;
var DURATION_LOOKUP_BUDGET_MS = 10 * 1000;

function initialize() {
  return {
    success: true
  };
}

function cleanup() {
  TOP200_CACHE = [];
  TOP200_CACHE_TIME = 0;
  ALBUM_CACHE = {};
  ARTIST_CACHE = {};
  TRACK_CACHE = {};
  FEED_CACHE = {};
  CHART_CACHE = {};
  DJ_CACHE = {};
  return {
    success: true
  };
}

function cleanText(value) {
  if (!value) {
    return "";
  }

  return String(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:span|em|strong)\b[^>]*class=["'][^"']*\b(?:icon|hide|blind|badge)\b[^"']*["'][^>]*>[\s\S]*?<\/(?:span|em|strong)>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, function(_, code) {
      var number = code.charAt(0).toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
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
    return url.replace(/^http:\/\/((?:www\.)?genie\.co\.kr|image\.genie\.co\.kr)(?=\/)/i, "https://$1");
  }

  if (url.indexOf("/") === 0) {
    return "https://www.genie.co.kr" + url;
  }

  return "https://www.genie.co.kr/" + url;
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
  return firstMatch(row, [/href=["'][^"']*songInfo[^"']*[?&]xgnm=(\d+)/i,/data-song-no\s*=\s*["'](\d+)["']/i,/data-songid\s*=\s*["'](\d+)["']/i,/songId\s*[=:]\s*["']?(\d+)/i,/songid\s*[=:]\s*["']?(\d+)/i,/xgnm\s*[=:]\s*["']?(\d+)/i]);
}

function getTrackName(row) {
  return firstMatch(row, [
    /<a[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /<a[^>]*href=["'][^"']*songInfo[^"']*["'][^>]*>([\s\S]*?)<\/a>/i
  ]);
}

function getArtistName(row) {
  return firstMatch(row, [
    /<a[^>]*class=["'][^"']*artist[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,/<a[^>]*class=["'][^"']*(?:artist|artistName)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,/<span[^>]*class=["'][^"']*(?:artist|artistName)[^"']*["'][^>]*>([\s\S]*?)<\/span>/i]);
}

function getAlbumId(row) {
  return firstMatch(row, [
    /href=["'][^"']*albumInfo[^"']*[?&]axnm=(\d+)/i,
    /fnViewAlbumLayer\s*\(\s*["']?(\d+)/i,
    /fnGoMore\s*\(\s*["']albumInfo["']\s*,\s*["']?(\d+)/i,
    /data-album-no\s*=\s*["'](\d+)["']/i,
    /data-album-id\s*=\s*["'](\d+)["']/i,
    /(?:albumInfo|albumView)[^"']*(?:axnm|albumId|albumNo|albnm)[=\\"]+(\d+)/i,
    /(?:axnm|albumId|albumNo|albnm)\s*[=:]\s*["']?(\d+)/i,
    /[?&](?:axnm|albumId|albumNo|albnm)=(\d+)/i,
    /goAlbum(?:Detail)?\s*\([^)]*?(\d{4,})/i,
    /(?:albumInfo|albumView|\/album\/)[^>]{0,500}?(?:axnm|albumId|albumNo|albnm)\s*[=:]\s*["']?(\d{4,})/i,
    /(?:data-)?(?:album|al)\s*(?:no|id)\s*=\s*["'](\d{4,})["']/i,
    /href=["'][^"']*\/album\/(\d{4,})[^"']*["']/i
  ]);
}

function getAlbumName(row) {
  return firstMatch(row, [
    /<a[^>]*class=["'][^"']*\balbumtitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /<a[^>]*class=["'][^"']*\balbum\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*albumName[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i,
    /class=["'][^"']*album[^"']*["'][^>]*>([\s\S]*?)<\/span>/i
  ]);
}


function normalizeCoverUrl(url) {
  if (!url) return "";
  url = absoluteUrl(url).replace(/\?[^#]*$/, "");
  if (/^https:\/\/image\.genie\.co\.kr\//i.test(url)) {
    url = url.replace(/\/dims\/.*$/i, "").replace(/_\d+x\d+(\.\w+)$/i, "_600x600$1");
  }
  return url;
}

function getCoverUrl(row) {
  var urls = [];
  var re = /(?:data-original|data-src|data-lazy-src|data-image|src|content)=["\']([^"\']+)["\']/ig;
  var m;
  while ((m = re.exec(row)) !== null) {
    var u = String(m[1] || "").replace(/&amp;/gi, "&").trim();
    if (u && !/^data:image/i.test(u) && !/blank|transparent|noimage|default/i.test(u)) urls.push(u);
  }
  var bg = row.match(/background-image\s*:\s*url\(["\']?([^"\')]+)["\']?\)/i);
  if (bg) urls.push(bg[1]);
  for (var i=0;i<urls.length;i++) {
    if (/image\.genie\.co\.kr/i.test(urls[i])) return normalizeCoverUrl(urls[i]);
  }
  return urls.length ? normalizeCoverUrl(urls[0]) : "";
}

function getDurationMs(row) {
  var clock = row.match(/(?:재생시간|재생 시간|txt_8\.png)[\s\S]{0,200}?(\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (clock) {
    return clock[1].split(":").reduce(function(seconds, part) { return seconds * 60 + Number(part); }, 0) * 1000;
  }
  var explicitMs = row.match(/(?:data-duration-ms|duration_ms)\s*[=:]\s*["']?(\d+)/i);
  if (explicitMs) return Number(explicitMs[1]);
  var value = firstMatch(row, [
    /data-duration\s*=\s*["'](\d+)["']/i,
    /duration\s*[=:]\s*["']?(\d{2,6})/i
  ]);
  if (!value) return 0;
  if (String(value).indexOf(":") >= 0) {
    var parts = String(value).split(":");
    return (parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10)) * 1000;
  }
  return parseInt(value, 10) * 1000;
}

function getArtistId(row) {
  return firstMatch(row, [
    /fnViewArtist\s*\(\s*["']?(\d+)/i,
    /fnGoMore\s*\(\s*["']artistInfo["']\s*,\s*["']?(\d+)/i,
    /artistInfo[^"']*[?&]xxnm=(\d+)/i
  ]);
}

function getIsrc(row) {
  return firstMatch(row, [
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

  if (!name || !artists) return null;

  return {
    id: String(id),
    name: name,
    artists: artists,
    album_name: albumName,
    album_id: albumId,
    artist_id: getArtistId(row),
    cover_url: coverUrl,
    duration_ms: getDurationMs(row),
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
    uri: "genie-music:track:" + String(track.id),
    type: "track",
    name: track.name || "",
    artists: track.artists || "",
    album_name: track.album_name || "",
    album_id: track.album_id || "",
    album_url: track.album_id ? "https://www.genie.co.kr/detail/albumInfo?axnm=" + track.album_id : "",
    artist_id: track.artist_id || "",
    artist_url: track.artist_id ? "https://www.genie.co.kr/detail/artistInfo?xxnm=" + track.artist_id : "",
    cover_url: track.cover_url || "",
    images: track.cover_url || "",
    item_type: "track",
    duration_ms: Number(track.duration_ms || 0),
    isrc: track.isrc || "",
    release_date: track.release_date || "",
    track_number: Number(track.track_number || 0),
    genre: track.genre || "",
    composer: track.composer || "",
    external_urls: "https://www.genie.co.kr/detail/songInfo?xgnm=" + String(track.id),
    external_links: { genie: "https://www.genie.co.kr/detail/songInfo?xgnm=" + String(track.id), source: "https://www.genie.co.kr/detail/songInfo?xgnm=" + String(track.id) },
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
    uri: "genie-music:album:" + String(id),
    type: "album",
    item_type: "album",
    name: name,
    artists: "Genie Music",
    album_type: "compilation",
    total_tracks: list.length,
    cover_url: cover || ((list.filter(function(t){return t.cover_url;})[0] || {}).cover_url),
    images: cover || ((list.filter(function(t){return t.cover_url;})[0] || {}).cover_url) || "",
    provider_id: PROVIDER_ID,
    tracks: list.map(makeTrackResult)
  };
}

function fetchHtml(url) {
  var response = http.get(url, {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html,application/xhtml+xml"
  });
  if (response && response.error) throw new Error("Genie request failed: " + response.error + ": " + url);
  if (!response || !response.ok) {
    throw new Error("Genie HTTP " + (response ? response.status : "unavailable") + ": " + url);
  }
  var body = response.body || "";
  if (!body || !/<(?:html|table|div)\b/i.test(body)) throw new Error("Genie returned no HTML: " + url);
  return body;
}

function safeTracks(url) {
  try {
    return parseTracks(fetchHtml(url));
  } catch (error) {
    if (typeof log !== "undefined") log.warn(String(error));
    return [];
  }
}

function searchTracks(query, limit) {
  if (!query || !String(query).trim()) return { tracks: [], total: 0 };
  var html = fetchHtml("https://www.genie.co.kr/search/searchMain?query=" + encodeURIComponent(String(query).trim()));
  var tracks = parseTracks(primaryTrackTable(html));
  if (!tracks.length && !/검색결과|class=["'][^"']*\bno-result\b/i.test(html)) {
    throw new Error("Genie search metadata is unavailable");
  }
  var count = Math.max(1, Math.min(100, Number(limit) || 50));
  return { tracks: tracks.slice(0, count).map(makeTrackResult), total: tracks.length };
}

function resourceId(value, kind) {
  var id = String(value || "").replace(new RegExp("^" + PROVIDER_ID + ":" + kind + ":"), "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Invalid Genie " + kind + " ID");
  return id;
}

function mainInfo(html, className) {
  var start = html.search(new RegExp("<div[^>]*class=[\"'][^\"']*\\b" + className + "\\b", "i"));
  if (start < 0) throw new Error("Genie " + className + " metadata is unavailable");
  var end = html.indexOf("<!-- E. info-zone", start);
  if (end < 0) end = html.indexOf('class="song-list"', start);
  return html.slice(start, end < 0 ? start + 18000 : end);
}

function infoValue(html, imageNumber) {
  return firstMatch(html, [new RegExp("txt_" + imageNumber + "\\.png[^>]*>[\\s\\S]{0,150}?<span[^>]*class=[\"']value[\"'][^>]*>([\\s\\S]*?)</span>", "i")]);
}

function primaryTrackTable(html) {
  var table = html.match(/<table[^>]*class=["'][^"']*\blist-wrap\b[^"']*["'][^>]*>[\s\S]*?<\/table>/i);
  return table ? table[0] : "";
}

function detailName(html) {
  return firstMatch(html, [/<h2[^>]*class=["'][^"']*\bname\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i]);
}

function getTrack(trackId) {
  var id = resourceId(trackId, "track");
  var cached = TRACK_CACHE[id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.track;
  var html = fetchHtml("https://www.genie.co.kr/detail/songInfo?xgnm=" + id);
  var main = mainInfo(html, "song-main-infos");
  var identity = firstMatch(html, [/var\s+iSnsSeq\s*=\s*["'](\d+)["']/i, /songInfo\?xgnm=(\d+)/i]);
  if (identity && identity !== id) throw new Error("Genie returned a different track");
  var track = {
    id: id,
    name: detailName(main),
    artists: infoValue(main, 5),
    artist_id: getArtistId(main),
    album_name: infoValue(main, 6),
    album_id: getAlbumId(main),
    cover_url: getCoverUrl(main),
    duration_ms: getDurationMs(main),
    genre: infoValue(main, 7),
    composer: infoValue(main, 19),
    isrc: getIsrc(main)
  };
  if (!track.name || !track.artists || !track.album_id) throw new Error("Genie track metadata is incomplete: " + id);
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

function customSearch(query, options) {
  var limit = options && typeof options === "object" ? options.limit : options;
  return searchTracks(query, limit).tracks;
}

function getAlbum(albumId) {
  var id = String(albumId || "").replace("genie-music:album:", "").trim();
  if (ALBUM_CACHE[id] && Date.now() - ALBUM_CACHE[id].time < CACHE_TTL_MS) return ALBUM_CACHE[id].value;

  var dj = id.match(/^genie-dj-(\d+)$/);
  if (dj) {
    var playlist = getPlaylist(dj[1]);
    return makeVirtualAlbum(id, playlist.name, playlist.tracks, playlist.cover_url);
  }
  var genre = genieGenreDefinition(id);
  if (genre) return genieGenreAlbum(genre);
  var period = genieChartDefinition(id);
  if (period && period.id !== "genie-top200") return genieChartAlbum(period);
  if (id === "genie-top200" || id === "top200" || id === "genie-top200-day") {
    var cached = Date.now() - TOP200_CACHE_TIME < CACHE_TTL_MS ? TOP200_CACHE : [];
    if (!cached.length) {
      cached = loadTop200();
      TOP200_CACHE = cached;
      TOP200_CACHE_TIME = Date.now();
    }
    if (!cached.length) throw new Error("Genie chart is unavailable");
    var virtual = makeVirtualAlbum("genie-top200", "지니 TOP 200", cached, cached[0].cover_url);
    cacheStore(ALBUM_CACHE, id, { time: Date.now(), value: virtual });
    return virtual;
  }

  id = resourceId(id, "album");
  var html = fetchHtml("https://www.genie.co.kr/detail/albumInfo?axnm=" + id);
  var identity = firstMatch(html, [/var\s+iSnsSeq\s*=\s*["'](\d+)["']/i]);
  if (identity && identity !== id) throw new Error("Genie returned another album");
  var main = mainInfo(html, "album-detail-infos");
  var pageAlbumName = detailName(main);
  var pageCover = getCoverUrl(main);
  var pageArtist = infoValue(main, 5);
  var artistId = getArtistId(main);
  var releaseDate = infoValue(main, 12).replace(/\./g, "-");
  var tracks = parseTracks(primaryTrackTable(html)).filter(function(t) { return !t.album_id || t.album_id === id; });
  if (!pageAlbumName || !pageArtist || !tracks.length) throw new Error("Genie album metadata is incomplete: " + id);
  tracks = tracks.map(function(t, index) {
    t.album_id = id;
    t.album_name = pageAlbumName;
    t.cover_url = pageCover;
    t.artist_id = t.artist_id || artistId;
    t.release_date = releaseDate;
    t.track_number = index + 1;
    t.genre = infoValue(main, 10);
    return t;
  });
  fillTrackDurations(tracks);
  var cover = pageCover || (tracks.length ? tracks[0].cover_url : "");
  var album = {
    id: id,
    uri: "genie-music:album:" + id,
    type: "album",
    item_type: "album",
    name: pageAlbumName,
    artists: pageArtist,
    artist_id: artistId,
    release_date: releaseDate,
    total_tracks: tracks.length,
    album_type: "album",
    cover_url: cover,
    images: cover || "",
    provider_id: PROVIDER_ID,
    tracks: tracks.map(makeTrackResult)
  };
  cacheStore(ALBUM_CACHE, id, { time: Date.now(), value: album });
  return album;
}

// Album rows carry no running time; each song page does. Lookups stop at a
// budget so a long album still opens within the host timeout.
function fillTrackDurations(tracks) {
  var started = Date.now(), lookups = 0;
  for (var i = 0; i < tracks.length; i++) {
    if (tracks[i].duration_ms) continue;
    if (lookups >= DURATION_LOOKUP_LIMIT || Date.now() - started >= DURATION_LOOKUP_BUDGET_MS) return;
    lookups++;
    try {
      var detail = getTrack(tracks[i].id);
      tracks[i].duration_ms = detail.duration_ms;
      tracks[i].composer = tracks[i].composer || detail.composer;
    } catch (error) {
      log.warn("Genie track duration unavailable: " + String(error.message || error));
    }
  }
}

var GENIE_PERIOD_CHARTS = [
  { id: "genie-top200-realtime", title: "지니 TOP 200 실시간", query: "ditc=D&rtm=Y" },
  { id: "genie-top200", title: "지니 TOP 200 일간", query: "ditc=D&rtm=N" },
  { id: "genie-top200-week", title: "지니 TOP 200 주간", query: "ditc=W&rtm=N" },
  { id: "genie-top200-month", title: "지니 TOP 200 월간", query: "ditc=M&rtm=N" }
];
var GENIE_GENRE_CHARTS = [
  {code: "M0100", name: "가요"}, {code: "M0200", name: "POP"},
  {code: "M0300", name: "OST"}, {code: "M0107", name: "트롯"},
  {code: "M0500", name: "JAZZ"}, {code: "M0600", name: "CLASSIC"},
  {code: "E0000", name: "EDM"}, {code: "M0400", name: "JPOP"},
  {code: "M0700", name: "뉴에이지"}, {code: "M0800", name: "CCM"}
];

function genieGenreDefinition(id) {
  for (var i = 0; i < GENIE_GENRE_CHARTS.length; i++) {
    if (id === "genie-genre-" + GENIE_GENRE_CHARTS[i].code) return GENIE_GENRE_CHARTS[i];
  }
  return null;
}

function genieGenreAlbum(definition) {
  var id = "genie-genre-" + definition.code, cached = CHART_CACHE[id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;
  var tracks = firstAvailable(["https://www.genie.co.kr/chart/genre?ditc=D&genrecode=" + definition.code], 100);
  if (!tracks.length) throw new Error("Genie genre chart is unavailable: " + definition.code);
  var album = makeVirtualAlbum(id, "지니 " + definition.name + " 일간", tracks, tracks[0].cover_url);
  cacheStore(CHART_CACHE, id, { time: Date.now(), value: album });
  return album;
}

function genieChartDefinition(id) {
  if (id === "top200" || id === "genie-top200-day") id = "genie-top200";
  for (var i = 0; i < GENIE_PERIOD_CHARTS.length; i++) {
    if (GENIE_PERIOD_CHARTS[i].id === id) return GENIE_PERIOD_CHARTS[i];
  }
  return null;
}

function genieChartAlbum(definition) {
  var cached = CHART_CACHE[definition.id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;
  var all = [], seen = {};
  for (var page = 1; page <= 4; page++) {
    var tracks = safeTracks("https://www.genie.co.kr/chart/top200?" + definition.query + "&pg=" + page);
    if (!tracks.length) {
      if (page > 1) throw new Error("Genie chart page is unavailable: " + page);
      break;
    }
    var added = 0;
    for (var i = 0; i < tracks.length; i++) {
      if (seen[tracks[i].id]) continue;
      seen[tracks[i].id] = true;
      all.push(tracks[i]);
      added++;
    }
    if (added === 0 || tracks.length < 50) break;
  }
  if (!all.length) throw new Error("Genie chart is unavailable: " + definition.id);
  all = all.slice(0, 200);
  var album = makeVirtualAlbum(definition.id, definition.title, all, all[0].cover_url);
  cacheStore(CHART_CACHE, definition.id, { time: Date.now(), value: album });
  return album;
}

function loadTop200() {
  return genieChartAlbum(GENIE_PERIOD_CHARTS[1]).tracks;
}

function getPlaylist(playlistId) {
  var id = resourceId(playlistId, "playlist"), cached = DJ_CACHE[id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.value;
  var html = fetchHtml("https://www.genie.co.kr/playlist/detailView?plmSeq=" + id);
  var tracks = uniqueTracks(parseTracks(primaryTrackTable(html)));
  if (!tracks.length) throw new Error("Genie DJ playlist is unavailable: " + id);
  var title = firstMatch(html, [/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i]);
  title = title.replace(/\s*-\s*genie\s*$/i, "");
  if (!title) throw new Error("Genie DJ playlist title is unavailable: " + id);
  var cover = normalizeCoverUrl(firstMatch(html, [/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i])) || tracks[0].cover_url;
  var playlist = makeVirtualAlbum(id, title, tracks, cover);
  playlist.type = playlist.item_type = "playlist";
  playlist.uri = PROVIDER_ID + ":playlist:" + id;
  cacheStore(DJ_CACHE, id, { time: Date.now(), value: playlist });
  return playlist;
}

function genieDjItems() {
  var html = fetchHtml("https://www.genie.co.kr/");
  var pattern = /plmSeq=(\d+)/g, match, seen = {}, items = [];
  while ((match = pattern.exec(html)) && items.length < 8) {
    var id = match[1];
    if (seen[id]) continue;
    seen[id] = true;
    // Load one playlist page only when it is opened, not once per home card.
    items.push({ id: "genie-dj-" + id, uri: PROVIDER_ID + ":album:genie-dj-" + id,
      type: "album", item_type: "album", name: "지니 DJ 플레이리스트 " + id,
      artists: "Genie DJ", cover_url: "", images: "", total_tracks: 0,
      provider_id: PROVIDER_ID, tracks: [] });
  }
  return items;
}

function uniqueTracks(list) { var seen = {}; return (list || []).filter(function(t){ var k=String(t.id||""); if(!k||seen[k]) return false; seen[k]=true; return true; }); }
function firstAvailable(urls, limit) { for (var i=0;i<urls.length;i++){ var a=safeTracks(urls[i]); if(a.length) return a.slice(0,limit||50); } return []; }
function getHomeFeed() {
  if (FEED_CACHE.feed && Date.now() - FEED_CACHE.time < CACHE_TTL_MS) return FEED_CACHE.feed;
  var top = loadTop200();
  TOP200_CACHE = top;
  TOP200_CACHE_TIME = Date.now();
  var latest=firstAvailable(["https://www.genie.co.kr/newest/song"],50);
  var genres = GENIE_GENRE_CHARTS;
  var sections=[];
  if(top.length) sections.push({uri:"genie-music:top200",title:"지니 TOP 200",items:[makeVirtualAlbum("genie-top200","지니 TOP 200",top,top[0].cover_url)]});
  if (top.length) {
    for (var period = 0; period < GENIE_PERIOD_CHARTS.length; period++) {
      if (period === 1) continue;
      var definition = GENIE_PERIOD_CHARTS[period];
      sections[0].items.push(makeVirtualAlbum(definition.id, definition.title, [], ""));
    }
  }
  if(latest.length) sections.push(makeSection("genie-music:latest","최신음악",latest));
  for (var i = 0; i < genres.length; i++) {
    try {
      var genre = genieGenreAlbum(genres[i]);
      sections.push({ uri: PROVIDER_ID + ":genre:" + genres[i].code, title: genres[i].name, items: [genre] });
    } catch (error) {
      log.warn("Genie optional genre chart unavailable: " + genres[i].code);
    }
  }
  try {
    var djItems = genieDjItems();
    if (djItems.length) sections.push({ uri: PROVIDER_ID + ":dj-playlists", title: "지니 DJ 플레이리스트", items: djItems });
  } catch (error) {
    log.warn("Genie DJ playlists unavailable");
  }
  if (!sections.length) throw new Error("Genie home feed is unavailable");
  var feed = {success:true,greeting:"Genie Music",sections:sections};
  FEED_CACHE = { time: Date.now(), feed: feed };
  return feed;
}

function enrichTrack(track) {
  if (!track || !track.id) throw new Error("Genie enrichment requires a track ID");
  if (track.provider_id && track.provider_id !== PROVIDER_ID) return track;
  var detail = getTrack(track.id), result = Object.assign({}, track);
  Object.keys(detail).forEach(function(key) {
    if (detail[key] !== "" && detail[key] !== 0) result[key] = detail[key];
  });
  result.external_links = Object.assign({}, track.external_links || {}, detail.external_links);
  return result;
}

function parseArtistAlbums(html, artistId, artistName) {
  var rows = html.match(/<li[^>]*class=["'][^"']*\blist-album\b[^"']*["'][^>]*>[\s\S]*?<\/dl>/gi) || [];
  var seen = {};
  var albums = [];
  rows.forEach(function(row) {
    var id = getAlbumId(row);
    var name = firstMatch(row, [/<dt[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i]);
    if (!id || !name || seen[id]) return;
    seen[id] = true;
    albums.push({
      id: id,
      uri: PROVIDER_ID + ":album:" + id,
      name: name,
      artists: getArtistName(row) || artistName,
      artist_id: artistId,
      release_date: firstMatch(row, [/<dd[^>]*class=["']desc["'][^>]*>\s*(\d{4}\.\d{2}\.\d{2})/i]).replace(/\./g, "-"),
      total_tracks: Number(firstMatch(row, [/<dd[^>]*class=["']desc["'][^>]*>[\s\S]*?(\d+)곡/i])) || 0,
      album_type: /싱글\/EP/.test(row) ? "single" : /컴필레이션/.test(row) ? "compilation" : "album",
      cover_url: getCoverUrl(row),
      provider_id: PROVIDER_ID,
      item_type: "album",
      type: "album",
      tracks: []
    });
  });
  return albums;
}

function getArtist(artistId) {
  var value = String(artistId || "").replace(PROVIDER_ID + ":artist:", "").trim();
  var match = value.match(/^(\d+)(?::albums:(\d+))?$/);
  if (!match) throw new Error("Invalid Genie artist ID");
  var id = match[1], page = Number(match[2] || "1");
  // Keep the ten-item offset within JavaScript's exact integer range.
  if (page < 1 || page > 900719925474099) throw new Error("Invalid Genie album page");
  var main = "", artistHtml = "";
  var identity = ARTIST_CACHE[id];
  if (page === 1 || !identity || Date.now() - identity.time >= CACHE_TTL_MS) {
    artistHtml = fetchHtml("https://www.genie.co.kr/detail/artistInfo?xxnm=" + id);
    main = mainInfo(artistHtml, "artist-main-infos");
    var artistName = detailName(main);
    if (!artistName) throw new Error("Genie artist metadata is incomplete: " + id);
    identity = { time: Date.now(), name: artistName, image_url: getCoverUrl(main) };
    cacheStore(ARTIST_CACHE, id, identity);
  }
  var html = fetchHtml(page === 1 ? "https://www.genie.co.kr/detail/artistAlbum?xxnm=" + id
    : "https://www.genie.co.kr/detail/bArtistAlbumList?xxnm=" + id + "&pg=" + page + "&pgsize=10&otype=newest&atype=ALL");
  var albums = parseArtistAlbums(html, id, identity.name);
  var totalText = firstMatch(html, [/전체\s*<strong>\s*([\d,]+)\s*<\/strong>/i]).replace(/,/g, "");
  var total = totalText ? Number(totalText) : albums.length;
  if (!albums.length && totalText !== "0") {
    throw new Error("Genie artist album list is unavailable: " + id);
  }
  return {
    id: id, uri: PROVIDER_ID + ":artist:" + id, type: "artist",
    name: identity.name, provider_id: PROVIDER_ID,
    image_url: identity.image_url, albums: albums,
    albums_next: page * 10 < total && albums.length ? id + ":albums:" + (page + 1) : "",
    top_tracks: page === 1 ? parseTracks(primaryTrackTable(artistHtml)).map(makeTrackResult) : []
  };
}

function handleUrl(url) {
  var dj = String(url || "").match(/^https?:\/\/(?:[a-z0-9-]+\.)*genie\.co\.kr\/playlist\/detailView\?([^#]*)/i);
  if (dj) {
    var sequence = firstMatch(dj[1].replace(/&amp;/gi, "&"), [/(?:^|&)plmSeq=(\d+)(?:&|$)/i]);
    if (!sequence) throw new Error("Genie URL has no valid playlist ID");
    var playlist = getPlaylist(sequence);
    return { type: "playlist", id: sequence, name: playlist.name, cover_url: playlist.cover_url,
      playlist: playlist, tracks: playlist.tracks };
  }
  // Mobile and other Genie subdomains share the desktop detail paths.
  var match = String(url || "").match(/^https?:\/\/(?:[a-z0-9-]+\.)*genie\.co\.kr\/detail\/(songInfo|albumInfo|artistInfo)\?([^#]*)/i);
  if (!match) return null;
  var parameters = match[2].replace(/&amp;/gi, "&");
  var key = match[1].toLowerCase() === "songinfo" ? "xgnm" : match[1].toLowerCase() === "albuminfo" ? "axnm" : "xxnm";
  var id = firstMatch(parameters, [new RegExp("(?:^|&)" + key + "=(\\d+)(?:&|$)", "i")]);
  if (!id) throw new Error("Genie URL has no valid resource ID");
  if (key === "xgnm") {
    var track = getTrack(id);
    return { type: "track", id: id, name: track.name, cover_url: track.cover_url, track: track };
  }
  if (key === "axnm") {
    var album = getAlbum(id);
    return { type: "album", id: id, name: album.name, cover_url: album.cover_url, album: album, tracks: album.tracks };
  }
  var artist = getArtist(id);
  return { type: "artist", id: id, name: artist.name, cover_url: artist.image_url, artist: artist };
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  searchTracks: searchTracks,
  customSearch: customSearch,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  getHomeFeed: getHomeFeed,
  getPlaylist: getPlaylist,
  enrichTrack: enrichTrack,
  handleUrl: handleUrl
});
