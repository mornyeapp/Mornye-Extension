var BASE_URL = "https://www.melon.com";
var MOBILE_API_URL = "https://m2.melon.com/m6/v1";
var MOBILE_WEB_URL = "https://m.app.melon.com";
var MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
var PROVIDER_ID = "melon-music";
var FEED_CACHE = {};
var TRACK_CACHE = {};
var ALBUM_CACHE = {};
var CACHE_TTL_MS = 5 * 60 * 1000;

function initialize() {
  return {
    success: true
  };
}

function cleanup() {
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
    .replace(/&#(x[0-9a-f]+|\d+);/gi, function (_, value) {
      var code = value.charAt(0).toLowerCase() === "x" ? parseInt(value.slice(1), 16) : parseInt(value, 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    })
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
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
  return firstMatch(row, [/data-song-no\s*=\s*["'](\d+)["']/i, /goSongDetail\(\s*["']?(\d+)/i, /playSong\(\s*["']?\d+["']?\s*,\s*["']?(\d+)/i]);
}

function getTrackName(row) {
  return firstMatch(row, [
    /<a\b[^>]*href=["'][^>]*playSong\([^>]*>([\s\S]*?)<\/a>/i,
    // Songs Melon cannot stream, such as CD-only demos, show an unlinked title.
    /<div\b[^>]*class=["'][^"']*\bwrap_song_info\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*class=["']disabled["'][^>]*>([\s\S]*?)<\/span>/i
  ]);
}

function getArtistName(row) {
  return artistInfo(row).name;
}

function artistInfo(html) {
  var names = [], ids = [], seen = {};
  var re = /<a\b[^>]*href=["'][^>]*(?:goArtistDetail\(\s*["']?|\/artist\/(?:detail|timeline)\.htm\?artistId=)(\d+)[^>]*>([\s\S]*?)<\/a>/gi, match;
  while ((match = re.exec(html)) !== null) {
    var name = cleanText(match[2]);
    if (name && !seen[match[1]]) {
      seen[match[1]] = true;
      names.push(name);
      ids.push(match[1]);
    }
  }
  return { name: names.join(", "), id: ids[0] || "" };
}

function elementContent(html, tag, className) {
  var open = new RegExp("<" + tag + "\\b[^>]*class=[\\\"'][^\\\"']*\\b" + className + "\\b[^\\\"']*[\\\"'][^>]*>", "i").exec(html);
  if (!open) return "";
  var start = open.index + open[0].length, depth = 1;
  var tags = new RegExp("</?" + tag + "\\b[^>]*>", "gi"), match;
  tags.lastIndex = start;
  while ((match = tags.exec(html)) !== null) {
    depth += match[0].slice(0, 2) === "</" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return "";
}

function visibleText(html) {
  return cleanText(html.replace(/<(?:strong|span)\b[^>]*class=["'][^"']*\bnone\b[^"']*["'][^>]*>[\s\S]*?<\/(?:strong|span)>/gi, ""));
}

function structuredData(html, type) {
  var scripts = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, match;
  while ((match = scripts.exec(html)) !== null) {
    try {
      var parsed = JSON.parse(match[1]);
      var values = Array.isArray(parsed) ? parsed : (parsed["@graph"] || [parsed]);
      for (var i = 0; i < values.length; i++) {
        if (values[i]["@type"] === type) return values[i];
      }
    } catch (_) {}
  }
  return {};
}

function pageMeta(html, name) {
  return firstMatch(html, [new RegExp("<meta\\b[^>]*property=[\\\"']" + name + "[\\\"'][^>]*content=[\\\"']([^\\\"']+)[\\\"']", "i")]);
}

function detailValue(html, label) {
  return firstMatch(html, [new RegExp("<dt\\b[^>]*>\\s*" + label + "\\s*</dt>\\s*<dd\\b[^>]*>([\\s\\S]*?)</dd>", "i")]);
}

function releaseDate(html) {
  return detailValue(html, "발매일").replace(/\./g, "-");
}

function resourceId(value, type) {
  var id = String(value || "").replace(new RegExp("^" + PROVIDER_ID + ":" + type + ":"), "").trim();
  if (!/^\d+$/.test(id)) throw new Error("Melon " + type + " ID must be numeric");
  return id;
}

function getAlbumId(row) {
  return firstMatch(row, [
    /data-album-id\s*=\s*["'](\d+)["']/i,
    /href\s*=\s*["'][^"']*album\/detail\.htm\?[^"']*albumId=(\d+)/i,
    /href\s*=\s*["'][^"']*[?&]albumId=(\d+)[^"']*["']/i,
    /albumId(?:=|\s*[=:])\s*["']?(\d+)/i,
    /albumNo(?:=|\s*[=:])\s*["']?(\d+)/i,
    /goAlbumDetail\((?:\s*["']?)(\d+)/i,
    /albumId["']?\s*[:=]\s*["']?(\d+)/i,
    /albnm\s*[=:]\s*["']?(\d+)/i
  ]);
}

function getAlbumName(row) {
  var anchors = /<a\b[^>]*href=["'][^>]*(?:goAlbumDetail\(|\/album\/detail\.htm\?albumId=)[^>]*>([\s\S]*?)<\/a>/gi, match;
  while ((match = anchors.exec(row)) !== null) {
    var name = cleanText(match[1]);
    if (name) return name;
  }
  return "";
}

function normalizeCoverUrl(url) {
  if (!url) return "";
  url = absoluteUrl(url).replace(/^http:/i, "https:");
  // Strip Melon's transformation query to preserve the original 500px asset.
  return url.replace(/\?[^#]*$/, "").replace(/\/melon\/resize\/[^#]*$/, "");
}

function getCoverUrl(row) {
  var patterns = [
    /<a[^>]*class=["'][^"']*thumbnail[^"']*["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["']/i,
    /<a[^>]*class=["'][^"']*thumbnail[^"']*["'][^>]*>[\s\S]*?<img[^>]*data-original=["']([^"']+)["']/i,
    /<img[^>]*data-original=["']([^"']+)["']/i,
    /<img[^>]*data-src=["']([^"']+)["']/i,
    /<img[^>]*data-lazy-src=["']([^"']+)["']/i,
    /<img[^>]*srcset=["']([^"']+)["']/i,
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
  var millis = firstMatch(row, [/data-duration-ms\s*=\s*["'](\d+)["']/i, /duration_ms\s*[=:]\s*["']?(\d+)/i]);
  if (millis) return Number(millis);
  var seconds = firstMatch(row, [/data-duration\s*=\s*["'](\d+)["']/i]);
  if (seconds) return Number(seconds) * 1000;
  var clock = row.match(/(?:재생시간|재생 시간)[^0-9]{0,80}(\d{1,3}):(\d{2})/i);
  if (clock) return (Number(clock[1]) * 60 + Number(clock[2])) * 1000;
  return 0;
}

function isoDurationMs(value) {
  var match = String(value || "").match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  return match ? Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000) : 0;
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
    artist_id: artistInfo(row).id,
    album_name: albumName,
    album_id: albumId,
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

  if (tracks.length === 0) {
    var listItems = html.match(
      /<li[^>]*>[\s\S]*?<\/li>/gi
    ) || [];

    for (var j = 0; j < listItems.length; j++) {
      var listTrack = parseTrackRow(listItems[j]);

      if (!listTrack || !listTrack.id) {
        continue;
      }

      if (seen[listTrack.id]) {
        continue;
      }

      seen[listTrack.id] = true;
      tracks.push(listTrack);
    }
  }

  if (tracks.length === 0) {
    var divBlocks = html.match(
      /<div[^>]*>[\s\S]*?<\/div>/gi
    ) || [];

    for (var k = 0; k < divBlocks.length; k++) {
      var divTrack = parseTrackRow(divBlocks[k]);

      if (!divTrack || !divTrack.id) {
        continue;
      }

      if (seen[divTrack.id]) {
        continue;
      }

      seen[divTrack.id] = true;
      tracks.push(divTrack);
    }
  }

  return tracks;
}

function makeTrackResult(track) {
  return {
    id: String(track.id),
    uri: PROVIDER_ID + ":track:" + String(track.id),
    type: "track",
    name: track.name || "",
    artists: track.artists || "",
    artist_id: track.artist_id || "",
    artist_url: track.artist_id ? BASE_URL + "/artist/timeline.htm?artistId=" + track.artist_id : "",
    album_artist: track.album_artist || track.artists || "",
    album_name: track.album_name || "",
    album_id: track.album_id || "",
    album_url: track.album_id ? BASE_URL + "/album/detail.htm?albumId=" + track.album_id : "",
    album_uri: track.album_id ? "melon-music:album:" + String(track.album_id) : "",
    album: {
      id: String(track.album_id || ""),
      uri: track.album_id ? "melon-music:album:" + String(track.album_id) : "",
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
    release_date: track.release_date || "",
    track_number: Number(track.track_number || 0),
    disc_number: Number(track.disc_number || 0),
    total_tracks: Number(track.total_tracks || 0),
    genre: track.genre || "",
    composer: track.composer || "",
    label: track.label || "",
    external_urls: BASE_URL + "/song/detail.htm?songId=" + String(track.id),
    external_links: { melon: "https://www.melon.com/song/detail.htm?songId=" + String(track.id), source: "https://www.melon.com/song/detail.htm?songId=" + String(track.id) },
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
    uri: PROVIDER_ID + ":album:" + String(id),
    type: "album",
    item_type: "album",
    name: name,
    artists: "Melon Music",
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
    throw new Error("Melon HTTP " + (response ? response.status : "no response") + ": " + url);
  }
  return response.body || "";
}

function safeTracks(url) {
  var html = fetchHtml(url);
  var tracks = parseTracks(html);
  if (!tracks.length) throw new Error("Melon song list was empty or unrecognized: " + url);
  return tracks;
}

// The web pages omit running times and disc numbers; the mobile app's JSON
// carries them. A failure leaves those fields empty instead of failing the page.
function mobileJson(path) {
  try {
    var response = http.get(MOBILE_API_URL + path, {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    });
    var data = response && response.ok ? JSON.parse(response.body || "{}") : null;
    return data && data.response && String(data.response.RESULTCODE) === "0" ? data.response : null;
  } catch (error) {
    log.warn("Melon mobile metadata unavailable: " + String(error.message || error));
    return null;
  }
}

function playTimeMs(value) {
  var seconds = Number(value);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function listNames(list, key) {
  return (Array.isArray(list) ? list : []).map(function (item) {
    return cleanText(item && item[key]);
  }).filter(Boolean).join(", ");
}

// Desktop search rows have no artwork; the mobile web results carry each
// song's album image.
function fillSearchCovers(tracks, query) {
  if (!tracks.some(function (track) { return !track.cover_url; })) return;
  try {
    var response = http.get(MOBILE_WEB_URL + "/search/mobile4web/searchsong_list.htm?keyword=" +
      encodeURIComponent(query) + "&startIndex=1&pageSize=" + tracks.length, {
      "User-Agent": MOBILE_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml"
    });
    if (!response || !response.ok) return;
    var bySong = {}, byAlbum = {};
    (String(response.body || "").match(/<li\b[^>]*\bd-songId=["']\d+["'][^>]*>/gi) || []).forEach(function (tag) {
      var cover = normalizeCoverUrl(firstMatch(tag, [/\bd-albumImage=["']([^"']+)["']/i]));
      if (!cover) return;
      bySong[firstMatch(tag, [/\bd-songId=["'](\d+)["']/i])] = cover;
      byAlbum[firstMatch(tag, [/\bd-albumId=["'](\d+)["']/i])] = cover;
    });
    tracks.forEach(function (track) {
      track.cover_url = track.cover_url || bySong[track.id] || byAlbum[track.album_id] || "";
    });
  } catch (error) {
    log.warn("Melon search artwork unavailable: " + String(error.message || error));
  }
}

function searchTracks(query, limit) {
  if (!query || !String(query).trim()) return [];
  var url = BASE_URL + "/search/song/index.htm?q=" + encodeURIComponent(String(query).trim());
  var html = fetchHtml(url), tracks = parseTracks(html);
  if (!tracks.length && !/검색결과가 없습니다|검색 결과가 없습니다|검색된 결과가 없습니다|검색된 곡이 없습니다|결과가 없습니다/.test(cleanText(html))) {
    throw new Error("Melon search response was unrecognized: " + url);
  }
  var count = Number(limit);
  if (!(count > 0)) count = 50;
  tracks = tracks.slice(0, Math.min(100, count));
  if (tracks.length) fillSearchCovers(tracks, String(query).trim());
  return tracks.map(makeTrackResult);
}

function getTrack(trackId) {
  var id = resourceId(trackId, "track");
  var cached = TRACK_CACHE[id];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.track;
  var html = fetchHtml(BASE_URL + "/song/detail.htm?songId=" + id);
  var page = structuredData(html, "MusicRecording");
  var detail = elementContent(html, "div", "section_info");
  var artist = artistInfo(elementContent(detail, "div", "artist"));
  var actualId = firstMatch(page.sameAs || pageMeta(html, "og:url"), [/songId=(\d+)/i]);
  var metaId = firstMatch(pageMeta(html, "og:url"), [/songId=(\d+)/i]);
  if (actualId && actualId !== id) throw new Error("Melon returned another track: " + actualId);
  if (metaId && metaId !== id) throw new Error("Melon returned another track: " + metaId);
  var album = page.inAlbum || {};
  var track = {
    id: id,
    name: cleanText(page.name || visibleText(elementContent(detail, "div", "song_name"))),
    artists: artist.name,
    artist_id: artist.id,
    album_name: cleanText(album.name || detailValue(detail, "앨범")),
    album_id: firstMatch(album["@id"] || "", [/albumId=(\d+)/i]) || getAlbumId(detail),
    cover_url: normalizeCoverUrl(page.image || pageMeta(html, "og:image")),
    duration_ms: isoDurationMs(page.duration) || getDurationMs(detail),
    isrc: page.isrcCode || getIsrc(detail),
    release_date: releaseDate(detail),
    genre: detailValue(detail, "장르")
  };
  if (!track.name || !track.artists || !track.album_id || !track.album_name) {
    throw new Error("Melon track metadata was incomplete or unrecognized: " + id);
  }
  if (!track.duration_ms) {
    var info = mobileJson("/song/info.json?songId=" + id);
    var song = info && info.SONGINFO;
    if (song && String(song.SONGID) === id) {
      track.duration_ms = playTimeMs(song.PLAYTIME);
      track.genre = track.genre || listNames(info.GENRELIST, "GENRENAME");
      track.composer = listNames(info.CMPSRLIST, "ARTISTNAME");
    }
  }
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
  return searchTracks(query, limit);
}

function getAlbum(albumId) {
  var id = String(albumId || "").replace(PROVIDER_ID + ":album:", "").trim();
  var chart = melonChartById(id);
  if (chart) {
    var cached = chartTracks(chart.key);
    return makeVirtualAlbum(id, chart.title, cached, cached[0].cover_url);
  }
  id = resourceId(id, "album");
  var cachedAlbum = ALBUM_CACHE[id];
  if (cachedAlbum && Date.now() - cachedAlbum.time < CACHE_TTL_MS) return cachedAlbum.value;
  var html = fetchHtml(BASE_URL + "/album/detail.htm?albumId=" + id);
  var page = structuredData(html, "MusicAlbum");
  var detail = elementContent(html, "div", "section_info");
  var name = cleanText(page.name || visibleText(elementContent(detail, "div", "song_name")));
  var actualId = firstMatch(page.sameAs || pageMeta(html, "og:url"), [/albumId=(\d+)/i]);
  var metaId = firstMatch(pageMeta(html, "og:url"), [/albumId=(\d+)/i]);
  if (actualId && actualId !== id) throw new Error("Melon returned another album: " + actualId);
  if (metaId && metaId !== id) throw new Error("Melon returned another album: " + metaId);
  var artist = artistInfo(elementContent(detail, "div", "artist"));
  var cover = normalizeCoverUrl(page.image || pageMeta(html, "og:image"));
  var date = releaseDate(detail), genre = detailValue(detail, "장르"), label = detailValue(detail, "발매사");
  var tracks = parseTracks(elementContent(html, "div", "service_list_song"));
  if (!name || !artist.name || !tracks.length) throw new Error("Melon album metadata was incomplete or unrecognized: " + id);
  var songs = tracks.every(function (track) { return track.duration_ms; }) ? {} : albumSongs(id);
  tracks = tracks.map(function (track, index) {
    var song = songs[track.id] || {};
    track.album_id = id;
    track.album_name = name;
    track.album_artist = artist.name;
    track.cover_url = cover;
    track.release_date = date;
    track.track_number = song.number || index + 1;
    track.total_tracks = tracks.length;
    track.disc_number = song.disc || 1;
    track.duration_ms = track.duration_ms || song.duration || 0;
    track.genre = genre;
    track.label = label;
    return makeTrackResult(track);
  });
  var album = {
    id: id, uri: PROVIDER_ID + ":album:" + id, type: "album", item_type: "album",
    name: name, artists: artist.name, artist_id: artist.id,
    total_tracks: tracks.length, album_type: "album",
    cover_url: cover, images: cover, release_date: date,
    provider_id: PROVIDER_ID, tracks: tracks
  };
  cacheStore(ALBUM_CACHE, id, { time: Date.now(), value: album });
  return album;
}

function albumSongs(id) {
  var listing = mobileJson("/album/song/list.json?albumId=" + id), songs = {};
  ((listing && listing.CDLIST) || []).forEach(function (cd) {
    (cd.SONGLIST || []).forEach(function (song) {
      if (song.ALBUMID && String(song.ALBUMID) !== id) return;
      songs[String(song.SONGID)] = { disc: Number(cd.CDNO) || 0, number: Number(song.TRACKNO) || 0,
        duration: playTimeMs(song.PLAYTIME) };
    });
  });
  return songs;
}

function getPlaylist(playlistId) {
  var id = resourceId(playlistId, "playlist");
  var urls = [
    BASE_URL + "/landing/playList.htm?plylstSeq=" + id + "&plylstTypeCode=M20002&type=djc",
    BASE_URL + "/mymusic/dj/mymusicdjplaylistview_inform.htm?plylstSeq=" + id
  ];
  var html = "", tracks = [], lastError;
  for (var i = 0; i < urls.length; i++) {
    try {
      var page = fetchHtml(urls[i]);
      if (!html) html = page;
      var parsed = parseTracks(page);
      if (parsed.length) { html = page; tracks = parsed; break; }
    } catch (error) { lastError = error; }
  }
  var name = pageMeta(html, "og:title");
  if (!tracks.length || !name) throw lastError || new Error("Melon playlist metadata was incomplete or unrecognized: " + id);
  var cover = normalizeCoverUrl(pageMeta(html, "og:image"));
  return { id: id, uri: PROVIDER_ID + ":playlist:" + id, type: "playlist", item_type: "playlist",
    name: name, description: "Melon DJ", cover_url: cover, images: cover, total_tracks: tracks.length,
    tracks: tracks.map(makeTrackResult), provider_id: PROVIDER_ID };
}

var MELON_CHARTS = [
  { key: "top", id: "melon-top100", title: "멜론 TOP 100 실시간", path: "/chart/index.htm" },
  { key: "day", id: "melon-top100-day", title: "멜론 TOP 100 일간", path: "/chart/day/index.htm" },
  { key: "week", id: "melon-top100-week", title: "멜론 TOP 100 주간", path: "/chart/week/index.htm" },
  { key: "month", id: "melon-top100-month", title: "멜론 TOP 100 월간", path: "/chart/month/index.htm" },
  { key: "rise", id: "melon-top100-rise", title: "멜론 TOP 100 급상승", path: "/chart/rise/index.htm" },
  { key: "hot", id: "melon-hot100", title: "멜론 HOT 100", path: "/chart/hot100/index.htm" }
];
var MELON_GENRES = [
  ["GN0200", "댄스"], ["GN0300", "랩/힙합"], ["GN0400", "R&B/Soul"],
  ["GN0500", "인디음악"], ["GN0600", "록/메탈"], ["GN0700", "트로트"],
  ["GN0800", "포크/블루스"], ["GN0900", "해외 POP"], ["GN1000", "해외 록/메탈"],
  ["GN1100", "해외 일렉트로니카"], ["GN1200", "해외 랩/힙합"]
];
MELON_GENRES.forEach(function(genre) {
  MELON_CHARTS.push({ key: "genre-" + genre[0], id: "melon-genre-" + genre[0],
    title: "멜론 " + genre[1] + " 최신곡", path: "/genre/song_list.htm?gnrCode=" + genre[0] });
});

function melonChartById(id) {
  if (id === "top100") id = "melon-top100";
  for (var i = 0; i < MELON_CHARTS.length; i++) {
    if (MELON_CHARTS[i].id === id) return MELON_CHARTS[i];
  }
  return null;
}

function chartTracks(key) {
  var definition = null;
  for (var i = 0; i < MELON_CHARTS.length; i++) {
    if (MELON_CHARTS[i].key === key) definition = MELON_CHARTS[i];
  }
  if (!definition) throw new Error("Unknown Melon chart: " + key);
  var cached = FEED_CACHE[key];
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.tracks;
  var tracks = safeTracks(BASE_URL + definition.path).slice(0, 100);
  if (!tracks.length) throw new Error("Melon chart is unavailable: " + key);
  cacheStore(FEED_CACHE, key, { time: Date.now(), tracks: tracks });
  return tracks;
}

function optionalSection(url, title, sections) {
  try {
    sections.push(makeSection(url, title, safeTracks(url).slice(0, 50)));
  } catch (error) {
    log.warn("Melon optional home section unavailable: " + String(error.message || error));
  }
}

function djTodaySection() {
  var html = fetchHtml(BASE_URL + "/dj/today/djtoday_list.htm");
  var re = /goDjPlaylistDetail\([^)]*?['"](\d+)['"]\s*\)\s*;?["'][^>]*?title=["']([^"']*?)\s*-\s*페이지 이동["'][^>]*>\s*<img[^>]*?src=["']([^"']+)["']/gi;
  var items = [], seen = {}, m;
  while ((m = re.exec(html)) !== null) {
    var id = m[1];
    if (seen[id]) continue;
    seen[id] = true;
    var name = cleanText(m[2]);
    if (!name) continue;
    var cover = normalizeCoverUrl(m[3]);
    items.push({ id: id, uri: PROVIDER_ID + ":playlist:" + id, type: "playlist", item_type: "playlist",
      name: name, description: "Melon DJ", cover_url: cover, images: cover, provider_id: PROVIDER_ID });
  }
  if (!items.length) throw new Error("Melon DJ list was unrecognized");
  return { uri: PROVIDER_ID + ":dj-today", title: "멜론 DJ", items: items };
}

function getHomeFeed() {
  if (FEED_CACHE.home && Date.now() - FEED_CACHE.home.time < CACHE_TTL_MS) return FEED_CACHE.home.value;
  var sections = [], topItems = [], genreItems = [];
  MELON_CHARTS.forEach(function(definition) {
    if (definition.key === "hot") return;
    try {
      var tracks = chartTracks(definition.key);
      var album = makeVirtualAlbum(definition.id, definition.title, tracks, tracks[0].cover_url);
      if (definition.key.indexOf("genre-") === 0) genreItems.push(album);
      else topItems.push(album);
    } catch (error) {
      log.warn("Melon optional chart unavailable: " + definition.key);
    }
  });
  if (topItems.length) sections.push({ uri: PROVIDER_ID + ":top100", title: "멜론 TOP 100", items: topItems });
  if (genreItems.length) sections.push({ uri: PROVIDER_ID + ":genre-charts", title: "장르별 최신곡", items: genreItems });
  try {
    var hot = chartTracks("hot");
    sections.push({ uri: PROVIDER_ID + ":hot100", title: "멜론 HOT 100", items: [makeVirtualAlbum("melon-hot100", "멜론 HOT 100", hot, hot[0].cover_url)] });
  } catch (error) {
    log.warn("Melon HOT 100 unavailable: " + String(error.message || error));
  }
  optionalSection(BASE_URL + "/new/index.htm", "최신음악", sections);
  optionalSection(BASE_URL + "/genre/song_list.htm?gnrCode=GN0100", "장르음악", sections);
  try {
    sections.push(djTodaySection());
  } catch (error) {
    log.warn("Melon DJ section unavailable: " + String(error.message || error));
  }
  if (!sections.length) throw new Error("Melon home feed is unavailable");
  var feed = { success: true, greeting: "Melon Music", sections: sections };
  cacheStore(FEED_CACHE, "home", { time: Date.now(), value: feed });
  return feed;
}

function enrichTrack(track) {
  if (!track || !track.id) throw new Error("Melon enrichment requires a track ID");
  if (track.provider_id && track.provider_id !== PROVIDER_ID) return track;
  var detail = getTrack(track.id), result = Object.assign({}, track);
  Object.keys(detail).forEach(function (key) {
    if (detail[key] !== "" && detail[key] !== 0) result[key] = detail[key];
  });
  result.external_links = Object.assign({}, track.external_links || {}, detail.external_links);
  return result;
}

function getArtist(artistId) {
  var id = resourceId(artistId, "artist");
  var html = fetchHtml(BASE_URL + "/artist/timeline.htm?artistId=" + id);
  var name = pageMeta(html, "og:title");
  var actualId = firstMatch(pageMeta(html, "og:url"), [/artistId=(\d+)/i]);
  if (!name || (actualId && actualId !== id)) throw new Error("Melon artist metadata was unrecognized: " + id);
  var songs = safeTracks(BASE_URL + "/artist/song.htm?artistId=" + id + "&orderBy=POPULAR_SONG_LIST").slice(0, 50);
  var albumHtml = fetchHtml(BASE_URL + "/artist/album.htm?artistId=" + id);
  var items = albumHtml.match(/<li\b[^>]*class=["'][^"']*\balbum11_li\b[^"']*["'][^>]*>[\s\S]*?<\/li>/gi) || [];
  var albums = [], seen = {};
  for (var i = 0; i < items.length; i++) {
    var albumId = getAlbumId(items[i]);
    var title = firstMatch(items[i], [/<a\b[^>]*goAlbumDetail\([^>]*class=["'][^"']*\bellipsis\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i]);
    if (!albumId || !title || seen[albumId]) continue;
    seen[albumId] = true;
    var cover = getCoverUrl(items[i]);
    albums.push({ id: albumId, name: title, artists: name, artist_id: id, cover_url: cover, images: cover,
      release_date: firstMatch(items[i], [/<span\b[^>]*class=["']cnt_view["'][^>]*>([\s\S]*?)<\/span>/i]).replace(/\./g, "-"),
      total_tracks: 0, tracks: [], provider_id: PROVIDER_ID, item_type: "album" });
  }
  // Popular song rows have no artwork; reuse the covers of this artist's albums,
  // then the mobile search results for songs from older albums.
  var albumCovers = {};
  albums.forEach(function (album) { if (album.cover_url) albumCovers[album.id] = album.cover_url; });
  songs.forEach(function (song) { song.cover_url = song.cover_url || albumCovers[song.album_id] || ""; });
  if (songs.length) fillSearchCovers(songs, name);
  return { id: id, name: name, uri: PROVIDER_ID + ":artist:" + id, type: "artist", provider_id: PROVIDER_ID,
    image_url: normalizeCoverUrl(pageMeta(html, "og:image")), top_tracks: songs.map(makeTrackResult), albums: albums };
}

function handleUrl(url) {
  // Mobile and other Melon subdomains share the desktop detail paths.
  var match = String(url || "").match(/^https?:\/\/(?:[a-z0-9-]+\.)*melon\.com\/(song\/detail|album\/detail|artist\/(?:detail|timeline|song|album)|landing\/playList|mymusic\/dj\/mymusicdjplaylistview_inform)\.htm\?([^#]*)/i);
  if (!match) throw new Error("Unsupported Melon URL");
  var resource = match[1].toLowerCase();
  var type = resource === "song/detail" ? "track" : resource === "album/detail" ? "album" : resource.indexOf("artist/") === 0 ? "artist" : "playlist";
  var key = type === "track" ? "songId" : type === "album" ? "albumId" : type === "artist" ? "artistId" : "plylstSeq";
  var id = firstMatch(match[2].replace(/&amp;/gi, "&"), [new RegExp("(?:^|&)" + key + "=(\\d+)(?:&|$)", "i")]);
  if (!id) throw new Error("Melon URL has no valid " + key);
  var result = { type: type, id: id };
  if (type === "track") result.track = getTrack(id);
  else if (type === "album") result.album = getAlbum(id);
  else if (type === "artist") result.artist = getArtist(id);
  else {
    var playlist = getPlaylist(id);
    result.name = playlist.name;
    result.cover_url = playlist.cover_url;
    result.tracks = playlist.tracks;
  }
  if (type !== "playlist") {
    var item = result[type];
    result.name = item.name;
    result.cover_url = item.cover_url || item.image_url || "";
    if (type === "album") result.tracks = item.tracks;
  }
  return result;
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  searchTracks: searchTracks,
  customSearch: customSearch,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getPlaylist: getPlaylist,
  getArtist: getArtist,
  getHomeFeed: getHomeFeed,
  enrichTrack: enrichTrack,
  handleUrl: handleUrl
});
