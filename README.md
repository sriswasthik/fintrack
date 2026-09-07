# FinTrack

Personal finance transaction categorizer & dashboard — a React SPA talking to an
Express REST API. See [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) for the architecture
and data model, and [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the phased
build plan.

> **Status:** Phase 1 — data model and synthetic data. The Prisma schema and a
> seeded demo dataset exist; there is no import pipeline, categorization or auth
> yet. The client still renders a placeholder page that calls `GET /api/health`.

## Layout

This is an npm workspaces monorepo:

| Workspace | Stack                                                                                      | Dev port |
| --------- | ------------------------------------------------------------------------------------------ | -------- |
| `client/` | React + Vite + TypeScript, Tailwind CSS, shadcn/ui, React Router v6, TanStack Query, axios | 5173     |
| `server/` | Node.js + Express + TypeScript, Prisma, Zod                                                | 4000     |

ESLint and Prettier are configured once at the repo root (`eslint.config.mjs`,
`prettier.config.mjs`); each workspace extends those.

## Getting started

Requires Node.js 20.19+ (22 recommended) and npm 10+.

```bash
npm install                       # installs both workspaces from the root lockfile
cp server/.env.example server/.env
cp client/.env.example client/.env
```

You need a PostgreSQL 14+ database. Point `DATABASE_URL` in `server/.env` at it,
then set up the schema and load the demo data:

```bash
npm run db:generate --workspace server   # generate Prisma Client from the schema
npm run db:migrate  --workspace server   # npx prisma migrate dev
npm run db:seed     --workspace server   # npx prisma db seed
npm run dev                              # API + Vite dev server together
```

Then open <http://localhost:5173> — the placeholder page calls the API and shows
the health-check result.

Prisma Client is generated code and is not committed, so `db:generate` has to run
after a fresh clone and after any schema change. It does not need a database.

## Scripts

Run from the repo root:

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Runs `server` and `client` concurrently |
| `npm run build`     | Builds both workspaces                  |
| `npm run lint`      | ESLint over both workspaces             |
| `npm run typecheck` | `tsc` over both workspaces              |
| `npm test`          | Vitest in both workspaces               |
| `npm run format`    | Prettier write over the repo            |

Any of these can be scoped to one workspace, e.g. `npm run test --workspace server`.

## Environment variables

Copy the `.env.example` files and fill them in — never commit a real `.env`.

- `server/.env` — `DATABASE_URL`, `ANTHROPIC_API_KEY`, `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `CORS_ORIGIN`, `PORT`
- `client/.env` — `VITE_API_BASE_URL`

Only `VITE_`-prefixed variables reach the browser bundle; secrets belong in
`server/.env` only.
