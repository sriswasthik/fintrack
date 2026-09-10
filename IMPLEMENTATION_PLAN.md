# FinTrack — Implementation Plan

Total estimated time: ~2.5–3 weeks, solo, part-time-friendly. Work phase by phase; don't start a phase until the previous phase's PR has been reviewed and merged into `main`. Each phase corresponds 1:1 to a prompt in `PHASE_PROMPTS.md`, branches off `main` as `phase-N-slug`, and ends with a PR back into `main` (see PROJECT_CONTEXT.md §15 for the full workflow). Stack: React + Vite (`client/`) and Node.js + Express (`server/`) as two workspaces in one repo, in a repo that already exists with Claude Code given push access.

| # | Phase | Branch | Est. Time | Depends On |
|---|-------|--------|-----------|------------|
| 0 | Project Setup & Scaffolding (client + server) | `phase-0-scaffolding` | 1 day | — |
| 1 | Data Model & Synthetic Data | `phase-1-data-model` | 1.5 days | 0 |
| 2 | CSV Import & Parsing Pipeline | `phase-2-csv-import` | 2 days | 1 |
| 3 | Rule-Based Categorization Engine | `phase-3-rule-engine` | 2 days | 2 |
| 4 | LLM-Assisted Categorization | `phase-4-llm-categorization` | 1.5 days | 3 |
| 5 | Dashboard & Visualization | `phase-5-dashboard` | 2.5 days | 3 (can overlap with 4) |
| 6 | Anomaly Detection | `phase-6-anomaly-detection` | 1.5 days | 3, 5 |
| 7 | Monthly NL Summary | `phase-7-monthly-summary` | 1.5 days | 5, 6 |
| 8 | Edge Case Hardening & Tests | `phase-8-edge-case-tests` | 3 days | 1–7 |
| 9 | Auth, Multi-User, Security (JWT) | `phase-9-auth-security` | 2 days | 0–8 |
| 10 | Deploy, Docs, Resume Metrics | `phase-10-deployment` | 1.5 days | 9 |

## Phase Details

### Phase 0 — Project Setup & Scaffolding
**Goal:** A monorepo with a working, empty React (Vite) client and a working, empty Express server talking to each other, inside the existing repo.
**Deliverables:** root `package.json` with npm workspaces (`client`, `server`) and a `dev` script running both concurrently; `client/` scaffolded with Vite + React + TypeScript + Tailwind + shadcn/ui; `server/` scaffolded with Express + TypeScript + a `/api/health` route; shared ESLint/Prettier config; CI workflow with separate `client` and `server` jobs.
**Definition of Done:** `npm run dev` from the repo root starts both apps; the client shows a placeholder page; `GET /api/health` returns 200; lint/typecheck/test pass in both workspaces (even with zero tests). A PR (`phase-0-scaffolding` → `main`) is open covering these changes.

### Phase 1 — Data Model & Synthetic Data Generator
**Goal:** Prisma schema (in `server/prisma/`) for all entities in PROJECT_CONTEXT.md §6, plus a seed script and standalone CSV producing realistic messy data.
**Deliverables:** `server/prisma/schema.prisma`, `server/prisma/seed.ts`, `test-data/synthetic_transactions.csv`, `test-data/README.md` mapping rows → edge cases.
**Definition of Done:** `npx prisma migrate dev` and `npx prisma db seed` (run from `server/`) both succeed; seed populates ≥500 transactions across ≥6 months covering every edge case in §8; the CSV is uploadable in later phases. A PR (`phase-1-data-model` → `main`) is open covering these changes.

