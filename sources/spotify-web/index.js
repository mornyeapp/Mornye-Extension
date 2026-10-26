// ============================================
// Spotify Web Extension for SpotiFLAC
// Version: 1.10.3
//
// This extension uses Spotify's internal GraphQL API
// to fetch metadata. It can access personalized playlists
// like Daily Mix, Discover Weekly, etc.
//
// WARNING: This uses unofficial internal APIs which may
// break at any time. Use at your own risk.
// ============================================

const TOTP_SECRETS = {
  59: [
    123, 105, 79, 70, 110, 59, 52, 125, 60, 49, 80, 70, 89, 75, 80, 86, 63, 53,
    123, 37, 117, 49, 52, 93, 77, 62, 47, 86, 48, 104, 68, 72,
  ],
  60: [
    79, 109, 69, 123, 90, 65, 46, 74, 94, 34, 58, 48, 70, 71, 92, 85, 122, 63,
    91, 64, 87, 87,
  ],
  61: [
    44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102,
    43, 69, 49, 120, 118, 80, 64, 78,
  ],
};

const TOTP_VERSION = 61;
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

let clientState = {
  accessToken: null,
  accessTokenExpiry: 0,
  clientToken: null,
  clientTokenExpiry: 0,
  clientID: null,
  deviceID: null,
  clientVersion: null,
  cookies: {},
  initialized: false,
};

const METADATA_CACHE_LIMIT = 500;
const METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const METADATA_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const METADATA_CACHE_MISS = Object.freeze({ metadataCacheMiss: true });
const SPOTIFY_COVER_SIZE_300 = "ab67616d00001e02";
const SPOTIFY_COVER_SIZE_640 = "ab67616d0000b273";
const SPOTIFY_COVER_SIZE_MAX = "ab67616d000082c1";
const nativeTrackMetadataCache = new Map();
const nativeAlbumMetadataCache = new Map();
const deezerTrackMetadataCache = new Map();
const deezerAlbumMetadataCache = new Map();

function metadataCacheGet(cache, key) {
  if (!key || !cache.has(key)) return null;
  const entry = cache.get(key);
  if (
    !entry ||
    Date.now() - entry.createdAt > Number(entry.ttlMs || METADATA_CACHE_TTL_MS)
  ) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function metadataCachePut(cache, key, value, ttlMs) {
  if (!key || !value) return value;
  if (cache.has(key)) cache.delete(key);
  cache.set(key, {
    value: value,
    createdAt: Date.now(),
    ttlMs: Number(ttlMs || METADATA_CACHE_TTL_MS),
  });
  while (cache.size > METADATA_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return value;
}

function initialize(config) {
  log.info("Spotify Web Extension initializing...");

  try {
    const cached = storage.get("client_state");
    if (cached) {
      const parsed = JSON.parse(cached);
      clientState.accessToken = parsed.accessToken || null;
      clientState.accessTokenExpiry = Number(parsed.accessTokenExpiry || 0);
      clientState.clientToken = parsed.clientToken || null;
      clientState.clientTokenExpiry = Number(parsed.clientTokenExpiry || 0);
      clientState.clientID = parsed.clientID || null;
      clientState.deviceID = parsed.deviceID || null;
      clientState.clientVersion = parsed.clientVersion || null;
      clientState.cookies =
        parsed.cookies && typeof parsed.cookies === "object"
          ? parsed.cookies
          : {};
      if (!clientState.deviceID && clientState.cookies.sp_t) {
        clientState.deviceID = clientState.cookies.sp_t;
      }
      clientState.initialized =
        tokenIsUsable(clientState.accessToken, clientState.accessTokenExpiry) &&
        tokenIsUsable(clientState.clientToken, clientState.clientTokenExpiry);

      if (clientState.initialized) {
        log.info("Loaded cached Spotify Web session");
      }
    }
  } catch (e) {
    log.warn(
      "Failed to load cached Spotify Web session:",
      e.message || String(e),
    );
  }

  return true;
}

function persistClientState() {
  try {
    return storage.set("client_state", JSON.stringify(clientState));
  } catch (e) {
    log.warn("Failed to persist Spotify Web session:", e.message || String(e));
    return false;
  }
}

function cleanup() {
  persistClientState();
  nativeTrackMetadataCache.clear();
  nativeAlbumMetadataCache.clear();
  deezerTrackMetadataCache.clear();
  deezerAlbumMetadataCache.clear();
}

function tokenIsUsable(token, expiry) {
  if (!token) return false;
  const expiryMs = Number(expiry || 0);
  // Older cached sessions did not store expiry. Reuse them until Spotify
  // rejects them, then the existing 401 retry refreshes and persists expiry.
  return expiryMs <= 0 || Date.now() < expiryMs - TOKEN_EXPIRY_SKEW_MS;
}

function absoluteExpiryMs(value) {
  let expiry = Number(value || 0);
  if (!isFinite(expiry) || expiry <= 0) return 0;
  // Accept either Unix seconds or Unix milliseconds.
  if (expiry < 100000000000) expiry *= 1000;
  return expiry;
}

function relativeExpiryMs(seconds) {
  const ttlSeconds = Number(seconds || 0);
  if (!isFinite(ttlSeconds) || ttlSeconds <= 0) return 0;
  return Date.now() + ttlSeconds * 1000;
}

function generateTOTP() {
  const secretList = TOTP_SECRETS[TOTP_VERSION];

  const transformed = [];
  for (let i = 0; i < secretList.length; i++) {
    transformed.push(secretList[i] ^ ((i % 33) + 9));
  }

  let joined = "";
  for (let i = 0; i < transformed.length; i++) {
    joined += transformed[i].toString();
  }

  let hexStr = "";
  for (let i = 0; i < joined.length; i++) {
    hexStr += joined.charCodeAt(i).toString(16).padStart(2, "0");
  }

  const hexBytes = [];
  for (let i = 0; i < hexStr.length; i += 2) {
    hexBytes.push(parseInt(hexStr.substr(i, 2), 16));
  }

  const secret = base32Encode(hexBytes);

  const counter = Math.floor(Date.now() / 1000 / 30);
  const code = generateTOTPCode(secret, counter);

  return { code: code, version: TOTP_VERSION };
}

function base32Encode(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let bits = 0;
  let value = 0;

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += alphabet[(value << (5 - bits)) & 31];
  }

  return result;
}

function generateTOTPCode(secret, counter) {
  const key = base32Decode(secret);

  const counterBytes = [];
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    counterBytes[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const hmac = utils.hmacSHA1(key, counterBytes);

  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = code % 1000000;
  return otp.toString().padStart(6, "0");
}

function base32Decode(str) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  str = str.toUpperCase().replace(/=+$/, "");

  const result = [];
  let bits = 0;
  let value = 0;

  for (let i = 0; i < str.length; i++) {
    const idx = alphabet.indexOf(str[i]);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      result.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return result;
}

function extractCookies(response) {
  if (!response || !response.headers) return;

  let setCookie =
    response.headers["Set-Cookie"] || response.headers["set-cookie"];
  if (!setCookie) {
    for (const key in response.headers) {
      if (key.toLowerCase() === "set-cookie") {
        setCookie = response.headers[key];
        break;
      }
    }
  }
  if (!setCookie) return;

  const cookieStrings = Array.isArray(setCookie) ? setCookie : [setCookie];

  for (const cookieStr of cookieStrings) {
    const match = cookieStr.match(/^([^=]+)=([^;]*)/);
    if (match) {
      const name = match[1].trim();
      const value = match[2].trim();
      clientState.cookies[name] = value;

      if (name === "sp_t") {
        clientState.deviceID = value;
      }
    }
  }
}

function buildCookieHeader() {
  const parts = [];
  for (const name in clientState.cookies) {
    if (clientState.cookies.hasOwnProperty(name)) {
      parts.push(name + "=" + clientState.cookies[name]);
    }
  }
  return parts.join("; ");
}

function spotifyResponseError(response) {
  if (!response) return "no response";
  if (response.error) return String(response.error);
  return response.statusCode
    ? "HTTP " + response.statusCode
    : "missing HTTP status";
}

function spotifyRequest(method, url, body, headers) {
  var response;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      response =
        method === "POST"
          ? http.post(url, body, headers)
          : http.get(url, headers);
    } catch (error) {
      response = { error: (error && error.message) || String(error) };
    }
    var reason = spotifyResponseError(response);
    var retryable =
      !response ||
      response.error ||
      response.statusCode === 408 ||
      response.statusCode >= 500;
    if (
      attempt === 1 ||
      !retryable ||
      /cancel|denied|not permitted|certificate/i.test(reason)
    )
      break;
    log.warn("Spotify session request retry after:", reason);
    if (typeof utils.sleep === "function" && utils.sleep(250) === false) {
      throw new Error("Spotify request cancelled");
    }
  }
  return response;
}

function ensureDeviceID() {
  if (!clientState.deviceID) {
    // Some session pages do not resend sp_t. Keep one anonymous device ID
    // across token refreshes and application restarts instead of failing.
    clientState.deviceID = clientState.cookies.sp_t || generateDeviceID();
    persistClientState();
  }
  return clientState.deviceID;
}

function getSessionInfo() {
  const headers = {
    "User-Agent": utils.randomUserAgent(),
  };

  const cookieHeader = buildCookieHeader();
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const response = spotifyRequest(
    "GET",
    "https://open.spotify.com",
    null,
    headers,
  );

  if (!response || response.error || response.statusCode !== 200) {
    throw new Error(
      "Failed to get session info: " + spotifyResponseError(response),
    );
  }

  extractCookies(response);

  const match = response.body.match(
    /<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/,
  );
  if (match) {
    try {
      const decoded = atob(match[1]);
      const cfg = JSON.parse(decoded);
      clientState.clientVersion = cfg.clientVersion;
    } catch (e) {}
  }

  if (!clientState.clientVersion) {
    throw new Error("Spotify session page did not include a client version");
  }
  ensureDeviceID();
  persistClientState();
}

function getAccessToken() {
  const totp = generateTOTP();

  const url =
    "https://open.spotify.com/api/token?reason=init&productType=web-player" +
    "&totp=" +
    totp.code +
    "&totpVer=" +
    totp.version +
    "&totpServer=" +
    totp.code;

  const headers = {
    "User-Agent": utils.randomUserAgent(),
    "Content-Type": "application/json;charset=UTF-8",
  };

  const cookieHeader = buildCookieHeader();
  if (cookieHeader) {
    headers["Cookie"] = cookieHeader;
  }

  const response = spotifyRequest("GET", url, null, headers);

  if (!response || response.error || response.statusCode !== 200) {
    throw new Error(
      "Failed to get access token: " + spotifyResponseError(response),
    );
  }

  extractCookies(response);

  const data = JSON.parse(response.body);
  if (!data || !data.accessToken || !data.clientId) {
    throw new Error("Spotify access token response is incomplete");
  }
  clientState.accessToken = data.accessToken;
  clientState.accessTokenExpiry = absoluteExpiryMs(
    data.accessTokenExpirationTimestampMs ||
      data.accessTokenExpirationTimestamp,
  );
  clientState.clientID = data.clientId;
  persistClientState();

  return clientState.accessToken;
}

