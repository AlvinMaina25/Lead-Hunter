# Alvin Lead Hunter — Database Setup

Internal lead-generation and sales-intelligence platform for Alvin Solutions.
This package contains the PostgreSQL (Neon) schema, migrations, and
connection tooling only — no application features yet, as requested.

## What's automated for you

- The full relational schema (7 tables, constraints, indexes, triggers).
- A migration runner that creates the schema in one command.
- A connection test script that checks Neon is reachable without ever
  printing your password.
- `.env.example`, `.gitignore` already set up so secrets can't leak into Git.

## What you must do manually

Neon account creation, obtaining a connection string, and installing
dependencies all require actions on your machine/account that Claude
cannot perform for you. See **"Manual steps"** in the summary below.

## Setup

```bash
npm install
cp .env.example .env
# open .env and paste your real Neon connection string into DATABASE_URL
npm run test:connection   # confirms Neon is reachable
npm run migrate           # creates all 7 tables
```

## Project layout

```
alvin-lead-hunter/
├── db/
│   └── pool.js               # shared pg connection pool (reads DATABASE_URL)
├── server/                   # Phase 6 — backend/API layer (Express)
│   ├── index.js               # entrypoint; loads .env, starts listening
│   ├── app.js                 # route mounting, static frontend serving in prod, error handler
│   ├── db.js                  # re-exports db/pool.js — one pool, no duplication
│   ├── lib/                    # Phase 7 — pure, unit-tested helpers used by routes
│   │   ├── validation.js       # POST /api/searches input validation
│   │   ├── googlePlaces.js     # Google Places API (New) Text Search client + error mapping
│   │   ├── normalize.js        # Google result -> businesses table row normalization
│   │   ├── searchService.js    # Phase 20: manual search flow (config -> Google -> businesses/searches)
│   │   ├── searchPipelineService.js  # post-search pipeline: checks/analyses/scoring for one search's businesses
│   │   └── __tests__/          # node:test unit tests (run with `npm test`)
│   └── routes/
│       ├── dashboard.js       # GET /api/dashboard/metrics
│       ├── leads.js           # GET /api/leads (joined with businesses + ai_analysis)
│       ├── businesses.js      # GET /api/businesses
│       └── searches.js        # GET /api/searches, POST /api/searches (Phase 7: Google Places discovery)
├── migrations/
│   └── 001_init_schema.sql   # full schema: tables, constraints, indexes, triggers (unchanged since Phase 3)
├── scripts/
│   ├── migrate.js            # applies pending migrations, tracks history
│   └── test-connection.js    # verifies DATABASE_URL works
├── frontend/                 # React + TypeScript + Tailwind dashboard (Phase 5)
│   └── src/lib/api.ts         # fetches from /api/* — the only place the frontend talks to the backend
├── .env.example
├── .gitignore
└── package.json
```

## Running the full app locally (Phase 6)

```bash
npm install                     # root deps: express, pg, dotenv, concurrently, cross-env
npm --prefix frontend install   # frontend deps
cp .env.example .env            # fill in your real Neon DATABASE_URL and GOOGLE_PLACES_API_KEY
npm run migrate                 # if not already applied

npm run dev                     # runs the API (port 3001) and the Vite dev server (port 5173) together
```

### Phase 7 — Google Places business discovery

The Searches page (`/searches`) now has a form (category, location, optional
keyword) that calls `POST /api/searches`. That endpoint:

1. Validates the input (`server/lib/validation.js`).
2. Runs one Google Places API (New) Text Search request server-side
   (`server/lib/googlePlaces.js`) — the browser never talks to Google directly.
3. Normalizes each result (`server/lib/normalize.js`) — trims whitespace,
   turns empty strings into `NULL`, and only pulls city/country from
   Google's structured `addressComponents`, never guessed from free text.
