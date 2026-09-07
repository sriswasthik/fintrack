# FinTrack

Personal finance transaction categorizer & dashboard — a React SPA talking to an
Express REST API. See [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) for the architecture
and data model, and [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) for the phased
build plan.

> **Status:** Phase 0 — scaffolding only. There is no database schema, business logic
> or auth yet; the client renders a placeholder page that calls `GET /api/health`.

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
npm run dev                       # runs the API and the Vite dev server together
```

Then open <http://localhost:5173> — the placeholder page calls the API and shows
the health-check result.

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
