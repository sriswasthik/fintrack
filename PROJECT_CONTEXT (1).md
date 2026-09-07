# FinTrack — Personal Finance Transaction Categorizer & Dashboard
Project Context & Reference Document

This document is the single source of truth for architecture, data model, and edge-case requirements. Keep it in the repo root and reference it in every build phase so a coding agent (or you) stays consistent across sessions.

## 1. Overview
FinTrack is a two-part application: a **React single-page app** (frontend) talking over a REST API to a **Node.js/Express backend**. It ingests bank transaction exports (CSV), automatically categorizes each transaction into a fixed spending taxonomy, visualizes spending patterns on a dashboard, flags anomalies (unusual charges, new subscriptions, price hikes), and generates a plain-English monthly summary. Categorization uses a deterministic rule engine first, with an LLM (Claude) as a fallback for ambiguous merchants — output is always validated against a fixed schema before being trusted. All database access and all LLM calls happen server-side only; the client never sees a DB connection string or an API key.

## 2. Problem & Value
Manually categorizing bank transactions in a spreadsheet is tedious and error-prone. FinTrack automates categorization, surfaces spending insights without manual chart-building, and catches anomalies (forgotten subscriptions, billing errors, unusual spikes) a person would likely miss scanning a raw statement. Target resume framing: "Built a React + Node.js finance dashboard with a REST API backend that auto-categorizes transactions via a rule engine + LLM fallback, reducing manual categorization effort by ~80%."

## 3. Tech Stack

### Frontend — `client/`
- React 18 + TypeScript, built and served in dev with **Vite**
- **React Router v6** for client-side routing
- **TanStack Query (React Query)** for all server-state fetching/caching/mutations against the API
- **Tailwind CSS + shadcn/ui** (Vite-compatible setup, not the Next.js one) for components
- **Recharts** for charts
- **Axios** with a request interceptor (attach access token) and response interceptor (retry once via refresh token on 401)
- **React Context** for auth/session state

### Backend — `server/`
- **Node.js + Express + TypeScript**
- **Prisma ORM + PostgreSQL**
- **Zod** for request validation on every route
- Auth: **JWT** (`jsonwebtoken`) — short-lived access token returned in the response body, long-lived refresh token set as an httpOnly secure cookie; **bcrypt** for password hashing
- **multer** for CSV file upload handling; **papaparse** (or `csv-parse`) for parsing on the server
- **express-rate-limit** on upload/categorize/summary routes; **helmet** + **cors** for basic hardening
- **@anthropic-ai/sdk** — used only inside `server/` code, never bundled into the client

### Cross-cutting
- **Testing:** Vitest + Testing Library for client unit/component tests; Vitest + **Supertest** for server unit and API-integration tests; Playwright for full-stack e2e (built client served against a running server)
- **CI/CD:** GitHub Actions with separate jobs for `client` and `server` (lint, typecheck, test) → deploy frontend to Vercel or Netlify (static build), backend to Render or Railway (persistent Node process)
- **Data privacy:** synthetic/sanitized transaction data only — no real bank connections (no Plaid) in this build
- **Repo layout:** npm workspaces monorepo (`client`, `server`) with a root `dev` script that runs both concurrently via `concurrently`

## 4. Architecture Summary
```
[React SPA — client]  <-- REST/JSON over HTTPS -->  [Express API — server]  <-- Prisma -->  [Postgres]
                                                             |
                                                             +--> Anthropic API (server-side only)

Import flow (client uploads a file; the server does all the work):
Client CSV upload (multipart/form-data)
  -> POST /api/transactions/upload  (multer)
  -> Parse & Normalize (server)  -> Dedup Check  -> Rule Engine
       -> [resolved]   -> stored, category=X, confidence=1.0
       -> [unresolved] -> LLM Categorization (batched, cached by normalized merchant)
            -> validate against fixed enum via Zod
            -> [valid]   stored, category=X, confidence=LLM score, flagged "AI-categorized"
            -> [invalid/low-confidence] category=UNCATEGORIZED, queued for manual review
  -> Manual review/override (client calls API) -> saved as a learned Rule, never auto-overwritten again
  -> Dashboard aggregates served via GET /api/dashboard (excludes TRANSFER from spend/income totals)
  -> Anomaly detector (pure statistics, server-side, no LLM) -> GET /api/insights
  -> Monthly summary generator (server-side LLM call, input = pre-computed aggregates only) -> GET /api/summary
```
The client only ever talks to the Express API — never directly to Postgres or to Anthropic.

