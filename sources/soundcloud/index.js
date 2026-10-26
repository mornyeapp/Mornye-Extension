// ============================================
// SoundCloud Extension for Mornye
// Version: 1.0.12
//
// Uses SoundCloud's api-v2 metadata, AAC HLS and legacy progressive streams.
//
// client_id is extracted from SoundCloud's JS bundles
// (same pattern as Apple Music developer token extraction).
// ============================================

var SC_API = "https://api-v2.soundcloud.com";
var TRACK_CACHE_TTL_MS = 5 * 60 * 1000;
var TRACK_CACHE_MAX_ENTRIES = 300;
var TRACK_CACHE = new Map();

var state = {
  clientId: null,
  clientIdExpiry: 0,
  scVersion: ""
};

// ============================================
// INITIALIZATION
// ============================================

function initialize(config) {
  log.info("[SC] SoundCloud Extension initializing...");

  try {
    var cached = storage.get("sc_state");
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed.clientId && parsed.clientIdExpiry && Date.now() < parsed.clientIdExpiry) {
        state.clientId = parsed.clientId;
        state.clientIdExpiry = parsed.clientIdExpiry;
        state.scVersion = parsed.scVersion || "";
        log.info("[SC] Loaded cached client_id (expires in " +
          Math.round((state.clientIdExpiry - Date.now()) / 60000) + " min)");
      }
    }
  } catch (e) {
  }

  return true;
}

function cleanup() {
  TRACK_CACHE.clear();
  persistSoundCloudState();
}

function persistSoundCloudState() {
  try {
    storage.set("sc_state", JSON.stringify({
      clientId: state.clientId,
      clientIdExpiry: state.clientIdExpiry,
      scVersion: state.scVersion
    }));
  } catch (e) {}
}

function trackCacheGet(trackID) {
  var key = String(trackID || "");
  var entry = TRACK_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    TRACK_CACHE.delete(key);
    return null;
  }
  TRACK_CACHE.delete(key);
  TRACK_CACHE.set(key, entry);
  return entry.value;
}

function trackCacheSet(trackID, value) {
  var key = String(trackID || "");
  if (!key || !value) return value;
  if (TRACK_CACHE.has(key)) TRACK_CACHE.delete(key);
  TRACK_CACHE.set(key, {
    value: value,
    expiresAt: Date.now() + TRACK_CACHE_TTL_MS
  });
  while (TRACK_CACHE.size > TRACK_CACHE_MAX_ENTRIES) {
    TRACK_CACHE.delete(TRACK_CACHE.keys().next().value);
  }
  return value;
}

function userAgentForURL(url) {
  return utils.randomUserAgent();
}

// ============================================
// CLIENT ID EXTRACTION
// ============================================

function soundCloudResponseError(response) {
  if (!response) return "no response";
  if (response.error) return String(response.error);
  return response.statusCode ? "HTTP " + response.statusCode : "missing HTTP status";
}

function soundCloudGet(url, headers) {
  var response;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      response = http.get(url, headers);
    } catch (error) {
      response = { error: (error && error.message) || String(error) };
    }
    var reason = soundCloudResponseError(response);
    var retryable = !response || response.error || response.statusCode === 408 || response.statusCode >= 500;
    if (attempt === 1 || !retryable || /cancel|denied|not permitted|certificate/i.test(reason)) break;
    log.warn("[SC] Request retry after:", reason);
    if (typeof utils.sleep === "function" && utils.sleep(250) === false) {
      throw new Error("SoundCloud request cancelled");
    }
  }
  return response;
}