### Phase 2 — CSV Import & Parsing Pipeline
**Goal:** Upload UI in the client + a server-side upload/parse/dedup pipeline behind a REST endpoint.
**Deliverables:** client `Upload` page (file input, account selector, preview table); `POST /api/transactions/upload` (multer) on the server that parses, normalizes, and flags likely duplicates and returns a preview payload; `POST /api/transactions/commit` that finalizes the import after the user confirms/resolves flagged duplicates; `server/src/services/parsing/csv.ts` and `normalize.ts`.
**Definition of Done:** uploading the Phase-1 synthetic CSV through the client populates normalized, dedup-flagged `Transaction` rows in the DB via the API — no parsing logic lives in the client beyond building the multipart request. A PR (`phase-2-csv-import` → `main`) is open covering these changes.

### Phase 3 — Rule-Based Categorization Engine
**Goal:** Deterministic categorization pass run server-side on commit: keyword rules, transfer matching, refund linking, split support.
**Deliverables:** `server/src/services/rules/engine.ts`, seeded default `Rule` records, transfer/refund matching logic, `Split` model wiring, `POST /api/transactions/:id/split` endpoint, a client split UI on the transaction detail view.
**Definition of Done:** running the engine over the seeded dataset auto-resolves the intended "easy" transactions; transfers and refunds are correctly linked/excluded; unresolved rows are marked `UNCATEGORIZED`. A PR (`phase-3-rule-engine` → `main`) is open covering these changes.

### Phase 4 — LLM-Assisted Categorization
**Goal:** Fallback categorization for anything the rule engine couldn't resolve.
**Deliverables:** `server/src/services/ai/categorize.ts`, `MerchantCategoryCache` wiring, batching, Zod-validated structured output, `GET /api/review-queue` and `POST /api/transactions/:id/category` (override) endpoints, a client `/review` page (React Query) with accept/override, override → learned `Rule`.
**Definition of Done:** all previously `UNCATEGORIZED` seed transactions get a category or land in the review queue; overriding one saves a rule that a re-import respects; no invalid category ever reaches the database. A PR (`phase-4-llm-categorization` → `main`) is open covering these changes.

### Phase 5 — Dashboard & Visualization
**Goal:** The main user-facing screen.
**Deliverables:** `GET /api/dashboard` (aggregates, filterable by month/account/category) on the server; client `/dashboard` page consuming it via React Query — totals cards (spend/income, month-over-month delta), category donut chart, spend-over-time chart, top-merchants table, category drill-down, date/account/category filters.
**Definition of Done:** dashboard reflects the seeded dataset correctly (transfers excluded from totals); responsive on mobile; filter/drill-down interactions don't require a full page reload. A PR (`phase-5-dashboard` → `main`) is open covering these changes.

### Phase 6 — Anomaly Detection
**Goal:** Statistical flags surfaced as an "Insights" panel.
**Deliverables:** `server/src/services/anomalies/detect.ts` (outlier detection, new-recurring-charge detection, subscription price-hike detection, category spend-spike detection), `AnomalyFlag` writes, `GET /api/insights`, client Insights UI component.
**Definition of Done:** known anomalies planted in the synthetic dataset (Phase 1) are detected; unit tests cover the threshold math; false-positive rate on normal recurring charges (e.g. daily coffee) is acceptably low. A PR (`phase-6-anomaly-detection` → `main`) is open covering these changes.

### Phase 7 — Monthly Natural-Language Summary
**Goal:** LLM-generated recap grounded in computed stats.
**Deliverables:** `server/src/services/ai/summarize.ts`, `GET /api/summary` and `POST /api/summary/regenerate`, client `/summary` page.
**Definition of Done:** summary text correctly reflects the actual computed numbers for a given month (spot-checked against dashboard); regeneration works; API cost per summary is reasonable (single call, small payload). A PR (`phase-7-monthly-summary` → `main`) is open covering these changes.

### Phase 8 — Edge Case Hardening & Test Suite
**Goal:** Prove out the edge-case handling systematically — this is the differentiator.
**Deliverables:** `docs/EDGE_CASES.md` (matrix of edge case → expected behavior → test reference), expanded Vitest/Supertest tests on the server and Vitest/Testing Library tests on the client, an accuracy report script.
**Definition of Done:** every edge case in PROJECT_CONTEXT.md §8 has at least one passing automated test; accuracy report shows ≥90% correct auto-categorization on the synthetic set; report saved to `docs/ACCURACY_REPORT.md`. A PR (`phase-8-edge-case-tests` → `main`) is open covering these changes.

