/**
 * Manual business search (Phase 7, extended by Phase 20 Part 1).
 *
 * This is the logic that used to live inline in
 * server/routes/searches.js's POST handler, moved here unchanged in
 * behavior so it can be unit tested with a fake pool and a fake Google
 * client (the routes file needs Express and a live database to load;
 * this file needs neither) -- the same pattern as leadDetailService.js.
 *
 * Phase 20 adds a search CONFIGURATION on top of the existing flow:
 *
 *   category, location, keyword?          (existing)
 *   radius_meters?                        -> Google locationBias + a distance filter
 *   max_results?                          -> Google maxResultCount / result cap
 *   analysis_options.{website,ai}_analysis -> persisted, then acted on by
 *                                             the post-search pipeline
 *
 * There is still exactly ONE Google Places integration
 * (googlePlaces.js#textSearch); this module only decides what to ask it.
 *
 * ANALYSIS OPTIONS ARE NOT EXECUTED IN THIS MODULE, but they are no
 * longer stored-only. The choices are persisted on the `searches` row
 * (website_analysis_requested, ai_analysis_requested), and once the
 * search has completed the handler hands that search's businesses to the
 * injected `startPipeline` (searchPipelineService.startSearchPipeline in
 * production -- see server/routes/searches.js), which runs the requested
 * analyses and lead scoring IN THE BACKGROUND. The response never waits
 * for it. Without a `startPipeline` dependency (as in this module's own
 * tests) the handler behaves exactly as it did before the pipeline existed.
 */

'use strict';

const googlePlaces = require('./googlePlaces');
const { ValidationError, validateSearchConfiguration } = require('./validation');
const { normalizePlace } = require('./normalize');

const { GooglePlacesError, PAGE_SIZE, buildSearchQuery, distanceMeters, resolveLocationCenter } = googlePlaces;

// The columns of `searches` the API returns (GET /api/searches and the
// `search` object of POST /api/searches). Same order as the Phase 7 list
// with the Phase 20 configuration columns and the post-search pipeline
// columns (migration 008) appended.
const SEARCH_COLUMNS = `
  id, search_query, category, location, keyword, results_count, started_at,
  completed_at, status, radius_meters, max_results,
  website_analysis_requested, ai_analysis_requested,
  pipeline_status, pipeline_started_at, pipeline_completed_at,
  pipeline_summary, pipeline_failures
`;

// Same column list/order as GET /api/businesses, so a freshly discovered
// business matches the shape the frontend's Business type already expects.
const BUSINESS_COLUMNS = `
  id, external_place_id, name, category, phone, email, address, city, country,
  latitude, longitude, google_maps_url, google_rating, google_review_count,
  website_url, website_status, created_at, updated_at
`;

/**
 * Turns a raw `searches` row into the API shape: the two boolean
 * columns become one nested `analysis_options` object, the five
 * pipeline_* columns become one nested `pipeline` object, and every
 * other column passes through under its own name.
 *
 * `pipeline` is only added when the row actually carries the pipeline
 * columns, so a row that predates them maps exactly as it used to.
 *
 * @param {object} row
 */
function toSearchRecord(row) {
  const {
    website_analysis_requested: websiteAnalysis,
    ai_analysis_requested: aiAnalysis,
    pipeline_status: pipelineStatus,
    pipeline_started_at: pipelineStartedAt,
    pipeline_completed_at: pipelineCompletedAt,
    pipeline_summary: pipelineSummary,
    pipeline_failures: pipelineFailures,
    ...rest
  } = row;

  const record = {
    ...rest,
    analysis_options: {
      website_analysis: Boolean(websiteAnalysis),
      ai_analysis: Boolean(aiAnalysis),
    },
  };

  if (pipelineStatus !== undefined) {
    record.pipeline = {
      status: pipelineStatus,
      started_at: pipelineStartedAt ?? null,
      completed_at: pipelineCompletedAt ?? null,
      summary: pipelineSummary ?? null,
      failures: Array.isArray(pipelineFailures) ? pipelineFailures : [],
    };
  }

  return record;
}

/**
 * Inserts a normalized business, or -- if a business with the same
 * external_place_id already exists -- reuses it untouched.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING + a follow-up SELECT rather than
 * the common "RETURNING (xmax = 0)" trick, because that trick does not
 * reliably distinguish insert from update in Postgres (the new tuple from
 * either path has xmax = 0). This two-step approach is slightly less
 * elegant but is unambiguous.
 *
 * @param {{query: Function}} pool
 * @returns {Promise<{ business: object, isNew: boolean }>}
 */
