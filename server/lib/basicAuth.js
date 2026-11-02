/**
 * HTTP Basic Auth gate for the whole app.
 *
 * SECURITY CONTEXT (Phase 23B1): before this file existed, every route —
 * including /api/leads, /api/leads/export.csv, /api/businesses, and
 * /api/searches — was reachable by anyone who could reach the server,
 * with no login step of any kind. This app has no user/session model
 * (see migrations/*.sql — there is no `users` table), so it is not
 * multi-tenant and there is no per-record ownership to enforce; the
 * vulnerability here is that the *entire* dataset and every
 * data-mutating/cost-incurring action (search, AI opportunity
 * analysis, CSV export of all leads) had zero access control at all.
 *
 * This middleware requires a single shared username/password (HTTP
 * Basic Auth, RFC 7617) for every request, checked server-side on every
 * request. It intentionally does NOT rely on anything shipped to the
 * browser bundle: the browser's native basic-auth prompt sends the
 * credential per request; it is never embedded in frontend JS the way a
 * baked-in API key would be (see Phase 23A1 on keeping secrets
 * server-side).
 *
 * Configuration: BASIC_AUTH_USER / BASIC_AUTH_PASSWORD (see .env.example).
 * - In production (NODE_ENV === 'production'), these are REQUIRED. If
 *   either is missing, every request is refused with 503 rather than
 *   silently running unprotected.
 * - Outside production (local dev/test), if unset, requests pass
 *   through unchanged so `npm run dev` / `npm test` keep working
 *   without extra setup.
 *
 * This is a pragmatic stopgap appropriate to a single-tenant internal
 * tool, not a full user/login system. If per-user accounts, audit
 * trails, or role-based access (e.g. a real /admin area) are ever
 * needed, that requires a dedicated users table, password hashing, and
 * session/token handling — a larger feature, not a one-file fix.
 */
const crypto = require('crypto');

// Requests to this path stay open regardless of auth config, so
// uptime monitors / load balancers can check liveness without a
// credential.
const OPEN_PATHS = new Set(['/api/health']);

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseBasicAuthHeader(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const [scheme, encoded] = headerValue.split(' ');
  if (scheme !== 'Basic' || !encoded) return null;

  let decoded;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return null;
  }

  const sep = decoded.indexOf(':');
  if (sep === -1) return { user: decoded, pass: '' };
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

function requireAuth(res) {
  res.set('WWW-Authenticate', 'Basic realm="Alvin Lead Hunter"');
  return res.status(401).json({ error: 'Authentication required.' });
}

function basicAuth(req, res, next) {
  if (OPEN_PATHS.has(req.path)) return next();

  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASSWORD;

  if (!expectedUser || !expectedPass) {
    if (process.env.NODE_ENV === 'production') {
      console.error(
        '[auth] BASIC_AUTH_USER/BASIC_AUTH_PASSWORD not set in production — refusing all requests.'
      );
      return res.status(503).json({ error: 'Server auth is not configured.' });
    }
    return next();
  }

  const credentials = parseBasicAuthHeader(req.headers.authorization);
  if (!credentials) return requireAuth(res);

  const userOk = timingSafeStringEqual(credentials.user, expectedUser);
  const passOk = timingSafeStringEqual(credentials.pass, expectedPass);
  if (!userOk || !passOk) return requireAuth(res);

  return next();
}

module.exports = basicAuth;