### Phase 9 — Auth, Multi-User & Security Pass
**Goal:** Production-readiness with JWT-based auth (no Auth.js/Next dependency).
**Deliverables:** `POST /api/auth/register|login|refresh|logout`, bcrypt password hashing, short-lived JWT access token + httpOnly-cookie refresh token, `middleware/auth.ts` protecting all data routes, client `AuthContext` + protected routes, rate limiting on upload/categorize/summary, CORS locked to the client origin with credentials.
**Definition of Done:** two separate test accounts see only their own data; hitting a protected route with another user's IDs returns 403/404; `npm audit` has no high/critical issues in either workspace; no server secret appears in the client build output. A PR (`phase-9-auth-security` → `main`) is open covering these changes.

### Phase 10 — Deployment, Docs & Resume Metrics
**Goal:** Ship a demo-able, documented project with the two services deployed separately.
**Deliverables:** server deployed to Render/Railway, client deployed to Vercel/Netlify with `VITE_API_BASE_URL` pointing at the deployed API, `CORS_ORIGIN` set on the server accordingly; `README.md` covering both services; `RESULTS.md` (metrics as resume-ready bullets); a no-signup "demo mode" preloaded with synthetic data.
**Definition of Done:** the public frontend URL works end-to-end for a stranger with no account, successfully calling the deployed API; README lets a new developer run both services locally in under 10 minutes; RESULTS.md numbers are backed by the Phase 8 accuracy report. A PR (`phase-10-deployment` → `main`) is open covering these changes.

### Phase 11 — INR Currency Localization
**Goal:** Present every amount in Indian rupees, with Indian digit grouping, on a dataset that reads like an Indian household's statement.
**Deliverables:** a `formatINR` utility with identical implementations in `client/src/lib/currency.ts` and `server/src/utils/currency.ts`; every client money render (dashboard cards, transaction list, review queue, top merchants, category breakdown, summary) going through it; server-generated text that quotes amounts — anomaly explanations, the monthly-summary prompt and its figure check — doing the same; the Phase 1 seed rebalanced to Indian household figures with Indian merchant names, and the rule set, normalizer and accuracy report updated to match.
**Definition of Done:** `formatINR` is unit-tested in both workspaces over zero, a negative amount, a value under ₹1,000, a value in the lakhs and a value in the crores, and the two copies are asserted identical; no `$` and no un-grouped amount appears anywhere in the running app; auto-categorization still meets the ≥90% target of Phase 8 on the rebalanced dataset. A PR (`phase-11-inr-currency` → `main`) is open covering these changes.

### Phase 12 — PDF Statement Import
**Goal:** Import a bank statement PDF, asking for a password only when the file actually has one.
**Deliverables:** `server/src/services/parsing/pdf.ts` with `inspectPdf` (encrypted or not, no parsing) and `extractPdfText` (text with x/y coordinates, distinct `PasswordRequiredError` and `IncorrectPasswordError`); `POST /api/statements/inspect` and `POST /api/statements/parse`; a reference reader for a generic `Date | Narration | Reference No | Debit | Credit | Balance` layout that reconstructs rows from y and columns from x, with a Zod-validated model fallback for layouts it cannot settle; both feeding the existing Phase 2-3 normalize → dedup → rule pipeline unchanged; a client `/upload` page that accepts `.pdf`, inspects on selection and reveals a password field only when one is needed; two synthetic statement fixtures in `test-data/`, one plain and one encrypted.
**Definition of Done:** the unencrypted fixture imports with no password prompt at any point; the encrypted fixture imports correctly given the right password; a wrong password produces a distinct, specific error and imports nothing. A PR (`phase-12-pdf-statement-import` → `main`) is open covering these changes.
