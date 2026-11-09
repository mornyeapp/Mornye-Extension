const CONFIG = {
  fetchTimeoutMs: 15000,
  maxRetries: 2,
  baseBackoffMs: 250,
  cacheTtlMs: 120000,
  cacheMaxEntries: 500,
  poTokenCacheMaxEntries: 200,
  thumbnailSize: 512,
  clientVersion: "1.20240801.01.00",
  debugRawJsonHead: 1200,
  maxResults: 12,
  allowlistHosts: [],
  yt1dResultsURL: "https://yt1d.io/results/",
  yt1dAjaxURL: "https://yt1d.io/wp-admin/admin-ajax.php",
  cobaltAudioURL: "https://api.zarz.moe/v1/dl/cobalt",
  youtubeWatchURL: "https://www.youtube.com/watch?v=",
  poTokenMode: "off",
  poTokenProviderURL: "",
  manualGvsPoToken: "",
  logLevel: "warn",
  homeCountry: "ID",
  poTokenFallbackTtlMs: 6 * 60 * 60 * 1000,
  // InnerTube ANDROID client config
  innerTubeApiKey: "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
  innerTubeClientVersion: "21.02.35",
  innerTubeUserAgent:
    "com.google.android.youtube/21.02.35 (Linux; U; Android 11) gzip",
  directAudioChunkSize: 1024 * 1024,
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getAppUserAgent() {
  try {
    if (
      typeof utils !== "undefined" &&
      utils &&
      typeof utils.appUserAgent === "function"
    ) {
      var appUA = String(utils.appUserAgent() || "").trim();
      if (appUA) return appUA;
    }
  } catch (e) {}
  return "SpotiFLAC-Mobile";
}

function readSetting(settings, key, fallback) {
  if (!settings || typeof settings !== "object") return fallback;
  var value = settings[key];
  if (value === undefined || value === null) return fallback;
  return value;
}

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function normalizeLogLevel(value) {
  var normalized = String(value || "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)
    ? normalized
    : "warn";
}

function L(level, ...args) {
  try {
    var normalizedLevel = normalizeLogLevel(level);
    if (LOG_LEVELS[normalizedLevel] < LOG_LEVELS[CONFIG.logLevel]) return;
    if (
      typeof log !== "undefined" &&
      typeof log[normalizedLevel] === "function"
    ) {
      log[normalizedLevel](...args);
    }
  } catch {}
}

function now() {
  return Date.now();
}

const _cache = new Map();
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (now() - e.t > CONFIG.cacheTtlMs) {
    _cache.delete(k);
    return null;
  }
  // Refresh insertion order so eviction follows true LRU semantics.
  _cache.delete(k);
  _cache.set(k, e);
  return e.v;
}
function cacheSet(k, v) {
  if (_cache.has(k)) _cache.delete(k);
  _cache.set(k, { v, t: now() });
  while (_cache.size > CONFIG.cacheMaxEntries) {
    var oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
}

const _poTokenCache = new Map();
function poTokenCacheGet(k) {
  var e = _poTokenCache.get(k);
  if (!e) return "";
  if (e.expiresAt && now() >= e.expiresAt) {
    _poTokenCache.delete(k);
    return "";
  }
  _poTokenCache.delete(k);
  _poTokenCache.set(k, e);
  return e.token || "";
}
function poTokenCacheSet(k, token, expiresAt) {
  if (!token) return;
  var safeExpiresAt = Number(expiresAt || 0);
  if (!safeExpiresAt || safeExpiresAt <= now()) {
    safeExpiresAt = now() + CONFIG.poTokenFallbackTtlMs;
  }
  if (_poTokenCache.has(k)) _poTokenCache.delete(k);
  _poTokenCache.set(k, { token: token, expiresAt: safeExpiresAt });
  while (_poTokenCache.size > CONFIG.poTokenCacheMaxEntries) {
    var oldestKey = _poTokenCache.keys().next().value;
    _poTokenCache.delete(oldestKey);
  }
}
function poTokenCacheDelete(k) {
  _poTokenCache.delete(k);
}

const _inflight = new Map();
function dedupFetch(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => {
    _inflight.delete(key);
  });
  _inflight.set(key, p);
  return p;
}

async function safeFetch(url, opts) {
  opts = opts || {};
  for (let i = 0; i <= CONFIG.maxRetries; i++) {
    var controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    var local = Object.assign({}, opts);
    if (controller) local.signal = controller.signal;
    var to;
    try {
      if (controller)
        to = setTimeout(function () {
          controller.abort();
        }, CONFIG.fetchTimeoutMs);
      var res = await fetch(url, local);
      if (to) clearTimeout(to);
      if (!res) throw new Error("no_response");
      if (res.status === 429 || res.status === 503) {
        var e = new Error("rate_limited");
        e.retryable = true;
        e.status = res.status;
        throw e;
      }
      return res;
    } catch (err) {
      if (to) clearTimeout(to);
      var retryable =
        err &&
        (err.retryable ||
          err.name === "AbortError" ||
          /Failed to fetch|NetworkError/.test(String(err.message)));
      if (!retryable || i === CONFIG.maxRetries) {
        L("error", "safeFetch final", String(err));
        throw err;
      }
      var back =
        CONFIG.baseBackoffMs * Math.pow(2, i) + Math.floor(Math.random() * 100);
      L("warn", "safeFetch retry", { url: url, attempt: i + 1, back: back });
      await new Promise(function (r) {
        setTimeout(r, back);
      });
    }
  }
  throw new Error("safeFetch_failed");
}

function isString(v) {
  return typeof v === "string";
}

function normalizeUrl(u) {
  if (!isString(u)) return null;
  var s = u.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    var parsed = new URL(s);
    if (
      Array.isArray(CONFIG.allowlistHosts) &&
      CONFIG.allowlistHosts.length > 0
    ) {
      if (
        CONFIG.allowlistHosts.indexOf(parsed.hostname) === -1 &&
        !/^https?:\/\//i.test(parsed.protocol + "//")
      ) {
        // no-op, primary check already ensures http(s)
      }
    }
    return parsed.toString();
  } catch (e) {
    return null;
  }
}

function isAbsoluteHttpUrl(u) {
  return isString(u) && /^https?:\/\//i.test(u.trim());
}

function updateUrlQuery(url, params) {
  try {
    var parsed = new URL(String(url || ""));
    var query = new URLSearchParams(parsed.search);
    for (var key in params) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      var value = params[key];
      if (value === undefined || value === null || value === "") continue;
      query.set(key, String(value));
    }
    var base = parsed.toString().replace(/[?#].*$/, "");
    var encoded = query.toString();
    return base + (encoded ? "?" + encoded : "") + (parsed.hash || "");
  } catch (e) {
    return url;
  }
}

function parseQueryString(text) {
  var out = {};
  var raw = String(text || "");
  if (raw.charAt(0) === "?") raw = raw.substring(1);
  if (!raw) return out;
  var parts = raw.split("&");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part) continue;
    var eq = part.indexOf("=");
    var key = eq >= 0 ? part.substring(0, eq) : part;
    var value = eq >= 0 ? part.substring(eq + 1) : "";
    try {
      key = decodeURIComponent(key.replace(/\+/g, " "));
      value = decodeURIComponent(value.replace(/\+/g, " "));
    } catch (e) {}
    if (key) out[key] = value;
  }
  return out;
}

function formEncode(params) {
  var parts = [];
  for (var key in params) {
    if (!params.hasOwnProperty(key)) continue;
    parts.push(
      encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key])),
    );
  }
  return parts.join("&");
}

function extractYt1dConfig(html) {
  var text = String(html || "");
  var ajaxMatch = text.match(/"ajaxurl"\s*:\s*"([^"]+)"/);
  var nonceMatch = text.match(/"nonce"\s*:\s*"([^"]+)"/);
  return {
    ajaxURL: ajaxMatch
      ? ajaxMatch[1].replace(/\\\//g, "/")
      : CONFIG.yt1dAjaxURL,
    nonce: nonceMatch ? nonceMatch[1] : "",
  };
}

function getYt1dConfig() {
  var cached = cacheGet("yt1d:config");
  if (cached && cached.nonce) return cached;

  var res = fetch(CONFIG.yt1dResultsURL, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": getRandomUserAgent(),
    },
  });

  if (!res || !res.ok) {
    throw new Error(
      "yt1d config returned " + (res ? res.status : "no response"),
    );
  }

  var html = "";
  try {
    html = res.text();
  } catch (e) {
    html = "";
  }
  var config = extractYt1dConfig(html);
  if (!config.nonce) {
    throw new Error("yt1d nonce not found");
  }

  cacheSet("yt1d:config", config);
  return config;
}

// Direct clients follow yt-dlp's current client contexts. Android VR 1.65.10
// has returned 403 for all formats since August 2026, so it is not a fallback.
var INNERTUBE_CLIENTS = [
  {
    name: "tv_samsung",
    clientHeaderName: "7",
    requiresGvsPoToken: false,
    requiresJsPlayer: true,
    body: {
      context: {
        client: {
          clientName: "TVHTML5",
          clientVersion: "5.20260707",
          hl: "en",
          gl: "US",
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          osName: "Tizen",
          osVersion: "2.4.0",
          deviceMake: "Samsung",
          deviceModel: "UKS9800",
        },
      },
    },
    ua: "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
    key: CONFIG.innerTubeApiKey,
  },
  {
    name: "web_embedded",
    clientHeaderName: "56",
    requiresGvsPoToken: false,
    requiresJsPlayer: true,
    body: {
      context: {
        client: {
          clientName: "WEB_EMBEDDED_PLAYER",
          clientVersion: "2.20260708.00.00",
          hl: "en",
          gl: "US",
        },
      },
    },
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)",
    key: CONFIG.innerTubeApiKey,
  },
  {
    name: "mweb",
    clientHeaderName: "2",
    requiresGvsPoToken: true,
    body: {
      context: {
        client: {
          clientName: "MWEB",
          clientVersion: "2.20260115.01.00",
          hl: "en",
          gl: "US",
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          userAgent:
            "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
        },
      },
    },
    ua: "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)",
    key: CONFIG.innerTubeApiKey,
  },
  {
    name: "android",
    clientHeaderName: "3",
    requiresGvsPoToken: true,
    body: {
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: CONFIG.innerTubeClientVersion,
          androidSdkVersion: 30,
          hl: "en",
          gl: "US",
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          osName: "Android",
          osVersion: "11",
          platform: "MOBILE",
        },
      },
    },
    ua: CONFIG.innerTubeUserAgent,
    key: CONFIG.innerTubeApiKey,
  },
  {
    name: "ios",
    clientHeaderName: "5",
    requiresGvsPoToken: true,
    body: {
      context: {
        client: {
          clientName: "IOS",
          clientVersion: "21.02.3",
          deviceMake: "Apple",
          deviceModel: "iPhone16,2",
          hl: "en",
          gl: "US",
          timeZone: "UTC",
          utcOffsetMinutes: 0,
          osName: "iOS",
          osVersion: "18.3.2",
          platform: "MOBILE",
        },
      },
    },
    ua: "com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    key: "AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc",
  },
];

var YOUTUBE_AUDIO_FORMAT_PREFERENCE = [251, 250, 249, 140, 139, 600, 599, 18];

function parseMimeCodec(mimeType) {
  var text = String(mimeType || "");
  var match = text.match(/codecs="([^"]+)"/i);
  return match ? match[1] : "";
}

function outputExtensionFromYouTubeFormat(fmt) {
  var mimeType = String((fmt && fmt.mimeType) || "").toLowerCase();
  var codec = parseMimeCodec(mimeType).toLowerCase();
  if (mimeType.indexOf("audio/webm") >= 0 || codec.indexOf("opus") >= 0)
    return ".opus";
  if (mimeType.indexOf("audio/mp4") >= 0 || codec.indexOf("mp4a") >= 0)
    return ".m4a";
  if (mimeType.indexOf("video/mp4") >= 0) return ".mp4";
  if (mimeType.indexOf("video/webm") >= 0) return ".webm";
  return ".opus";
}

function isGvsPoTokenRequiredFormat(fmt) {
  var itag = String((fmt && fmt.itag) || "");
  return itag !== "18";
}

function hasUsableYouTubeFormatURL(fmt) {
  if (!fmt || !(fmt.url || fmt.signatureCipher || fmt.cipher)) return false;
  var mimeType = String(fmt.mimeType || "").toLowerCase();
  return (
    mimeType.indexOf("audio/") === 0 ||
    (Number(fmt.itag) === 18 && mimeType.indexOf("video/mp4") === 0)
  );
}

function scoreYouTubeFormat(fmt, clientConfig, hasGvsPoToken) {
  if (!hasUsableYouTubeFormatURL(fmt)) return -1;
  if (
    clientConfig &&
    clientConfig.requiresGvsPoToken &&
    isGvsPoTokenRequiredFormat(fmt) &&
    !hasGvsPoToken
  ) {
    return -1;
  }
  var itag = Number(fmt.itag || 0);
  var prefIndex = YOUTUBE_AUDIO_FORMAT_PREFERENCE.indexOf(itag);
  var score = prefIndex >= 0 ? 1000 - prefIndex * 50 : 0;
  var mimeType = String(fmt.mimeType || "").toLowerCase();
  if (mimeType.indexOf("audio/") === 0) score += 100;
  if (mimeType.indexOf("opus") >= 0) score += 25;
  score += Math.min(Number(fmt.averageBitrate || fmt.bitrate || 0) / 1000, 300);
  return score;
}

function chooseYouTubeFormat(formats, clientConfig, hasGvsPoToken) {
  var best = null;
  var bestScore = -1;

  for (var pi = 0; pi < YOUTUBE_AUDIO_FORMAT_PREFERENCE.length; pi++) {
    var wanted = YOUTUBE_AUDIO_FORMAT_PREFERENCE[pi];
    for (var fi = 0; fi < formats.length; fi++) {
      var fmt = formats[fi];
      if (
        Number((fmt && fmt.itag) || 0) !== wanted ||
        !hasUsableYouTubeFormatURL(fmt)
      )
        continue;
      var score = scoreYouTubeFormat(fmt, clientConfig, hasGvsPoToken);
      if (score > bestScore) {
        best = fmt;
        bestScore = score;
      }
    }
    if (best) return best;
  }

  for (var i = 0; i < formats.length; i++) {
    var fallback = formats[i];
    if (!hasUsableYouTubeFormatURL(fallback)) continue;
    var fallbackScore = scoreYouTubeFormat(
      fallback,
      clientConfig,
      hasGvsPoToken,
    );
    if (fallbackScore > bestScore) {
      best = fallback;
      bestScore = fallbackScore;
    }
  }
  return best;
}

function normalizePoTokenProviderURL(value) {
  var raw = String(value || "").trim();
  if (!raw) return "";
  try {
    var parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    var text = parsed.toString().replace(/\/+$/, "");
    if (!/\/get_pot$/i.test(text)) text += "/get_pot";
    return text;
  } catch (e) {
    return "";
  }
}

function cleanPoToken(value) {
  var token = String(value || "").trim();
  if (!token) return "";
  var plus = token.lastIndexOf("+");
  if (plus >= 0) token = token.substring(plus + 1);
  token = token.split(/[?&#]/)[0].trim();
  return /^[A-Za-z0-9_-]+={0,2}$/.test(token) ? token : "";
}

function parseExpirationMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") {
    if (value > 1000000000000) return value;
    if (value > 1000000000) return value * 1000;
    return now() + value * 1000;
  }
  var text = String(value || "").trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return parseExpirationMs(Number(text));
  var parsed = Date.parse(text);
  return isNaN(parsed) ? 0 : parsed;
}

function extractPoTokenPayload(payload) {
  if (!payload) return null;
  var direct = cleanPoToken(
    payload.po_token || payload.poToken || payload.pot || payload.token,
  );
  if (direct) {
    return {
      token: direct,
      contentBinding: String(
        payload.content_binding ||
          payload.contentBinding ||
          payload.visit_identifier ||
          payload.visitor_data ||
          "",
      ),
      expiresAt: parseExpirationMs(
        payload.expires_at ||
          payload.expiresAt ||
          payload.expiry ||
          payload.expiration ||
          payload.ttl ||
          payload.expires_in,
      ),
    };
  }

  var keys = ["data", "result", "response", "tokenData"];
  for (var i = 0; i < keys.length; i++) {
    if (!payload[keys[i]]) continue;
    var nested = extractPoTokenPayload(payload[keys[i]]);
    if (nested) return nested;
  }
  return null;
}

function getManualGvsPoToken(clientName) {
  var raw = String(CONFIG.manualGvsPoToken || "").trim();
  if (!raw) return "";
  var parts = raw.split(/[\s,]+/);
  var fallback = "";
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var plus = part.indexOf("+");
    if (plus < 0) {
      fallback = cleanPoToken(part);
      continue;
    }
    var meta = part.substring(0, plus).toLowerCase();
    var token = cleanPoToken(part.substring(plus + 1));
    if (!token) continue;
    if (meta === String(clientName || "").toLowerCase() + ".gvs") return token;
    if (meta === "gvs" && !fallback) fallback = token;
  }
  return fallback;
}

function getPoTokenCacheKey(videoID, clientConfig, visitorData) {
  return [
    "pot",
    clientConfig ? clientConfig.name : "",
    "gvs",
    String(videoID || ""),
    String(visitorData || "").slice(0, 32),
  ].join(":");
}

function requestExternalGvsPoToken(
  videoID,
  clientConfig,
  visitorData,
  bypassCache,
) {
  var endpoint = normalizePoTokenProviderURL(CONFIG.poTokenProviderURL);
  if (!endpoint) return "";
  var innertubeContext = JSON.parse(
    JSON.stringify(clientConfig.body.context || {}),
  );
  if (visitorData && innertubeContext.client) {
    innertubeContext.client.visitorData = visitorData;
  }

  var contentBinding =
    String(videoID || "").trim() || String(visitorData || "").trim();
  var payloads = [
    {
      content_binding: contentBinding,
      innertube_context: innertubeContext,
      bypass_cache: !!bypassCache,
    },
    {
      visitor_data: visitorData || contentBinding,
      bypass_cache: !!bypassCache,
    },
  ];

  var lastStatus = "";
  for (var pi = 0; pi < payloads.length; pi++) {
    if (pi > 0 && !visitorData) continue;
    var body = payloads[pi];
    var res = fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": getAppUserAgent(),
      },
      body: JSON.stringify(body),
    });
    if (!res || !res.ok) {
      lastStatus = res ? String(res.status) : "no response";
      if (res && res.status !== 400 && res.status !== 422) break;
      continue;
    }

    var payload = null;
    try {
      payload = res.json();
    } catch (e) {
      payload = null;
    }
    var tokenPayload = extractPoTokenPayload(payload);
    if (!tokenPayload || !tokenPayload.token) {
      L("warn", "[POT] provider returned no token");
      return "";
    }
    if (
      tokenPayload.contentBinding &&
      contentBinding &&
      tokenPayload.contentBinding !== contentBinding
    ) {
      L(
        "debug",
        "[POT] provider returned binding:",
        tokenPayload.contentBinding,
      );
    }
    return {
      token: tokenPayload.token,
      expiresAt: tokenPayload.expiresAt || 0,
    };
  }
  L("warn", "[POT] provider failed:", lastStatus || "request failed");
  return "";
}

function getGvsPoToken(videoID, clientConfig, visitorData, bypassCache) {
  if (!clientConfig || !clientConfig.requiresGvsPoToken) return "";
  var mode = String(CONFIG.poTokenMode || "off").toLowerCase();
  if (mode === "off" || mode === "disabled") return "";

  var cacheKey = getPoTokenCacheKey(videoID, clientConfig, visitorData);
  if (bypassCache) poTokenCacheDelete(cacheKey);
  var cached = poTokenCacheGet(cacheKey);
  if (cached) return cached;

  var manualToken = getManualGvsPoToken(clientConfig.name);
  if (manualToken && (mode === "manual" || mode === "auto") && !bypassCache) {
    poTokenCacheSet(cacheKey, manualToken, now() + CONFIG.poTokenFallbackTtlMs);
    return manualToken;
  }

  if (mode === "external" || mode === "auto") {
    var externalToken = requestExternalGvsPoToken(
      videoID,
      clientConfig,
      visitorData,
      bypassCache,
    );
    if (externalToken && externalToken.token) {
      poTokenCacheSet(cacheKey, externalToken.token, externalToken.expiresAt);
      return externalToken.token;
    }
  }
  return "";
}

function extractYouTubeVisitorData(text) {
  var html = String(text || "");
  var patterns = [
    /"VISITOR_DATA"\s*:\s*"([^"]+)"/,
    /"visitorData"\s*:\s*"([^"]+)"/,
    /visitorData["']?\s*:\s*["']([^"']+)/,
  ];
  for (var i = 0; i < patterns.length; i++) {
    var match = html.match(patterns[i]);
    if (match && match[1]) return match[1].replace(/\\u0026/g, "&");
  }
  return "";
}

