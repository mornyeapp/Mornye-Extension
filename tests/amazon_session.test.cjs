const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../sources/amazon/index.js'), 'utf8');

// What Amazon sends for a search with expired session credentials.
const serviceErrorDialog = {
  methods: [{
    interface: 'TemplateListInterface.v1_0.CreateAndBindTemplateMethod',
    template: {
      interface: 'Web.TemplatesInterface.v1_0.Touch.DialogTemplateInterface.DialogTemplate',
      header: 'Service error',
      body: { text: 'Sorry something went wrong.' },
    },
  }],
};

function runtime({ rejectFirstSearch = false, dialogFirstSearch = false } = {}) {
  const configRequests = [];
  const searchHeaders = [];
  const response = { methods: [{ interface: 'SearchTemplate' }] };
  const context = vm.createContext({
    URL, URLSearchParams,
    registerExtension() {},
    log: { info() {}, debug() {}, warn() {}, error() {} },
    utils: { isDownloadCancelled: () => false, sleep: () => true },
    fetch(url, options) {
      const parsed = new URL(url);
      if (parsed.pathname === '/config.json') {
        configRequests.push({ url, options });
        const config = { deviceId: 'fixture-device', sessionId: 'fixture-session' };
        // GET still returns HTTP 200, but Amazon no longer includes a CSRF token.
        if (options.method === 'POST' &&
            parsed.searchParams.get('skipToken') === 'false' &&
            parsed.searchParams.get('clientApplication') === 'skyfire') {
          config.csrf = { token: `token-${configRequests.length}`, ts: '1234567890', rnd: '987654321' };
        }
        return { ok: true, status: 200, json: () => config };
      }
      const headers = JSON.parse(JSON.parse(options.body).headers);
      searchHeaders.push(headers);
      if (!JSON.parse(headers['x-amzn-csrf']).token ||
          (rejectFirstSearch && searchHeaders.length === 1)) {
        return { ok: false, status: 403 };
      }
      if (dialogFirstSearch && searchHeaders.length === 1) {
        return { ok: true, status: 200, json: () => serviceErrorDialog };
      }
      return { ok: true, status: 200, json: () => response };
    },
  });
  vm.runInContext(source, context);
  return { context, configRequests, searchHeaders, response };
}

test('search obtains CSRF credentials through POST and reuses the session', () => {
  const app = runtime();
  assert.deepEqual(app.context.callShowSearch('First song'), app.response);
  assert.deepEqual(app.context.callShowSearch('Second song'), app.response);
  assert.equal(app.configRequests.length, 1);
  assert.equal(app.configRequests[0].options.method, 'POST');
  assert.equal(app.searchHeaders.length, 2);
  for (const headers of app.searchHeaders) {
    assert.equal(headers['x-amzn-device-id'], 'fixture-device');
    assert.equal(headers['x-amzn-session-id'], 'fixture-session');
    assert.deepEqual(JSON.parse(headers['x-amzn-csrf']), {
      interface: 'CSRFInterface.v1_0.CSRFHeaderElement',
      token: 'token-1', timestamp: '1234567890', rndNonce: '987654321',
    });
  }
});

test('a service error dialog with HTTP 200 renews the session before its retry', () => {
  const app = runtime({ dialogFirstSearch: true });
  assert.deepEqual(app.context.callShowSearch('Song'), app.response);
  assert.equal(app.configRequests.length, 2);
  assert.deepEqual(app.searchHeaders.map(headers => JSON.parse(headers['x-amzn-csrf']).token), [
    'token-1', 'token-2',
  ]);
});

test('a search page without results is not taken for a service error', () => {
  const app = runtime();
  app.response.methods = [{
    interface: 'TemplateListInterface.v1_0.BindTemplateMethod',
    template: { interface: 'Web.TemplatesInterface.v1_0.Touch.SearchTemplateInterface.SearchTemplate' },
  }];
  assert.deepEqual(app.context.callShowSearch('Unknown song'), app.response);
  assert.equal(app.configRequests.length, 1);
  assert.equal(app.searchHeaders.length, 1);
});

test('a rejected search refreshes CSRF through POST before its retry', () => {
  const app = runtime({ rejectFirstSearch: true });
  assert.deepEqual(app.context.callShowSearch('Song'), app.response);
  assert.equal(app.configRequests.length, 2);
  assert.ok(app.configRequests.every(request => request.options.method === 'POST'));
  assert.deepEqual(app.searchHeaders.map(headers => JSON.parse(headers['x-amzn-csrf']).token), [
    'token-1', 'token-2',
  ]);
});