## 5. Fixed Category Taxonomy
Categorization must always resolve to one of these (never a free-form string):

`GROCERIES, DINING, TRANSPORTATION, HOUSING, UTILITIES, SUBSCRIPTIONS, ENTERTAINMENT, SHOPPING, HEALTH_FITNESS, TRAVEL, INCOME, TRANSFER, FEES_INTEREST, INSURANCE, EDUCATION, PERSONAL_CARE, GIFTS_DONATIONS, BUSINESS, REFUND, UNCATEGORIZED`

`TRANSFER` and `INCOME` are excluded from "spend" totals; `TRANSFER` is also excluded from "income" totals. `REFUND` nets against the original category in aggregates but is stored as its own category for traceability.

## 6. Core Data Model (Prisma sketch, lives in `server/prisma/schema.prisma`)
```prisma
model User { id, email, passwordHash, name, accounts Account[], rules Rule[], refreshTokens RefreshToken[] }
model RefreshToken { id, userId, tokenHash, expiresAt, revokedAt }
model Account { id, userId, name, type, transactions Transaction[] }
model Transaction {
  id, accountId, date, postedDate, description, rawMerchant, normalizedMerchant,
  amount, currency, category Category, confidence Float, source (RULE|LLM|MANUAL),
  isDuplicateOf String?, linkedRefundId String?, splits Split[]
}
model Split { id, transactionId, category Category, amount, note }
model Rule { id, userId?, pattern, category Category, priority, learnedFromOverride Boolean }
model MerchantCategoryCache { normalizedMerchant, category Category, confidence, updatedAt }
model AnomalyFlag { id, transactionId?, userId, type, severity, month, explanation }
model MonthlySummary { id, userId, month, content, statsSnapshot Json }
enum Category { GROCERIES DINING TRANSPORTATION HOUSING UTILITIES SUBSCRIPTIONS
  ENTERTAINMENT SHOPPING HEALTH_FITNESS TRAVEL INCOME TRANSFER FEES_INTEREST
  INSURANCE EDUCATION PERSONAL_CARE GIFTS_DONATIONS BUSINESS REFUND UNCATEGORIZED }
```

## 7. AI Integration Guardrails
- **Categorization calls:** implemented in `server/src/services/ai/categorize.ts`, called only from Express route handlers, `ANTHROPIC_API_KEY` read from `process.env` on the server. Batch up to ~20 unresolved merchants per request; system prompt restricts output to the fixed enum plus a 0–1 confidence and one-line reason; response parsed as structured JSON and validated with Zod; anything failing validation becomes `UNCATEGORIZED`, never guessed silently.
- **Caching:** every LLM categorization decision is cached by normalized merchant string (`MerchantCategoryCache`) so the same merchant is never sent to the LLM twice.
- **Summary generation:** implemented in `server/src/services/ai/summarize.ts`. Input is a small JSON of pre-computed aggregates (totals, deltas, top categories/merchants, anomaly list) — never raw transaction rows. Output is checked to contain the key figures passed in before being returned to the client.
- **Human overrides always win:** once a user manually corrects a category via the API, that transaction (and future matches of the same merchant) is never re-categorized automatically.