function getClientToken() {
  if (!clientState.clientVersion) {
    getSessionInfo();
  }
  if (
    !clientState.clientID ||
    !tokenIsUsable(clientState.accessToken, clientState.accessTokenExpiry)
  ) {
    getAccessToken();
  }
  ensureDeviceID();

  const payload = {
    client_data: {
      client_version: clientState.clientVersion,
      client_id: clientState.clientID,
      js_sdk_data: {
        device_brand: "unknown",
        device_model: "unknown",
        os: "windows",
        os_version: "NT 10.0",
        device_id: clientState.deviceID,
        device_type: "computer",
      },
    },
  };

  const response = spotifyRequest(
    "POST",
    "https://clienttoken.spotify.com/v1/clienttoken",
    JSON.stringify(payload),
    {
      Authority: "clienttoken.spotify.com",
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": utils.randomUserAgent(),
    },
  );

  if (!response || response.error || response.statusCode !== 200) {
    throw new Error(
      "Failed to get client token: " + spotifyResponseError(response),
    );
  }

  const data = JSON.parse(response.body);
  if (data.response_type !== "RESPONSE_GRANTED_TOKEN_RESPONSE") {
    throw new Error("Invalid client token response: " + data.response_type);
  }
  if (!data.granted_token || !data.granted_token.token) {
    throw new Error("Spotify client token response is incomplete");
  }

  clientState.clientToken = data.granted_token.token;
  clientState.clientTokenExpiry = relativeExpiryMs(
    data.granted_token.expires_after_seconds,
  );
  clientState.initialized = true;
  persistClientState();

  return clientState.clientToken;
}

function generateDeviceID() {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function ensureInitialized() {
  const accessTokenUsable = tokenIsUsable(
    clientState.accessToken,
    clientState.accessTokenExpiry,
  );
  const clientTokenUsable = tokenIsUsable(
    clientState.clientToken,
    clientState.clientTokenExpiry,
  );

  if (accessTokenUsable && clientTokenUsable) {
    clientState.initialized = true;
    return;
  }

  clientState.initialized = false;

  if (!clientState.deviceID || !clientState.clientVersion) {
    getSessionInfo();
  }
  if (!accessTokenUsable) {
    getAccessToken();
  }
  if (!clientTokenUsable) {
    getClientToken();
  }

  clientState.initialized = true;
  persistClientState();
}

function resetAuthState() {
  clientState.initialized = false;
  clientState.accessToken = null;
  clientState.accessTokenExpiry = 0;
  clientState.clientToken = null;
  clientState.clientTokenExpiry = 0;
  persistClientState();
}

function query(payload, allowRetry) {
  ensureInitialized();

  const response = http.post(
    "https://api-partner.spotify.com/pathfinder/v2/query",
    JSON.stringify(payload),
    {
      Authorization: "Bearer " + clientState.accessToken,
      "Client-Token": clientState.clientToken,
      "Spotify-App-Version": clientState.clientVersion,
      "Content-Type": "application/json",
      "User-Agent": utils.randomUserAgent(),
    },
  );

  if (!response || response.error) {
    throw new Error(
      "Query failed: " + (response ? response.error : "no response"),
    );
  }

  if (response.statusCode === 401 && allowRetry !== false) {
    resetAuthState();
    ensureInitialized();
    return query(payload, false);
  }

  if (response.statusCode !== 200) {
    throw new Error("Query failed: HTTP " + response.statusCode);
  }

  return JSON.parse(response.body);
}

function parseSpotifyURL(url) {
  url = (url || "").trim();
  if (!url) {
    return null;
  }

  if (url.startsWith("spotify:")) {
    const parts = url.split(":").filter(Boolean);
    if (parts.length === 3) {
      if (["track", "album", "playlist", "artist"].indexOf(parts[1]) !== -1) {
        return { type: parts[1], id: parts[2] };
      }
    }

    if (parts.length === 5 && parts[1] === "user" && parts[3] === "playlist") {
      return { type: "playlist", id: parts[4] };
    }

    return null;
  }

  const embedMatch = url.match(/^https?:\/\/embed\.spotify\.com\/?\?(.*)$/i);
  if (embedMatch) {
    const query = embedMatch[1] || "";
    const uriMatch = query.match(/(?:^|&)uri=([^&]+)/);
    if (uriMatch && uriMatch[1]) {
      try {
        return parseSpotifyURL(decodeURIComponent(uriMatch[1]));
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  const hostMatch = url.match(
    /^https?:\/\/(?:open|play)\.spotify\.com\/(.+)$/i,
  );
  if (!hostMatch) {
    return null;
  }

  let path = hostMatch[1].split("?")[0].split("#")[0];
  let parts = path.split("/").filter(Boolean);

  if (parts.length > 0 && /^intl-/i.test(parts[0])) {
    parts = parts.slice(1);
  }

  if (parts.length > 0 && parts[0] === "embed") {
    parts = parts.slice(1);
  }

  if (parts.length === 2) {
    if (parts[0] === "s") {
      return { type: "short", id: parts[1] };
    }

    if (["track", "album", "playlist", "artist"].indexOf(parts[0]) !== -1) {
      return { type: parts[0], id: parts[1] };
    }
  }

  if (parts.length === 4 && parts[2] === "playlist") {
    return { type: "playlist", id: parts[3] };
  }

  return null;
}

function parseSpotifyResolutionResponse(response) {
  if (!response || response.error) {
    return null;
  }

  let parsed = response.url ? parseSpotifyURL(response.url) : null;
  if (parsed && parsed.type !== "short") {
    return parsed;
  }

  const body = String(response.body || "");
  const metadataPatterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
    /https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[^/"']+\/)?(?:track|album|playlist|artist)\/[A-Za-z0-9]+/i,
  ];

  for (let i = 0; i < metadataPatterns.length; i++) {
    const match = body.match(metadataPatterns[i]);
    if (!match) continue;

    const candidate = String(match[1] || match[0]).replace(
      /&amp;|&#38;|&#x26;/gi,
      "&",
    );
    parsed = parseSpotifyURL(candidate);
    if (parsed && parsed.type !== "short") {
      return parsed;
    }
  }

  return null;
}

function resolveSpotifyShortURL(url) {
  let response = null;

  if (typeof http.request === "function") {
    response = http.request(url, {
      method: "HEAD",
      headers: {
        Accept: "text/html",
      },
    });
  }

  let parsed = parseSpotifyResolutionResponse(response);

  if (!parsed || parsed.type === "short") {
    response = http.get(url, {
      Accept: "text/html",
    });
    parsed = parseSpotifyResolutionResponse(response);
  }

  if (!parsed || parsed.type === "short") {
    throw new Error("Unable to resolve Spotify short URL");
  }

  return parsed;
}

function fetchPlaylist(playlistID) {
  log.info("Fetching playlist:", playlistID);

  const allItems = [];
  let offset = 0;
  const limit = 1000;
  let totalCount = null;
  let data = null;

  while (true) {
    const payload = {
      variables: {
        uri: "spotify:playlist:" + playlistID,
        offset: offset,
        limit: limit,
        enableWatchFeedEntrypoint: false,
      },
      operationName: "fetchPlaylist",
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "bb67e0af06e8d6f52b531f97468ee4acd44cd0f82b988e15c2ea47b1148efc77",
        },
      },
    };

    const response = query(payload);

    if (!data) {
      data = response;
    }

    const playlistData = getNestedValue(response, "data.playlistV2") || {};
    const content = playlistData.content || {};
    const items = content.items || [];

    if (items.length === 0) break;

    allItems.push(...items);

    if (totalCount === null) {
      totalCount = content.totalCount || items.length;
    }

    if (allItems.length >= totalCount || items.length < limit) {
      break;
    }

    offset += limit;
  }

  return formatPlaylistData(data, allItems);
}

function formatPlaylistData(data, allItems) {
  const playlistData = getNestedValue(data, "data.playlistV2") || {};

  const ownerData = getNestedValue(playlistData, "ownerV2.data") || {};
  const playlistInfo = {
    name: playlistData.name || "",
    description: playlistData.description || "",
    owner: ownerData.name || "",
    ownerAvatar: getNestedValue(ownerData, "avatar.sources.0.url") || "",
    cover:
      spotifyBestImage(getNestedValue(playlistData, "images.items.0")) ||
      spotifyBestImage(getNestedValue(playlistData, "imagesV2.items.0")),
    totalTracks: allItems.length,
    followers: getNestedValue(playlistData, "followers.totalCount") || 0,
  };

  const tracks = [];
  for (const item of allItems) {
    const trackData = getNestedValue(item, "itemV2.data") || {};
    if (!trackData.uri) continue;

    let artistEntries = spotifyArtistEntries(
      getNestedValue(trackData, "artists.items") || [],
    );
    if (!artistEntries.length) {
      artistEntries = spotifyArtistEntries(
        getNestedValue(trackData, "firstArtist.items") || [],
      ).concat(
        spotifyArtistEntries(
          getNestedValue(trackData, "otherArtists.items") || [],
        ),
      );
    }
    const artistsString = uniqueMetadataValues(
      artistEntries.map(function (artist) {
        return artist.name;
      }),
    ).join(", ");
    const firstArtist = artistEntries.length ? artistEntries[0] : {};
    const durationMs =
      getNestedValue(trackData, "trackDuration.totalMilliseconds") ||
      getNestedValue(trackData, "duration.totalMilliseconds") ||
      0;
    const trackID = trackData.id || spotifyIDFromURI(trackData.uri);
    const albumData = trackData.albumOfTrack || {};
    const albumName = albumData.name || "";
    const albumID = albumData.id || spotifyIDFromURI(albumData.uri);
    const albumURL = albumID ? "https://open.spotify.com/album/" + albumID : "";
    const albumArtists = spotifyArtistNames(albumData.artists) || artistsString;
    const coverURL = spotifyBestImage(albumData.coverArt);
    const spotifyURL = "https://open.spotify.com/track/" + trackID;

    tracks.push({
      id: trackID,
      spotify_id: trackID,
      name: trackData.name || "",
      artists: artistsString,
      album_name: albumName,
      album_artist: albumArtists,
      artist_id: firstArtist.id || "",
      artist_url: firstArtist.url || "",
      duration_ms: durationMs,
      images: coverURL,
      cover_url: coverURL,
      preview_url:
        getNestedValue(trackData, "previews.audioPreviews.items.0.url") || "",
      release_date: normalizeSpotifyDate(albumData.date),
      album_type: normalizeSpotifyAlbumType(
        albumData.albumType || albumData.type,
      ),
      track_number: Number(trackData.trackNumber || 0),
      total_tracks: Number(getNestedValue(albumData, "tracks.totalCount") || 0),
      disc_number: Number(trackData.discNumber || 0),
      total_discs: 0,
      external_urls: spotifyURL,
      external_links: { spotify: spotifyURL },
      isrc: "",
      explicit: isExplicitSpotify(trackData),
      album_id: albumID,
      album_url: albumURL,
      label: albumData.label || "",
      copyright: spotifyCopyrightText(albumData.copyright),
      comment: albumURL,
      item_type: "track",
      provider_id: "spotify-web",
    });
  }

  log.info("Fetched", tracks.length, "tracks from playlist");

  return {
    type: "playlist",
    playlist_info: playlistInfo,
    track_list: tracks,
  };
}

function fetchAlbum(albumID) {
  log.info("Fetching album:", albumID);

  const allItems = [];
  let offset = 0;
  const limit = 1000;
  let totalCount = null;
  let data = null;

  while (true) {
    const payload = {
      variables: {
        uri: "spotify:album:" + albumID,
        locale: "",
        offset: offset,
        limit: limit,
      },
      operationName: "getAlbum",
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "b9bfabef66ed756e5e13f68a942deb60bd4125ec1f1be8cc42769dc0259b4b10",
        },
      },
    };

    const response = query(payload);

    if (!data) {
      data = response;
    }

    const albumData = getNestedValue(response, "data.albumUnion") || {};
    const tracksData = albumData.tracksV2 || {};
    const items = tracksData.items || [];

    if (items.length === 0) break;

    allItems.push(...items);

    if (totalCount === null) {
      totalCount = tracksData.totalCount || items.length;
    }

    if (allItems.length >= totalCount || items.length < limit) {
      break;
    }

    offset += limit;
  }

  return formatAlbumData(data, allItems, albumID);
}

