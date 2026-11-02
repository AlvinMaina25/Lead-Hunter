# Alvin Lead Hunter — Dashboard (Frontend)

React + TypeScript + Tailwind CSS frontend foundation: layout, navigation,
and the six core pages. Built with Vite.

## Run locally

```bash
cd frontend
npm install
npm run dev
```

Then open the URL Vite prints (usually http://localhost:5173).

## Build for production

```bash
npm run build
```

Output goes to `dist/`. `npm run build` also type-checks the whole app
(`tsc -b`) before bundling, so a broken build will fail loudly instead of
shipping a type error.

## Data status

This phase ships the **frontend foundation only** — there is no backend
API yet, so every page reads through `src/lib/api.ts`, which currently
returns empty results on purpose. Real numbers will appear automatically,
with no component changes required, once a backend API is built and
`src/lib/api.ts` is pointed at it.

To preview the UI with sample data, go to **Settings → Preview with demo
data**. A "Demo data" banner stays visible everywhere while it's on, and
none of it is ever treated as real. Demo content lives entirely in
`src/data/mockData.ts`.

## Project layout

```
frontend/
├── src/
│   ├── components/
│   │   ├── layout/       # Sidebar, mobile drawer, header, page shell
│   │   ├── ui/            # Badge, Button, DataTable, EmptyState, etc.
│   │   ├── leads/         # LeadsTable
│   │   ├── businesses/    # BusinessesTable
│   │   └── searches/      # SearchesTable
│   ├── pages/              # One file per route
│   ├── hooks/               # useData.ts — combines API + demo mode + loading state
│   ├── lib/
│   │   ├── api.ts           # Real data layer (stubbed — see "Data status")
│   │   └── DemoDataContext.tsx
│   ├── data/mockData.ts    # Clearly-labeled DEMO data only
│   └── types/index.ts       # Mirrors the Phase 3 Neon schema
├── tailwind.config.js       # Design tokens (colors, type)
└── index.html
```