function extractYouTubePlayerURL(text) {
  var html = String(text || "");
  var match =
    html.match(/"jsUrl"\s*:\s*"([^"]+)"/) ||
    html.match(/"PLAYER_JS_URL"\s*:\s*"([^"]+)"/) ||
    html.match(/(\/s\/player\/[^"']+\/base\.js)/);
  if (!match) return "";
  var playerURL = String(match[1] || match[0] || "").replace(/\\\//g, "/");
  if (!playerURL) return "";
  if (playerURL.indexOf("//") === 0) return "https:" + playerURL;
  if (playerURL.charAt(0) === "/") return "https://www.youtube.com" + playerURL;
  return /^https?:\/\//i.test(playerURL) ? playerURL : "";
}

function getYouTubePageInfo(videoID) {
  var cacheKey = "youtube:pageinfo:" + String(videoID || "");
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var res = fetch(
    CONFIG.youtubeWatchURL + encodeURIComponent(String(videoID || "")),
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": getRandomUserAgent(),
      },
    },
  );
  if (!res || !res.ok) {
    L(
      "warn",
      "[InnerTube] visitorData page failed:",
      res ? res.status : "no response",
    );
    return { visitorData: "", playerUrl: "" };
  }

  var html = "";
  try {
    html = res.text();
  } catch (e) {
    html = "";
  }
  var pageInfo = {
    visitorData: extractYouTubeVisitorData(html),
    playerUrl: extractYouTubePlayerURL(html),
  };
  if (pageInfo.visitorData || pageInfo.playerUrl) cacheSet(cacheKey, pageInfo);
  return pageInfo;
}

function getGlobalRoot() {
  try {
    if (typeof globalThis !== "undefined") return globalThis;
  } catch (e) {}
  return (function () {
    return this;
  })();
}

function loadYouTubePlayerJS(playerUrl) {
  var url = String(playerUrl || "").trim();
  if (!url) return "";
  var cacheKey = "youtube:playerjs:" + url;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;

  var res = fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/javascript,text/javascript,*/*",
      "User-Agent": getRandomUserAgent(),
    },
  });
  if (!res || !res.ok) {
    L(
      "warn",
      "[InnerTube] player JS failed:",
      res ? res.status : "no response",
    );
    return "";
  }

  var js = "";
  try {
    js = res.text();
  } catch (e) {
    js = "";
  }
  if (js) cacheSet(cacheKey, js);
  return js;
}

function findYouTubeURLTransformFunction(playerJS) {
  var text = String(playerJS || "");
  var marker = /\.set\(\s*["']alr["']\s*,\s*["']yes["']\s*\)/g.exec(text);
  if (!marker) return "";

  var prefix = text.substring(Math.max(0, marker.index - 12000), marker.index);
  var patterns = [
    /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function\s*\([^)]*\)\s*\{/g,
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /([A-Za-z_$][\w$]*)\s*=\s*function\s*\([^)]*\)\s*\{/g,
  ];
  var best = "";
  for (var pi = 0; pi < patterns.length; pi++) {
    var pattern = patterns[pi];
    var match;
    while ((match = pattern.exec(prefix))) {
      if (match[1]) best = match[1];
    }
  }
  return best;
}

function buildYouTubeChallengeSolver(playerJS) {
  var text = String(playerJS || "");
  var transformFn = findYouTubeURLTransformFunction(text);
  if (!transformFn) return null;

  var marker = ";})(_yt_player);";
  var markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) {
    marker = "})(_yt_player);";
    markerIndex = text.lastIndexOf(marker);
  }
  if (markerIndex < 0) return null;

  var injection =
    ';(function(){var root=typeof globalThis!=="undefined"?globalThis:this;' +
    "root.__mornyeYtChallengeSolver=function(sig,n){var result={};" +
    "var url=" +
    transformFn +
    '("https://www.youtube.com/watch?v=yt-dlp-wins","s",sig?encodeURIComponent(sig):void 0);' +
    'if(n){url.set("n",n);var proto=Object.getPrototypeOf(url);var names=Object.getOwnPropertyNames(proto);' +
    "for(var i=0;i<names.length;i++){var name=names[i];" +
    'if(name==="constructor"||name==="set"||name==="get"||name==="clone")continue;' +
    'if(typeof url[name]!=="function")continue;' +
    "try{url[name](url);break}catch(e){try{url[name]();break}catch(e2){}}}}" +
    'if(sig)result.sig=decodeURIComponent(url.get("s")||url.get("sig")||url.get("signature")||"");' +
    'if(n)result.n=url.get("n")||"";return result};})();';

  var root = getGlobalRoot();
  var previous = {};
  var had = {};
  function setStub(name, value) {
    had[name] = Object.prototype.hasOwnProperty.call(root, name);
    previous[name] = root[name];
    root[name] = value;
  }

  var xhr = function () {};
  xhr.prototype.fetch = function () {};
  var fakeDocument = {
    createElement: function () {
      return {};
    },
    querySelector: function () {
      return null;
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    body: {
      appendChild: function () {},
      removeChild: function () {},
    },
  };
  var fakeWindow = {
    location: { hostname: "www.youtube.com", href: "https://www.youtube.com/" },
    addEventListener: function () {},
    removeEventListener: function () {},
    XMLHttpRequest: xhr,
  };
  fakeWindow.window = fakeWindow;
  fakeWindow.document = fakeDocument;

  setStub("window", fakeWindow);
  setStub("document", fakeDocument);
  setStub("location", fakeWindow.location);
  setStub("navigator", { userAgent: getRandomUserAgent() });
  setStub("XMLHttpRequest", xhr);
  setStub("ytcfg", {
    get: function () {
      return null;
    },
    set: function () {},
  });

  try {
    var script =
      text.substring(0, markerIndex) + injection + text.substring(markerIndex);
    eval(script);
    var solver = root.__mornyeYtChallengeSolver;
    return typeof solver === "function" ? solver : null;
  } catch (e) {
    L(
      "warn",
      "[InnerTube] player challenge solver failed:",
      String((e && e.message) || e),
    );
    return null;
  } finally {
    try {
      delete root.__mornyeYtChallengeSolver;
    } catch (e2) {
      root.__mornyeYtChallengeSolver = undefined;
    }
    for (var key in previous) {
      if (!Object.prototype.hasOwnProperty.call(previous, key)) continue;
      if (had[key]) root[key] = previous[key];
      else {
        try {
          delete root[key];
        } catch (e3) {
          root[key] = undefined;
        }
      }
    }
  }
}

function solveYouTubePlayerChallenge(playerUrl, sig, n) {
  var url = String(playerUrl || "").trim();
  if (!url || (!sig && !n)) return {};

  var cacheKey = "youtube:playersolver:" + url;
  var solver = cacheGet(cacheKey);
  if (!solver) {
    var playerJS = loadYouTubePlayerJS(url);
    if (!playerJS) return {};
    solver = buildYouTubeChallengeSolver(playerJS);
    if (!solver) return {};
    cacheSet(cacheKey, solver);
  }

  try {
    return solver(sig || "", n || "") || {};
  } catch (e) {
    L(
      "warn",
      "[InnerTube] challenge solve failed:",
      String((e && e.message) || e),
    );
    return {};
  }
}

function buildYouTubeFormatURL(fmt, playerUrl) {
  if (!fmt) return "";

  var rawURL = String(fmt.url || "").trim();
  var cipher = fmt.signatureCipher || fmt.cipher;
  var encryptedSig = "";
  var sigParam = "signature";

  if (!rawURL && cipher) {
    var parsedCipher = parseQueryString(cipher);
    rawURL = String(parsedCipher.url || "").trim();
    encryptedSig = String(parsedCipher.s || "").trim();
    sigParam = String(parsedCipher.sp || "signature").trim() || "signature";
  }
  if (!rawURL) return "";

  var solved = {};
  try {
    var parsed = new URL(rawURL);
    var nValue = parsed.searchParams.get("n") || "";
    if (encryptedSig || nValue) {
      solved = solveYouTubePlayerChallenge(playerUrl, encryptedSig, nValue);
    }
    if (encryptedSig) {
      var sigValue = solved.sig || "";
      if (!sigValue) return "";
      rawURL = updateUrlQuery(rawURL, { [sigParam]: sigValue });
    }
    if (nValue && solved.n) rawURL = updateUrlQuery(rawURL, { n: solved.n });
    return rawURL;
  } catch (e) {
    return encryptedSig ? "" : rawURL;
  }
}

function _tryInnerTubeClient(videoID, clientConfig, pageInfo, options) {
  options = options || {};
  pageInfo = pageInfo || {};
  var visitorData = pageInfo.visitorData || "";
  var playerUrlForChallenges = pageInfo.playerUrl || "";
  var reqBody = JSON.parse(JSON.stringify(clientConfig.body));
  reqBody.videoId = videoID;
  // Request content to be served in a way compatible with external download
  reqBody.contentCheckOk = true;
  reqBody.racyCheckOk = true;
  if (clientConfig.requiresJsPlayer && playerUrlForChallenges) {
    if (pageInfo.signatureTimestamp === undefined) {
      var playerCode = loadYouTubePlayerJS(playerUrlForChallenges);
      var timestamp = playerCode.match(/(?:signatureTimestamp|sts)\s*:\s*(\d{5})/);
      pageInfo.signatureTimestamp = timestamp ? Number(timestamp[1]) : 0;
    }
    if (pageInfo.signatureTimestamp) {
      reqBody.playbackContext = {
        contentPlaybackContext: {
          html5Preference: "HTML5_PREF_WANTS",
          signatureTimestamp: pageInfo.signatureTimestamp,
        },
      };
    }
  }
  if (visitorData) {
    reqBody.context.client.visitorData = visitorData;
  }

  var playerUrl =
    "https://www.youtube.com/youtubei/v1/player?key=" +
    clientConfig.key +
    "&prettyPrint=false";
  var headers = {
    "Content-Type": "application/json",
    "User-Agent": clientConfig.ua,
    Origin: "https://www.youtube.com",
    "X-YouTube-Client-Name": String(
      clientConfig.clientHeaderName ||
        clientConfig.body.context.client.clientName,
    ),
    "X-YouTube-Client-Version": clientConfig.body.context.client.clientVersion,
  };
  if (visitorData) {
    headers["X-Goog-Visitor-Id"] = visitorData;
  }

  var res = fetch(playerUrl, {
    method: "POST",
    headers: headers,
    body: JSON.stringify(reqBody),
  });

  if (!res || !res.ok) {
    return { error: "HTTP " + (res ? res.status : "no response") };
  }

  var data;
  try {
    data = res.json();
  } catch (e) {
    return { error: "json parse fail" };
  }
  if (!data) return { error: "null response" };

  var playStatus = data.playabilityStatus ? data.playabilityStatus.status : "?";
  if (playStatus !== "OK") {
    var reason = data.playabilityStatus
      ? data.playabilityStatus.reason || playStatus
      : "unknown";
    return { error: reason };
  }

  var sd = data.streamingData;
  if (!sd) return { error: "no streamingData" };

  var formats = (sd.formats || []).concat(sd.adaptiveFormats || []);
  var gvsPoToken = getGvsPoToken(
    videoID,
    clientConfig,
    visitorData,
    !!options.bypassPoCache,
  );
  var candidates = [];
  var remaining = formats.slice();
  while (remaining.length) {
    var bestAudio = chooseYouTubeFormat(remaining, clientConfig, !!gvsPoToken);
    if (!bestAudio) break;
    remaining.splice(remaining.indexOf(bestAudio), 1);
    var bestAudioURL = buildYouTubeFormatURL(bestAudio, playerUrlForChallenges);
    if (!bestAudioURL) continue;
    if (gvsPoToken && isGvsPoTokenRequiredFormat(bestAudio)) {
      bestAudioURL = updateUrlQuery(bestAudioURL, { pot: gvsPoToken });
    }
    candidates.push({
      url: bestAudioURL,
      extension: outputExtensionFromYouTubeFormat(bestAudio),
      itag: bestAudio.itag,
      mimeType: bestAudio.mimeType || "",
      contentLength: bestAudio.contentLength || "",
      bitrate: bestAudio.averageBitrate || bestAudio.bitrate || 0,
      clientName: clientConfig.name,
      needsGvsPoToken:
        clientConfig.requiresGvsPoToken && isGvsPoTokenRequiredFormat(bestAudio),
      poTokenUsed: !!gvsPoToken,
      ua: clientConfig.ua,
    });
  }
  if (!candidates.length) {
    return { error: "no usable audio URL (fmts=" + formats.length + ")" };
  }
  candidates[0].alternatives = candidates.slice(1);
  return candidates[0];
}

function findInnerTubeClientByName(name) {
  var wanted = String(name || "");
  for (var i = 0; i < INNERTUBE_CLIENTS.length; i++) {
    if (INNERTUBE_CLIENTS[i].name === wanted) return INNERTUBE_CLIENTS[i];
  }
  return null;
}

function refreshInnerTubeAudioCandidate(videoID, oldCandidate, pageInfo) {
  var client = findInnerTubeClientByName(
    oldCandidate && oldCandidate.clientName,
  );
  if (!client) return null;
  L(
    "info",
    "[InnerTube] Refreshing candidate with fresh PO token:",
    client.name,
  );
  var refreshed = _tryInnerTubeClient(videoID, client, pageInfo, {
    bypassPoCache: true,
  });
  if (refreshed && !refreshed.error) return refreshed;
  if (refreshed && refreshed.error) {
    L("warn", "[InnerTube] Fresh PO retry candidate failed:", refreshed.error);
  }
  return null;
}

function requestInnerTubeAudioDownload(videoID) {
  // Returns the first client that gives us a valid audio URL.
  // No probe -- probing can invalidate single-use googlevideo URLs.
  var lastError = "";
  var pageInfo = { visitorData: "", playerUrl: "" };
  try {
    pageInfo = getYouTubePageInfo(videoID);
  } catch (pageErr) {
    L("warn", "[InnerTube] page info failed:", String(pageErr));
  }

  for (var ci = 0; ci < INNERTUBE_CLIENTS.length; ci++) {
    var client = INNERTUBE_CLIENTS[ci];
    L("info", "[InnerTube] Trying " + client.name + " for " + videoID);

    var result = _tryInnerTubeClient(videoID, client, pageInfo);
    if (result.error) {
      L("warn", "[InnerTube] " + client.name + " failed: " + result.error);
      lastError = client.name + ": " + result.error;
      continue;
    }

    L(
      "info",
      "[InnerTube] " +
        client.name +
        " OK: itag=" +
        result.itag +
        " " +
        result.extension +
        " " +
        result.bitrate +
        "bps",
    );
    return result;
  }

  throw new Error("innertube: all clients failed. Last: " + lastError);
}

// Returns an array of {url, extension, ua, clientName} for all clients that respond.
// Used for download-level fallback: try downloading from each until one succeeds.
function getInnerTubeAudioCandidates(videoID, pageInfo) {
  var candidates = [];
  pageInfo = pageInfo || getYouTubePageInfo(videoID);
  for (var ci = 0; ci < INNERTUBE_CLIENTS.length; ci++) {
    var client = INNERTUBE_CLIENTS[ci];
    L(
      "info",
      "[InnerTube] Getting candidate from " + client.name + " for " + videoID,
    );

    var result = _tryInnerTubeClient(videoID, client, pageInfo);
    if (result.error) {
      L("warn", "[InnerTube] " + client.name + " failed: " + result.error);
      continue;
    }

    L(
      "info",
      "[InnerTube] " +
        client.name +
        " candidate: itag=" +
        result.itag +
        " " +
        result.extension +
        " " +
        result.bitrate +
        "bps",
    );
    candidates.push(result);
  }
  return candidates;
}

// Resolve and download one InnerTube candidate at a time. Fetching all client
// candidates up front adds three unnecessary player requests when the first
// client succeeds, and also lets otherwise fresh media URLs age before use.
function tryInnerTubeDownloadsLazily(
  videoID,
  pageInfo,
  outputPath,
  youtubeURL,
  coverURL,
) {
  var deferred = [];
  for (var ci = 0; ci < INNERTUBE_CLIENTS.length; ci++) {
    var client = INNERTUBE_CLIENTS[ci];
    L(
      "info",
      "[InnerTube] Resolving candidate from " + client.name + " for " + videoID,
    );

    var candidate;
    try {
      candidate = _tryInnerTubeClient(videoID, client, pageInfo);
    } catch (error) {
      L("warn", "[InnerTube] client request failed:", client.name, String(error));
      continue;
    }
    if (!candidate || candidate.error) {
      L(
        "warn",
        "[InnerTube] " + client.name + " failed:",
        candidate && candidate.error ? candidate.error : "no candidate",
      );
      continue;
    }

    var candidates = [candidate].concat(candidate.alternatives || []);
    for (var fi = 0; fi < candidates.length; fi++) {
      var next = candidates[fi];
      if (next.extension !== ".opus") {
        deferred.push(next);
        continue;
      }
      var success = tryInnerTubeCandidateDownload(
        next,
        videoID,
        pageInfo,
        outputPath,
        youtubeURL,
        coverURL,
      );
      if (success) return success;
    }
  }

  for (var di = 0; di < deferred.length; di++) {
    var fallback = tryInnerTubeCandidateDownload(
      deferred[di],
      videoID,
      pageInfo,
      outputPath,
      youtubeURL,
      coverURL,
    );
    if (fallback) {
      L("warn", "[YTMusic] Direct Opus unavailable; using", fallback.audio_codec);
      return fallback;
    }
  }
  return null;
}

function tryInnerTubeCandidateDownload(
  candidate,
  videoID,
  pageInfo,
  outputPath,
  youtubeURL,
  coverURL,
) {
  try {
    L(
      "info",
      "[YTMusic] Trying direct InnerTube download:",
      candidate.clientName,
      "itag=" + candidate.itag,
      candidate.extension,
      "pot=" + (candidate.poTokenUsed ? "yes" : "no"),
    );
    var directAttempt = attemptDirectCandidateDownload(
      candidate,
      outputPath,
      youtubeURL,
    );
    var directResult = directAttempt.result;
    if (directResult && directResult.success) {
      L(
        "info",
        "[YTMusic] Direct InnerTube download OK:",
        candidate.clientName,
        "itag=" + candidate.itag,
      );
      return buildDownloadSuccess(
        directResult.path || directAttempt.path,
        coverURL,
      );
    }

    L(
      "warn",
      "[YTMusic] Direct InnerTube download failed:",
      candidate.clientName,
      downloadErrorText(directResult),
    );
    if (candidate.needsGvsPoToken && isDownloadAuthFailure(directResult)) {
      var refreshedCandidate = refreshInnerTubeAudioCandidate(
        videoID,
        candidate,
        pageInfo,
      );
      if (
        refreshedCandidate &&
        refreshedCandidate.url &&
        refreshedCandidate.url !== candidate.url
      ) {
        L(
          "info",
          "[YTMusic] Retrying direct InnerTube with fresh PO token:",
          refreshedCandidate.clientName,
          "itag=" + refreshedCandidate.itag,
        );
        var retryAttempt = attemptDirectCandidateDownload(
          refreshedCandidate,
          outputPath,
          youtubeURL,
        );
        var retryResult = retryAttempt.result;
        if (retryResult && retryResult.success) {
          L(
            "info",
            "[YTMusic] Direct InnerTube fresh PO retry OK:",
            refreshedCandidate.clientName,
            "itag=" + refreshedCandidate.itag,
          );
          return buildDownloadSuccess(
            retryResult.path || retryAttempt.path,
            coverURL,
          );
        }
        L(
          "warn",
          "[YTMusic] Direct InnerTube fresh PO retry failed:",
          refreshedCandidate.clientName,
          downloadErrorText(retryResult),
        );
      }
    }
  } catch (error) {
    L(
      "warn",
      "[YTMusic] Direct candidate failed:",
      candidate.clientName,
      String(error),
    );
  }
  return null;
}

function extractYt1dDownloadURL(payload) {
  if (!payload) return "";
  if (payload.downloadUrl && /^https?:\/\//i.test(String(payload.downloadUrl)))
    return String(payload.downloadUrl);
  if (payload.downloadURL && /^https?:\/\//i.test(String(payload.downloadURL)))
    return String(payload.downloadURL);
  if (payload.url && /^https?:\/\//i.test(String(payload.url)))
    return String(payload.url);
  if (
    payload.download_link &&
    /^https?:\/\//i.test(String(payload.download_link))
  )
    return String(payload.download_link);
  if (payload.data) return extractYt1dDownloadURL(payload.data);
  return "";
}

function requestYt1dAudioDownload(youtubeURL) {
  var config = getYt1dConfig();
  var res = fetch(config.ajaxURL || CONFIG.yt1dAjaxURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      Origin: "https://yt1d.io",
      Referer: CONFIG.yt1dResultsURL,
      "User-Agent": getRandomUserAgent(),
    },
    body: formEncode({
      action: "process_youtube_audio_download",
      video_url: youtubeURL,
      quality: "m4a",
      nonce: config.nonce,
    }),
  });

  if (!res || !res.ok) {
    throw new Error(
      "yt1d audio returned " + (res ? res.status : "no response"),
    );
  }

  var payload;
  try {
    payload = res.json();
  } catch (e) {
    payload = null;
  }
  var downloadURL = extractYt1dDownloadURL(payload);
  if (!downloadURL) {
    var message =
      payload && payload.data && payload.data.message
        ? payload.data.message
        : "download URL missing";
    throw new Error("yt1d audio failed: " + message);
  }

  return {
    url: downloadURL,
    extension: ".mp3",
  };
}

function extractCobaltDownloadURL(payload) {
  if (!payload) return "";
  if (payload.url && /^https?:\/\//i.test(String(payload.url)))
    return String(payload.url);
  if (payload.audio && /^https?:\/\//i.test(String(payload.audio)))
    return String(payload.audio);
  if (payload.audioUrl && /^https?:\/\//i.test(String(payload.audioUrl)))
    return String(payload.audioUrl);
  if (payload.downloadUrl && /^https?:\/\//i.test(String(payload.downloadUrl)))
    return String(payload.downloadUrl);
  if (payload.downloadURL && /^https?:\/\//i.test(String(payload.downloadURL)))
    return String(payload.downloadURL);
  if (payload.data) return extractCobaltDownloadURL(payload.data);
  if (payload.result) return extractCobaltDownloadURL(payload.result);
  var lists = [payload.picker, payload.files, payload.media];
  for (var i = 0; i < lists.length; i++) {
    var list = lists[i];
    if (!Array.isArray(list)) continue;
    for (var j = 0; j < list.length; j++) {
      var item = list[j];
      if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
      var nested = extractCobaltDownloadURL(item);
      if (nested) return nested;
    }
  }
  return "";
}

function outputExtensionFromCobalt(payload, downloadURL) {
  var candidates = [
    payload && payload.filename,
    payload && payload.name,
    payload && payload.title,
    downloadURL,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var text = String(candidates[i] || "").trim();
    var match = text.match(/\.([a-z0-9]{2,5})(?:[?#].*)?$/i);
    if (match) {
      var ext = match[1].toLowerCase();
      if (ext === "webm") return ".opus";
      if (ext === "m4a" || ext === "mp3" || ext === "opus") return "." + ext;
    }
  }
  return ".opus";
}

function isGoogleVideoURL(url) {
  try {
    var host = new URL(String(url || "")).hostname.toLowerCase();
    return host.indexOf("googlevideo.com") >= 0;
  } catch (e) {
    return false;
  }
}

function outputPathWithExtension(outputPath, extension) {
  var actualOutputPath = outputPath;
  var normalizedExt = String(extension || "").trim();
  if (!normalizedExt) return actualOutputPath;
  if (normalizedExt.charAt(0) !== ".") normalizedExt = "." + normalizedExt;

  var dotIdx = outputPath.lastIndexOf(".");
  if (dotIdx >= 0) {
    var currentExt = outputPath.substring(dotIdx).toLowerCase();
    if (currentExt !== normalizedExt) {
      actualOutputPath = outputPath.substring(0, dotIdx) + normalizedExt;
      L(
        "info",
        "[YTMusic] Corrected output extension:",
        currentExt,
        "->",
        normalizedExt,
      );
    }
  }
  return actualOutputPath;
}

function audioCodecForExtension(ext) {
  switch (String(ext || "").toLowerCase()) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".m4a":
    case ".mp4":
    case ".aac":
      return "aac";
    case ".mp3":
      return "mp3";
    case ".flac":
      return "flac";
    default:
      return "";
  }
}

// Build a successful download result that reports the ACTUAL container/codec
// of the written file. YouTube audio is typically Opus/AAC, never FLAC, so the
// host must not assume the requested .flac extension. Reporting the real
// extension lets the generic pipeline name the file and embed metadata with the
// correct format instead of treating Opus bytes as FLAC.
function buildDownloadSuccess(filePath, coverUrl) {
  var result = {
    success: true,
    file_path: filePath || "",
    cover_url: coverUrl || "",
    bit_depth: 0,
    sample_rate: 0,
  };

  var path = String(filePath || "");
  var dotIdx = path.lastIndexOf(".");
  if (dotIdx >= 0) {
    var ext = path.substring(dotIdx).toLowerCase();
    if (ext && ext.length <= 5) {
      result.actual_extension = ext;
      result.output_extension = ext;
      var codec = audioCodecForExtension(ext);
      if (codec) result.audio_codec = codec;
    }
  }

  return result;
}

function downloadAudioURL(
  downloadURL,
  outputPath,
  outputExtension,
  downloadOptions,
) {
  var actualOutputPath = outputPathWithExtension(outputPath, outputExtension);
  downloadOptions = downloadOptions || {};
  var options = {
    headers: {
      "User-Agent": downloadOptions.userAgent || getRandomUserAgent(),
    },
  };

  if (downloadOptions.referer)
    options.headers["Referer"] = downloadOptions.referer;
  if (downloadOptions.origin)
    options.headers["Origin"] = downloadOptions.origin;

  if (isGoogleVideoURL(downloadURL)) {
    options.chunked = true;
    options.chunkSize =
      downloadOptions.chunkSize || CONFIG.directAudioChunkSize;
  }

  return {
    path: actualOutputPath,
    result: file.download(downloadURL, actualOutputPath, options),
  };
}

function downloadErrorText(result) {
  if (!result) return "file.download returned null";
  return String(
    result.error || result.message || result.status || "download failed",
  );
}

function isDownloadAuthFailure(result) {
  var text = downloadErrorText(result).toLowerCase();
  return (
    text.indexOf("403") >= 0 ||
    text.indexOf("forbidden") >= 0 ||
    text.indexOf("unauthorized") >= 0 ||
    text.indexOf("range") >= 0 ||
    text.indexOf("http error") >= 0
  );
}

function attemptDirectCandidateDownload(candidate, outputPath, youtubeURL) {
  return downloadAudioURL(
    candidate.url,
    outputPath,
    candidate.extension || ".opus",
    {
      userAgent: candidate.ua || getRandomUserAgent(),
      referer: youtubeURL,
      origin: "https://www.youtube.com",
      chunkSize: CONFIG.directAudioChunkSize,
    },
  );
}

function cobaltErrorMessage(payload) {
  if (!payload) return "request failed";
  if (payload.error) {
    if (typeof payload.error === "string") return payload.error;
    if (payload.error.code) return String(payload.error.code);
    if (payload.error.message) return String(payload.error.message);
  }
  if (payload.message) return String(payload.message);
  if (payload.status) return String(payload.status);
  return "download URL missing";
}

function requestCobaltAudioDownload(youtubeURL) {
  var res = fetch(CONFIG.cobaltAudioURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": getAppUserAgent(),
    },
    body: JSON.stringify({
      url: youtubeURL,
      downloadMode: "audio",
      audioFormat: "best",
    }),
  });

  if (!res || !res.ok) {
    var status = res ? res.status : "no response";
    var errorPayload = null;
    try {
      errorPayload = res ? res.json() : null;
    } catch (e) {
      errorPayload = null;
    }
    throw new Error(
      "Cobalt audio returned " +
        status +
        ": " +
        cobaltErrorMessage(errorPayload),
    );
  }

  var payload;
  try {
    payload = res.json();
  } catch (e2) {
    payload = null;
  }
  var downloadURL = extractCobaltDownloadURL(payload);
  if (!downloadURL) {
    throw new Error("Cobalt audio failed: " + cobaltErrorMessage(payload));
  }

  return {
    url: downloadURL,
    extension: outputExtensionFromCobalt(payload, downloadURL),
  };
}

function makeSquareThumb(url) {
  var u = normalizeUrl(url);
  if (!u) return null;
  try {
    var replaced = u
      .replace(
        /=w\d+-h\d+/g,
        "=w" + CONFIG.thumbnailSize + "-h" + CONFIG.thumbnailSize,
      )
      .replace(/\/s\d+-c/g, "/s" + CONFIG.thumbnailSize + "-c");
    return normalizeUrl(replaced);
  } catch (e) {
    return null;
  }
}

function parseDurationText(t) {
  if (!t) return 0;
  var m = String(t).match(/(\d{1,2}:)?\d{1,2}:\d{2}|\d{1,2}:\d{2}/);
  if (!m) return 0;
  var parts = m[0].split(":").map(function (x) {
    return parseInt(x, 10);
  });
  if (
    parts.some(function (p) {
      return isNaN(p);
    })
  )
    return 0;
  var s = 0;
  for (var i = 0; i < parts.length; i++) s = s * 60 + parts[i];
  return s;
}

function extractVideoIdFromEndpoint(ep) {
  try {
    if (!ep) return null;
    if (ep.watchEndpoint && ep.watchEndpoint.videoId)
      return ep.watchEndpoint.videoId;
    if (
      ep.commandMetadata &&
      ep.commandMetadata.webCommandMetadata &&
      ep.commandMetadata.webCommandMetadata.url
    ) {
      var m = String(ep.commandMetadata.webCommandMetadata.url).match(
        /v=([^&]+)/,
      );
      if (m) return m[1];
    }
    if (ep.browseEndpoint && ep.browseEndpoint.browseId)
      return ep.browseEndpoint.browseId;
    return null;
  } catch (e) {
    return null;
  }
}

function extractBrowseInfoFromEndpoint(ep) {
  try {
    if (!ep) return null;
    if (ep.browseEndpoint && ep.browseEndpoint.browseId) {
      var browseId = ep.browseEndpoint.browseId;
      var type = "unknown";
      if (browseId.startsWith("MPREb_")) type = "album";
      else if (
        browseId.startsWith("VLPL") ||
        browseId.startsWith("VL") ||
        browseId.startsWith("PL")
      )
        type = "playlist";
      else if (browseId.startsWith("VLRDCLAK5uy_")) type = "playlist";
      else if (browseId.startsWith("UC")) type = "artist";
      return { browseId: browseId, type: type };
    }
    return null;
  } catch (e) {
    return null;
  }
}

function normalizeCandidate(info) {
  if (!info) return null;
  if (info.musicResponsiveListItemRenderer)
    return info.musicResponsiveListItemRenderer;
  if (info.musicTwoRowItemRenderer) return info.musicTwoRowItemRenderer;
  if (info.musicCardRenderer) return info.musicCardRenderer;
  if (info.videoRenderer) return info.videoRenderer;
  if (info.richItemRenderer && info.richItemRenderer.content)
    return info.richItemRenderer.content;
  if (info.playlistPanelVideoRenderer) return info.playlistPanelVideoRenderer;
  return info;
}

function pickLastThumbnailUrl(thumbnailObj) {
  try {
    if (!thumbnailObj) return null;
    if (Array.isArray(thumbnailObj)) {
      if (thumbnailObj.length === 0) return null;
      var last = thumbnailObj[thumbnailObj.length - 1];
      return last && last.url ? last.url : null;
    }
    if (
      thumbnailObj.thumbnails &&
      Array.isArray(thumbnailObj.thumbnails) &&
      thumbnailObj.thumbnails.length
    ) {
      var l = thumbnailObj.thumbnails[thumbnailObj.thumbnails.length - 1];
      return l && l.url ? l.url : null;
    }
    return null;
  } catch (e) {
    return null;
  }
}

function runsText(runs, separator) {
  if (!Array.isArray(runs)) return "";
  return runs
    .map(function (run) {
      return run && run.text ? String(run.text) : "";
    })
    .join(separator === undefined ? "" : separator)
    .trim();
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var value = String(values[i] || "").trim();
    var key = value.toLowerCase();
    if (!value || seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function findFirstRenderer(node, rendererKey, depth) {
  depth = depth || 0;
  if (!node || typeof node !== "object" || depth > 16) return null;
  if (
    Object.prototype.hasOwnProperty.call(node, rendererKey) &&
    node[rendererKey]
  ) {
    return node[rendererKey];
  }
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length; i++) {
      var arrayMatch = findFirstRenderer(node[i], rendererKey, depth + 1);
      if (arrayMatch) return arrayMatch;
    }
    return null;
  }
  for (var key in node) {
    if (
      !Object.prototype.hasOwnProperty.call(node, key) ||
      key === "trackingParams" ||
      key === "clickTrackingParams"
    )
      continue;
    var match = findFirstRenderer(node[key], rendererKey, depth + 1);
    if (match) return match;
  }
  return null;
}

function browsePageType(endpoint) {
  try {
    return String(
      endpoint.browseEndpointContextSupportedConfigs
        .browseEndpointContextMusicConfig.pageType || "",
    );
  } catch (e) {
    return "";
  }
}

function collectTrackReferences(node) {
  var result = {
    artists: [],
    album_id: "",
    album_name: "",
    credits_id: "",
  };
  var seenArtists = {};

  function visit(value, depth) {
    if (!value || typeof value !== "object" || depth > 14) return;
    if (value.browseEndpoint && value.browseEndpoint.browseId) {
      var endpoint = value.browseEndpoint;
      var browseId = String(endpoint.browseId);
      var pageType = browsePageType(endpoint);
      var text = value.__runText || "";
      if (
        (browseId.startsWith("UC") || pageType === "MUSIC_PAGE_TYPE_ARTIST") &&
        text
      ) {
        if (!seenArtists[browseId]) {
          seenArtists[browseId] = true;
          result.artists.push({ id: browseId, name: text });
        }
      } else if (
        (browseId.startsWith("MPREb_") ||
          pageType === "MUSIC_PAGE_TYPE_ALBUM") &&
        !result.album_id
      ) {
        result.album_id = browseId;
        result.album_name = text;
      } else if (
        (browseId.startsWith("MPTC") ||
          pageType === "MUSIC_PAGE_TYPE_TRACK_CREDITS") &&
        !result.credits_id
      ) {
        result.credits_id = browseId;
      }
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) visit(value[i], depth + 1);
      return;
    }
    for (var key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      var child = value[key];
      if (key === "navigationEndpoint" && child && typeof child === "object") {
        var decorated = Object.assign({}, child);
        if (typeof value.text === "string")
          decorated.__runText = value.text.trim();
        visit(decorated, depth + 1);
      } else if (key !== "trackingParams" && key !== "clickTrackingParams") {
        visit(child, depth + 1);
      }
    }
  }

  visit(node, 0);
  return result;
}

function hasExplicitBadge(node) {
  try {
    var badges = node && node.badges;
    if (!Array.isArray(badges)) return false;
    for (var i = 0; i < badges.length; i++) {
      var badge = badges[i] || {};
      var inline = badge.musicInlineBadgeRenderer || {};
      var metadata = badge.metadataBadgeRenderer || {};
      var iconType =
        (inline.icon && inline.icon.iconType) ||
        (metadata.icon && metadata.icon.iconType) ||
        "";
      var label =
        (inline.accessibilityData &&
          inline.accessibilityData.accessibilityData &&
          inline.accessibilityData.accessibilityData.label) ||
        metadata.label ||
        "";
      if (
        String(iconType).toUpperCase().indexOf("EXPLICIT") >= 0 ||
        String(label).toLowerCase() === "explicit"
      ) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

function parseItemExtended(info) {
  try {
    if (!info) return null;
    var c = normalizeCandidate(info);
    if (!c) return null;
    var references = collectTrackReferences(c);

    var title = null;
    if (c.flexColumns && Array.isArray(c.flexColumns)) {
      for (var fi = 0; fi < c.flexColumns.length; fi++) {
        var fc = c.flexColumns[fi];
        if (fc && fc.musicResponsiveListItemFlexColumnRenderer) {
          var fcr = fc.musicResponsiveListItemFlexColumnRenderer;
          if (fcr.text && fcr.text.runs && fcr.text.runs[0]) {
            if (!title) title = fcr.text.runs[0].text;
          }
        }
      }
    }

    if (
      !title &&
      c.title &&
      c.title.runs &&
      c.title.runs[0] &&
      c.title.runs[0].text
    )
      title = c.title.runs[0].text;
    if (!title && c.title && c.title.simpleText) title = c.title.simpleText;
    if (
      !title &&
      c.titleText &&
      c.titleText.runs &&
      c.titleText.runs[0] &&
      c.titleText.runs[0].text
    )
      title = c.titleText.runs[0].text;
    if (!title && c.name && c.name.simpleText) title = c.name.simpleText;
    if (!title && c.video && c.video.title) title = c.video.title;
    if (!title && c.header && c.header.title && c.header.title.runs)
      title = c.header.title.runs
        .map(function (r) {
          return r.text;
        })
        .join(" ");

    var artist = "";
    if (
      c.flexColumns &&
      Array.isArray(c.flexColumns) &&
      c.flexColumns.length > 1
    ) {
      var fc2 = c.flexColumns[1];
      if (fc2 && fc2.musicResponsiveListItemFlexColumnRenderer) {
        var fcr2 = fc2.musicResponsiveListItemFlexColumnRenderer;
        if (fcr2.text && fcr2.text.runs) {
          var artistParts = [];
          for (var ri = 0; ri < fcr2.text.runs.length; ri++) {
            var run = fcr2.text.runs[ri];
            if (run && run.text) {
              var txt = run.text.trim();
              if (txt === "•" || txt === " • " || txt === "," || txt === " & ")
                continue;
              var lowerTxt = txt.toLowerCase();
              if (
                lowerTxt === "single" ||
                lowerTxt === "album" ||
                lowerTxt === "ep" ||
                lowerTxt === "playlist" ||
                lowerTxt === "video" ||
                lowerTxt === "song"
              )
                continue;
              if (/^\d{4}$/.test(txt)) continue;
              if (
                /^\d+(\.\d+)?[KMB]?\s*(views|plays|listeners|subscribers|monthly audience)/i.test(
                  txt,
                )
              )
                continue;
              if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(txt)) continue;
              if (
                run.navigationEndpoint &&
                run.navigationEndpoint.browseEndpoint
              ) {
                var artistBrowse = run.navigationEndpoint.browseEndpoint;
                if (
                  String(artistBrowse.browseId || "").startsWith("UC") ||
                  browsePageType(artistBrowse) === "MUSIC_PAGE_TYPE_ARTIST"
                ) {
                  artistParts.push(txt);
                }
              } else if (!run.navigationEndpoint) {
                if (txt.length > 1) artistParts.push(txt);
              }
            }
          }
          artist = artistParts.join(", ");
        }
      }
    }

    if (!artist && c.subtitle && c.subtitle.runs) {
      var subtitleParts = [];
      for (var si = 0; si < c.subtitle.runs.length; si++) {
        var srun = c.subtitle.runs[si];
        if (srun && srun.text) {
          var stxt = srun.text.trim();
          if (stxt === "•" || stxt === " • " || stxt === "," || stxt === " & ")
            continue;
          var lowerStxt = stxt.toLowerCase();
          if (
            lowerStxt === "single" ||
            lowerStxt === "album" ||
            lowerStxt === "ep" ||
            lowerStxt === "playlist" ||
            lowerStxt === "video" ||
            lowerStxt === "song"
          )
            continue;
          if (/^\d{4}$/.test(stxt)) continue;
          // Skip view/play counts (e.g., "159M views", "1.1B plays", "241M plays")
          if (
            /^\d+(\.\d+)?[KMB]?\s*(views|plays|listeners|subscribers|monthly audience)/i.test(
              stxt,
            )
          )
            continue;
          // Skip duration format (e.g., "3:06", "10:45", "1:23:45")
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(stxt)) continue;
          if (
            srun.navigationEndpoint &&
            srun.navigationEndpoint.browseEndpoint
          ) {
            var subtitleBrowse = srun.navigationEndpoint.browseEndpoint;
            if (
              String(subtitleBrowse.browseId || "").startsWith("UC") ||
              browsePageType(subtitleBrowse) === "MUSIC_PAGE_TYPE_ARTIST"
            ) {
              subtitleParts.push(stxt);
            }
          } else if (stxt.length > 1) {
            subtitleParts.push(stxt);
          }
        }
      }
      artist = subtitleParts.join(", ");
    }
    if (!artist && c.longBylineText && c.longBylineText.runs)
      artist = c.longBylineText.runs
        .map(function (r) {
          return r.text;
        })
        .join(" ");
    if (!artist && c.ownerText && c.ownerText.runs)
      artist = c.ownerText.runs
        .map(function (r) {
          return r.text;
        })
        .join(" ");
    if (references.artists.length > 0) {
      artist = uniqueStrings(
        references.artists.map(function (item) {
          return item.name;
        }),
      ).join(", ");
    }

    if (!artist) {
      L("debug", "parseItemExtended: no artist found for", title);
    }

    var album = "";
    if (
      c.flexColumns &&
      Array.isArray(c.flexColumns) &&
      c.flexColumns.length > 1
    ) {
      var fc2 = c.flexColumns[1];
      if (fc2 && fc2.musicResponsiveListItemFlexColumnRenderer) {
        var fcr2 = fc2.musicResponsiveListItemFlexColumnRenderer;
        if (fcr2.text && fcr2.text.runs) {
          for (var ri = 0; ri < fcr2.text.runs.length; ri++) {
            var run = fcr2.text.runs[ri];
            if (
              run &&
              run.text &&
              run.navigationEndpoint &&
              run.navigationEndpoint.browseEndpoint
            ) {
              var browseId =
                run.navigationEndpoint.browseEndpoint.browseId || "";
              if (browseId.startsWith("MPREb_")) {
                album = run.text.trim();
                L(
                  "debug",
                  "parseItemExtended: found album from flexColumns",
                  album,
                );
                break;
              }
            }
          }
        }
      }
    }

    if (!album && c.subtitle && c.subtitle.runs) {
      for (var si = 0; si < c.subtitle.runs.length; si++) {
        var srun = c.subtitle.runs[si];
        if (
          srun &&
          srun.text &&
          srun.navigationEndpoint &&
          srun.navigationEndpoint.browseEndpoint
        ) {
          var sBrowseId = srun.navigationEndpoint.browseEndpoint.browseId || "";
          if (sBrowseId.startsWith("MPREb_")) {
            album = srun.text.trim();
            L("debug", "parseItemExtended: found album from subtitle", album);
            break;
          }
        }
      }
    }
    if (references.album_name) album = references.album_name;

    var videoId = null;
    if (c.playlistItemData && c.playlistItemData.videoId)
      videoId = c.playlistItemData.videoId;
    if (!videoId && c.videoId) videoId = c.videoId;
    if (
      !videoId &&
      c.overlay &&
      c.overlay.musicItemThumbnailOverlayRenderer &&
      c.overlay.musicItemThumbnailOverlayRenderer.content &&
      c.overlay.musicItemThumbnailOverlayRenderer.content
        .musicPlayButtonRenderer
    ) {
      var mpbr =
        c.overlay.musicItemThumbnailOverlayRenderer.content
          .musicPlayButtonRenderer;
      if (mpbr.playNavigationEndpoint)
        videoId = extractVideoIdFromEndpoint(mpbr.playNavigationEndpoint);
    }
    if (!videoId && c.navigationEndpoint)
      videoId = extractVideoIdFromEndpoint(c.navigationEndpoint);
    if (
      !videoId &&
      c.thumbnail &&
      c.thumbnail.musicThumbnailRenderer &&
      c.thumbnail.musicThumbnailRenderer.navigationEndpoint
    )
      videoId = extractVideoIdFromEndpoint(
        c.thumbnail.musicThumbnailRenderer.navigationEndpoint,
      );
    if (!videoId && c.video && c.video.videoId) videoId = c.video.videoId;

    if (!title || !videoId) {
      if (Math.random() < 0.1)
        L("debug", "parseItemExtended failed", {
          hasTitle: !!title,
          hasVideoId: !!videoId,
          keys: Object.keys(c).slice(0, 5),
        });
      return null;
    }
    var durationText = "";
    if (c.lengthText && c.lengthText.simpleText)
      durationText = c.lengthText.simpleText;
    // Watch-next queue rows (playlistPanelVideoRenderer) carry runs instead.
    if (!durationText && c.lengthText && c.lengthText.runs)
      durationText = runsText(c.lengthText.runs, "");
    if (
      !durationText &&
      c.thumbnailOverlays &&
      c.thumbnailOverlays[0] &&
      c.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer &&
      c.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.text &&
      c.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.text.simpleText
    ) {
      durationText =
        c.thumbnailOverlays[0].thumbnailOverlayTimeStatusRenderer.text
          .simpleText;
    }
    if (!durationText && c.badges && c.badges.length) {
      for (var bi = 0; bi < c.badges.length; bi++) {
        var b = c.badges[bi];
        if (b && b.metadataBadgeRenderer && b.metadataBadgeRenderer.label) {
          durationText = String(b.metadataBadgeRenderer.label);
          break;
        }
      }
    }
    if (!durationText && c.fixedColumns && Array.isArray(c.fixedColumns)) {
      for (var dfi = 0; dfi < c.fixedColumns.length; dfi++) {
        var dfc = c.fixedColumns[dfi];
        if (dfc && dfc.musicResponsiveListItemFixedColumnRenderer) {
          var dfcr = dfc.musicResponsiveListItemFixedColumnRenderer;
          if (
            dfcr.text &&
            dfcr.text.runs &&
            dfcr.text.runs[0] &&
            dfcr.text.runs[0].text
          ) {
            var possibleDuration = dfcr.text.runs[0].text.trim();
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(possibleDuration)) {
              durationText = possibleDuration;
              L(
                "debug",
                "parseItemExtended: found duration from fixedColumns",
                durationText,
              );
              break;
            }
          }
          if (!durationText && dfcr.text && dfcr.text.simpleText) {
            var possibleDuration2 = dfcr.text.simpleText.trim();
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(possibleDuration2)) {
              durationText = possibleDuration2;
              L(
                "debug",
                "parseItemExtended: found duration from fixedColumns simpleText",
                durationText,
              );
              break;
            }
          }
        }
      }
    }
    if (
      !durationText &&
      c.flexColumns &&
      Array.isArray(c.flexColumns) &&
      c.flexColumns.length > 1
    ) {
      var fc3 = c.flexColumns[1];
      if (fc3 && fc3.musicResponsiveListItemFlexColumnRenderer) {
        var fcr3 = fc3.musicResponsiveListItemFlexColumnRenderer;
        if (fcr3.text && fcr3.text.runs) {
          for (var dri = 0; dri < fcr3.text.runs.length; dri++) {
            var drun = fcr3.text.runs[dri];
            if (drun && drun.text) {
              var dtxt = drun.text.trim();
              if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(dtxt)) {
                durationText = dtxt;
                L(
                  "debug",
                  "parseItemExtended: found duration from flexColumns",
                  durationText,
                );
                break;
              }
            }
          }
        }
      }
    }
    var duration = parseDurationText(durationText);
    var thumbRaw = null;
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.thumbnail &&
          c.thumbnail.musicThumbnailRenderer &&
          c.thumbnail.musicThumbnailRenderer.thumbnail &&
          c.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) ||
          null,
      );
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl((c.thumbnail && c.thumbnail.thumbnails) || null);
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.video && c.video.thumbnail && c.video.thumbnail.thumbnails) || null,
      );
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.thumbnail &&
          c.thumbnail.thumbnail &&
          c.thumbnail.thumbnail.thumbnails) ||
          null,
      );
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.thumbnail && c.thumbnail.thumbnails && c.thumbnail.thumbnails) ||
          null,
      );
    if (!thumbRaw && c.fixedColumns) {
      for (var fi = 0; fi < c.fixedColumns.length; fi++) {
        var fc = c.fixedColumns[fi];
        if (
          fc &&
          fc.musicResponsiveListItemFixedColumnRenderer &&
          fc.musicResponsiveListItemFixedColumnRenderer.thumbnail
        ) {
          thumbRaw = pickLastThumbnailUrl(
            fc.musicResponsiveListItemFixedColumnRenderer.thumbnail.thumbnails,
          );
          if (thumbRaw) break;
        }
      }
    }
    var thumb = makeSquareThumb(thumbRaw);
    thumb = normalizeUrl(thumb) || null;
    return {
      id: String(videoId),
      title: String(title),
      artist: String(artist || ""),
      album: String(album || ""),
      album_artist: "",
      artist_id: references.artists.length ? references.artists[0].id : "",
      artist_url: references.artists.length
        ? "https://music.youtube.com/channel/" + references.artists[0].id
        : "",
      album_id: references.album_id,
      album_url: references.album_id
        ? "https://music.youtube.com/browse/" + references.album_id
        : "",
      external_urls: "https://music.youtube.com/watch?v=" + String(videoId),
      external_links: {
        youtube: "https://music.youtube.com/watch?v=" + String(videoId),
      },
      duration: Number(duration || 0),
      thumbnail: thumb,
      explicit: hasExplicitBadge(c),
      credits_id: references.credits_id || "MPTC" + String(videoId),
      source: "youtube",
      item_type: "track",
    };
  } catch (e) {
    L("warn", "parseItemExtended error", String(e));
    return null;
  }
}

function parseCollectionItem(info) {
  try {
    if (!info) return null;
    var c = normalizeCandidate(info);
    if (!c) return null;

    var browseInfo = null;
    if (c.navigationEndpoint) {
      browseInfo = extractBrowseInfoFromEndpoint(c.navigationEndpoint);
    }
    if (
      !browseInfo &&
      c.overlay &&
      c.overlay.musicItemThumbnailOverlayRenderer
    ) {
      var overlay = c.overlay.musicItemThumbnailOverlayRenderer;
      if (
        overlay.content &&
        overlay.content.musicPlayButtonRenderer &&
        overlay.content.musicPlayButtonRenderer.playNavigationEndpoint
      ) {
        browseInfo = extractBrowseInfoFromEndpoint(
          overlay.content.musicPlayButtonRenderer.playNavigationEndpoint,
        );
      }
    }

    // Only process albums, playlists, and artists
    if (
      !browseInfo ||
      (browseInfo.type !== "album" &&
        browseInfo.type !== "playlist" &&
        browseInfo.type !== "artist")
    ) {
      return null;
    }

    // Extract title
    var title = null;
    if (c.flexColumns && Array.isArray(c.flexColumns)) {
      for (var fi = 0; fi < c.flexColumns.length; fi++) {
        var fc = c.flexColumns[fi];
        if (fc && fc.musicResponsiveListItemFlexColumnRenderer) {
          var fcr = fc.musicResponsiveListItemFlexColumnRenderer;
          if (fcr.text && fcr.text.runs && fcr.text.runs[0]) {
            if (!title) title = fcr.text.runs[0].text;
          }
        }
      }
    }
    if (!title && c.title && c.title.runs && c.title.runs[0])
      title = c.title.runs[0].text;
    if (!title && c.title && c.title.simpleText) title = c.title.simpleText;

    var subtitle = "";
    var albumType = browseInfo.type === "album" ? "album" : "playlist";
    var year = "";
    var artist = "";

    if (
      c.flexColumns &&
      Array.isArray(c.flexColumns) &&
      c.flexColumns.length > 1
    ) {
      var fc2 = c.flexColumns[1];
      if (fc2 && fc2.musicResponsiveListItemFlexColumnRenderer) {
        var fcr2 = fc2.musicResponsiveListItemFlexColumnRenderer;
        if (fcr2.text && fcr2.text.runs) {
          subtitle = fcr2.text.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
      }
    }
    if (!subtitle && c.subtitle && c.subtitle.runs) {
      subtitle = c.subtitle.runs
        .map(function (r) {
          return r.text;
        })
        .join("");
    }

    if (subtitle) {
      var parts = subtitle.split(" • ");
      if (parts.length >= 1) {
        var typeStr = parts[0].toLowerCase().trim();
        if (typeStr === "album" || typeStr === "single" || typeStr === "ep") {
          albumType = typeStr === "ep" ? "ep" : typeStr;
        } else if (typeStr === "playlist") {
          albumType = "playlist";
        }
      }
      if (parts.length >= 2) {
        artist = parts[1].trim();
      }
      if (parts.length >= 3) {
        var maybeYear = parts[2].trim();
        if (/^\d{4}$/.test(maybeYear)) {
          year = maybeYear;
        }
      }
    }

    var thumbRaw = null;
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.thumbnail &&
          c.thumbnail.musicThumbnailRenderer &&
          c.thumbnail.musicThumbnailRenderer.thumbnail &&
          c.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) ||
          null,
      );
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl((c.thumbnail && c.thumbnail.thumbnails) || null);
    thumbRaw =
      thumbRaw ||
      pickLastThumbnailUrl(
        (c.thumbnailRenderer &&
          c.thumbnailRenderer.musicThumbnailRenderer &&
          c.thumbnailRenderer.musicThumbnailRenderer.thumbnail &&
          c.thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails) ||
          null,
      );
    if (!thumbRaw && c.thumbnail && c.thumbnail.musicThumbnailRenderer) {
      var mtr = c.thumbnail.musicThumbnailRenderer;
      if (mtr.thumbnail && mtr.thumbnail.thumbnails) {
        thumbRaw = pickLastThumbnailUrl(mtr.thumbnail.thumbnails);
      }
    }
    var thumb = makeSquareThumb(thumbRaw);
    thumb = normalizeUrl(thumb) || null;
    L("debug", "parseCollectionItem thumbnail", {
      id: browseInfo ? browseInfo.browseId : "null",
      thumbRaw: thumbRaw,
      thumb: thumb,
    });

    if (!title || !browseInfo.browseId) {
      return null;
    }

    // Determine item_type
    var itemType = "album";
    if (browseInfo.type === "playlist") itemType = "playlist";
    else if (browseInfo.type === "artist") itemType = "artist";

    L("info", "parseCollectionItem returning", {
      id: browseInfo.browseId,
      title: title,
      item_type: itemType,
      browseType: browseInfo.type,
    });

    return {
      id: browseInfo.browseId,
      title: String(title),
      artist: String(artist || ""),
      album_type: browseInfo.type === "artist" ? "artist" : albumType,
      year: year,
      thumbnail: thumb,
      item_type: itemType,
      source: "youtube",
    };
  } catch (e) {
    L("warn", "parseCollectionItem error", String(e));
    return null;
  }
}

function parseArtistCardShelf(info) {
  try {
    if (!info || !info.musicCardShelfRenderer) return null;
    var c = info.musicCardShelfRenderer;

    var title = null;
    if (c.title && c.title.runs && c.title.runs[0]) {
      title = c.title.runs[0].text;
    }

    var browseId = null;
    if (
      c.title &&
      c.title.runs &&
      c.title.runs[0] &&
      c.title.runs[0].navigationEndpoint
    ) {
      var navEp = c.title.runs[0].navigationEndpoint;
      if (navEp.browseEndpoint && navEp.browseEndpoint.browseId) {
        browseId = navEp.browseEndpoint.browseId;
      }
    }
    // Alternative: check onTap or buttons
    if (!browseId && c.onTap && c.onTap.browseEndpoint) {
      browseId = c.onTap.browseEndpoint.browseId;
    }
    if (!browseId && c.buttons && c.buttons.length > 0) {
      for (var bi = 0; bi < c.buttons.length; bi++) {
        var btn = c.buttons[bi];
        if (
          btn &&
          btn.buttonRenderer &&
          btn.buttonRenderer.navigationEndpoint &&
          btn.buttonRenderer.navigationEndpoint.browseEndpoint
        ) {
          browseId =
            btn.buttonRenderer.navigationEndpoint.browseEndpoint.browseId;
          break;
        }
      }
    }

    // Check if this is an artist (browseId starts with UC)
    if (!browseId || !browseId.startsWith("UC")) {
      return null;
    }

    if (!title) return null;

    // Extract subtitle (e.g., "45M monthly audience")
    var subtitle = "";
    if (c.subtitle && c.subtitle.runs) {
      subtitle = c.subtitle.runs
        .map(function (r) {
          return r.text;
        })
        .join("");
    }

    var thumbRaw = null;
    if (
      c.thumbnail &&
      c.thumbnail.musicThumbnailRenderer &&
      c.thumbnail.musicThumbnailRenderer.thumbnail
    ) {
      thumbRaw = pickLastThumbnailUrl(
        c.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
      );
    }
    var thumb = makeSquareThumb(thumbRaw);
    thumb = normalizeUrl(thumb) || null;

    L("info", "parseArtistCardShelf found artist", {
      id: browseId,
      name: title,
      subtitle: subtitle,
    });

    return {
      id: browseId,
      title: String(title),
      artist: String(title), // For artists, artist name is the title
      thumbnail: thumb,
      item_type: "artist",
      album_type: "artist",
      source: "youtube",
    };
  } catch (e) {
    L("warn", "parseArtistCardShelf error", String(e));
    return null;
  }
}

function parseSearchItem(info) {
  if (info && info.musicCardShelfRenderer) {
    var artistCard = parseArtistCardShelf(info);
    if (artistCard) return artistCard;
  }

  var collection = parseCollectionItem(info);
  if (collection) return collection;

  return parseItemExtended(info);
}

var COLLECT_ITEMS_MAX = 5000;

function collectItemsFromNode(node, out, depth) {
  depth = depth || 0;
  // Prevent infinite recursion - max depth 20
  if (depth > 20) return;
  // Safety exit with high cap (was 100, now 5000)
  if (out.length >= COLLECT_ITEMS_MAX) return;

  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (var i = 0; i < node.length && out.length < COLLECT_ITEMS_MAX; i++)
      collectItemsFromNode(node[i], out, depth + 1);
    return;
  }
  if (
    node.videoRenderer ||
    node.musicResponsiveListItemRenderer ||
    node.musicTwoRowItemRenderer ||
    node.musicCardRenderer ||
    (node.richItemRenderer && node.richItemRenderer.content) ||
    node.playlistPanelVideoRenderer ||
    node.musicCardShelfRenderer
  ) {
    out.push(node);
  }
  for (var k in node) {
    if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
    if (out.length >= COLLECT_ITEMS_MAX) break;
    var v = node[k];
    if (!v) continue;
    if (Array.isArray(v)) {
      for (var ai = 0; ai < v.length && out.length < COLLECT_ITEMS_MAX; ai++)
        collectItemsFromNode(v[ai], out, depth + 1);
    } else if (typeof v === "object") {
      collectItemsFromNode(v, out, depth + 1);
    }
  }
}

function collectAlbumTracksOnly(data, out, continuationInfo) {
  if (!data || typeof data !== "object") return;

  var shelfFound = false;

  // Helper to extract continuation token from a shelf renderer
  function extractContinuation(shelfNode) {
    if (!continuationInfo) return;
    try {
      var conts = shelfNode.continuations;
      if (Array.isArray(conts)) {
        for (var ci = 0; ci < conts.length; ci++) {
          var c = conts[ci];
          if (
            c &&
            c.nextContinuationData &&
            c.nextContinuationData.continuation
          ) {
            continuationInfo.token = c.nextContinuationData.continuation;
            L("debug", "collectAlbumTracksOnly: found continuation token");
            return;
          }
          if (
            c &&
            c.reloadContinuationData &&
            c.reloadContinuationData.continuation
          ) {
            continuationInfo.token = c.reloadContinuationData.continuation;
            L(
              "debug",
              "collectAlbumTracksOnly: found reload continuation token",
            );
            return;
          }
        }
      }
    } catch (e) {
      L("debug", "extractContinuation error", String(e));
    }
  }

  function findFirstShelf(node, depth) {
    if (shelfFound || depth > 15) return;
    if (!node || typeof node !== "object") return;

    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        findFirstShelf(node[i], depth + 1);
        if (shelfFound) return;
      }
      return;
    }

    // Helper to extract continuation token from items in a contents array
    // YouTube Music API often puts continuationItemRenderer at the end of contents
    function extractContinuationFromContents(contents) {
      if (!continuationInfo) return;
      for (
        var ci = contents.length - 1;
        ci >= 0 && ci >= contents.length - 3;
        ci--
      ) {
        var item = contents[ci];
        if (item && item.continuationItemRenderer) {
          var ep = item.continuationItemRenderer.continuationEndpoint;
          if (ep && ep.continuationCommand && ep.continuationCommand.token) {
            continuationInfo.token = ep.continuationCommand.token;
            L(
              "debug",
              "collectAlbumTracksOnly: found continuation token from continuationItemRenderer",
            );
            return;
          }
        }
      }
    }

    // PRIORITY 1: musicPlaylistShelfRenderer (YouTube Music playlists use this)
    if (
      node.musicPlaylistShelfRenderer &&
      node.musicPlaylistShelfRenderer.contents
    ) {
      shelfFound = true;
      var plShelf = node.musicPlaylistShelfRenderer;
      var contents = plShelf.contents;
      for (var i = 0; i < contents.length; i++) {
        var item = contents[i];
        if (item.musicResponsiveListItemRenderer) {
          out.push(item);
        }
      }
      // Try shelf-level continuations first, then check contents for continuationItemRenderer
      extractContinuation(plShelf);
      if (!continuationInfo || !continuationInfo.token) {
        extractContinuationFromContents(contents);
      }
      L(
        "debug",
        "collectAlbumTracksOnly: found musicPlaylistShelfRenderer with",
        contents.length,
        "items, continuation:",
        continuationInfo ? !!continuationInfo.token : "n/a",
      );
      return;
    }

    // PRIORITY 2: musicShelfRenderer (albums and some other views)
    if (node.musicShelfRenderer && node.musicShelfRenderer.contents) {
      shelfFound = true;
      var shelf = node.musicShelfRenderer;
      var contents = shelf.contents;
      for (var i = 0; i < contents.length; i++) {
        var item = contents[i];
        if (item.musicResponsiveListItemRenderer) {
          out.push(item);
        }
      }
      extractContinuation(shelf);
      if (!continuationInfo || !continuationInfo.token) {
        extractContinuationFromContents(contents);
      }
      return;
    }

    // PRIORITY 3: playlistPanelRenderer (radio/auto playlists)
    if (node.playlistPanelRenderer && node.playlistPanelRenderer.contents) {
      shelfFound = true;
      var panel = node.playlistPanelRenderer;
      var contents = panel.contents;
      for (var i = 0; i < contents.length; i++) {
        var item = contents[i];
        if (item.playlistPanelVideoRenderer) {
          out.push(item);
        }
      }
      extractContinuation(panel);
      if (!continuationInfo || !continuationInfo.token) {
        extractContinuationFromContents(contents);
      }
      return;
    }

    for (var k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (shelfFound) return;
      var v = node[k];
      if (v && typeof v === "object") {
        findFirstShelf(v, depth + 1);
      }
    }
  }

  findFirstShelf(data, 0);
  L(
    "debug",
    "collectAlbumTracksOnly found",
    out.length,
    "tracks, shelfFound:",
    shelfFound,
  );
}

function parseSearchResponseExtended(data) {
  try {
    if (!data || typeof data !== "object") return [];
    var rootCandidates = [];

    if (data.contents && data.contents.tabbedSearchResultsRenderer) {
      var tabs = data.contents.tabbedSearchResultsRenderer.tabs;
      if (Array.isArray(tabs)) {
        for (var ti = 0; ti < tabs.length; ti++) {
          var tab = tabs[ti];
          if (tab && tab.tabRenderer && tab.tabRenderer.content) {
            collectItemsFromNode(tab.tabRenderer.content, rootCandidates);
          }
        }
      }
    }

    if (data.contents && data.contents.sectionListRenderer) {
      collectItemsFromNode(data.contents.sectionListRenderer, rootCandidates);
    }

    if (Array.isArray(data.onResponseReceivedCommands)) {
      data.onResponseReceivedCommands.forEach(function (cmd) {
        if (cmd && typeof cmd === "object") {
          if (
            cmd.appendContinuationItemsAction &&
            cmd.appendContinuationItemsAction.continuationItems
          ) {
            collectItemsFromNode(
              cmd.appendContinuationItemsAction.continuationItems,
              rootCandidates,
            );
          }
          collectItemsFromNode(cmd, rootCandidates);
        }
      });
    }
    if (data.onResponseReceivedActions)
      collectItemsFromNode(data.onResponseReceivedActions, rootCandidates);
    if (data.contents) collectItemsFromNode(data.contents, rootCandidates);
    if (data.results) collectItemsFromNode(data.results, rootCandidates);

    // Only do full tree scan if we found nothing
    if (rootCandidates.length === 0) {
      collectItemsFromNode(data, rootCandidates);
    }

    L("debug", "parseSearchResponseExtended candidates", rootCandidates.length);

    var results = [];
    for (var i = 0; i < rootCandidates.length; i++) {
      var node = rootCandidates[i];
      var possible =
        node.musicResponsiveListItemRenderer ||
        node.musicTwoRowItemRenderer ||
        node.musicCardRenderer ||
        (node.richItemRenderer && node.richItemRenderer.content) ||
        node.videoRenderer ||
        node;
      // Parse both tracks and collections (albums/playlists)
      var parsed = parseSearchItem(possible);
      if (parsed) results.push(parsed);
    }
    var seen = {};
    var deduped = [];
    for (var r = 0; r < results.length; r++) {
      var item = results[r];
      if (!item || !item.id) continue;
      if (!seen[item.id]) {
        seen[item.id] = true;
        deduped.push(item);
        if (deduped.length >= CONFIG.maxResults) break;
      }
    }
    return deduped;
  } catch (e) {
    L("error", "parseSearchResponseExtended fatal", String(e));
    return [];
  }
}

var URL_KEY_RE = /url|uri|link|cover|download|thumbnail/i;

function stripUrlLikeFields(obj) {
  var out = {};
  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    var v = obj[k];
    if (k === "external_links" && v && typeof v === "object") {
      var safeLinks = {};
      for (var provider in v) {
        if (!Object.prototype.hasOwnProperty.call(v, provider)) continue;
        if (isString(v[provider]) && isAbsoluteHttpUrl(v[provider])) {
          safeLinks[provider] = normalizeUrl(v[provider]);
        }
      }
      out[k] = safeLinks;
    } else if (URL_KEY_RE.test(k)) {
      if (isString(v) && isAbsoluteHttpUrl(v)) {
        out[k] = normalizeUrl(v);
      } else {
        out[k] = null;
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

function sanitizeTrackBeforeReturn(t) {
  if (!t || typeof t !== "object") return null;
  var id = t.id ? String(t.id).trim() : "";
  if (!id) return null;

  // If this is a collection (album/playlist/artist), use different sanitization
  if (
    t.item_type === "album" ||
    t.item_type === "playlist" ||
    t.item_type === "artist"
  ) {
    return sanitizeCollectionBeforeReturn(t);
  }

  var title = t.title ? String(t.title).trim() : "Unknown title";
  var artist = t.artist ? String(t.artist).trim() : "";
  var thumbCandidate = t.thumbnail || t.coverUrl || null;
  var thumb = normalizeUrl(thumbCandidate) || null;

  var sanitized = {
    id: id,
    name: title, // Mornye expects 'name' not 'title'
    artists: artist, // Mornye expects 'artists' not 'artist'
    album_name: t.album ? String(t.album).trim() : "",
    album_artist: String(t.album_artist || "").trim(),
    artist_id: String(t.artist_id || "").trim(),
    artist_url: String(t.artist_url || "").trim(),
    album_id: String(t.album_id || "").trim(),
    album_url: String(t.album_url || "").trim(),
    external_urls: String(
      t.external_urls || "https://music.youtube.com/watch?v=" + id,
    ).trim(),
    external_links: Object.assign(
      { youtube: "https://music.youtube.com/watch?v=" + id },
      t.external_links || {},
    ),
    duration_ms: (Number(t.duration || 0) || 0) * 1000, // Convert seconds to ms
    cover_url: thumb, // Mornye expects 'cover_url' not 'thumbnail'
    track_number: Number(t.track_number || 0) || 0,
    total_tracks: Number(t.total_tracks || 0) || 0,
    disc_number: Number(t.disc_number || 0) || 0,
    total_discs: Number(t.total_discs || 0) || 0,
    release_date: String(t.release_date || "").trim(),
    album_type: String(t.album_type || "").trim(),
    isrc: String(t.isrc || "").trim(),
    upc: String(t.upc || "").trim(),
    label: String(t.label || "").trim(),
    copyright: String(t.copyright || "").trim(),
    genre: String(t.genre || "").trim(),
    composer: String(t.composer || "").trim(),
    preview_url: String(t.preview_url || "").trim(),
    explicit: t.explicit === true,
    provider_id: "ytmusic-spotiflac",
    item_type: "track",
  };
  cacheSet("yt:video:" + id, sanitized);
  return sanitized;
}

// Album and playlist browse responses share the same parser, but their
// collection headers have different semantics. An album header describes
// every track's release; a playlist header does not. Preserve album metadata
// parsed from each playlist row (or leave it empty) instead of replacing it
// with the playlist title/owner.
function applyBrowseCollectionMetadata(parsed, collection, isPlaylist) {
  if (!parsed || !collection || isPlaylist) return parsed;
  if (collection.name) parsed.album = collection.name;
  parsed.album_id = collection.id || parsed.album_id || "";
  parsed.album_url = parsed.album_id
    ? "https://music.youtube.com/browse/" + parsed.album_id
    : "";
  parsed.album_artist = collection.artists || parsed.album_artist || "";
  parsed.release_date = collection.release_date || parsed.release_date || "";
  parsed.album_type = collection.album_type || parsed.album_type || "album";
  parsed.total_tracks = collection.total_tracks || parsed.total_tracks || 0;
  if (!parsed.thumbnail && collection.cover_url)
    parsed.thumbnail = collection.cover_url;
  if (!parsed.artist && collection.artists) {
    parsed.artist = collection.artists;
  }
  if (!parsed.artist_id && collection.artist_id) {
    parsed.artist_id = collection.artist_id;
    parsed.artist_url =
      "https://music.youtube.com/channel/" + collection.artist_id;
  }
  if (!parsed.disc_number) parsed.disc_number = 1;
  if (!parsed.total_discs) parsed.total_discs = 1;
  return parsed;
}

function resolveDownloadCoverUrl(videoID) {
  var cached = cacheGet("yt:video:" + String(videoID || ""));
  var cover =
    cached && (cached.cover_url || cached.coverUrl || cached.thumbnail);
  var normalized = normalizeUrl(cover);
  if (normalized) return normalized;
  if (/^[A-Za-z0-9_-]{11}$/.test(String(videoID || ""))) {
    return (
      "https://i.ytimg.com/vi/" +
      encodeURIComponent(String(videoID)) +
      "/hqdefault.jpg"
    );
  }
  return null;
}

// Sanitize album/playlist collection for return
function sanitizeCollectionBeforeReturn(t) {
  if (!t || typeof t !== "object") return null;
  var id = t.id ? String(t.id).trim() : "";
  if (!id) return null;

  var title = t.title ? String(t.title).trim() : "Unknown";
  var artist = t.artist ? String(t.artist).trim() : "";
  var thumbCandidate = t.thumbnail || t.coverUrl || null;
  var thumb = normalizeUrl(thumbCandidate) || null;

  var finalItemType = t.item_type || "album";
  L("info", "sanitizeCollectionBeforeReturn", {
    id: id,
    name: title,
    input_item_type: t.item_type,
    final_item_type: finalItemType,
  });

  return {
    id: id,
    name: title,
    artists: artist,
    album_name: title,
    album_type:
      t.album_type || (t.item_type === "playlist" ? "playlist" : "album"),
    release_date: t.year || "",
    cover_url: thumb,
    provider_id: "ytmusic-spotiflac",
    item_type: finalItemType,
  };
}

async function performSearchAsync(query, searchParams) {
  var url = "https://music.youtube.com/youtubei/v1/search?alt=json";
  var requestBody = {
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: CONFIG.clientVersion },
    },
    query: String(query || ""),
  };
  if (searchParams) {
    requestBody.params = searchParams;
  }
  var body = JSON.stringify(requestBody);
  L("info", "performSearch fetch start", query);
  var res;
  try {
    res = await safeFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible)",
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: body,
    });
  } catch (e) {
    L("warn", "performSearch safeFetch failed", String(e));
    return [];
  }
  L("debug", "performSearch http status", res.status);
  var rawText = "";
  try {
    rawText = await res.text();
    L(
      "debug",
      "performSearch raw text head",
      rawText.slice(0, CONFIG.debugRawJsonHead),
    );
  } catch (e) {
    L("warn", "performSearch read text failed", String(e));
    return [];
  }
  var data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    L("error", "performSearch json parse failed", String(e));
    return [];
  }
  var parsed = parseSearchResponseExtended(data);
  L("info", "performSearch parsed results", parsed.length);
  return parsed;
}

// YouTube Music InnerTube search filter params (server-side filtering)
var YT_SEARCH_PARAMS = {
  tracks: "EgWKAQIIAQ%3D%3D", // Songs only
  videos: "EgWKAQIQAQ%3D%3D", // Videos only
  albums: "EgWKAQIYAQ%3D%3D", // Albums only
  artists: "EgWKAQIgAQ%3D%3D", // Artists only
  playlists: "EgWKAQIoAQ%3D%3D", // Community playlists only
};

function performSearchSync(query, searchParams) {
  var url = "https://music.youtube.com/youtubei/v1/search?alt=json";
  var requestBody = {
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: CONFIG.clientVersion },
    },
    query: String(query || ""),
  };
  if (searchParams) {
    requestBody.params = searchParams;
  }
  var body = JSON.stringify(requestBody);

  L("info", "performSearchSync fetch start", query);

  var res;
  try {
    res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible)",
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: body,
    });
  } catch (e) {
    L("error", "performSearchSync fetch failed", String(e));
    return [];
  }

  if (!res || !res.ok) {
    L(
      "error",
      "performSearchSync bad response",
      res ? res.status : "no response",
    );
    return [];
  }

  L("debug", "performSearchSync http status", res.status);

  var data;
  try {
    data = res.json();
  } catch (e) {
    L("error", "performSearchSync json parse failed", String(e));
    return [];
  }

  var parsed = parseSearchResponseExtended(data);
  L("info", "performSearchSync parsed results", parsed.length);
  return parsed;
}

function customSearchSync(query, options) {
  var filter = (options && options.filter) || null;
  var isFiltered = filter && filter !== "all";

  // Cache key includes filter for filtered searches
  var key =
    "yt:search:" + String(query || "") + (isFiltered ? ":" + filter : "");
  var cached = cacheGet(key);
  if (cached) {
    L(
      "info",
      "customSearch returning cached",
      query,
      cached.length,
      "filter:",
      filter || "all",
    );
    return cached;
  }

  try {
    // Use server-side filter params when available (more accurate than local filtering)
    var searchParams = isFiltered ? YT_SEARCH_PARAMS[filter] || null : null;
    var results = performSearchSync(query, searchParams);
    if (Array.isArray(results) && results.length > 0) {
      var sanitized = results
        .map(sanitizeTrackBeforeReturn)
        .filter(function (x) {
          return !!x;
        })
        .map(stripUrlLikeFields);

      // Apply local filter as fallback (in case server-side filter missed some)
      if (isFiltered && sanitized.length > 0) {
        sanitized = sanitized.filter(function (item) {
          if (filter === "tracks") return item.item_type === "track";
          if (filter === "albums") return item.item_type === "album";
          if (filter === "artists") return item.item_type === "artist";
          if (filter === "playlists") return item.item_type === "playlist";
          return true;
        });
        L(
          "info",
          "customSearch filtered to",
          filter,
          ":",
          sanitized.length,
          "items",
        );
      }

      if (sanitized.length > 0) {
        cacheSet(key, sanitized);
        L(
          "info",
          "customSearch returning results",
          query,
          sanitized.length,
          "filter:",
          filter || "all",
        );
        return sanitized;
      }
    }
    L("info", "customSearch no results", query, "filter:", filter || "all");
    return [];
  } catch (e) {
    L("error", "customSearch failed", String(e));
    return [];
  }
}

// ---- Related tracks (watch-next radio queue) ----

var RELATED_MAX_SEEDS = 5;
var RELATED_DURATION_TOLERANCE_MS = 15000;

function stripTrackTitleAnnotations(value) {
  return String(value || "").replace(/[(\[]\s*(?:(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+|from\s+["“][^)\]]+["”]\s*)[)\]]/gi, function(annotation) {
    if (/^[(\[]\s*with\b/i.test(annotation) &&
        /\b(?:mix|remix|live|acoustic|demo|instrumental|karaoke|edit|extended|slowed|sped)\b/i.test(annotation)) {
      return annotation;
    }
    return " ";
  });
}

function downloadMatchValue(value) {
  return String(value || "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9\u0080-\uffff]+/g, " ").replace(/\s+/g, " ").trim();
}

function downloadTextScript(value) {
  var text = String(value || "");
  return {
    latin: /[A-Za-z]/.test(text),
    nonLatin: /[\u0370-\u052f\u0590-\u08ff\u0900-\u1fff\u2c00-\ud7ff\uf900-\ufaff]/.test(text),
  };
}

function downloadArtistsUseDifferentScripts(expected, found) {
  var left = downloadTextScript(expected);
  var right = downloadTextScript(found);
  return (left.latin && right.nonLatin && !right.latin) ||
    (right.latin && left.nonLatin && !left.latin);
}

function downloadCandidateTitleParts(value) {
  var text = String(value || "").trim();
  var parts = { title: text, creditedArtist: "" };
  var slash = text.indexOf("/");
  var openingParenthesis = text.indexOf("(");
  if (slash > 0 && slash < text.length - 1 &&
      (openingParenthesis < 0 || slash < openingParenthesis)) {
    parts.creditedArtist = text.slice(0, slash).trim();
    parts.title = text.slice(slash + 1).trim();
  }
  return parts;
}

function downloadTitleWithoutAlbumSuffix(trackName, albumName) {
  var title = String(trackName || "").trim();
  var albumKey = downloadMatchValue(albumName).replace(/\s+disc\s+\d+$/i, "").trim();
  if (!title || !albumKey) return title;
  var separator = " - ";
  var offset = title.indexOf(separator);
  while (offset >= 0) {
    var suffix = title.slice(offset + separator.length).trim();
    if (downloadMatchValue(suffix) === albumKey) {
      return title.slice(0, offset).trim();
    }
    offset = title.indexOf(separator, offset + separator.length);
  }
  // Some Spotify catalog rows append the album directly after a quoted mix
  // name without a dash, e.g. `appears - "JP's SoundFactory Mix" LOVEppears
  // / appears -20th Anniversary Edition-`. Compare every word boundary to
  // the exact normalized album metadata instead of guessing a delimiter.
  for (offset = 1; offset < title.length; offset++) {
    if (!/\s/.test(title.charAt(offset - 1))) continue;
    var directSuffix = title.slice(offset).trim();
    if (downloadMatchValue(directSuffix) === albumKey) {
      return title.slice(0, offset).replace(/\s+[-–—]?\s*$/, "").trim();
    }
  }
  if (title.endsWith(")")) {
    offset = title.indexOf(" (");
    while (offset >= 0) {
      var parenthesizedSuffix = title.slice(offset + 2, -1).trim();
      if (downloadMatchValue(parenthesizedSuffix) === albumKey) {
        return title.slice(0, offset).trim();
      }
      offset = title.indexOf(" (", offset + 2);
    }
  }
  return title;
}

function downloadBilingualEditionTitleMatches(expectedKey, candidateTitle, durationClose, albumName) {
  if (!expectedKey || !durationClose) return false;
  var text = String(candidateTitle || "").trim();
  var separator = text.indexOf(" - ");
  if (separator <= 0 || separator >= text.length - 3) return false;
  var nativeHalf = text.slice(0, separator).trim();
  var translatedHalf = text.slice(separator + 3).trim();
  if (!albumName &&
      downloadMatchValue(stripTrackTitleAnnotations(nativeHalf)) !== expectedKey) return false;

  // YouTube Music sometimes appends a Romanized title after a native title,
  // repeating the edition in both halves, for example:
  // オヒアの木 (A BALLADS 2) - Ohianoki (A BALLADS 2)
  // Require that repeated qualifier so ordinary Live/Remix/Karaoke suffixes
  // cannot be discarded as if they were only a translation.
  var edition = nativeHalf.match(/\(([^()]+)\)\s*$/);
  if (!edition) return false;
  var editionKey = downloadMatchValue(edition[1]);
  var translatedKey = downloadMatchValue(translatedHalf);
  if (!editionKey || (" " + translatedKey + " ").indexOf(" " + editionKey + " ") < 0) return false;
  var nativeKey = downloadMatchValue(stripTrackTitleAnnotations(
    downloadTitleWithoutAlbumSuffix(nativeHalf, albumName),
  ));
  var translatedTitleKey = downloadMatchValue(stripTrackTitleAnnotations(
    downloadTitleWithoutAlbumSuffix(translatedHalf, albumName),
  ));
  if (albumName && nativeKey !== expectedKey && translatedTitleKey !== expectedKey) return false;
  var nativeScript = downloadTextScript(nativeHalf);
  var translatedScript = downloadTextScript(translatedHalf);
  return (nativeScript.nonLatin && translatedScript.latin) ||
    (albumName && translatedTitleKey === expectedKey);
}

function downloadRecordingMatches(trackName, artistName, durationMs, candidate, albumName) {
  var expectedTitle = downloadTitleWithoutAlbumSuffix(trackName, albumName);
  var titleKey = downloadMatchValue(stripTrackTitleAnnotations(expectedTitle));
  var candidateTitle = downloadCandidateTitleParts(candidate.name || candidate.title);
  // Search results produced by parseItemExtended use `artist` and a duration
  // in seconds. Sanitized/API-shaped tracks use `artists` and duration_ms.
  // Accept both shapes so availability checks validate the data that the
  // production search parser actually returns.
  var candidateDuration = Number(candidate.duration_ms || 0) ||
    Number(candidate.duration || 0) * 1000;
  var durationClose = durationMs > 0 && candidateDuration > 0 &&
    Math.abs(durationMs - candidateDuration) <= 10000;
  var normalizedCandidateTitle = downloadTitleWithoutAlbumSuffix(candidateTitle.title, albumName);
  var titleMatched = titleKey &&
    titleKey === downloadMatchValue(stripTrackTitleAnnotations(normalizedCandidateTitle));
  if (!titleMatched &&
      !downloadBilingualEditionTitleMatches(titleKey, candidateTitle.title, durationClose, albumName)) {
    return false;
  }
  if (artistName) {
    var candidateArtists = String(candidate.artists || candidate.artist || "");
    var artistText = " " + downloadMatchValue(candidateArtists) + " ";
    var artists = String(artistName).split(/[,;&]|\s+(?:and|feat\.?|ft\.?|featuring|x)\s+/i);
    var artistMatched = artists.some(function(artist) {
      var key = downloadMatchValue(artist);
      return key && artistText.indexOf(" " + key + " ") >= 0;
    });
    // Spotify can return a romanized artist while YouTube Music credits the
    // same performer in the native script (Ayumi Hamasaki / 浜崎あゆみ).
    // Cross-script names alone are not proof of identity, so only allow the
    // fallback after an exact title match and a near-exact duration match.
    var titleArtistMatched = candidateTitle.creditedArtist && durationClose &&
      downloadArtistsUseDifferentScripts(artistName, candidateTitle.creditedArtist);
    if (!artistMatched && !titleArtistMatched &&
        !(durationClose && downloadArtistsUseDifferentScripts(artistName, candidateArtists))) {
      return false;
    }
  }
  return !(durationMs > 0 && candidateDuration > 0 && Math.abs(durationMs - candidateDuration) > 15000);
}

function relatedTitleKey(value) {
  return metadataMatchValue(
    String(value || "").replace(/\s*[\(\[][^\)\]]*[\)\]]/g, " "),
  );
}

function relatedArtistKeys(value) {
  var parts = Array.isArray(value)
    ? value
    : String(value || "").split(
        /\s*,\s*|\s*;\s*|\s+&\s+|\s+and\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s+x\s+/i,
      );
  var keys = [];
  for (var i = 0; i < parts.length; i++) {
    var key = metadataMatchValue(parts[i]);
    if (key && keys.indexOf(key) < 0) keys.push(key);
  }
  return keys;
}

function isConfidentSeedMatch(seed, candidate) {
  if (!seed || !candidate || !candidate.id) return false;
  var seedTitle = relatedTitleKey(seed.name);
  var candidateTitle = relatedTitleKey(candidate.name);
  if (!seedTitle || !candidateTitle) return false;
  if (
    seedTitle !== candidateTitle &&
    candidateTitle.indexOf(seedTitle + " ") !== 0 &&
    seedTitle.indexOf(candidateTitle + " ") !== 0
  )
    return false;

  var seedArtists = relatedArtistKeys(seed.artists);
  var candidateArtists = relatedArtistKeys(candidate.artists);
  var candidateArtistText = " " + metadataMatchValue(candidate.artists) + " ";
  var artistOk = false;
  for (var i = 0; i < seedArtists.length && !artistOk; i++) {
    if (
      candidateArtists.indexOf(seedArtists[i]) >= 0 ||
      candidateArtistText.indexOf(" " + seedArtists[i] + " ") >= 0
    )
      artistOk = true;
  }
  if (!artistOk) return false;

  var seedDuration = Number(seed.duration_ms) || 0;
  var candidateDuration = Number(candidate.duration_ms) || 0;
  if (
    seedDuration > 0 &&
    candidateDuration > 0 &&
    Math.abs(seedDuration - candidateDuration) > RELATED_DURATION_TOLERANCE_MS
  )
    return false;
  return true;
}

function resolveRelatedSeed(seed) {
  var artists = Array.isArray(seed.artists)
    ? seed.artists.join(", ")
    : String(seed.artists || "");
  var query = (artists ? artists + " " : "") + String(seed.name || "");
  if (!query.trim()) return null;
  var results = customSearchSync(query.trim(), { filter: "tracks" });
  for (var i = 0; i < results.length; i++) {
    var candidate = results[i];
    if (candidate && candidate.item_type === "track") {
      if (isConfidentSeedMatch(seed, candidate)) return candidate.id;
    }
  }
  return null;
}

function relatedVideoType(node) {
  var renderer = node && node.playlistPanelVideoRenderer;
  var endpoint = renderer && renderer.navigationEndpoint;
  var config =
    endpoint &&
    endpoint.watchEndpoint &&
    endpoint.watchEndpoint.watchEndpointMusicSupportedConfigs &&
    endpoint.watchEndpoint.watchEndpointMusicSupportedConfigs
      .watchEndpointMusicConfig;
  return (config && config.musicVideoType) || "";
}

// Fetches the YouTube Music radio ("RDAMVM" + videoId) queue for one song.
// Returns sanitized tracks in the customSearch shape. Throws on HTTP errors.
function fetchRelatedForVideo(videoId) {
  var key = "yt:related:" + videoId;
  var cached = cacheGet(key);
  if (cached) return cached;

  var res = fetch("https://music.youtube.com/youtubei/v1/next?alt=json", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible)",
      "x-youtube-client-name": "WEB_REMIX",
      "x-youtube-client-version": CONFIG.clientVersion,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: CONFIG.clientVersion,
        },
      },
      videoId: videoId,
      playlistId: "RDAMVM" + videoId,
      isAudioOnly: true,
    }),
  });
  if (!res || !res.ok) {
    throw new Error(
      "YouTube Music related request failed: " +
        (res ? res.status : "no response"),
    );
  }
  var data = res.json();
  var panel =
    data && data.contents
      ? findFirstRenderer(data.contents, "playlistPanelRenderer")
      : null;
  var rows = panel && Array.isArray(panel.contents) ? panel.contents : [];

  // Song seeds return songs; video seeds return music videos. Prefer songs
  // and only keep other video types when the queue has no song at all.
  var songs = [];
  var others = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.playlistPanelVideoRenderer) continue;
    var type = relatedVideoType(row);
    if (!type || type === "MUSIC_VIDEO_TYPE_ATV") songs.push(row);
    else others.push(row);
  }
  var picked = songs.length > 0 ? songs : others;
  var tracks = [];
  for (var j = 0; j < picked.length; j++) {
    var sanitized = sanitizeTrackBeforeReturn(parseItemExtended(picked[j]));
    if (sanitized) tracks.push(stripUrlLikeFields(sanitized));
  }
  cacheSet(key, tracks);
  return tracks;
}

function getRelatedTracks(seeds, options) {
  var limit = Number(options && options.limit) || 25;
  limit = Math.max(1, Math.min(50, Math.floor(limit)));
  var list = Array.isArray(seeds) ? seeds.slice(0, 10) : [];

  var excludedIds = {};
  var excludedIsrcs = {};
  var seedIds = [];
  var attempted = 0;
  for (var i = 0; i < list.length; i++) {
    var seed = list[i];
    if (!seed) continue;
    var isrc = String(seed.isrc || "")
      .trim()
      .toUpperCase();
    if (isrc) excludedIsrcs[isrc] = true;
    var ownId =
      seed.provider_id === "ytmusic-spotiflac"
        ? String(seed.id || "").trim()
        : "";
    if (ownId) excludedIds[ownId] = true;
    if (attempted >= RELATED_MAX_SEEDS) continue;
    attempted++;
    var videoId = ownId;
    if (!videoId) {
      try {
        videoId = resolveRelatedSeed(seed) || "";
      } catch (e) {
        L("warn", "getRelatedTracks seed resolution failed", String(e));
        videoId = "";
      }
    }
    if (!videoId || seedIds.indexOf(videoId) >= 0) continue;
    excludedIds[videoId] = true;
    seedIds.push(videoId);
  }

  var lists = [];
  var failures = 0;
  for (var s = 0; s < seedIds.length; s++) {
    try {
      lists.push(fetchRelatedForVideo(seedIds[s]));
    } catch (e) {
      failures++;
      L("warn", "getRelatedTracks related request failed", String(e));
    }
  }
  if (lists.length === 0 && failures > 0) {
    throw new Error("YouTube Music related tracks unavailable");
  }

  var out = [];
  var seen = {};
  var longest = 0;
  for (var l = 0; l < lists.length; l++) {
    if (lists[l].length > longest) longest = lists[l].length;
  }
  for (var idx = 0; idx < longest && out.length < limit; idx++) {
    for (var li = 0; li < lists.length && out.length < limit; li++) {
      var track = lists[li][idx];
      if (!track || !track.id || seen[track.id] || excludedIds[track.id])
        continue;
      var trackIsrc = String(track.isrc || "")
        .trim()
        .toUpperCase();
      if (trackIsrc && excludedIsrcs[trackIsrc]) continue;
      seen[track.id] = true;
      out.push(track);
    }
  }
  return out;
}

function validateTrackForDownload(track) {
  if (!track || typeof track !== "object")
    return { ok: false, reason: "invalid_track" };
  if (!track.id || !String(track.id).trim())
    return { ok: false, reason: "missing_id" };
  var keys = ["downloadUrl", "coverUrl", "thumbnail", "url", "uri"];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(track, k)) {
      var v = track[k];
      if (v === "") {
        return { ok: false, reason: k + "_empty" };
      }
      if (v === null || typeof v === "undefined") {
        continue;
      }
      if (v && !isAbsoluteHttpUrl(v))
        return { ok: false, reason: k + "_invalid" };
    }
  }
  return { ok: true };
}

function finalGuardBeforeNative(track) {
  var v = validateTrackForDownload(track);
  if (!v.ok) {
    L(
      "error",
      "native call blocked invalid field",
      v.reason,
      track && track.id,
    );
    try {
      if (typeof DEBUG !== "undefined" && DEBUG) {
        var offending = {};
        var keys = ["downloadUrl", "coverUrl", "thumbnail", "url", "uri"];
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          if (Object.prototype.hasOwnProperty.call(track, k))
            offending[k] = track[k];
        }
        L("debug", "finalGuard offending fields", offending);
      }
    } catch (e) {}
    return false;
  }
  return true;
}

// Extract video ID from YouTube URL
function extractVideoId(url) {
  if (!url) return null;
  try {
    var u = new URL(url);
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0];
    return null;
  } catch (e) {
    return null;
  }
}

function extractPlaylistId(url) {
  if (!url) return null;
  try {
    var u = new URL(url);
    if (u.searchParams.has("list")) return u.searchParams.get("list");
    if (u.pathname.startsWith("/browse/")) {
      var browseId = u.pathname.replace("/browse/", "");
      if (browseId.startsWith("VL") || browseId.startsWith("PL"))
        return browseId;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Extract album/browse ID from YouTube Music URL
function extractBrowseId(url) {
  if (!url) return null;
  try {
    var u = new URL(url);
    if (u.pathname.startsWith("/browse/")) {
      return u.pathname.replace("/browse/", "");
    }
    if (u.searchParams.has("list")) {
      var list = u.searchParams.get("list");
      if (list.startsWith("OLAK5uy_")) return list;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Max pages to fetch for continuation (safety limit)
var MAX_CONTINUATION_PAGES = 50;

// Fetch a single continuation page
function fetchContinuationSync(continuationToken) {
  L("debug", "fetchContinuationSync: fetching next page");

  var url =
    "https://music.youtube.com/youtubei/v1/browse?ctoken=" +
    encodeURIComponent(continuationToken) +
    "&continuation=" +
    encodeURIComponent(continuationToken) +
    "&alt=json";
  var body = JSON.stringify({
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: CONFIG.clientVersion },
    },
  });

  var res;
  try {
    res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: body,
    });
  } catch (e) {
    L("error", "fetchContinuationSync fetch failed", String(e));
    return null;
  }

  if (!res || !res.ok) {
    L(
      "error",
      "fetchContinuationSync bad response",
      res ? res.status : "no response",
    );
    return null;
  }

  try {
    return res.json();
  } catch (e) {
    L("error", "fetchContinuationSync json parse failed", String(e));
    return null;
  }
}

// Parse tracks and continuation token from a continuation response
function parseContinuationResponse(data) {
  var result = { tracks: [], continuationToken: null };
  if (!data) return result;

  var items = [];

  // Check continuationContents (standard continuation response)
  if (data.continuationContents) {
    var cc = data.continuationContents;

    // Helper: extract continuation token from shelf-level .continuations array
    function extractShelfContinuation(shelf) {
      if (shelf.continuations && Array.isArray(shelf.continuations)) {
        for (var ci = 0; ci < shelf.continuations.length; ci++) {
          var c = shelf.continuations[ci];
          if (
            c &&
            c.nextContinuationData &&
            c.nextContinuationData.continuation
          ) {
            result.continuationToken = c.nextContinuationData.continuation;
            return;
          }
          if (
            c &&
            c.reloadContinuationData &&
            c.reloadContinuationData.continuation
          ) {
            result.continuationToken = c.reloadContinuationData.continuation;
            return;
          }
        }
      }
    }

    // Helper: extract continuation token from continuationItemRenderer inside contents array
    function extractContItemFromContents(contents) {
      for (
        var ci = contents.length - 1;
        ci >= 0 && ci >= contents.length - 3;
        ci--
      ) {
        var item = contents[ci];
        if (item && item.continuationItemRenderer) {
          var ep = item.continuationItemRenderer.continuationEndpoint;
          if (ep && ep.continuationCommand && ep.continuationCommand.token) {
            result.continuationToken = ep.continuationCommand.token;
            return;
          }
        }
      }
    }

    // musicPlaylistShelfContinuation (playlist continuations)
    if (cc.musicPlaylistShelfContinuation) {
      var shelf = cc.musicPlaylistShelfContinuation;
      if (shelf.contents) {
        for (var i = 0; i < shelf.contents.length; i++) {
          var item = shelf.contents[i];
          if (item.musicResponsiveListItemRenderer) {
            items.push(item);
          }
        }
        // Check both shelf-level .continuations and continuationItemRenderer in contents
        extractShelfContinuation(shelf);
        if (!result.continuationToken) {
          extractContItemFromContents(shelf.contents);
        }
      }
    }

    // musicShelfContinuation (album/search continuations)
    if (cc.musicShelfContinuation) {
      var mShelf = cc.musicShelfContinuation;
      if (mShelf.contents) {
        for (var i = 0; i < mShelf.contents.length; i++) {
          var item = mShelf.contents[i];
          if (item.musicResponsiveListItemRenderer) {
            items.push(item);
          }
        }
        extractShelfContinuation(mShelf);
        if (!result.continuationToken) {
          extractContItemFromContents(mShelf.contents);
        }
      }
    }

    // sectionListContinuation
    if (cc.sectionListContinuation && cc.sectionListContinuation.contents) {
      var contInfo = { token: null };
      collectAlbumTracksOnly(cc.sectionListContinuation, items, contInfo);
      if (contInfo.token) result.continuationToken = contInfo.token;
    }
  }

  // Also check onResponseReceivedActions (alternative continuation format)
  if (
    data.onResponseReceivedActions &&
    Array.isArray(data.onResponseReceivedActions)
  ) {
    for (var ai = 0; ai < data.onResponseReceivedActions.length; ai++) {
      var action = data.onResponseReceivedActions[ai];
      if (
        action &&
        action.appendContinuationItemsAction &&
        action.appendContinuationItemsAction.continuationItems
      ) {
        var contItems = action.appendContinuationItemsAction.continuationItems;
        for (var ci = 0; ci < contItems.length; ci++) {
          var item = contItems[ci];
          if (item.musicResponsiveListItemRenderer) {
            items.push(item);
          }
          // Check for continuation item
          if (
            item.continuationItemRenderer &&
            item.continuationItemRenderer.continuationEndpoint
          ) {
            var ep = item.continuationItemRenderer.continuationEndpoint;
            if (ep.continuationCommand && ep.continuationCommand.token) {
              result.continuationToken = ep.continuationCommand.token;
            }
          }
        }
      }
    }
  }

  result.tracks = items;
  L(
    "debug",
    "parseContinuationResponse: found",
    items.length,
    "items, hasMore:",
    !!result.continuationToken,
  );
  return result;
}

// Fetch album/playlist tracks using browse API (sync version for goja)
// Extract MPREb_ album browseId from a browse response's track data.
// VLOLAK5uy_ responses don't include album header, but each track's
// album column links to the real MPREb_ album page.
function _extractAlbumBrowseIdFromResponse(data) {
  try {
    var json = JSON.stringify(data);
    var match = json.match(/MPREb_[a-zA-Z0-9_-]+/);
    return match ? match[0] : null;
  } catch (e) {
    return null;
  }
}

function applyResponsiveHeaderMetadata(renderer, info) {
  if (!renderer || !info) return info;
  if (renderer.title && renderer.title.runs) {
    info.name = runsText(renderer.title.runs);
  }

  var subtitleRuns = (renderer.subtitle && renderer.subtitle.runs) || [];
  for (var i = 0; i < subtitleRuns.length; i++) {
    var subtitleText = String(
      (subtitleRuns[i] && subtitleRuns[i].text) || "",
    ).trim();
    var lower = subtitleText.toLowerCase();
    if (
      lower === "album" ||
      lower === "single" ||
      lower === "ep" ||
      lower === "playlist"
    ) {
      info.album_type = lower;
    } else if (/^\d{4}$/.test(subtitleText)) {
      info.release_date = subtitleText;
    }
  }

  var artistRuns =
    (renderer.straplineTextOne && renderer.straplineTextOne.runs) || [];
  if (artistRuns.length) {
    info.artists = uniqueStrings(
      artistRuns.map(function (run) {
        return run && run.text;
      }),
    ).join(", ");
    for (var ar = 0; ar < artistRuns.length; ar++) {
      var endpoint =
        artistRuns[ar] &&
        artistRuns[ar].navigationEndpoint &&
        artistRuns[ar].navigationEndpoint.browseEndpoint;
      if (
        endpoint &&
        (String(endpoint.browseId || "").startsWith("UC") ||
          browsePageType(endpoint) === "MUSIC_PAGE_TYPE_ARTIST")
      ) {
        info.artist_id = String(endpoint.browseId);
        break;
      }
    }
  }

  if (
    renderer.thumbnail &&
    renderer.thumbnail.musicThumbnailRenderer &&
    renderer.thumbnail.musicThumbnailRenderer.thumbnail
  ) {
    var thumbnailURL = pickLastThumbnailUrl(
      renderer.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
    );
    if (thumbnailURL) info.cover_url = makeSquareThumb(thumbnailURL);
  }

  var secondSubtitle = runsText(
    (renderer.secondSubtitle && renderer.secondSubtitle.runs) || [],
  );
  var totalMatch = secondSubtitle.match(/(\d[\d,.]*)\s+(songs?|tracks?)/i);
  if (totalMatch) {
    info.total_tracks =
      parseInt(totalMatch[1].replace(/[^\d]/g, ""), 10) ||
      info.total_tracks ||
      0;
  }
  return info;
}

// Fetch album header metadata (name, artist, cover, etc.) from a MPREb_ browseId.
// Used as a follow-up call when the primary browse response lacks header info.
function _fetchAlbumHeaderMetadata(albumBrowseId) {
  try {
    var cacheKey = "yt:album-header:" + albumBrowseId;
    var cached = cacheGet(cacheKey);
    if (cached) return cached;
    var url = "https://music.youtube.com/youtubei/v1/browse?alt=json";
    var res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: CONFIG.clientVersion,
          },
        },
        browseId: albumBrowseId,
      }),
    });
    if (!res || !res.ok) {
      L(
        "warn",
        "_fetchAlbumHeaderMetadata bad response",
        res ? res.status : "no response",
      );
      return null;
    }
    var data = res.json();

    var info = {
      name: "",
      artists: "",
      artist_id: "",
      cover_url: null,
      release_date: "",
      album_type: "album",
      total_tracks: 0,
    };

    var responsiveHeader =
      (data.header && data.header.musicResponsiveHeaderRenderer) ||
      findFirstRenderer(data.contents, "musicResponsiveHeaderRenderer");
    if (responsiveHeader) applyResponsiveHeaderMetadata(responsiveHeader, info);

    // microformat has the cleanest title: "Acoustic - Album by Queen"
    if (data.microformat && data.microformat.microformatDataRenderer) {
      var mf = data.microformat.microformatDataRenderer;
      if (mf.title) {
        var m = mf.title.match(
          /^(.+?)\s*-\s*(Album|Single|EP|Playlist)\s+by\s+(.+)$/i,
        );
        if (m) {
          info.name = m[1].trim();
          info.artists = m[3].trim();
          var typeStr = m[2].toLowerCase();
          if (typeStr === "single") info.album_type = "single";
          else if (typeStr === "ep") info.album_type = "ep";
        } else {
          info.name = mf.title;
        }
      }
      if (!info.artists && mf.description) {
        var parts = mf.description.split(" • ");
        if (parts.length >= 2) {
          var lower = parts[0].toLowerCase().trim();
          if (lower === "album" || lower === "single" || lower === "ep") {
            info.artists = parts[1].trim();
          } else {
            info.artists = parts[0].trim();
          }
        }
      }
    }

    // background has the cover image
    if (
      data.background &&
      data.background.musicThumbnailRenderer &&
      data.background.musicThumbnailRenderer.thumbnail
    ) {
      var thumbUrl = pickLastThumbnailUrl(
        data.background.musicThumbnailRenderer.thumbnail.thumbnails,
      );
      if (thumbUrl) info.cover_url = makeSquareThumb(thumbUrl);
    }

    // frameworkUpdates may have artist_id and release_date
    if (data.frameworkUpdates && data.frameworkUpdates.entityBatchUpdate) {
      var mutations = data.frameworkUpdates.entityBatchUpdate.mutations;
      if (Array.isArray(mutations)) {
        for (var i = 0; i < mutations.length; i++) {
          var mut = mutations[i];
          if (mut && mut.payload && mut.payload.musicAlbumRelease) {
            var release = mut.payload.musicAlbumRelease;
            if (release.releaseDate) {
              var rd = release.releaseDate;
              info.release_date =
                (rd.year || "") +
                (rd.month ? "-" + String(rd.month).padStart(2, "0") : "") +
                (rd.day ? "-" + String(rd.day).padStart(2, "0") : "");
            }
            if (release.artistDisplayName && !info.artists) {
              info.artists = release.artistDisplayName;
            }
            break;
          }
        }
      }
    }

    cacheSet(cacheKey, info);
    L("info", "_fetchAlbumHeaderMetadata result", {
      name: info.name,
      artists: info.artists,
      album_type: info.album_type,
    });
    return info;
  } catch (e) {
    L("error", "_fetchAlbumHeaderMetadata failed", String(e));
    return null;
  }
}

function fetchBrowseTracksSync(browseId) {
  L("info", "fetchBrowseTracksSync", browseId);

  var url = "https://music.youtube.com/youtubei/v1/browse?alt=json";
  var body = JSON.stringify({
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: CONFIG.clientVersion },
    },
    browseId: browseId,
  });

  var res;
  try {
    res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: body,
    });
  } catch (e) {
    L("error", "fetchBrowseTracksSync fetch failed", String(e));
    return null;
  }

  if (!res || !res.ok) {
    L(
      "error",
      "fetchBrowseTracksSync bad response",
      res ? res.status : "no response",
    );
    return null;
  }

  var data;
  try {
    data = res.json();
  } catch (e) {
    L("error", "fetchBrowseTracksSync json parse failed", String(e));
    return null;
  }

  var result = parseBrowseResponse(data, browseId);
  if (!result) return null;
  var rawBrowseData = data; // Keep reference for album ID extraction later

  // Follow continuation tokens to fetch ALL tracks (pagination)
  var continuationToken = result._continuationToken;
  var page = 0;
  var seenTokens = {};
  var seenVideoIds = {};

  // Build set of video IDs from first page to detect duplicates
  for (var si = 0; si < result.tracks.length; si++) {
    var tid = result.tracks[si].id || result.tracks[si].track_id;
    if (tid) seenVideoIds[tid] = true;
  }

  while (continuationToken && page < MAX_CONTINUATION_PAGES) {
    // Detect infinite loop: same token returned again
    if (seenTokens[continuationToken]) {
      L(
        "warn",
        "fetchBrowseTracksSync: duplicate continuation token detected, stopping pagination",
      );
      break;
    }
    seenTokens[continuationToken] = true;

    page++;
    L("info", "fetchBrowseTracksSync: fetching continuation page", page);

    var contData = fetchContinuationSync(continuationToken);
    if (!contData) break;

    var contResult = parseContinuationResponse(contData);
    if (!contResult || contResult.tracks.length === 0) break;

    // Parse the continuation tracks, skipping duplicates
    var newTracksThisPage = 0;
    for (var i = 0; i < contResult.tracks.length; i++) {
      var node = contResult.tracks[i];
      var possible =
        node.musicResponsiveListItemRenderer ||
        node.playlistPanelVideoRenderer ||
        node;
      var parsed = parseItemExtended(possible);
      if (parsed) {
        // Skip duplicate video IDs
        var vid = parsed.id;
        if (vid && seenVideoIds[vid]) {
          continue;
        }
        if (vid) seenVideoIds[vid] = true;

        applyBrowseCollectionMetadata(
          parsed,
          result.album,
          result.type === "playlist",
        );
        var sanitized = sanitizeTrackBeforeReturn(parsed);
        if (sanitized) {
          if (!sanitized.track_number) {
            sanitized.track_number = result.tracks.length + 1;
          }
          result.tracks.push(sanitized);
          newTracksThisPage++;
        }
      }
    }

    L(
      "info",
      "fetchBrowseTracksSync: page",
      page,
      "added",
      newTracksThisPage,
      "new tracks, total:",
      result.tracks.length,
    );

    // If no new unique tracks were added, we've exhausted the playlist
    if (newTracksThisPage === 0) {
      L(
        "info",
        "fetchBrowseTracksSync: no new tracks on page",
        page,
        ", stopping pagination",
      );
      break;
    }

    continuationToken = contResult.continuationToken;
  }

  // Update total_tracks after all pages fetched
  if (result.album) {
    result.album.total_tracks = result.tracks.length;
    for (var trackIndex = 0; trackIndex < result.tracks.length; trackIndex++) {
      result.tracks[trackIndex].total_tracks = result.tracks.length;
    }
  }

  // Clean up internal field
  delete result._continuationToken;

  // If album header info is missing (e.g. VLOLAK5uy_ playlist IDs that
  // represent albums), try to find the MPREb_ album browseId from the
  // response and do a follow-up browse to get proper album metadata.
  if (!result.name && result.tracks && result.tracks.length > 0) {
    var albumBrowseId = _extractAlbumBrowseIdFromResponse(rawBrowseData);
    if (albumBrowseId) {
      L(
        "info",
        "fetchBrowseTracksSync: header missing, fetching album metadata from",
        albumBrowseId,
      );
      var albumMeta = _fetchAlbumHeaderMetadata(albumBrowseId);
      if (albumMeta) {
        result.name = albumMeta.name || result.name;
        result.cover_url = albumMeta.cover_url || result.cover_url;
        // This is actually an album, not a playlist -- override type
        result.type = "album";
        if (!result.album) {
          result.album = {
            id: albumBrowseId,
            total_tracks: result.tracks.length,
          };
        }
        result.album.name = albumMeta.name || result.album.name;
        result.album.artists = albumMeta.artists || result.album.artists;
        result.album.artist_id = albumMeta.artist_id || result.album.artist_id;
        result.album.cover_url = albumMeta.cover_url || result.album.cover_url;
        result.album.release_date =
          albumMeta.release_date || result.album.release_date;
        result.album.album_type =
          albumMeta.album_type || result.album.album_type;
        result.album.total_tracks =
          albumMeta.total_tracks || result.album.total_tracks;
        result.album.id = albumBrowseId;
      }
    }
  }

  // For playlists, remove album field so Flutter routes to PlaylistScreen
  // (matches Spotify Web extension convention: playlists don't have album field)
  if (result.type === "playlist") {
    delete result.album;
  }

  L("info", "fetchBrowseTracksSync: final total tracks:", result.tracks.length);
  return result;
}

function parseBrowseResponse(data, browseId) {
  try {
    if (!data) return null;

    var headerInfo = {
      id: browseId,
      name: "",
      artists: "",
      artist_id: "",
      cover_url: null,
      album_type: "album",
      release_date: "",
      total_tracks: 0,
    };

    var header = data.header;

    if (!header && data.contents) {
      var scbr = data.contents.singleColumnBrowseResultsRenderer;
      if (
        scbr &&
        scbr.tabs &&
        scbr.tabs[0] &&
        scbr.tabs[0].tabRenderer &&
        scbr.tabs[0].tabRenderer.content
      ) {
        var tabContent = scbr.tabs[0].tabRenderer.content;
        if (
          tabContent.sectionListRenderer &&
          tabContent.sectionListRenderer.header
        ) {
          header = tabContent.sectionListRenderer.header;
        }
      }
      // Check twoColumnBrowseResultsRenderer
      var tcbr = data.contents.twoColumnBrowseResultsRenderer;
      if (
        !header &&
        tcbr &&
        tcbr.tabs &&
        tcbr.tabs[0] &&
        tcbr.tabs[0].tabRenderer &&
        tcbr.tabs[0].tabRenderer.content
      ) {
        var tabContent2 = tcbr.tabs[0].tabRenderer.content;
        if (
          tabContent2.sectionListRenderer &&
          tabContent2.sectionListRenderer.header
        ) {
          header = tabContent2.sectionListRenderer.header;
        }
      }
    }
    if (!header && data.contents) {
      var nestedResponsiveHeader = findFirstRenderer(
        data.contents,
        "musicResponsiveHeaderRenderer",
      );
      if (nestedResponsiveHeader)
        header = { musicResponsiveHeaderRenderer: nestedResponsiveHeader };
    }

    if (!header && data.background) {
      var bgThumb = pickLastThumbnailUrl(
        data.background.musicThumbnailRenderer &&
          data.background.musicThumbnailRenderer.thumbnail &&
          data.background.musicThumbnailRenderer.thumbnail.thumbnails,
      );
      if (bgThumb) {
        headerInfo.cover_url = makeSquareThumb(bgThumb);
      }
    }

    if (data.microformat && data.microformat.microformatDataRenderer) {
      var mf = data.microformat.microformatDataRenderer;
      if (mf.title) {
        var titleStr = mf.title;
        var albumByMatch = titleStr.match(
          /^(.+?)\s*-\s*(Album|Single|EP|Playlist)\s+by\s+(.+)$/i,
        );
        if (albumByMatch) {
          if (!headerInfo.name) headerInfo.name = albumByMatch[1].trim();
          if (!headerInfo.artists) headerInfo.artists = albumByMatch[3].trim();
          var typeStr = albumByMatch[2].toLowerCase();
          if (typeStr === "single") headerInfo.album_type = "single";
          else if (typeStr === "ep") headerInfo.album_type = "ep";
          else if (typeStr === "playlist") headerInfo.album_type = "playlist";
        } else if (!headerInfo.name) {
          headerInfo.name = titleStr;
        }
      }
      if (!headerInfo.artists && mf.description) {
        var descParts = mf.description.split(" • ");
        if (descParts.length >= 2) {
          var lowerFirst = descParts[0].toLowerCase().trim();
          if (
            lowerFirst === "album" ||
            lowerFirst === "single" ||
            lowerFirst === "ep" ||
            lowerFirst === "playlist"
          ) {
            if (descParts.length >= 2) headerInfo.artists = descParts[1].trim();
          } else {
            headerInfo.artists = descParts[0].trim();
          }
        }
      }
    }

    if (
      !headerInfo.artists &&
      data.frameworkUpdates &&
      data.frameworkUpdates.entityBatchUpdate
    ) {
      var mutations = data.frameworkUpdates.entityBatchUpdate.mutations;
      if (Array.isArray(mutations)) {
        for (var mi = 0; mi < mutations.length; mi++) {
          var mut = mutations[mi];
          if (mut && mut.payload && mut.payload.musicAlbumRelease) {
            var release = mut.payload.musicAlbumRelease;
            if (release.artistDisplayName) {
              headerInfo.artists = release.artistDisplayName;
              break;
            }
          }
        }
      }
    }

    L(
      "debug",
      "parseBrowseResponse header keys",
      header ? Object.keys(header) : "no header",
    );
    L("debug", "parseBrowseResponse data keys", Object.keys(data));
    L("debug", "parseBrowseResponse headerInfo after fallbacks", {
      name: headerInfo.name,
      artists: headerInfo.artists,
    });
    if (header) {
      if (header.musicResponsiveHeaderRenderer) {
        applyResponsiveHeaderMetadata(
          header.musicResponsiveHeaderRenderer,
          headerInfo,
        );
        L(
          "debug",
          "musicResponsiveHeaderRenderer cover_url",
          headerInfo.cover_url,
        );
      }
      if (header.musicDetailHeaderRenderer) {
        var h = header.musicDetailHeaderRenderer;
        if (h.title && h.title.runs) {
          headerInfo.name = h.title.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
        if (h.subtitle && h.subtitle.runs) {
          var subtitleParts = h.subtitle.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
          headerInfo.artists = subtitleParts;
          var yearMatch = subtitleParts.match(/\d{4}/);
          if (yearMatch) headerInfo.release_date = yearMatch[0];
          var lowerSubtitle = subtitleParts.toLowerCase();
          if (lowerSubtitle.indexOf("ep") !== -1) headerInfo.album_type = "ep";
          else if (lowerSubtitle.indexOf("single") !== -1)
            headerInfo.album_type = "single";
          else if (lowerSubtitle.indexOf("playlist") !== -1)
            headerInfo.album_type = "playlist";

          // Extract artist_id from runs with browseEndpoint
          for (var ri = 0; ri < h.subtitle.runs.length; ri++) {
            var run = h.subtitle.runs[ri];
            if (
              run.navigationEndpoint &&
              run.navigationEndpoint.browseEndpoint
            ) {
              var browseEndpoint = run.navigationEndpoint.browseEndpoint;
              if (
                browseEndpoint.browseId &&
                browseEndpoint.browseId.startsWith("UC")
              ) {
                headerInfo.artist_id = browseEndpoint.browseId;
                // Also get clean artist name from this run
                if (run.text && run.text.trim()) {
                  headerInfo.artists = run.text.trim();
                }
                L(
                  "debug",
                  "Extracted artist_id from subtitle runs:",
                  headerInfo.artist_id,
                );
                break;
              }
            }
          }
        }
        if (
          h.thumbnail &&
          h.thumbnail.croppedSquareThumbnailRenderer &&
          h.thumbnail.croppedSquareThumbnailRenderer.thumbnail
        ) {
          var thumbUrl = pickLastThumbnailUrl(
            h.thumbnail.croppedSquareThumbnailRenderer.thumbnail.thumbnails,
          );
          headerInfo.cover_url = makeSquareThumb(thumbUrl);
        } else if (
          h.thumbnail &&
          h.thumbnail.musicThumbnailRenderer &&
          h.thumbnail.musicThumbnailRenderer.thumbnail
        ) {
          var thumbUrl = pickLastThumbnailUrl(
            h.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
          );
          headerInfo.cover_url = makeSquareThumb(thumbUrl);
        }
        L("debug", "musicDetailHeaderRenderer cover_url", headerInfo.cover_url);
      }
      if (header.musicImmersiveHeaderRenderer) {
        var ih = header.musicImmersiveHeaderRenderer;
        if (ih.title && ih.title.runs) {
          headerInfo.name = ih.title.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
        if (ih.description && ih.description.runs) {
          headerInfo.artists = ih.description.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
        if (
          ih.thumbnail &&
          ih.thumbnail.musicThumbnailRenderer &&
          ih.thumbnail.musicThumbnailRenderer.thumbnail
        ) {
          var thumbUrl2 = pickLastThumbnailUrl(
            ih.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
          );
          headerInfo.cover_url = makeSquareThumb(thumbUrl2);
        }
        headerInfo.album_type = "playlist";
        L(
          "debug",
          "musicImmersiveHeaderRenderer cover_url",
          headerInfo.cover_url,
        );
      }
      if (header.musicVisualHeaderRenderer) {
        var vh = header.musicVisualHeaderRenderer;
        if (vh.title && vh.title.runs) {
          headerInfo.name = vh.title.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
        if (
          vh.foregroundThumbnail &&
          vh.foregroundThumbnail.musicThumbnailRenderer &&
          vh.foregroundThumbnail.musicThumbnailRenderer.thumbnail
        ) {
          var thumbUrl3 = pickLastThumbnailUrl(
            vh.foregroundThumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
          );
          headerInfo.cover_url = makeSquareThumb(thumbUrl3);
        }
        L("debug", "musicVisualHeaderRenderer cover_url", headerInfo.cover_url);
      }
    }

    L(
      "debug",
      "parseBrowseResponse headerInfo.cover_url after header parse",
      headerInfo.cover_url,
    );

    var trackCandidates = [];
    var continuationInfo = { token: null };
    if (data.contents) {
      collectAlbumTracksOnly(data.contents, trackCandidates, continuationInfo);
    }

    if (trackCandidates.length === 0 && data.contents) {
      L(
        "debug",
        "parseBrowseResponse: collectAlbumTracksOnly found nothing, falling back to collectItemsFromNode",
      );
      collectItemsFromNode(data.contents, trackCandidates, 0);
    }

    L(
      "debug",
      "parseBrowseResponse found candidates",
      trackCandidates.length,
      "continuation:",
      !!continuationInfo.token,
    );

    // Classify the collection before parsing its tracks. Playlist headers are
    // containers, not release metadata, and must never become ALBUM/ARTIST.
    if (
      browseId.startsWith("VL") ||
      browseId.startsWith("PL") ||
      browseId.startsWith("RDCLAK5uy_")
    ) {
      headerInfo.album_type = "playlist";
    } else if (browseId.startsWith("MPREb_")) {
      if (!headerInfo.album_type) headerInfo.album_type = "album";
    }
    var isPlaylist = headerInfo.album_type === "playlist";

    var tracks = [];
    for (var i = 0; i < trackCandidates.length; i++) {
      var node = trackCandidates[i];
      var possible =
        node.musicResponsiveListItemRenderer ||
        node.playlistPanelVideoRenderer ||
        node;
      var parsed = parseItemExtended(possible);
      if (parsed) {
        applyBrowseCollectionMetadata(parsed, headerInfo, isPlaylist);
        var sanitized = sanitizeTrackBeforeReturn(parsed);
        if (sanitized) {
          if (!sanitized.track_number) {
            sanitized.track_number = tracks.length + 1;
          }
          tracks.push(sanitized);
        }
      }
    }

    L("info", "parseBrowseResponse parsed tracks", tracks.length);

    headerInfo.total_tracks = Math.max(
      headerInfo.total_tracks || 0,
      tracks.length,
    );
    for (var trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      tracks[trackIndex].total_tracks = headerInfo.total_tracks;
      if (!tracks[trackIndex].album_artist)
        tracks[trackIndex].album_artist = headerInfo.artists;
      if (!tracks[trackIndex].release_date)
        tracks[trackIndex].release_date = headerInfo.release_date;
      if (!tracks[trackIndex].album_type)
        tracks[trackIndex].album_type = headerInfo.album_type;
    }

    if (!headerInfo.cover_url && tracks.length > 0 && tracks[0].cover_url) {
      headerInfo.cover_url = tracks[0].cover_url;
      L(
        "debug",
        "parseBrowseResponse using first track cover as fallback",
        headerInfo.cover_url,
      );
    }

    L("debug", "parseBrowseResponse final cover_url", headerInfo.cover_url);

    return {
      type: headerInfo.album_type === "playlist" ? "playlist" : "album",
      album: headerInfo,
      tracks: tracks,
      cover_url: headerInfo.cover_url,
      name: headerInfo.name,
      _continuationToken: continuationInfo.token || null,
    };
  } catch (e) {
    L("error", "parseBrowseResponse error", String(e));
    return null;
  }
}

async function fetchVideoMetadata(videoId) {
  var url = "https://music.youtube.com/youtubei/v1/player?alt=json";
  var body = JSON.stringify({
    context: {
      client: { clientName: "WEB_REMIX", clientVersion: CONFIG.clientVersion },
    },
    videoId: videoId,
  });

  var res = await safeFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible)",
      "x-youtube-client-name": "WEB_REMIX",
      "x-youtube-client-version": CONFIG.clientVersion,
    },
    body: body,
  });

  var data = await res.json();
  if (!data || !data.videoDetails) return null;

  var details = data.videoDetails;
  var thumb = null;
  if (
    details.thumbnail &&
    details.thumbnail.thumbnails &&
    details.thumbnail.thumbnails.length > 0
  ) {
    var lastThumb =
      details.thumbnail.thumbnails[details.thumbnail.thumbnails.length - 1];
    thumb = makeSquareThumb(lastThumb.url);
  }

  return {
    id: videoId,
    title: details.title || "Unknown",
    artist: details.author || "",
    album: "",
    duration: parseInt(details.lengthSeconds, 10) || 0,
    thumbnail: thumb,
    source: "youtube",
  };
}

function fetchVideoMetadataSync(videoId) {
  var data = fetchJSONSync(
    "https://music.youtube.com/youtubei/v1/player?alt=json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: CONFIG.clientVersion,
          },
        },
        videoId: videoId,
      }),
    },
  );
  if (!data || !data.videoDetails) return null;
  var details = data.videoDetails;
  var thumbnailURL = pickLastThumbnailUrl(
    details.thumbnail && details.thumbnail.thumbnails,
  );
  return {
    id: videoId,
    title: details.title || "Unknown title",
    artist: details.author || "",
    album: "",
    duration: parseInt(details.lengthSeconds, 10) || 0,
    thumbnail: thumbnailURL ? makeSquareThumb(thumbnailURL) : null,
    external_urls: "https://music.youtube.com/watch?v=" + videoId,
    external_links: { youtube: "https://music.youtube.com/watch?v=" + videoId },
    source: "youtube",
    item_type: "track",
  };
}

function getTrack(trackID) {
  var videoID = String(trackID || "").trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoID)) return null;
  var cached = cacheGet("yt:video:" + videoID);
  if (cached) return enrichTrack(cached);

  var raw = fetchVideoMetadataSync(videoID);
  if (!raw) return null;
  var candidates = performSearchSync(
    (raw.artist ? raw.artist + " " : "") + raw.title,
    YT_SEARCH_PARAMS.tracks,
  );
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] && candidates[i].id === videoID) {
      raw = candidates[i];
      break;
    }
  }
  var sanitized = sanitizeTrackBeforeReturn(raw);
  return sanitized ? enrichTrack(sanitized) : null;
}

function handleUrl(url) {
  L("info", "handleUrl called", url);

  var browseId = extractBrowseId(url);
  if (browseId) {
    L("info", "handleUrl: detected browseId", browseId);
    var browseResult = fetchBrowseTracksSync(browseId);
    if (browseResult) {
      return browseResult;
    }
  }

  var playlistId = extractPlaylistId(url);
  if (playlistId) {
    L("info", "handleUrl: detected playlistId", playlistId);
    var browsePL = playlistId.startsWith("VL") ? playlistId : "VL" + playlistId;
    var playlistResult = fetchBrowseTracksSync(browsePL);
    if (playlistResult) {
      return playlistResult;
    }
  }

  var videoId = extractVideoId(url);
  if (!videoId) {
    L("warn", "handleUrl: no video ID found", url);
    return null;
  }

  var key = "yt:video:" + videoId;
  var cached = cacheGet(key);
  if (cached) {
    L("info", "handleUrl: returning cached", videoId);
    return { type: "track", track: cached };
  }

  dedupFetch(key, async function () {
    try {
      var track = await fetchVideoMetadata(videoId);
      if (track) {
        var sanitized = sanitizeTrackBeforeReturn(track);
        if (sanitized) {
          cacheSet(key, sanitized);
          L("info", "handleUrl: cached video metadata", videoId);
        }
      }
    } catch (e) {
      L("error", "handleUrl fetch failed", String(e));
    }
  }).catch(function () {});

  return {
    type: "track",
    track: {
      id: videoId,
      title: "Loading...",
      artist: "",
      album: "",
      duration: 0,
      thumbnail: null,
      source: "youtube",
    },
  };
}

function getAlbum(albumId) {
  L("info", "getAlbum called", albumId);
  try {
    var result = fetchBrowseTracksSync(albumId);
    if (result && result.tracks) {
      return {
        id: albumId,
        name: result.name || "",
        artists: result.album ? result.album.artists : "",
        artist_id: result.album ? result.album.artist_id : "",
        cover_url: result.cover_url,
        release_date: result.album ? result.album.release_date : "",
        total_tracks: result.tracks.length,
        album_type: result.album ? result.album.album_type : "album",
        tracks: result.tracks,
        provider_id: "ytmusic-spotiflac",
      };
    }
    return null;
  } catch (e) {
    L("error", "getAlbum error", String(e));
    return null;
  }
}

function getPlaylist(playlistId) {
  L("info", "getPlaylist called", playlistId);
  try {
    var browseId = playlistId;
    if (!playlistId.startsWith("VL") && !playlistId.startsWith("RDCLAK5uy_")) {
      browseId = "VL" + playlistId;
    }

    var result = fetchBrowseTracksSync(browseId);
    if (result && result.tracks) {
      return {
        id: playlistId,
        name: result.name || "",
        owner: result.album ? result.album.artists : "",
        cover_url: result.cover_url,
        total_tracks: result.tracks.length,
        tracks: result.tracks,
        provider_id: "ytmusic-spotiflac",
      };
    }
    return null;
  } catch (e) {
    L("error", "getPlaylist error", String(e));
    return null;
  }
}

function getArtist(artistId) {
  L("info", "getArtist called", artistId);
  try {
    var url = "https://music.youtube.com/youtubei/v1/browse?alt=json";
    var body = JSON.stringify({
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: CONFIG.clientVersion,
        },
      },
      browseId: artistId,
    });

    var res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: body,
    });

    if (!res || !res.ok) {
      L("error", "getArtist fetch failed", res ? res.status : "no response");
      return null;
    }

    var data = res.json();
    if (!data) {
      L("error", "getArtist json parse failed");
      return null;
    }

    var artistName = "";
    var artistImage = null;
    var headerImage = null;
    var monthlyListeners = null;

    if (data.header) {
      var header =
        data.header.musicImmersiveHeaderRenderer ||
        data.header.musicVisualHeaderRenderer ||
        data.header.musicDetailHeaderRenderer;
      if (header) {
        if (header.title && header.title.runs) {
          artistName = header.title.runs
            .map(function (r) {
              return r.text;
            })
            .join("");
        }
        if (
          header.thumbnail &&
          header.thumbnail.musicThumbnailRenderer &&
          header.thumbnail.musicThumbnailRenderer.thumbnail
        ) {
          var thumbUrl = pickLastThumbnailUrl(
            header.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
          );
          artistImage = makeSquareThumb(thumbUrl);
        }
        if (
          !artistImage &&
          header.foregroundThumbnail &&
          header.foregroundThumbnail.musicThumbnailRenderer
        ) {
          var thumbUrl2 = pickLastThumbnailUrl(
            header.foregroundThumbnail.musicThumbnailRenderer.thumbnail
              .thumbnails,
          );
          artistImage = makeSquareThumb(thumbUrl2);
        }
        if (
          header.subscriptionButton &&
          header.subscriptionButton.subscribeButtonRenderer
        ) {
          var subButton = header.subscriptionButton.subscribeButtonRenderer;
          if (
            subButton.subscriberCountText &&
            subButton.subscriberCountText.runs
          ) {
            var subText = subButton.subscriberCountText.runs
              .map(function (r) {
                return r.text;
              })
              .join("");
            var subMatch = subText.match(/^([\d.]+)([KMB])?/i);
            if (subMatch) {
              var num = parseFloat(subMatch[1]);
              var mult = subMatch[2] ? subMatch[2].toUpperCase() : "";
              if (mult === "K") num *= 1000;
              else if (mult === "M") num *= 1000000;
              else if (mult === "B") num *= 1000000000;
              monthlyListeners = Math.round(num);
            }
          }
        }
      }
    }

    var topTracks = [];
    var albums = [];

    if (data.contents) {
      var sectionList = findSectionList(data.contents);
      if (sectionList && sectionList.contents) {
        for (var si = 0; si < sectionList.contents.length; si++) {
          var section = sectionList.contents[si];

          if (section.musicShelfRenderer) {
            var shelf = section.musicShelfRenderer;
            var shelfTitle = "";
            if (shelf.title && shelf.title.runs) {
              shelfTitle = shelf.title.runs
                .map(function (r) {
                  return r.text;
                })
                .join("")
                .toLowerCase();
            }

            if (
              shelfTitle.indexOf("song") !== -1 ||
              shelfTitle.indexOf("top") !== -1 ||
              shelfTitle.indexOf("popular") !== -1
            ) {
              L("info", "getArtist found songs section:", shelfTitle);
              if (shelf.contents) {
                for (
                  var ti = 0;
                  ti < shelf.contents.length && topTracks.length < 10;
                  ti++
                ) {
                  var trackNode = shelf.contents[ti];
                  var parsed = parseItemExtended(trackNode);
                  if (parsed && parsed.id) {
                    var sanitized = sanitizeTrackBeforeReturn(parsed);
                    if (sanitized) {
                      // Add artist name if missing
                      if (!sanitized.artists) {
                        sanitized.artists = artistName;
                      }
                      topTracks.push(sanitized);
                    }
                  }
                }
              }
              L("info", "getArtist found top tracks", topTracks.length);
            }
          }

          if (section.musicCarouselShelfRenderer) {
            var carousel = section.musicCarouselShelfRenderer;
            if (carousel.contents) {
              for (var ci = 0; ci < carousel.contents.length; ci++) {
                var node = carousel.contents[ci];
                var parsed = parseCollectionItem(node);
                if (
                  parsed &&
                  (parsed.item_type === "album" ||
                    parsed.item_type === "playlist")
                ) {
                  var sanitized = sanitizeCollectionBeforeReturn(parsed);
                  if (sanitized) {
                    albums.push({
                      id: sanitized.id,
                      name: sanitized.name,
                      artists: sanitized.artists || artistName,
                      cover_url: sanitized.cover_url,
                      release_date: sanitized.release_date || "",
                      total_tracks: 0,
                      album_type: sanitized.album_type || "album",
                      provider_id: "ytmusic-spotiflac",
                    });
                  }
                }
              }
            }
          }
        }
      }

      if (albums.length === 0) {
        var candidates = [];
        collectItemsFromNode(data.contents, candidates, 0);

        for (var i = 0; i < candidates.length; i++) {
          var node = candidates[i];
          var parsed = parseCollectionItem(node);
          if (
            parsed &&
            (parsed.item_type === "album" || parsed.item_type === "playlist")
          ) {
            var sanitized = sanitizeCollectionBeforeReturn(parsed);
            if (sanitized) {
              albums.push({
                id: sanitized.id,
                name: sanitized.name,
                artists: sanitized.artists || artistName,
                cover_url: sanitized.cover_url,
                release_date: sanitized.release_date || "",
                total_tracks: 0,
                album_type: sanitized.album_type || "album",
                provider_id: "ytmusic-spotiflac",
              });
            }
          }
        }
      }
    }

    L("info", "getArtist found albums", albums.length);
    L("info", "getArtist found top_tracks", topTracks.length);

    return {
      id: artistId,
      name: artistName,
      image_url: artistImage,
      header_image: headerImage,
      listeners: monthlyListeners,
      albums: albums,
      top_tracks: topTracks,
      provider_id: "ytmusic-spotiflac",
    };
  } catch (e) {
    L("error", "getArtist error", String(e));
    return null;
  }
}

function findSectionList(contents) {
  if (!contents) return null;

  if (contents.sectionListRenderer) {
    return contents.sectionListRenderer;
  }

  if (contents.singleColumnBrowseResultsRenderer) {
    var tabs = contents.singleColumnBrowseResultsRenderer.tabs;
    if (tabs && tabs[0] && tabs[0].tabRenderer && tabs[0].tabRenderer.content) {
      if (tabs[0].tabRenderer.content.sectionListRenderer) {
        return tabs[0].tabRenderer.content.sectionListRenderer;
      }
    }
  }

  if (contents.twoColumnBrowseResultsRenderer) {
    var secondaryContents =
      contents.twoColumnBrowseResultsRenderer.secondaryContents;
    if (secondaryContents && secondaryContents.sectionListRenderer) {
      return secondaryContents.sectionListRenderer;
    }
    var tabs = contents.twoColumnBrowseResultsRenderer.tabs;
    if (tabs && tabs[0] && tabs[0].tabRenderer && tabs[0].tabRenderer.content) {
      if (tabs[0].tabRenderer.content.sectionListRenderer) {
        return tabs[0].tabRenderer.content.sectionListRenderer;
      }
    }
  }

  return null;
}

function fetchJSONSync(url, options) {
  try {
    var response = fetch(
      url,
      options || {
        method: "GET",
        headers: { "User-Agent": getRandomUserAgent() },
      },
    );
    if (!response || !response.ok) return null;
    var data = response.json();
    return data && !data.error ? data : null;
  } catch (e) {
    L("debug", "fetchJSONSync failed", url, String(e));
    return null;
  }
}

function metadataMatchValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function primaryArtistMatches(expected, actual) {
  var expectedPrimary = String(expected || "").split(
    /\s*,\s*|\s+feat\.?\s+|\s+ft\.?\s+/i,
  )[0];
  return metadataMatchValue(expectedPrimary) === metadataMatchValue(actual);
}

function parseTrackCredits(data) {
  var result = {
    title: "",
    artists: "",
    composer: "",
    producer: "",
    release_date: "",
    cover_url: null,
  };
  var actions = data && data.onResponseReceivedActions;
  if (!Array.isArray(actions)) return result;
  for (var ai = 0; ai < actions.length; ai++) {
    var dialog =
      actions[ai] &&
      actions[ai].openPopupAction &&
      actions[ai].openPopupAction.popup &&
      actions[ai].openPopupAction.popup.dismissableDialogRenderer;
    if (!dialog) continue;
    var metadata =
      dialog.metadata && dialog.metadata.musicMultiRowListItemRenderer;
    if (metadata) {
      result.title = runsText((metadata.title && metadata.title.runs) || []);
      result.artists = runsText(
        (metadata.subtitle && metadata.subtitle.runs) || [],
      );
      var secondTitle = runsText(
        (metadata.secondTitle && metadata.secondTitle.runs) || [],
      );
      var yearMatch = secondTitle.match(/\b(19|20)\d{2}\b/);
      if (yearMatch) result.release_date = yearMatch[0];
      var thumbnailURL = pickLastThumbnailUrl(
        metadata.thumbnail &&
          metadata.thumbnail.musicThumbnailRenderer &&
          metadata.thumbnail.musicThumbnailRenderer.thumbnail &&
          metadata.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails,
      );
      if (thumbnailURL) result.cover_url = makeSquareThumb(thumbnailURL);
    }
    var sections = dialog.sections || [];
    for (var si = 0; si < sections.length; si++) {
      var section =
        sections[si] && sections[si].dismissableDialogContentSectionRenderer;
      if (!section) continue;
      var role = runsText(
        (section.title && section.title.runs) || [],
      ).toLowerCase();
      var names = uniqueStrings(
        ((section.subtitle && section.subtitle.runs) || []).map(function (run) {
          return String((run && run.text) || "").trim();
        }),
      ).join("; ");
      if (/written by|songwriters?|composers?|lyrics by/.test(role)) {
        result.composer = names;
      } else if (/produced by|producers?/.test(role)) {
        result.producer = names;
      } else if (/performed by|artists?/.test(role) && !result.artists) {
        result.artists = names;
      }
    }
    break;
  }
  return result;
}

function fetchTrackCreditsSync(videoID) {
  var cacheKey = "yt:credits:" + videoID;
  var cached = cacheGet(cacheKey);
  if (cached) return cached;
  var data = fetchJSONSync(
    "https://music.youtube.com/youtubei/v1/browse?alt=json",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": getRandomUserAgent(),
        "x-youtube-client-name": "WEB_REMIX",
        "x-youtube-client-version": CONFIG.clientVersion,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB_REMIX",
            clientVersion: CONFIG.clientVersion,
            hl: "en",
            gl: "US",
          },
        },
        browseId: "MPTC" + videoID,
      }),
    },
  );
  var result = parseTrackCredits(data);
  cacheSet(cacheKey, result);
  return result;
}

function normalizeDeezerAlbumType(value) {
  var type = String(value || "album").toLowerCase();
  if (type === "ep" || type === "single") return type;
  return "album";
}

function deezerComposerNames(trackData) {
  var contributors = (trackData && trackData.contributors) || [];
  var names = [];
  for (var i = 0; i < contributors.length; i++) {
    var role = String(
      (contributors[i] && contributors[i].role) || "",
    ).toLowerCase();
    if (/composer|songwriter|writer|author/.test(role))
      names.push(contributors[i].name);
  }
  return uniqueStrings(names).join("; ");
}

function fetchValidatedDeezerMetadata(track) {
  var title = String(track.name || track.title || "").trim();
  var artists = String(track.artists || track.artist || "").trim();
  var albumName = String(track.album_name || track.album || "").trim();
  var durationSeconds =
    Math.round(Number(track.duration_ms || 0) / 1000) ||
    Number(track.duration || 0) ||
    0;
  if (!title || !artists) return null;

  var query =
    'track:"' +
    title.replace(/"/g, "") +
    '" artist:"' +
    artists.split(",")[0].replace(/"/g, "") +
    '"';
  if (albumName) query += ' album:"' + albumName.replace(/"/g, "") + '"';
  var search = fetchJSONSync(
    "https://api.deezer.com/search?q=" +
      encodeURIComponent(query) +
      "&limit=10",
  );
  if (!search || !Array.isArray(search.data)) return null;

  var candidate = null;
  for (var i = 0; i < search.data.length; i++) {
    var item = search.data[i];
    if (metadataMatchValue(item.title) !== metadataMatchValue(title)) continue;
    if (!primaryArtistMatches(artists, item.artist && item.artist.name))
      continue;
    if (
      albumName &&
      metadataMatchValue(item.album && item.album.title) !==
        metadataMatchValue(albumName)
    )
      continue;
    if (
      durationSeconds &&
      item.duration &&
      Math.abs(Number(item.duration) - durationSeconds) > 5
    )
      continue;
    candidate = item;
    break;
  }
  if (!candidate) return null;

  var trackData = fetchJSONSync(
    "https://api.deezer.com/track/" + encodeURIComponent(String(candidate.id)),
  );
  if (
    !trackData ||
    metadataMatchValue(trackData.title) !== metadataMatchValue(title) ||
    !primaryArtistMatches(artists, trackData.artist && trackData.artist.name)
  )
    return null;
  if (
    durationSeconds &&
    trackData.duration &&
    Math.abs(Number(trackData.duration) - durationSeconds) > 5
  )
    return null;

  var deezerAlbumName = String(
    (trackData.album && trackData.album.title) ||
      (candidate.album && candidate.album.title) ||
      "",
  );
  var sameAlbum =
    !!albumName &&
    metadataMatchValue(deezerAlbumName) === metadataMatchValue(albumName);
  var albumData =
    sameAlbum && trackData.album && trackData.album.id
      ? fetchJSONSync(
          "https://api.deezer.com/album/" +
            encodeURIComponent(String(trackData.album.id)),
        )
      : null;
  if (
    albumData &&
    metadataMatchValue(albumData.title) !== metadataMatchValue(albumName)
  )
    albumData = null;

  var deezerURL = String(
    trackData.link || "https://www.deezer.com/track/" + candidate.id,
  );
  var result = {
    isrc: String(trackData.isrc || "").trim(),
    preview_url: String(trackData.preview || "").trim(),
    explicit: trackData.explicit_lyrics === true,
    deezer_id: String(candidate.id),
    deezer_url: deezerURL,
    composer: deezerComposerNames(trackData),
  };
  if (albumData) {
    result.album_artist = String(
      (albumData.artist && albumData.artist.name) || "",
    ).trim();
    result.release_date = String(albumData.release_date || "").trim();
    result.track_number = Number(trackData.track_position || 0) || 0;
    result.total_tracks = Number(albumData.nb_tracks || 0) || 0;
    result.disc_number = Number(trackData.disk_number || 0) || 0;
    result.total_discs = 1;
    if (albumData.tracks && Array.isArray(albumData.tracks.data)) {
      for (var ti = 0; ti < albumData.tracks.data.length; ti++) {
        result.total_discs = Math.max(
          result.total_discs,
          Number(albumData.tracks.data[ti].disk_number || 1),
        );
      }
    }
    result.album_type = normalizeDeezerAlbumType(albumData.record_type);
    result.upc = String(albumData.upc || "").trim();
    result.label = String(albumData.label || "").trim();
    result.copyright = String(albumData.copyright || "").trim();
    var genres = (albumData.genres && albumData.genres.data) || [];
    result.genre = uniqueStrings(
      genres.map(function (genre) {
        return genre && genre.name;
      }),
    ).join("; ");
  }
  return result;
}

function enrichTrack(track) {
  L("info", "enrichTrack called", track ? track.id : "null");
  if (!track || !track.id) return track;

  var cacheKey = "yt:enrichment:" + track.id;
  var cached = cacheGet(cacheKey);
  if (cached) return Object.assign({}, track, cached);

  var youtubeURL =
    "https://music.youtube.com/watch?v=" + encodeURIComponent(track.id);
  var enrichment = {
    external_urls: youtubeURL,
    external_links: Object.assign({}, track.external_links || {}, {
      youtube: youtubeURL,
    }),
  };

  var credits = fetchTrackCreditsSync(String(track.id));
  if (credits) {
    if (credits.composer) enrichment.composer = credits.composer;
    if (!track.artists && credits.artists) enrichment.artists = credits.artists;
    if (!track.name && credits.title) enrichment.name = credits.title;
    if (!track.release_date && credits.release_date)
      enrichment.release_date = credits.release_date;
    if (!track.cover_url && credits.cover_url)
      enrichment.cover_url = credits.cover_url;
  }

  var albumID = String(track.album_id || "").trim();
  if (albumID.startsWith("MPREb_")) {
    var nativeAlbum = _fetchAlbumHeaderMetadata(albumID);
    if (nativeAlbum) {
      if (!track.album_name && nativeAlbum.name)
        enrichment.album_name = nativeAlbum.name;
      if (!track.album_artist && nativeAlbum.artists)
        enrichment.album_artist = nativeAlbum.artists;
      if (!track.artist_id && nativeAlbum.artist_id)
        enrichment.artist_id = nativeAlbum.artist_id;
      if (!track.artist_url && nativeAlbum.artist_id)
        enrichment.artist_url =
          "https://music.youtube.com/channel/" + nativeAlbum.artist_id;
      if (!track.release_date && nativeAlbum.release_date)
        enrichment.release_date = nativeAlbum.release_date;
      if (!track.album_type && nativeAlbum.album_type)
        enrichment.album_type = nativeAlbum.album_type;
      if (!track.total_tracks && nativeAlbum.total_tracks)
        enrichment.total_tracks = nativeAlbum.total_tracks;
      if (!track.cover_url && nativeAlbum.cover_url)
        enrichment.cover_url = nativeAlbum.cover_url;
    }
  }

  var lookupTrack = Object.assign({}, track, enrichment);
  var deezer = fetchValidatedDeezerMetadata(lookupTrack);
  if (deezer) {
    if (deezer.isrc) enrichment.isrc = deezer.isrc;
    if (deezer.preview_url) enrichment.preview_url = deezer.preview_url;
    if (!enrichment.composer && !track.composer && deezer.composer)
      enrichment.composer = deezer.composer;
    if (deezer.explicit) enrichment.explicit = true;
    enrichment.deezer_id = deezer.deezer_id;
    enrichment.external_links.deezer = deezer.deezer_url;
    var albumFields = [
      "album_artist",
      "track_number",
      "total_tracks",
      "disc_number",
      "total_discs",
      "album_type",
      "upc",
      "label",
      "copyright",
      "genre",
    ];
    for (var fi = 0; fi < albumFields.length; fi++) {
      var field = albumFields[fi];
      if (
        (!track[field] ||
          field === "genre" ||
          field === "label" ||
          field === "copyright" ||
          field === "upc") &&
        deezer[field]
      ) {
        enrichment[field] = deezer[field];
      }
    }
    if (
      deezer.release_date &&
      (!track.release_date || /^\d{4}$/.test(String(track.release_date)))
    ) {
      enrichment.release_date = deezer.release_date;
    }
  }

  cacheSet(cacheKey, enrichment);
  L("info", "enrichTrack: success", {
    id: track.id,
    hasComposer: !!enrichment.composer,
    hasIsrc: !!enrichment.isrc,
    hasGenre: !!enrichment.genre,
  });
  return Object.assign({}, track, enrichment);
}

var YT_API_KEY = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";

function getTimeBasedGreeting() {
  var localTime = gobackend.getLocalTime();
  var hour = localTime.hour;

  L(
    "debug",
    "getTimeBasedGreeting: localHour=" +
      hour +
      ", timezone=" +
      localTime.timezone,
  );

  if (hour >= 5 && hour < 12) {
    return "Good morning";
  } else if (hour >= 12 && hour < 17) {
    return "Good afternoon";
  } else if (hour >= 17 && hour < 21) {
    return "Good evening";
  } else {
    return "Good night";
  }
}

function parseHomeFeedSection(section) {
  try {
    var sectionRenderer =
      section.musicCarouselShelfRenderer || section.musicShelfRenderer;
    if (!sectionRenderer) return null;

    var title = "";
    var header = sectionRenderer.header;
    if (header) {
      var headerRenderer =
        header.musicCarouselShelfBasicHeaderRenderer ||
        header.musicShelfBasicHeaderRenderer;
      if (
        headerRenderer &&
        headerRenderer.title &&
        headerRenderer.title.runs &&
        headerRenderer.title.runs[0]
      ) {
        title = headerRenderer.title.runs[0].text;
      }
    }

    if (!title) return null;

    var contents = sectionRenderer.contents || [];
    var items = [];

    for (var i = 0; i < contents.length && items.length < 20; i++) {
      var item = parseHomeFeedItem(contents[i]);
      if (item) items.push(item);
    }

    if (items.length === 0) return null;

    return {
      uri: "",
      title: title,
      items: items,
    };
  } catch (e) {
    L("warn", "parseHomeFeedSection error", String(e));
    return null;
  }
}

function parseHomeFeedItem(itemContainer) {
  try {
    var item =
      itemContainer.musicTwoRowItemRenderer ||
      itemContainer.musicResponsiveListItemRenderer ||
      itemContainer.musicNavigationButtonRenderer;

    if (!item) return null;

    var name = "";
    if (item.title && item.title.runs && item.title.runs[0]) {
      name = item.title.runs[0].text;
    }
    if (!name && item.flexColumns && item.flexColumns[0]) {
      var fcr = item.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
      if (fcr && fcr.text && fcr.text.runs && fcr.text.runs[0]) {
        name = fcr.text.runs[0].text;
      }
    }

    if (!name) return null;

    var artists = "";
    var durationMs = 0;
    if (item.subtitle && item.subtitle.runs) {
      var artistParts = [];
      for (var i = 0; i < item.subtitle.runs.length; i++) {
        var run = item.subtitle.runs[i];
        if (run && run.text) {
          var txt = run.text.trim();
          if (txt === "•" || txt === " • " || txt === "," || txt === " & ")
            continue;
          var lowerTxt = txt.toLowerCase();
          if (
            lowerTxt === "single" ||
            lowerTxt === "album" ||
            lowerTxt === "ep" ||
            lowerTxt === "playlist" ||
            lowerTxt === "video" ||
            lowerTxt === "song" ||
            lowerTxt === "artist"
          )
            continue;
          if (/^\d{4}$/.test(txt)) continue;
          if (
            /^\d+(\.\d+)?[KMB]?\s*(views|plays|listeners|subscribers)/i.test(
              txt,
            )
          )
            continue;
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(txt)) {
            var durationSec = parseDurationText(txt);
            if (durationSec > 0) {
              durationMs = durationSec * 1000;
            }
            continue;
          }
          if (txt.length > 1) artistParts.push(txt);
        }
      }
      artists = artistParts.join(", ");
    }

    var itemType = "track";
    var itemId = "";
    var albumId = "";
    var albumName = "";

    var navEp = item.navigationEndpoint;
    if (navEp) {
      if (navEp.watchEndpoint && navEp.watchEndpoint.videoId) {
        itemType = "track";
        itemId = navEp.watchEndpoint.videoId;
        if (navEp.watchEndpoint.playlistId) {
          var plId = navEp.watchEndpoint.playlistId;
          if (plId.startsWith("OLAK5uy_")) {
            albumId = plId;
          }
        }
      } else if (navEp.browseEndpoint && navEp.browseEndpoint.browseId) {
        var browseId = navEp.browseEndpoint.browseId;
        itemId = browseId;

        if (browseId.startsWith("MPREb_")) {
          itemType = "album";
        } else if (
          browseId.startsWith("VL") ||
          browseId.startsWith("PL") ||
          browseId.startsWith("RDCLAK")
        ) {
          itemType = "playlist";
        } else if (browseId.startsWith("UC")) {
          itemType = "artist";
        }
      }
    }

    if (
      !itemId &&
      item.overlay &&
      item.overlay.musicItemThumbnailOverlayRenderer
    ) {
      var overlay = item.overlay.musicItemThumbnailOverlayRenderer;
      if (overlay.content && overlay.content.musicPlayButtonRenderer) {
        var playNav =
          overlay.content.musicPlayButtonRenderer.playNavigationEndpoint;
        if (playNav && playNav.watchEndpoint && playNav.watchEndpoint.videoId) {
          itemType = "track";
          itemId = playNav.watchEndpoint.videoId;
        }
      }
    }

    if (!itemId) return null;

    var coverUrl = null;
    if (
      item.thumbnailRenderer &&
      item.thumbnailRenderer.musicThumbnailRenderer
    ) {
      var thumbs = item.thumbnailRenderer.musicThumbnailRenderer.thumbnail;
      if (thumbs && thumbs.thumbnails && thumbs.thumbnails.length > 0) {
        coverUrl = thumbs.thumbnails[thumbs.thumbnails.length - 1].url;
      }
    }
    if (!coverUrl && item.thumbnail && item.thumbnail.musicThumbnailRenderer) {
      var thumbs2 = item.thumbnail.musicThumbnailRenderer.thumbnail;
      if (thumbs2 && thumbs2.thumbnails && thumbs2.thumbnails.length > 0) {
        coverUrl = thumbs2.thumbnails[thumbs2.thumbnails.length - 1].url;
      }
    }

    if (coverUrl) {
      coverUrl = makeSquareThumb(coverUrl);
    }

    return {
      id: itemId,
      uri: "ytmusic:" + itemType + ":" + itemId,
      type: itemType,
      name: name,
      artists: artists,
      description: "",
      cover_url: coverUrl,
      album_id: albumId,
      album_name: albumName,
      duration_ms: durationMs,
      provider_id: "ytmusic-spotiflac",
    };
  } catch (e) {
    L("warn", "parseHomeFeedItem error", String(e));
    return null;
  }
}

function getHomeFeed() {
  L("info", "getHomeFeed called");

  var cacheKey = "ytmusic:homefeed:" + CONFIG.homeCountry;
  var cached = cacheGet(cacheKey);
  if (cached) {
    L("debug", "getHomeFeed returning cached data");
    return cached;
  }

  try {
    var url = "https://music.youtube.com/youtubei/v1/browse?key=" + YT_API_KEY;
    var body = JSON.stringify({
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: CONFIG.clientVersion,
          hl: "en",
          gl: CONFIG.homeCountry,
        },
      },
      browseId: "FEmusic_home",
    });

    var res = fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://music.youtube.com",
        Referer: "https://music.youtube.com/",
        "User-Agent": getRandomUserAgent(),
      },
      body: body,
    });

    if (!res || !res.ok) {
      L("error", "getHomeFeed fetch failed", res ? res.status : "no response");
      return {
        success: false,
        error: "Failed to fetch home feed",
        sections: [],
      };
    }

    var data = res.json();
    if (!data) {
      L("error", "getHomeFeed json parse failed");
      return {
        success: false,
        error: "Failed to parse response",
        sections: [],
      };
    }

    var sections = [];

    var sectionList = null;
    if (data.contents && data.contents.singleColumnBrowseResultsRenderer) {
      var tabs = data.contents.singleColumnBrowseResultsRenderer.tabs;
      if (
        tabs &&
        tabs[0] &&
        tabs[0].tabRenderer &&
        tabs[0].tabRenderer.content
      ) {
        sectionList = tabs[0].tabRenderer.content.sectionListRenderer;
      }
    }

    if (sectionList && sectionList.contents) {
      for (
        var i = 0;
        i < sectionList.contents.length && sections.length < 10;
        i++
      ) {
        var sectionData = sectionList.contents[i];
        var section = parseHomeFeedSection(sectionData);
        if (section) {
          sections.push(section);
        }
      }
    }

    L("info", "getHomeFeed parsed", sections.length, "sections");

    var result = {
      success: true,
      greeting: getTimeBasedGreeting(),
      sections: sections,
    };

    cacheSet(cacheKey, result);

    return result;
  } catch (e) {
    L("error", "getHomeFeed error", String(e));
    return { success: false, error: String(e), sections: [] };
  }
}

registerExtension({
  initialize: function (settings) {
    settings = settings || {};
    var homeCountry = String(readSetting(settings, "homeCountry", "ID"))
      .trim()
      .toUpperCase();
    CONFIG.homeCountry = /^[A-Z]{2}$/.test(homeCountry) ? homeCountry : "ID";
    var poTokenMode = String(
      readSetting(settings, "poTokenMode", CONFIG.poTokenMode) || "",
    )
      .trim()
      .toLowerCase();
    if (
      poTokenMode === "off" ||
      poTokenMode === "auto" ||
      poTokenMode === "external" ||
      poTokenMode === "manual"
    ) {
      CONFIG.poTokenMode = poTokenMode;
    }
    CONFIG.poTokenProviderURL = normalizePoTokenProviderURL(
      readSetting(settings, "poTokenProviderUrl", CONFIG.poTokenProviderURL),
    );
    CONFIG.manualGvsPoToken = String(
      readSetting(settings, "manualGvsPoToken", CONFIG.manualGvsPoToken) || "",
    ).trim();
    CONFIG.logLevel = normalizeLogLevel(
      readSetting(settings, "logLevel", CONFIG.logLevel),
    );
    L("info", "YouTube Music extension init", {
      poTokenMode: CONFIG.poTokenMode,
      hasProvider: !!CONFIG.poTokenProviderURL,
      hasManualToken: !!CONFIG.manualGvsPoToken,
    });
    return true;
  },
  customSearch: function (query, options) {
    L("info", "customSearch", query, "options:", JSON.stringify(options));
    try {
      return customSearchSync(query, options);
    } catch (e) {
      L("error", "customSearch fatal", String(e));
      return [];
    }
  },
  handleUrl: handleUrl,
  getTrack: getTrack,
  getAlbum: getAlbum,
  getPlaylist: getPlaylist,
  getArtist: getArtist,
  getHomeFeed: getHomeFeed,
  getRelatedTracks: getRelatedTracks,
  enrichTrack: enrichTrack,
  validateTrackForDownload: validateTrackForDownload,
  finalGuardBeforeNative: finalGuardBeforeNative,
  matchTrack: function () {
    return null;
  },

  // ---- Download Provider Functions ----

  checkAvailability: function (isrc, trackName, artistName, options) {
    L("info", "[YTMusic] checkAvailability:", isrc, trackName, artistName);

    var spotifyId = options && options.spotify_id ? options.spotify_id : null;
    var source = String(options && options.track && options.track.provider_id || "").trim().toLowerCase();
    var directTrack = source === "ytmusic-spotiflac" || (!source && !trackName && !artistName);
    if (directTrack && spotifyId && /^[A-Za-z0-9_-]{11}$/.test(spotifyId)) {
      L("info", "[YTMusic] spotify_id looks like a video ID:", spotifyId);
      return { available: true, track_id: spotifyId };
    }

    var albumName = options && (options.album_name || options.albumName ||
      options.track && (options.track.album_name || options.track.albumName)) || "";
    var resolvedTrackName = downloadTitleWithoutAlbumSuffix(trackName, albumName);
    var query = (artistName ? artistName + " " : "") + (resolvedTrackName || "");
    if (!query.trim()) {
      return { available: false, reason: "no_search_query" };
    }

    try {
      var queries = [query.trim()];
      var strippedTitle = stripTrackTitleAnnotations(resolvedTrackName).replace(/\s+/g, " ").trim();
      if (strippedTitle && strippedTitle !== String(resolvedTrackName || "").trim()) {
        var strippedQuery = ((artistName ? artistName + " " : "") + strippedTitle).trim();
        if (queries.indexOf(strippedQuery) < 0) queries.push(strippedQuery);
      }
      // Artist + native title can yield no results when the provider indexes
      // the artist only in another script. Retry the title by itself; the
      // strict title/artist/duration validator below still decides identity.
      var titleOnlyQuery = String(resolvedTrackName || "").trim();
      if (titleOnlyQuery && queries.indexOf(titleOnlyQuery) < 0) {
        queries.push(titleOnlyQuery);
      }
      var punctuationFreeTitle = titleOnlyQuery
        .replace(/[、，,。・:：]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (punctuationFreeTitle && queries.indexOf(punctuationFreeTitle) < 0) {
        queries.push(punctuationFreeTitle);
      }
      var durationMs = Number(options && (options.duration_ms || options.track && options.track.duration_ms) || 0);
      for (var queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        if (utils && typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled()) {
          return { available: false, reason: "download cancelled" };
        }
        var results = performSearchSync(queries[queryIndex], YT_SEARCH_PARAMS.tracks) || [];
        for (var i = 0; i < results.length; i++) {
          var item = results[i];
          if (item && item.id && (item.item_type === "track" || item.type === "track") &&
              downloadRecordingMatches(resolvedTrackName, artistName, durationMs, item, albumName)) {
            L("info", "[YTMusic] Found verified track:", item.id, item.name || item.title);
            return { available: true, track_id: item.id };
          }
        }
      }


      // Some legitimate catalog versions (especially older remixes) are
      // indexed only as music videos. Search that index after the Songs
      // results, but keep the same exact-title, artist-credit and duration
      // checks so live, short, karaoke and unrelated uploads stay rejected.
      for (var videoQueryIndex = 0; videoQueryIndex < queries.length; videoQueryIndex++) {
        if (utils && typeof utils.isDownloadCancelled === "function" && utils.isDownloadCancelled()) {
          return { available: false, reason: "download cancelled" };
        }
        var videoResults = performSearchSync(queries[videoQueryIndex], YT_SEARCH_PARAMS.videos) || [];
        for (var videoIndex = 0; videoIndex < videoResults.length; videoIndex++) {
          var videoItem = videoResults[videoIndex];
          if (videoItem && videoItem.id &&
              downloadRecordingMatches(resolvedTrackName, artistName, durationMs, videoItem, albumName)) {
            L("info", "[YTMusic] Found verified video track:", videoItem.id, videoItem.name || videoItem.title);
            return { available: true, track_id: videoItem.id };
          }
        }
      }

      return { available: false, reason: "No verified YouTube Music track match found" };
    } catch (e) {
      L("error", "[YTMusic] checkAvailability error:", String(e));
      return { available: false, reason: "search_error: " + String(e) };
    }
  },

  download: function (trackID, quality, outputPath, onProgress) {
    L("info", "[YTMusic] download called:", trackID, quality, outputPath);

    var videoID = String(trackID || "").trim();
    if (!videoID) {
      return {
        success: false,
        error_message: "No video ID provided",
        error_type: "invalid_input",
      };
    }

    var youtubeURL = "https://music.youtube.com/watch?v=" + videoID;
    var downloadURL = null;
    var actualOutputExt = ".mp3";
    var downloadSource = "";
    var downloadOptions = {};
    var downloadCoverUrl = resolveDownloadCoverUrl(videoID);
    var pageInfo = { visitorData: "", playerUrl: "" };
    try {
      pageInfo = getYouTubePageInfo(videoID);
    } catch (pageErr) {
      L("warn", "[YTMusic] page info failed:", String(pageErr));
    }

    var directDownloadResult = null;
    try {
      directDownloadResult = tryInnerTubeDownloadsLazily(
        videoID,
        pageInfo,
        outputPath,
        youtubeURL,
        downloadCoverUrl,
      );
    } catch (innerTubeError) {
      L(
        "warn",
        "[YTMusic] Lazy InnerTube download failed:",
        String(innerTubeError),
      );
    }
    if (directDownloadResult && directDownloadResult.success)
      return directDownloadResult;

    if (!downloadURL) {
      L("info", "[YTMusic] Downloading via Cobalt for video:", videoID);
      try {
        var cobaltResult = requestCobaltAudioDownload(youtubeURL);
        downloadURL = cobaltResult.url;
        actualOutputExt = cobaltResult.extension || ".opus";
        downloadSource = "cobalt";
        downloadOptions = {};
        L("info", "[YTMusic] Cobalt OK, ext:", actualOutputExt);
      } catch (cobaltError) {
        L("error", "[YTMusic] Cobalt failed:", String(cobaltError));
      }
    }

    // Fallback download via yt1d. This endpoint has drifted before, so keep it
    // behind Cobalt instead of making users wait on it first.
    if (!downloadURL) {
      L("info", "[YTMusic] Downloading via yt1d for video:", videoID);
    }
    try {
      if (!downloadURL) {
        L("info", "[YTMusic] Requesting yt1d:", youtubeURL);
        var yt1dResult = requestYt1dAudioDownload(youtubeURL);
        downloadURL = yt1dResult.url;
        actualOutputExt = yt1dResult.extension || ".mp3";
        downloadSource = "yt1d";
        downloadOptions = {};
        L("info", "[YTMusic] yt1d OK, ext:", actualOutputExt);
      }
    } catch (e2) {
      L("error", "[YTMusic] yt1d failed:", String(e2));
    }

    if (!downloadURL) {
      return {
        success: false,
        error_message: "All download sources failed for video: " + videoID,
        error_type: "api_error",
      };
    }

    L(
      "info",
      "[YTMusic] Downloading via",
      downloadSource,
      "to extension:",
      actualOutputExt,
    );
    var downloadAttempt = downloadAudioURL(
      downloadURL,
      outputPath,
      actualOutputExt,
      downloadOptions,
    );
    var downloadResult = downloadAttempt.result;
    var actualOutputPath = downloadAttempt.path;

    if (
      (!downloadResult || !downloadResult.success) &&
      downloadSource === "cobalt"
    ) {
      var cobaltDownloadError = downloadResult
        ? downloadResult.error
        : "file.download returned null";
      L(
        "warn",
        "[YTMusic] Cobalt URL download failed, trying yt1d fallback:",
        cobaltDownloadError,
      );
      try {
        var fallbackYt1dResult = requestYt1dAudioDownload(youtubeURL);
        downloadURL = fallbackYt1dResult.url;
        actualOutputExt = fallbackYt1dResult.extension || ".mp3";
        downloadSource = "yt1d";
        downloadOptions = {};
        downloadAttempt = downloadAudioURL(
          downloadURL,
          outputPath,
          actualOutputExt,
          downloadOptions,
        );
        downloadResult = downloadAttempt.result;
        actualOutputPath = downloadAttempt.path;
      } catch (fallbackError) {
        L(
          "error",
          "[YTMusic] yt1d fallback after Cobalt download failure failed:",
          String(fallbackError),
        );
      }
    }

    if (!downloadResult || !downloadResult.success) {
      var errMsg = downloadResult
        ? downloadResult.error
        : "file.download returned null";
      return {
        success: false,
        error_message:
          "Failed to download file via " + downloadSource + ": " + errMsg,
        error_type: "download_error",
      };
    }

    L(
      "info",
      "[YTMusic] Download complete for video:",
      videoID,
      "via",
      downloadSource,
    );
    return buildDownloadSuccess(
      downloadResult.path || actualOutputPath,
      downloadCoverUrl,
    );
  },

  getDownloadUrl: function () {
    return null;
  },

  cleanup: function () {
    _cache.clear();
    _poTokenCache.clear();
    _inflight.clear();
    L("info", "YouTube Music extension cleanup");
    return true;
  },
});
