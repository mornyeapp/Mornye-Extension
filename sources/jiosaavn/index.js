// ============================================================
// JioSaavn Extension – modular build
// ============================================================

// ---- src/api/constants.js ----
var EXT_ID = "jiosaavn";

var API_HOST = 'https://www.jiosaavn.com';
var API_BASE = API_HOST + '/api.php';
var REFERER = API_HOST + '/';

var UA = 'Mozilla/5.0';
var COOKIE_BASE = 'DL=english; geo=19.0760%2C72.8777%2CIN%2CMaharashtra%2CMumbai%2C400001';

// Default headers for all requests
var DEFAULT_HEADERS = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': REFERER,
    'User-Agent': UA,
};

// Common API parameters (overridden per call)
var API_DEFAULTS = {
    _format: 'json',
    _marker: 0,
    api_version: 4,
    ctx: 'web6dot0'
};

// ---- src/api/fetch.js ----
// ----- Low-level fetch (returns null on failure) -----
function fetchAPI(url, options) {
    options = options || {};
    var headers = options.headers || {};

    // Build dynamic cookie
    var lang = storage.get("lang") || 'english';
    var cookie = COOKIE_BASE + '; L=' + lang;

    // Add cookie to headers
    headers['Cookie'] = cookie;

    var response;
    // log.debug('[fetchAPI] Request URL: ' + url);

    response = http.get(url, headers);
    if (!response) {
        log.debug('[fetchAPI] No response from server');
        if (options.throwOnError) throw new Error('No response from JioSaavn');
        return null;
    }
    // log.debug('[fetchAPI] Status: ' + response.statusCode + ', OK: ' + response.ok);
    if (!response.ok) {
        log.debug('[fetchAPI] Response body: ' + (response.body || '').substring(0, 200));
        if (options.throwOnError) throw new Error(response.error || ('HTTP ' + response.statusCode + ' from JioSaavn'));
        return null;
    }

    try {
        var parsed = JSON.parse(response.body);
        // log.debug('[fetchAPI] Parsed JSON successfully (keys: ' + Object.keys(parsed).join(', ') + ')');
        return parsed;
    } catch (e) {
        log.debug('[fetchAPI] JSON parse error: ' + e.message);
        log.debug('[fetchAPI] Raw body: ' + (response.body || '').substring(0, 200));
        return null;
    }
}

// ----- API call builder -----
function callAPI(call, extraParams, options) {
    // Start with defaults
    var params = { __call: call };
    for (var key in API_DEFAULTS) {
        params[key] = API_DEFAULTS[key];
    }
    if (extraParams) {
        for (var key in extraParams) {
            params[key] = extraParams[key];
        }
    }

    // Build query string
    var qParts = [];
    for (var key in params) {
        qParts.push(enc(key) + '=' + enc(params[key]));
    }
    var endpoint = '?' + qParts.join('&');
    var url = API_BASE + endpoint;
    log.debug('[callAPI] Call: ' + call + ', URL: ' + url);

    // Pass DEFAULT_HEADERS (without Cookie) – fetchAPI will add it dynamically
    var result = fetchAPI(url, { headers: DEFAULT_HEADERS, throwOnError: !!(options && options.throwOnError) });
    if (!result) {
        log.debug('[callAPI] fetchAPI returned null for ' + call);
    }

    log.debug('[callAPI] fetchAPI succeeded for ' + call);
    return result;
}

// ---- src/api/songs.js ----
function searchSongs(query, limit, page) {
    log.debug('[searchSongs] Query: ' + query + ', limit: ' + limit + ', page: ' + page);
    var result = callAPI('search.getResults', {
        q: query,
        p: page || 1,
        n: limit || 20
    });
    if (!result) log.debug('[searchSongs] No results');
    return result;
}

function getSong(token) {
    log.debug('[getSong] Token: ' + token);
    token = catalogReference(token);
    if (!token) return null;
    // Version 1.0.1 used catalog IDs; PR #36 used permalink tokens. Keep both.
    var byIdFirst = /^[A-Za-z0-9_-]{8}$/.test(token);
    for (var attempt = 0; attempt < 2; attempt++) {
        var byId = attempt === 0 ? byIdFirst : !byIdFirst;
        var result = byId
            ? callAPI('song.getDetails', { pids: token })
            : callAPI('webapi.get', { token: token, type: 'song', includeMetaTags: 0 });
        var songs = result && Array.isArray(result.songs) ? result.songs : [];
        for (var i = 0; i < songs.length; i++) {
            if (String(songs[i].id) === token || extractToken(songs[i].perma_url) === token) {
                return songs[i];
            }
        }
    }
    return null;
}

// ---- src/api/collections.js ----
function searchCollections(type, query, limit, page) {
    // log.debug('[searchCollections] type: ' + type + ', query: ' + query + ', limit: ' + limit + ', page: ' + page);
    var call = type === 'album' ? 'search.getAlbumResults' : 'search.getPlaylistResults';
    var result = callAPI(call, {
        q: query,
        p: page || 1,
        n: limit || 20
    });
    if (!result) log.debug('[searchCollections] No results for ' + type);
    return result;
}

function getAlbumById(albumId) {
    log.debug('[getAlbumById] albumId: ' + albumId);
    var result = callAPI('content.getAlbumDetails', { albumid: albumId });
    if (!result) {
        log.debug('[getAlbumById] No album found for id: ' + albumId);
        return null;
    }
    return result;
}

function getCollection(type, token) {
    // log.debug('[getCollection] type: ' + type + ', token: ' + token);

    // Album ID prefix detected
    token = catalogReference(token);
    if (!token) return null;
    var id = token.replace(/^(albumid_|playlist_)/, '');
    if (type === 'album' && /^\d+$/.test(id)) {
        return getAlbumById(id);
    }

    // Playlist or album token path
    var extra = { token: token, type: type, includeMetaTags: 0 };
    if (type === 'playlist') {
        extra.p = 1;
        extra.n = 100;
        log.debug('[getCollection] Playlist – fetching up to 100 tracks');
    }
    var byId = type === 'playlist' && /^\d+$/.test(id);
    var result = byId
        ? callAPI('playlist.getDetails', { listid: id, p: 1, n: 100 })
        : callAPI('webapi.get', extra);
    if (!result) {
        log.debug('[getCollection] No ' + type + ' found for token: ' + token);
        return null;
    }
    if (type === 'playlist' && Array.isArray(result.list)) {
        var rows = result.list.slice();
        var seen = {};
        rows.forEach(function(row) { seen[String(row.id)] = true; });
        var total = Number(result.list_count);
        if (!Number.isSafeInteger(total) || total < rows.length) total = 0;
        // Count fetched entries before deduplication because playlists can repeat songs.
        var fetched = rows.length;
        var batchSize = rows.length;
        for (var page = 2; batchSize >= 100 && (!total || fetched < total); page++) {
            if (page > 100) throw new Error('JioSaavn playlist exceeds the paging limit');
            var next = byId
                ? callAPI('playlist.getDetails', { listid: id, p: page, n: 100 })
                : callAPI('webapi.get', { token: token, type: type, includeMetaTags: 0, p: page, n: 100 });
            if (!next || !Array.isArray(next.list)) throw new Error('Could not load JioSaavn playlist page ' + page);
            batchSize = next.list.length;
            fetched += batchSize;
            var added = 0;
            next.list.forEach(function(row) {
                if (!seen[String(row.id)]) {
                    seen[String(row.id)] = true;
                    rows.push(row);
                    added++;
                }
            });
            if (batchSize && !added) throw new Error('JioSaavn returned a repeated playlist page');
        }
        if (total && fetched < total) throw new Error('Could not load all JioSaavn playlist tracks');
        result.list = rows;
    }
    log.debug('[getCollection] Found ' + type + ': ' + (result.title || 'untitled'));
    return result;
}

// ---- src/api/home.js ----
function getLaunchData() {
    log.debug('[getLaunchData] Fetching home feed data');
    var result = callAPI('webapi.getLaunchData');
    if (!result) {
        log.debug('[getLaunchData] No launch data received');
        return null;
    }
    log.debug('[getLaunchData] Received launch data with modules: ' + Object.keys(result.modules || {}).join(', '));
    return result;
}

