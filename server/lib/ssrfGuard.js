/**
 * SSRF protection for the website checker (Phase 9B2).
 *
 * Website URLs come from third-party data (Google Places), so before the
 * checker opens any socket we must make sure the target is a public
 * internet host. This module is pure policy: it decides whether a
 * protocol, hostname, or resolved IP address is allowed. It performs no
 * HTTP requests. The only I/O it can do is a DNS lookup, and that lookup
 * function is injectable so tests never touch the network.
 *
 * Blocked IPv4: 0.0.0.0/8, 10/8, 100.64/10 (CGNAT), 127/8 (loopback),
 *   169.254/16 (link-local), 172.16/12, 192.0.0/24, 192.0.2/24,
 *   192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24,
 *   224/4 (multicast), 240/4 (reserved) incl. 255.255.255.255.
 * Blocked IPv6: ::/128, ::1/128, fc00::/7 (unique local), fe80::/10
 *   (link-local), fec0::/10 (site-local), ff00::/8 (multicast),
 *   2001:db8::/32 (documentation), 2001::/32 (Teredo), 2002::/16 (6to4),
 *   64:ff9b::/96 (NAT64), 100::/64 (discard), and IPv4-mapped /
 *   IPv4-compatible forms whose embedded IPv4 address is blocked.
 *
 * Blocked ports (Phase 23C1): a denylist of non-web/internal-service
 * ports (SSH, databases, LDAP, SMB, Redis, cloud-orchestration
 * ports, etc. -- see BLOCKED_PORTS) is rejected even on an otherwise
 * public address, since a public IP can still run an internal-only
 * service on a non-standard port. This is a denylist, not an
 * allowlist, so ordinary alternate web ports (8080, 8443, 3000, ...)
 * stay usable.
 */

'use strict';

const dns = require('node:dns');
const net = require('node:net');

/** Only these protocols may ever be requested. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Schemes rejected outright, even when written without "//" (e.g.
 * "javascript:alert(1)", "data:text/html,..."), so they can never be
 * mistaken for a bare hostname:port.
 */
const BLOCKED_SCHEMES = new Set([
  'file',
  'ftp',
  'javascript',
  'data',
  'vbscript',
  'mailto',
  'gopher',
  'ws',
  'wss',
  'blob',
  'about',
]);

/** Reasons a target can be refused. */
const SSRF_REASON = Object.freeze({
  BLOCKED_PROTOCOL: 'blocked_protocol',
  BLOCKED_HOSTNAME: 'blocked_hostname',
  BLOCKED_ADDRESS: 'blocked_address',
  BLOCKED_PORT: 'blocked_port',
  INVALID_URL: 'invalid_url',
  DNS_FAILURE: 'dns_failure',
});

/**
 * Ports that are never allowed, even on an otherwise-public address.
 * Blocking by IP range alone doesn't stop a target from running an
 * internal-only service (a database, an admin protocol, a metadata
 * sidecar) on a non-web port of an address that happens to be public.
 * This is a denylist, not an allowlist, so ordinary alternate web ports
 * (8080, 8443, 3000, 5000, ...) are left usable.
 */
const BLOCKED_PORTS = new Set([
  20, 21, // FTP
  22, // SSH
  23, // Telnet
  25, 465, 587, // SMTP
  53, // DNS
  69, // TFTP
  110, 995, // POP3(S)
  111, // rpcbind
  123, // NTP
  135, // MSRPC
  137, 138, 139, 445, // NetBIOS / SMB
  143, 993, // IMAP(S)
  161, 162, // SNMP
  179, // BGP
  389, 636, // LDAP(S)
  427, // SLP
  512, 513, 514, // r-services / syslog
  873, // rsync
  1433, 1434, // MSSQL
  1521, // Oracle
  1723, // PPTP
  2049, // NFS
  2181, // ZooKeeper
  2375, 2376, // Docker daemon
  3260, // iSCSI
  3306, // MySQL
  3389, // RDP
  4369, // EPMD (Erlang/RabbitMQ)
  5432, // PostgreSQL
  5601, // Kibana
  5671, 5672, // AMQP
  5900, 5901, 5902, // VNC
  6379, // Redis
  7000, 7001, 7199, 9042, // Cassandra
  8009, // AJP
  9092, // Kafka
  9200, 9300, // Elasticsearch
  9418, // git protocol
  10250, 10255, // kubelet
  11211, // Memcached
  15672, // RabbitMQ management
  27017, 27018, 27019, // MongoDB
  50000, // DB2
  50070, // Hadoop NameNode
]);

// ---------------------------------------------------------------------
// IPv4 / IPv6 range tables
// ---------------------------------------------------------------------

