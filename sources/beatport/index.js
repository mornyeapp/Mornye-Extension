/* Mornye Beatport extension. Provider credentials stay on the server. */
(function () {
  "use strict";
  var PROVIDER = "beatport", resolved = {};
  function id(value) {
    var raw = String(value || "").trim().replace(/^beatport:/, "");
    if (!/^[1-9]\d{0,14}$/.test(raw)) throw new Error("Invalid Beatport ID");
    return raw;
  }
  function pref(value) { return value ? "beatport:" + id(value) : ""; }
  function names(list) { return (list || []).map(function (a) { return String(a.name || ""); }).filter(Boolean).join(", "); }
  function fail(response) {
    var data = {}; try { data = JSON.parse(response.body || "{}"); } catch (_) {}
    var verify = response.needsVerification || data.code === "VERIFICATION_REQUIRED";
    var error = new Error(verify ? "Verification required" : data.error || response.error || "Beatport request failed");
    error.needsVerification = !!verify;
    error.code = String(data.code || response.code || "");
    error.status = response.statusCode || response.status || 0;
    error.retryAfterSeconds = Math.max(0, Number(data.retry_after_seconds || response.retryAfterSeconds || 0));
    error.retryable = !!(data.retryable || response.retryable);
    throw error;
  }
  function request(method, path, body, headers) {
    if (typeof session === "undefined" || typeof session.signedFetch !== "function") throw new Error("Mornye 5.3.0 or newer is required");
    var r = session.signedFetch(method, path, body || null, headers || {});
    if (!r || r.error || r.needsVerification || r.statusCode !== 200) fail(r || {});
    return JSON.parse(r.body || "{}");
  }
  function get(path) {
    var parts = path.split("?"), route = parts[0].split("/"), body = {};
    if (route[0] === "search") body.action = "search";
    else {
      body.action = { tracks: "track", artists: "artist", releases: "release" }[route[0]];
      body.id = id(route[1]);
      if (route[2]) body.action = "artist-" + route[2];
    }
    if (parts[1]) parts[1].split("&").forEach(function (pair) {
      var i = pair.indexOf("="), key = pair.slice(0, i), value = decodeURIComponent(pair.slice(i + 1));
      if (["q", "type", "limit", "page"].indexOf(key) >= 0) body[key] = key === "limit" || key === "page" ? Number(value) : value;
    });
    return request("POST", "/btp/catalog", body);
  }
  function track(t) {
    var title = String(t.title || "").trim(), mix = String(t.mix_name || "").trim();
    if (mix && title.toLowerCase().indexOf(mix.toLowerCase()) < 0) title += " (" + mix + ")";
    return { id: pref(t.id), name: title, artists: names(t.artists), album_name: t.album || "",
      album_artist: names(t.artists), artist_id: t.artists && t.artists.length ? pref(t.artists[0].id) : "",
      album_id: t.album_id ? pref(t.album_id) : "", album_url: t.album_id ? "https://www.beatport.com/release/release/" + t.album_id : "",
      duration_ms: Number(t.duration_ms) || 0, cover_url: t.cover || "", images: t.cover || "",
      release_date: t.release_date || "", track_number: Number(t.track_number) || 0, disc_number: 1,
      total_discs: 1, total_tracks: Number(t.total_tracks) || 0, isrc: t.isrc || "", upc: t.upc || "",
      explicit: t.explicit === true, provider_id: PROVIDER, item_type: "track", external_urls: t.url || "",
      external_links: { beatport: t.url || "" }, genre: t.genre || "", label: t.label || "",
      comment: [t.bpm ? "BPM: " + t.bpm : "", t.key ? "Key: " + t.key : "", t.camelot ? "Camelot: " + t.camelot : ""].filter(Boolean).join("; ") };
  }
  function album(r) {
    var result = { id: pref(r.id), name: r.name || "", artists: names(r.artists), album_artist: names(r.artists),
      artist_id: r.artists && r.artists.length ? pref(r.artists[0].id) : "", cover_url: r.cover || "", images: r.cover || "",
      release_date: r.release_date || "", total_tracks: Number(r.total_tracks) || 0, album_type: "album",
      label: r.label || "", upc: r.upc || "", explicit: r.explicit === true, description: r.description || "",
      provider_id: PROVIDER, item_type: "album", external_urls: r.url || "", album_url: r.url || "" };
    result.tracks = (r.tracks || []).map(function (t) {
      var v = track(t); v.total_tracks = result.total_tracks; v.album_artist = result.artists || v.artists;
      v.upc = result.upc; return v;
    });
    return result;
  }
  function artist(a) {
    return { id: pref(a.id), name: a.name || "", image_url: a.image || "", images: a.image || "", cover_url: a.image || "",
      provider_id: PROVIDER, item_type: "artist", external_urls: a.url || "", description: a.description || "" };
  }
  function customSearch(query, options) {
    query = String(query || "").trim(); if (!query) return [];
    options = options || {};
    var limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 20)));
    var filters = { track: "tracks", songs: "tracks", tracks: "tracks", album: "releases", albums: "releases", release: "releases", artist: "artists", artists: "artists", all: "all" };
    var type = filters[String(options.filter || "all").toLowerCase()]; if (!type) return [];
    var page = Math.max(1, Math.min(100, Math.floor((Number(options.offset) || 0) / limit) + 1));
    var result = get("search?q=" + encodeURIComponent(query) + "&type=" + type + "&limit=" + limit + "&page=" + page);
    return (result.tracks || []).map(track).concat((result.artists || []).map(artist), (result.releases || []).map(album));
  }
  function getTrack(value) { return track(get("tracks/" + id(value))); }
  function getAlbum(value) { return album(get("releases/" + id(value))); }
  function getArtist(value) {
    var cursor = /^artist-albums:([1-9]\d{0,14}):([1-9]\d{0,2})$/.exec(String(value));
    var aid = cursor ? id(cursor[1]) : id(value), page = cursor ? Number(cursor[2]) : 1;
    var releases = get("artists/" + aid + "/releases?limit=20&page=" + page);
    var result = cursor ? { id: pref(aid), provider_id: PROVIDER, item_type: "artist" } : artist(get("artists/" + aid));
    result.albums = (releases.releases || []).map(album);
    result.albums_next = releases.has_more && page < 100 ? "artist-albums:" + aid + ":" + (page + 1) : "";
    if (!cursor) result.top_tracks = (get("artists/" + aid + "/tracks?limit=20&page=1").tracks || []).map(track);
    return result;
  }
  function parseUrl(value) {
    var m = /^https:\/\/(?:www\.)?beatport\.com\/(?:[a-z]{2}\/)?(track|release|artist)\/(?:[^/?#]+\/)?([1-9]\d{0,14})\/?(?:[?#].*)?$/.exec(String(value || "").trim());
    return m ? { type: m[1], id: m[2] } : null;
  }
  function handleUrl(value) {
    var p = parseUrl(value); if (!p) throw new Error("Unsupported Beatport URL");
    if (p.type === "artist") return { type: "artist", artist: getArtist(p.id) };
    if (p.type === "release") { var a = getAlbum(p.id); return { type: "album", name: a.name, cover_url: a.cover_url, album: a, tracks: a.tracks }; }
    return { type: "track", track: getTrack(p.id) };
  }
  function normalized(s) { return String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
  function matches(t, isrc, title, artistName, duration) {
    if (isrc && t.isrc) return String(isrc).toUpperCase() === String(t.isrc).toUpperCase();
    if (!title || !artistName || normalized(t.name) !== normalized(title)) return false;
    if (normalized(t.artists) !== normalized(artistName)) return false;
    return Number.isFinite(duration) && duration > 0 && Number.isFinite(t.duration_ms) &&
      t.duration_ms > 0 && Math.abs(t.duration_ms - duration) <= 3000;
  }
  function checkAvailability(isrc, title, artistName, options) {
    options = options || {};
    var query = [title, artistName].filter(Boolean).join(" ") || isrc || "";
    if (!query) return { available: false, reason: "No track identity supplied" };
    try {
      var data = get("search?q=" + encodeURIComponent(query) + "&type=tracks&limit=20&page=1");
      for (var i = 0; i < (data.tracks || []).length; i++) {
        var raw = data.tracks[i], t = track(raw);
        if (raw.available && matches(t, isrc, title, artistName, Number(options.duration_ms) || 0))
          return { available: true, track_id: id(raw.id), prepared_context: { track_id: id(raw.id), formatted_track: t } };
      }
      return { available: false, reason: "No matching Beatport recording available" };
    } catch (e) {
      if (e.needsVerification) throw e;
      return { available: false, reason: e.message };
    }
  }
  function qualityName(value) {
    var q = String(value || "LOSSLESS").toUpperCase();
    if (["LOSSLESS", "FLAC", "BEST", "HI_RES", "HI_RES_LOSSLESS"].indexOf(q) >= 0) return "lossless";
    if (["HIGH", "AAC", "256"].indexOf(q) >= 0) return "high";
    throw new Error("Unsupported Beatport quality");
  }
  function cachedResolve(tid, quality) {
    var key = tid + ":" + quality, now = Date.now();
    if (!resolved[key] && typeof storage !== "undefined") {
      var saved = storage.get("prepared-files", {});
      resolved = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    }
    var cached = resolved[key];
    if (cached && Date.parse(cached.expires_at) > now + 30000) return cached;
    var ticket = request("POST", "/tickets", { capability: "download_ticket", provider: "btp", resource_hash: utils.sha256("beatport:track:" + tid) });
    if (!ticket.ticket_id) throw new Error("Download authorization failed");
    var result = request("POST", "/dl/btp", { id: tid, quality: quality, allow_fallback: false }, { "X-Zarz-Ticket": ticket.ticket_id });
    if (result.fulfilled_quality !== quality || result.requested_quality !== quality || result.quality_changed ||
        !result.audio || result.audio.codec !== (quality === "lossless" ? "flac" : "aac") ||
        result.format !== (quality === "lossless" ? "flac" : "m4a")) throw new Error("Unexpected Beatport audio format");
    if (!/^https:\/\/api\.zarz\.moe\/v2\/media\/btp\/[a-f0-9]{48}\?token=[A-Za-z0-9_.-]+$/.test(String(result.download_url || ""))) throw new Error("Invalid Beatport media address");
    resolved[key] = result;
    Object.keys(resolved).forEach(function (k) { if (Date.parse(resolved[k].expires_at) <= now + 30000) delete resolved[k]; });
    var keys = Object.keys(resolved); while (keys.length > 100) delete resolved[keys.shift()];
    if (typeof storage !== "undefined") storage.set("prepared-files", resolved);
    return result;
  }
  function forgetResolve(tid, quality) {
    delete resolved[tid + ":" + quality];
    if (typeof storage !== "undefined") storage.set("prepared-files", resolved);
  }
  function expiredMedia(transfer) {
    if (!transfer || transfer.error_type === "cancelled") return false;
    var status = Number(transfer.http_status || transfer.status_code || transfer.status || 0);
    return transfer.error_type === "expired_stream" || [401, 403, 404, 410].indexOf(status) >= 0;
  }
  function download(value, quality, outputPath, onProgress, options) {
    try {
      var tid = id(value), q = qualityName(quality);
      if (onProgress) onProgress(2);
      var result = cachedResolve(tid, q), ext = "." + result.format;
      var path = String(outputPath || ""); if (!path) throw new Error("Download destination required");
      var slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")), dot = path.lastIndexOf(".");
      path = (dot > slash ? path.slice(0, dot) : path) + ext;
      var userAgent = typeof utils.appUserAgent === "function" ? utils.appUserAgent() : "Mornye/5.3.0";
      var transfer;
      for (var attempt = 0; attempt < 2; attempt++) {
        transfer = file.download(result.download_url, path, { headers: { "User-Agent": userAgent }, resume: true, persistentCheckpoint: true, trackItemBytes: true,
          onProgress: function (done, total) { if (onProgress && total > 0) onProgress(Math.min(99, 5 + Math.floor(done * 94 / total))); } });
        if (transfer && transfer.success || !expiredMedia(transfer)) break;
        forgetResolve(tid, q);
        if (attempt === 0) result = cachedResolve(tid, q);
      }
      if (!transfer || !transfer.success) return { success: false, error_message: transfer && transfer.error || "Beatport transfer failed", error_type: transfer && transfer.error_type || "network_error", retry_after_seconds: Number(transfer && transfer.retry_after_seconds) || 0 };
      path = transfer.path || path;
      if (typeof file.getSize === "function") {
        var size = file.getSize(path);
        if (!size || !size.success || Number(size.size) !== result.size) throw new Error("Incomplete Beatport file");
      }
      var meta = result.track ? track(result.track) : options && options.preparedContext && options.preparedContext.formatted_track || {};
      if (onProgress) onProgress(100);
      return Object.assign({}, meta, { success: true, file_path: path, title: meta.name || "", artist: meta.artists || "", album: meta.album_name || "", bit_depth: result.audio.bit_depth || 0,
        sample_rate: result.audio.sample_rate || 0, audio_codec: result.audio.codec, actual_container: result.format,
        actual_extension: ext, output_extension: ext, requires_container_conversion: false });
    } catch (e) {
      return { success: false, error_message: e.message, error_type: e.needsVerification ? "verification_required" :
        e.status === 429 ? "rate_limited" : e.code === "QUALITY_UNAVAILABLE" ? "quality_unavailable" : e.retryable || e.status === 503 ? "api_error" : "runtime_error",
        retry_after_seconds: e.retryAfterSeconds || 0 };
    }
  }
  registerExtension({ initialize: function () { return { success: true }; }, cleanup: function () { resolved = {}; },
    completeGrant: function (grant) { return arguments.length ? session.completeGrant(grant) : session.completeGrant(); }, customSearch: customSearch,
    searchTracks: function (q, limit) { return customSearch(q, { filter: "track", limit: limit || 20 }); },
    getTrack: getTrack, getAlbum: getAlbum, getArtist: getArtist, handleUrl: handleUrl,
    enrichTrack: function (t) { return String(t.provider_id || "") === PROVIDER ? getTrack(t.id) : t; },
    checkAvailability: checkAvailability, download: download });
})();
