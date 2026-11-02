const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  SSRF_REASON,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedPort,
  hasBlockedScheme,
  resolvePublicAddresses,
  makePinnedLookup,
} = require('../ssrfGuard');
const { CHECK_STATUS, checkWebsiteReachability } = require('../httpChecker');

const UNKNOWN_RESULT = { status: CHECK_STATUS.UNKNOWN, httpStatus: null, finalUrl: null };

/** A fake http module that records whether a request was ever made. */
function makeSpyModule() {
  const spy = { requestCalled: false, lastOptions: null };
  spy.request = (_url, options, callback) => {
    spy.requestCalled = true;
    spy.lastOptions = options;
    const req = new EventEmitter();
    req.end = () => process.nextTick(() => callback({ statusCode: 200, destroy() {} }));
    req.destroy = (err) => process.nextTick(() => req.emit('error', err));
    return req;
  };
  return spy;
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const lookupReturning = (...addresses) => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** Runs the checker and asserts it refused without making a request. */
async function assertBlocked(url, lookup = publicLookup) {
  const spy = makeSpyModule();
  const result = await checkWebsiteReachability(url, {
    httpModule: spy,
    httpsModule: spy,
    lookup,
  });
  assert.deepEqual(result, UNKNOWN_RESULT, `expected ${url} to be blocked`);
  assert.equal(spy.requestCalled, false, `no request should be made for ${url}`);
}

// ---------------------------------------------------------------------
// localhost
// ---------------------------------------------------------------------

test('SSRF: localhost is blocked (http and https, with port, trailing dot, subdomain)', async () => {
  await assertBlocked('http://localhost');
  await assertBlocked('https://localhost');
  await assertBlocked('http://localhost:3000/admin');
  await assertBlocked('localhost');
  await assertBlocked('http://LOCALHOST./');
  await assertBlocked('http://app.localhost');
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('foo.localhost'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});

// ---------------------------------------------------------------------
// 127.0.0.1 and other loopback / unspecified forms
// ---------------------------------------------------------------------

test('SSRF: 127.0.0.1 and loopback variants are blocked', async () => {
  await assertBlocked('http://127.0.0.1');
  await assertBlocked('https://127.0.0.1:8443/');
  await assertBlocked('http://127.1.2.3');
  await assertBlocked('http://0.0.0.0');
  // WHATWG URL normalizes these obfuscated forms to 127.0.0.1
  await assertBlocked('http://2130706433');
  await assertBlocked('http://0x7f.0.0.1');
  await assertBlocked('http://017700000001');
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('0.0.0.0'), true);
});

// ---------------------------------------------------------------------
// private / link-local / reserved IPv4
// ---------------------------------------------------------------------

test('SSRF: private IPv4 addresses are blocked', async () => {
  await assertBlocked('http://10.0.0.5');
  await assertBlocked('http://172.16.0.1');
  await assertBlocked('http://172.31.255.254');
  await assertBlocked('https://192.168.1.1');
  await assertBlocked('http://100.64.0.1'); // CGNAT
});

test('SSRF: IPv4 link-local (incl. cloud metadata) is blocked', async () => {
  await assertBlocked('http://169.254.169.254/latest/meta-data/');
  await assertBlocked('http://169.254.0.1');
});

test('SSRF: IPv4 multicast and reserved addresses are blocked', async () => {
  for (const ip of ['224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '198.18.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  await assertBlocked('http://224.0.0.1');
  await assertBlocked('http://255.255.255.255');
});

test('SSRF: public IPv4 boundaries next to private ranges are allowed', () => {
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1', '192.169.0.1', '100.128.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

// ---------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------

test('SSRF: IPv6 loopback ([::1]) is blocked', async () => {
  await assertBlocked('http://[::1]');
  await assertBlocked('https://[::1]:8080/');
  await assertBlocked('http://[0:0:0:0:0:0:0:1]');
  await assertBlocked('http://[::]');
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('::'), true);
});

test('SSRF: IPv6 private/internal, link-local, multicast, reserved are blocked', async () => {
  for (const ip of ['fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  await assertBlocked('http://[fd00::1]');
  await assertBlocked('http://[fe80::1]');
  await assertBlocked('http://[ff02::1]');
});

test('SSRF: IPv4-mapped IPv6 addresses are judged by the embedded IPv4', async () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:10.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
  assert.equal(isBlockedAddress('::ffff:7f00:1'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
  await assertBlocked('http://[::ffff:127.0.0.1]');
});

test('SSRF: public IPv6 address is allowed', () => {
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
});

test('SSRF: unparseable / non-string addresses fail closed', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress(undefined), true);
  assert.equal(isBlockedAddress(null), true);
});

// ---------------------------------------------------------------------
// dangerous ports (Phase 23C1)
// ---------------------------------------------------------------------

test('SSRF: dangerous internal-service ports are blocked on an otherwise-public host', async () => {
  for (const port of [22, 25, 3306, 5432, 6379, 27017, 11211, 9200, 8009, 445, 3389]) {
    assert.equal(isBlockedPort(port), true, String(port));
    assert.equal(isBlockedPort(String(port)), true, String(port));
  }
  await assertBlocked('http://example.com:22/');
  await assertBlocked('https://example.com:5432/');
  await assertBlocked('http://example.com:6379/');
  await assertBlocked('http://93.184.216.34:3306/'); // dangerous port on a public IP literal
});

test('SSRF: ordinary web ports (default, and common alternates) are allowed', async () => {
  const spy = makeSpyModule();
  assert.equal(isBlockedPort(''), false);
  assert.equal(isBlockedPort(undefined), false);
  assert.equal(isBlockedPort(80), false);
  assert.equal(isBlockedPort(443), false);
  assert.equal(isBlockedPort(8080), false);
  assert.equal(isBlockedPort(8443), false);
  assert.equal(isBlockedPort(3000), false);

  const a = await checkWebsiteReachability('http://example.com:8080/', { httpModule: spy, httpsModule: spy, lookup: publicLookup });
  assert.equal(a.status, CHECK_STATUS.REACHABLE);
});

test('SSRF: port 0 and unparsable ports fail closed', () => {
  assert.equal(isBlockedPort(0), true);
  assert.equal(isBlockedPort('0'), true);
  assert.equal(isBlockedPort('not-a-port'), true);
  assert.equal(isBlockedPort(-1), true);
  assert.equal(isBlockedPort(70000), true);
});

test('SSRF: a redirect to a dangerous port is blocked, not followed', async () => {
  const spy = { requestCalled: 0 };
  spy.request = (_url, options, callback) => {
    spy.requestCalled += 1;
    const req = new EventEmitter();
    req.end = () =>
      process.nextTick(() =>
        callback({
          statusCode: 302,
          headers: { location: 'http://internal.example.com:6379/' },
          destroy() {},
        })
      );
    req.destroy = (err) => process.nextTick(() => req.emit('error', err));
    return req;
  };

  const result = await checkWebsiteReachability('https://example.com', {
    httpModule: spy,
    httpsModule: spy,
    lookup: publicLookup,
  });

  assert.deepEqual(result, UNKNOWN_RESULT);
  assert.equal(spy.requestCalled, 1); // only the original hop, redirect never connected
});

// ---------------------------------------------------------------------
// invalid protocols
// ---------------------------------------------------------------------

test('SSRF: file:, ftp:, javascript:, data: protocols are blocked', async () => {
  await assertBlocked('file:///etc/passwd');
  await assertBlocked('ftp://example.com/file.txt');
  await assertBlocked('javascript:alert(1)');
  await assertBlocked('JavaScript:alert(1)');
  await assertBlocked('data:text/html,<script>alert(1)</script>');
  await assertBlocked('data://example.com');
  assert.equal(hasBlockedScheme('file:///x'), true);
  assert.equal(hasBlockedScheme('ftp://x'), true);
  assert.equal(hasBlockedScheme('javascript:void(0)'), true);
  assert.equal(hasBlockedScheme('data:text/plain,hi'), true);
  assert.equal(hasBlockedScheme('https://example.com'), false);
  assert.equal(hasBlockedScheme('example.com:8080'), false);
});

// ---------------------------------------------------------------------
// hostname resolution
// ---------------------------------------------------------------------

test('SSRF: a hostname that resolves to a private IPv4 address is blocked', async () => {
  await assertBlocked('https://internal.example.com', lookupReturning('10.1.2.3'));
  await assertBlocked('https://sneaky.example.com', lookupReturning('127.0.0.1'));
  await assertBlocked('https://metadata.example.com', lookupReturning('169.254.169.254'));
});

test('SSRF: a hostname that resolves to IPv6 loopback/private is blocked', async () => {
  await assertBlocked('https://v6.example.com', lookupReturning('::1'));
  await assertBlocked('https://v6.example.com', lookupReturning('fd00::5'));
});

test('SSRF: a hostname with ANY private record among public ones is blocked', async () => {
  await assertBlocked('https://mixed.example.com', lookupReturning('93.184.216.34', '10.0.0.1'));
});

test('SSRF: DNS is resolved before connecting (lookup called, request comes after)', async () => {
  const order = [];
  const spy = makeSpyModule();
  const origRequest = spy.request;
  spy.request = (...args) => {
    order.push('request');
    return origRequest(...args);
  };
  const lookup = async (host) => {
    order.push(`lookup:${host}`);
    return [{ address: '93.184.216.34', family: 4 }];
  };

  await checkWebsiteReachability('https://example.com', { httpModule: spy, httpsModule: spy, lookup });

  assert.deepEqual(order, ['lookup:example.com', 'request']);
});

test('SSRF: the connection is pinned to the validated address', async () => {
  const spy = makeSpyModule();
  await checkWebsiteReachability('https://example.com', {
    httpModule: spy,
    httpsModule: spy,
    lookup: lookupReturning('93.184.216.34'),
  });

  assert.equal(typeof spy.lastOptions.lookup, 'function');
  const single = await new Promise((res) => spy.lastOptions.lookup('example.com', {}, (e, a, f) => res({ e, a, f })));
  assert.deepEqual(single, { e: null, a: '93.184.216.34', f: 4 });
  const all = await new Promise((res) => spy.lastOptions.lookup('example.com', { all: true }, (e, a) => res(a)));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
});

test('makePinnedLookup: supports callback-as-second-argument form', () => {
  const lookup = makePinnedLookup([{ address: '8.8.8.8', family: 4 }]);
  let got;
  lookup('x', (err, addr, fam) => { got = { err, addr, fam }; });
  assert.deepEqual(got, { err: null, addr: '8.8.8.8', fam: 4 });
});

test('SSRF: DNS failure is still reported as unreachable (not blocked)', async () => {
  const spy = makeSpyModule();
  const lookup = async () => {
    const err = new Error('getaddrinfo ENOTFOUND nope.invalid');
    err.code = 'ENOTFOUND';
    throw err;
  };
  const result = await checkWebsiteReachability('https://nope.invalid', { httpModule: spy, httpsModule: spy, lookup });
  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  assert.equal(result.httpStatus, null);
  assert.equal(spy.requestCalled, false);
});

test('SSRF: a hung DNS lookup times out as unreachable', async () => {
  const spy = makeSpyModule();
  const lookup = () => new Promise(() => {}); // never settles
  const result = await checkWebsiteReachability('https://slow-dns.example.com', {
    httpModule: spy,
    httpsModule: spy,
    lookup,
    timeoutMs: 20,
  });
  assert.equal(result.status, CHECK_STATUS.UNREACHABLE);
  assert.equal(spy.requestCalled, false);
});

test('resolvePublicAddresses: IP literals skip DNS', async () => {
  let called = false;
  const lookup = async () => { called = true; return []; };
  const ok = await resolvePublicAddresses('8.8.8.8', lookup);
  assert.equal(ok.ok, true);
  const bad = await resolvePublicAddresses('[::1]', lookup);
  assert.deepEqual([bad.ok, bad.reason], [false, SSRF_REASON.BLOCKED_ADDRESS]);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------
// valid public URLs still work
// ---------------------------------------------------------------------

test('SSRF: valid public https URL is allowed and checked', async () => {
  const spy = makeSpyModule();
  const result = await checkWebsiteReachability('https://example.com', {
    httpModule: spy,
    httpsModule: spy,
    lookup: publicLookup,
  });
  assert.deepEqual(result, { status: CHECK_STATUS.REACHABLE, httpStatus: 200, finalUrl: 'https://example.com' });
  assert.equal(spy.requestCalled, true);
});

test('SSRF: valid public http URL and schemeless domain are allowed', async () => {
  const spy = makeSpyModule();
  const a = await checkWebsiteReachability('http://example.com', { httpModule: spy, httpsModule: spy, lookup: publicLookup });
  assert.equal(a.status, CHECK_STATUS.REACHABLE);
  const b = await checkWebsiteReachability('example.com', { httpModule: spy, httpsModule: spy, lookup: publicLookup });
  assert.equal(b.status, CHECK_STATUS.REACHABLE);
  assert.equal(b.finalUrl, 'https://example.com');
});

test('SSRF: public IP-literal URLs are allowed (IPv4 and IPv6)', async () => {
  const spy = makeSpyModule();
  const v4 = await checkWebsiteReachability('http://8.8.8.8', { httpModule: spy, httpsModule: spy });
  assert.equal(v4.status, CHECK_STATUS.REACHABLE);
  const v6 = await checkWebsiteReachability('http://[2606:2800:220:1:248:1893:25c8:1946]', { httpModule: spy, httpsModule: spy });
  assert.equal(v6.status, CHECK_STATUS.REACHABLE);
});
