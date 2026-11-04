var CONFIG = {
  resolverBaseURL: "https://api.zarz.moe",
  resolverDownloadPath: "/dl/dzr",
  deezerBaseURL: "https://www.deezer.com",
  apiBaseURL: "https://api.deezer.com",
  gatewayURL: "https://www.deezer.com/ajax/gw-light.php",
  blowfishSecret: "g4el58wc0zvf9na1",
  blowfishIVHex: "0001020304050607",
  chunkSize: 2048,
  maxCollectionTracks: 200,
  maxArtistAlbums: 100,
  maxArtistTopTracks: 20,
  coverMaxSize: 1400,
  metadataCacheTtlMs: 5 * 60 * 1000,
  metadataCacheMaxEntries: 500,
  gatewayTokenTtlMs: 30 * 60 * 1000
};

var metadataCache = new Map();
var gatewayToken = "";
var gatewayTokenCreatedAt = 0;

function nowMs() {
  return Date.now();
}

function cacheGet(key) {
  var entry = metadataCache.get(key);
  if (!entry) return null;
  if (nowMs() - entry.createdAt > CONFIG.metadataCacheTtlMs) {
    metadataCache.delete(key);
    return null;
  }
  metadataCache.delete(key);
  metadataCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (value !== null && value !== undefined) {
    if (metadataCache.has(key)) metadataCache.delete(key);
    metadataCache.set(key, { value: value, createdAt: nowMs() });
    while (metadataCache.size > CONFIG.metadataCacheMaxEntries) {
      metadataCache.delete(metadataCache.keys().next().value);
    }
  }
  return value;
}

function initialize(settings) {
  settings = settings || {};
  var configuredBase = String(settings.apiBaseUrl || "").trim();
  if (configuredBase) {
    CONFIG.resolverBaseURL = configuredBase.replace(/\/+$/, "");
  }
  return true;
}

function cleanup() {
  metadataCache = new Map();
  gatewayToken = "";
  gatewayTokenCreatedAt = 0;
  return true;
}

function mergeHeaders(base, extra) {
  var merged = {};
  var key;
  base = base || {};
  extra = extra || {};

  for (key in base) {
    if (base.hasOwnProperty(key)) {
      merged[key] = base[key];
    }
  }
  for (key in extra) {
    if (extra.hasOwnProperty(key)) {
      merged[key] = extra[key];
    }
  }
  return merged;
}

function appUserAgent() {
  if (utils && typeof utils.appUserAgent === "function") {
    return String(utils.appUserAgent() || "").trim() || "SpotiFLAC-Mobile";
  }
  return "SpotiFLAC-Mobile";
}

function userAgentForURL(url) {
  var text = String(url || "").trim().toLowerCase();
  if (text.indexOf("https://api.zarz.moe") === 0 || text.indexOf("http://api.zarz.moe") === 0) {
    return appUserAgent();
  }
  return utils.randomUserAgent();
}

function getJSON(url, headers) {
  var response = http.get(url, headers || {});
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return JSON.parse(response.body);
}

function postJSON(url, body, headers) {
  var response = http.post(url, JSON.stringify(body), mergeHeaders({
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": userAgentForURL(url)
  }, headers));
  if (!response || response.error) {
    throw new Error(response && response.error ? response.error : "request failed");
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + url);
  }
  return JSON.parse(response.body);
}

function signedJSON(method, path, body, headers) {
  if (typeof session === "undefined" || !session || typeof session.signedFetch !== "function") {
    throw new Error("signed session runtime is not available");
  }
  var response = session.signedFetch(method, path, body || null, headers || {});
  if (!response || response.error || response.needsVerification) {
    var error = response && response.error ? response.error : "signed request failed";
    throw new Error(error);
  }
  if (response.statusCode !== 200) {
    throw new Error("HTTP " + response.statusCode + " for " + path);
  }
  return JSON.parse(response.body || "{}");
}

function signedTicket(provider, type, id) {
  var resourceHash = utils.sha256(provider + ":" + (type || "track") + ":" + String(id || "").toLowerCase());
  var payload = signedJSON("POST", "/tickets", {
    capability: "download_ticket",
    provider: provider,
    resource_hash: resourceHash
  });
  var ticketID = String(payload.ticket_id || payload.ticket || "").trim();
  if (!ticketID) {
    throw new Error("signed ticket response missing ticket_id");
  }
  return ticketID;
}

function parseBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    var normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function ensureLeadingDot(ext) {
  ext = String(ext || "").trim();
  if (!ext) return "";
  return ext.charAt(0) === "." ? ext : "." + ext;
}

function ensureOutputExtension(outputPath, extension) {
  var normalizedExt = ensureLeadingDot(extension);
  if (!normalizedExt) return outputPath;

  var currentDot = outputPath.lastIndexOf(".");
  if (currentDot < 0) {
    return outputPath + normalizedExt;
  }
  if (outputPath.substring(currentDot).toLowerCase() === normalizedExt.toLowerCase()) {
    return outputPath;
  }
  return outputPath.substring(0, currentDot) + normalizedExt;
}

function buildEncryptedTempPath(outputPath) {
  var dotIndex = outputPath.lastIndexOf(".");
  if (dotIndex < 0) return outputPath + ".encrypted";
  return outputPath.substring(0, dotIndex) + ".encrypted" + outputPath.substring(dotIndex);
}

function hexByte(value) {
  var hex = (value & 0xff).toString(16);
  return hex.length === 1 ? "0" + hex : hex;
}

function generateBlowfishKeyHex(trackID) {
  var md5hex = utils.md5(String(trackID || "").trim());
  var out = "";
  for (var i = 0; i < 16; i++) {
    var value = md5hex.charCodeAt(i) ^ md5hex.charCodeAt(i + 16) ^ CONFIG.blowfishSecret.charCodeAt(i);
    out += hexByte(value);
  }
  return out;
}

function normalizedUserAgent() {
  return {
    "User-Agent": userAgentForURL(CONFIG.resolverBaseURL),
    "Accept": "application/json"
  };
}

function normalizeDate(value) {
  var text = String(value || "").trim();
  if (!text) return "";
  if (text.length >= 10) return text.substring(0, 10);
  return text;
}