function formatAlbumData(data, allItems, albumID) {
  const albumData = getNestedValue(data, "data.albumUnion") || {};
  const albumArtists = spotifyArtistEntries(
    getNestedValue(albumData, "artists.items") || [],
  );
  const albumArtistsString = uniqueMetadataValues(
    albumArtists.map(function (artist) {
      return artist.name;
    }),
  ).join(", ");
  const firstAlbumArtist = albumArtists.length ? albumArtists[0] : {};
  const coverURL = spotifyBestImage(albumData.coverArt);
  const releaseDate = normalizeSpotifyDate(albumData.date);
  const albumURL = "https://open.spotify.com/album/" + albumID;
  const totalTracks = Number(
    getNestedValue(albumData, "tracksV2.totalCount") || allItems.length,
  );
  const totalDiscs = spotifyTotalDiscs(allItems);
  const nativeAlbumMetadata = getSpotifyNativeAlbumMetadata(albumID) || {};

  const albumInfo = {
    name: albumData.name || "",
    artists: albumArtistsString,
    artist_id: firstAlbumArtist.id || "",
    artist_url: firstAlbumArtist.url || "",
    images: coverURL,
    cover_url: coverURL,
    release_date: releaseDate,
    total_tracks: totalTracks,
    total_discs: totalDiscs,
    album_type: normalizeSpotifyAlbumType(
      albumData.albumType || albumData.type,
    ),
    label: albumData.label || "",
    copyright: spotifyCopyrightText(albumData.copyright),
    external_urls: albumURL,
    comment: albumURL,
    upc: "",
  };
  applyMetadataFallbacks(albumInfo, nativeAlbumMetadata);

  const tracks = [];
  let trackNumber = 0;

  for (const item of allItems) {
    const track = item.track || {};
    if (!track.uri) continue;
    trackNumber++;

    const trackArtists = spotifyArtistEntries(
      getNestedValue(track, "artists.items") || [],
    );
    const trackArtistsString = uniqueMetadataValues(
      trackArtists.map(function (artist) {
        return artist.name;
      }),
    ).join(", ");
    const firstTrackArtist = trackArtists.length ? trackArtists[0] : {};
    const durationMs = getNestedValue(track, "duration.totalMilliseconds") || 0;
    const trackID = spotifyIDFromURI(track.uri);
    const spotifyURL = "https://open.spotify.com/track/" + trackID;
    const formattedTrack = {
      id: trackID,
      spotify_id: trackID,
      name: track.name || "",
      artists: trackArtistsString,
      album_name: albumData.name || "",
      album_artist: albumArtistsString,
      artist_id: firstTrackArtist.id || "",
      artist_url: firstTrackArtist.url || "",
      duration_ms: durationMs,
      images: coverURL,
      cover_url: coverURL,
      preview_url:
        getNestedValue(track, "previews.audioPreviews.items.0.url") || "",
      release_date: releaseDate,
      album_type: albumInfo.album_type,
      track_number: Number(track.trackNumber || trackNumber),
      total_tracks: totalTracks,
      disc_number: Number(track.discNumber || 1),
      total_discs: totalDiscs,
      external_urls: spotifyURL,
      external_links: { spotify: spotifyURL },
      isrc: "",
      explicit: isExplicitSpotify(track),
      album_id: albumID,
      album_url: albumURL,
      label: albumInfo.label || "",
      copyright: albumInfo.copyright || "",
      genre: albumInfo.genre || "",
      upc: albumInfo.upc || "",
      comment: albumURL,
      item_type: "track",
      provider_id: "spotify-web",
    };
    applyMetadataFallbacks(formattedTrack, nativeAlbumMetadata);
    tracks.push(formattedTrack);
  }

  log.info("Fetched", tracks.length, "tracks from album");

  return {
    type: "album",
    album_info: albumInfo,
    track_list: tracks,
  };
}

function fetchTrack(trackID) {
  log.info("Fetching track:", trackID);

  const payload = {
    variables: {
      uri: "spotify:track:" + trackID,
    },
    operationName: "getTrack",
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "612585ae06ba435ad26369870deaae23b5c8800a256cd8a57e08eddc25a37294",
      },
    },
  };

  const response = query(payload);
  const trackData = getNestedValue(response, "data.trackUnion") || {};

  const artistEntries = spotifyArtistEntries(
    getNestedValue(trackData, "firstArtist.items") || [],
  ).concat(
    spotifyArtistEntries(getNestedValue(trackData, "otherArtists.items") || []),
  );
  const artistsString = uniqueMetadataValues(
    artistEntries.map(function (artist) {
      return artist.name;
    }),
  ).join(", ");
  const firstArtist = artistEntries.length ? artistEntries[0] : {};
  const albumData = trackData.albumOfTrack || {};
  const albumName = albumData.name || "";
  const albumID = albumData.id || spotifyIDFromURI(albumData.uri);
  const albumURL = albumID ? "https://open.spotify.com/album/" + albumID : "";
  const coverURL = spotifyBestImage(albumData.coverArt);
  const durationMs =
    getNestedValue(trackData, "duration.totalMilliseconds") || 0;
  const releaseDate = normalizeSpotifyDate(albumData.date);
  const spotifyURL = "https://open.spotify.com/track/" + trackID;
  const enrichedMetadata = enrichMetadata(trackID, albumID, {
    album_name: albumName,
  });
  const track = {
    id: trackID,
    spotify_id: trackID,
    name: trackData.name || "",
    artists: artistsString,
    album_name: albumName,
    album_artist: "",
    artist_id: firstArtist.id || "",
    artist_url: firstArtist.url || "",
    duration_ms: durationMs,
    images: coverURL,
    cover_url: coverURL,
    preview_url:
      getNestedValue(trackData, "previews.audioPreviews.items.0.url") || "",
    release_date: releaseDate,
    album_type: normalizeSpotifyAlbumType(
      albumData.albumType || albumData.type,
    ),
    track_number: Number(trackData.trackNumber || 0),
    total_tracks: Number(getNestedValue(albumData, "tracks.totalCount") || 0),
    disc_number: Number(trackData.discNumber || 0),
    total_discs: 0,
    external_urls: spotifyURL,
    external_links: { spotify: spotifyURL },
    isrc: "",
    explicit: isExplicitSpotify(trackData),
    album_id: albumID,
    album_url: albumURL,
    label: albumData.label || "",
    copyright: spotifyCopyrightText(albumData.copyright),
    comment: albumURL,
    item_type: "track",
    provider_id: "spotify-web",
  };
  applyMetadataFallbacks(track, enrichedMetadata);
  if (!track.album_artist) track.album_artist = artistsString;
  if (!track.disc_number) track.disc_number = 1;

  log.info(
    "Fetched track:",
    track.name,
    "by",
    track.artists,
    "ISRC:",
    track.isrc,
  );

  return {
    type: "track",
    track: track,
  };
}