async function upsertBusiness(pool, biz) {
  const values = [
    biz.external_place_id,
    biz.name,
    biz.category,
    biz.phone,
    biz.address,
    biz.city,
    biz.country,
    biz.latitude,
    biz.longitude,
    biz.google_maps_url,
    biz.google_rating,
    biz.google_review_count,
    biz.website_url,
    biz.website_status,
    // Only present when Google returned an international number (see normalize.js).
    biz.international_phone || null,
  ];

  const inserted = await pool.query(
    `
      INSERT INTO businesses (
        external_place_id, name, category, phone, address, city, country,
        latitude, longitude, google_maps_url, google_rating, google_review_count,
        website_url, website_status, international_phone
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (external_place_id) DO NOTHING
      RETURNING ${BUSINESS_COLUMNS}
    `,
    values
  );

  if (inserted.rows.length > 0) {
    return { business: inserted.rows[0], isNew: true };
  }

  const existing = await pool.query(
    `SELECT ${BUSINESS_COLUMNS} FROM businesses WHERE external_place_id = $1`,
    [biz.external_place_id]
  );

  if (existing.rows.length > 0) {
    return { business: existing.rows[0], isNew: false };
  }

  // Extremely unlikely race (row deleted between the two queries above).
  // Fall back to a plain insert so the search doesn't silently drop a result.
  const fallback = await pool.query(
    `
      INSERT INTO businesses (
        external_place_id, name, category, phone, address, city, country,
        latitude, longitude, google_maps_url, google_rating, google_review_count,
        website_url, website_status, international_phone
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING ${BUSINESS_COLUMNS}
    `,
    values
  );

  return { business: fallback.rows[0], isNew: true };
}

/**
 * Inserts the `searches` row for a new manual search, status 'running',
 * persisting the whole validated configuration.
 *
 * @param {{query: Function}} pool
 * @param {ReturnType<typeof validateSearchConfiguration>} config
 * @param {string} searchQuery
 * @returns {Promise<object>} the raw inserted row
 */
async function insertSearch(pool, config, searchQuery) {
  const { rows } = await pool.query(
    `
      INSERT INTO searches (
        search_query, category, location, keyword, radius_meters, max_results,
        website_analysis_requested, ai_analysis_requested, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')
      RETURNING ${SEARCH_COLUMNS}
    `,
    [
      searchQuery,
      config.category,
      config.location,
      config.keyword || null,
      config.radius_meters,
      config.max_results,
      config.analysis_options.website_analysis,
      config.analysis_options.ai_analysis,
    ]
  );
  return rows[0];
}

/**
 * Asks Google for places matching the configuration, applying radius
 * and max_results.
 *
 * With a radius: the centre of `location` is resolved (one extra,
 * single-field Text Search), the query is biased to that circle, and
 * results outside the radius are dropped -- a locationBias only
 * PREFERS nearby places, so the filter is what makes the radius a real
 * limit. A place without coordinates can't be shown to be inside the
 * radius, so it is dropped too. Google is asked for a full page in that
 * case (some results will be filtered out); the final list is capped at
 * max_results either way.
 *
 * Without a radius: exactly the pre-Phase-20 query, except that Google
 * is asked for max_results (paged in 20s) instead of always 20.
 *
 * @param {ReturnType<typeof validateSearchConfiguration>} config
 * @param {string} searchQuery
 * @param {typeof googlePlaces.textSearch} textSearch
 * @returns {Promise<{ places: object[], placesReturned: number, excludedByRadius: number }>}
 * @throws {GooglePlacesError}
 */
async function findPlaces(config, searchQuery, textSearch) {
  if (config.radius_meters === null) {
    const places = await textSearch(searchQuery, { maxResultCount: config.max_results });
    return { places, placesReturned: places.length, excludedByRadius: 0 };
  }

  const center = await resolveLocationCenter(config.location, textSearch);
  if (!center) {
    throw new GooglePlacesError(
      `Could not find map coordinates for "${config.location}", so the search radius cannot be applied. ` +
        'Try a more specific location, or search without a radius.',
      { statusCode: 422, reason: 'LOCATION_NOT_FOUND' }
    );
  }

  const found = await textSearch(searchQuery, {
    // At least a full page, since some results will be filtered out by
    // the radius; never more than the caller asked for beyond that.
    maxResultCount: Math.max(PAGE_SIZE, config.max_results),
    locationBias: { ...center, radius: config.radius_meters },
  });

  const places = found.filter((place) => {
    const point = place && place.location;
    return (
      point &&
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      distanceMeters(center, point) <= config.radius_meters
    );
  });

  return { places, placesReturned: found.length, excludedByRadius: found.length - places.length };
}