function fetchClientId() {
  log.info("[SC] Fetching SoundCloud client_id...");

  var response = soundCloudGet("https://soundcloud.com/", {
    "User-Agent": utils.randomUserAgent()
  });

  if (!response || response.error || response.statusCode !== 200) {
    throw new Error("Failed to fetch soundcloud.com: " + soundCloudResponseError(response));
  }

  var body = response.body || "";

  // Extract __sc_version for cache key
  var versionMatch = body.match(/__sc_version="(\d{10})"/);
  if (versionMatch) {
    var newVersion = versionMatch[1];
    if (newVersion === state.scVersion && state.clientId) {
      state.clientIdExpiry = Date.now() + (24 * 60 * 60 * 1000);
      persistSoundCloudState();
      log.info("[SC] SoundCloud version unchanged, reusing cached client_id");
      return;
    }
    state.scVersion = newVersion;
  }

  // Strategy 1: Look for client_id directly in HTML
  var directMatch = body.match(/["']?client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
  if (directMatch) {
    state.clientId = directMatch[1];
    state.clientIdExpiry = Date.now() + (24 * 60 * 60 * 1000); // 24h
    persistSoundCloudState();
    log.info("[SC] Found client_id in HTML");
    return;
  }

  // Strategy 2: Extract from JS bundles at a-v2.sndcdn.com
  var scriptMatches = body.match(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g);
  if (!scriptMatches) {
    // Fallback: any script with sndcdn
    scriptMatches = body.match(/src="(https:\/\/[^"]*sndcdn\.com[^"]*\.js)"/g);
  }

  var lastBundleError = null;
  if (scriptMatches) {
    // Process from last to first (client_id is usually in later bundles)
    for (var i = scriptMatches.length - 1; i >= 0 && i >= scriptMatches.length - 8; i--) {
      var srcMatch = scriptMatches[i].match(/src="([^"]+)"/);
      if (!srcMatch) continue;

      var bundleURL = srcMatch[1];
      log.debug("[SC] Checking bundle:", bundleURL.substring(bundleURL.lastIndexOf("/") + 1));

      try {
        var bundleResp = soundCloudGet(bundleURL, {
          "User-Agent": utils.randomUserAgent()
        });

        if (bundleResp && !bundleResp.error && bundleResp.statusCode === 200) {
          var bundleBody = bundleResp.body || "";

          // Look for client_id pattern: client_id:"XXXX" or client_id=XXXX
          var cidMatch = bundleBody.match(/["']?client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
          if (!cidMatch) {
            // Alternative pattern: ("client_id=XXXXX")
            cidMatch = bundleBody.match(/\("client_id=([a-zA-Z0-9]{32})"\)/);
          }
          if (!cidMatch) {
            // client_id=XXXXX within a string
            var idx = bundleBody.indexOf("client_id=");
            if (idx !== -1) {
              var start = idx + 10;
              var end = start;
              var chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
              while (end < bundleBody.length && end - start < 32 && chars.indexOf(bundleBody.charAt(end)) !== -1) {
                end++;
              }
              if (end - start === 32) {
                cidMatch = [null, bundleBody.substring(start, end)];
              }
            }
          }

          if (cidMatch) {
            state.clientId = cidMatch[1];
            state.clientIdExpiry = Date.now() + (24 * 60 * 60 * 1000);
            persistSoundCloudState();
            log.info("[SC] Found client_id in JS bundle");
            return;
          }
        } else {
          lastBundleError = soundCloudResponseError(bundleResp);
        }
      } catch (e) {
        lastBundleError = e.message || String(e);
        log.debug("[SC] Bundle fetch failed:", e.message);
      }
    }
  }

  throw new Error("Could not find SoundCloud client_id in page or JS bundles" +
    (lastBundleError ? ": " + lastBundleError : ""));
}

function ensureClientId() {
  if (!state.clientId || Date.now() >= state.clientIdExpiry) {
    fetchClientId();
  }
}

// ============================================
// API HELPERS
// ============================================

function scGet(path, extraParams) {
  ensureClientId();

  var sep = path.indexOf("?") === -1 ? "?" : "&";
  var url = SC_API + "/" + path + sep + "client_id=" + state.clientId;
  if (extraParams) {
    url += "&" + extraParams;
  }

  var response = soundCloudGet(url, {
    "User-Agent": utils.randomUserAgent(),
    "Accept": "application/json"
  });

  if (!response || response.error) {
    throw new Error("SoundCloud API failed: " + soundCloudResponseError(response));
  }

  if (response.statusCode === 401 || response.statusCode === 403) {
    // client_id may be invalid, try refreshing
    log.info("[SC] Authorization rejected, refreshing client_id...");
    state.clientId = null;
    state.clientIdExpiry = 0;
    ensureClientId();
    // Retry once
    sep = path.indexOf("?") === -1 ? "?" : "&";
    url = SC_API + "/" + path + sep + "client_id=" + state.clientId;
    if (extraParams) url += "&" + extraParams;
    response = soundCloudGet(url, {
      "User-Agent": utils.randomUserAgent(),
      "Accept": "application/json"
    });
    if (!response || response.error || response.statusCode !== 200) {
      throw new Error("SoundCloud API failed after retry: " + soundCloudResponseError(response));
    }
  }

  if (response.statusCode !== 200) {
    throw new Error("SoundCloud API returned HTTP " + response.statusCode);
  }

  return JSON.parse(response.body);
}

/**
 * Resolve a SoundCloud URL to its API object.
 */
function scResolve(url) {
  return scGet("resolve?url=" + encodeURIComponent(url));
}

/**
 * Artwork URL helper. Replace -large with higher resolution suffix.
 */
function hiResArtwork(url) {
  if (!url) return "";
  return url.replace("-large.", "-t500x500.");
}

function originalArtwork(url) {
  if (!url) return "";
  return url.replace("-large.", "-original.");
}

// ============================================
// FORMAT HELPERS
// ============================================

function formatTrack(track) {
  if (!track || !track.id) return null;

  var attr = track;
  var user = attr.user || {};
  var pub = attr.publisher_metadata || {};

  var artist = pub.artist || attr.metadata_artist || user.username || "";
  var albumName = pub.album_title || pub.release_title || "";

  // Build cover URL — prefer original, fallback to t500x500
  var coverURL = originalArtwork(attr.artwork_url);
  if (!coverURL && user.avatar_url) {
    coverURL = hiResArtwork(user.avatar_url);
  }

  return {
    id: String(attr.id),
    name: attr.title || "",
    artists: artist,
    album_name: albumName,
    album_artist: user.username || "",
    duration_ms: attr.full_duration || attr.duration || 0,
    cover_url: coverURL,
    images: coverURL,
    release_date: formatDate(attr.display_date || attr.created_at),
    track_number: 0,
    disc_number: 1,
    isrc: pub.isrc || attr.isrc || "",
    label: attr.label_name || "",
    copyright: pub.p_line_for_display || pub.c_line_for_display || "",
    genre: attr.genre || "",
    composer: pub.writer_composer || "",
    external_urls: attr.permalink_url || "",
    provider_id: "soundcloud",
    item_type: "track"
  };
}

function formatPlaylistOrAlbum(playlist) {
  if (!playlist || !playlist.id) return null;

  var user = playlist.user || {};
  var isAlbum = playlist.is_album || (playlist.set_type === "album") ||
                (playlist.set_type === "ep") || (playlist.set_type === "compilation") ||
                (playlist.set_type === "single");

  var coverURL = originalArtwork(playlist.artwork_url);
  if (!coverURL && user.avatar_url) {
    coverURL = hiResArtwork(user.avatar_url);
  }

  var albumType = playlist.set_type || (isAlbum ? "album" : "playlist");

  return {
    id: String(playlist.id),
    name: playlist.title || "",
    artists: user.username || "",
    artist_id: user.id ? String(user.id) : "",
    images: coverURL,
    cover_url: coverURL,
    release_date: formatDate(playlist.display_date || playlist.published_at || playlist.created_at),
    total_tracks: playlist.track_count || 0,
    album_type: albumType,
    record_label: playlist.label_name || "",
    genre: playlist.genre || "",
    external_urls: playlist.permalink_url || "",
    provider_id: "soundcloud",
    item_type: isAlbum ? "album" : "playlist"
  };
}

function formatUser(user) {
  if (!user || !user.id) return null;

  var avatarURL = originalArtwork(user.avatar_url);

  return {
    id: String(user.id),
    name: user.username || user.full_name || "",
    image_url: avatarURL,
    images: avatarURL,
    listeners: user.followers_count || 0,
    external_urls: user.permalink_url || "",
    provider_id: "soundcloud",
    item_type: "artist"
  };
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  return dateStr.substring(0, 10);
}

// ============================================
// FETCH FUNCTIONS
// ============================================

function fetchTrack(trackId) {
  log.info("[SC] Fetching track:", trackId);
  var data = fetchTrackData(trackId);
  return formatTrack(data);
}

function fetchTrackData(trackId) {
  var cached = trackCacheGet(trackId);
  if (cached) return cached;
  return trackCacheSet(trackId, scGet("tracks/" + trackId));
}

function fetchPlaylistOrAlbum(playlistId) {
  log.info("[SC] Fetching playlist/album:", playlistId);
  var data = scGet("playlists/" + playlistId + "?representation=full");

  var info = formatPlaylistOrAlbum(data);
  if (!info) throw new Error("Failed to format playlist/album");

  var tracks = [];
  var trackItems = data.tracks || [];

  // SoundCloud may return abbreviated tracks — collect full IDs for batch fetch
  var needFullFetch = [];
  for (var i = 0; i < trackItems.length; i++) {
    var t = trackItems[i];
    if (t.title) {
      // Full track object
      trackCacheSet(t.id, t);
      var ft = formatTrack(t);
      if (ft) {
        ft.track_number = i + 1;
        tracks.push(ft);
      }
    } else if (t.id) {
      // Abbreviated — just has id
      needFullFetch.push(t.id);
    }
  }

  // Batch fetch missing tracks (API supports comma-separated IDs)
  if (needFullFetch.length > 0) {
    var batchSize = 50;
    for (var b = 0; b < needFullFetch.length; b += batchSize) {
      var batch = needFullFetch.slice(b, b + batchSize);
      try {
        var batchData = scGet("tracks?ids=" + batch.join(","));
        if (batchData && batchData.length) {
          // Build ID->track map for ordering
          var trackMap = {};
          for (var j = 0; j < batchData.length; j++) {
            trackMap[batchData[j].id] = batchData[j];
          }
          for (var k = 0; k < batch.length; k++) {
            var fullTrack = trackMap[batch[k]];
            if (fullTrack) {
              trackCacheSet(fullTrack.id, fullTrack);
              var formatted = formatTrack(fullTrack);
              if (formatted) {
                formatted.track_number = tracks.length + 1;
                tracks.push(formatted);
              }
            }
          }
        }
      } catch (e) {
        log.debug("[SC] Batch track fetch failed:", e.message);
      }
    }
  }

  info.total_tracks = tracks.length;
  return { info: info, tracks: tracks };
}

function fetchArtist(userId) {
  log.info("[SC] Fetching artist:", userId);
  var userData = scGet("users/" + userId);
  var artistInfo = formatUser(userData);
  if (!artistInfo) throw new Error("Failed to format user");

  // Fetch top tracks
  var topTracks = [];
  try {
    var topData = scGet("users/" + userId + "/toptracks", "limit=20");
    var topItems = topData.collection || topData || [];
    if (Array.isArray(topItems)) {
      for (var i = 0; i < topItems.length; i++) {
        var t = formatTrack(topItems[i]);
        if (t) topTracks.push(t);
      }
    }
  } catch (e) {
    log.debug("[SC] Top tracks fetch failed:", e.message);
    // Fallback to recent tracks
    try {
      var recentData = scGet("users/" + userId + "/tracks", "limit=20");
      var recentItems = recentData.collection || recentData || [];
      if (Array.isArray(recentItems)) {
        for (var ri = 0; ri < recentItems.length; ri++) {
          var rt = formatTrack(recentItems[ri]);
          if (rt) topTracks.push(rt);
        }
      }
    } catch (e2) {
      log.debug("[SC] Recent tracks fetch failed:", e2.message);
    }
  }

  // Fetch albums
  var albums = [];
  try {
    var albumData = scGet("users/" + userId + "/albums", "limit=50");
    var albumItems = albumData.collection || albumData || [];
    if (Array.isArray(albumItems)) {
      for (var a = 0; a < albumItems.length; a++) {
        var albumInfo = formatPlaylistOrAlbum(albumItems[a]);
        if (albumInfo) albums.push(albumInfo);
      }
    }
  } catch (e) {
    log.debug("[SC] Albums fetch failed:", e.message);
  }

  return {
    type: "artist",
    artist: {
      id: artistInfo.id,
      name: artistInfo.name,
      image_url: artistInfo.image_url,
      listeners: artistInfo.listeners,
      albums: albums,
      top_tracks: topTracks,
      provider_id: "soundcloud"
    }
  };
}

// ============================================
// SEARCH
// ============================================

function customSearch(query, options) {
  log.info("[SC] Searching:", query);

  var limit = (options && options.limit) || 20;
  var offset = (options && options.offset) || 0;
  var filter = (options && options.filter) || null;
  if (limit <= 0 || limit > 50) limit = 50;

  var isFiltered = filter && filter !== "all";
  var results = [];
  var successfulSearches = 0;
  var firstError = null;

  // Bootstrap once, so an unavailable session does not repeat for every type.
  ensureClientId();

  // Determine which types to search
  var searchTypes = ["tracks", "albums", "users", "playlists"];
  if (isFiltered) {
    var typeMap = {
      "tracks": "tracks",
      "albums": "albums",
      "artists": "users",
      "playlists": "playlists"
    };
    searchTypes = [typeMap[filter] || "tracks"];
  }

  for (var ti = 0; ti < searchTypes.length; ti++) {
    var searchType = searchTypes[ti];
    var searchLimit = isFiltered ? limit : (searchType === "tracks" ? limit : 5);

    try {
      var data = scGet("search/" + searchType + "?q=" + encodeURIComponent(query),
        "limit=" + searchLimit + "&offset=" + offset + "&access=playable");

      var items = data.collection || [];
      successfulSearches++;

      for (var i = 0; i < items.length; i++) {
        var item = items[i];

        if (searchType === "tracks") {
          trackCacheSet(item.id, item);
          var track = formatTrack(item);
          if (track) results.push(track);
        } else if (searchType === "albums") {
          var album = formatPlaylistOrAlbum(item);
          if (album) {
            album.item_type = "album";
            results.push(album);
          }
        } else if (searchType === "users") {
          var user = formatUser(item);
          if (user) {
            user.item_type = "artist";
            results.push(user);
          }
        } else if (searchType === "playlists") {
          var pl = formatPlaylistOrAlbum(item);
          if (pl) {
            pl.item_type = "playlist";
            results.push(pl);
          }
        }
      }
    } catch (e) {
      if (!firstError) firstError = e;
      log.debug("[SC] Search for " + searchType + " failed:", e.message);
    }
  }

  if (!successfulSearches && firstError) throw firstError;
  log.info("[SC] Found", results.length, "results (filter:", filter || "all", ")");
  return results;
}

// ============================================
// URL HANDLING
// ============================================

/**
 * Parse a SoundCloud URL into components.
 * Returns { type, permalink_url } or null.
 */
function parseSoundCloudURL(url) {
  url = (url || "").trim();
  if (!url) return null;

  // Normalize mobile/short URLs
  url = url.replace(/^https?:\/\/m\.soundcloud\.com/, "https://soundcloud.com");
  // on.soundcloud.com short links need resolution
  if (url.indexOf("on.soundcloud.com") !== -1) {
    return { type: "resolve", permalink_url: url };
  }

  // https://soundcloud.com/{author}/sets/{slug}
  var setsMatch = url.match(/soundcloud\.com\/([^/?#]+)\/sets\/([^/?#]+)/i);
  if (setsMatch) {
    return { type: "playlist", permalink_url: "https://soundcloud.com/" + setsMatch[1] + "/sets/" + setsMatch[2] };
  }

  // https://soundcloud.com/{author}/{track}
  var trackMatch = url.match(/soundcloud\.com\/([^/?#]+)\/([^/?#]+)/i);
  if (trackMatch && trackMatch[2] !== "sets" && trackMatch[2] !== "albums" &&
      trackMatch[2] !== "tracks" && trackMatch[2] !== "likes" &&
      trackMatch[2] !== "followers" && trackMatch[2] !== "following" &&
      trackMatch[2] !== "reposts" && trackMatch[2] !== "playlists" &&
      trackMatch[2] !== "popular-tracks") {
    return { type: "track", permalink_url: "https://soundcloud.com/" + trackMatch[1] + "/" + trackMatch[2] };
  }

  // https://soundcloud.com/{author} (user profile)
  var userMatch = url.match(/soundcloud\.com\/([^/?#]+)\/?$/i);
  if (userMatch) {
    return { type: "user", permalink_url: "https://soundcloud.com/" + userMatch[1] };
  }

  // Unknown — try resolving
  return { type: "resolve", permalink_url: url };
}

function handleURL(url) {
  log.info("[SC] Handling URL:", url);

  var parsed = parseSoundCloudURL(url);
  if (!parsed) {
    return { success: false, error: "Invalid SoundCloud URL" };
  }

  // on.soundcloud.com short links are 302 redirects that the API can't resolve.
  // Follow the redirect to get the real soundcloud.com URL first.
  if (parsed.type === "resolve" && parsed.permalink_url.indexOf("on.soundcloud.com") !== -1) {
    log.info("[SC] Resolving short link:", parsed.permalink_url);
    try {
      var redirectResp = http.get(parsed.permalink_url, {
        "User-Agent": utils.randomUserAgent()
      });
      var finalUrl = "";

      // Method 1: Use response.url (final URL after redirects, requires updated Go backend)
      if (redirectResp && !redirectResp.error && redirectResp.url &&
          redirectResp.url.indexOf("soundcloud.com") !== -1 &&
          redirectResp.url.indexOf("on.soundcloud.com") === -1) {
        finalUrl = redirectResp.url;
        log.info("[SC] Got final URL from response.url");
      }

      // Method 2: Parse canonical URL from HTML body
      if (!finalUrl && redirectResp && redirectResp.body) {
        var canonMatch = redirectResp.body.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
        if (!canonMatch) {
          canonMatch = redirectResp.body.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
        }
        if (canonMatch && canonMatch[1] && canonMatch[1].indexOf("soundcloud.com") !== -1) {
          finalUrl = canonMatch[1];
          log.info("[SC] Got final URL from HTML meta tag");
        }
      }

      if (finalUrl) {
        // Strip tracking params
        var qIdx = finalUrl.indexOf("?");
        if (qIdx !== -1) finalUrl = finalUrl.substring(0, qIdx);
        log.info("[SC] Resolved short link ->", finalUrl);
        parsed = parseSoundCloudURL(finalUrl);
        if (!parsed) {
          return { success: false, error: "Could not parse resolved URL: " + finalUrl };
        }
      } else {
        log.warn("[SC] Could not extract final URL from short link response");
      }
    } catch (e) {
      log.warn("[SC] Short link redirect failed:", e.message);
      // Fall through — will try /resolve with original URL as last resort
    }
  }

  try {
    // Use the resolve endpoint — works for all URL types
    var resolved = scResolve(parsed.permalink_url);
    if (!resolved) {
      return { success: false, error: "Could not resolve URL" };
    }

    var kind = resolved.kind;

    if (kind === "track") {
      trackCacheSet(resolved.id, resolved);
      var track = formatTrack(resolved);
      return { success: true, type: "track", track: track };
    }

    if (kind === "playlist") {
      var playlistData = fetchPlaylistOrAlbum(resolved.id);
      var isAlbum = resolved.is_album || (resolved.set_type === "album") ||
                    (resolved.set_type === "ep") || (resolved.set_type === "single");

      if (isAlbum) {
        return {
          success: true,
          type: "album",
          album: {
            id: String(resolved.id),
            name: playlistData.info.name,
            artists: playlistData.info.artists,
            cover_url: playlistData.info.cover_url,
            release_date: playlistData.info.release_date,
            total_tracks: playlistData.tracks.length,
            tracks: playlistData.tracks
          },
          tracks: playlistData.tracks,
          name: playlistData.info.name,
          cover_url: playlistData.info.cover_url
        };
      }

      return {
        success: true,
        type: "playlist",
        tracks: playlistData.tracks,
        name: playlistData.info.name,
        cover_url: playlistData.info.cover_url
      };
    }

    if (kind === "user") {
      var artistResult = fetchArtist(resolved.id);
      return {
        success: true,
        type: "artist",
        artist: artistResult.artist
      };
    }

    return { success: false, error: "Unsupported resource type: " + kind };
  } catch (e) {
    log.error("[SC] URL handling failed:", e.message);
    return { success: false, error: e.message || "Failed to resolve URL" };
  }
}

// ============================================
// ENRICHMENT
// ============================================

function enrichTrack(track) {
  log.info("[SC] enrichTrack for:", track.name, "by", track.artists);

  var scId = (track.id || "").trim();

  // If the ID is numeric (SoundCloud track ID), fetch directly
  if (scId && /^\d+$/.test(scId)) {
    try {
      var data = fetchTrackData(scId);
      if (data) {
        var pub = data.publisher_metadata || {};
        if (pub.isrc || data.isrc) {
          track.isrc = pub.isrc || data.isrc;
          log.info("[SC] Enriched ISRC:", track.isrc);
        }
        if (data.genre && !track.genre) track.genre = data.genre;
        if (data.label_name && !track.label) track.label = data.label_name;
        if (pub.p_line_for_display && !track.copyright) {
          track.copyright = pub.p_line_for_display;
        }
        if (pub.writer_composer && !track.composer) {
          track.composer = pub.writer_composer;
        }
      }
    } catch (e) {
      log.debug("[SC] Direct enrichment failed:", e.message);
    }
  }

  // If no ISRC, try searching + matching
  if (!track.isrc) {
    var searchTerm = (track.name || "") + " " + (track.artists || "");
    searchTerm = searchTerm.trim();
    if (searchTerm) {
      try {
        var searchData = scGet("search/tracks?q=" + encodeURIComponent(searchTerm),
          "limit=5&access=playable");
        var songs = searchData.collection || [];
    var best = findBestMatch(songs, track.name, track.artists, track.duration_ms);
        if (best) {
          trackCacheSet(best.id, best);
          var bPub = best.publisher_metadata || {};
          if (bPub.isrc || best.isrc) {
            track.isrc = bPub.isrc || best.isrc;
            log.info("[SC] Enriched ISRC via search:", track.isrc);
          }
          if (!track.genre && best.genre) track.genre = best.genre;
          if (!track.label && best.label_name) track.label = best.label_name;
        }
      } catch (e) {
        log.debug("[SC] Search enrichment failed:", e.message);
      }
    }
  }

  return track;
}

// ============================================
// DOWNLOAD PROVIDER
// ============================================

function checkAvailability(isrc, trackName, artistName, options) {
  log.info("[SC] checkAvailability:", trackName, "-", artistName);

  // If we have a SoundCloud track ID in options
  var scId = options && options.spotify_id;
  if (scId && /^\d{5,}$/.test(scId)) {
    // Verify it exists and is playable
    try {
      var track = fetchTrackData(scId);
      if (track && track.access === "playable" && track.streamable) {
        return {
          available: true,
          track_id: String(track.id),
          prepared_context: { track: track },
          skip_fallback: true,
          reason: "direct SoundCloud track ID"
        };
      }
      return {
        available: false,
        skip_fallback: true,
        reason: "direct SoundCloud track is not playable"
      };
    } catch (e) {
      log.debug("[SC] Direct availability check failed:", e.message);
      return {
        available: false,
        skip_fallback: true,
        reason: "direct SoundCloud lookup failed: " + e.message
      };
    }
  }

  // Search by name + artist
  var query = (trackName || "") + " " + (artistName || "");
  query = query.trim();
  if (!query) {
    return { available: false, reason: "No search query" };
  }

  try {
    var targetDurationMs = 0;
    if (options && options.duration_ms) {
      targetDurationMs = Number(options.duration_ms) || 0;
    }
    var data = scGet("search/tracks?q=" + encodeURIComponent(query),
      "limit=5&access=playable");
    var tracks = data.collection || [];

    var best = findBestMatch(tracks, trackName, artistName, targetDurationMs, 65);
    if (best && best.access === "playable" && best.streamable !== false) {
      trackCacheSet(best.id, best);
      return {
        available: true,
        track_id: String(best.id),
        prepared_context: { track: best }
      };
    }

    return { available: false, reason: "No confident playable match found on SoundCloud" };
  } catch (e) {
    return { available: false, reason: "Search failed: " + e.message };
  }
}

function download(trackID, quality, outputPath, onProgress, options) {
  log.info("[SC] Downloading track:", trackID, "quality:", quality);

  var prepared = options && options.preparedContext || {};
  var trackData = prepared.track || null;
  if (!trackData || String(trackData.id || "") !== String(trackID || "")) {
    try {
      trackData = fetchTrackData(trackID);
    } catch (e) {
      return {
        success: false,
        error_message: "Could not fetch track data: " + e.message,
        error_type: "api_error"
      };
    }
  }

  if (!trackData) {
    return {
      success: false,
      error_message: "Track not found: " + trackID,
      error_type: "api_error"
    };
  }

  if (trackData.streamable === false || (trackData.access && trackData.access !== "playable")) {
    return {
      success: false,
      error_message: "This SoundCloud track does not offer a full playable stream",
      error_type: "api_error"
    };
  }

  try {
    // Prepared metadata can arrive in a fresh runtime with no cached client ID.
    ensureClientId();
  } catch (e) {
    return { success: false, error_message: e.message, error_type: "api_error" };
  }
  var audioFormat = String(quality || "aac_160").split("_")[0];
  var candidates = rankTranscodings((trackData.media && trackData.media.transcodings) || [], audioFormat);
  var lastError = "No supported full SoundCloud stream is available";
  if (onProgress) onProgress(0.1);
  for (var i = 0; i < candidates.length && i < 6; i++) {
    if (downloadCancelled()) return cancelledDownload();
    var candidate = candidates[i];
    var actualFormat = transcodingFormat(candidate);
    var actualOutputPath = audioOutputPath(outputPath, actualFormat);
    try {
      var streamURL = resolveStreamURL(candidate, trackData);
      var result;
      if (candidate.format.protocol === "hls") {
        var playlist = readHlsPlaylist(streamURL, 0);
        var expected = Number(trackData.duration || 0) / 1000;
        if (expected > 0 && Math.abs(playlist.duration - expected) > Math.max(5, expected * 0.02)) {
          throw new Error("SoundCloud stream duration does not match the full track");
        }
        result = downloadHls(playlist.segments, actualOutputPath, onProgress);
      } else {
        result = file.download(streamURL, actualOutputPath, {
          headers: { "User-Agent": userAgentForURL(streamURL) },
          onProgress: function(written, total) {
            if (onProgress && total > 0) onProgress(0.2 + Math.min(1, written / total) * 0.7);
          }
        });
      }
      if (downloadCancelled() || (result && result.error_type === "cancelled")) {
        return cancelledDownload();
      }
      if (!result || !result.success) {
        throw new Error(result && result.error || "Audio transfer failed");
      }
      if (onProgress) onProgress(1.0);
      return {
        success: true,
        file_path: result.path || actualOutputPath,
        bit_depth: 0,
        sample_rate: 0
      };
    } catch (e) {
      if (downloadCancelled()) return cancelledDownload();
      lastError = e.message;
      log.warn("[SC] Stream attempt failed:", lastError);
    }
  }
  return { success: false, error_message: lastError, error_type: "download_error" };
}

function downloadCancelled() {
  return typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled();
}

function cancelledDownload() {
  return { success: false, error_message: "Download cancelled", error_type: "cancelled" };
}

function audioOutputPath(path, format) {
  var dot = path.lastIndexOf(".");
  var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (dot > slash ? path.substring(0, dot) : path) + "." + format;
}

function transcodingFormat(transcoding) {
  var mime = String(transcoding.format && transcoding.format.mime_type || "").toLowerCase();
  var preset = String(transcoding.preset || "").toLowerCase();
  if (/aac|mp4|mp4a/.test(mime) || /^aac_/.test(preset)) return "m4a";
  if (/opus/.test(mime) || /^opus_/.test(preset)) return "opus";
  if (/mpeg|mp3/.test(mime)) return "mp3";
  return "";
}

function rankTranscodings(transcodings, preferFormat) {
  var ranked = [];
  for (var i = 0; i < transcodings.length; i++) {
    var t = transcodings[i];
    if (!t || !t.url || !t.format || t.snipped || /preview/.test(t.preset || "")) continue;
    if (t.format.protocol !== "progressive" && t.format.protocol !== "hls") continue;
    var format = transcodingFormat(t);
    if (!format) continue;
    var score = format === "m4a" ? 60 : format === "opus" ? 40 : 20;
    if (format === preferFormat || (preferFormat === "aac" && format === "m4a")) score += 100;
    var bitrate = String(t.preset || "").match(/_(\d+)k/);
    score += bitrate ? Math.min(320, Number(bitrate[1])) / 100 : 0;
    if (t.quality === "hq") score += 5;
    ranked.push({ value: t, score: score });
  }
  ranked.sort(function(a, b) { return b.score - a.score; });
  return ranked.map(function(item) { return item.value; });
}

function resolveStreamURL(transcoding, track) {
  for (var attempt = 0; attempt < 2; attempt++) {
    var url = new URL(transcoding.url);
    // The app's URL query is read-only; build a separate mutable query.
    var params = new URLSearchParams(url.search || "");
    params.set("client_id", state.clientId);
    if (track.track_authorization) params.set("track_authorization", track.track_authorization);
    var endpoint = url.toString().split("#")[0].split("?")[0];
    var response = http.get(endpoint + "?" + params.toString() + (url.hash || ""), {
      "User-Agent": utils.randomUserAgent(), "Accept": "application/json"
    });
    if (response && !response.error && response.statusCode === 200) {
      var data = JSON.parse(response.body);
      if (data.url) return data.url;
      throw new Error("SoundCloud returned no stream URL");
    }
    if (attempt === 0 && response && (response.statusCode === 401 || response.statusCode === 403)) {
      state.clientId = null;
      state.clientIdExpiry = 0;
      ensureClientId();
      // Refresh short-lived track authorization as well as the client ID.
      track = scGet("tracks/" + track.id);
      trackCacheSet(track.id, track);
      if (track.streamable === false || (track.access && track.access !== "playable")) {
        throw new Error("SoundCloud track is no longer playable");
      }
      continue;
    }
    throw new Error("SoundCloud stream request failed: " + soundCloudResponseError(response));
  }
}

function hlsAttributes(line) {
  var attributes = {};
  var pattern = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  var match;
  while ((match = pattern.exec(line)) !== null) attributes[match[1]] = match[2] === undefined ? match[3] : match[2];
  return attributes;
}

function hlsURL(value, base) {
  var url = new URL(value, base);
  if (url.protocol !== "https:") throw new Error("Unsupported SoundCloud playlist URL");
  return url.toString();
}

function hlsSegment(url, range, previous) {
  var segment = { url: url, headers: {} };
  if (!range) return segment;
  var match = String(range).match(/^(\d+)(?:@(\d+))?$/);
  if (!match) throw new Error("Invalid HLS byte range");
  var length = Number(match[1]);
  var offset = match[2] === undefined ? (previous && previous.url === url ? previous.end : NaN) : Number(match[2]);
  if (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + length)) {
    throw new Error("Invalid HLS byte range offset");
  }
  segment.headers.Range = "bytes=" + offset + "-" + (offset + length - 1);
  segment.end = offset + length;
  return segment;
}

function readHlsPlaylist(url, depth) {
  if (depth >= 4) throw new Error("SoundCloud HLS playlist nesting is too deep");
  if (downloadCancelled()) throw new Error("Download cancelled");
  var response = http.get(url, { "User-Agent": userAgentForURL(url) });
  if (!response || response.error || response.statusCode !== 200) {
    throw new Error("SoundCloud HLS request failed: " + soundCloudResponseError(response));
  }
  var body = String(response.body || "").trim();
  if (body.indexOf("#EXTM3U") !== 0) throw new Error("Invalid SoundCloud HLS playlist");
  var lines = body.split(/\r?\n/);
  var variants = [], audio = [], segments = [];
  var pendingVariant = null, range = null, previous = null, init = null;
  var duration = 0, ended = false, pendingDuration = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) pendingVariant = hlsAttributes(line);
    else if (line.indexOf("#EXT-X-MEDIA:") === 0) {
      var media = hlsAttributes(line);
      if (media.TYPE === "AUDIO" && media.URI) audio.push(media);
    } else if (line.indexOf("#EXT-X-KEY:") === 0 || line.indexOf("#EXT-X-SESSION-KEY:") === 0) {
      if (hlsAttributes(line).METHOD !== "NONE") throw new Error("Encrypted SoundCloud streams are not supported");
    } else if (line.indexOf("#EXT-X-MAP:") === 0) {
      var map = hlsAttributes(line);
      if (!map.URI) throw new Error("Invalid HLS initialization segment");
      var nextInit = hlsSegment(hlsURL(map.URI, url), map.BYTERANGE, null);
      if (init && JSON.stringify(nextInit) !== JSON.stringify(init)) throw new Error("Changing HLS initialization segments are not supported");
      if (!init) {
        if (segments.length) throw new Error("Late HLS initialization segment");
        segments.push(nextInit);
        init = nextInit;
      }
    } else if (line.indexOf("#EXT-X-BYTERANGE:") === 0) range = line.substring(17);
    else if (line.indexOf("#EXTINF:") === 0) {
      var seconds = Number(line.substring(8).split(",")[0]);
      if (!isFinite(seconds) || seconds <= 0 || pendingDuration) throw new Error("Invalid HLS segment duration");
      duration += seconds;
      pendingDuration = true;
    } else if (line === "#EXT-X-ENDLIST") ended = true;
    else if (line[0] !== "#") {
      if (pendingVariant) {
        variants.push({ url: hlsURL(line, url), bandwidth: Number(pendingVariant.BANDWIDTH) || 0 });
        pendingVariant = null;
      } else {
        if (!pendingDuration) throw new Error("HLS segment has no duration");
        var segment = hlsSegment(hlsURL(line, url), range, previous);
        segments.push(segment);
        previous = segment;
        range = null;
        pendingDuration = false;
        if (segments.length > 10000) throw new Error("SoundCloud HLS playlist is too large");
      }
    }
  }
  if (audio.length) {
    var selected = audio.filter(function(item) { return item.DEFAULT === "YES"; })[0] || audio[0];
    return readHlsPlaylist(hlsURL(selected.URI, url), depth + 1);
  }
  if (variants.length) {
    variants.sort(function(a, b) { return b.bandwidth - a.bandwidth; });
    return readHlsPlaylist(variants[0].url, depth + 1);
  }
  if (!ended || pendingDuration || !duration || segments.length <= (init ? 1 : 0)) {
    throw new Error("SoundCloud HLS playlist is incomplete");
  }
  return { segments: segments, duration: duration };
}

function downloadHls(segments, outputPath, onProgress) {
  var temporary = outputPath + ".sc-stream";
  var remuxStarted = false;
  try {
    var result = file.downloadSegments(segments, temporary, {
      headers: { "User-Agent": utils.randomUserAgent() },
      maxParallel: 4,
      onProgress: function(written, total, completed, count) {
        if (onProgress && count > 0) onProgress(0.2 + Math.min(1, completed / count) * 0.65);
      }
    });
    if (!result || !result.success) return result;
    if (downloadCancelled()) return { success: false, error_type: "cancelled" };
    if (onProgress) onProgress(0.9);
    // Join the segments natively, then remux local AAC/MP3/Opus without encoding.
    // FFmpeg never receives a remote playlist or provider credentials.
    remuxStarted = true;
    var converted = ffmpeg.convert(result.path || temporary, outputPath, { codec: "copy" });
    if (!converted || !converted.success || downloadCancelled()) {
      deleteSoundCloudFile(outputPath);
      return converted;
    }
    return { success: true, path: outputPath };
  } catch (e) {
    if (remuxStarted) deleteSoundCloudFile(outputPath);
    throw e;
  } finally {
    deleteSoundCloudFile(temporary);
  }
}

function deleteSoundCloudFile(path) {
  try { file.delete(path); } catch (e) {}
}

// ============================================
// MATCHING
// ============================================

function findBestMatch(tracks, targetName, targetArtist, targetDurationMs, minScore) {
  if (!tracks || tracks.length === 0) return null;

  var bestScore = -1;
  var bestTrack = null;

  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i];
    var tTitle = t.title || "";
    var tArtist = (t.publisher_metadata && t.publisher_metadata.artist) ||
                  t.metadata_artist ||
                  (t.user && t.user.username) || "";
    var score = 0;

    score += matching.compareStrings(targetName || "", tTitle) * 50;
    score += matching.compareStrings(targetArtist || "", tArtist) * 30;

    if (targetDurationMs > 0 && t.duration) {
      score += matching.compareDuration(targetDurationMs, t.duration) * 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestTrack = t;
    }
  }

  var threshold = (typeof minScore === "number") ? minScore : 40;
  if (bestScore < threshold) return null;
  return bestTrack;
}

function normalizeText(text) {
  if (!text) return "";
  return text.toLowerCase()
    .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================
// EXPORTED API
// ============================================

function getTrack(trackId) {
  try {
    return fetchTrack(trackId);
  } catch (e) {
    log.error("[SC] getTrack failed:", e.message);
    return null;
  }
}

function getAlbum(albumId) {
  try {
    var result = fetchPlaylistOrAlbum(albumId);
    var tracks = result.tracks.map(function (t) {
      t.provider_id = "soundcloud";
      return t;
    });
    return {
      id: albumId,
      name: result.info.name,
      artists: result.info.artists,
      artist_id: result.info.artist_id,
      release_date: result.info.release_date,
      total_tracks: tracks.length,
      images: result.info.images,
      cover_url: result.info.cover_url,
      tracks: tracks,
      provider_id: "soundcloud"
    };
  } catch (e) {
    log.error("[SC] getAlbum failed:", e.message);
    return null;
  }
}

function getPlaylist(playlistId) {
  try {
    var result = fetchPlaylistOrAlbum(playlistId);
    var tracks = result.tracks.map(function (t) {
      t.provider_id = "soundcloud";
      return t;
    });
    return {
      id: playlistId,
      name: result.info.name,
      description: "",
      owner: result.info.artists,
      cover: result.info.cover_url,
      cover_url: result.info.cover_url,
      total_tracks: tracks.length,
      tracks: tracks,
      provider_id: "soundcloud"
    };
  } catch (e) {
    log.error("[SC] getPlaylist failed:", e.message);
    return null;
  }
}

function getArtist(artistId) {
  try {
    var result = fetchArtist(artistId);
    return result.artist;
  } catch (e) {
    log.error("[SC] getArtist failed:", e.message);
    return null;
  }
}

function searchTracks(query, limit) {
  return customSearch(query, { limit: limit || 20, filter: "tracks" });
}

// ============================================
// REGISTER EXTENSION
// ============================================

registerExtension({
  initialize: initialize,
  cleanup: cleanup,
  customSearch: customSearch,
  handleUrl: handleURL,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getArtist: getArtist,
  getPlaylist: getPlaylist,
  searchTracks: searchTracks,
  enrichTrack: enrichTrack,

  // Download provider
  checkAvailability: checkAvailability,
  download: download,
  getDownloadUrl: function () { return null; }
});

log.info("[SC] SoundCloud Extension loaded!");