// ---- src/api/artists.js ----
function searchArtists(query, limit, page) {
    // log.debug('[searchArtists] Query: ' + query + ', limit: ' + limit + ', page: ' + page);
    var result = callAPI('search.getArtistResults', {
        q: query,
        p: page || 1,
        n: limit || 20
    });
    if (!result) log.debug('[searchArtists] No results');
    return result;
}

function getArtistById(artistId, category) {
    // log.debug('[getArtistById] artistId: ' + artistId);
    var params = {
        artistId: artistId,
        page: 0, // artist uses page starting from 0
        n_song: 50,
        n_album: 50,
        sub_type: '',
        category: category || 'popular',
        sort_order: category === 'latest' ? 'desc' : 'asc'
    };
    var result = callAPI('artist.getArtistPageDetails', params);
    if (!result) {
        log.debug('[getArtistById] No artist found for id: ' + artistId);
        return null;
    }
    log.debug('[getArtistById] Found artist: ' + (result.name || result.title || 'untitled'));
    return result;
}

function getArtist(token, category) {
    // Artist ID prefix detected
    token = catalogReference(token);
    if (!token) return null;
    var artistId = token.replace(/^artistid_/, '');
    if (/^\d+$/.test(artistId)) {
        return getArtistById(artistId, category);
    }

    // log.debug('[getArtist] Token: ' + token + ', category: ' + category);

    var params = {
        token: token,
        type: 'artist',
        p: 0, // artist uses page starting from 0
        n_song: 50,
        n_album: 50,
        sub_type: '',
        category: category || 'popular',
        sort_order: category === 'latest' ? 'desc' : 'asc'
    };
    var result = callAPI('webapi.get', params);
    if (!result) {
        log.debug('[getArtist] No artist found for token: ' + token);
        return null;
    }
    log.debug('[getArtist] Found artist: ' + (result.name || result.title || 'untitled'));
    return result;
}

function getMoreSongs(artistId, page, category) {
    // log.debug('[getMoreSongs] artistId: ' + artistId + ', page: ' + page);
    return callAPI('artist.getArtistMoreSong', {
        artistId: artistId,
        page: page || 1,
        category: category || 'popular',
        sort_order: category === 'latest' ? 'desc' : 'asc'
    });
}

function getMoreAlbums(artistId, page, category) {
    // log.debug('[getMoreAlbums] artistId: ' + artistId + ', page: ' + page);
    return callAPI('artist.getArtistMoreAlbum', {
        artistId: artistId,
        page: page || 1,
        category: category || 'popular',
        sort_order: category === 'latest' ? 'desc' : 'asc'
    });
}

// ---- src/api/search.js ----
function searchAll(query) {
    log.debug('[searchAll] Query: ' + query);
    var result = callAPI('autocomplete.get', { query: query });
    if (!result) {
        log.debug('[searchAll] No results');
        return null;
    }
    return result;
}

// ---- src/libs/des.js ----
// ----- DES Library (ECB mode, decryption only) -----

// (Full S‑boxes and DES block processor)
var S1 = new Int32Array([
    0x1010400, 0,         0x10000,   0x1010404, 0x1010004, 0x10404,   0x4,       0x10000,   0x400,     0x1010400,
    0x1010404, 0x400,     0x1000404, 0x1010004, 0x1000000, 0x4,       0x404,     0x1000400, 0x1000400, 0x10400,
    0x10400,   0x1010000, 0x1010000, 0x1000404, 0x10004,   0x1000004, 0x1000004, 0x10004,   0,         0x404,
    0x10404,   0x1000000, 0x10000,   0x1010404, 0x4,       0x1010000, 0x1010400, 0x1000000, 0x1000000, 0x400,
    0x1010004, 0x10000,   0x10400,   0x1000004, 0x400,     0x4,       0x1000404, 0x10404,   0x1010404, 0x10004,
    0x1010000, 0x1000404, 0x1000004, 0x404,     0x10404,   0x1010400, 0x404,     0x1000400, 0x1000400, 0,
    0x10004,   0x10400,   0,         0x1010004
]);
var S2 = new Int32Array([
    -0x7FEF7FE0, -0x7FFF8000, 0x8000,      0x108020,    0x100000,    0x20,        -0x7FEFFFE0, -0x7FFF7FE0,
    -0x7FFFFFE0, -0x7FEF7FE0, -0x7FEF8000, -0x80000000, -0x7FFF8000, 0x100000,    0x20,        -0x7FEFFFE0,
    0x108000,    0x100020,    -0x7FFF7FE0, 0,           -0x80000000, 0x8000,      0x108020,    -0x7FF00000,
    0x100020,    -0x7FFFFFE0, 0,           0x108000,    0x8020,      -0x7FEF8000, -0x7FF00000, 0x8020,
    0,           0x108020,    -0x7FEFFFE0, 0x100000,    -0x7FFF7FE0, -0x7FF00000, -0x7FEF8000, 0x8000,
    -0x7FF00000, -0x7FFF8000, 0x20,        -0x7FEF7FE0, 0x108020,    0x20,        0x8000,      -0x80000000,
    0x8020,      -0x7FEF8000, 0x100000,    -0x7FFFFFE0, 0x100020,    -0x7FFF7FE0, -0x7FFFFFE0, 0x100020,
    0x108000,    0,           -0x7FFF8000, 0x8020,      -0x80000000, -0x7FEFFFE0, -0x7FEF7FE0, 0x108000
]);
var S3 = new Int32Array([
    0x208,     0x8020200, 0,         0x8020008, 0x8000200, 0,         0x20208,   0x8000200, 0x20008,   0x8000008,
    0x8000008, 0x20000,   0x8020208, 0x20008,   0x8020000, 0x208,     0x8000000, 0x8,       0x8020200, 0x200,
    0x20200,   0x8020000, 0x8020008, 0x20208,   0x8000208, 0x20200,   0x20000,   0x8000208, 0x8,       0x8020208,
    0x200,     0x8000000, 0x8020200, 0x8000000, 0x20008,   0x208,     0x20000,   0x8020200, 0x8000200, 0,
    0x200,     0x20008,   0x8020208, 0x8000200, 0x8000008, 0x200,     0,         0x8020008, 0x8000208, 0x20000,
    0x8000000, 0x8020208, 0x8,       0x20208,   0x20200,   0x8000008, 0x8020000, 0x8000208, 0x208,     0x8020000,
    0x20208,   0x8,       0x8020008, 0x20200
]);
var S4 = new Int32Array([
    0x802001, 0x2081,   0x2081,   0x80,     0x802080, 0x800081, 0x800001, 0x2001,   0,        0x802000, 0x802000,
    0x802081, 0x81,     0,        0x800080, 0x800001, 0x1,      0x2000,   0x800000, 0x802001, 0x80,     0x800000,
    0x2001,   0x2080,   0x800081, 0x1,      0x2080,   0x800080, 0x2000,   0x802080, 0x802081, 0x81,     0x800080,
    0x800001, 0x802000, 0x802081, 0x81,     0,        0,        0x802000, 0x2080,   0x800080, 0x800081, 0x1,
    0x802001, 0x2081,   0x2081,   0x80,     0x802081, 0x81,     0x1,      0x2000,   0x800001, 0x2001,   0x802080,
    0x800081, 0x2001,   0x2080,   0x800000, 0x802001, 0x80,     0x800000, 0x2000,   0x802080
]);
var S5 = new Int32Array([
    0x100,      0x2080100,  0x2080000,  0x42000100, 0x80000,    0x100,      0x40000000, 0x2080000,
    0x40080100, 0x80000,    0x2000100,  0x40080100, 0x42000100, 0x42080000, 0x80100,    0x40000000,
    0x2000000,  0x40080000, 0x40080000, 0,          0x40000100, 0x42080100, 0x42080100, 0x2000100,
    0x42080000, 0x40000100, 0,          0x42000000, 0x2080100,  0x2000000,  0x42000000, 0x80100,
    0x80000,    0x42000100, 0x100,      0x2000000,  0x40000000, 0x2080000,  0x42000100, 0x40080100,
    0x2000100,  0x40000000, 0x42080000, 0x2080100,  0x40080100, 0x100,      0x2000000,  0x42080000,
    0x42080100, 0x80100,    0x42000000, 0x42080100, 0x2080000,  0,          0x40080000, 0x42000000,
    0x80100,    0x2000100,  0x40000100, 0x80000,    0,          0x40080000, 0x2080100,  0x40000100
]);
var S6 = new Int32Array([
    0x20000010, 0x20400000, 0x4000,     0x20404010, 0x20400000, 0x10,       0x20404010, 0x400000,
    0x20004000, 0x404010,   0x400000,   0x20000010, 0x400010,   0x20004000, 0x20000000, 0x4010,
    0,          0x400010,   0x20004010, 0x4000,     0x404000,   0x20004010, 0x10,       0x20400010,
    0x20400010, 0,          0x404010,   0x20404000, 0x4010,     0x404000,   0x20404000, 0x20000000,
    0x20004000, 0x10,       0x20400010, 0x404000,   0x20404010, 0x400000,   0x4010,     0x20000010,
    0x400000,   0x20004000, 0x20000000, 0x4010,     0x20000010, 0x20404010, 0x404000,   0x20400000,
    0x404010,   0x20404000, 0,          0x20400010, 0x10,       0x4000,     0x20400000, 0x404010,
    0x4000,     0x400010,   0x20004010, 0,          0x20404000, 0x20000000, 0x400010,   0x20004010
]);
var S7 = new Int32Array([
    0x200000,  0x4200002, 0x4000802, 0,         0x800,     0x4000802, 0x200802,  0x4200800, 0x4200802, 0x200000,
    0,         0x4000002, 0x2,       0x4000000, 0x4200002, 0x802,     0x4000800, 0x200802,  0x200002,  0x4000800,
    0x4000002, 0x4200000, 0x4200800, 0x200002,  0x4200000, 0x800,     0x802,     0x4200802, 0x200800,  0x2,
    0x4000000, 0x200800,  0x4000000, 0x200800,  0x200000,  0x4000802, 0x4000802, 0x4200002, 0x4200002, 0x2,
    0x200002,  0x4000000, 0x4000800, 0x200000,  0x4200800, 0x802,     0x200802,  0x4200800, 0x802,     0x4000002,
    0x4200802, 0x4200000, 0x200800,  0,         0x2,       0x4200802, 0,         0x200802,  0x4200000, 0x800,
    0x4000002, 0x4000800, 0x800,     0x200002
]);
var S8 = new Int32Array([
    0x10001040, 0x1000,     0x40000,    0x10041040, 0x10000000, 0x10001040, 0x40,       0x10000000,
    0x40040,    0x10040000, 0x10041040, 0x41000,    0x10041000, 0x41040,    0x1000,     0x40,
    0x10040000, 0x10000040, 0x10001000, 0x1040,     0x41000,    0x40040,    0x10040040, 0x10041000,
    0x1040,     0,          0,          0x10040040, 0x10000040, 0x10001000, 0x41040,    0x40000,
    0x41040,    0x40000,    0x10041000, 0x1000,     0x40,       0x10040040, 0x1000,     0x41040,
    0x10001000, 0x40,       0x10000040, 0x10040000, 0x10040040, 0x10000000, 0x40000,    0x10001040,
    0,          0x10041040, 0x40040,    0x10000040, 0x10040000, 0x10001000, 0x10001040, 0,
    0x10041040, 0x41000,    0x41000,    0x1040,     0x1040,     0x40040,    0x10000000, 0x10041000
]);

