const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CHECK_STATUS, checkWebsiteReachability: rawCheck } = require('../httpChecker');

/**
 * Fake DNS: every hostname resolves to a public address, so these
 * tests never touch the real network. SSRF-specific behavior is
 * covered in ssrfGuard.test.js.
 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Wraps the real checker, defaulting to the fake public DNS. */
function checkWebsiteReachability(url, options = {}) {
  return rawCheck(url, { lookup: publicLookup, ...options });
}

/**
 * Builds a fake replacement for node:http / node:https whose `.request()`
 * behaves however the test tells it to, without ever touching the
 * network. This lets us deterministically exercise success, HTTP error
 * statuses, DNS failure, connection failure, TLS failure, and timeout —
 * none of which we want to depend on a real remote server for.
 *
 * @param {(req: EventEmitter, respond: (res: object) => void) => void} behavior
 */
function makeFakeHttpModule(behavior) {
  return {
    request(_url, _options, callback) {
      const req = new EventEmitter();
      req.end = () => {
        // Defer so listeners ('error', 'timeout') are attached before firing,
        // matching real Node's async behavior.
        process.nextTick(() => behavior(req, callback));
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err || new Error('socket destroyed')));
      };
      return req;
    },
  };
}

function fakeResponse(statusCode, headers = {}) {
  return {
    statusCode,
    headers,
    destroy() {
      /* no-op: simulates discarding the body without reading it */
    },
  };
}

/**
 * Fake http(s) module for redirect chains: `steps` is an array where
 * each entry describes what the Nth request should get back (a
 * response, via {statusCode, headers}, or a low-level failure, via
 * {error}). If the chain makes more requests than `steps` has entries,
 * the last entry repeats — handy for simulating an endless redirect
 * loop without listing dozens of hops by hand.
 *
 * @param {Array<{statusCode?: number, headers?: object, error?: Error}>} steps
 */
function makeStepHttpModule(steps) {
  let callIndex = 0;
  return {
    request(_url, _options, callback) {
      const req = new EventEmitter();
      req.end = () => {
        const step = steps[Math.min(callIndex, steps.length - 1)];
        callIndex += 1;
        process.nextTick(() => {
          if (step.error) {
            req.emit('error', step.error);
          } else {
            callback(fakeResponse(step.statusCode, step.headers));
          }
        });
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err || new Error('socket destroyed')));
      };
      return req;
    },
  };
}

// ---------------------------------------------------------------------
// reachable outcomes
// ---------------------------------------------------------------------

test('checkWebsiteReachability: successful 200 response -> reachable', async () => {
  const httpModule = makeFakeHttpModule((req, callback) => {
    callback(fakeResponse(200));
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, {
    status: CHECK_STATUS.REACHABLE,
    httpStatus: 200,
    finalUrl: 'https://example.com',
  });
});

test('checkWebsiteReachability: 403 response -> reachable', async () => {
  const httpModule = makeFakeHttpModule((req, callback) => {
    callback(fakeResponse(403));
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.httpStatus, 403);
});

test('checkWebsiteReachability: 404 response -> reachable', async () => {
  const httpModule = makeFakeHttpModule((req, callback) => {
    callback(fakeResponse(404));
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.httpStatus, 404);
});

test('checkWebsiteReachability: 500 response -> reachable', async () => {
  const httpModule = makeFakeHttpModule((req, callback) => {
    callback(fakeResponse(500));
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.httpStatus, 500);
});

test('checkWebsiteReachability: a redirect with no Location header is reachable, not followed', async () => {
  const httpModule = makeFakeHttpModule((req, callback) => {
    // 301 with no Location: nothing to follow, so this IS the final answer.
    callback(fakeResponse(301));
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.httpStatus, 301);
  assert.equal(result.finalUrl, 'https://example.com');
});

// ---------------------------------------------------------------------
// redirect handling (Phase 9B3)
// ---------------------------------------------------------------------

test('checkWebsiteReachability: a single redirect is followed to its final destination', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'https://example.com/page' } },
    { statusCode: 200 },
  ]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, {
    status: CHECK_STATUS.REACHABLE,
    httpStatus: 200,
    finalUrl: 'https://example.com/page',
  });
});

test('checkWebsiteReachability: a relative Location header resolves against the current URL', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 301, headers: { location: '/moved' } },
    { statusCode: 200 },
  ]);

  const result = await checkWebsiteReachability('https://example.com/old', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.finalUrl, 'https://example.com/moved');
});

