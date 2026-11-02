/**
 * Backend database access for the API layer.
 *
 * Deliberately re-exports the SAME pool created in db/pool.js (Phase 3)
 * instead of creating a second connection pool. That file already
 * reads DATABASE_URL from the environment and throws if it's missing —
 * we don't duplicate that logic here.
 */
const pool = require('../db/pool');

module.exports = pool;