function desBlock(message, keys, encrypt) {
    var s1 = S1, s2 = S2, s3 = S3, s4 = S4;
    var s5 = S5, s6 = S6, s7 = S7, s8 = S8;
    if (encrypt) {
        var padLen = 8 - (message.length % 8);
        for (var p = 0; p < padLen; p++) {
            message += String.fromCharCode(padLen);
        }
    }
    var len = message.length;
    var result = '';
    var left, right, temp;
    for (var m = 0; m < len; m += 8) {
        left = (message.charCodeAt(m) << 24) | (message.charCodeAt(m + 1) << 16) | (message.charCodeAt(m + 2) << 8) |
            message.charCodeAt(m + 3);
        right = (message.charCodeAt(m + 4) << 24) | (message.charCodeAt(m + 5) << 16) |
            (message.charCodeAt(m + 6) << 8) | message.charCodeAt(m + 7);
        temp = ((left >>> 4) ^ right) & 0x0F0F0F0F;
        right ^= temp;
        left ^= (temp << 4);
        temp = ((left >>> 16) ^ right) & 0x0000FFFF;
        right ^= temp;
        left ^= (temp << 16);
        temp = ((right >>> 2) ^ left) & 0x33333333;
        left ^= temp;
        right ^= (temp << 2);
        temp = ((right >>> 8) ^ left) & 0x00FF00FF;
        left ^= temp;
        right ^= (temp << 8);
        temp = ((left >>> 1) ^ right) & 0x55555555;
        right ^= temp;
        left ^= (temp << 1);
        left = ((left << 1) | (left >>> 31));
        right = ((right << 1) | (right >>> 31));
        var start = encrypt ? 0 : 30;
        var end = encrypt ? 32 : -2;
        var step = encrypt ? 2 : -2;
        for (var i = start; i !== end; i += step) {
            var right1 = right ^ keys[i];
            var rrot = (right >>> 4) | (right << 28);
            var right2 = rrot ^ keys[i + 1];
            temp = left;
            left = right;
            right = temp ^
                (s2[(right1 >>> 24) & 63] | s4[(right1 >>> 16) & 63] | s6[(right1 >>> 8) & 63] | s8[right1 & 63] |
                 s1[(right2 >>> 24) & 63] | s3[(right2 >>> 16) & 63] | s5[(right2 >>> 8) & 63] | s7[right2 & 63]);
        }
        temp = left;
        left = right;
        right = temp;
        left = ((left >>> 1) | (left << 31));
        right = ((right >>> 1) | (right << 31));
        temp = ((left >>> 1) ^ right) & 0x55555555;
        right ^= temp;
        left ^= (temp << 1);
        temp = ((right >>> 8) ^ left) & 0x00FF00FF;
        left ^= temp;
        right ^= (temp << 8);
        temp = ((right >>> 2) ^ left) & 0x33333333;
        left ^= temp;
        right ^= (temp << 2);
        temp = ((left >>> 16) ^ right) & 0x0000FFFF;
        right ^= temp;
        left ^= (temp << 16);
        temp = ((left >>> 4) ^ right) & 0x0F0F0F0F;
        right ^= temp;
        left ^= (temp << 4);
        result += String.fromCharCode(
            (left >>> 24), ((left >>> 16) & 0xFF), ((left >>> 8) & 0xFF), (left & 0xFF), (right >>> 24),
            ((right >>> 16) & 0xFF), ((right >>> 8) & 0xFF), (right & 0xFF));
    }
    return result;
}

function desDecrypt(message, keys) {
    return desBlock(message, keys, false);
}

// ---- src/utils/decrypt.js ----
// DES key (32×32‑bit words)
var DES_KEY = new Uint32Array([
    36443656, 338827529, 170141697, 338826299, 170272797, 875566612, 170276616, 941097494,
    153487137, 941103620, 154281006, 940128288, 221380890, 688468270, 621941049, 688727305,
    622007300, 151861785, 890309646, 184882698, 874054925, 50799890, 874062625, 117842443,
    805908001, 119942188, 839720978, 102894652, 302780946, 103954180, 302782501, 338829583
]);

function base64ToBinaryString(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    str = str.replace(/=+$/, '');
    var binary = '';
    var len = str.length;
    for (var i = 0; i < len; i += 4) {
        var c1 = chars.indexOf(str.charAt(i));
        var c2 = chars.indexOf(str.charAt(i + 1));
        var c3 = chars.indexOf(str.charAt(i + 2));
        var c4 = chars.indexOf(str.charAt(i + 3));
        var byte1 = (c1 << 2) | (c2 >> 4);
        var byte2 = ((c2 & 15) << 4) | (c3 >> 2);
        var byte3 = ((c3 & 3) << 6) | c4;
        binary += String.fromCharCode(byte1);
        if (c3 !== -1 && i + 2 < len) binary += String.fromCharCode(byte2);
        if (c4 !== -1 && i + 3 < len) binary += String.fromCharCode(byte3);
    }
    return binary;
}

