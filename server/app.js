/**
 * Express app for the Alvin Lead Hunter API.
 *
 * This is the ONLY place that talks to Neon. The browser never
 * receives DATABASE_URL, credentials, or raw query/error details —
 * see the error handler at the bottom of this file.
 */
const path = require('path');
const express = require('express');
const cors = require('cors');

const basicAuth = require('./lib/basicAuth');
const dashboardRoutes = require('./routes/dashboard');
const leadsRoutes = require('./routes/leads');
const businessesRoutes = require('./routes/businesses');
const searchesRoutes = require('./routes/searches');
const analyticsRoutes = require('./routes/analytics');

function createApp() {
  const app = express();

  app.use(express.json());

  // Deployment fix: frontend (Render Static Site) and backend (Render
  // Web Service) are now separate origins, so the browser's CORS
  // preflight needs an explicit allow before anything else runs.
  // FRONTEND_URL is set in the backend's Render environment to the
  // deployed frontend's origin; falls back to reflecting the request
  // origin (`true`) when unset, e.g. in local dev.
  app.use(cors({
    origin: process.env.FRONTEND_URL || true,
    credentials: true,
  }));

  // Gate the ENTIRE app (API + the static frontend below) behind a
  // single shared credential. Before this, every route — including
  // /api/leads, /api/leads/export.csv, and /api/searches — was
  // reachable by anyone with network access, with no login of any
  // kind. See server/lib/basicAuth.js for full rationale/config.
  app.use(basicAuth);

  // Simple liveness check — no database access, safe to call freely.
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/leads', leadsRoutes);
  app.use('/api/businesses', businessesRoutes);
  app.use('/api/searches', searchesRoutes);
  app.use('/api/analytics', analyticsRoutes);

  // In production this same process also serves the built frontend, so
  // the whole app runs as a single deployable unit with no CORS and no
  // second origin to configure. In development the Vite dev server
  // proxies /api to this process instead (see frontend/vite.config.ts).
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(__dirname, '..', 'frontend', 'dist');
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Centralized error handler.
  // IMPORTANT: never send err.message, err.stack, or any part of the
  // raw error to the client, and never log DATABASE_URL or connection
  // config — only a short server-side message for debugging.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[api error]', err.message);
    res.status(500).json({ error: 'Something went wrong while reading from the database.' });
  });

  return app;
}

module.exports = createApp;