test('checkWebsiteReachability: multiple redirects in a chain are all followed', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 301, headers: { location: 'https://example.com/hop1' } },
    { statusCode: 302, headers: { location: 'https://example.com/hop2' } },
    { statusCode: 307, headers: { location: 'https://example.com/hop3' } },
    { statusCode: 200 },
  ]);

  const result = await checkWebsiteReachability('https://example.com/start', {
    httpModule,
    httpsModule: httpModule,
  });

  assert.deepEqual(result, {
    status: CHECK_STATUS.REACHABLE,
    httpStatus: 200,
    finalUrl: 'https://example.com/hop3',
  });
});

test('checkWebsiteReachability: redirect chain longer than 5 hops is abandoned as unreachable', async () => {
  // Every response redirects to the next hop — an endless chain. Only
  // MAX_REDIRECTS (5) hops should ever be followed.
  let n = 0;
  const httpModule = {
    request(_url, _options, callback) {
      const req = new EventEmitter();
      req.end = () => {
        n += 1;
        const hop = n;
        process.nextTick(() => callback(fakeResponse(302, { location: `https://example.com/hop${hop}` })));
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err || new Error('socket destroyed')));
      };
      return req;
    },
  };

  const result = await checkWebsiteReachability('https://example.com/start', {
    httpModule,
    httpsModule: httpModule,
  });

  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  // 1 initial request + 5 followed redirects = 6 requests made, never more.
  assert.equal(n, 6);
  // The chain stopped at the 6th response (hop5), which was never followed.
  assert.equal(result.finalUrl, 'https://example.com/hop5');
});

test('checkWebsiteReachability: exactly 5 redirects succeeds (at the limit, not over it)', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'https://example.com/hop1' } },
    { statusCode: 302, headers: { location: 'https://example.com/hop2' } },
    { statusCode: 302, headers: { location: 'https://example.com/hop3' } },
    { statusCode: 302, headers: { location: 'https://example.com/hop4' } },
    { statusCode: 302, headers: { location: 'https://example.com/hop5' } },
    { statusCode: 200 },
  ]);

  const result = await checkWebsiteReachability('https://example.com/start', {
    httpModule,
    httpsModule: httpModule,
  });

  assert.equal(result.status, CHECK_STATUS.REACHABLE);
  assert.equal(result.finalUrl, 'https://example.com/hop5');
});

test('checkWebsiteReachability: redirect to localhost is rejected (unknown, never connected)', async () => {
  let requestCount = 0;
  const inner = makeStepHttpModule([{ statusCode: 302, headers: { location: 'http://localhost/admin' } }]);
  const httpModule = {
    request(url, opts, cb) {
      requestCount += 1;
      return inner.request(url, opts, cb);
    },
  };

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
  // Only the first (allowed) request happened — localhost was never connected to.
  assert.equal(requestCount, 1);
});

