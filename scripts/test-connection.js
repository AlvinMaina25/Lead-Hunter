#!/usr/bin/env node
/**
 * Verifies that DATABASE_URL points to a reachable Postgres/Neon
 * database. Never prints the connection string or password.
 *
 * Usage: npm run test:connection
 */
require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
  }

  // Redact credentials before ever logging anything derived from the URL.
  let hostForDisplay = '(unknown host)';
  try {
    const u = new URL(process.env.DATABASE_URL);
    hostForDisplay = u.hostname;
  } catch {
    // ignore parse errors; we still won't print the raw string
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const result = await pool.query('SELECT now() AS server_time, current_database() AS db');
    console.log(`Connected successfully to database "${result.rows[0].db}" at host ${hostForDisplay}`);
    console.log(`Server time: ${result.rows[0].server_time}`);
    process.exit(0);
  } catch (err) {
    console.error(`Connection FAILED (host: ${hostForDisplay}): ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