function fetchArtist(artistID) {
  log.info("Fetching artist:", artistID);

  const overviewPayload = {
    variables: {
      uri: "spotify:artist:" + artistID,
      locale: "",
    },
    operationName: "queryArtistOverview",
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "446130b4a0aa6522a686aafccddb0ae849165b5e0436fd802f96e0243617b5d8",
      },
    },
  };

  const overviewResponse = query(overviewPayload);
  const artistData = getNestedValue(overviewResponse, "data.artistUnion") || {};

  const allDiscographyItems = [];
  let offset = 0;
  const limit = 50;

  const topTracks = [];
  const topTracksData =
    getNestedValue(artistData, "discography.topTracks.items") || [];

  for (const item of topTracksData) {
    const trackData = item.track || {};
    if (!trackData.uri) continue;

    const trackID = trackData.id || spotifyIDFromURI(trackData.uri);

    const albumData = trackData.albumOfTrack || {};
    const albumName = albumData.name || "";
    const albumID = albumData.id || spotifyIDFromURI(albumData.uri);
    const albumURL = albumID ? "https://open.spotify.com/album/" + albumID : "";
    const coverURL = spotifyBestImage(albumData.coverArt);
    const durationMs =
      getNestedValue(trackData, "duration.totalMilliseconds") || 0;
    const trackArtists = spotifyArtistEntries(
      getNestedValue(trackData, "artists.items") || [],
    );
    const artistsString = uniqueMetadataValues(
      trackArtists.map(function (artist) {
        return artist.name;
      }),
    ).join(", ");
    const firstTrackArtist = trackArtists.length ? trackArtists[0] : {};
    const spotifyURL = "https://open.spotify.com/track/" + trackID;

    topTracks.push({
      id: trackID,
      name: trackData.name || "",
      artists: artistsString,
      album_name: albumName,
      album_artist: spotifyArtistNames(albumData.artists) || artistsString,
      album_id: albumID,
      album_url: albumURL,
      artist_id: firstTrackArtist.id || "",
      artist_url: firstTrackArtist.url || "",
      duration_ms: durationMs,
      images: coverURL,
      cover_url: coverURL,
      preview_url:
        getNestedValue(trackData, "previews.audioPreviews.items.0.url") || "",
      release_date: normalizeSpotifyDate(albumData.date),
      track_number: Number(trackData.trackNumber || 0),
      total_tracks: Number(getNestedValue(albumData, "tracks.totalCount") || 0),
      disc_number: Number(trackData.discNumber || 0),
      album_type: normalizeSpotifyAlbumType(
        albumData.albumType || albumData.type,
      ),
      external_urls: spotifyURL,
      external_links: { spotify: spotifyURL },
      copyright: spotifyCopyrightText(albumData.copyright),
      comment: albumURL,
      item_type: "track",
      provider_id: "spotify-web",
      spotify_id: trackID,
      isrc: "",
      explicit: isExplicitSpotify(trackData),
    });
  }

  while (true) {
    const discographyPayload = {
      variables: {
        uri: "spotify:artist:" + artistID,
        offset: offset,
        limit: limit,
        order: "DATE_DESC",
      },
      operationName: "queryArtistDiscographyAll",
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash:
            "5e07d323febb57b4a56a42abbf781490e58764aa45feb6e3dc0591564fc56599",
        },
      },
    };

    try {
      const response = query(discographyPayload);
      const discographyData =
        getNestedValue(response, "data.artistUnion.discography.all") || {};
      const items = discographyData.items || [];

      if (items.length === 0) break;

      allDiscographyItems.push(...items);

      const totalCount = discographyData.totalCount || items.length;
      if (allDiscographyItems.length >= totalCount || items.length < limit) {
        break;
      }

      offset += limit;
    } catch (e) {
      log.debug("Discography fetch error:", e.message);
      break;
    }
  }

  const profile = artistData.profile || {};
  const stats = artistData.stats || {};
  const visuals = artistData.visuals || {};

  const artistInfo = {
    id: artistID,
    name: profile.name || "",
    images: spotifyBestImage(visuals.avatarImage),
    header: getNestedValue(visuals, "headerImage.sources.0.url") || "",
    followers: stats.followers || 0,
    listeners: stats.monthlyListeners || 0,
    biography: getNestedValue(profile, "biography.text") || "",
    verified: profile.verified || false,
  };

  const albums = [];
  for (const item of allDiscographyItems) {
    const releases = getNestedValue(item, "releases.items") || [];
    if (releases.length === 0) continue;

    const release = releases[0];
    let releaseID = "";
    if (release.uri) {
      const parts = release.uri.split(":");
      releaseID = parts[parts.length - 1];
    }

    const dateInfo = release.date || {};
    let releaseDate = dateInfo.isoString || "";
    if (releaseDate && releaseDate.includes("T")) {
      releaseDate = releaseDate.split("T")[0];
    }

    albums.push({
      id: releaseID,
      name: release.name || "",
      album_type: (release.type || "album").toLowerCase(),
      release_date: releaseDate,
      total_tracks: getNestedValue(release, "tracks.totalCount") || 0,
      artists: artistInfo.name,
      cover_url: spotifyBestImage(release.coverArt),
      external_urls: "https://open.spotify.com/album/" + releaseID,
      provider_id: "spotify-web",
    });
  }

  log.info("Fetched artist with", albums.length, "releases");

  return {
    type: "artist",
    artist: {
      id: artistInfo.id,
      name: artistInfo.name,
      image_url: artistInfo.images,
      header_image: artistInfo.header,
      listeners: artistInfo.listeners,
      albums: albums,
      top_tracks: topTracks,
      provider_id: "spotify-web",
    },
  };
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;

  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const index = parseInt(part, 10);
      if (!Array.isArray(current) || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else {
      if (
        current === null ||
        current === undefined ||
        typeof current !== "object"
      ) {
        return undefined;
      }
      current = current[part];
    }
  }

  return current;
}

function spotifyIDFromURI(uri) {
  const value = String(uri || "").trim();
  if (!value) return "";
  const parts = value.split(":");
  return parts[parts.length - 1] || "";
}

function normalizeSpotifyDate(dateValue) {
  let value = "";
  if (typeof dateValue === "string") {
    value = dateValue;
  } else if (dateValue && typeof dateValue === "object") {
    value = dateValue.isoString || "";
    if (!value && dateValue.year) {
      value = String(dateValue.year);
      if (dateValue.month) {
        value += "-" + String(dateValue.month).padStart(2, "0");
        if (dateValue.day) {
          value += "-" + String(dateValue.day).padStart(2, "0");
        }
      }
    }
  }
  if (value.indexOf("T") >= 0) value = value.split("T")[0];
  return value;
}

function uniqueMetadataValues(values) {
  const result = [];
  const seen = {};
  for (let i = 0; i < (values || []).length; i++) {
    const value = String(values[i] || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    result.push(value);
  }
  return result;
}

function spotifyArtistEntries(value) {
  const items = Array.isArray(value)
    ? value
    : getNestedValue(value, "items") || [];
  const artists = [];
  for (let i = 0; i < items.length; i++) {
    const item = (items[i] && (items[i].data || items[i])) || {};
    const name = getNestedValue(item, "profile.name") || item.name || "";
    const id = item.id || spotifyIDFromURI(item.uri);
    if (!name && !id) continue;
    artists.push({
      id: id,
      name: name,
      url:
        getNestedValue(item, "sharingInfo.shareUrl") ||
        (id ? "https://open.spotify.com/artist/" + id : ""),
    });
  }
  return artists;
}

function spotifyArtistNames(value) {
  return uniqueMetadataValues(
    spotifyArtistEntries(value).map(function (artist) {
      return artist.name;
    }),
  ).join(", ");
}

function spotifyBestImage(value) {
  if (!value) return "";
  let sources = Array.isArray(value) ? value : value.sources || [];
  if (!sources.length && value.items && value.items.length) {
    sources = (value.items[0] && value.items[0].sources) || [];
  }
  let best = null;
  let bestSize = -1;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i] || {};
    if (!source.url) continue;
    const width = Number(source.width || 0);
    const height = Number(source.height || 0);
    const size =
      width > 0 && height > 0 ? width * height : Math.max(width, height);
    if (!best || size > bestSize) {
      best = source;
      bestSize = size;
    }
  }
  return (best && spotifyMaxCoverURL(best.url)) || "";
}

function spotifyMaxCoverURL(value) {
  const url = String(value || "");
  if (!url) return "";
  if (url.indexOf(SPOTIFY_COVER_SIZE_300) !== -1) {
    return url.replace(SPOTIFY_COVER_SIZE_300, SPOTIFY_COVER_SIZE_MAX);
  }
  if (url.indexOf(SPOTIFY_COVER_SIZE_640) !== -1) {
    return url.replace(SPOTIFY_COVER_SIZE_640, SPOTIFY_COVER_SIZE_MAX);
  }
  return url;
}

function spotifyCopyrightText(value) {
  const items = Array.isArray(value)
    ? value
    : getNestedValue(value, "items") || [];
  return uniqueMetadataValues(
    items.map(function (item) {
      return (item && (item.text || item.value)) || "";
    }),
  ).join("; ");
}

function normalizeSpotifyAlbumType(value) {
  const type = String(value || "album")
    .trim()
    .toLowerCase();
  if (type === "ep") return "ep";
  if (type === "single") return "single";
  if (type === "compilation") return "compilation";
  if (type === "audiobook") return "audiobook";
  if (type === "podcast") return "podcast";
  return "album";
}

function spotifyTotalDiscs(trackItems) {
  let total = 0;
  const items = trackItems || [];
  for (let i = 0; i < items.length; i++) {
    const track = (items[i] && (items[i].track || items[i])) || {};
    const disc = Number(track.discNumber || track.disc_number || 0);
    if (disc > total) total = disc;
  }
  if (!total && items.length) total = 1;
  return total;
}

function applyMetadataFallbacks(target, source) {
  if (!target || !source) return target;
  const stringFields = [
    "album_name",
    "album_artist",
    "album_id",
    "album_url",
    "artist_id",
    "artist_url",
    "preview_url",
    "release_date",
    "album_type",
    "isrc",
    "upc",
    "label",
    "copyright",
    "genre",
    "composer",
    "comment",
    "deezer_id",
  ];
  for (let i = 0; i < stringFields.length; i++) {
    const field = stringFields[i];
    if (
      !String(target[field] || "").trim() &&
      String(source[field] || "").trim()
    ) {
      target[field] = source[field];
    }
  }
  const numberFields = [
    "track_number",
    "total_tracks",
    "disc_number",
    "total_discs",
    "duration_ms",
  ];
  for (let i = 0; i < numberFields.length; i++) {
    const field = numberFields[i];
    if (!(Number(target[field]) > 0) && Number(source[field]) > 0) {
      target[field] = Number(source[field]);
    }
  }
  if (!target.explicit && source.explicit) target.explicit = true;
  if (source.external_links && typeof source.external_links === "object") {
    target.external_links =
      target.external_links && typeof target.external_links === "object"
        ? target.external_links
        : {};
    for (const provider in source.external_links) {
      if (!target.external_links[provider] && source.external_links[provider]) {
        target.external_links[provider] = source.external_links[provider];
      }
    }
  }
  return target;
}

// Spotify GraphQL exposes a parental-advisory flag as `contentRating.label`
// (e.g. "EXPLICIT" / "NONE"). Some shapes use a boolean `explicit`. This helper
// normalizes both into a boolean so we can surface an "E" badge in the UI.
function isExplicitSpotify(obj) {
  if (!obj) return false;
  var label = getNestedValue(obj, "contentRating.label");
  if (typeof label === "string" && label.toUpperCase() === "EXPLICIT")
    return true;
  if (obj.explicit === true) return true;
  if (typeof obj.isExplicit === "boolean") return obj.isExplicit;
  return false;
}

function spotifyIDToHexGID(spotifyID) {
  if (!spotifyID) return "";

  const alphabet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const bytes = [];

  for (let i = 0; i < spotifyID.length; i++) {
    const value = alphabet.indexOf(spotifyID.charAt(i));
    if (value < 0) {
      throw new Error("Invalid Spotify ID character");
    }

    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      const total = bytes[j] * 62 + carry;
      bytes[j] = total & 0xff;
      carry = total >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = carry >> 8;
    }
  }

  while (bytes.length < 16) {
    bytes.push(0);
  }

  let hex = "";
  for (let i = 15; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }

  return hex;
}

function protobufBytes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") value = String(value);
  const bytes = new Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function readProtobufFields(value) {
  const bytes = protobufBytes(value);
  const fields = {};
  let position = 0;

  function readVarint() {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 10 && position < bytes.length; i++) {
      const current = bytes[position++];
      result += (current & 0x7f) * multiplier;
      if ((current & 0x80) === 0) return result;
      multiplier *= 128;
    }
    return null;
  }

  while (position < bytes.length) {
    const tag = readVarint();
    if (tag === null || tag <= 0) break;
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    let fieldValue;

    if (wireType === 0) {
      fieldValue = readVarint();
      if (fieldValue === null) break;
    } else if (wireType === 1) {
      if (position + 8 > bytes.length) break;
      fieldValue = bytes.slice(position, position + 8);
      position += 8;
    } else if (wireType === 2) {
      const length = readVarint();
      if (length === null || length < 0 || position + length > bytes.length)
        break;
      fieldValue = bytes.slice(position, position + length);
      position += length;
    } else if (wireType === 5) {
      if (position + 4 > bytes.length) break;
      fieldValue = bytes.slice(position, position + 4);
      position += 4;
    } else {
      break;
    }

    if (!fields[fieldNumber]) fields[fieldNumber] = [];
    fields[fieldNumber].push({ wire: wireType, value: fieldValue });
  }

  return fields;
}

