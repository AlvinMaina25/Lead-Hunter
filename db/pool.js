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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

module.exports = pool;
