const test = require('node:test');
const assert = require('node:assert/strict');

// Isolate module + env state per test, matching the pattern used by
// googlePlaces.test.js.
function loadModule() {
  return require('../basicAuth');
}

function makeReq({ path = '/api/leads', authorization } = {}) {
  return {
    path,
    headers: authorization !== undefined ? { authorization } : {},
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function withEnv(vars, fn) {
  const originals = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function basicAuthHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

test('rejects requests with no Authorization header when credentials are configured', () => {
  withEnv({ BASIC_AUTH_USER: 'alvin', BASIC_AUTH_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['WWW-Authenticate'], 'Basic realm="Alvin Lead Hunter"');
  });
});

test('rejects wrong credentials', () => {
  withEnv({ BASIC_AUTH_USER: 'alvin', BASIC_AUTH_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq({ authorization: basicAuthHeader('alvin', 'wrong-password') });
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});

test('allows requests with correct credentials', () => {
  withEnv({ BASIC_AUTH_USER: 'alvin', BASIC_AUTH_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq({ authorization: basicAuthHeader('alvin', 'secret') });
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  });
});

test('always allows /api/health, even without credentials configured', () => {
  withEnv({ BASIC_AUTH_USER: 'alvin', BASIC_AUTH_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq({ path: '/api/health' });
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});

test('production with no credentials configured refuses every request (fails closed)', () => {
  withEnv({ BASIC_AUTH_USER: undefined, BASIC_AUTH_PASSWORD: undefined, NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
  });
});

test('non-production with no credentials configured passes through (dev/test convenience)', () => {
  withEnv({ BASIC_AUTH_USER: undefined, BASIC_AUTH_PASSWORD: undefined, NODE_ENV: 'test' }, () => {
    const basicAuth = loadModule();
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
  });
});

test('rejects a malformed Authorization header', () => {
  withEnv({ BASIC_AUTH_USER: 'alvin', BASIC_AUTH_PASSWORD: 'secret', NODE_ENV: 'production' }, () => {
    const basicAuth = loadModule();
    const req = makeReq({ authorization: 'Bearer some-token' });
    const res = makeRes();
    let nextCalled = false;

    basicAuth(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });
});
