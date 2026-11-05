(function (host) {
    "use strict";
    const symbolDescription = Object.getOwnPropertyDescriptor(Symbol.prototype, "description").get;
    const stringApply = Reflect.apply;
    const primitiveSymbol = Symbol.toPrimitive;
    const boxedStringValue = String.prototype.valueOf;
    const boxedNumberValue = Number.prototype.valueOf;
    const boxedBooleanValue = Boolean.prototype.valueOf;
    function isPrimitive(value) {
        return value === null || (typeof value !== "object" && typeof value !== "function");
    }
    function goString(value) {
        // Goja Value.String accepts a Symbol returned by an object's coercion.
        if (!isPrimitive(value)) {
            const exotic = value[primitiveSymbol];
            if (exotic !== undefined && exotic !== null) {
                value = stringApply(exotic, value, ["string"]);
                if (!isPrimitive(value)) throw new TypeError("cannot convert object to primitive value");
            } else {
                let converted = false;
                for (const key of ["toString", "valueOf"]) {
                    const method = value[key];
                    if (typeof method !== "function") continue;
                    const result = stringApply(method, value, []);
                    if (isPrimitive(result)) { value = result; converted = true; break; }
                }
                if (!converted) throw new TypeError("cannot convert object to primitive value");
            }
        }
        if (typeof value === "symbol") return (stringApply(symbolDescription, value, []) || "").toWellFormed();
        return String(value).toWellFormed();
    }
    function goNumberPrimitive(value) {
        if (isPrimitive(value)) return value;
        const exotic = value[primitiveSymbol];
        if (exotic !== undefined && exotic !== null) {
            const result = stringApply(exotic, value, ["number"]);
            if (isPrimitive(result)) return result;
        } else {
            for (const key of ["valueOf", "toString"]) {
                const method = value[key];
                if (typeof method !== "function") continue;
                const result = stringApply(method, value, []);
                if (isPrimitive(result)) return result;
            }
        }
        throw new TypeError("cannot convert object to primitive value");
    }
    function isMap(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value)
            && !ArrayBuffer.isView(value) && !(value instanceof Date)
            && !(value instanceof Map) && !(value instanceof Set);
    }
    function formatGo(value) {
        if (value === null || value === undefined) return "<nil>";
        if (typeof value === "number") {
            if (Number.isNaN(value)) return "NaN";
            if (!Number.isFinite(value)) return value < 0 ? "-Inf" : "+Inf";
            if (Object.is(value, -0)) return "-0";
        }
        if (Array.isArray(value) || ArrayBuffer.isView(value)) {
            return "[" + Array.from(value, formatGo).join(" ") + "]";
        }
        if (isMap(value)) {
            return "map[" + host.sortKeys(Object.keys(value))
                .map(key => goString(key) + ":" + formatGo(value[key])).join(" ") + "]";
        }
        return goString(value);
    }
    function queryMethods(values, mutable) {
        const result = {};
        for (const method of mutable ? ["append", "delete", "get", "getAll", "has", "set"] : ["get", "getAll", "has"]) {
            if (method === "append" || method === "set" || method === "delete") {
                result[method] = function(key, value) {
                    if (arguments.length >= (method === "delete" ? 1 : 2)) {
                        values.write(method, goString(key), method === "delete" ? "" : goString(value));
                    }
                };
            } else {
                result[method] = function(key) {
                    if (!arguments.length) return method === "getAll" ? [] : method === "has" ? false : null;
                    return values.read(method, goString(key));
                };
            }
        }
        result.toString = function() { return values.encode(); };
        return result;
    }
    globalThis.URL = function URL(input, base) {
        if (!new.target) throw new TypeError("URL requires new");
        if (!arguments.length) { this.href = ""; return; }
        const parsed = host.parseURL(goString(input), base === undefined ? undefined : goString(base));
        Object.assign(this, parsed);
        if (parsed.searchParams) {
            this.searchParams = queryMethods(parsed.searchParams, false);
            this.toString = this.toJSON = function() { return parsed.href; };
        }
    };
    globalThis.URLSearchParams = function URLSearchParams(init) {
        if (!new.target) throw new TypeError("URLSearchParams requires new");
        const values = host.parseQuery(typeof init === "string" ? goString(init).replace(/^\?/, "") : "");
        const boxed = [boxedStringValue, boxedNumberValue, boxedBooleanValue].some(valueOf => {
            try { stringApply(valueOf, init, []); return true; } catch (_) { return false; }
        });
        if (isMap(init) && !boxed) {
            for (const key of Object.keys(init)) values.write("set", key.toWellFormed(), formatGo(init[key]));
        }
        Object.assign(this, queryMethods(values, true));
    };
    const byteArrays = new WeakSet();
    const responseByteArrays = new WeakMap();
    function emptyBytes() {
        const bytes = [];
        byteArrays.add(bytes);
        return bytes;
    }
    function exportValue(value, ancestors) {
        if (value === undefined || value === null) return null;
        if (typeof value === "number") {
            if (!Number.isFinite(value)) throw new TypeError("unsupported JSON number");
            return value;
        }
        if (typeof value === "boolean") return value;
        if (typeof value === "string") return value.toWellFormed();
        if (typeof value !== "object") throw new TypeError("unsupported JSON value");
        let stringObject;
        try { stringObject = stringApply(boxedStringValue, value, []); } catch (_) {}
        let primitive;
        try { primitive = stringApply(boxedBooleanValue, value, []); } catch (_) {}
        if (typeof primitive === "boolean") return primitive;
        try { primitive = stringApply(boxedNumberValue, value, []); } catch (_) {}
        if (typeof primitive === "number") return exportValue(primitive, ancestors);
        if (ancestors.length >= 128 || ancestors.includes(value)) throw new TypeError("cyclic or deeply nested JSON value");
        if (responseByteArrays.has(value)) return host.encodeBuffer(responseByteArrays.get(value));
        if (byteArrays.has(value) || value instanceof Uint8Array) return host.encodeBytes(Array.from(value));
        if (value instanceof Date) {
            if (!Number.isFinite(value.getTime())) return null;
            const pad = (number, width = 2) => String(number).padStart(width, "0");
            const year = value.getFullYear();
            if (year < 0 || year > 9999) throw new TypeError("unsupported JSON date");
            const offset = -value.getTimezoneOffset();
            const zone = offset === 0 ? "Z" : (offset < 0 ? "-" : "+")
                + pad(Math.trunc(Math.abs(offset) / 60)) + ":" + pad(Math.abs(offset) % 60);
            const milliseconds = value.getMilliseconds();
            const fraction = milliseconds ? "." + pad(milliseconds, 3).replace(/0+$/, "") : "";
            return pad(year, 4) + "-" + pad(value.getMonth() + 1) + "-" + pad(value.getDate())
                + "T" + pad(value.getHours()) + ":" + pad(value.getMinutes()) + ":"
                + pad(value.getSeconds()) + fraction + zone;
        }
        if (value instanceof Map) throw new TypeError("unsupported JSON map");
        ancestors.push(value);
        let result;
        if (Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof Set) {
            result = Array.from(value, item => exportValue(item, ancestors));
        } else {
            result = Object.create(null);
            for (const key of Object.keys(value)) {
                if (stringObject !== undefined && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < stringObject.length) continue;
                result[key.toWellFormed()] = exportValue(value[key], ancestors);
            }
        }
        ancestors.pop();
        return result;
    }
    function serialize(value) {
        // Goja exports values before encoding/json. That retains undefined object
        // properties as null, encodes byte slices as base64, and ignores toJSON.
        function encode(value) {
            if (value === null) return "null";
            if (typeof value === "string") return host.quoteJSON(value);
            if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
            if (typeof value === "boolean") return String(value);
            if (Array.isArray(value)) return "[" + value.map(encode).join(",") + "]";
            const fields = host.sortKeys(Object.keys(value))
                .map(key => host.quoteJSON(key) + ":" + encode(value[key]));
            return "{" + fields.join(",") + "}";
        }
        return encode(exportValue(value, []));
    }
    let registered = false;
    globalThis.registerExtension = function (value) {
        if (arguments.length) {
            registered = value !== undefined;
            globalThis.extension = value;
        }
    };

    if (host.storageEnabled) {
        function read(credentials, key, fallback) {
            const result = JSON.parse(host.storageRead(credentials, goString(key)));
            if (result.error !== undefined) return undefined;
            return result.found ? result.value : fallback;
        }
        function write(credentials, key, value) {
            try {
                return JSON.parse(host.storageWrite(credentials, goString(key), serialize(value)));
            } catch (error) {
                return {success: false, error: goString(error)};
            }
        }
        globalThis.storage = {
            get(key, fallback) { return arguments.length ? read(false, key, fallback) : undefined; },
            set(key, value) { return arguments.length >= 2 && write(false, key, value).success; },
            remove(key) {
                return arguments.length > 0 && JSON.parse(host.storageRemove(false, goString(key))).success;
            }
        };
        globalThis.credentials = {
            get(key, fallback) { return arguments.length ? read(true, key, fallback) : undefined; },
            store(key, value) {
                return arguments.length < 2 ? {success: false, error: "key and value are required"} : write(true, key, value);
            },
            remove(key) {
                return arguments.length > 0 && JSON.parse(host.storageRemove(true, goString(key))).success;
            },
            has(key) {
                return arguments.length > 0 && JSON.parse(host.storageRead(true, goString(key))).found === true;
            }
        };
    }

    if (host.networkEnabled) {
        function responseBytes(bytes) {
            // Go exposes []byte as a fresh, array-like object sharing the body.
            // A sparse array proxy preserves that shape without a Number slot
            // per byte; the backing Uint8Array remains charged to the VM heap.
            const array = [];
            array.length = bytes.length;
            function index(key) {
                if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return -1;
                const value = Number(key);
                return value < bytes.length ? value : -1;
            }
            const proxy = new Proxy(array, {
                get(target, key, receiver) {
                    const offset = index(key);
                    return offset >= 0 && offset < target.length ? bytes[offset] : Reflect.get(target, key, receiver);
                },
                set(target, key, value) {
                    const offset = index(key);
                    if (offset >= 0) { bytes[offset] = value; return true; }
                    return Reflect.set(target, key, value);
                },
                has(target, key) { return (index(key) >= 0 && index(key) < target.length) || Reflect.has(target, key); },
                ownKeys(target) {
                    return Array.from({length: Math.min(target.length, bytes.length)}, (_, i) => String(i))
                        .concat(Reflect.ownKeys(target).filter(key => index(key) < 0));
                },
                getOwnPropertyDescriptor(target, key) {
                    const offset = index(key);
                    return offset >= 0 && offset < target.length
                        ? {value: bytes[offset], writable: true, enumerable: true, configurable: true}
                        : Reflect.getOwnPropertyDescriptor(target, key);
                }
            });
            byteArrays.add(proxy);
            responseByteArrays.set(proxy, bytes);
            return proxy;
        }
        function bodyString(value, exported) {
            if (value === undefined || value === null) return "";
            if (typeof value === "string") return goString(value);
            if (isMap(value) || (Array.isArray(value) && !byteArrays.has(value))) return serialize(value);
            return exported ? formatGo(value) : goString(value);
        }
        function requestHeaders(value) {
            const headers = Object.create(null);
            if (isMap(value)) {
                for (const key of Object.keys(value)) headers[goString(key)] = formatGo(value[key]);
            }
            return headers;
        }
        function fetchError(error) {
            return {ok: false, status: 0, statusText: "Network Error", error,
                text() { return ""; }, json() { return undefined; }};
        }
        function dispatch(args, method, fetch, options) {
            const fail = error => fetch ? fetchError(error) : {error};
            if (!args.length) return fail("URL is required");
            const url = goString(args[0]);
            const denied = host.validateURL(url);
            if (denied !== undefined && denied !== null) return fail(denied);
            let body = "", headers = {};
            try {
                if (options && isMap(args[1])) {
                    const opts = args[1];
                    if (typeof opts.method === "string") method = goString(opts.method).toUpperCase();
                    body = bodyString(opts.body, true);
                    headers = requestHeaders(opts.headers);
                } else if (!options) {
                    if (method === "GET" || method === "DELETE") headers = requestHeaders(args[1]);
                    else {
                        body = bodyString(args[1], false);
                        headers = requestHeaders(args[2]);
                    }
                }
            } catch (error) { return fail("failed to stringify body: " + goString(error)); }
            const result = host.request(url, method, body, headers,
                (!options && method === "POST") || body !== "",
                fetch ? host.appUserAgent() : "Mornye-Extension/1.0", fetch);
            if (result.error !== undefined) return fail(result.error);
            if (!fetch) return result;
            const bytes = result.bytes;
            delete result.bytes;
            let text;
            result.text = function () {
                if (text === undefined) text = host.decodeBuffer(bytes);
                return text;
            };
            result.json = function () {
                try { return host.parseJSONBuffer(bytes); }
                catch (_) { return undefined; }
            };
            result.arrayBuffer = function () { return responseBytes(bytes); };
            return result;
        }
        globalThis.http = {
            get() { return dispatch(arguments, "GET", false, false); },
            post() { return dispatch(arguments, "POST", false, false); },
            put() { return dispatch(arguments, "PUT", false, false); },
            delete() { return dispatch(arguments, "DELETE", false, false); },
            patch() { return dispatch(arguments, "PATCH", false, false); },
            request() { return dispatch(arguments, "GET", false, true); },
            clearCookies() { return host.clearCookies(); }
        };
        globalThis.fetch = function () { return dispatch(arguments, "GET", true, true); };
        if (host.sessionEnabled) {
            function invokeSession(method, args) { return JSON.parse(host.sessionCall(method, JSON.stringify(args))); }
            globalThis.session = {
                status() { return invokeSession("status", []); },
                clear() { return invokeSession("clear", []); },
                completeGrant(grant) { return invokeSession("completeGrant", arguments.length ? [goString(grant)] : []); },
                signedFetch(method, path, body, headers) {
                    if (arguments.length < 2) return invokeSession("signedFetch", []);
                    try { return invokeSession("signedFetch", [goString(method), goString(path), bodyString(body, false), requestHeaders(headers)]); }
                    catch (error) { return {ok: false, error: goString(error)}; }
                }
            };
        }
        if (host.authEnabled) {
            function invokeAuth(method, args, expiresIsFloat = false) {
                const result = JSON.parse(host.authCall(method, JSON.stringify(args), expiresIsFloat));
                return method === "getAuthCode" && result === null ? undefined : result;
            }
            function goFloat(value) {
                return typeof value === "number" && (!Number.isInteger(value) || Object.is(value, -0)
                    || value < -9223372036854775808 || value >= 9223372036854775808);
            }
            function authConfig(args) {
                if (!args.length) return [];
                if (!isMap(args[0])) return [null];
                const config = Object.create(null);
                for (const key of ["authUrl", "clientId", "redirectUri", "scope", "tokenUrl", "code"]) {
                    if (typeof args[0][key] === "string") config[key] = goString(args[0][key]);
                }
                if (isMap(args[0].extraParams)) config.extraParams = requestHeaders(args[0].extraParams);
                return [config];
            }
            globalThis.auth = {
                openAuthUrl(url, callback) {
                    const args = [];
                    if (arguments.length) args.push(goString(url));
                    if (arguments.length > 1 && callback !== undefined) args.push(goString(callback));
                    return invokeAuth("openAuthUrl", args);
                },
                getAuthCode() { return invokeAuth("getAuthCode", []); },
                setAuthCode(value) {
                    if (!arguments.length) return invokeAuth("setAuthCode", []);
                    if (typeof value === "string") return invokeAuth("setAuthCode", [goString(value)]);
                    const config = Object.create(null);
                    if (isMap(value)) {
                        for (const key of ["code", "access_token", "refresh_token"]) {
                            if (typeof value[key] === "string") config[key] = goString(value[key]);
                        }
                        if (typeof value.expires_in === "number") config.expires_in = value.expires_in;
                    }
                    const expiresIsFloat = goFloat(config.expires_in);
                    // JSON cannot carry NaN/Infinity. Go's duration conversion
                    // makes these already expired; retain that outcome.
                    if (expiresIsFloat && !Number.isFinite(config.expires_in)) config.expires_in = 0;
                    return invokeAuth("setAuthCode", [config], expiresIsFloat);
                },
                clearAuth() { return invokeAuth("clearAuth", []); },
                isAuthenticated() { return invokeAuth("isAuthenticated", []); },
                getTokens() { return invokeAuth("getTokens", []); },
                generatePKCE(length) {
                    // Goja exports integral JS values as int64; this legacy host
                    // only honors float64 lengths, otherwise it defaults to 64.
                    const size = goFloat(length) && length >= 43 && length <= 128 ? Math.trunc(length) : 64;
                    return invokeAuth("generatePKCE", [size]);
                },
                getPKCE() { return invokeAuth("getPKCE", []); },
                startOAuthWithPKCE() { return invokeAuth("startOAuthWithPKCE", authConfig(arguments)); },
                exchangeCodeWithPKCE() { return invokeAuth("exchangeCodeWithPKCE", authConfig(arguments)); }
            };
        }
    }

    function binaryOptions(value) {
        if (value === null || typeof value !== "object" || Array.isArray(value) || ArrayBuffer.isView(value)
            || value instanceof ArrayBuffer || value instanceof Date || value instanceof Map || value instanceof Set) return null;
        const result = Object.create(null);
        for (const key of Object.keys(value)) {
            let item = value[key];
            if (typeof item === "string") item = goString(item);
            else if (responseByteArrays.has(item)) item = responseByteArrays.get(item);
            else if (item instanceof Uint8ClampedArray) item = new Uint8Array(item.buffer, item.byteOffset, item.byteLength);
            if (key === "segments" && Array.isArray(item)) item = Array.from(item, binaryOptions);
            result[key] = item;
        }
        return result;
    }
    function binaryPayload(value) {
        if (typeof value === "string") return goString(value);
        if (responseByteArrays.has(value)) return responseByteArrays.get(value);
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (value instanceof Uint8ClampedArray) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return value;
    }
    function blockTransform(operation, args) {
        if (args.length < 2) return {success: false, error: "data and options are required"};
        return host.blockTransform(operation, binaryPayload(args[0]), binaryOptions(args[1]));
    }
    if (host.filesEnabled) {
        globalThis.ffmpeg = {
            getInfo(path) {
                if (!arguments.length) return {success: false, error: "file path is required"};
                return host.mediaInfo(goString(path));
            },
            convert(input, output, options) {
                if (arguments.length < 2) return {success: false, error: "input and output paths are required"};
                return JSON.parse(host.mediaConvert(goString(input), goString(output), binaryOptions(options)));
            }
        };
        if (host.rawFfmpegStub) {
            globalThis.ffmpeg.execute = function() {
                return {success: false, error: "raw FFmpeg execution is disabled; use ffmpeg.convert"};
            };
        }
        function fileCall(method, args) {
            const paired = ["copy", "move", "transformPatternedBlocks"].includes(method);
            const write = method === "write" || method === "writeBytes";
            const required = method === "transformPatternedBlocks" ? 3 : paired || write ? 2 : 1;
            if (args.length < required) {
                if (method === "exists") return false;
                return {success: false, error: method === "transformPatternedBlocks"
                    ? "input path, output path, and options are required"
                    : paired ? "source and destination paths are required"
                    : write ? "path and data are required" : "path is required"};
            }
            const value = paired || method === "write" ? goString(args[1])
                : method === "writeBytes" ? binaryPayload(args[1]) : undefined;
            const options = method === "readBytes" ? binaryOptions(args[1])
                : method === "writeBytes" || method === "transformPatternedBlocks" ? binaryOptions(args[2]) : null;
            return host.fileCall(method, goString(args[0]), value, options, args[3]);
        }
        globalThis.file = {};
        globalThis.file.download = function(url, path, options) {
            if (arguments.length < 2) return {success: false, error: "URL and output path are required"};
            if (!host.networkEnabled) return {success: false, error: "network access unavailable"};
            const opts = binaryOptions(options);
            const headers = Object.create(null);
            if (opts && isMap(opts.headers)) {
                for (const key of Object.keys(opts.headers)) headers[goString(key)] = formatGo(opts.headers[key]);
            }
            return JSON.parse(host.downloadCall(goString(url), goString(path), opts, JSON.stringify(headers)));
        };
        globalThis.file.downloadSegments = function(segments, path, options) {
            const failure = (error_type, error) => ({success: false, error, error_type, attempts: 0});
            if (arguments.length < 2) return failure("invalid_request", "segments and output path are required");
            if (!Array.isArray(segments) || !segments.length) return failure("invalid_request", "segments must be a non-empty array");
            const opts = binaryOptions(options);
            const common = Object.create(null);
            function headersInto(target, source) {
                if (source && typeof source === "object" && !Array.isArray(source)
                    && !ArrayBuffer.isView(source) && !(source instanceof ArrayBuffer)
                    && !(source instanceof Date) && !(source instanceof Map) && !(source instanceof Set)) {
                    for (const key of Object.keys(source)) target[goString(key)] = formatGo(source[key]);
                }
            }
            if (host.networkEnabled && opts) headersInto(common, opts.headers);
            const specs = [];
            for (let index = 0; index < segments.length; index++) {
                const item = segments[index];
                const headers = Object.assign(Object.create(null), common);
                let url;
                if (typeof item === "string") url = item;
                else if (item && typeof item === "object" && !Array.isArray(item)
                    && !ArrayBuffer.isView(item) && !(item instanceof ArrayBuffer)
                    && !(item instanceof Date) && !(item instanceof Map) && !(item instanceof Set)) {
                    url = typeof item.url === "string" ? item.url : "";
                    if (host.networkEnabled) headersInto(headers, item.headers);
                } else return failure("invalid_request", "segment " + index + " must be a URL string or object");
                specs.push({url: goString(url), headers});
            }
            return JSON.parse(host.downloadSegmentsCall(JSON.stringify(specs), goString(path), opts));
        };
        for (const method of ["exists", "delete", "read", "readBytes", "write", "writeBytes", "copy", "move", "getSize", "transformPatternedBlocks"]) {
            globalThis.file[method] = function() { return fileCall(method, arguments); };
        }
    }
    const logTypedName = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag).get;
    const logArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
    const logDateValue = Date.prototype.getTime;
    const logMapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
    const logSetSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
    const logBoxValues = [Number.prototype.valueOf, Boolean.prototype.valueOf, BigInt.prototype.valueOf, Symbol.prototype.valueOf];
    const logApply = Reflect.apply;
    const logSlice = String.prototype.slice;
    function logValue(value) {
        if (value === null || value === undefined) return "<value>";
        if (byteArrays.has(value)) return "<[]uint8>";
        const opaque = host.logOpaqueType(value);
        if (opaque) return opaque;
        const kind = typeof value;
        if (kind === "bigint") return "<*big.Int>";
        if (kind === "function") return "<func(goja.FunctionCall) goja.Value>";
        if (kind !== "object") return goString(value);
        if (Array.isArray(value)) return "<[]interface {}>";
        const typedName = logApply(logTypedName, value, []);
        if (typedName) {
            const types = {Uint8Array:"uint8", Uint8ClampedArray:"uint8", Int8Array:"int8", Uint16Array:"uint16", Int16Array:"int16", Uint32Array:"uint32", Int32Array:"int32", Float32Array:"float32", Float64Array:"float64", BigInt64Array:"int64", BigUint64Array:"uint64"};
            return "<[]" + types[typedName] + ">";
        }
        for (const method of logBoxValues) {
            let primitive;
            try { primitive = logApply(method, value, []); } catch (_) { continue; }
            return typeof primitive === "bigint" ? "<*big.Int>" : goString(value);
        }
        for (const [method, name] of [[logArrayBufferLength,"goja.ArrayBuffer"], [logDateValue,"time.Time"], [logMapSize,"[][2]interface {}"], [logSetSize,"[]interface {}"]]) {
            try { logApply(method, value, []); return "<" + name + ">"; } catch (_) {}
        }
        return "<map[string]interface {}>";
    }
    globalThis.log = {};
    function logArguments(args) {
        const values = [];
        for (let index = 0; index < Math.min(args.length, 8); index++) {
            // Enough UTF-16 units for Go's byte cut, including overflow detection.
            values.push(logApply(logSlice, logValue(args[index]), [0, 513]));
        }
        return values;
    }
    for (const level of ["debug", "info", "warn", "error"]) {
        globalThis.log[level] = function() {
            host.extensionLog(level.toUpperCase(), logArguments(arguments), arguments.length);
        };
    }
    if (host.managedConsole) globalThis.console = {log() { host.extensionLog("", logArguments(arguments), arguments.length); }};
    globalThis.matching = {
        compareStrings(first, second) {
            return arguments.length < 2 ? 0 : host.compareStrings(goString(first), goString(second));
        },
        compareDuration(first, second, tolerance) {
            return arguments.length < 2 ? false : host.compareDuration(+first, +second, tolerance === undefined ? 3000 : +tolerance);
        },
        normalizeString(value) { return arguments.length ? host.normalizeMatching(goString(value)) : ""; }
    };
    if (host.legacyBackend) {
        const mapEntries = Map.prototype.entries;
        const setValues = Set.prototype.values;
        const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size").get;
        const setSize = Object.getOwnPropertyDescriptor(Set.prototype, "size").get;
        function filenameMetadata(value) {
            const seen = new WeakSet();
            function visit(value, depth) {
                if (typeof value === "string" || typeof value === "number") return value;
                if (value === null || typeof value !== "object" || host.logOpaqueType(value)) return null;
                try { return stringApply(boxedNumberValue, value, []); } catch (_) {}
                try { stringApply(boxedBooleanValue, value, []); return null; } catch (_) {}
                if (value instanceof Date || value instanceof ArrayBuffer
                    || (ArrayBuffer.isView(value) && !(value instanceof DataView))) return null;
                if (seen.has(value)) return null;
                if (depth >= 128) throw new TypeError("deeply nested filename metadata");
                seen.add(value);
                if (value instanceof Map || value instanceof Set) {
                    const map = value instanceof Map;
                    const count = stringApply(map ? mapSize : setSize, value, []);
                    const iterator = stringApply(map ? mapEntries : setValues, value, []);
                    for (let index = 0; index < count; index++) {
                        const entry = iterator.next();
                        if (entry.done) break;
                        if (map) visit(entry.value[0], depth + 1);
                        visit(map ? entry.value[1] : entry.value, depth + 1);
                    }
                    return null;
                }
                if (Array.isArray(value)) {
                    const length = value.length;
                    for (let index = 0; index < length; index++) visit(value[index], depth + 1);
                    return null;
                }
                let stringObject;
                try { stringObject = stringApply(boxedStringValue, value, []); } catch (_) {}
                const result = depth === 0 ? Object.create(null) : null;
                for (const key of Object.keys(value)) {
                    if (stringObject !== undefined && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < stringObject.length) continue;
                    // Goja exports ignored values too: preserve getter order,
                    // errors and shared/cyclic graph visitation without JSON.
                    const item = visit(value[key], depth + 1);
                    if (result === null) continue;
                    if (typeof item === "string") result[key.toWellFormed()] = item.toWellFormed();
                    else if (typeof item === "number") {
                        result[key.toWellFormed()] = Number.isFinite(item) ? item : Number.isNaN(item) ? 0 : item < 0 ? -1e300 : 1e300;
                    }
                }
                return result;
            }
            const result = visit(value, 0);
            return isMap(result) ? result : null;
        }
        globalThis.gobackend = {
            sanitizeFilename(value) { return arguments.length ? host.legacySanitize(goString(value)) : ""; },
            buildFilename(template, metadata) {
                if (arguments.length < 2) return "";
                const pattern = goString(template);
                const fields = filenameMetadata(metadata);
                return fields === null ? "" : host.legacyFilename(pattern, serialize(fields));
            },
            getLocalTime() { return JSON.parse(host.legacyLocalTime()); },
            getAudioQuality(path) {
                return arguments.length ? JSON.parse(host.legacyQuality(goString(path))) : {error: "file path is required"};
            },
            getLyricsLRC(spotifyID, track, artist, path, duration) {
                if (arguments.length < 3) return {error: "spotifyID, trackName, and artistName are required"};
                const id = goString(spotifyID), title = goString(track), name = goString(artist);
                const file = path == null ? "" : goString(path);
                const value = duration == null ? 0 : goNumberPrimitive(duration);
                const milliseconds = typeof value === "string" ? 0 : +value;
                const text = typeof value === "string"
                    ? (typeof duration === "string" ? value : value.trim()).toWellFormed() : null;
                return JSON.parse(host.legacyLyrics(id, title, name, file, milliseconds,
                    text, typeof duration !== "string"));
            },
            checkISRCExists(directory, isrc) {
                return arguments.length < 2 ? {error: "outputDir and isrc are required"}
                    : JSON.parse(host.legacyIsrc(false, goString(directory), goString(isrc), ""));
            },
            addToISRCIndex(directory, isrc, path) {
                return arguments.length < 3 ? {error: "outputDir, isrc, and filePath are required"}
                    : JSON.parse(host.legacyIsrc(true, goString(directory), goString(isrc), goString(path)));
            }
        };
    }
    globalThis.utils = {
        isDownloadCancelled() { return host.downloadCancelled(); },
        isRequestCancelled() { return host.requestCancelled(); },
        randomUserAgent() { return host.randomUserAgent(); },
        appVersion() { return host.appVersion(); },
        appUserAgent() { return host.appUserAgent(); },
        setDownloadStatus(status) {
            if (arguments.length && host.downloadItemActive()) host.downloadStatus(goString(status));
        },
        getResolutionRemainingMs() { return host.resolutionRemaining(); },
        encrypt(data, key) {
            return arguments.length < 2 ? {success: false, error: "plaintext and key are required"}
                : host.cryptoText(false, goString(data), goString(key));
        },
        decrypt(data, key) {
            return arguments.length < 2 ? {success: false, error: "ciphertext and key are required"}
                : host.cryptoText(true, goString(data), goString(key));
        },
        generateKey(length) {
            length = length === undefined ? 32 : Number(length);
            if (!Number.isInteger(length) || length < 1 || length > 4096)
                return {success: false, error: "key length must be an integer between 1 and 4096 bytes"};
            return host.generateKey(length);
        },
        encryptBlockCipher() { return blockTransform("encrypt", arguments); },
        decryptBlockCipher() { return blockTransform("decrypt", arguments); },
        decryptCTRSegments() { return blockTransform("segments", arguments); },
        base64Encode(value) { return arguments.length ? host.base64Encode(goString(value)) : ""; },
        base64Decode(value) { return arguments.length ? host.base64Decode(goString(value), false) : ""; },
        md5(value) { return arguments.length ? host.md5(goString(value)) : ""; },
        sha256(value) { return arguments.length ? host.sha256(goString(value)) : ""; },
        hmacSHA256(message, key) {
            return arguments.length < 2 ? "" : host.hmacSHA256(goString(message), goString(key));
        },
        hmacSHA256Base64(message, key) {
            return arguments.length < 2 ? "" : host.hmacSHA256Base64(goString(message), goString(key));
        },
        hmacSHA1(key, message) {
            function bytes(value) {
                if (typeof value === "string") return host.encode(goString(value));
                if (Array.isArray(value)) return Array.from(value, item => typeof item === "number" ? item & 255 : 0);
                return null;
            }
            key = bytes(key);
            message = bytes(message);
            return key === null || message === null ? emptyBytes() : host.hmacSHA1(key, message);
        },
        parseJSON(value) {
            if (!arguments.length) return undefined;
            try {
                // encoding/json rejects overflowing numbers and replaces lone surrogates.
                return JSON.parse(serialize(JSON.parse(String(value))));
            } catch (_) { return undefined; }
        },
        stringifyJSON(value) {
            if (!arguments.length) return "";
            try { return serialize(value); } catch (_) { return ""; }
        },
        sleep(milliseconds) {
            if (typeof milliseconds !== "number" || !(milliseconds > 0)) return true;
            return host.sleep(Math.min(Math.trunc(milliseconds), 300000));
        }
    };
    globalThis.btoa = function (value) {
        return arguments.length ? host.base64Encode(goString(value)) : "";
    };
    globalThis.atob = function (value) {
        return arguments.length ? host.base64Decode(goString(value), true) : "";
    };
    globalThis.TextEncoder = function () {
        this.encoding = "utf-8";
        this.encode = function (value) {
            return arguments.length ? host.encode(goString(value)) : emptyBytes();
        };
        this.encodeInto = function (value, destination) {
            if (arguments.length < 2) return { read: 0, written: 0 };
            const length = host.encode(goString(value)).length;
            // Preserve the existing Go host contract, including no destination copy.
            return { read: length, written: length };
        };
    };
    globalThis.TextDecoder = function (encoding) {
        this.encoding = encoding === undefined ? "utf-8" : goString(encoding);
        this.fatal = false;
        this.ignoreBOM = false;
        this.decode = function (value) {
            if (typeof value === "string") return goString(value);
            if (!Array.isArray(value) && !(value instanceof Uint8Array)) return "";
            return host.decode(Array.from(value, item => typeof item === "number" ? item & 255 : 0));
        };
    };
    return {
        providerHelpers: {goString, isMap, exportValue, serialize},
        registered() { return registered; },
        getExtension() { return globalThis.extension; },
        invokeManaged(action, method, args) {
            const extension = globalThis.extension;
            let callback;
            if (extension !== undefined && (action ? extension : true) && typeof extension[method] === "function") {
                callback = () => extension[method].apply(extension, args);
            } else if (action && method === "completeGrant" && typeof session !== "undefined" && session && typeof session.completeGrant === "function") {
                callback = () => session.completeGrant();
            }
            if (!callback) return action ? {success:false, error:"Action function not found: " + method} : {success:true, message:"no " + method + " function"};
            try {
                const result = callback();
                if (!action) return {success:true};
                if (result && typeof result.then === "function") return {success:true, pending:true, message:"Action started"};
                if (result !== null && result !== undefined && typeof result === "object" && !Array.isArray(result)) {
                    const output = {success:true};
                    for (const key in result) output[key] = result[key];
                    return output;
                }
                return {success:true, result};
            } catch (error) { return {success:false, error:error.toString()}; }
        },
        serialize
    };
})