function decryptMediaUrl(encrypted) {
    if (typeof encrypted !== 'string' || !encrypted) return '';
    var binary = base64ToBinaryString(encrypted);
    if (!binary.length || binary.length % 8) return '';
    var plain = desDecrypt(binary, DES_KEY);
    // Remove PKCS#7 padding (last byte = pad length)
    var padLen = plain.charCodeAt(plain.length - 1);
    if (padLen > 0 && padLen <= 8) plain = plain.slice(0, plain.length - padLen);
    return mediaUrl(plain);
}

// ---- src/utils/cache.js ----
var TRACKING_KEY = "__cache_keys";

function getCache(key) {
    try {
        return storage.get(key);
    } catch (e) {
        log.debug("getCache error:", e.message);
        return null;
    }
}

function setCache(key, value) {
    try {
        storage.set(key, value);
        // Track the key
        var list = getCache(TRACKING_KEY);
        var keys = list ? JSON.parse(list) : [];
        if (keys.indexOf(key) === -1) {
            keys.push(key);
            storage.set(TRACKING_KEY, JSON.stringify(keys));
        }
        // log.debug("setCache: stored", key);
    } catch (e) {
        log.debug("setCache error:", e.message);
    }
}

function removeCache(key) {
    try {
        storage.remove(key);
        // Remove from tracking list
        var list = getCache(TRACKING_KEY);
        if (list) {
            var keys = JSON.parse(list);
            var idx = keys.indexOf(key);
            if (idx !== -1) {
                keys.splice(idx, 1);
                storage.set(TRACKING_KEY, JSON.stringify(keys));
            }
        }
        log.debug("removeCache: removed", key);
    } catch (e) {
        log.debug("removeCache error:", e.message);
    }
}

function clearCache() {
    try {
        var list = getCache(TRACKING_KEY);
        if (list) {
            var keys = JSON.parse(list);
            for (var i = 0; i < keys.length; i++) {
                storage.remove(keys[i]);
            }
            storage.remove(TRACKING_KEY);
            log.debug("clearCache: removed", keys.length, "keys");
        } else {
            log.debug("clearCache: no keys to clear");
        }
    } catch (e) {
        log.debug("clearCache error:", e.message);
    }
}

function cleanup(force) {
    try {
        var now = Date.now();
        var last = getCache("last_cleanup");
        var lastTime = last ? parseInt(last, 10) : 0;
        var age = now - lastTime;
        var threshold = 24 * 60 * 60 * 1000; // 24 hours

        if (force || lastTime === 0 || age > threshold) {
            clearCache();
            setCache("last_cleanup", String(now));
            var msg = force ? "forced" : ("last cleanup was " + (lastTime ? Math.round(age / 60000) : "never") + " min ago");
            log.info("[Extension] Cleanup: storage cache cleared (" + msg + ")");
             return { success: true, message: "Cache cleared!" };
        } else {
            var remaining = threshold - age;
            var remainingMinutes = Math.ceil(remaining / 60000);
            log.debug("[Extension] Cleanup skipped – next cleanup in " + remainingMinutes + " minute(s)");
            return false;
        }
    } catch (e) {
        log.error("[Extension] Cleanup error: " + e.message);
        return false;
    }
}

function initialize(config) {
    var settings = config || {};
    log.info("Extension initialized with settings:", settings.lang);

    storage.set("lang", settings.lang || 'english');
    // Run cleanup on init
    cleanup();
    return true;
}

function forceCleanup() {
    log.debug("clearCache: force clearing the cache");
    cleanup(true);
    return { success: true, message: "Cache cleared!" };
}

// ---- src/utils/formatters.js ----
function enc(v) {
    return encodeURIComponent(String(v == null ? "" : v));
}

function decodeEntities(s) {
    if (s == null) return "";
    return String(s)
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(x[0-9a-f]+|\d+);/gi, function (m, d) {
            var value = d.charAt(0).toLowerCase() === 'x' ? parseInt(d.slice(1), 16) : parseInt(d, 10);
            return value <= 0x10ffff ? String.fromCodePoint(value) : m;
        })
        .replace(/&amp;/g, '&').trim();
}