function protobufFieldValues(fields, fieldNumber, wireType) {
  const entries = (fields && fields[fieldNumber]) || [];
  return entries
    .filter(function (entry) {
      return wireType === undefined || entry.wire === wireType;
    })
    .map(function (entry) {
      return entry.value;
    });
}

function protobufFirstValue(fields, fieldNumber, wireType) {
  const values = protobufFieldValues(fields, fieldNumber, wireType);
  return values.length ? values[0] : null;
}

function protobufUTF8(bytes) {
  const input = protobufBytes(bytes);
  let result = "";
  for (let i = 0; i < input.length; ) {
    const first = input[i++];
    let codePoint = first;
    let extra = 0;
    if ((first & 0xe0) === 0xc0) {
      codePoint = first & 0x1f;
      extra = 1;
    } else if ((first & 0xf0) === 0xe0) {
      codePoint = first & 0x0f;
      extra = 2;
    } else if ((first & 0xf8) === 0xf0) {
      codePoint = first & 0x07;
      extra = 3;
    }
    for (let j = 0; j < extra && i < input.length; j++) {
      codePoint = codePoint * 64 + (input[i++] & 0x3f);
    }
    if (codePoint <= 0xffff) {
      result += String.fromCharCode(codePoint);
    } else {
      codePoint -= 0x10000;
      result += String.fromCharCode(0xd800 + Math.floor(codePoint / 0x400));
      result += String.fromCharCode(0xdc00 + (codePoint % 0x400));
    }
  }
  return result;
}

function protobufString(fields, fieldNumber) {
  const value = protobufFirstValue(fields, fieldNumber, 2);
  return value ? protobufUTF8(value) : "";
}

function decodeProtobufSInt(value) {
  const number = Number(value || 0);
  return number % 2 ? -Math.floor((number + 1) / 2) : Math.floor(number / 2);
}

function spotifyGIDBytesToID(bytes) {
  const input = protobufBytes(bytes);
  if (!input.length) return "";
  const alphabet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = [0];
  for (let i = 0; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      const value = digits[j] * 256 + carry;
      digits[j] = value % 62;
      carry = Math.floor(value / 62);
    }
    while (carry > 0) {
      digits.push(carry % 62);
      carry = Math.floor(carry / 62);
    }
  }
  let id = "";
  for (let i = digits.length - 1; i >= 0; i--) id += alphabet[digits[i]];
  return id.padStart(22, "0");
}

function parseSpotifyProtoExternalID(value) {
  const fields = readProtobufFields(value);
  return {
    type: protobufString(fields, 1).toLowerCase(),
    id: protobufString(fields, 2),
  };
}

function parseSpotifyProtoArtist(value) {
  const fields = readProtobufFields(value);
  const gid = protobufFirstValue(fields, 1, 2);
  const id = spotifyGIDBytesToID(gid);
  return {
    id: id,
    name: protobufString(fields, 2),
    url: id ? "https://open.spotify.com/artist/" + id : "",
  };
}

function parseSpotifyProtoDate(value) {
  const fields = readProtobufFields(value);
  return normalizeSpotifyDate({
    year: decodeProtobufSInt(protobufFirstValue(fields, 1, 0)),
    month: decodeProtobufSInt(protobufFirstValue(fields, 2, 0)),
    day: decodeProtobufSInt(protobufFirstValue(fields, 3, 0)),
  });
}

function parseSpotifyProtoCopyright(value) {
  const fields = readProtobufFields(value);
  return protobufString(fields, 2);
}

function parseSpotifyProtoAlbum(value) {
  const fields = readProtobufFields(value);
  const gid = protobufFirstValue(fields, 1, 2);
  const albumID = spotifyGIDBytesToID(gid);
  const artists = protobufFieldValues(fields, 3, 2).map(
    parseSpotifyProtoArtist,
  );
  const typeValue = Number(protobufFirstValue(fields, 4, 0) || 1);
  const albumTypes = {
    1: "album",
    2: "single",
    3: "compilation",
    4: "ep",
    5: "audiobook",
    6: "podcast",
  };
  const externalIDs = protobufFieldValues(fields, 10, 2).map(
    parseSpotifyProtoExternalID,
  );
  let upc = "";
  for (let i = 0; i < externalIDs.length; i++) {
    if (externalIDs[i].type === "upc") {
      upc = externalIDs[i].id;
      break;
    }
    if (!upc && externalIDs[i].type === "ean") upc = externalIDs[i].id;
  }

  const discs = protobufFieldValues(fields, 11, 2);
  let totalDiscs = 0;
  let totalTracks = 0;
  for (let i = 0; i < discs.length; i++) {
    const discFields = readProtobufFields(discs[i]);
    const discNumber = decodeProtobufSInt(protobufFirstValue(discFields, 1, 0));
    if (discNumber > totalDiscs) totalDiscs = discNumber;
    totalTracks += protobufFieldValues(discFields, 3, 2).length;
  }
  if (!totalDiscs && discs.length) totalDiscs = discs.length;

  const genres = protobufFieldValues(fields, 8, 2).map(protobufUTF8);
  const copyrights = protobufFieldValues(fields, 13, 2).map(
    parseSpotifyProtoCopyright,
  );
  const firstArtist = artists.length ? artists[0] : {};
  return {
    album_id: albumID,
    album_name: protobufString(fields, 2),
    album_artist: uniqueMetadataValues(
      artists.map(function (artist) {
        return artist.name;
      }),
    ).join(", "),
    artist_id: firstArtist.id || "",
    artist_url: firstArtist.url || "",
    album_url: albumID ? "https://open.spotify.com/album/" + albumID : "",
    album_type: albumTypes[typeValue] || "album",
    label: protobufString(fields, 5),
    release_date: parseSpotifyProtoDate(protobufFirstValue(fields, 6, 2)),
    upc: upc,
    total_tracks: totalTracks,
    total_discs: totalDiscs,
    genre: uniqueMetadataValues(genres).join("; "),
    copyright: uniqueMetadataValues(copyrights).join("; "),
  };
}

function parseSpotifyProtoTrack(value) {
  const fields = readProtobufFields(value);
  const albumValue = protobufFirstValue(fields, 3, 2);
  const result = albumValue ? parseSpotifyProtoAlbum(albumValue) : {};
  const externalIDs = protobufFieldValues(fields, 10, 2).map(
    parseSpotifyProtoExternalID,
  );
  for (let i = 0; i < externalIDs.length; i++) {
    if (externalIDs[i].type === "isrc") {
      result.isrc = String(externalIDs[i].id || "").toUpperCase();
      break;
    }
  }

  const composers = [];
  const artistRoles = protobufFieldValues(fields, 32, 2);
  for (let i = 0; i < artistRoles.length; i++) {
    const roleFields = readProtobufFields(artistRoles[i]);
    const role = Number(protobufFirstValue(roleFields, 3, 0) || 0);
    if (role === 5) composers.push(protobufString(roleFields, 2));
  }

  result.track_number = decodeProtobufSInt(protobufFirstValue(fields, 5, 0));
  result.disc_number = decodeProtobufSInt(protobufFirstValue(fields, 6, 0));
  result.duration_ms = decodeProtobufSInt(protobufFirstValue(fields, 7, 0));
  result.explicit = Number(protobufFirstValue(fields, 9, 0) || 0) === 1;
  result.composer = uniqueMetadataValues(composers).join("; ");
  return result;
}

function extractISRCFromSpotifyMetadataBody(body) {
  if (!body) return "";
  const match = String(body).match(/isrc[\x00-\x1f]+([A-Za-z0-9]{12})/);
  return match && match[1] ? match[1].toUpperCase() : "";
}

function getSpotifyMetadataBody(entityType, spotifyID, allowRetry) {
  try {
    ensureInitialized();

    const gid = spotifyIDToHexGID(spotifyID);
    if (!gid) {
      return null;
    }

    const response = http.get(
      "https://spclient.wg.spotify.com/metadata/4/" +
        entityType +
        "/" +
        gid +
        "?market=from_token",
      {
        Authorization: "Bearer " + clientState.accessToken,
        "Client-Token": clientState.clientToken,
        "Spotify-App-Version": clientState.clientVersion,
        "App-Platform": "WebPlayer",
        "User-Agent": utils.randomUserAgent(),
      },
    );

    if (!response || response.error) {
      throw new Error(
        "Spotify metadata query failed: " +
          (response ? response.error : "no response"),
      );
    }

    if (response.statusCode === 401 && allowRetry) {
      resetAuthState();
      return getSpotifyMetadataBody(entityType, spotifyID, false);
    }

    if (response.statusCode === 404) {
      log.debug(
        "Spotify metadata endpoint returned 404 for:",
        entityType,
        spotifyID,
      );
      return null;
    }

    if (response.statusCode !== 200) {
      throw new Error(
        "Spotify metadata query failed: HTTP " + response.statusCode,
      );
    }

    return response.body || null;
  } catch (e) {
    log.debug("Spotify metadata lookup failed:", e.message);
    return null;
  }
}

function getSpotifyNativeAlbumMetadata(albumID) {
  if (!albumID) return null;
  const cached = metadataCacheGet(nativeAlbumMetadataCache, albumID);
  if (cached) return cached;
  const body = getSpotifyMetadataBody("album", albumID, true);
  if (!body) return null;
  const metadata = parseSpotifyProtoAlbum(body);
  if (!metadata.album_id) metadata.album_id = albumID;
  if (!metadata.album_url)
    metadata.album_url = "https://open.spotify.com/album/" + albumID;
  return metadataCachePut(nativeAlbumMetadataCache, albumID, metadata);
}

function getSpotifyNativeTrackMetadata(spotifyID, albumID) {
  if (!spotifyID) return null;
  const cached = metadataCacheGet(nativeTrackMetadataCache, spotifyID);
  if (cached) return cached;
  const body = getSpotifyMetadataBody("track", spotifyID, true);
  if (!body) return null;
  const metadata = parseSpotifyProtoTrack(body);
  if (!metadata.isrc) metadata.isrc = extractISRCFromSpotifyMetadataBody(body);
  const resolvedAlbumID = albumID || metadata.album_id;
  if (resolvedAlbumID) {
    if (!metadata.album_id) metadata.album_id = resolvedAlbumID;
    if (!metadata.album_url)
      metadata.album_url = "https://open.spotify.com/album/" + resolvedAlbumID;
    const albumMetadata = getSpotifyNativeAlbumMetadata(resolvedAlbumID);
    if (albumMetadata) applyMetadataFallbacks(metadata, albumMetadata);
  }
  if (metadata.isrc)
    log.debug("Got ISRC from Spotify metadata:", metadata.isrc);
  return metadataCachePut(nativeTrackMetadataCache, spotifyID, metadata);
}