4. Upserts each business into `businesses`, deduplicated by
   `external_place_id` (Google's Place ID) — a rediscovered business reuses
   its existing row rather than creating a duplicate.
5. Links every business to the search via `search_results`, and updates the
   `searches` record's `status`/`results_count`/`completed_at`.

**Requires `GOOGLE_PLACES_API_KEY`** in `.env` (server-side only — see
Security below). Without it, `POST /api/searches` returns `503` and
explains what to do; `GET` endpoints and the rest of the dashboard are
unaffected.

### Phase 20 Part 1 — search configuration

`POST /api/searches` now accepts an optional **search configuration** on top
of `category` / `location` / `keyword`. Every new field is optional, so Phase 7
callers are unchanged.

| Field | Type | Rules | Default |
|---|---|---|---|
| `radius_meters` | number or `null` | `0 < r <= 50000` (Google `locationBias` limit) | `null` = no radius |
| `max_results` | integer | `1..50` (Google pages of 20, so up to 3 requests) | `20` |
| `analysis_options.website_analysis` | boolean | strict boolean | `false` |
| `analysis_options.ai_analysis` | boolean | strict boolean | `false` |

Invalid values return `400` with a specific message (nothing is stored, Google
is not called); values are never coerced. The configuration is persisted on the
`searches` row (migration `007_search_configuration.sql` — run `npm run migrate`)
and returned by both `GET` and `POST /api/searches`. The response is
`{ search, businesses, summary }`.

With a radius, the centre of `location` is resolved with one extra single-field
Text Search, the query is biased to that circle, and results outside it are
dropped. The analysis options are acted on by the post-search pipeline below.

### Post-search pipeline

After a search completes, the businesses of **that search only** are run through
the existing services, in this order:

1. website check + website analysis — only if `analysis_options.website_analysis`
2. AI opportunity analysis — only if `analysis_options.ai_analysis`
3. lead scoring — **always** (deterministic, no external calls, no AI input; the
   scoring rules and weights are unchanged)

It runs **in the background**: `POST /api/searches` returns as soon as the search
is stored, with the same `{ search, businesses, summary }` body plus one additive
field, `search.pipeline` (status `running`). Each business and stage is isolated —
a failure is recorded and the rest carry on, and nothing in the pipeline can fail
the search. Businesses already stored by earlier searches that Google returns again
are included; every requested stage runs for them again.

`GET /api/searches` returns the stored outcome for each search as `pipeline`:

| Field | Meaning |
|---|---|
| `status` | `not_run` (searches from before this feature), `running`, `completed`, `completed_with_errors`, `failed` (the pipeline itself crashed), `interrupted` (the server restarted mid-run; set at startup) |
| `started_at` / `completed_at` | timestamps; `completed_at` is `null` while running |
| `summary` | counts: `businesses_total`, `website_checked`, `website_analyzed`, `website_analysis_skipped`, `ai_analyzed`, `scored`, `businesses_with_failures` |
| `failures` | `[{ business_id, stage, code }]` — error codes only, never raw error text |

The pipeline runs inside the API process, so a restart while it is running
interrupts it. Re-run the missing work with the per-business endpoints, or score
the remainder with the batch endpoint below.

**Requires migration `008_search_pipeline.sql`** (adds the `pipeline_*` columns to
`searches`). It is purely additive and idempotent — run `npm run migrate`, which
applies only pending migrations; re-running the file by hand is also safe. Apply it
**before** deploying this code: `GET /api/searches` reads the new columns.

### Scoring businesses that have no lead yet

A lead exists only once a business has been scored. `POST /api/businesses/lead-score`
takes `{ limit?, only_unscored? }`:

- default (unchanged): the oldest `limit` businesses, scored or not — so repeated
  calls re-score the same oldest ones
- `only_unscored: true`: the oldest `limit` businesses **with no lead row**, so each
  call moves on to businesses never scored. Must be a boolean (`400` otherwise);
  `limit` keeps its `1..50` bounds (default 20)

`GET /api/businesses/unscored-count` returns `{ "unscored_count": n }`, the size of
that set. The **Leads** page has a **Score new businesses (n)** button: it scores up
to 50 unscored businesses, shows how many were scored/failed, then refreshes the
list. A business that fails stays unscored, so the next click retries it. The button
is hidden in demo mode.

Run the Phase 7 unit tests (pure validation/normalization/Google-client
logic, no database or network required — Google's API is mocked):

```bash
npm test
```

Open http://localhost:5173 — the dashboard fetches real data from Neon through the API. Vite proxies
`/api/*` requests to the backend on port 3001 in dev (see `frontend/vite.config.ts`), so there's no
CORS setup needed.

To run just one side: `npm run dev:api` (backend only) or `npm run dev:web` (frontend only).

### Contactable leads (phones, website contacts)

**Requires migration `009_contacts.sql`** — adds `businesses.international_phone`
(+ `international_phone_checked_at`) and the `business_contacts` table. Purely
additive and idempotent: run `npm run migrate` (applies only pending migrations;
re-running the file by hand is also safe). Until it is applied the app keeps working —
the Leads list, lead detail and CSV export fall back to "no contact data" instead of
erroring.

**Phone data (all businesses).** The Places field mask now also requests
`internationalPhoneNumber`, stored as Google returns it (`+254 20 123 4567`). A country
code is **never guessed**: `server/lib/phone.js` turns an international number into
digits-only E.164 (`254201234567`) for `wa.me` links, and returns `null` for anything
without a leading `+`. A `tel:` link works from either number; a `wa.me` link needs the
international one.

**Backfilling existing businesses** (so searches needn't be re-run). Each business is
one billed Google *Place Details* request, so it is bounded:

```bash
npm run backfill:international-phone                  # default 25
npm run backfill:international-phone -- --limit 100   # 1..200
# or: POST /api/businesses/backfill-international-phone  { "limit": 100 }
```

It only selects businesses that have a phone, no international number, a Google place
id, and have never been asked; concurrency is 3. A business Google has no number for is
marked checked and not re-fetched; a failed request is retried by a later run; a
run-level error (bad key, permission, quota) stops the run. Output includes
`remaining_estimate` — repeat until it reaches 0. Needs `GOOGLE_PLACES_API_KEY`.

**Website contacts (businesses with a website).** Website analysis now also
extracts contacts, best-effort and after the analysis row is saved (it can never fail or
downgrade an analysis). It reuses the homepage HTML already fetched and makes **at most
one** extra request: a single same-site contact page (`/contact`, `/contact-us`, a link
whose text mentions "contact", else `/about`), fetched through the same SSRF-guarded,
size/time-limited `safeFetchHomepage` (contact page: 8 s, 1 MB). It extracts:

- emails — `mailto:` first, then text; lowercased, deduped, max 5; junk filtered
  (`name@2x.png`-style filenames, example/placeholder domains and local parts,
  no-reply addresses, error-tracking addresses)
- social profiles — Instagram, Facebook, TikTok, X, LinkedIn, YouTube; profile URLs
  only (share/embed/post/login links rejected), rebuilt in canonical form, max 2 per
  platform
- WhatsApp links (`wa.me`, `api.whatsapp.com`) — normalized to `wa.me/<digits>`;
  share links and numbers without a country code are rejected
- `tel:` numbers and the contact page URL

Nothing is guessed (no `info@domain`). Each contact is stored in `business_contacts`
with `source_url` and `found_at`; re-analysis updates the existing row
(`UNIQUE (business_id, contact_type, value)`). `businesses.email` is filled only when
it is NULL. Contacts that are no longer found on the site are left in place.

**No website.** The lead detail shows the Google phone as a `tel:` link, a **Try
WhatsApp** `wa.me` link (only when an international number exists; labelled "try"
because we cannot know the number is on WhatsApp), and Google / Instagram search links
built from name + city. The "Instagram" link is a Google search restricted to
`instagram.com` (Instagram's own search can't be deep-linked).

**API / UI.** `GET /api/leads/:id` returns a `contacts` block; `GET /api/leads` adds
`has_phone` / `has_email` / `has_social` / `has_whatsapp` flags per lead. Lead Detail
has a **Contact details** panel; every URL is validated (only `http`, `https`, `mailto`,
`tel`) before being rendered as a link, and anything that fails is shown as plain text.
The Leads table has contact indicators and a "Has email / Has any contact" filter.
`GET /api/leads/export.csv` gains **Email** and **WhatsApp / Social** columns;
scraped values go through the formula-injection guard (and control characters are
stripped). Lead scoring is unchanged.

### Production build (single process)

```bash
npm run build:web               # builds frontend/dist
npm start                       # serves the API + built frontend from one Express process on $PORT (default 3001)
```

## Security

- `DATABASE_URL` and all database credentials exist only in `.env` (gitignored) and are read
  exclusively by `db/pool.js` on the server. Nothing in `server/` or `frontend/` ever sends the
  connection string, username, or password to the browser.
- `GOOGLE_PLACES_API_KEY` (Phase 7) exists only in `.env` and is read exclusively by
  `server/lib/googlePlaces.js`, which sends it to Google as a request header. It is never present
  in frontend source, `frontend/dist`, a Vite `import.meta.env.VITE_*` variable, an API response
  body, or a server log line.
- All SQL in `server/routes/*.js` uses fixed, explicit column lists (no `SELECT *`). The Phase 7
  `POST /api/searches` endpoint validates and trims its input (`server/lib/validation.js`) before
  it ever reaches a query, and every value is passed as a parameterized `$1..$n` placeholder —
  never string-concatenated into SQL.
- The API's error handler (`server/app.js`) never returns raw error objects, stack traces, or
  query text to the client — only a generic message. Server-side logs only print `err.message`,
  never the connection string. `POST /api/searches` follows the same rule for Google Places
  errors: `server/lib/googlePlaces.js` maps Google's raw error response to one of a fixed set of
  safe, specific messages (e.g. "Google Places API rate limit reached...") and never forwards
  Google's raw response body or the API key.