test('checkWebsiteReachability: redirect to a loopback IP (127.0.0.1) is rejected', async () => {
  const httpModule = makeStepHttpModule([{ statusCode: 302, headers: { location: 'http://127.0.0.1/' } }]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: redirect to a private IPv4 address (10.x) is rejected', async () => {
  const httpModule = makeStepHttpModule([{ statusCode: 302, headers: { location: 'http://10.0.0.5/internal' } }]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: redirect to a link-local address (cloud metadata IP) is rejected', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } },
  ]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: redirect to a private/loopback IPv6 address is rejected', async () => {
  const httpModule = makeStepHttpModule([{ statusCode: 302, headers: { location: 'http://[::1]/' } }]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: redirect to an invalid protocol (ftp:) is rejected', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'ftp://files.example.com/thing' } },
  ]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: redirect to a javascript: scheme is rejected', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'javascript:alert(1)' } },
  ]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

test('checkWebsiteReachability: mid-chain redirect to a private IP stops the chain, even after safe hops', async () => {
  const httpModule = makeStepHttpModule([
    { statusCode: 302, headers: { location: 'https://example.com/redirect' } },
    { statusCode: 302, headers: { location: 'http://127.0.0.1/' } },
  ]);

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
});

// ---------------------------------------------------------------------
// unreachable outcomes
// ---------------------------------------------------------------------

test('checkWebsiteReachability: DNS failure (ENOTFOUND) -> unreachable', async () => {
  const httpModule = makeFakeHttpModule((req) => {
    const err = new Error('getaddrinfo ENOTFOUND doesnotexist.invalid');
    err.code = 'ENOTFOUND';
    req.emit('error', err);
  });

  const result = await checkWebsiteReachability('https://doesnotexist.invalid', {
    httpModule,
    httpsModule: httpModule,
  });

  assert.deepEqual(result, {
    status: CHECK_STATUS.UNREACHABLE,
    httpStatus: null,
    finalUrl: 'https://doesnotexist.invalid',
  });
});

test('checkWebsiteReachability: connection refused -> unreachable', async () => {
  const httpModule = makeFakeHttpModule((req) => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:80');
    err.code = 'ECONNREFUSED';
    req.emit('error', err);
  });

  const result = await checkWebsiteReachability('http://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  assert.equal(result.httpStatus, null);
});

test('checkWebsiteReachability: TLS failure -> unreachable', async () => {
  const httpsModule = makeFakeHttpModule((req) => {
    const err = new Error('self-signed certificate');
    err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
    req.emit('error', err);
  });

  const result = await checkWebsiteReachability('https://example.com', {
    httpModule: httpsModule,
    httpsModule,
  });

  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
});

test('checkWebsiteReachability: timeout -> unreachable', async () => {
  const httpModule = {
    request(_url, _options, _callback) {
      const req = new EventEmitter();
      req.end = () => {
        // Simulate a stalled socket: fire the 'timeout' event the way
        // real Node does once the configured socket timeout elapses.
        // The callback is deliberately never invoked.
        process.nextTick(() => req.emit('timeout'));
      };
      req.destroy = (err) => {
        process.nextTick(() => req.emit('error', err || new Error('socket destroyed')));
      };
      return req;
    },
  };

  const result = await checkWebsiteReachability('https://slow.example.com', {
    httpModule,
    httpsModule: httpModule,
    timeoutMs: 10, // short timeout so the test stays fast
  });

  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  assert.equal(result.httpStatus, null);
});

test('checkWebsiteReachability: timeout event handler destroys the request', async () => {
  let destroyedWithTimeoutError = false;
  const httpModule = {
    request(_url, options, _callback) {
      const req = new EventEmitter();
      req.end = () => {
        // Fire the 'timeout' event asynchronously, as Node does when the
        // socket's configured timeout (options.timeout) elapses.
        process.nextTick(() => req.emit('timeout'));
      };
      req.destroy = (err) => {
        destroyedWithTimeoutError = Boolean(err && err.__isTimeout);
        process.nextTick(() => req.emit('error', err));
      };
      return req;
    },
  };

  const result = await checkWebsiteReachability('https://slow.example.com', {
    httpModule,
    httpsModule: httpModule,
    timeoutMs: 50,
  });

  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  assert.equal(destroyedWithTimeoutError, true);
});

// ---------------------------------------------------------------------
// unknown outcomes (cannot safely determine)
// ---------------------------------------------------------------------

test('checkWebsiteReachability: missing URL -> unknown, no request attempted', async () => {
  let requestCalled = false;
  const httpModule = {
    request() {
      requestCalled = true;
      return new EventEmitter();
    },
  };

  const result = await checkWebsiteReachability(undefined, { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
  assert.equal(requestCalled, false);
});

test('checkWebsiteReachability: invalid protocol -> unknown, no request attempted', async () => {
  let requestCalled = false;
  const httpModule = {
    request() {
      requestCalled = true;
      return new EventEmitter();
    },
  };

  const result = await checkWebsiteReachability('ftp://example.com', { httpModule, httpsModule: httpModule });

  assert.deepEqual(result, { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null });
  assert.equal(requestCalled, false);
});

test('checkWebsiteReachability: unrecognized error code -> unknown', async () => {
  const httpModule = makeFakeHttpModule((req) => {
    const err = new Error('something weird happened');
    err.code = 'EWEIRD_UNRECOGNIZED';
    req.emit('error', err);
  });

  const result = await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(result.status, CHECK_STATUS.UNKNOWN);
});

// ---------------------------------------------------------------------
// no-body guarantee
// ---------------------------------------------------------------------

test('checkWebsiteReachability: never reads the response body', async () => {
  let bodyWasRead = false;
  const httpModule = makeFakeHttpModule((req, callback) => {
    const res = fakeResponse(200);
    res.on = () => {
      bodyWasRead = true; // would only happen if code attached a 'data' listener
      return res;
    };
    callback(res);
  });

  await checkWebsiteReachability('https://example.com', { httpModule, httpsModule: httpModule });

  assert.equal(bodyWasRead, false);
});
