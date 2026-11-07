// Jellyfin extension for Mornye
// Use your own Jellyfin server as a search provider, download source,
// URL handler, lyrics source and home feed.

var EXT_ID = "jellyfin";
var settings = {};
var session = null;

// ---------------------------------------------------------------- helpers

function baseUrl() {
  var u = String(settings.server_url || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

function errText(r) {
  if (!r) return "no response";
  var t = r.error || r.statusText || "";
  if (!t && r.body && typeof r.body === "string" && r.body.length < 200) t = r.body;
  var code = r.status || r.statusCode;
  return (code ? "HTTP " + code : "no HTTP status") + (t ? " - " + t : "");
}

function isId(s) {
  return typeof s === "string" && /^[0-9a-f-]{32,36}$/i.test(s);
}

function qs(params) {
  var out = [];
  for (var k in params) {
    var v = params[k];
    if (v === undefined || v === null || v === "") continue;
    out.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}

function deviceId() {
  var id = null;
  try { id = storage.get("device_id"); } catch (e) {}
  if (!id) {
    id = "mornye-" + String(utils.md5(String(Date.now()) + String(Math.random()))).substring(0, 16);
    try { storage.set("device_id", id); } catch (e) {}
  }
  return id;
}

function authHeaders(token) {
  var h = 'MediaBrowser Client="Mornye", Device="Mornye", DeviceId="' + deviceId() +
          '", Version="1.0.0"';
  if (token) h += ', Token="' + token + '"';
  var o = { "Authorization": h, "Accept": "application/json" };
  if (token) o["X-Emby-Token"] = token;
  return o;
}

function sessionKey() {
  return baseUrl() + "|" + String(settings.username || "").toLowerCase();
}

function clearSessionCache() {
  session = null;
  try { credentials.remove("session"); } catch (e) {}
}

// ---------------------------------------------------------------- auth

function login(force) {
  if (!force && session) return session;
  var base = baseUrl();
  if (!base) throw new Error("Server URL is missing in the settings");

  // Variant 1: API key
  if (settings.api_key) {
    var s = { token: String(settings.api_key), userId: "" };
    var r = http.get(base + "/Users", authHeaders(s.token));
    if (!r.ok) throw new Error("API key rejected (" + errText(r) + ")");
    var users = JSON.parse(r.body) || [];
    var want = String(settings.username || "").toLowerCase();
    for (var i = 0; i < users.length; i++) {
      if (!want || String(users[i].Name).toLowerCase() === want) {
        s.userId = users[i].Id;
        break;
      }
    }
    if (!s.userId) throw new Error("User '" + settings.username + "' not found");
    s.name = settings.username || "";
    session = s;
    return s;
  }

  // Variant 2: username + password (token cached)
  if (!settings.username) throw new Error("Username is missing in the settings");
  if (!force) {
    try {
      var c = credentials.get("session");
      if (c && c.key === sessionKey() && c.token && c.userId) {
        session = c;
        return c;
      }
    } catch (e) {}
  }
  var hdrs = authHeaders(null);
  hdrs["Content-Type"] = "application/json";
  var resp = http.post(base + "/Users/AuthenticateByName",
    { Username: settings.username, Pw: settings.password || "" }, hdrs);
  if (!resp.ok) throw new Error("Login failed (" + errText(resp) + ")");
  var d = JSON.parse(resp.body);
  if (!d || !d.AccessToken || !d.User) throw new Error("Unexpected login response");
  session = { key: sessionKey(), token: d.AccessToken, userId: d.User.Id, name: d.User.Name };
  try { credentials.store("session", session); } catch (e) {}
  return session;
}

function apiGet(path, params, retried) {
  var s = login(false);
  var url = baseUrl() + path + (params ? "?" + qs(params) : "");
  var r = http.get(url, authHeaders(s.token));
  if (r.status === 401 && !settings.api_key && !retried) {
    clearSessionCache();
    login(true);
    return apiGet(path, params, true);
  }
  if (!r.ok) {
    log.warn("Jellyfin GET " + path + " -> " + errText(r));
    return null;
  }
  try { return JSON.parse(r.body); } catch (e) { return null; }
}

// ---------------------------------------------------------------- mapping

function coverUrl(it) {
  var id = null, tag = null;
  if (it.ImageTags && it.ImageTags.Primary) { id = it.Id; tag = it.ImageTags.Primary; }
  else if (it.AlbumId && it.AlbumPrimaryImageTag) { id = it.AlbumId; tag = it.AlbumPrimaryImageTag; }
  if (!id) return "";
  return baseUrl() + "/Items/" + id + "/Images/Primary?maxHeight=600&quality=90&tag=" + tag;
}

function artistString(it) {
  if (it.Artists && it.Artists.length) return it.Artists.join(", ");
  return it.AlbumArtist || "";
}

function releaseDate(it) {
  if (it.PremiereDate) return String(it.PremiereDate).substring(0, 10);
  if (it.ProductionYear) return String(it.ProductionYear);
  return "";
}

function toTrack(it) {
  var c = coverUrl(it);
  return {
    id: it.Id,
    name: it.Name || "",
    artists: artistString(it),
    album_name: it.Album || "",
    album_artist: it.AlbumArtist || artistString(it),
    duration_ms: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 10000) : 0,
    track_number: it.IndexNumber || 0,
    disc_number: it.ParentIndexNumber || 1,
    release_date: releaseDate(it),
    isrc: "",
    cover_url: c,
    images: c,
    item_type: "track",
    provider_id: EXT_ID
  };
}

function toAlbumItem(it) {
  var c = coverUrl(it);
  return {
    id: it.Id,
    name: it.Name || "",
    artists: it.AlbumArtist || artistString(it),
    album_name: it.Name || "",
    album_type: "album",
    release_date: releaseDate(it),
    total_tracks: it.ChildCount || 0,
    cover_url: c,
    images: c,
    item_type: "album",
    provider_id: EXT_ID
  };
}

function toArtistItem(it) {
  var c = coverUrl(it);
  return {
    id: it.Id, name: it.Name || "", artists: it.Name || "",
    cover_url: c, images: c, item_type: "artist", provider_id: EXT_ID
  };
}

function toPlaylistItem(it) {
  var c = coverUrl(it);
  return {
    id: it.Id, name: it.Name || "", artists: "Playlist", album_name: it.Name || "",
    album_type: "playlist", total_tracks: it.ChildCount || 0,
    cover_url: c, images: c, item_type: "playlist", provider_id: EXT_ID
  };
}

function getItem(id, fields) {
  var s = login(false);
  var d = apiGet("/Items", { UserId: s.userId, Ids: id, Fields: fields || "" });
  return d && d.Items && d.Items.length ? d.Items[0] : null;
}

function listItems(extra, limit) {
  var s = login(false);
  var p = { UserId: s.userId, Recursive: "true", Limit: limit || 100 };
  for (var k in extra) p[k] = extra[k];
  var d = apiGet("/Items", p);
  return d && d.Items ? d.Items : [];
}

// ---------------------------------------------------------------- lifecycle

function initialize(config) {
  settings = config || {};
  session = null;
  if (!settings.server_url) log.warn("Jellyfin: server URL not set yet");
  return true;
}

function cleanup() {
  session = null;
}

function testConnection() {
  try {
    if (!baseUrl()) return { success: false, error: "Server URL is missing" };
    var r = http.get(baseUrl() + "/System/Info/Public", { "Accept": "application/json" });
    if (!r.ok) return { success: false, error: "Server not reachable (" + errText(r) + ")" };
    var info = JSON.parse(r.body);
    var s = login(true);
    return { success: true, message: "Connected to " + (info.ServerName || "Jellyfin") +
             " " + (info.Version || "") + " as " + (s.name || settings.username) };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

function clearSession() {
  clearSessionCache();
  return { success: true, message: "Saved session cleared" };
}

// ---------------------------------------------------------------- search

function search(query, limit) {
  var s = login(false);
  var out = [];
  var n = limit || 20;

  var tracks = listItems({ SearchTerm: query, IncludeItemTypes: "Audio" }, n);
  for (var i = 0; i < tracks.length; i++) out.push(toTrack(tracks[i]));

  var albums = listItems({ SearchTerm: query, IncludeItemTypes: "MusicAlbum" }, 10);
  for (var j = 0; j < albums.length; j++) out.push(toAlbumItem(albums[j]));

  var ad = apiGet("/Artists", { UserId: s.userId, SearchTerm: query, Limit: 8 });
  var artists = ad && ad.Items ? ad.Items : [];
  for (var k = 0; k < artists.length; k++) out.push(toArtistItem(artists[k]));

  var pls = listItems({ SearchTerm: query, IncludeItemTypes: "Playlist" }, 8);
  for (var m = 0; m < pls.length; m++) {
    if (!pls[m].MediaType || pls[m].MediaType === "Audio") out.push(toPlaylistItem(pls[m]));
  }
  return out;
}

function customSearch(query, options) {
  var limit = options && typeof options === "object" && options.limit ? options.limit : 20;
  try { return search(query, limit); }
  catch (e) { log.error("Jellyfin search failed: " + (e && e.message ? e.message : e)); return []; }
}

function searchTracks(query, limit) {
  try {
    var items = listItems({ SearchTerm: query, IncludeItemTypes: "Audio" }, limit || 20);
    return items.map(toTrack);
  } catch (e) { return []; }
}

// ---------------------------------------------------------------- metadata

function getTrack(id) {
  var it = getItem(id);
  return it ? toTrack(it) : null;
}

function getAlbum(id) {
  var album = getItem(id);
  if (!album) return null;
  var items = listItems({
    ParentId: id, IncludeItemTypes: "Audio",
    SortBy: "ParentIndexNumber,IndexNumber,SortName"
  }, 500);
  var tracks = items.map(toTrack);
  var c = coverUrl(album);
  for (var i = 0; i < tracks.length; i++) {
    if (!tracks[i].cover_url) { tracks[i].cover_url = c; tracks[i].images = c; }
    if (!tracks[i].album_name) tracks[i].album_name = album.Name;
  }
  return {
    id: id, name: album.Name, artists: album.AlbumArtist || artistString(album),
    cover_url: c, images: c, release_date: releaseDate(album),
    total_tracks: tracks.length, album_type: "album",
    tracks: tracks, provider_id: EXT_ID
  };
}

function getPlaylist(id) {
  var s = login(false);
  var pl = getItem(id);
  var d = apiGet("/Playlists/" + id + "/Items", { UserId: s.userId });
  var items = d && d.Items ? d.Items : [];
  var tracks = items.map(toTrack);
  var c = pl ? coverUrl(pl) : "";
  return {
    id: id, name: pl ? pl.Name : "Playlist", owner: "Jellyfin",
    cover_url: c, images: c, total_tracks: tracks.length,
    tracks: tracks, provider_id: EXT_ID
  };
}

function getArtist(id) {
  var a = getItem(id);
  var items = listItems({
    ArtistIds: id, IncludeItemTypes: "MusicAlbum",
    SortBy: "ProductionYear,SortName", SortOrder: "Descending"
  }, 200);
  var c = a ? coverUrl(a) : "";
  return {
    id: id, name: a ? a.Name : "", image_url: c, images: c,
    albums: items.map(toAlbumItem), provider_id: EXT_ID
  };
}

// ---------------------------------------------------------------- matching

function clean(s) {
  s = String(s || "").toLowerCase();
  try { s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
  var c = s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
           .replace(/\s[-\u2013]\s(remaster(ed)?|live|radio edit|single version|album version|mono|stereo|deluxe).*$/, " ")
           .replace(/\b(feat|ft)\.?\s.*$/, " ")
           .replace(/[^a-z0-9\u00c0-\uffff]+/g, " ").trim();
  return c || s.replace(/[^a-z0-9\u00c0-\uffff]+/g, " ").trim();
}

function tokens(s) {
  var t = clean(s).split(" "), o = [];
  for (var i = 0; i < t.length; i++) if (t[i]) o.push(t[i]);
  return o;
}

function overlap(a, b) {
  if (!a.length) return 0;
  var n = 0;
  for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) !== -1) n++;
  return n / a.length;
}

function nameScore(want, have) {
  var a = clean(want), b = clean(have);
  if (!a || !b) return 0;
  if (a === b) return 1;
  var shortLen = Math.min(a.length, b.length), longLen = Math.max(a.length, b.length);
  if (shortLen >= 4 && shortLen / longLen >= 0.5 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1)) return 0.9;
  var ta = tokens(want), tb = tokens(have);
  var j = Math.min(overlap(ta, tb), overlap(tb, ta)) * 0.85;
  var m = 0;
  if (typeof matching !== "undefined" && matching.compareStrings) {
    try { m = matching.compareStrings(a, b) || 0; } catch (e) {}
  }
  return Math.max(j, m);
}

function artistMatch(wantArtist, it) {
  var w = tokens(wantArtist);
  var names = (it.Artists || []).join(" ") + " " + (it.AlbumArtist || "");
  var h = tokens(names);
  if (!w.length || !h.length) return null;
  return overlap(w, h) >= 0.5 || overlap(h, w) >= 0.5;
}

function pickBest(items, trackName, artistName, durationSec) {
  var best = null, bestScore = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var score = nameScore(trackName, it.Name);
    var am = artistName ? artistMatch(artistName, it) : null;
    if (durationSec && it.RunTimeTicks && Math.abs(it.RunTimeTicks / 10000000 - durationSec) > 15) score -= 0.3;
    var ok = (score >= 0.9 && am !== false) || (score >= 0.7 && am === true) || (!artistName && score >= 1);
    if (!ok) continue;
    var total = score + (am === true ? 0.05 : 0);
    if (total > bestScore) { best = it; bestScore = total; }
  }
  return best;
}

// Find the best Jellyfin track for a title/artist pair (download source for other services)
function findTrack(trackName, artistName, durationSec) {
  if (!trackName) return null;
  var seen = {}, items = [];
  function add(list) {
    for (var i = 0; i < list.length; i++) {
      if (!seen[list[i].Id]) { seen[list[i].Id] = 1; items.push(list[i]); }
    }
  }
  add(listItems({ SearchTerm: trackName, IncludeItemTypes: "Audio" }, 30));
  var best = pickBest(items, trackName, artistName, durationSec);
  if (best) return best;

  var ct = clean(trackName);
  if (ct && ct !== String(trackName).toLowerCase()) {
    add(listItems({ SearchTerm: ct, IncludeItemTypes: "Audio" }, 30));
    best = pickBest(items, trackName, artistName, durationSec);
    if (best) return best;
  }

  if (artistName) {
    var first = String(artistName).split(/,|&|;| feat\.? | ft\.? /i)[0].trim();
    var s = login(false);
    var ad = apiGet("/Artists", { UserId: s.userId, SearchTerm: first, Limit: 3 });
    var arts = ad && ad.Items ? ad.Items : [];
    for (var k = 0; k < arts.length; k++) {
      add(listItems({ ArtistIds: arts[k].Id, IncludeItemTypes: "Audio" }, 500));
    }
    best = pickBest(items, trackName, artistName, durationSec);
  }
  return best;
}

// ---------------------------------------------------------------- download

function checkAvailability(isrc, trackName, artistName) {
  try {
    var it = findTrack(trackName, artistName, 0);
    if (!it) return { available: false };
    return { available: true, track_id: it.Id, quality: "ORIGINAL" };
  } catch (e) {
    log.warn("checkAvailability failed: " + (e && e.message ? e.message : e));
    return { available: false };
  }
}

function transcodeParams(quality) {
  if (quality === "MP3_320") return { container: "mp3", audioCodec: "mp3", audioBitRate: 320000, fmt: "mp3" };
  if (quality === "MP3_192") return { container: "mp3", audioCodec: "mp3", audioBitRate: 192000, fmt: "mp3" };
  if (quality === "OPUS_128") return { container: "opus", audioCodec: "opus", audioBitRate: 128000, fmt: "opus" };
  return null;
}

function originalExt(item) {
  var ms = item.MediaSources && item.MediaSources[0];
  var path = (ms && ms.Path) || item.Path || "";
  var m = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  if (m) return m[1].toLowerCase();
  var c = String((ms && ms.Container) || "").toLowerCase();
  if (c.indexOf("m4a") !== -1 || c.indexOf("mp4") !== -1) return "m4a";
  return c.split(",")[0] || "flac";
}

function streamUrl(id, quality, token) {
  var t = transcodeParams(quality);
  var base = baseUrl();
  var key = token ? { api_key: token } : {};
  if (!t) return base + "/Items/" + id + "/Download" + (token ? "?" + qs(key) : "");
  var p = { static: "false", container: t.container, audioCodec: t.audioCodec,
            audioBitRate: t.audioBitRate, maxAudioChannels: 2 };
  if (token) p.api_key = token;
  return base + "/Audio/" + id + "/stream?" + qs(p);
}

function staticUrl(id, token) {
  return baseUrl() + "/Audio/" + id + "/stream?" + qs({ static: "true", api_key: token });
}

function buildUrls(id, quality, token, original) {
  var l = [streamUrl(id, quality, token)];
  if (original) l.push(staticUrl(id, token));
  return l;
}

function getDownloadUrl(trackId, quality) {
  try {
    var s = login(false);
    var item = getItem(trackId, "MediaSources,Path");
    if (!item) return { success: false, error: "Track not found" };
    var t = transcodeParams(quality);
    return { success: true, url: streamUrl(trackId, quality || "ORIGINAL", s.token),
             format: t ? t.fmt : originalExt(item), quality: quality || "ORIGINAL" };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

function withExt(p, ext) {
  var m = /\.[A-Za-z0-9]{2,5}$/.exec(p);
  if (m && m[0].toLowerCase() === "." + ext) return p;
  return m ? p.slice(0, m.index) + "." + ext : p + "." + ext;
}

// Supports both call styles used in the docs:
//   download(request, progressCallback)
//   download(trackId, quality, outputPath, progressCallback)
function download(a, b, c, d) {
  var req = null, trackId, quality, outputPath = null, cb, scale;
  if (a && typeof a === "object") {
    req = a; cb = b; scale = 1;
    trackId = req.track_id || req.service_track_id || req.source_id || req.id;
    quality = req.quality;
    outputPath = req.output_path || req.outputPath || null;
  } else {
    trackId = a; quality = b; outputPath = c; cb = d; scale = 100;
  }
  quality = quality || "ORIGINAL";

  try {
    var s = login(false);

    if (!isId(trackId) && req) {
      var found = findTrack(req.track_name, req.artist_name, req.duration_ms ? req.duration_ms / 1000 : (req.duration || 0));
      if (found) trackId = found.Id;
    }
    if (!isId(trackId)) {
      return { success: false, error_type: "not_found",
               error: "Not found on Jellyfin: " + (req ? (req.track_name || "?") + " - " + (req.artist_name || "?") : String(trackId)) };
    }

    var item = getItem(trackId, "MediaSources,Path");
    if (!item) return { success: false, error: "Track not found on Jellyfin", error_type: "not_found" };

    var t = transcodeParams(quality);
    var ext = t ? t.fmt : originalExt(item);

    if (!outputPath) {
      var dir = (req && (req.output_dir || req.outputDir)) || "";
      var title = gobackend.sanitizeFilename((item.Name || "track") + " - " + artistString(item));
      outputPath = (dir ? dir + "/" : "") + title + "." + ext;
    } else {
      outputPath = withExt(outputPath, ext);
    }

    var relogged = false, res = null, lastErr = "";
    var urls = buildUrls(trackId, quality, s.token, !t);
    var onProg = function (received, total) {
      if (typeof cb === "function" && total > 0) {
        try { cb((received / total) * scale); } catch (e) {}
      }
    };
    for (var u = 0; u < urls.length; u++) {
      res = file.download(urls[u], outputPath, { headers: { "X-Emby-Token": s.token }, onProgress: onProg });
      if (res && res.success) break;
      lastErr = res && res.error ? res.error : "unknown";
      log.warn("Jellyfin download attempt " + (u + 1) + " failed: " + lastErr);
      if (/401/.test(lastErr) && !settings.api_key && !relogged) {
        relogged = true;
        clearSessionCache();
        s = login(true);
        urls = buildUrls(trackId, quality, s.token, !t);
        u = -1;
      }
    }
    if (!res || !res.success) {
      return { success: false, error: "Download failed: " + lastErr, error_type: "download_error" };
    }

    var out = { success: true, file_path: outputPath, format: ext };
    var ms = item.MediaSources && item.MediaSources[0];
    if (!t && ms && ms.MediaStreams) {
      for (var i = 0; i < ms.MediaStreams.length; i++) {
        if (ms.MediaStreams[i].Type === "Audio") {
          if (ms.MediaStreams[i].BitDepth) out.actual_bit_depth = ms.MediaStreams[i].BitDepth;
          if (ms.MediaStreams[i].SampleRate) out.actual_sample_rate = ms.MediaStreams[i].SampleRate;
          break;
        }
      }
    }
    return out;
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e), error_type: "auth_error" };
  }
}

// ---------------------------------------------------------------- URL handler

function handleURL(url) {
  try {
    var m = /[?&]id=([0-9a-f-]{32,36})/i.exec(String(url));
    if (!m) return { success: false, error: "No Jellyfin ID found in the URL" };
    var id = m[1];
    var it = getItem(id);
    if (!it) return { success: false, error: "Item not found" };
    if (it.Type === "Audio") return { success: true, type: "track", track: toTrack(it) };
    if (it.Type === "MusicAlbum") return { success: true, type: "album", album: getAlbum(id) };
    if (it.Type === "Playlist") return { success: true, type: "album", album: getPlaylist(id) };
    if (it.Type === "MusicArtist") return { success: true, type: "artist", artist: getArtist(id) };
    return { success: false, error: "Unsupported item type: " + it.Type };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------- lyrics

function fetchLyrics(trackName, artistName, albumName, durationSec) {
  try {
    var it = findTrack(trackName, artistName, durationSec);
    if (!it) return null;
    var d = apiGet("/Audio/" + it.Id + "/Lyrics", null);
    if (!d || !d.Lyrics || !d.Lyrics.length) return null;

    var synced = false, i;
    for (i = 0; i < d.Lyrics.length; i++) {
      if (typeof d.Lyrics[i].Start === "number") { synced = true; break; }
    }
    if (synced) {
      var lines = [];
      for (i = 0; i < d.Lyrics.length; i++) {
        var start = Math.round((d.Lyrics[i].Start || 0) / 10000);
        var next = i + 1 < d.Lyrics.length && typeof d.Lyrics[i + 1].Start === "number"
          ? Math.round(d.Lyrics[i + 1].Start / 10000) : 0;
        lines.push({ startTimeMs: start, words: d.Lyrics[i].Text || "", endTimeMs: next });
      }
      return { lines: lines, syncType: "LINE_SYNCED", instrumental: false, plainLyrics: "", provider: "Jellyfin" };
    }
    var plain = [];
    for (i = 0; i < d.Lyrics.length; i++) plain.push(d.Lyrics[i].Text || "");
    return { lines: [], syncType: "UNSYNCED", instrumental: false, plainLyrics: plain.join("\n"), provider: "Jellyfin" };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- home feed

function homeItem(it) {
  var type = it.Type === "MusicAlbum" ? "album" : it.Type === "Playlist" ? "playlist" :
             it.Type === "MusicArtist" ? "artist" : "track";
  var o = {
    id: it.Id, uri: "jellyfin:" + type + ":" + it.Id, type: type, name: it.Name || "",
    artists: type === "album" ? (it.AlbumArtist || artistString(it)) : type === "track" ? artistString(it) : "",
    description: type === "playlist" ? "Playlist" : "",
    cover_url: coverUrl(it), provider_id: EXT_ID
  };
  if (type === "track" && it.AlbumId) { o.album_id = it.AlbumId; o.album_name = it.Album || ""; }
  return o;
}

function greeting() {
  try {
    var h = gobackend.getLocalTime().hour;
    if (h >= 5 && h < 12) return "Good morning";
    if (h >= 12 && h < 17) return "Good afternoon";
    if (h >= 17 && h < 22) return "Good evening";
    return "Good night";
  } catch (e) { return "Hello"; }
}

function getHomeFeed() {
  try {
    var s = login(false);
    var sections = [];
    var add = function (title, uri, items) {
      if (items && items.length) sections.push({ uri: uri, title: title, items: items.map(homeItem) });
    };
    var safe = function (fn) { try { return fn(); } catch (e) { return []; } };

    add("Recently added", "recent-albums", safe(function () {
      return listItems({ IncludeItemTypes: "MusicAlbum", SortBy: "DateCreated", SortOrder: "Descending" }, 20); }));
    add("Recently played", "recent-played", safe(function () {
      return listItems({ IncludeItemTypes: "Audio", Filters: "IsPlayed", SortBy: "DatePlayed", SortOrder: "Descending" }, 20); }));
    add("Most played", "most-played", safe(function () {
      return listItems({ IncludeItemTypes: "Audio", Filters: "IsPlayed", SortBy: "PlayCount", SortOrder: "Descending" }, 20); }));
    add("Favorites", "favorites", safe(function () {
      return listItems({ IncludeItemTypes: "Audio", Filters: "IsFavorite", SortBy: "SortName" }, 20); }));
    add("Playlists", "playlists", safe(function () {
      var pl = listItems({ IncludeItemTypes: "Playlist" }, 20), out = [];
      for (var i = 0; i < pl.length; i++) if (!pl[i].MediaType || pl[i].MediaType === "Audio") out.push(pl[i]);
      return out; }));
    add("Discover albums", "random-albums", safe(function () {
      return listItems({ IncludeItemTypes: "MusicAlbum", SortBy: "Random" }, 20); }));
    add("Discover artists", "random-artists", safe(function () {
      var d = apiGet("/Artists", { UserId: s.userId, SortBy: "Random", Limit: 20 });
      return d && d.Items ? d.Items : []; }));

    if (!sections.length) return { success: false, error: "No content found on the server" };
    return { success: true, greeting: greeting(), sections: sections };
  } catch (e) {
    return { success: false, error: String(e && e.message ? e.message : e) };
  }
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  testConnection: testConnection,
  clearSession: clearSession,
  customSearch: customSearch,
  searchTracks: searchTracks,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getPlaylist: getPlaylist,
  getArtist: getArtist,
  handleURL: handleURL,
  checkAvailability: checkAvailability,
  getDownloadUrl: getDownloadUrl,
  download: download,
  fetchLyrics: fetchLyrics,
  getHomeFeed: getHomeFeed
});