function extractToken(permaUrl) {
    if (!permaUrl) return null;
    var parts = String(permaUrl).split(/[?#]/)[0].replace(/\/+$/, '').split("/");
    return parts[parts.length - 1] || null;
}

function catalogReference(value) {
    value = String(value == null ? '' : value).trim();
    if (/^https?:\/\//i.test(value)) value = extractToken(value) || '';
    return /^[A-Za-z0-9_,.-]{1,128}$/.test(value) ? value : '';
}

function mediaUrl(value) {
    var url = String(value || '').trim().replace(/^http:/, 'https:');
    return /^https:\/\/aac\.saavncdn\.com\//i.test(url) ? url : '';
}

function recordingIsrc(value) {
    var isrc = String(value || '').toUpperCase().replace(/[\s-]/g, '');
    return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc) ? isrc : '';
}

function getHighResImageUrl(url) {
    if (!url) return '';
    return String(url).replace(/^http:/, 'https:').replace(/(?:50|150)x(?:50|150)(\.[a-z]+)(?=[?#]|$)/i, '500x500$1');
}

function extractArtistNames(item) {
    if (!item) return '';
    var moreInfo = item.more_info || {};
    var artistMap = moreInfo.artistMap || {};
    var artists = (artistMap.primary_artists || []).concat(artistMap.featured_artists || []);
    var names = artists.map(function(artist) { return decodeEntities(artist.name); })
        .filter(function(name, index, values) { return name && values.indexOf(name) === index; });
    return names.join(', ') || decodeEntities(item.primary_artists || moreInfo.primary_artists ||
        String(item.subtitle || '').split(' - ')[0]);
}

function positiveInt(value) {
    var number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function formatSong(song, album, index) {
    if (!song) return null;
    var token = extractToken(song.perma_url);
    var id = String(song.id || token || '');
    if (!id) return null;

    // log.debug("[formatSong] token: " + token);

    var more = song.more_info || {};
    var duration = Number(more.duration || song.duration || 0);

    var decryptedFull = decryptMediaUrl(more.encrypted_media_url);

    // Album artist
    var artistMap = more.artistMap || {};
    var primaryArtists = artistMap.primary_artists || [];
    var primary = primaryArtists[0] || {};
    var albumArtist = (album && album.artists) || primaryArtists.map(function(artist) {
        return decodeEntities(artist.name);
    }).filter(Boolean).join(', ') || extractArtistNames(song);
    var composers = (artistMap.artists || []).filter(function(artist) {
        return /^(music|composer)$/i.test(artist.role || '');
    }).map(function(artist) { return decodeEntities(artist.name); })
        .filter(function(name, position, values) { return name && values.indexOf(name) === position; });
    var trackNumber = positiveInt(more.track_number || song.track_number) ||
        (typeof index === 'number' ? index + 1 : 0);

    var formatted = {
        id: id,
        name: decodeEntities(song.title || song.song || ""),
        artists: extractArtistNames(song),
        album_name: decodeEntities(more.album || song.album || album && album.name || ""),
        album_id: String(more.album_id || song.albumid || album && album.id || extractToken(more.album_url) || ''),
        album_url: String(more.album_url || song.album_url || album && album.url || ''),
        album_artist: decodeEntities(albumArtist),
        artist_id: String(primary.id || String(song.primary_artists_id || '').split(',')[0] || ''),
        artist_url: String(primary.perma_url || ''),
        duration_ms: Number.isFinite(duration) ? Math.max(0, Math.round(duration * 1000)) : 0,
        cover_url: getHighResImageUrl(song.image || album && album.cover_url) || "",
        external_urls: String(song.perma_url || ''),
        preview_url: decryptedFull, // can play song for small duration
        release_date: String(more.release_date || song.release_date || song.year || album && album.release_date || ''),
        track_number: trackNumber,
        total_tracks: positiveInt(more.total_tracks || song.total_tracks || album && album.total_tracks),
        disc_number: positiveInt(more.disc_number || song.disc_number) || 1,
        total_discs: positiveInt(more.total_discs || song.total_discs),
        composer: composers.join(', ') || decodeEntities(more.music || song.music || ""),
        isrc: recordingIsrc(more.isrc || song.isrc),
        audio_quality: "AAC",
        item_type: "track",
        provider_id: EXT_ID,

        genre: decodeEntities(more.genre || song.genre || ""),
        label: decodeEntities(more.label || ""),
        copyright: decodeEntities(more.copyright_text || ""),
        explicit: song.explicit_content === '1' || song.explicit_content === 1 || song.explicit_content === true
    };

    return formatted;
}

// ----- Unified collection formatter ---------------------------------
function formatCollection(item, type, isDetail) {
    if (!item) {
        log.debug("[formatCollection] item is null/undefined");
        return null;
    }
    var token = String(item.id || item.albumid || extractToken(item.perma_url) || '');
    if (!token) {
        log.debug("[formatCollection] Failed to extract token for", type);
        return null;
    }
    // log.debug("[formatCollection] token: " + token + ", type: " + type + ", isDetail: " + isDetail);

    var songs = Array.isArray(item.list) ? item.list : Array.isArray(item.songs) ? item.songs : [];
    var more = item.more_info || {};
    var total = positiveInt(item.song_count || more.song_count || more.songs_count || item.list_count) || songs.length;

    var result = {
        id: token,
        name: decodeEntities(item.title || ""),
        cover_url: getHighResImageUrl(item.image) || "",
        total_tracks: total,
        item_type: type,
        url: String(item.perma_url || ''),
        provider_id: EXT_ID
    };

    if (type === 'album') {
        result.artists = extractArtistNames(item);
        result.artist_id = String((more.artistMap && more.artistMap.primary_artists && more.artistMap.primary_artists[0] || {}).id || '');
        result.album_type = item.type || "album";
        result.release_date = String(more.release_date || item.release_date || item.year || '');
    } else {
        result.album_type = "playlist";
    }

    if (isDetail) {
        result.tracks = songs.map(function(song, index) {
            // Playlist position is not an album track number or track total.
            return formatSong(song, type === 'album' ? result : null, type === 'album' ? index : undefined);
        }).filter(function(t) { return t !== null; });
        if (type === 'playlist') result.total_tracks = result.tracks.length;
        log.debug("[formatCollection] Mapped " + result.tracks.length + " tracks for " + type);
    }

    return result;
}

// Artist formatting helpers
function processArtistSongs(songs) {
    if (!songs || !songs.length) return [];
    return songs.map(function(song) {
        return formatSong(song);
    }).filter(function(t) { return t !== null; });
}

function processArtistAlbums(albums) {
    if (!albums || !albums.length) return [];
    return albums.map(function(album) {
        return formatCollection(album, 'album');
    }).filter(function(a) { return a !== null; });
}

function processArtistSingles(singles, result) {
    if (!singles || !singles.length) return;
    // log.debug("[formatArtist] Found " + singles.length + " single(s)");
    for (var i = 0; i < singles.length; i++) {
        var single = singles[i];
        var formatted = formatCollection(single, 'album');
        if (formatted) {
            formatted.album_type = 'single';
            result.albums.push(formatted);
            // log.debug("[formatArtist] Added single: " + formatted.name);
        }
    }
}

function processCompilations(playlists, result) {
    if (!playlists || !playlists.length) return;
    // log.debug("[formatArtist] Found " + playlists.length + " playlist(s)");
    for (var i = 0; i < playlists.length; i++) {
        var playlist = playlists[i];
        var compilation = formatCollection(playlist, 'playlist');
        if (compilation) {
            // log.debug("[formatArtist] Added compilation: " + compilation.name);
            compilation.id = "playlist_" + compilation.id;
            compilation.item_type = 'album';
            compilation.album_type = 'compilation';
            result.albums.push(compilation);
        }
    }
}

// ----- Main formatArtist (orchestrator) ------------------------
function formatArtist(artist, isDetail) {
    if (!artist) {
        log.debug("[formatArtist] artist is null/undefined");
        return null;
    }

    // Extract token – use overview URL for detail, perma_url for search
    var token = String(artist.artistId || artist.id || extractToken(artist.urls && artist.urls.overview || artist.perma_url) || '');
    if (!token) {
        log.debug("[formatArtist] Failed to extract token");
        return null;
    }

    var result = {
        id: token,
        name: decodeEntities(artist.title || artist.name || ""),
        cover_url: getHighResImageUrl(artist.image) || "",
        image_url: getHighResImageUrl(artist.image) || "",
        item_type: "artist",
        provider_id: EXT_ID
    };

    if (isDetail) {
        result.listeners = positiveInt(String(artist.fan_count || '').replace(/,/g, ''));
        result.image_url = getHighResImageUrl(artist.image) || "";
        result.top_tracks = processArtistSongs(artist.topSongs || []);
        result.albums = processArtistAlbums(artist.topAlbums || []);
        processArtistSingles(artist.singles || [], result);
        processCompilations(artist.dedicated_artist_playlist || [], result);
        processCompilations(artist.featured_artist_playlist || [], result);

        log.debug("[formatArtist] Mapped " + result.top_tracks.length + " top tracks and " + result.albums.length + " albums (including singles and compilations)");
    }

    return result;
}

// ----- Home feed item formatter --------------------------------
function formatHomeFeedItem(item, type) {
    if (!item) {
        log.debug("[formatHomeFeedItem] item is null/undefined");
        return null;
    }

    // Determine type from context or item.type
    var itemType = mapRawType(type || item.type);
    if (['track', 'album', 'playlist', 'artist'].indexOf(itemType) === -1) return null;
    var id = String(item.artistId || item.id || extractToken(item.perma_url) || '');
    if (!id) return null;

    var result = {
        id: id,
        type: itemType,
        name: decodeEntities(item.title || item.name || ''),
        cover_url: getHighResImageUrl(item.image) || '',
        provider_id: EXT_ID
    };

    // For tracks, include album info for "Go to Album"
    if (itemType === 'track') {
        var more = item.more_info || {};
        result.album_id = String(more.album_id || extractToken(more.album_url) || '');
        result.album_name = decodeEntities(more.album || item.album || '');
        result.duration_ms = positiveInt(Number(more.duration || item.duration || 0) * 1000);
    }

    if (itemType !== 'playlist') {
        result.artists = extractArtistNames(item);
    }

    // log.debug("[formatHomeFeedItem] Formatted " + itemType + ": " + result.name);
    return result;
}

// ----- Search item formatter (for autocomplete.get results) -----
function formatSearchItem(raw, type) {
    if (!raw) return null;

    var id;

    id = String(raw.artistId || raw.id || extractToken(raw.perma_url) || '');

    if (!id) return null;

    var artists = '';
    var more = raw.more_info || {};
    if (type === 'track') {
        artists = decodeEntities(more.primary_artists || more.singers || raw.subtitle || '');
    } else if (type === 'album') {
        artists = decodeEntities(more.music || raw.subtitle || '');
    }

    var item = {
        id: id,
        name: decodeEntities(raw.title || ""),
        artists: artists,
        cover_url: getHighResImageUrl(raw.image) || "",
        item_type: type,
        provider_id: EXT_ID
    };

    if (type === 'track') {
        if (more.album_id) {
            item.album_id = String(more.album_id);
        }
        if (more.album) {
            item.album_name = decodeEntities(more.album);
        }
    }

    return item;
}

// ---- src/services/songs.js ----
function searchSongsService(query, limit) {
    var data = searchSongs(query, limit);
    if (!data || !data.results) return [];
    var songs = data.results.filter(function (item) { return item.type === "song"; });
    var out = [];
    for (var i = 0; i < songs.length; i++) {
        var t = formatSong(songs[i]);
        if (t && t.id) out.push(t);
    }
    return out;
}

function getSongService(token) {
    log.debug('[getSongService] Token: ' + token);

    var song = getSong(token);
    return song ? formatSong(song) : null;
}

// ---- src/services/collections.js ----
function searchCollectionsService(type, query, limit) {
    log.debug('[searchCollectionsService] type: ' + type + ', query: ' + query + ', limit: ' + limit);
    var data = searchCollections(type, query, limit);
    if (!data || !data.results) {
        log.debug('[searchCollectionsService] No results for ' + type);
        return [];
    }
    var filtered = data.results.filter(function(item) {
        return item.type === type;
    });
    var out = filtered.map(function(item) {
        return formatCollection(item, type, false);
    }).filter(function(item) { return item && item.id; });
    log.debug('[searchCollectionsService] Returning ' + out.length + ' ' + type + '(s)');
    return out;
}

function getCollectionService(type, token) {
    log.debug('[getCollectionService] type: ' + type + ', token: ' + token);
    var raw = getCollection(type, token);
    if (!raw) {
        log.debug('[getCollectionService] No raw data for ' + type);
        return null;
    }
    var formatted = formatCollection(raw, type, true);
    log.debug('[getCollectionService] Formatted ' + type + ': ' + (formatted ? formatted.name : 'null'));
    return formatted;
}

// ---- src/services/artists.js ----
function searchArtistsService(query, limit) {
    log.debug('[searchArtistsService] Query: ' + query + ', limit: ' + limit);
    var data = searchArtists(query, limit);
    if (!data || !data.results) return [];
    var artists = data.results.filter(function(item) {
        return item.type === "artist";
    });
    var out = [];
    for (var i = 0; i < artists.length; i++) {
        var a = formatArtist(artists[i], false);
        if (a && a.id) out.push(a);
    }
    return out;
}

function getArtistService(token) {
    log.debug('[getArtistService] Artist ID: ' + token);

    // 1. Fetch main artist details
    var artist = getArtist(token);
    if (!artist) {
        log.debug('[getArtistService] No artist found');
        return null;
    }

/*
    // 2. Fetch extra songs (pages 2 and 3)
    var extraSongs = [];
    for (var page = 2; page <= 3; page++) {
        var more = getMoreSongs(artist.artistId, page);
        if (more && more.topSongs.songs && more.topSongs.songs.length) {
            extraSongs = extraSongs.concat(more.topSongs.songs);
        }
    }
    if (extraSongs.length) {
        if (!artist.topSongs) artist.topSongs = [];
        artist.topSongs = artist.topSongs.concat(extraSongs);
        log.debug('[getArtistService] Added ' + extraSongs.length + ' extra songs');
    }

    // 3. Fetch extra albums (pages 2 and 3)
    var extraAlbums = [];
    for (var page = 2; page <= 3; page++) {
        var more = getMoreAlbums(artist.artistId, page);
        if (more && more.topAlbums.albums && more.topAlbums.albums.length) {
            extraAlbums = extraAlbums.concat(more.topAlbums.albums);
        }
    }
    if (extraAlbums.length) {
        if (!artist.topAlbums) artist.topAlbums = [];
        artist.topAlbums = artist.topAlbums.concat(extraAlbums);
        log.debug('[getArtistService] Added ' + extraAlbums.length + ' extra albums');
    }
*/

    // 4. Format and return
    return formatArtist(artist, true);
}

// ---- src/services/home.js ----
// ----- Get time-based greeting -----
function getTimeBasedGreeting() {
    var hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
}

// ----- Extract and format a single section -----
function extractSection(key, moduleMeta, sectionData) {
    var supportedTypes = ['song', 'track', 'album', 'playlist', 'artist'];

    if (!sectionData || !sectionData.length) {
        log.debug('[extractSection] Skipping empty section: ' + key);
        return null;
    }

    // Check if at least one item has a supported type
    var hasSupportedType = false;
    for (var i = 0; i < sectionData.length; i++) {
        var itemType = sectionData[i].type || 'track';
        if (supportedTypes.indexOf(itemType) !== -1) {
            hasSupportedType = true;
            break;
        }
    }

    if (!hasSupportedType) {
        log.debug('[extractSection] Skipping section with unsupported items: ' + key);
        return null;
    }

    var formattedItems = [];
    for (var j = 0; j < sectionData.length; j++) {
        var rawItem = sectionData[j];
        var itemType = rawItem.type || 'track';
        var formatted = formatHomeFeedItem(rawItem, itemType);
        if (formatted) {
            formattedItems.push(formatted);
        }
    }

    if (!formattedItems.length) {
        log.debug('[extractSection] No valid items to display for section: ' + key);
        return null;
    }

    return {
        title: decodeEntities(moduleMeta.title || key),
        items: formattedItems
    };
}

function getHomeFeed() {
    log.debug('[getHomeFeed] Starting home feed generation');

    var data = getLaunchData();
    if (!data) {
        log.debug('[getHomeFeed] No launch data available');
        return { success: false, error: 'No home feed data available' };
    }

    var modules = data.modules || {};
    var sections = [];

    for (var key in modules) {
        if (!modules.hasOwnProperty(key)) continue;

        var moduleMeta = modules[key];
        var sectionData = data[key];

        var section = extractSection(key, moduleMeta, sectionData);
        if (section) {
            sections.push(section);
            log.debug('[getHomeFeed] Added section: ' + section.title + ' with ' + section.items.length + ' items');
        }
    }

    var greeting = getTimeBasedGreeting();

    log.debug('[getHomeFeed] Returning ' + sections.length + ' sections');
    return {
        success: true,
        greeting: greeting,
        sections: sections
    };
}

// ---- src/services/search.js ----
function customSearch(query, options) {
    log.debug('[customSearch] Query: ' + query + ', options: ' + JSON.stringify(options));

    options = typeof options === 'string' ? { filter: options } : options || {};
    var aliases = { song: 'tracks', songs: 'tracks', track: 'tracks', album: 'albums', playlist: 'playlists', artist: 'artists' };
    var filter = String(options.filter || '').toLowerCase();
    filter = aliases[filter] || filter;
    var limit = (options && options.limit) || 20; // default to 20 if not provided

    // Filtered mode – use the provided limit
    if (filter === 'tracks') {
        log.debug('[customSearch] Filter: tracks, limit: ' + limit);
        return searchSongsService(query, limit);
    }
    if (filter === 'albums') {
        log.debug('[customSearch] Filter: albums, limit: ' + limit);
        return searchCollectionsService('album', query, limit);
    }
    if (filter === 'playlists') {
        log.debug('[customSearch] Filter: playlists, limit: ' + limit);
        return searchCollectionsService('playlist', query, limit);
    }
    // Note: 'artist' is used when we click on artist name in a song card
    if (filter === 'artist' || filter === 'artists') {
        log.debug('[customSearch] Filter: artists, limit: ' + limit);
        return searchArtistsService(query, limit);
    }

    // "all" or no filter – use autocomplete.get
    log.debug('[customSearch] Filter: all – using autocomplete.get');
    var data = searchAll(query);
    if (!data) return [];

    var results = [];
    var skipId = null;

    // 1. Extract topquery item
    if (data.topquery && data.topquery.data && data.topquery.data.length) {
        var rawTop = data.topquery.data[0];
        var topItem = formatSearchItem(rawTop, mapRawType(rawTop.type));
        if (topItem) {
            results.push(topItem);
            skipId = rawTop.id;
            log.debug('[customSearch] Added topquery item: ' + topItem.name + ' (' + rawTop.type + ')');
        }
    }

    // 2. Add all sections (skip the topquery item by id)
    var sections = [
        { data: data.songs,     type: 'track' },
        { data: data.albums,    type: 'album' },
        { data: data.playlists, type: 'playlist' },
        { data: data.artists,   type: 'artist' }
    ];

    for (var i = 0; i < sections.length; i++) {
        results = results.concat(parseSearchSection(sections[i].data, sections[i].type, skipId));
    }

    log.debug('[customSearch] Returning ' + results.length + ' total items');
    return results;
}

function mapRawType(rawType) {
    return rawType === 'song' ? 'track' : rawType;
}

// ----- Helper: parse a section from autocomplete response -----
function parseSearchSection(section, type, skipId) {
    if (!section || !section.data || !section.data.length) return [];
    var out = [];
    for (var i = 0; i < section.data.length; i++) {
        var raw = section.data[i];
        // Skip by raw.id (works for all types, including artists without perma_url)
        if (skipId && raw.id === skipId) {
            log.debug('[parseSearchSection] Skipping topquery item in ' + type + ' section');
            continue;
        }
        var item = formatSearchItem(raw, type);
        if (item) out.push(item);
    }
    return out;
}

// ---- src/services/url-handler.js ----
// ----- URL type detection -----
function getUrlType(url) {
    if (url.indexOf('/song/') >= 0) return 'song';
    if (url.indexOf('/album/') >= 0) return 'album';
    if (url.indexOf('/playlist/') >= 0 || url.indexOf('/featured/') >= 0) return 'playlist';
    if (url.indexOf('/artist/') >= 0) return 'artist';
    return null;
}

// ----- Handlers (now called with token) -----
function handleSongUrl(token) {
    var track = getSongService(token);
    if (!track) return null;
    return {
        success: true,
        type: "track",
        track: track
    };
}

function handleAlbumUrl(token) {
    var album = getCollectionService('album', token);
    if (!album) return null;
    return {
        success: true,
        type: "album",
        album: album,
        name: album.name,
        tracks: album.tracks,
        cover_url: album.cover_url
    };
}

function handlePlaylistUrl(token) {
    var playlist = getCollectionService('playlist', token);
    if (!playlist) return null;
    return {
        success: true,
        type: "playlist",
        playlist: playlist,
        name: playlist.name,
        tracks: playlist.tracks,
        cover_url: playlist.cover_url
    };
}

function handleArtistUrl(token) {
    var artist = getArtistService(token);
    if (!artist) return null;
    return {
        success: true,
        type: "artist",
        artist: artist,
        image_url: artist.image_url
    };
}

function handleUrl(url) {
    log.info("[handleURL] Called with URL: " + url);
    if (!url) return { success: false, error: "Empty URL" };

    // Detect URL type first (no API calls)
    var type = getUrlType(url);
    if (!type) {
        log.info("[handleURL] Not a JioSaavn link: ");
        return { success: false, error: "Not a JioSaavn song, album, playlist, or artist link" };
    }

    // Extract token
    var token = extractToken(url);
    if (!token) {
        return { success: false, error: "Invalid URL – could not extract token" };
    }

    // Dispatch to the correct handler based on type
    var result = null;
    switch (type) {
        case 'song': result = handleSongUrl(token); break;
        case 'album': result = handleAlbumUrl(token); break;
        case 'playlist': result = handlePlaylistUrl(token); break;
        case 'artist': result = handleArtistUrl(token); break;
        default: break;
    }

    if (result) {
        return result;
    }

    return { success: false, error: "Could not resolve the URL" };
}

// ---- src/services/download.js ----
function enrichTrack(track) {
    if (!track || !track.id) {
        log.debug('[enrichTrack] No track or missing id');
        return track;
    }

    // Fetch full song details
    var song = getSongService(track.id);
    if (!song) {
        log.debug('[enrichTrack] Could not fetch song details');
        return track;
    }

    cacheDownloadTrack(song, track.id);

    return song;  // return the deep, formatted track
}

// ----- Quality mapping -----------------------------------------
function getBitrate(qualityId) {
    var map = { "AAC_12": "12", "AAC_48": "48", "AAC_96": "96", "AAC_160": "160", "AAC_320": "320" };
    var id = String(qualityId || 'AAC_320').toUpperCase();
    var bitrate = map[id] || null;
    log.debug('[getBitrate] qualityId: ' + qualityId + ' → bitrate: ' + bitrate);
    return bitrate;
}

function cacheDownloadTrack(track, reference) {
    if (!track || !mediaUrl(track.preview_url)) return;
    var ids = [reference, track.id, extractToken(track.external_urls)];
    ids.forEach(function(id, index) {
        if (!id || ids.indexOf(id) !== index) return;
        setCache('url_' + id, mediaUrl(track.preview_url));
        setCache('track_' + id, JSON.stringify(track));
    });
}

function getDownloadUrl(token, quality, options) {
    log.debug('[getDownloadUrl] Token: ' + token + ', quality: ' + quality);
    token = catalogReference(token);
    if (!token) return { success: false, error_message: 'Invalid JioSaavn track ID', error_type: 'not_found' };
    var baseUrl = '';
    var track = null;
    var prepared = options && options.preparedContext && options.preparedContext.track;
    if (prepared && (String(prepared.id) === token || extractToken(prepared.external_urls) === token)) {
        baseUrl = mediaUrl(prepared.preview_url);
        if (baseUrl) track = prepared;
    }
    try {
        if (!baseUrl) {
            baseUrl = mediaUrl(getCache('url_' + token));
            var cachedTrack = getCache('track_' + token);
            if (cachedTrack) track = JSON.parse(cachedTrack);
        }
    } catch (e) {}
    if (!baseUrl) {
        track = getSongService(token);
        baseUrl = track && mediaUrl(track.preview_url);
        cacheDownloadTrack(track, token);
    }
    if (!baseUrl) return { success: false, error_message: 'JioSaavn has no playable stream for this track', error_type: 'stream_error' };
    var bitrate = getBitrate(quality);
    if (!bitrate) return { success: false, error_message: 'Unsupported JioSaavn quality', error_type: 'quality_unavailable' };
    var finalUrl = baseUrl.replace(/_\d+\.mp4(?=[?#]|$)/, '_' + bitrate + '.mp4');
    log.debug('[getDownloadUrl] Final URL: ' + finalUrl);
    return {
        success: true,
        url: finalUrl,
        format: "m4a",
        actual_extension: 'm4a',
        audio_codec: 'aac',
        quality: bitrate + "kbps",
        track: track
    };
}

function download(token, quality, outputPath, onProgress, options) {
    log.debug('[download] Starting download for token: ' + token + ', quality: ' + quality);

    // Get the stream URL (reuse getDownloadUrl)
    var streamInfo;
    try { streamInfo = getDownloadUrl(token, quality, options); }
    catch (error) { return { success: false, error_message: error.message || String(error), error_type: 'stream_error' }; }
    if (!streamInfo.success) {
        return streamInfo; // forward the error
    }
    var plainUrl = streamInfo.url;

    // Require outputPath – if missing, log and exit
    if (!outputPath) {
        log.debug('[download] outputPath missing, cannot download');
        return { success: false, error_message: "Output path not provided", error_type: "invalid_path" };
    }

    // The host may supply a provisional .flac path. AAC stays in its MP4
    // container and must never be published with a lossless suffix.
    outputPath = String(outputPath);
    if (!/\.m4a$/i.test(outputPath)) {
        outputPath = outputPath.replace(/\.[^./\\]+$/, '') + '.m4a';
    }

    // Download the file
    var dl = file.download(plainUrl, outputPath, {
        headers: { "User-Agent": UA, "Referer": REFERER },
        onProgress: onProgress ? function(r, t) { onProgress(t > 0 ? r / t : 0); } : undefined
    });
    if (!dl || !dl.success) {
        return { success: false, error_message: dl && (dl.error_message || dl.error) || "Download failed", error_type: dl && dl.error_type || "download_error" };
    }
    if (onProgress) onProgress(1);
    var track = streamInfo.track || {};
    return {
        success: true,
        file_path: dl.path || outputPath,
        format: "m4a",
        actual_extension: 'm4a',
        audio_codec: 'aac',
        title: track.name || '',
        artist: track.artists || '',
        album: track.album_name || '',
        album_artist: track.album_artist || '',
        track_number: track.track_number || 0,
        total_tracks: track.total_tracks || 0,
        disc_number: track.disc_number || 0,
        total_discs: track.total_discs || 0,
        release_date: track.release_date || '',
        cover_url: track.cover_url || '',
        isrc: recordingIsrc(track.isrc),
        genre: track.genre || '',
        label: track.label || '',
        copyright: track.copyright || '',
        composer: track.composer || '',
        explicit: track.explicit === true
    };
}

function checkAvailability(isrc, trackName, artistName, options) {
    options = options || {};
    var track = options.track || {};
    if (track.provider_id === EXT_ID && track.id) {
        var song = getSongService(track.id);
        if (song && song.preview_url) {
            cacheDownloadTrack(song, track.id);
            return { available: true, track_id: song.id, prepared_context: { track: song } };
        }
    }
    if (!trackName || !artistName) return { available: false, reason: 'No recording metadata to match' };
    var queries = [trackName + ' ' + artistName];
    var strippedTitle = stripTrackTitleAnnotations(trackName).replace(/\s+/g, ' ').trim();
    if (strippedTitle && strippedTitle !== String(trackName).trim()) {
        var strippedQuery = strippedTitle + ' ' + artistName;
        if (queries.indexOf(strippedQuery) < 0) queries.push(strippedQuery);
    }
    var requestedIsrc = recordingIsrc(isrc);
    var requestedDuration = positiveInt(options.duration_ms || track.duration_ms);
    for (var queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        if (typeof utils !== 'undefined' && typeof utils.isDownloadCancelled === 'function' && utils.isDownloadCancelled()) {
            return { available: false, reason: 'download cancelled' };
        }
        var candidates = searchSongsService(queries[queryIndex], 20);
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            if (!candidate.preview_url) continue;
            if (requestedIsrc && candidate.isrc && requestedIsrc !== candidate.isrc) continue;
            var exactIsrc = requestedIsrc && requestedIsrc === candidate.isrc;
            if (!exactIsrc && (matchingName(stripTrackTitleAnnotations(trackName)) !== matchingName(stripTrackTitleAnnotations(candidate.name)) ||
                !matchingArtists(artistName, candidate.artists) ||
                !requestedDuration || !candidate.duration_ms ||
                Math.abs(requestedDuration - candidate.duration_ms) > 5000)) continue;
            cacheDownloadTrack(candidate, candidate.id);
            return { available: true, track_id: candidate.id, prepared_context: { track: candidate } };
        }
    }
    return { available: false, reason: 'No matching JioSaavn recording' };
}

function stripTrackTitleAnnotations(value) {
    return String(value || '').replace(/[(\[]\s*(?:(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]+|from\s+["“][^)\]]+["”]\s*)[)\]]/gi, function(annotation) {
        if (/^[(\[]\s*with\b/i.test(annotation) &&
            /\b(?:mix|remix|live|acoustic|demo|instrumental|karaoke|edit|extended|slowed|sped)\b/i.test(annotation)) {
            return annotation;
        }
        return ' ';
    });
}

function matchingName(value) {
    return decodeEntities(value).toLowerCase().replace(/[^a-z0-9\u0080-\uffff]+/g, ' ').trim();
}

function matchingArtists(expected, actual) {
    function names(value) {
        return String(value || '').split(/[,;&]|\s+(?:feat\.?|ft\.?)\s+/i).map(matchingName).filter(Boolean);
    }
    var requested = names(expected);
    return names(actual).some(function(name) { return requested.indexOf(name) !== -1; });
}

// ---- src/services/related.js ----
function isOwnSeed(seed) {
    return String(seed.provider_id || '').trim().toLowerCase() === EXT_ID;
}

function seedArtistText(value) {
    if (Array.isArray(value)) {
        return value.map(function(artist) {
            return artist && typeof artist === 'object' ? artist.name : artist;
        }).filter(Boolean).join(', ');
    }
    return String(value || '').trim();
}

// JioSaavn has no ISRC lookup, so a foreign seed is matched through one search
// request. Request failures propagate so the caller can tell them from misses.
function resolveRelatedSeed(seed) {
    if (isOwnSeed(seed)) {
        var reference = catalogReference(seed.id);
        if (!reference) return null;
        if (/^[A-Za-z0-9_-]{8}$/.test(reference)) return { id: reference, isrc: recordingIsrc(seed.isrc) };
        var legacy = getSong(reference);
        return legacy && legacy.id ? { id: String(legacy.id), isrc: recordingIsrc(seed.isrc) } : null;
    }

    var name = String(seed.name || '').trim();
    var artists = seedArtistText(seed.artists);
    if (!name || !artists) return null;
    var data = callAPI('search.getResults', { q: name + ' ' + artists, p: 1, n: 10 }, { throwOnError: true });
    var results = data && Array.isArray(data.results) ? data.results : [];
    var isrc = recordingIsrc(seed.isrc);
    var duration = positiveInt(seed.duration_ms);
    for (var i = 0; i < results.length; i++) {
        if (!results[i] || results[i].type !== 'song') continue;
        var candidate = formatSong(results[i]);
        if (!candidate) continue;
        if (isrc && candidate.isrc) {
            if (isrc === candidate.isrc) return { id: candidate.id, isrc: candidate.isrc };
            continue;
        }
        if (matchingName(name) !== matchingName(candidate.name) || !matchingArtists(artists, candidate.artists)) continue;
        if (duration && candidate.duration_ms && Math.abs(duration - candidate.duration_ms) > 5000) continue;
        return { id: candidate.id, isrc: candidate.isrc || isrc };
    }
    return null;
}

// The web contexts return an empty list for reco.getreco; the android context
// returns the song's recommendations keyed by the requested song id.
function fetchRelatedSongs(songId) {
    var data = callAPI('reco.getreco', { pid: songId, ctx: 'android' }, { throwOnError: true });
    var songs = Array.isArray(data) ? data : (data && Array.isArray(data[songId]) ? data[songId] : []);
    var out = [];
    for (var i = 0; i < songs.length; i++) {
        if (!songs[i] || (songs[i].type && songs[i].type !== 'song')) continue;
        var track = formatSong(songs[i]);
        if (track && track.id) out.push(track);
    }
    return out;
}

function getRelatedTracks(seeds, options) {
    var limit = Number(options && options.limit) || 25;
    limit = Math.max(1, Math.min(50, Math.floor(limit)));
    var list = Array.isArray(seeds) ? seeds.slice(0, 10) : [];
    var excludedIds = {};
    var excludedIsrcs = {};
    var i;

    for (i = 0; i < list.length; i++) {
        var seed = list[i] || {};
        var seedIsrc = recordingIsrc(seed.isrc);
        if (seedIsrc) excludedIsrcs[seedIsrc] = true;
        if (isOwnSeed(seed) && catalogReference(seed.id)) excludedIds[catalogReference(seed.id)] = true;
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
        } catch (e) {
            lastError = e;
            log.debug('[getRelatedTracks] Seed resolve failed: ' + e.message);
            continue;
        }
        if (!resolved || seen[resolved.id]) continue;
        seen[resolved.id] = true;
        excludedIds[resolved.id] = true;
        if (resolved.isrc) excludedIsrcs[resolved.isrc] = true;
        try {
            groups.push(fetchRelatedSongs(resolved.id));
            succeeded = true;
        } catch (e) {
            lastError = e;
            log.debug('[getRelatedTracks] Recommendations failed: ' + e.message);
        }
    }

    if (!succeeded && lastError) throw lastError;

    var results = [];
    var added = {};
    var maxLength = 0;
    for (i = 0; i < groups.length; i++) maxLength = Math.max(maxLength, groups[i].length);
    for (var position = 0; position < maxLength && results.length < limit; position++) {
        for (i = 0; i < groups.length && results.length < limit; i++) {
            var track = groups[i][position];
            if (!track || excludedIds[track.id] || added[track.id]) continue;
            if (track.isrc && excludedIsrcs[track.isrc]) continue;
            added[track.id] = true;
            results.push(track);
        }
    }
    return results;
}

// ---- src/spotiflac.js ----
// ============================================================
// Register extension with Mornye
// ============================================================

registerExtension({
    initialize: initialize,
    cleanup: cleanup,
    forceCleanup: forceCleanup,
    searchTracks: searchSongsService,
    customSearch: customSearch,
    getRelatedTracks: getRelatedTracks,
    getTrack: function(token) {
        log.debug('[getTrack] Token ' + token);
        return getSongService(token);
    },

    // ----- Collection detection: album or playlist? -----
    getAlbum: function(token) {
        if (token && token.indexOf('playlist_') === 0) {
            log.debug('[getAlbum] Token "' + token + '" is a playlist – routing to getPlaylist');
            return getCollectionService('playlist', token.replace('playlist_', ''));
        }
        log.debug('[getAlbum] Token "' + token + '" treated as album');
        return getCollectionService('album', token);
    },

    getPlaylist: function(token) {
        return getCollectionService('playlist', token);
    },

    getArtist: getArtistService,
    getHomeFeed: getHomeFeed,
    enrichTrack: enrichTrack,
    checkAvailability: checkAvailability,
    getDownloadUrl: getDownloadUrl,
    download: download,
    handleUrl: handleUrl // note that handleUrl is "rl" in lowercase as opposed to the official docs
});

log.debug("JioSaavn extension loaded");