## 8. Edge Cases Catalog (must all be explicitly handled and tested)
1. Transfers between the user's own accounts (checking ↔ savings ↔ credit card payment) — excluded from spend/income
2. Refunds/returns (negative amount) — matched back to originating transaction where possible
3. Split transactions (single charge spanning multiple categories, e.g. a big-box or Amazon order)
4. Recurring subscriptions — cadence detection + price-change detection
5. Duplicate transactions from sync glitches (same amount/date/merchant) vs. legitimately repeated small charges (e.g. daily coffee) — must not conflate the two
6. Pending vs. posted transactions
7. Foreign transaction fees split from the purchase amount
8. Ambiguous/processor-mangled merchant strings (`SQ *JOES COFFEE`, `PAYPAL *XYZ123`, `TST* RESTAURANT NAME`)
9. Person-to-person payments (Venmo/CashApp/Zelle) that are round-tripped, not real spend
10. Large one-off purchases that would otherwise skew category-average-based anomaly detection
11. Irregular/variable income (freelance, multiple sources)
12. Manual corrections must survive re-import and re-runs of the rule/LLM engine

## 9. Testing & Validation Strategy
- **Client:** Vitest + Testing Library component tests (charts render given mock data, forms validate, review-queue interactions work).
- **Server:** Vitest for pure logic (normalizer, rule engine, anomaly math); Supertest for API-route integration tests against a test database.
- **Full-stack:** Playwright drives the built client against a running server instance for the upload → dashboard → summary flow.
- A documented synthetic dataset intentionally covers every edge case above, with a README mapping row IDs to the edge case they represent.
- LLM eval harness: a labeled set of ambiguous merchants with expected categories, tracking accuracy over time as prompts change.
- Target metric: ≥90% of synthetic transactions correctly auto-categorized (rule + LLM combined) without manual correction.

## 10. Success Metrics (for resume bullets)
- % of transactions auto-categorized correctly without human override
- Estimated reduction in manual categorization time vs. a spreadsheet baseline
- Anomaly-flag precision on the synthetic test set (flag was a real edge case, not noise)
- Latency/cost per 100 transactions categorized via LLM fallback (shows cost-consciousness)

## 11. Non-Goals (v1)
- No live bank connections (Plaid/Yodlee) — CSV upload only, synthetic/sanitized data
- No investment or net-worth tracking
- No native mobile app (responsive web only)
- No budget-setting/alerts (documented stretch goal)

## 12. Environment Variables

**`server/.env`**
```
DATABASE_URL=
ANTHROPIC_API_KEY=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
CORS_ORIGIN=http://localhost:5173
PORT=4000
```

**`client/.env`**
```
VITE_API_BASE_URL=http://localhost:4000
```
Only variables prefixed `VITE_` are ever exposed to the browser bundle — never put a secret there.

## 13. Deployment Target
- **Frontend:** Vercel or Netlify, deployed as a static Vite build (`client/dist`)
- **Backend:** Render or Railway, running the Express server as a persistent Node web service
- **Database:** Neon or Supabase Postgres
- CORS on the server must allow only the deployed frontend origin (with credentials, for the refresh-token cookie). GitHub Actions runs lint/typecheck/test for both `client` and `server` on every PR before either deploy triggers.

## 14. Proposed Folder Structure
```
fintrack/
├── client/
│   ├── src/
│   │   ├── pages/          # Dashboard, Upload, Review, Summary, Login, Register
│   │   ├── components/
│   │   ├── lib/            # api.ts (axios instance), query hooks
│   │   ├── context/        # AuthContext
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
├── server/
│   ├── src/
│   │   ├── routes/         # auth.ts, transactions.ts, categorize.ts, summary.ts, insights.ts
│   │   ├── controllers/
│   │   ├── services/
│   │   │   ├── ai/         # categorize.ts, summarize.ts
│   │   │   ├── parsing/    # csv.ts, normalize.ts
│   │   │   ├── rules/      # engine.ts
│   │   │   └── anomalies/  # detect.ts
│   │   ├── middleware/     # auth.ts, rateLimit.ts, errorHandler.ts
│   │   ├── db.ts
│   │   ├── app.ts
│   │   └── index.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── seed.ts
│   └── package.json
├── test-data/{synthetic_transactions.csv, README.md}
├── docs/{EDGE_CASES.md, ACCURACY_REPORT.md}
├── package.json             # workspaces root; `npm run dev` runs client + server together
├── PROJECT_CONTEXT.md
├── IMPLEMENTATION_PLAN.md
├── PROGRESS.md
└── RESULTS.md
```