function getISRCFromSpotifyMetadata(spotifyID, albumID) {
  const metadata = getSpotifyNativeTrackMetadata(spotifyID, albumID);
  return (metadata && metadata.isrc) || null;
}

function normalizeMetadataMatchText(value) {
  let normalized = String(value || "").toLowerCase();
  if (normalized.normalize) {
    normalized = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  normalized = normalized.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, " ");
  normalized = normalized.replace(
    /\b(deluxe|expanded|anniversary|edition|version|remaster(?:ed)?|mono|stereo)\b/g,
    " ",
  );
  return normalized
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deezerAlbumMatches(expectedAlbumName, actualAlbumName) {
  const expected = normalizeMetadataMatchText(expectedAlbumName);
  const actual = normalizeMetadataMatchText(actualAlbumName);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  if (
    expected.length >= 6 &&
    actual.length >= 6 &&
    (expected.indexOf(actual) >= 0 || actual.indexOf(expected) >= 0)
  ) {
    return true;
  }
  try {
    if (typeof matching !== "undefined" && matching.compareStrings) {
      return Number(matching.compareStrings(expected, actual)) >= 0.86;
    }
  } catch (e) {
    // Fall through to the conservative exact/substring decision above.
  }
  return false;
}

function deezerComposerNames(data) {
  const contributors = (data && data.contributors) || [];
  const names = [];
  for (let i = 0; i < contributors.length; i++) {
    const role = String(
      (contributors[i] && contributors[i].role) || "",
    ).toLowerCase();
    if (
      role.indexOf("composer") >= 0 ||
      role.indexOf("writer") >= 0 ||
      role.indexOf("songwriter") >= 0 ||
      role.indexOf("author") >= 0
    ) {
      names.push(contributors[i].name);
    }
  }
  return uniqueMetadataValues(names).join("; ");
}

function getMetadataFromDeezerTrackData(data, expected) {
  try {
    if (!data || !data.id) {
      return null;
    }

    const result = {
      isrc: data.isrc || null,
      deezer_id: String(data.id),
      external_links: {
        deezer: data.link || "https://www.deezer.com/track/" + data.id,
      },
      release_date: "",
      track_number: 0,
      total_tracks: 0,
      disc_number: 0,
      total_discs: 0,
      album_type: "",
      album_artist: "",
      upc: "",
      genre: "",
      label: "",
      copyright: "",
      composer: deezerComposerNames(data),
      preview_url: data.preview || "",
      explicit: data.explicit_lyrics === true,
      release_match: false,
    };

    if (result.isrc) {
      log.debug("Got ISRC from Deezer:", result.isrc);
    }

    if (data.album && data.album.id) {
      try {
        const albumCacheKey = String(data.album.id);
        let albumData = metadataCacheGet(
          deezerAlbumMetadataCache,
          albumCacheKey,
        );
        const albumCacheMiss = albumData === METADATA_CACHE_MISS;
        if (albumCacheMiss) albumData = null;
        if (!albumData && !albumCacheMiss) {
          const albumURL = "https://api.deezer.com/album/" + data.album.id;
          const albumResponse = http.get(albumURL, {
            "User-Agent": utils.randomUserAgent(),
          });
          if (
            albumResponse &&
            !albumResponse.error &&
            albumResponse.statusCode === 200
          ) {
            albumData = metadataCachePut(
              deezerAlbumMetadataCache,
              albumCacheKey,
              JSON.parse(albumResponse.body),
            );
          } else if (albumResponse && albumResponse.statusCode === 404) {
            metadataCachePut(
              deezerAlbumMetadataCache,
              albumCacheKey,
              METADATA_CACHE_MISS,
              METADATA_NEGATIVE_CACHE_TTL_MS,
            );
          }
        }

        if (albumData) {
          const expectedAlbumName =
            (expected && (expected.album_name || expected.albumName)) || "";
          const actualAlbumName =
            albumData.title || getNestedValue(data, "album.title") || "";
          result.release_match = deezerAlbumMatches(
            expectedAlbumName,
            actualAlbumName,
          );

          if (
            albumData.genres &&
            albumData.genres.data &&
            albumData.genres.data.length > 0
          ) {
            const genreNames = albumData.genres.data.map(function (g) {
              return g.name;
            });
            result.genre = uniqueMetadataValues(genreNames).join("; ");
            log.debug("Got genre from Deezer:", result.genre);
          }

          if (result.release_match) {
            result.label = albumData.label || "";
            result.release_date =
              albumData.release_date || data.release_date || "";
            result.track_number = Number(data.track_position || 0);
            result.total_tracks = Number(albumData.nb_tracks || 0);
            result.disc_number = Number(data.disk_number || 0);
            result.upc = albumData.upc || "";
            result.album_type = normalizeSpotifyAlbumType(
              albumData.record_type || "album",
            );
            result.album_artist =
              getNestedValue(albumData, "artist.name") || "";
            const albumTracks = getNestedValue(albumData, "tracks.data") || [];
            result.total_discs = spotifyTotalDiscs(albumTracks);
            if (!result.total_discs && albumTracks.length)
              result.total_discs = 1;
            if (result.label && result.release_date) {
              result.copyright =
                result.release_date.substring(0, 4) + " " + result.label;
            }
            log.debug("Matched Deezer release metadata:", actualAlbumName);
          } else {
            log.debug(
              "Ignoring mismatched Deezer release metadata:",
              actualAlbumName,
              "expected:",
              expectedAlbumName,
            );
          }
        }
      } catch (albumErr) {
        log.debug("Failed to fetch album details:", albumErr.message);
      }
    }

    return result;
  } catch (e) {
    log.debug("Deezer metadata lookup failed:", e.message);
    return null;
  }
}

function getMetadataFromDeezerByISRC(isrc, expected) {
  try {
    if (!isrc) {
      return null;
    }

    const cacheKey =
      String(isrc).trim().toUpperCase() +
      "|" +
      normalizeMetadataMatchText(
        (expected && (expected.album_name || expected.albumName)) || "",
      );
    const cached = metadataCacheGet(deezerTrackMetadataCache, cacheKey);
    if (cached === METADATA_CACHE_MISS) return null;
    if (cached) return cached;

    const directURL =
      "https://api.deezer.com/track/isrc:" + encodeURIComponent(isrc);
    const directResponse = http.get(directURL, {
      "User-Agent": utils.randomUserAgent(),
    });

    if (
      directResponse &&
      !directResponse.error &&
      directResponse.statusCode === 200
    ) {
      const data = JSON.parse(directResponse.body);
      if (data && data.id) {
        log.debug("Got Deezer track from ISRC:", isrc, "->", data.id);
        return metadataCachePut(
          deezerTrackMetadataCache,
          cacheKey,
          getMetadataFromDeezerTrackData(data, expected),
        );
      }
    } else {
      log.debug(
        "Deezer ISRC direct lookup failed:",
        directResponse ? directResponse.statusCode : "no response",
      );
    }

    const searchURL =
      "https://api.deezer.com/search/track?q=isrc:" +
      encodeURIComponent(isrc) +
      "&limit=1";
    const searchResponse = http.get(searchURL, {
      "User-Agent": utils.randomUserAgent(),
    });

    if (
      !searchResponse ||
      searchResponse.error ||
      searchResponse.statusCode !== 200
    ) {
      log.debug(
        "Deezer ISRC search failed:",
        searchResponse ? searchResponse.statusCode : "no response",
      );
      return null;
    }

    const searchData = JSON.parse(searchResponse.body);
    const track =
      searchData && searchData.data && searchData.data.length > 0
        ? searchData.data[0]
        : null;
    if (!track || !track.id) {
      log.debug("Deezer ISRC search returned no track for:", isrc);
      metadataCachePut(
        deezerTrackMetadataCache,
        cacheKey,
        METADATA_CACHE_MISS,
        METADATA_NEGATIVE_CACHE_TTL_MS,
      );
      return null;
    }

    log.debug("Got Deezer track from ISRC search:", isrc, "->", track.id);
    return metadataCachePut(
      deezerTrackMetadataCache,
      cacheKey,
      getMetadataFromDeezerTrackData(track, expected),
    );
  } catch (e) {
    log.debug("Deezer ISRC metadata lookup failed:", e.message);
    return null;
  }
}

function enrichMetadata(spotifyID, albumID, expected) {
  const nativeMetadata = getSpotifyNativeTrackMetadata(spotifyID, albumID);
  const result = nativeMetadata || {};

  if (result.isrc) {
    log.info(
      "Enriched ISRC from Spotify metadata for",
      spotifyID,
      "->",
      result.isrc,
    );
  }

  const comparison = expected || {};
  if (!comparison.album_name && result.album_name)
    comparison.album_name = result.album_name;
  const metadata = result.isrc
    ? getMetadataFromDeezerByISRC(result.isrc, comparison)
    : null;
  if (metadata) applyMetadataFallbacks(result, metadata);

  return result;
}

function enrichISRC(spotifyID, albumID) {
  return getISRCFromSpotifyMetadata(spotifyID, albumID);
}

function normalizeLyricsText(text) {
  if (!text) return "";
  let normalized = String(text).toLowerCase();
  normalized = normalized.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ");
  normalized = normalized.replace(
    /[^a-z0-9\u00c0-\u024f\u0400-\u04ff\u0590-\u06ff\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g,
    " ",
  );
  normalized = normalized.replace(/\s+/g, " ").trim();
  return normalized;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Base64 decode (atob polyfill for Goja)
 */
function atob(str) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  let result = "";
  let i = 0;

  str = str.replace(/[^A-Za-z0-9+/=]/g, "");

  while (i < str.length) {
    const enc1 = chars.indexOf(str.charAt(i++));
    const enc2 = chars.indexOf(str.charAt(i++));
    const enc3 = chars.indexOf(str.charAt(i++));
    const enc4 = chars.indexOf(str.charAt(i++));

    const chr1 = (enc1 << 2) | (enc2 >> 4);
    const chr2 = ((enc2 & 15) << 4) | (enc3 >> 2);
    const chr3 = ((enc3 & 3) << 6) | enc4;

    result += String.fromCharCode(chr1);
    if (enc3 !== 64) result += String.fromCharCode(chr2);
    if (enc4 !== 64) result += String.fromCharCode(chr3);
  }

  return result;
}

function customSearch(searchQuery, options) {
  log.info("Searching Spotify:", searchQuery);
  log.debug("Received options:", JSON.stringify(options));

  let limit = (options && options.limit) || 20;
  const offset = (options && options.offset) || 0;
  const filter = (options && options.filter) || null; // "tracks", "albums", "artists", "playlists", or null for all

  if (limit <= 0 || limit > 50) {
    limit = 50;
  }

  // Determine if we're filtering to a specific type
  const isFiltered = filter && filter !== "all";

  log.debug(
    "Search options - limit:",
    limit,
    "offset:",
    offset,
    "filter:",
    filter || "all",
    "isFiltered:",
    isFiltered,
  );

  ensureInitialized();

  const searchPayload = {
    variables: {
      searchTerm: searchQuery,
      offset: offset,
      limit: limit,
      numberOfTopResults: 5,
      includeAudiobooks: true,
      includeArtistHasConcertsField: false,
      includePreReleases: true,
      includeAuthors: false,
    },
    operationName: "searchDesktop",
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c",
      },
    },
  };

  try {
    const response = query(searchPayload);
    const searchData = getNestedValue(response, "data.searchV2") || {};

    const results = [];

    // Parse tracks if no filter or filter is "tracks"
    if (!isFiltered || filter === "tracks") {
      let tracksData = getNestedValue(searchData, "tracksV2.items") || [];
      if (tracksData.length === 0) {
        tracksData = getNestedValue(searchData, "tracks.items") || [];
      }

      log.debug("Search returned", tracksData.length, "raw track items");

      for (const item of tracksData) {
        let trackData = null;

        if (item.item && item.item.data) {
          trackData = item.item.data;
        } else if (item.track) {
          trackData = item.track;
        } else if (item.data) {
          trackData = item.data;
        }

        if (!trackData) continue;

        const trackID = trackData.id || spotifyIDFromURI(trackData.uri);
        if (!trackID) continue;

        const artistEntries = spotifyArtistEntries(
          getNestedValue(trackData, "artists.items") || [],
        );
        const artistsString = uniqueMetadataValues(
          artistEntries.map(function (artist) {
            return artist.name;
          }),
        ).join(", ");
        const firstArtist = artistEntries.length ? artistEntries[0] : {};

        const trackName = trackData.name || "";
        if (!trackName) continue;

        const albumData = trackData.albumOfTrack || {};
        const albumName = albumData.name || "";
        const albumID = albumData.id || spotifyIDFromURI(albumData.uri);
        const albumURL = albumID
          ? "https://open.spotify.com/album/" + albumID
          : "";
        const coverURL = spotifyBestImage(albumData.coverArt);
        const durationMs =
          getNestedValue(trackData, "duration.totalMilliseconds") ||
          getNestedValue(trackData, "trackDuration.totalMilliseconds") ||
          0;
        const spotifyURL = "https://open.spotify.com/track/" + trackID;

        results.push({
          id: trackID,
          spotify_id: trackID,
          name: trackName,
          artists: artistsString,
          album_name: albumName,
          album_artist: spotifyArtistNames(albumData.artists) || artistsString,
          album_id: albumID,
          album_url: albumURL,
          artist_id: firstArtist.id || "",
          artist_url: firstArtist.url || "",
          duration_ms: durationMs,
          images: coverURL,
          cover_url: coverURL,
          preview_url:
            getNestedValue(trackData, "previews.audioPreviews.items.0.url") ||
            "",
          release_date: normalizeSpotifyDate(albumData.date),
          track_number: Number(trackData.trackNumber || 0),
          total_tracks: Number(
            getNestedValue(albumData, "tracks.totalCount") || 0,
          ),
          disc_number: Number(trackData.discNumber || 0),
          album_type: normalizeSpotifyAlbumType(
            albumData.albumType || albumData.type,
          ),
          external_urls: spotifyURL,
          external_links: { spotify: spotifyURL },
          label: albumData.label || "",
          copyright: spotifyCopyrightText(albumData.copyright),
          comment: albumURL,
          source: "spotify-internal",
          item_type: "track",
          provider_id: "spotify-web",
          explicit: isExplicitSpotify(trackData),
        });
      }
    }

    // Parse albums if no filter or filter is "albums"
    if (!isFiltered || filter === "albums") {
      let albumsData = getNestedValue(searchData, "albums.items") || [];
      if (albumsData.length === 0) {
        albumsData = getNestedValue(searchData, "albumsV2.items") || [];
      }
      // Only limit if not filtering specifically for albums
      if (!isFiltered) {
        albumsData = albumsData.slice(0, 5);
      }
      log.debug(
        "Search returned",
        albumsData.length,
        "album items" + (isFiltered ? "" : " (limited to 5)"),
      );

      for (const item of albumsData) {
        const albumData = (item.item && item.item.data) || item.data || item;
        if (!albumData) continue;

        const albumID = albumData.id || spotifyIDFromURI(albumData.uri);
        if (!albumID) continue;

        const albumName = albumData.name || "";
        if (!albumName) continue;

        // Artists
        const albumArtists = spotifyArtistEntries(
          getNestedValue(albumData, "artists.items") || [],
        );
        const artistsString = uniqueMetadataValues(
          albumArtists.map(function (artist) {
            return artist.name;
          }),
        ).join(", ");
        const firstAlbumArtist = albumArtists.length ? albumArtists[0] : {};

        const coverURL = spotifyBestImage(albumData.coverArt);

        // Release date
        const releaseDate = normalizeSpotifyDate(albumData.date);
        const albumURL = "https://open.spotify.com/album/" + albumID;

        results.push({
          id: albumID,
          name: albumName,
          artists: artistsString,
          artist_id: firstAlbumArtist.id || "",
          artist_url: firstAlbumArtist.url || "",
          cover_url: coverURL,
          images: coverURL,
          release_date: releaseDate,
          total_tracks: Number(
            getNestedValue(albumData, "tracks.totalCount") || 0,
          ),
          album_type: normalizeSpotifyAlbumType(
            albumData.albumType || albumData.type,
          ),
          external_urls: albumURL,
          item_type: "album",
          provider_id: "spotify-web",
        });
      }
    }

    // Parse artists if no filter or filter is "artists"
    if (!isFiltered || filter === "artists") {
      let artistsData = getNestedValue(searchData, "artists.items") || [];
      // Only limit if not filtering specifically for artists
      if (!isFiltered) {
        artistsData = artistsData.slice(0, 2);
      }
      log.debug(
        "Search returned",
        artistsData.length,
        "artist items" + (isFiltered ? "" : " (limited to 2)"),
      );

      for (const item of artistsData) {
        const artistData = (item.item && item.item.data) || item.data || item;
        if (!artistData) continue;

        let artistID = "";
        if (artistData.uri) {
          const parts = artistData.uri.split(":");
          artistID = parts[parts.length - 1];
        }
        if (!artistID) continue;

        const profile = artistData.profile || artistData;
        const artistName = profile.name || artistData.name || "";
        if (!artistName) continue;

        const visuals = artistData.visuals || {};
        const imageURL =
          spotifyBestImage(visuals.avatarImage) ||
          getNestedValue(artistData, "images.0.url") ||
          "";

        results.push({
          id: artistID,
          name: artistName,
          image_url: imageURL,
          images: imageURL,
          item_type: "artist",
          provider_id: "spotify-web",
        });
      }
    }

    // Parse playlists if no filter or filter is "playlists"
    if (!isFiltered || filter === "playlists") {
      let playlistsData = getNestedValue(searchData, "playlists.items") || [];
      // Only limit if not filtering specifically for playlists
      if (!isFiltered) {
        playlistsData = playlistsData.slice(0, 4);
      }
      log.debug(
        "Search returned",
        playlistsData.length,
        "playlist items" + (isFiltered ? "" : " (limited to 4)"),
      );

      for (const item of playlistsData) {
        const playlistData = (item.item && item.item.data) || item.data || item;
        if (!playlistData) continue;

        let playlistID = "";
        if (playlistData.uri) {
          const parts = playlistData.uri.split(":");
          playlistID = parts[parts.length - 1];
        }
        if (!playlistID) continue;

        const playlistName = playlistData.name || "";
        if (!playlistName) continue;

        const ownerName =
          getNestedValue(playlistData, "ownerV2.data.name") ||
          getNestedValue(playlistData, "owner.name") ||
          "";
        const coverURL =
          spotifyBestImage(getNestedValue(playlistData, "images.items.0")) ||
          getNestedValue(playlistData, "images.0.url") ||
          "";

        results.push({
          id: playlistID,
          name: playlistName,
          owner: ownerName,
          cover_url: coverURL,
          images: coverURL,
          item_type: "playlist",
          provider_id: "spotify-web",
        });
      }
    }

    log.info("Found", results.length, "items (filter:", filter || "all", ")");
    return results;
  } catch (e) {
    log.error("Search failed:", e.message);
    return [];
  }
}