/**
 * Express handler factory for POST /api/searches. Exported as a factory
 * (dependencies injected) so tests can drive it with a fake pool, a
 * fake Google client and plain req/res objects.
 *
 * Status codes: 400 invalid configuration; 503 no GOOGLE_PLACES_API_KEY;
 * Google failures use GooglePlacesError's own statusCode (422 when a
 * radius was requested but the location can't be located) with the
 * `searchId` of the record marked 'failed'; anything else goes to
 * `next` (the app's generic 500).
 *
 * `startPipeline`, when given, is called once the search has been
 * stored and marked 'completed', with that search's id, the ids of ITS
 * businesses and its analysis options. It must return promptly with the
 * pipeline's initial state (it runs the actual work in the background),
 * which is attached to the response as `search.pipeline`. Whatever it
 * does -- including throwing -- can never fail or alter the search
 * response beyond that one additive field.
 *
 * @param {{
 *   pool: {query: Function},
 *   textSearch?: typeof googlePlaces.textSearch,
 *   startPipeline?: (args: { searchId: string, businessIds: string[], options: { website_analysis: boolean, ai_analysis: boolean } }) => Promise<object>,
 * }} deps
 */
function createSearchHandler({ pool, textSearch = googlePlaces.textSearch, startPipeline = null }) {
  return async function handleCreateSearch(req, res, next) {
    let config;
    try {
      config = validateSearchConfiguration(req.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ error: err.message });
      }
      return next(err);
    }

    if (!process.env.GOOGLE_PLACES_API_KEY) {
      return res.status(503).json({
        error: 'Google Places integration is not configured. Set GOOGLE_PLACES_API_KEY on the server and restart.',
      });
    }

    const searchQuery = buildSearchQuery(config);

    let searchRow;
    try {
      searchRow = await insertSearch(pool, config, searchQuery);
    } catch (err) {
      return next(err);
    }

    try {
      const { places, placesReturned, excludedByRadius } = await findPlaces(config, searchQuery, textSearch);

      const businesses = [];
      let rank = 0;

      for (const place of places) {
        if (rank >= config.max_results) break;

        const normalized = normalizePlace(place);
        if (!normalized) continue; // missing Google place id or name — can't be stored safely
        rank += 1;

        const { business, isNew } = await upsertBusiness(pool, normalized);

        await pool.query(
          `
            INSERT INTO search_results (search_id, business_id, rank_position)
            VALUES ($1, $2, $3)
            ON CONFLICT (search_id, business_id) DO NOTHING
          `,
          [searchRow.id, business.id, rank]
        );

        businesses.push({ ...business, isNew });
      }

      const { rows: completedRows } = await pool.query(
        `
          UPDATE searches
          SET results_count = $2, completed_at = now(), status = 'completed'
          WHERE id = $1
          RETURNING ${SEARCH_COLUMNS}
        `,
        [searchRow.id, businesses.length]
      );

      const search = toSearchRecord(completedRows[0]);

      if (startPipeline) {
        // The search is already stored and completed at this point, so a
        // pipeline problem must never reach the catch block below (which
        // would mark the search 'failed') or change the response shape.
        try {
          search.pipeline = await startPipeline({
            searchId: searchRow.id,
            businessIds: businesses.map((business) => business.id),
            // Businesses that were already in the database: the pipeline
            // only runs the stages these have never had.
            knownBusinessIds: businesses.filter((business) => !business.isNew).map((business) => business.id),
            options: { ...search.analysis_options },
          });
        } catch (pipelineErr) {
          console.error('[search pipeline] could not start', searchRow.id, pipelineErr.message);
        }
      }

      return res.json({
        search,
        businesses,
        summary: {
          places_returned: placesReturned,
          excluded_outside_radius: excludedByRadius,
          results_count: businesses.length,
        },
      });
    } catch (err) {
      // Best-effort: mark the search as failed rather than leaving it stuck
      // at "running". A failure here must never mask the original error.
      try {
        await pool.query(`UPDATE searches SET status = 'failed', completed_at = now() WHERE id = $1`, [
          searchRow.id,
        ]);
      } catch {
        // ignore — we still report the original error below
      }

      if (err instanceof GooglePlacesError) {
        return res.status(err.statusCode).json({ error: err.message, searchId: searchRow.id });
      }

      return next(err);
    }
  };
}

module.exports = {
  SEARCH_COLUMNS,
  toSearchRecord,
  upsertBusiness,
  insertSearch,
  findPlaces,
  createSearchHandler,
};
