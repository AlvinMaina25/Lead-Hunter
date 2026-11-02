#!/usr/bin/env node
/**
 * Starts the Alvin Lead Hunter API server.
 *
 * Usage: npm run dev:api   (or npm start, in production)
 * Requires: DATABASE_URL in the environment (see .env.example)
 */
require('dotenv').config();
const createApp = require('./app');
const pool = require('./db');
const { markInterruptedPipelines } = require('./lib/searchPipelineService');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const PORT = process.env.PORT || 3001;
const app = createApp();

app.listen(PORT, () => {
  console.log(`Alvin Lead Hunter API listening on port ${PORT}`);

  // Post-search pipelines run inside this process, so any still marked
  // 'running' belong to a previous process that is gone. Fire and forget:
  // it never throws and must not delay startup.
  markInterruptedPipelines(pool).then((count) => {
    if (count > 0) console.log(`Marked ${count} interrupted search pipeline(s).`);
  });
});