function handleURL(url) {
  log.info("Handling URL:", url);

  let parsed = parseSpotifyURL(url);

  if (!parsed) {
    return {
      success: false,
      error: "Invalid Spotify URL",
    };
  }

  try {
    if (parsed.type === "short") {
      parsed = resolveSpotifyShortURL(url);
      log.info("Resolved Spotify short URL as", parsed.type + ":" + parsed.id);
    }

    let result;

    switch (parsed.type) {
      case "track":
        result = fetchTrack(parsed.id);
        return {
          success: true,
          type: "track",
          track: result.track,
        };

      case "album":
        result = fetchAlbum(parsed.id);
        // Runtime expects: album (ExtAlbumMetadata), tracks ([]ExtTrackMetadata)
        return {
          success: true,
          type: "album",
          album: {
            id: parsed.id,
            name: result.album_info.name,
            artists: result.album_info.artists,
            artist_id: result.album_info.artist_id,
            cover_url: result.album_info.images,
            release_date: result.album_info.release_date,
            total_tracks: result.album_info.total_tracks,
            total_discs: result.album_info.total_discs,
            album_type: result.album_info.album_type,
            label: result.album_info.label,
            copyright: result.album_info.copyright,
            genre: result.album_info.genre,
            upc: result.album_info.upc,
            external_urls: result.album_info.external_urls,
            comment: result.album_info.comment,
            tracks: result.track_list,
          },
          tracks: result.track_list,
          name: result.album_info.name,
          cover_url: result.album_info.images,
        };

      case "playlist":
        result = fetchPlaylist(parsed.id);
        // Runtime expects: tracks ([]ExtTrackMetadata), name, cover_url
        return {
          success: true,
          type: "playlist",
          tracks: result.track_list,
          name: result.playlist_info.name,
          cover_url: result.playlist_info.cover,
        };

      case "artist":
        result = fetchArtist(parsed.id);
        // Runtime expects: artist (ExtArtistMetadata)
        // fetchArtist now returns { type, artist: { id, name, image_url, albums } }
        return {
          success: true,
          type: "artist",
          artist: result.artist,
        };

      default:
        return {
          success: false,
          error: "Unsupported URL type: " + parsed.type,
        };
    }
  } catch (e) {
    log.error("URL handling failed:", e.message);
    return {
      success: false,
      error: e.message || "Failed to fetch metadata",
    };
  }
}

function getTrack(trackId) {
  try {
    const result = fetchTrack(trackId);
    return result.track;
  } catch (e) {
    log.error("getTrack failed:", e.message);
    return null;
  }
}

