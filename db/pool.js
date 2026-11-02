/**
 * Shared PostgreSQL connection pool for the Alvin Lead Hunter app.
 * Always reads the connection string from the environment — never
 * hard-code DATABASE_URL or credentials here.
 */
require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and fill in your Neon connection string.'
  );
}

// The database (Neon) is remote, so every NEW connection costs several
// network round trips (TCP + TLS + auth). The pg defaults close idle
// connections after 10s, which made the first request after any short
// pause pay that cost again. Keep connections around longer, and have
// the OS probe them so a connection Neon has dropped is noticed.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 5 * 60 * 1000,
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});

// An idle connection the server closed (Neon suspends idle compute) emits
// 'error' on the pool. Without a listener that would crash the process;
// with one, pg simply discards the dead connection and opens a new one.
pool.on('error', (err) => {
  console.error('[db] idle connection error (will reconnect):', err.message);
});

module.exports = pool;