/** [base address, prefix length] */
const BLOCKED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6_RANGES = [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const blockList = new net.BlockList();
for (const [base, prefix] of BLOCKED_IPV4_RANGES) blockList.addSubnet(base, prefix, 'ipv4');
for (const [base, prefix] of BLOCKED_IPV6_RANGES) blockList.addSubnet(base, prefix, 'ipv6');

/**
 * Expands any valid IPv6 string into 8 numeric 16-bit groups.
 * Handles "::" compression and a trailing dotted IPv4 part.
 *
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIPv6(ip) {
  let addr = ip.split('%')[0]; // drop zone id (fe80::1%eth0)
  let tail = [];

  const lastColon = addr.lastIndexOf(':');
  const maybeV4 = addr.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    if (net.isIPv4(maybeV4) === false) return null;
    const o = maybeV4.split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    addr = addr.slice(0, lastColon + 1) + '0:0';
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;

  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...rest].map(
    (g) => parseInt(g, 16)
  );
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  if (tail.length === 2) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

/**
 * If an IPv6 address embeds an IPv4 address (IPv4-mapped ::ffff:a.b.c.d
 * or IPv4-compatible ::a.b.c.d), returns that IPv4 as a dotted string.
 *
 * @param {number[]} g - 8 groups
 * @returns {string|null}
 */
function extractEmbeddedIPv4(g) {
  const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
  if (!firstFiveZero) return null;
  if (g[5] !== 0xffff && g[5] !== 0) return null;
  return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
}

/**
 * True if the IP address must NOT be connected to. Anything that is not
 * a syntactically valid IP is treated as blocked (fail closed).
 *
 * @param {unknown} ip
 * @returns {boolean}
 */
function isBlockedAddress(ip) {
  if (typeof ip !== 'string') return true;
  const family = net.isIP(ip);

  if (family === 4) return blockList.check(ip, 'ipv4');

  if (family === 6) {
    const groups = parseIPv6(ip);
    if (!groups) return true;
    const embedded = extractEmbeddedIPv4(groups);
    if (embedded) {
      // ::ffff:127.0.0.1 and ::127.0.0.1 are judged by their IPv4 part
      // (and the bare "::" / "::1" cases fall through to that check too).
      if (blockList.check(embedded, 'ipv4')) return true;
    }
    const canonical = groups.map((x) => x.toString(16)).join(':');
    return blockList.check(canonical, 'ipv6');
  }

  return true;
}

// ---------------------------------------------------------------------
// hostname / protocol checks
// ---------------------------------------------------------------------

/**
 * Strips IPv6 brackets and a trailing root dot, lowercases.
 * @param {string} hostname
 */
function cleanHostname(hostname) {
  let h = String(hostname).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/**
 * True for names that always mean "this machine": localhost and any
 * *.localhost subdomain (RFC 6761). Everything else is decided by what
 * it resolves to.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isBlockedHostname(hostname) {
  const h = cleanHostname(hostname);
  if (h.length === 0) return true;
  return h === 'localhost' || h.endsWith('.localhost');
}

/**
 * True if `port` is on the denylist of non-web/internal-service ports.
 * An empty string / undefined means "no explicit port" (i.e. the
 * protocol's default, 80 or 443), which is always allowed.
 *
 * @param {string|number|undefined|null} port - as read from URL#port
 * @returns {boolean}
 */
function isBlockedPort(port) {
  if (port === undefined || port === null || port === '') return false;
  const n = typeof port === 'number' ? port : Number.parseInt(port, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return true; // unparsable: fail closed
  if (n === 0) return true;
  return BLOCKED_PORTS.has(n);
}

/**
 * Rejects non-http(s) schemes on the raw stored value, including
 * scheme-without-slashes forms such as "javascript:alert(1)".
 *
 * @param {string} rawUrl
 * @returns {boolean} true if the scheme is one we refuse
 */
function hasBlockedScheme(rawUrl) {
  const m = /^\s*([a-zA-Z][a-zA-Z\d+\-.]*):/.exec(String(rawUrl));
  if (!m) return false;
  return BLOCKED_SCHEMES.has(m[1].toLowerCase());
}

// ---------------------------------------------------------------------
// DNS resolution
// ---------------------------------------------------------------------

/** Default resolver: resolves ALL addresses for a hostname. */
function defaultLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Resolves a hostname and verifies EVERY address it maps to is public.
 * A name with even one private/internal record is rejected, so a
 * split-record hostname can't sneak a blocked address through.
 *
 * IP-literal hostnames skip DNS and are checked directly.
 *
 * @param {string} hostname - URL hostname (IPv6 may be bracketed)
 * @param {(hostname: string) => Promise<Array<{address: string, family: number}>>} [lookup]
 * @returns {Promise<
 *   | { ok: true, addresses: Array<{ address: string, family: number }> }
 *   | { ok: false, reason: string, error?: Error }
 * >}
 */
async function resolvePublicAddresses(hostname, lookup = defaultLookup) {
  const host = cleanHostname(hostname);

  if (isBlockedHostname(host)) {
    return { ok: false, reason: SSRF_REASON.BLOCKED_HOSTNAME };
  }

  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (isBlockedAddress(host)) return { ok: false, reason: SSRF_REASON.BLOCKED_ADDRESS };
    return { ok: true, addresses: [{ address: host, family: literalFamily }] };
  }

  let records;
  try {
    records = await lookup(host);
  } catch (error) {
    return { ok: false, reason: SSRF_REASON.DNS_FAILURE, error };
  }

  if (!Array.isArray(records) || records.length === 0) {
    const error = new Error(`No DNS records for ${host}`);
    error.code = 'ENOTFOUND';
    return { ok: false, reason: SSRF_REASON.DNS_FAILURE, error };
  }

  for (const rec of records) {
    if (!rec || isBlockedAddress(rec.address)) {
      return { ok: false, reason: SSRF_REASON.BLOCKED_ADDRESS };
    }
  }

  return {
    ok: true,
    addresses: records.map((r) => ({ address: r.address, family: r.family || net.isIP(r.address) })),
  };
}

/**
 * Builds a `lookup` function for http(s).request that always answers
 * with the already-validated addresses. Connecting through this closes
 * the DNS-rebinding gap between "check" and "connect": the socket goes
 * to exactly the IP we approved, not to a second, possibly different,
 * DNS answer.
 *
 * @param {Array<{ address: string, family: number }>} addresses
 */
function makePinnedLookup(addresses) {
  return function pinnedLookup(_hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (opts.all) {
      cb(null, addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      cb(null, addresses[0].address, addresses[0].family);
    }
  };
}

module.exports = {
  ALLOWED_PROTOCOLS,
  BLOCKED_SCHEMES,
  BLOCKED_PORTS,
  SSRF_REASON,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedPort,
  hasBlockedScheme,
  resolvePublicAddresses,
  makePinnedLookup,
};