function getAlbum(albumId) {
  try {
    const result = fetchAlbum(albumId);
    const tracks = result.track_list.map(function (t) {
      t.provider_id = "spotify-web";
      return t;
    });
    return {
      id: albumId,
      name: result.album_info.name,
      artists: result.album_info.artists,
      artist_id: result.album_info.artist_id,
      artist_url: result.album_info.artist_url,
      release_date: result.album_info.release_date,
      total_tracks: result.album_info.total_tracks,
      total_discs: result.album_info.total_discs,
      album_type: result.album_info.album_type,
      label: result.album_info.label,
      copyright: result.album_info.copyright,
      genre: result.album_info.genre,
      upc: result.album_info.upc,
      external_urls: result.album_info.external_urls,
      comment: result.album_info.comment,
      images: result.album_info.images,
      cover_url: result.album_info.images,
      tracks: tracks,
      provider_id: "spotify-web",
    };
  } catch (e) {
    log.error("getAlbum failed:", e.message);
    return null;
  }
}

function getArtist(artistId) {
  try {
    const result = fetchArtist(artistId);
    return result.artist;
  } catch (e) {
    log.error("getArtist failed:", e.message);
    return null;
  }
}

function getPlaylist(playlistId) {
  try {
    const result = fetchPlaylist(playlistId);
    const tracks = result.track_list.map(function (t) {
      t.provider_id = "spotify-web";
      return t;
    });
    return {
      id: playlistId,
      name: result.playlist_info.name,
      description: result.playlist_info.description,
      owner: result.playlist_info.owner,
      cover: result.playlist_info.cover,
      cover_url: result.playlist_info.cover,
      total_tracks: result.playlist_info.totalTracks,
      followers: result.playlist_info.followers,
      tracks: tracks,
      provider_id: "spotify-web",
    };
  } catch (e) {
    log.error("getPlaylist failed:", e.message);
    return null;
  }
}

function searchTracks(searchQuery, limit) {
  return customSearch(searchQuery, { limit: limit || 20 });
}

function enrichTrack(track) {
  log.info("enrichTrack called for:", track.name, "by", track.artists);

  const spotifyID = (track.spotify_id || track.id || "").trim();
  if (spotifyID) {
    log.debug("Enriching track using Spotify ID:", spotifyID);
    const albumID = String(track.album_id || "").trim();
    const metadata = enrichMetadata(spotifyID, albumID, {
      album_name: track.album_name || "",
    });
    if (metadata) applyMetadataFallbacks(track, metadata);
    if (track.isrc) log.info("Track enriched with real ISRC:", track.isrc);
  }

  return track;
}

function fetchHomeFeed() {
  log.info("Fetching Spotify home feed...");

  ensureInitialized();

  let timeZone = "Asia/Jakarta";
  try {
    const localTime = gobackend.getLocalTime();
    if (localTime && localTime.timezone && localTime.timezone !== "Local") {
      timeZone = localTime.timezone;
    } else if (localTime && localTime.offsetMinutes !== undefined) {
      const offsetMinutes = localTime.offsetMinutes;
      const tzMap = {
        "-420": "Asia/Jakarta", // UTC+7 (WIB)
        "-480": "Asia/Singapore", // UTC+8 (WITA)
        "-540": "Asia/Tokyo", // UTC+9 (WIT)
        "-330": "Asia/Kolkata", // UTC+5:30
        0: "Europe/London", // UTC+0
        "-60": "Europe/Paris", // UTC+1
        300: "America/New_York", // UTC-5
        480: "America/Los_Angeles", // UTC-8
      };
      timeZone = tzMap[String(offsetMinutes)] || "Asia/Jakarta";
    }
  } catch (e) {}
  log.debug("Using timezone: " + timeZone);

  const payload = {
    operationName: "home",
    variables: {
      timeZone: timeZone,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "3a67ee0ea6abad2ebad2e588a9aa130fc98d6b553f5b05ac6467503d02133bdc",
      },
    },
  };

  try {
    const response = query(payload);
    return formatHomeFeedData(response);
  } catch (e) {
    log.error("fetchHomeFeed failed:", e.message);
    return { success: false, error: e.message, sections: [] };
  }
}

function formatHomeFeedData(data) {
  const homeData = getNestedValue(data, "data.home") || {};

  const greeting = getNestedValue(homeData, "greeting.text") || "";

  const sectionContainer = homeData.sectionContainer || {};
  const sectionsData = getNestedValue(sectionContainer, "sections.items") || [];

  const sections = [];

  for (const sectionItem of sectionsData) {
    const sectionData = sectionItem.data || {};
    const sectionTitle = getNestedValue(sectionData, "title.text") || "";
    const sectionUri = sectionItem.uri || "";

    if (!sectionTitle) continue;

    const sectionItems =
      getNestedValue(sectionItem, "sectionItems.items") || [];
    const items = [];

    for (const item of sectionItems) {
      const contentData = getNestedValue(item, "content.data") || {};
      const uri = contentData.uri || "";

      if (!uri) continue;

      const uriParts = uri.split(":");
      if (uriParts.length < 3) continue;

      const itemType = uriParts[1];
      const itemId = uriParts[2];

      const name =
        contentData.name || getNestedValue(contentData, "profile.name") || "";

      let coverUrl = "";
      let artistNames = "";
      let description = "";
      let albumId = "";
      let albumName = "";
      let durationMs = 0;

      if (itemType === "track") {
        coverUrl = spotifyBestImage(
          getNestedValue(contentData, "albumOfTrack.coverArt"),
        );
        durationMs =
          getNestedValue(contentData, "duration.totalMilliseconds") ||
          getNestedValue(contentData, "trackDuration.totalMilliseconds") ||
          0;
        const albumUri = getNestedValue(contentData, "albumOfTrack.uri") || "";
        if (albumUri) {
          const albumParts = albumUri.split(":");
          if (albumParts.length >= 3) {
            albumId = albumParts[2];
          }
        }
        albumName = getNestedValue(contentData, "albumOfTrack.name") || "";
        let artistItems = getNestedValue(contentData, "artists.items") || [];
        if (artistItems.length === 0) {
          const firstArtist = getNestedValue(
            contentData,
            "firstArtist.items.0.profile.name",
          );
          if (firstArtist) {
            artistNames = firstArtist;
            const otherArtists =
              getNestedValue(contentData, "otherArtists.items") || [];
            for (var i = 0; i < otherArtists.length; i++) {
              const oName = getNestedValue(otherArtists[i], "profile.name");
              if (oName) artistNames += ", " + oName;
            }
          }
        } else {
          artistNames = artistItems
            .map(function (a) {
              return getNestedValue(a, "profile.name") || "";
            })
            .filter(function (n) {
              return n;
            })
            .join(", ");
        }
      } else if (itemType === "album") {
        coverUrl = spotifyBestImage(contentData.coverArt);
        let artistItems = getNestedValue(contentData, "artists.items") || [];
        if (artistItems.length === 0) {
          const artistName =
            getNestedValue(contentData, "artists.0.name") ||
            getNestedValue(contentData, "artist.name") ||
            "";
          if (artistName) {
            artistNames = artistName;
          }
        } else {
          artistNames = artistItems
            .map(function (a) {
              return getNestedValue(a, "profile.name") || a.name || "";
            })
            .filter(function (n) {
              return n;
            })
            .join(", ");
        }
      } else if (itemType === "playlist") {
        coverUrl = spotifyBestImage(
          getNestedValue(contentData, "images.items.0"),
        );
        description = contentData.description || "";
        artistNames = getNestedValue(contentData, "ownerV2.data.name") || "";
      } else if (itemType === "artist") {
        coverUrl = spotifyBestImage(
          getNestedValue(contentData, "visuals.avatarImage"),
        );
      } else if (itemType === "station") {
        coverUrl = getNestedValue(contentData, "image.sources.0.url") || "";
      }

      items.push({
        id: itemId,
        uri: uri,
        type: itemType,
        name: name,
        artists: artistNames,
        description: description,
        cover_url: coverUrl,
        album_id: albumId,
        album_name: albumName,
        duration_ms: durationMs,
        provider_id: "spotify-web",
      });
    }

    if (items.length > 0) {
      sections.push({
        uri: sectionUri,
        title: sectionTitle,
        items: items,
      });
    }
  }

  log.info("Fetched", sections.length, "sections from home feed");

  return {
    success: true,
    greeting: greeting,
    sections: sections,
  };
}

/**
 * Browse all categories/genres
 * Uses the 'browseAll' GraphQL operation
 * @returns {Object} Browse categories
 */
function browseAll() {
  log.info("Fetching browse categories...");

  ensureInitialized();

  const payload = {
    operationName: "browseAll",
    variables: {},
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "864fdecccb9bb893141df3776d0207886c7fa781d9e586b9d4eb3afa387eea42",
      },
    },
  };

  try {
    const response = query(payload);
    return formatBrowseData(response);
  } catch (e) {
    log.error("browseAll failed:", e.message);
    return { success: false, error: e.message, categories: [] };
  }
}

function formatBrowseData(data) {
  const browseData = getNestedValue(data, "data.browseV2.data") || {};
  const sections = getNestedValue(browseData, "sections.items") || [];

  const categories = [];

  for (const section of sections) {
    const sectionData = section.data || {};
    const sectionTitle = getNestedValue(sectionData, "title.text") || "";

    const sectionItems = getNestedValue(section, "sectionItems.items") || [];

    for (const item of sectionItems) {
      const contentData = getNestedValue(item, "content.data") || {};
      const uri = contentData.uri || "";
      const name =
        getNestedValue(contentData, "data.cardRepresentation.title.text") ||
        contentData.name ||
        "";
      const imageUrl =
        getNestedValue(
          contentData,
          "data.cardRepresentation.artwork.sources.0.url",
        ) ||
        getNestedValue(contentData, "image.sources.0.url") ||
        "";
      const backgroundColor =
        getNestedValue(
          contentData,
          "data.cardRepresentation.backgroundColor.hex",
        ) || "";

      if (!name) continue;

      let categoryId = "";
      if (uri) {
        const parts = uri.split(":");
        categoryId = parts[parts.length - 1];
      }

      categories.push({
        id: categoryId,
        uri: uri,
        name: name,
        image_url: imageUrl,
        background_color: backgroundColor,
        section: sectionTitle,
      });
    }
  }

  log.info("Fetched", categories.length, "browse categories");

  return {
    success: true,
    categories: categories,
  };
}

function getHomeFeed() {
  try {
    return fetchHomeFeed();
  } catch (e) {
    log.error("getHomeFeed failed:", e.message);
    return { success: false, error: e.message, sections: [] };
  }
}

function getBrowseCategories() {
  try {
    return browseAll();
  } catch (e) {
    log.error("getBrowseCategories failed:", e.message);
    return { success: false, error: e.message, categories: [] };
  }
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
  getHomeFeed: getHomeFeed,
  getBrowseCategories: getBrowseCategories,
});

log.info("Spotify Web Extension loaded!");