function uniqueValues(values) {
  var out = [];
  var seen = {};
  for (var i = 0; i < values.length; i++) {
    var value = String(values[i] || "").trim();
    var key = value.toLowerCase();
    if (!value || seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function numberValue(value) {
  var parsed = Number(value || 0);
  return isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isTruthyMetadata(value) {
  if (value === true || value === 1) return true;
  var normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "explicit";
}

function directURL(resourceType, id) {
  var rawID = stripPrefix(id);
  if (!rawID) return "";
  return "https://www.deezer.com/" + resourceType + "/" + encodeURIComponent(rawID);
}

function withPrefix(id) {
  var raw = String(id || "").trim();
  if (!raw) return "";
  return raw.indexOf("deezer:") === 0 ? raw : "deezer:" + raw;
}

function stripPrefix(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  return raw.indexOf("deezer:") === 0 ? raw.substring("deezer:".length) : raw;
}

function parseNumericID(value, resourceType) {
  var raw = String(value || "").trim();
  if (!raw) return "";

  var direct = raw.match(/^\d+$/);
  if (direct) return direct[0];

  var prefixed = raw.match(/^deezer:(\d+)$/i);
  if (prefixed) return prefixed[1];

  var pattern = new RegExp(resourceType + "\\/(\\d+)", "i");
  var match = raw.match(pattern);
  if (match) return match[1];

  return "";
}

function parseTrackID(value) {
  return parseNumericID(value, "track");
}

function parseAlbumID(value) {
  return parseNumericID(value, "album");
}

function parseArtistID(value) {
  return parseNumericID(value, "artist");
}

function parsePlaylistID(value) {
  return parseNumericID(value, "playlist");
}

function gatewayContributorNames(gatewayData, roles) {
  var contributors = gatewayData && gatewayData.SNG_CONTRIBUTORS;
  if (!contributors || typeof contributors !== "object") return [];
  var names = [];
  for (var i = 0; i < roles.length; i++) {
    var values = contributors[roles[i]];
    if (Array.isArray(values)) names = names.concat(values);
  }
  return uniqueValues(names);
}

function publicContributorNames(trackData, rolePattern) {
  var contributors = trackData && trackData.contributors;
  if (!Array.isArray(contributors)) return [];
  var names = [];
  for (var i = 0; i < contributors.length; i++) {
    var role = String(contributors[i] && contributors[i].role || "").toLowerCase();
    if (rolePattern.test(role)) names.push(contributors[i].name);
  }
  return uniqueValues(names);
}

function normalizeArtists(trackData, gatewayData) {
  if (!trackData) return "";

  var gatewayArtists = [];
  if (gatewayData && Array.isArray(gatewayData.ARTISTS)) {
    gatewayArtists = uniqueValues(gatewayData.ARTISTS.map(function(artist) {
      return artist && (artist.ART_NAME || artist.name);
    }));
  }
  if (!gatewayArtists.length) {
    gatewayArtists = gatewayContributorNames(gatewayData, [
      "main_artist", "featured_artist", "featuring", "artist", "performer"
    ]);
  }
  if (gatewayArtists.length) return gatewayArtists.join(", ");

  var publicArtists = publicContributorNames(trackData, /main|featured|artist|performer/);
  if (publicArtists.length) {
    return publicArtists.join(", ");
  }

  if (trackData.artist && trackData.artist.name) {
    return String(trackData.artist.name);
  }

  return "";
}

function composerNames(trackData, gatewayData) {
  var names = [];
  if (trackData && trackData.composer) names.push(trackData.composer);
  names = names.concat(gatewayContributorNames(gatewayData, [
    "composer", "author", "songwriter", "writer", "lyricist", "lyrics"
  ]));
  names = names.concat(publicContributorNames(trackData, /composer|author|songwriter|writer|lyricist/));
  return uniqueValues(names).join("; ");
}

// Deezer's CDN accepts larger numbers in the path, but those URLs can return
// a smaller 1200px fallback. The 1400px variant is the highest reliable
// request size and the CDN will still cap it to the source artwork when needed.
var deezerCoverSizePattern = /\/(\d+)x(\d+)-(\d+)-(\d+)-(\d+)-(\d+)\.jpg(?=([?#]|$))/;

function highestQualityDeezerCoverURL(value) {
  var url = String(value || "").trim();
  if (!url || url.indexOf(".dzcdn.net/") === -1) return url;

  return url.replace(deezerCoverSizePattern, function(match, width, height, quality, padding, output, format) {
    if (Number(width) >= CONFIG.coverMaxSize && Number(height) >= CONFIG.coverMaxSize) {
      return match;
    }
    return "/" + CONFIG.coverMaxSize + "x" + CONFIG.coverMaxSize +
      "-" + quality + "-" + padding + "-" + output + "-" + format + ".jpg";
  });
}

function coverFromAlbum(album) {
  if (!album) return "";
  return highestQualityDeezerCoverURL(
    album.cover_xl ||
    album.cover_big ||
    album.cover_medium ||
    album.cover ||
    album.picture_xl ||
    album.picture_big ||
    album.picture_medium ||
    album.picture ||
    ""
  );
}

function coverFromArtist(artist) {
  if (!artist) return "";
  return highestQualityDeezerCoverURL(
    artist.picture_xl ||
    artist.picture_big ||
    artist.picture_medium ||
    artist.picture ||
    artist.cover_xl ||
    artist.cover_big ||
    artist.cover_medium ||
    artist.cover ||
    ""
  );
}

function albumTypeFromRecordType(value) {
  var normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "album";
  switch (normalized) {
    case "ep":
    case "single":
    case "compilation":
    case "album":
      return normalized;
    default:
      return "album";
  }
}

function deezerGet(pathOrURL) {
  var url = String(pathOrURL || "").trim();
  if (!url) {
    throw new Error("missing Deezer API URL");
  }

  if (!/^https?:\/\//i.test(url)) {
    if (url.charAt(0) !== "/") {
      url = "/" + url;
    }
    url = CONFIG.apiBaseURL + url;
  }

  return getJSON(url, normalizedUserAgent());
}

function gatewayHasError(payload) {
  if (!payload || !payload.error) return false;
  if (Array.isArray(payload.error)) return payload.error.length > 0;
  return typeof payload.error === "object" ? Object.keys(payload.error).length > 0 : !!payload.error;
}

function refreshGatewayToken() {
  var payload = postJSON(
    CONFIG.gatewayURL + "?method=deezer.getUserData&input=3&api_version=1.0&api_token=null",
    {}
  );
  var token = payload && payload.results && payload.results.checkForm;
  if (gatewayHasError(payload) || !token) {
    throw new Error("Deezer gateway did not return a CSRF token");
  }
  gatewayToken = String(token);
  gatewayTokenCreatedAt = nowMs();
  return gatewayToken;
}

function currentGatewayToken() {
  if (!gatewayToken || nowMs() - gatewayTokenCreatedAt > CONFIG.gatewayTokenTtlMs) {
    return refreshGatewayToken();
  }
  return gatewayToken;
}

function gatewayCall(method, body) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var token = currentGatewayToken();
    var payload = postJSON(
      CONFIG.gatewayURL + "?method=" + encodeURIComponent(method) +
        "&input=3&api_version=1.0&api_token=" + encodeURIComponent(token),
      body || {}
    );
    if (!gatewayHasError(payload)) return payload.results || null;
    var errorText = JSON.stringify(payload.error || {});
    if (attempt === 0 && errorText.indexOf("VALID_TOKEN_REQUIRED") >= 0) {
      gatewayToken = "";
      gatewayTokenCreatedAt = 0;
      continue;
    }
    throw new Error("Deezer gateway error: " + errorText);
  }
  return null;
}

function safeGatewayCall(method, body) {
  try {
    return gatewayCall(method, body);
  } catch (e) {
    log.debug("[DeezerExt] Gateway metadata failed:", method, e.message);
    return null;
  }
}

function collectPaginatedItems(container, limit) {
  var items = [];
  var nextURL = "";
  var source = container;
  var remaining = typeof limit === "number" && limit > 0 ? limit : 0;

  while (source) {
    var pageItems = source.data || [];
    for (var i = 0; i < pageItems.length; i++) {
      items.push(pageItems[i]);
      if (remaining > 0 && items.length >= remaining) {
        return items;
      }
    }

    nextURL = source.next || "";
    if (!nextURL) break;
    source = deezerGet(nextURL);
  }

  return items;
}

function fetchTrackData(trackID) {
  var key = "track:" + trackID;
  return cacheGet(key) || cacheSet(key, deezerGet("/track/" + encodeURIComponent(trackID)));
}

function fetchAlbumData(albumID) {
  var key = "album:" + albumID;
  return cacheGet(key) || cacheSet(key, deezerGet("/album/" + encodeURIComponent(albumID)));
}

function fetchArtistData(artistID) {
  return deezerGet("/artist/" + encodeURIComponent(artistID));
}

function fetchPlaylistData(playlistID) {
  return deezerGet("/playlist/" + encodeURIComponent(playlistID));
}

function fetchArtistAlbums(artistID) {
  var result = deezerGet("/artist/" + encodeURIComponent(artistID) + "/albums?limit=100");
  return collectPaginatedItems(result, CONFIG.maxArtistAlbums);
}

function fetchArtistTopTracks(artistID) {
  var result = deezerGet("/artist/" + encodeURIComponent(artistID) + "/top?limit=" + CONFIG.maxArtistTopTracks);
  return collectPaginatedItems(result, CONFIG.maxArtistTopTracks);
}

function fetchCollectionTracks(container) {
  return collectPaginatedItems(container, CONFIG.maxCollectionTracks);
}

function fetchAlbumTracks(albumData) {
  if (!albumData || !albumData.id) return [];
  var key = "album-tracks:" + albumData.id;
  var cached = cacheGet(key);
  if (cached) return cached;
  var tracklistURL = String(albumData.tracklist || "").trim();
  if (!tracklistURL) {
    tracklistURL = "/album/" + encodeURIComponent(albumData.id) + "/tracks?limit=100";
  } else if (tracklistURL.indexOf("limit=") < 0) {
    tracklistURL += (tracklistURL.indexOf("?") >= 0 ? "&" : "?") + "limit=100";
  }
  return cacheSet(key, collectPaginatedItems(deezerGet(tracklistURL), CONFIG.maxCollectionTracks));
}

function fetchGatewayTrackData(trackID) {
  var key = "gateway-track:" + trackID;
  var cached = cacheGet(key);
  if (cached) return cached;
  return cacheSet(key, safeGatewayCall("song.getData", { sng_id: String(trackID) }) || {});
}

function fetchGatewayAlbumData(albumID) {
  var key = "gateway-album:" + albumID;
  var cached = cacheGet(key);
  if (cached) return cached;
  return cacheSet(key, safeGatewayCall("album.getData", { alb_id: String(albumID) }) || {});
}

function fetchGatewayAlbumTracks(albumID, trackItems) {
  var key = "gateway-album-tracks:" + albumID;
  var cached = cacheGet(key);
  if (cached) return cached;
  var ids = [];
  for (var i = 0; i < trackItems.length; i++) {
    if (trackItems[i] && trackItems[i].id) ids.push(String(trackItems[i].id));
  }
  if (!ids.length) return cacheSet(key, {});
  var payload = safeGatewayCall("song.getListData", { sng_ids: ids });
  var data = payload && Array.isArray(payload.data) ? payload.data : [];
  var byID = {};
  for (var di = 0; di < data.length; di++) {
    if (data[di] && data[di].SNG_ID) byID[String(data[di].SNG_ID)] = data[di];
  }
  return cacheSet(key, byID);
}

function totalDiscsFromTracks(trackItems) {
  var total = 0;
  for (var i = 0; i < trackItems.length; i++) {
    total = Math.max(total, numberValue(trackItems[i] && trackItems[i].disk_number));
  }
  return total;
}

function formatTrack(trackData, context) {
  if (!trackData || !trackData.id) return null;
  context = context || {};

  var albumData = context.album || trackData.album || null;
  var artistData = context.artist || trackData.artist || null;
  var gatewayTrack = context.gatewayTrack || null;
  var gatewayAlbum = context.gatewayAlbum || null;
  var artistName = normalizeArtists(trackData, gatewayTrack);
  if (!artistName && context.albumArtist) {
    artistName = context.albumArtist;
  }
  if (!artistName && artistData && artistData.name) {
    artistName = String(artistData.name);
  }

  var albumName = context.albumName || (albumData && albumData.title) || "";
  var albumArtist = context.albumArtist || (albumData && albumData.artist && albumData.artist.name) || (artistData && artistData.name) || artistName;
  var coverURL = context.coverURL || coverFromAlbum(albumData) || coverFromArtist(artistData);
  var releaseDate = context.releaseDate || (albumData && albumData.release_date) || trackData.release_date ||
    (gatewayAlbum && (gatewayAlbum.PHYSICAL_RELEASE_DATE || gatewayAlbum.DIGITAL_RELEASE_DATE || gatewayAlbum.ORIGINAL_RELEASE_DATE)) ||
    (gatewayTrack && (gatewayTrack.PHYSICAL_RELEASE_DATE || gatewayTrack.DIGITAL_RELEASE_DATE)) || "";
  var totalTracks = context.totalTracks || (albumData && albumData.nb_tracks) || 0;
  var itemID = withPrefix(trackData.id);
  var albumID = context.albumID || (albumData && albumData.id ? withPrefix(albumData.id) : "");
  var artistID = context.artistID || (artistData && artistData.id ? withPrefix(artistData.id) : "");
  var trackURL = String(trackData.link || directURL("track", trackData.id));
  var albumURL = String((albumData && albumData.link) || directURL("album", albumID));
  var artistURL = String((artistData && artistData.link) || directURL("artist", artistID));
  var discNumber = numberValue(trackData.disk_number || context.discNumber || (gatewayTrack && gatewayTrack.DISK_NUMBER));
  var trackNumber = numberValue(trackData.track_position || context.trackNumber || (gatewayTrack && gatewayTrack.TRACK_NUMBER));
  var isExplicit = !!(trackData.explicit_lyrics || isTruthyMetadata(trackData.explicit_content_lyrics) ||
    isTruthyMetadata(gatewayTrack && gatewayTrack.EXPLICIT_LYRICS) ||
    isTruthyMetadata(gatewayTrack && gatewayTrack.EXPLICIT_TRACK_CONTENT));

  return {
    id: itemID,
    spotify_id: itemID,
    deezer_id: String(trackData.id),
    name: String(trackData.title || trackData.title_short || ""),
    artists: artistName,
    album_name: String(albumName),
    album_artist: String(albumArtist || ""),
    artist_id: artistID,
    artist_url: artistURL,
    album_id: albumID,
    album_url: albumURL,
    external_urls: trackURL,
    external_links: { deezer: trackURL },
    duration_ms: Number(trackData.duration || 0) * 1000,
    preview_url: String(trackData.preview || ""),
    cover_url: coverURL,
    images: coverURL,
    release_date: normalizeDate(releaseDate),
    track_number: trackNumber,
    total_tracks: Number(totalTracks || 0),
    disc_number: discNumber,
    total_discs: Number(context.totalDiscs || 0),
    isrc: String(trackData.isrc || (gatewayTrack && gatewayTrack.ISRC) || ""),
    provider_id: "deezer",
    item_type: "track",
    album_type: albumTypeFromRecordType(context.albumType || (albumData && albumData.record_type)),
    upc: String((albumData && albumData.upc) || ""),
    label: String((albumData && albumData.label) || (gatewayAlbum && gatewayAlbum.LABEL_NAME) || ""),
    copyright: String((albumData && albumData.copyright) || (gatewayAlbum && gatewayAlbum.COPYRIGHT) || ""),
    genre: String(context.genre || ""),
    composer: composerNames(trackData, gatewayTrack),
    comment: albumURL,
    explicit: isExplicit,
    audio_quality: trackAudioQuality(trackData, gatewayTrack)
  };
}

function formatAlbum(albumData, context) {
  if (!albumData || !albumData.id) return null;
  context = context || {};

  var coverURL = coverFromAlbum(albumData);
  var gatewayAlbum = context.gatewayAlbum || null;
  var albumURL = String(albumData.link || directURL("album", albumData.id));
  return {
    id: withPrefix(albumData.id),
    name: String(albumData.title || ""),
    artists: String((albumData.artist && albumData.artist.name) || ""),
    artist_id: albumData.artist && albumData.artist.id ? withPrefix(albumData.artist.id) : "",
    artist_url: albumData.artist && albumData.artist.id ? directURL("artist", albumData.artist.id) : "",
    external_urls: albumURL,
    external_links: { deezer: albumURL },
    cover_url: coverURL,
    images: coverURL,
    release_date: normalizeDate(albumData.release_date || (gatewayAlbum &&
      (gatewayAlbum.PHYSICAL_RELEASE_DATE || gatewayAlbum.DIGITAL_RELEASE_DATE || gatewayAlbum.ORIGINAL_RELEASE_DATE))),
    total_tracks: Number(albumData.nb_tracks || (gatewayAlbum && gatewayAlbum.NUMBER_TRACK) || 0),
    total_discs: numberValue(context.totalDiscs || (gatewayAlbum && gatewayAlbum.NUMBER_DISK)),
    album_type: albumTypeFromRecordType(albumData.record_type),
    provider_id: "deezer",
    item_type: "album",
    upc: String(albumData.upc || ""),
    label: String(albumData.label || (gatewayAlbum && gatewayAlbum.LABEL_NAME) || ""),
    copyright: String(albumData.copyright || (gatewayAlbum && gatewayAlbum.COPYRIGHT) || ""),
    genre: extractGenres(albumData),
    explicit: !!(albumData.explicit_lyrics || isTruthyMetadata(gatewayAlbum && gatewayAlbum.EXPLICIT_ALBUM_CONTENT &&
      gatewayAlbum.EXPLICIT_ALBUM_CONTENT.EXPLICIT_LYRICS_STATUS)),
    audio_traits: ["lossless"]
  };
}

function formatArtist(artistData) {
  if (!artistData || !artistData.id) return null;

  var imageURL = coverFromArtist(artistData);
  var artistURL = String(artistData.link || directURL("artist", artistData.id));
  return {
    id: withPrefix(artistData.id),
    name: String(artistData.name || ""),
    image_url: imageURL,
    images: imageURL,
    header_image: imageURL,
    external_urls: artistURL,
    external_links: { deezer: artistURL },
    listeners: Number(artistData.nb_fan || 0),
    provider_id: "deezer",
    item_type: "artist"
  };
}

function formatPlaylist(playlistData) {
  if (!playlistData || !playlistData.id) return null;

  var coverURL = highestQualityDeezerCoverURL(
    playlistData.picture_xl ||
    playlistData.picture_big ||
    playlistData.picture_medium ||
    playlistData.picture ||
    ""
  );
  var playlistURL = String(playlistData.link || directURL("playlist", playlistData.id));

  return {
    id: withPrefix(playlistData.id),
    name: String(playlistData.title || ""),
    owner: String((playlistData.creator && playlistData.creator.name) || ""),
    cover_url: coverURL,
    images: coverURL,
    total_tracks: Number(playlistData.nb_tracks || 0),
    external_urls: playlistURL,
    external_links: { deezer: playlistURL },
    provider_id: "deezer",
    item_type: "playlist"
  };
}

function extractGenres(albumData) {
  if (!albumData || !albumData.genres || !albumData.genres.data || !albumData.genres.data.length) {
    return "";
  }
  return uniqueValues(albumData.genres.data.map(function(genre) {
    return genre && genre.name;
  })).join("; ");
}

function fetchTrack(trackID) {
  var rawID = parseTrackID(trackID);
  if (!rawID) throw new Error("invalid Deezer track ID");
  var trackData = fetchTrackData(rawID);
  var albumData = null;

  if (trackData && trackData.album && trackData.album.id) {
    try {
      albumData = fetchAlbumData(trackData.album.id);
    } catch (e) {
      log.debug("[DeezerExt] Album fetch for track failed:", e.message);
    }
  }

  var albumTrackItems = [];
  if (albumData) {
    try {
      albumTrackItems = fetchAlbumTracks(albumData);
    } catch (tracklistError) {
      log.debug("[DeezerExt] Album tracklist fetch for track failed:", tracklistError.message);
    }
  }
  var gatewayTrack = fetchGatewayTrackData(rawID);
  var gatewayAlbum = albumData && albumData.id ? fetchGatewayAlbumData(albumData.id) : null;
  var totalDiscs = numberValue(gatewayAlbum && gatewayAlbum.NUMBER_DISK) || totalDiscsFromTracks(albumTrackItems);

  var formatted = formatTrack(trackData, {
    album: albumData || trackData.album,
    albumName: albumData && albumData.title ? albumData.title : trackData.album && trackData.album.title,
    albumArtist: albumData && albumData.artist && albumData.artist.name ? albumData.artist.name : trackData.artist && trackData.artist.name,
    albumID: albumData && albumData.id ? withPrefix(albumData.id) : trackData.album && trackData.album.id ? withPrefix(trackData.album.id) : "",
    artistID: trackData.artist && trackData.artist.id ? withPrefix(trackData.artist.id) : "",
    releaseDate: albumData && albumData.release_date ? albumData.release_date : trackData.release_date,
    totalTracks: albumData && albumData.nb_tracks ? albumData.nb_tracks : 0,
    totalDiscs: totalDiscs,
    albumType: albumData && albumData.record_type ? albumData.record_type : "",
    coverURL: albumData ? coverFromAlbum(albumData) : coverFromAlbum(trackData.album),
    genre: extractGenres(albumData),
    gatewayTrack: gatewayTrack,
    gatewayAlbum: gatewayAlbum
  });

  return {
    track: formatted,
    album: albumData ? formatAlbum(albumData, { gatewayAlbum: gatewayAlbum, totalDiscs: totalDiscs }) : null
  };
}

function fetchAlbum(albumID) {
  var rawID = parseAlbumID(albumID);
  if (!rawID) throw new Error("invalid Deezer album ID");
  var albumData = fetchAlbumData(rawID);
  var gatewayAlbum = fetchGatewayAlbumData(rawID);
  var trackItems = fetchAlbumTracks(albumData);
  var gatewayTracks = fetchGatewayAlbumTracks(rawID, trackItems);
  var totalDiscs = numberValue(gatewayAlbum && gatewayAlbum.NUMBER_DISK) || totalDiscsFromTracks(trackItems);
  var info = formatAlbum(albumData, { gatewayAlbum: gatewayAlbum, totalDiscs: totalDiscs });
  var genre = extractGenres(albumData);
  var tracks = [];

  for (var i = 0; i < trackItems.length; i++) {
    var formatted = formatTrack(trackItems[i], {
      album: albumData,
      albumName: albumData.title,
      albumArtist: albumData.artist && albumData.artist.name ? albumData.artist.name : "",
      albumID: info.id,
      artistID: trackItems[i].artist && trackItems[i].artist.id ? withPrefix(trackItems[i].artist.id) : info.artist_id,
      releaseDate: albumData.release_date,
      totalTracks: albumData.nb_tracks,
      totalDiscs: totalDiscs,
      albumType: albumData.record_type,
      coverURL: info.cover_url,
      genre: genre,
      gatewayTrack: gatewayTracks[String(trackItems[i].id)] || null,
      gatewayAlbum: gatewayAlbum
    });
    if (formatted) tracks.push(formatted);
  }

  info.tracks = tracks;
  return info;
}

function fetchArtist(artistID) {
  var rawID = parseArtistID(artistID);
  if (!rawID) throw new Error("invalid Deezer artist ID");

  var artistData = fetchArtistData(rawID);
  var artistInfo = formatArtist(artistData);
  var albumItems = fetchArtistAlbums(rawID);
  var topTrackItems = fetchArtistTopTracks(rawID);
  var albums = [];
  var topTracks = [];

  for (var i = 0; i < albumItems.length; i++) {
    var albumInfo = formatAlbum(albumItems[i]);
    if (albumInfo) albums.push(albumInfo);
  }

  for (var j = 0; j < topTrackItems.length; j++) {
    var trackInfo = formatTrack(topTrackItems[j], {
      artist: artistData,
      artistID: artistInfo.id,
      coverURL: coverFromAlbum(topTrackItems[j].album),
      albumID: topTrackItems[j].album && topTrackItems[j].album.id ? withPrefix(topTrackItems[j].album.id) : "",
      albumName: topTrackItems[j].album && topTrackItems[j].album.title ? topTrackItems[j].album.title : "",
      albumArtist: artistInfo.name
    });
    if (trackInfo) topTracks.push(trackInfo);
  }

  artistInfo.albums = albums;
  artistInfo.top_tracks = topTracks;
  return artistInfo;
}

function fetchPlaylist(playlistID) {
  var rawID = parsePlaylistID(playlistID);
  if (!rawID) throw new Error("invalid Deezer playlist ID");

  var playlistData = fetchPlaylistData(rawID);
  var playlistInfo = formatPlaylist(playlistData);
  var trackItems = fetchCollectionTracks(playlistData.tracks || {});
  var tracks = [];

  for (var i = 0; i < trackItems.length; i++) {
    var formatted = formatTrack(trackItems[i], {
      album: trackItems[i].album,
      albumName: trackItems[i].album && trackItems[i].album.title ? trackItems[i].album.title : "",
      albumArtist: trackItems[i].artist && trackItems[i].artist.name ? trackItems[i].artist.name : "",
      albumID: trackItems[i].album && trackItems[i].album.id ? withPrefix(trackItems[i].album.id) : "",
      artistID: trackItems[i].artist && trackItems[i].artist.id ? withPrefix(trackItems[i].artist.id) : "",
      coverURL: coverFromAlbum(trackItems[i].album) || playlistInfo.cover_url,
      trackNumber: i + 1
    });
    if (formatted) tracks.push(formatted);
  }

  playlistInfo.tracks = tracks;
  return playlistInfo;
}

function resolveURLTarget(url) {
  var resolved = String(url || "").trim();
  if (!resolved) return "";

  if (resolved.indexOf("deezer.page.link") === -1 && resolved.indexOf("link.deezer.com") === -1) {
    return resolved;
  }

  try {
    var response = http.get(resolved, {
      "User-Agent": userAgentForURL(resolved),
      "Accept-Encoding": "identity"
    });

    if (response && response.url && response.url.indexOf("deezer.") !== -1 && response.url.indexOf("page.link") === -1) {
      return response.url;
    }

    if (response && response.headers) {
      var location = response.headers.Location || response.headers.location;
      if (location && String(location).indexOf("deezer.") !== -1) {
        return String(location);
      }
    }

    if (response && response.body) {
      var body = response.body;
      var canonicalMatch = body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
      if (!canonicalMatch) {
        canonicalMatch = body.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
      }
      if (canonicalMatch && canonicalMatch[1]) {
        return canonicalMatch[1];
      }
    }
  } catch (e) {
    log.debug("[DeezerExt] URL resolve failed:", e.message);
  }

  return resolved;
}

function parseURL(url) {
  var resolved = resolveURLTarget(url);
  var trackID = parseTrackID(resolved);
  if (trackID) return { type: "track", id: trackID };

  var albumID = parseAlbumID(resolved);
  if (albumID) return { type: "album", id: albumID };

  var artistID = parseArtistID(resolved);
  if (artistID) return { type: "artist", id: artistID };

  var playlistID = parsePlaylistID(resolved);
  if (playlistID) return { type: "playlist", id: playlistID };

  return null;
}

function handleURL(url) {
  try {
    var parsed = parseURL(url);
    if (!parsed) {
      return {
        success: false,
        error: "Unsupported Deezer URL"
      };
    }

    switch (parsed.type) {
      case "track":
        var trackResult = fetchTrack(parsed.id);
        return {
          type: "track",
          track: trackResult.track
        };
      case "album":
        var albumResult = fetchAlbum(parsed.id);
        return {
          type: "album",
          name: albumResult.name,
          cover_url: albumResult.cover_url,
          album: albumResult,
          tracks: albumResult.tracks
        };
      case "artist":
        return {
          type: "artist",
          artist: fetchArtist(parsed.id)
        };
      case "playlist":
        var playlistResult = fetchPlaylist(parsed.id);
        return {
          type: "playlist",
          name: playlistResult.name,
          cover_url: playlistResult.cover_url,
          tracks: playlistResult.tracks
        };
      default:
        return {
          success: false,
          error: "Unsupported Deezer URL type"
        };
    }
  } catch (e) {
    log.error("[DeezerExt] handleURL failed:", e.message);
    return {
      success: false,
      error: e.message || "Failed to fetch Deezer URL metadata"
    };
  }
}

function searchEndpointForFilter(filter) {
  switch (String(filter || "").trim().toLowerCase()) {
    case "track":
      return { path: "/search", type: "track" };
    case "album":
      return { path: "/search/album", type: "album" };
    case "artist":
      return { path: "/search/artist", type: "artist" };
    case "playlist":
      return { path: "/search/playlist", type: "playlist" };
    default:
      return null;
  }
}

function formatSearchItem(item, itemType) {
  switch (itemType) {
    case "track":
      return formatTrack(item, {
        album: item.album,
        albumName: item.album && item.album.title ? item.album.title : "",
        albumID: item.album && item.album.id ? withPrefix(item.album.id) : "",
        artistID: item.artist && item.artist.id ? withPrefix(item.artist.id) : "",
        coverURL: coverFromAlbum(item.album)
      });
    case "album":
      return formatAlbum(item);
    case "artist":
      return formatArtist(item);
    case "playlist":
      return formatPlaylist(item);
    default:
      return null;
  }
}

function searchOne(query, filter, limit) {
  var endpoint = searchEndpointForFilter(filter);
  if (!endpoint) return [];

  var data = deezerGet(endpoint.path + "?q=" + encodeURIComponent(query) + "&limit=" + encodeURIComponent(limit));
  var items = data && data.data ? data.data : [];
  var results = [];

  for (var i = 0; i < items.length; i++) {
    var formatted = formatSearchItem(items[i], endpoint.type);
    if (formatted) results.push(formatted);
  }

  return results;
}

function customSearch(query, options) {
  query = String(query || "").trim();
  if (!query) return [];

  options = options || {};
  var limit = Number(options.limit || 20);
  if (!limit || limit <= 0) limit = 20;
  if (limit > 50) limit = 50;

  var filter = String(options.filter || "").trim().toLowerCase();
  if (!filter || filter === "all") {
    filter = "";
  }

  if (filter) {
    return searchOne(query, filter, limit);
  }

  var results = [];
  var trackResults = searchOne(query, "track", limit);
  var artistResults = searchOne(query, "artist", 5);
  var albumResults = searchOne(query, "album", 5);
  var playlistResults = searchOne(query, "playlist", 5);

  results = results.concat(trackResults, artistResults, albumResults, playlistResults);
  return results;
}

function getTrack(trackID) {
  try {
    return fetchTrack(trackID).track;
  } catch (e) {
    log.error("[DeezerExt] getTrack failed:", e.message);
    return null;
  }
}

function getAlbum(albumID) {
  try {
    return fetchAlbum(albumID);
  } catch (e) {
    log.error("[DeezerExt] getAlbum failed:", e.message);
    return null;
  }
}

function getArtist(artistID) {
  try {
    return fetchArtist(artistID);
  } catch (e) {
    log.error("[DeezerExt] getArtist failed:", e.message);
    return null;
  }
}

function getPlaylist(playlistID) {
  try {
    return fetchPlaylist(playlistID);
  } catch (e) {
    log.error("[DeezerExt] getPlaylist failed:", e.message);
    return null;
  }
}

function enrichTrack(track) {
  if (!track || typeof track !== "object") return track;
  var rawID = parseTrackID(track.deezer_id || track.id || track.spotify_id || "");
  if (!rawID && track.isrc) {
    rawID = resolveTrackIDFromISRC(track.isrc);
  }
  if (!rawID) return track;
  try {
    var complete = fetchTrack(rawID).track;
    if (!complete) return track;
    return Object.assign({}, track, complete, {
      provider_id: "deezer",
      item_type: "track"
    });
  } catch (e) {
    log.debug("[DeezerExt] enrichTrack failed:", e.message);
    return track;
  }
}

function resolveTrackIDFromISRC(isrc) {
  if (!isrc) return "";
  try {
    var track = deezerGet("/track/isrc:" + encodeURIComponent(isrc));
    return track && track.id ? String(track.id) : "";
  } catch (e) {
    log.debug("[DeezerExt] ISRC resolve failed:", e.message);
    return "";
  }
}

function stripTrackTitleAnnotations(value) {
  return String(value || "").replace(/[(\[]\s*(?:(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+|from\s+["“][^)\]]+["”]\s*)[)\]]/gi, function(annotation) {
    if (/^[(\[]\s*with\b/i.test(annotation) &&
        /\b(?:mix|remix|live|acoustic|demo|instrumental|karaoke|edit|extended|slowed|sped)\b/i.test(annotation)) {
      return annotation;
    }
    return " ";
  });
}

function findBestSearchMatch(tracks, trackName, artistName, durationMs) {
  if (!tracks || !tracks.length) return null;

  var normalizedTrack = matching.normalizeString(stripTrackTitleAnnotations(trackName));
  var normalizedArtist = matching.normalizeString(artistName || "");
  var best = null;
  var bestScore = 0;

  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    if (!track || !track.id) continue;

    var score = 0;
    var title = track.title || "";
    var artist = track.artist && track.artist.name ? track.artist.name : "";
    var normalizedTitle = matching.normalizeString(stripTrackTitleAnnotations(title));
    var version = /\b(?:mix|remix|live|acoustic|demo|instrumental|karaoke|edit|extended|slowed|sped)\b/;
    if (normalizedTrack !== normalizedTitle &&
        (version.test(normalizedTrack) || version.test(normalizedTitle))) continue;
    var artistScore = matching.compareStrings(normalizedArtist, matching.normalizeString(artist));
    if (normalizedArtist && artistScore < 0.5) continue;
    var candidateDuration = Number(track.duration || 0) * 1000;
    if (durationMs > 0 && candidateDuration > 0 && Math.abs(durationMs - candidateDuration) > 15000) continue;

    if (normalizedTrack) {
      score += matching.compareStrings(normalizedTrack, normalizedTitle) * 70;
    }
    if (normalizedArtist) {
      score += artistScore * 30;
    }

    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }

  if (bestScore < 55) return null;
  return best;
}

function resolveTrackIDBySearch(trackName, artistName, durationMs) {
  var query = String(trackName || "").trim();
  if (artistName) {
    query += " " + String(artistName).trim();
  }
  query = query.trim();
  if (!query) return "";

  var queries = [query];
  var strippedTitle = stripTrackTitleAnnotations(trackName).replace(/\s+/g, " ").trim();
  if (strippedTitle && strippedTitle !== String(trackName || "").trim()) {
    var strippedQuery = (strippedTitle + " " + (artistName || "")).trim();
    if (queries.indexOf(strippedQuery) < 0) queries.push(strippedQuery);
  }
  try {
    for (var i = 0; i < queries.length; i++) {
      if (utils && typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled()) return "";
      var data = deezerGet("/search?q=" + encodeURIComponent(queries[i]) + "&limit=10");
      var best = findBestSearchMatch(data && data.data ? data.data : [], trackName, artistName, durationMs);
      if (best && best.id) return String(best.id);
    }
    return "";
  } catch (e) {
    log.debug("[DeezerExt] search resolve failed:", e.message);
    return "";
  }
}

function resolveTrackID(isrc, trackName, artistName, options) {
  options = options || {};

  var deezerID = parseTrackID(options.deezer_id || options.track_id || options.url || "");
  if (deezerID) return deezerID;

  if (isrc) {
    deezerID = resolveTrackIDFromISRC(isrc);
    if (deezerID) return deezerID;
  }

  return resolveTrackIDBySearch(trackName, artistName, Number(options.duration_ms || options.track && options.track.duration_ms || 0));
}

function checkAvailability(isrc, trackName, artistName, options) {
  var trackID = resolveTrackID(isrc, trackName, artistName, options || {});
  if (!trackID) {
    return {
      available: false,
      reason: "No Deezer track match found"
    };
  }

  return {
    available: true,
    track_id: trackID,
    prepared_context: {
      track: options && options.track || null
    }
  };
}

function resolveDownloadDescriptor(trackID) {
  var trackURL = CONFIG.deezerBaseURL + "/track/" + encodeURIComponent(trackID);
  var ticketID = signedTicket("dzr", "track", trackURL);
  return signedJSON("POST", CONFIG.resolverDownloadPath, {
    id: String(trackID || ""),
    type: "track",
    platform: "deezer",
    url: trackURL
  }, {
    "X-Zarz-Ticket": ticketID
  });
}

function resolveDescriptorDownloadURL(descriptor) {
  if (!descriptor) return "";

  var isDirectDownloadable = parseBoolean(descriptor.direct_downloadable, null);
  if (isDirectDownloadable === true && descriptor.direct_download_url) {
    return String(descriptor.direct_download_url);
  }

  if (descriptor.download_url) {
    return String(descriptor.download_url);
  }

  if (descriptor.direct_download_url) {
    return String(descriptor.direct_download_url);
  }

  return "";
}

function descriptorRequiresClientDecryption(descriptor) {
  if (!descriptor) return false;

  var explicit = parseBoolean(descriptor.requires_client_decryption, null);
  if (explicit !== null) {
    return explicit;
  }

  var directDownloadable = parseBoolean(descriptor.direct_downloadable, null);
  if (directDownloadable !== null) {
    return !directDownloadable;
  }

  return parseBoolean(descriptor.deezer_encrypted, false);
}

function decryptDownloadedFile(encryptedPath, outputPath, trackID, onProgress) {
  var keyHex = generateBlowfishKeyHex(trackID);
  var transformResult = file.transformPatternedBlocks(
    encryptedPath,
    outputPath,
    {
      operation: "decrypt",
      algorithm: "blowfish",
      mode: "cbc",
      key: keyHex,
      keyEncoding: "hex",
      iv: CONFIG.blowfishIVHex,
      ivEncoding: "hex",
      padding: "none",
      segmentSize: CONFIG.chunkSize,
      transformEvery: 3,
      transformOffset: 0,
      bufferSize: 1048576,
      transformPartial: false
    },
    function(processed, totalSize) {
      if (typeof onProgress !== "function" || totalSize <= 0) return;
      var percent = 35 + Math.floor((processed / totalSize) * 65);
      if (percent > 100) percent = 100;
      onProgress(percent);
    }
  );
  if (!transformResult || !transformResult.success) {
    throw new Error(transformResult && transformResult.error ? transformResult.error : "failed to transform encrypted file");
  }
  return transformResult.path || outputPath;
}

function trackAudioQuality(trackData, gatewayTrack) {
  var measured = cacheGet("audio-quality:" + String(trackData && trackData.id || ""));
  if (measured) return measured;
  var source = gatewayTrack || trackData || {};
  if (Number(source.FILESIZE_FLAC_24 || 0) > 0) return "24-bit FLAC";
  // Catalog metadata does not normally expose the source sample rate.
  return "FLAC";
}

function descriptorOutputExtension(descriptor) {
  var format = String(descriptor.deezer_source_format || descriptor.deezer_format || "FLAC").toUpperCase();
  return format.indexOf("MP3") === 0 ? "mp3" : "flac";
}

function downloadedAudioQuality(filePath, descriptor) {
  var measured = null;
  try {
    if (typeof gobackend !== "undefined" && gobackend && typeof gobackend.getAudioQuality === "function") {
      measured = gobackend.getAudioQuality(filePath);
      if (measured && measured.error) measured = null;
    }
  } catch (probeError) {
    log.debug("[DeezerExt] Audio quality probe unavailable:", probeError.message);
  }

  var bitDepth = Number(measured && (measured.bitDepth || measured.bit_depth) || 0);
  var sampleRate = Number(measured && (measured.sampleRate || measured.sample_rate) || 0);
  if (!isFinite(bitDepth) || bitDepth < 8 || bitDepth > 32 || Math.floor(bitDepth) !== bitDepth) bitDepth = 0;
  if (!isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 768000 || Math.floor(sampleRate) !== sampleRate) sampleRate = 0;

  var sourceFormat = String(descriptor.deezer_source_format || "").toUpperCase();
  var codec = String(measured && measured.codec || descriptorOutputExtension(descriptor)).toLowerCase();
  if (!bitDepth && codec === "flac") {
    if (sourceFormat === "FLAC_24") bitDepth = 24;
    else if (sourceFormat === "FLAC") bitDepth = 16;
  }
  var label = codec === "mp3" ? "MP3" : "FLAC";
  if (bitDepth && sampleRate) label = bitDepth + "bit/" + (sampleRate / 1000) + "kHz";
  else if (bitDepth) label = bitDepth + "-bit FLAC";

  return {
    bit_depth: bitDepth,
    sample_rate: sampleRate,
    audio_quality: label,
    audio_codec: codec,
    actual_container: codec === "mp3" ? "mp3" : "flac"
  };
}

function download(trackID, quality, outputPath, onProgress, options) {
  var resolvedTrackID = parseTrackID(trackID);
  if (!resolvedTrackID) {
    return {
      success: false,
      error_message: "Invalid Deezer track ID",
      error_type: "invalid_track"
    };
  }

  var prepared = options && options.preparedContext || {};
  var completeMetadata = prepared.track || prepared.host_track || null;
  if (!completeMetadata) {
    try {
      completeMetadata = fetchTrack(resolvedTrackID).track;
    } catch (e) {
      log.debug("[DeezerExt] Track metadata fetch failed:", e.message);
    }
  }

  var descriptor;
  try {
    descriptor = resolveDownloadDescriptor(resolvedTrackID);
  } catch (e2) {
    var resolveError = e2 && e2.message ? e2.message : String(e2);
    return {
      success: false,
      error_message: "Failed to resolve Deezer download: " + resolveError,
      error_type: resolveError.indexOf("VERIFY_REQUIRED") >= 0 ? "verification_required" : "api_error"
    };
  }

  var downloadURL = resolveDescriptorDownloadURL(descriptor);
  if (!descriptor || descriptor.success !== true || !downloadURL) {
    return {
      success: false,
      error_message: descriptor && descriptor.message ? descriptor.message : "Resolver did not return a download URL",
      error_type: "api_error"
    };
  }

  var requiresClientDecryption = descriptorRequiresClientDecryption(descriptor);
  var normalizedOutputPath = ensureOutputExtension(outputPath, descriptorOutputExtension(descriptor));
  var encryptedPath = requiresClientDecryption ? buildEncryptedTempPath(normalizedOutputPath) : normalizedOutputPath;

  if (typeof onProgress === "function") {
    onProgress(5);
  }

  var downloadResult = file.download(downloadURL, encryptedPath, {
    headers: {
      "User-Agent": userAgentForURL(downloadURL)
    }
  });
  if (!downloadResult || !downloadResult.success) {
    return {
      success: false,
      error_message: "Failed to download Deezer stream: " + (downloadResult && downloadResult.error ? downloadResult.error : "unknown error"),
      error_type: "download_error"
    };
  }

  var actualOutputPath = downloadResult.path || normalizedOutputPath;

  try {
    if (requiresClientDecryption) {
      var encryptedLocalPath = downloadResult.path || encryptedPath;
      var mediaTrackID = parseTrackID(descriptor.deezer_track_id) || resolvedTrackID;
      actualOutputPath = decryptDownloadedFile(encryptedLocalPath, normalizedOutputPath, mediaTrackID, onProgress);
      file.delete(encryptedLocalPath);
    }
  } catch (e3) {
    try { file.delete(downloadResult.path || encryptedPath); } catch (_) {}
    try { file.delete(actualOutputPath); } catch (_) {}
    return {
      success: false,
      error_message: "Failed to decrypt Deezer stream: " + e3.message,
      error_type: "decrypt_error"
    };
  }

  var audioQuality = downloadedAudioQuality(actualOutputPath, descriptor);
  if (audioQuality.bit_depth && audioQuality.sample_rate) {
    cacheSet("audio-quality:" + resolvedTrackID, audioQuality.audio_quality);
  }

  if (typeof onProgress === "function") {
    onProgress(100);
  }

  return {
    success: true,
    file_path: actualOutputPath,
    title: completeMetadata && completeMetadata.name ? completeMetadata.name : (descriptor.title || ""),
    name: completeMetadata && completeMetadata.name ? completeMetadata.name : (descriptor.title || ""),
    artist: completeMetadata && completeMetadata.artists ? completeMetadata.artists : (descriptor.artist || ""),
    artists: completeMetadata && completeMetadata.artists ? completeMetadata.artists : (descriptor.artist || ""),
    album: completeMetadata ? completeMetadata.album_name : "",
    album_name: completeMetadata ? completeMetadata.album_name : "",
    album_artist: completeMetadata ? completeMetadata.album_artist : "",
    artist_id: completeMetadata ? completeMetadata.artist_id : "",
    artist_url: completeMetadata ? completeMetadata.artist_url : "",
    album_id: completeMetadata ? completeMetadata.album_id : "",
    album_url: completeMetadata ? completeMetadata.album_url : "",
    external_urls: completeMetadata ? completeMetadata.external_urls : directURL("track", resolvedTrackID),
    external_links: completeMetadata ? completeMetadata.external_links : { deezer: directURL("track", resolvedTrackID) },
    track_number: completeMetadata ? completeMetadata.track_number : 0,
    total_tracks: completeMetadata ? completeMetadata.total_tracks : 0,
    disc_number: completeMetadata ? completeMetadata.disc_number : 0,
    total_discs: completeMetadata ? completeMetadata.total_discs : 0,
    release_date: completeMetadata ? completeMetadata.release_date : "",
    album_type: completeMetadata ? completeMetadata.album_type : "album",
    cover_url: completeMetadata ? completeMetadata.cover_url : "",
    preview_url: completeMetadata ? completeMetadata.preview_url : "",
    isrc: completeMetadata ? completeMetadata.isrc : "",
    upc: completeMetadata ? completeMetadata.upc : "",
    genre: completeMetadata ? completeMetadata.genre : "",
    composer: completeMetadata ? completeMetadata.composer : "",
    label: completeMetadata ? completeMetadata.label : "",
    copyright: completeMetadata ? completeMetadata.copyright : "",
    comment: completeMetadata ? completeMetadata.comment : "",
    explicit: completeMetadata ? completeMetadata.explicit : false,
    bit_depth: audioQuality.bit_depth,
    sample_rate: audioQuality.sample_rate,
    audio_quality: audioQuality.audio_quality,
    audio_codec: audioQuality.audio_codec,
    actual_container: audioQuality.actual_container
  };
}

function searchTracks(query, limit) {
  return customSearch(query, {
    limit: limit || 20,
    filter: "track"
  });
}

function seedArtistText(value) {
  if (Array.isArray(value)) {
    return uniqueValues(value.map(function(artist) {
      return artist && typeof artist === "object" ? artist.name : artist;
    })).join(", ");
  }
  return String(value || "").trim();
}

function normalizedISRC(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function isOwnSeed(seed) {
  return String(seed.provider_id || "").trim().toLowerCase() === "deezer";
}

// Returns the Deezer track for a seed, or null when it has no confident match.
// Network and HTTP failures propagate so the caller can tell them apart.
function resolveRelatedSeed(seed) {
  if (isOwnSeed(seed)) {
    var ownID = parseTrackID(seed.id);
    return ownID ? { id: ownID, isrc: normalizedISRC(seed.isrc) } : null;
  }

  var isrc = normalizedISRC(seed.isrc);
  if (isrc) {
    var track = deezerGet("/track/isrc:" + encodeURIComponent(isrc));
    if (!track || track.error || !track.id) return null;
    return { id: String(track.id), isrc: normalizedISRC(track.isrc) || isrc };
  }

  var trackName = String(seed.name || "").trim();
  var artistName = seedArtistText(seed.artists);
  var query = (trackName + " " + artistName).trim();
  if (!query) return null;
  var data = deezerGet("/search?q=" + encodeURIComponent(query) + "&limit=10");
  var best = findBestSearchMatch(data && data.data ? data.data : [], trackName, artistName);
  return best && best.id ? { id: String(best.id), isrc: normalizedISRC(best.isrc) } : null;
}

function gatewaySongPreviewURL(song) {
  var media = song && Array.isArray(song.MEDIA) ? song.MEDIA : [];
  for (var i = 0; i < media.length; i++) {
    if (media[i] && media[i].TYPE === "preview" && media[i].HREF) {
      return String(media[i].HREF);
    }
  }
  return "";
}

// Maps a gateway song onto the public API track shape so formatTrack can reuse
// the search mapping, with the gateway record supplying artists and credits.
function formatGatewaySong(song) {
  if (!song || !song.SNG_ID) return null;
  var title = String(song.SNG_TITLE || "").trim();
  var version = String(song.VERSION || "").trim();
  if (version && title.toLowerCase().indexOf(version.toLowerCase()) < 0) {
    title += " " + version;
  }
  var picture = String(song.ALB_PICTURE || "").trim();
  var album = song.ALB_ID ? {
    id: String(song.ALB_ID),
    title: String(song.ALB_TITLE || ""),
    cover_xl: picture ? "https://cdn-images.dzcdn.net/images/cover/" + encodeURIComponent(picture) +
      "/1000x1000-000000-80-0-0.jpg" : ""
  } : null;
  var artist = song.ART_ID ? { id: String(song.ART_ID), name: String(song.ART_NAME || "") } : null;
  var trackData = {
    id: String(song.SNG_ID),
    title: title,
    duration: numberValue(song.DURATION),
    isrc: String(song.ISRC || ""),
    preview: gatewaySongPreviewURL(song),
    disk_number: song.DISK_NUMBER,
    track_position: song.TRACK_NUMBER,
    album: album,
    artist: artist
  };
  return formatTrack(trackData, {
    album: album,
    artist: artist,
    gatewayTrack: song,
    albumID: album ? withPrefix(album.id) : "",
    artistID: artist ? withPrefix(artist.id) : ""
  });
}

function fetchTrackMix(trackID) {
  var payload = gatewayCall("song.getSearchTrackMix", {
    sng_id: String(trackID),
    start_with_input_track: false
  });
  var songs = payload && Array.isArray(payload.data) ? payload.data : [];
  var tracks = [];
  for (var i = 0; i < songs.length; i++) {
    var formatted = formatGatewaySong(songs[i]);
    if (formatted) tracks.push(formatted);
  }
  return tracks;
}

function getRelatedTracks(seeds, options) {
  var limit = Number(options && options.limit) || 25;
  limit = Math.max(1, Math.min(50, Math.floor(limit)));
  var list = Array.isArray(seeds) ? seeds.slice(0, 10) : [];
  var excludedIDs = {};
  var excludedISRCs = {};
  var i;

  for (i = 0; i < list.length; i++) {
    var seed = list[i] || {};
    var seedISRC = normalizedISRC(seed.isrc);
    if (seedISRC) excludedISRCs[seedISRC] = true;
    if (isOwnSeed(seed)) {
      var seedID = parseTrackID(seed.id);
      if (seedID) excludedIDs[seedID] = true;
    }
  }

  var succeeded = false;
  var lastError = null;
  var groups = [];
  var seen = {};
  for (i = 0; i < list.length && i < 5; i++) {
    var resolved = null;
    try {
      resolved = resolveRelatedSeed(list[i] || {});
      if (!isOwnSeed(list[i] || {})) succeeded = true;
    } catch (resolveError) {
      lastError = resolveError;
      log.debug("[DeezerExt] Related seed resolve failed:", resolveError.message);
      continue;
    }
    if (!resolved || seen[resolved.id]) continue;
    seen[resolved.id] = true;
    excludedIDs[resolved.id] = true;
    if (resolved.isrc) excludedISRCs[resolved.isrc] = true;
    try {
      groups.push(fetchTrackMix(resolved.id));
      succeeded = true;
    } catch (mixError) {
      lastError = mixError;
      log.debug("[DeezerExt] Track mix failed:", mixError.message);
    }
  }

  if (!succeeded && lastError) throw lastError;

  var results = [];
  var added = {};
  var maxLength = 0;
  for (i = 0; i < groups.length; i++) {
    maxLength = Math.max(maxLength, groups[i].length);
  }
  for (var position = 0; position < maxLength && results.length < limit; position++) {
    for (i = 0; i < groups.length && results.length < limit; i++) {
      var track = groups[i][position];
      if (!track) continue;
      var rawID = String(track.deezer_id || stripPrefix(track.id));
      var trackISRC = normalizedISRC(track.isrc);
      if (excludedIDs[rawID] || added[track.id] || (trackISRC && excludedISRCs[trackISRC])) continue;
      added[track.id] = true;
      results.push(track);
    }
  }
  return results;
}

function completeGrant() {
  if (typeof session === "undefined" || !session || typeof session.completeGrant !== "function") {
    return { success: false, error: "signed session runtime is not available" };
  }
  return session.completeGrant();
}

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  completeGrant: completeGrant,
  customSearch: customSearch,
  handleUrl: handleURL,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  getPlaylist: getPlaylist,
  enrichTrack: enrichTrack,
  searchTracks: searchTracks,
  getRelatedTracks: getRelatedTracks,
  checkAvailability: checkAvailability,
  download: download,
  getDownloadUrl: function () { return null; }
});

log.info("[DeezerExt] Deezer metadata and download extension loaded");
