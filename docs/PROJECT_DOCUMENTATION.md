# FinTrack — Project Documentation

_A personal ledger for Indian bank statements. State as of 27 September 2026,
branch `phase-20-completeness`._

FinTrack reads a bank statement — CSV, Excel or PDF — works out what each
transaction was, and shows you the month: where the money went, what changed,
what is coming up, and who you have paid. It is built around the parts that are
easy to get wrong: transfers between your own accounts, refunds against what
they refunded, one charge split across categories, and the peculiarities of
Indian statements — day-first dates, separate debit and credit columns, UPI and
NEFT narrations, EMIs and SIPs.

Categorization is deterministic first. A rule engine settles the familiar
merchants; a language model (Claude) sees only the names the rules could not
settle, and never a payment to a person. The same statement always produces
the same answer, and the model bill scales with unfamiliar merchants rather
than with transactions.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Technology](#3-technology)
4. [The import pipeline](#4-the-import-pipeline)
5. [Categorization](#5-categorization)
6. [Analysis features](#6-analysis-features)
7. [Accounts, sign-in and settings](#7-accounts-sign-in-and-settings)
8. [Security and privacy](#8-security-and-privacy)
9. [Design system](#9-design-system)
10. [API reference](#10-api-reference)
11. [Data model](#11-data-model)
12. [Configuration](#12-configuration)
13. [Running, testing and deploying](#13-running-testing-and-deploying)
14. [Quality and verification](#14-quality-and-verification)
15. [Build history](#15-build-history)
16. [Known limitations and next steps](#16-known-limitations-and-next-steps)
17. [Resume summary](#17-resume-summary)

---

## 1. What it does

| Area                    | Capability                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Import**              | CSV, Excel (XLS/XLSX) and PDF statements; one file or a quarter at once; preview before anything is saved; duplicates flagged, never dropped; undo a whole import later.                            |
| **Understand the file** | Finds the header below account details; reads separate debit/credit columns, Cr/Dr markers, ₹/Rs./INR amounts; settles day-first vs month-first dates from the file and says when it had to assume. |
| **Categorize**          | 20+ fixed categories; rules for Indian brands, bills and payment rails; AI fallback for the rest; every correction teaches a rule; review queue for what nobody could settle.                       |
| **Dashboard**           | Month headline figures with change vs last month, spending by category, spend over time, top merchants, drill-down to the transactions behind any category.                                         |
| **Insights**            | Price rises, new recurring charges, unusual amounts, category spikes, likely duplicates — plain statistics, no model.                                                                               |
| **India features**      | Salary detection, savings rate, EMIs and SIPs, bills expected next, festive-month comparison.                                                                                                       |
| **Payee ledger**        | Running totals per person or business: paid, received, net, history.                                                                                                                                |
| **Budgets**             | Monthly limit per category, measured with exactly the dashboard's arithmetic.                                                                                                                       |
| **Range totals**        | Debits, credits and net for today, this month, this quarter or any custom range.                                                                                                                    |
| **Monthly summary**     | A plain-English recap written from computed figures only (or the figures themselves when no model is configured).                                                                                   |
| **Transactions**        | Filter, inspect, recategorize, split one charge across categories, export to CSV.                                                                                                                   |
| **Accounts & sign-in**  | Email/password or Google; password reset by email; read-only public demo; delete everything on request.                                                                                             |
| **Interface**           | "Ledger" design with Paper (light) and Night (dark) themes, keyboard- and screen-reader-friendly.                                                                                                   |

---

## 2. Architecture

Two independently deployed services and a database:

```
  Browser
     │
     ├── static SPA           client/  → Vite build on a CDN (Vercel / Netlify)
     │                        VITE_API_BASE_URL points at the API
     │
     └── XHR (credentials)    server/  → Node web service (Render / Railway)
                              CORS_ORIGIN allows exactly the client's origin
                                 │
                                 ├── PostgreSQL (Neon / Supabase) via Prisma
                                 ├── Anthropic API   (categorization fallback,
                                 │                    statement reader, summaries)
                                 ├── Google          (ID-token verification)
                                 └── Resend          (welcome + password-reset email)
```

- The client is static files. Every data request is a cross-origin call with a
  bearer token; the refresh token travels only as an httpOnly cookie on
  `/api/auth`. Nothing but `VITE_`-prefixed values reaches the browser bundle.
- All database access and every model call happen on the server.
- Every optional integration degrades rather than fails: no model key means
  rules-only categorization and figures-only summaries; no mail provider means
  no emails (and an honest message on "forgot password"); no Google client ID
  hides the Google button.

Repository layout (npm workspaces monorepo):

```
client/     React SPA                 pages/, components/, lib/, context/
server/     Express REST API          routes/ → controllers/ → services/
            prisma/                   schema, migrations, seed data
            scripts/                  demo seed, accuracy report, evals
docs/       This file, edge cases, accuracy report, screenshots
test-data/  Synthetic CSV and PDF fixtures (every value invented)
```

---

## 3. Technology

| Layer  | Stack                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------ |
| Client | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui (Radix), React Router 7, TanStack Query, axios, Recharts    |
| Server | Node.js 20+, Express 5, TypeScript, Prisma 7, PostgreSQL, Zod, multer, pdf.js, SheetJS, helmet, express-rate-limit |
| Auth   | JWT access token (in memory) + rotating httpOnly refresh cookie, bcrypt, Google Identity Services                  |
| AI     | Anthropic SDK (`claude-opus-5`) with structured outputs, prompt caching and low effort for classification          |
| Email  | Resend                                                                                                             |
| Fonts  | Fraunces, IBM Plex Sans, IBM Plex Mono — self-hosted via Fontsource                                                |
| Tests  | Vitest + Supertest (server), Vitest + Testing Library (client)                                                     |
| CI     | GitHub Actions: lint, typecheck, test for both workspaces, with a Postgres service                                 |

---

## 4. The import pipeline

Import is two steps: **preview** (parse, normalize, flag duplicates — writes
nothing) and **commit** (insert the confirmed rows as one undoable import, then
categorize).

### 4.1 CSV

- **Header detection.** Indian exports put the account holder, account number
  and statement period above the table. The first line that names a date
  column and a money column is taken as the header.
- **Column recognition.** Presets for Chase and Amex; otherwise columns are
  recognised by name — `Narration`, `Particulars`, `Transaction Remarks`,
  `Withdrawal Amt.`, `Deposit Amount (INR )`, `DR`/`CR`, `Value Dt`, and so on.
  Unrecognised layouts get a mapping form (one amount column or separate
  debit/credit, and the date order).
- **Amounts.** `₹1,23,456.78`, `Rs. 500`, `INR 500`, `(12.34)`, `1,200.00 Cr`;
  a separate `Dr / Cr` column; `0.00` in the column that does not apply.
- **Dates.** `15/03/2026`, `15-03-26`, `15.03.2026`, `15-Mar-2026`,
  `15 Mar 26`, ISO, with or without a time. Day-first vs month-first is settled
  from the whole file; when nothing in the file proves it, day-first is assumed
  and the preview says so with a one-click "read month first instead".

### 4.2 Excel

Workbooks (`.xlsx`, legacy `.xls`, and the HTML tables some banks name `.xls`)
are converted to CSV text and then take exactly the CSV path. Date cells are
rewritten as ISO first — Excel's default display format is month-first and
would otherwise turn 3 May into 1 March. The sheet containing the transaction
table is chosen, not simply the first; at most 20,000 rows are read.

### 4.3 PDF

1. **Password check first** — a password box appears only for an encrypted file.
2. **Bank adapters** for HDFC, SBI and PhonePe statement layouts.
3. **Generic reader** that rebuilds the table from text geometry.
4. **AI statement reader** as a last resort — sent only the transaction rows,
   with the account holder's details dropped and identifiers masked
   (see [§8](#8-security-and-privacy)). A PDF with no transactions is refused
   without a model call. Can be switched off.

### 4.4 Several files at once

Quarterly and custom imports take PDF, CSV and Excel files mixed freely.
Duplicate detection runs across the whole batch, so the fortnight two
overlapping statements share is caught. A file that cannot be read fails on
its own; the rest still import.

### 4.5 Duplicates and undo

Rows matching an existing transaction (same account, amount and merchant within
a day) or an earlier row in the same import are flagged and default to _skip_;
the person decides. Every commit is recorded as an import and can be undone as
a unit from Settings.

---

## 5. Categorization

### 5.1 Merchant normalization

Raw narrations are reduced to a stable merchant key that rules, the AI cache
and the payee ledger all use:

| Narration                                                       | Key                 |
| --------------------------------------------------------------- | ------------------- |
| `SQ *JOES COFFEE`                                               | `JOES COFFEE`       |
| `UPI/606012345678/SWIGGY/swiggy@icici`                          | `SWIGGY`            |
| `NEFT CR-CITI0100000-NORTHWIND LABS-A SAMPLE PERSON-CITIN5202…` | `NORTHWIND LABS`    |
| `IMPS-606012345678-RAMESH KUMAR-HDFC-XXXXXXXX1234-RENT`         | `RAMESH KUMAR`      |
| `TO TRANSFER-UPI/DR/606112345678/ZOMATO/YESB/zomato@ybl/UPI`    | `ZOMATO`            |
| `POS 416021XXXXXX1234 BIGBASKET`                                | `BIGBASKET`         |
| `ONLINE PAYMENT TO HDFC CARD ...4021`                           | `HDFC CARD PAYMENT` |

Hyphen-separated rail narrations (how HDFC, ICICI and SBI print NEFT, IMPS,
RTGS, UPI and NACH lines) are split into fields, and the first field that is a
name — not a reference, IFSC, masked number or UPI address — is the merchant.

### 5.2 Rule engine

Deterministic, ordered by priority:

1. **Learned rules** — every correction a person makes (highest priority).
2. **Disambiguators** — e.g. LIC (insurance) vs LIC HFL (home loan).
3. **Keywords** — COFFEE, PHARMACY, SALARY, PAYROLL…
4. **Narration rules** — EMI, SIP, ATM, CASH WDL…
5. **Brands** — national merchants, bill payers, brokers.

The engine also pairs **transfers** between the user's own accounts (excluded
from spend and income), links **refunds** to the purchase they reverse, and
leaves **manual** categorizations untouched on every re-run.

**Salary recognition** runs next. An Indian NEFT salary credit usually names
only the employer, so no keyword rule can see it. The salary detector
recognises it by behaviour instead — the same payer, three consecutive months,
amounts within 10%, the same pay day — and that payer's uncategorized credits
are filed as income. Only uncategorized rows are changed; transfers and
refunds are never evidence; a payer who reads as a person is left for the
user to classify.

### 5.3 AI fallback

Runs after the rules and salary recognition, on every import and
re-categorization:

- Only **merchant names** are sent — no amounts, dates or descriptions.
- **Payments to a person** (mobile-number UPI handle, person-to-person wallet
  transfer, a personal name) are never sent; they go to review.
- Each distinct merchant is asked about once, then cached; batches of 20, four
  at a time; answers are validated against the fixed category list.
- Low-confidence answers are stored as suggestions and still appear in review.
- A missing key never fails an import; the result says the AI was unavailable.
- `AI_CATEGORIZATION=off` keeps merchant names on the server.

### 5.4 Review queue and learned rules

Everything no pass could settle confidently is listed for a person to decide.
Choosing a category writes a learned rule for that merchant, so it is never
asked about again; learned rules can be edited or forgotten on their own page.

---

## 6. Analysis features

- **Dashboard.** The month as the title; spent, received, net and transaction
  count with change against the previous month; spend over time (daily or
  weekly); where it went (ranked bars, each opening its transactions); top
  merchants; every category in a table. Filters by account and category.
  Money in that nobody has categorized yet is counted in neither spending nor
  income — it is shown under "Received" as an amount "to review", linking to
  the review queue — so an unrecognised credit can never make spending read
  negative.
- **Insights ("Worth a look").** Subscription price rises, new recurring
  charges, unusual amounts for a category, category spend spikes and possible
  duplicates — deterministic statistics, each with a plain explanation and a
  severity. Dismissals are remembered.
- **India-specific insights.** Salary (payer, typical amount, pay day), savings
  rate, EMIs and loans, SIPs and investments (with share of income), bills
  expected next month from their cadence, and festive months compared with the
  usual.
- **Payee ledger.** Everyone paid or paid by, with running paid / received /
  net, type (person or business) and per-payee history.
- **Budgets.** A monthly limit per category, with on-track / nearly-there /
  over status measured on the dashboard's own figures.
- **Range totals.** Debits, credits and net for today, the month, the quarter
  or a custom range.
- **Monthly summary.** Generated only from computed aggregates, never raw rows;
  cached, regenerable, and flagged stale when later imports change the month.

---

## 7. Accounts, sign-in and settings

- **Email and password** — bcrypt-hashed; minimum 10 characters.
- **Google sign-in** — the server verifies Google's ID token against the
  configured client ID; an email already registered is linked, not duplicated.
- **Sessions** — short-lived access token in memory; rotating refresh token in
  an httpOnly cookie; presenting a refresh token that was already used ends
  every session for that user, since it was either replayed or stolen.
- **Password reset** — single-use, hashed, one-hour link by email. With no mail
  provider in production, the page says reset is unavailable rather than
  promising an email.
- **Demo mode** — a read-only session on a seeded sample account, enforced by
  the server on every write route. Off by default.
- **Settings** — profile, bank accounts (add, rename, delete), import history
  with undo, change password, delete the account and all its data.

---

## 8. Security and privacy

| Concern        | Measure                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credentials    | bcrypt; tokens never in local storage; refresh-token rotation with reuse detection                                                                                                     |
| Access control | Every data route behind one auth middleware; ownership checked on every row; "not yours" is indistinguishable from "not there"                                                         |
| Abuse          | Rate limits on sign-in, reset, uploads, categorization and summaries; helmet; CORS locked to one origin                                                                                |
| Demo           | Read-only enforced server-side, not by hiding buttons                                                                                                                                  |
| Uploads        | Kept in memory, never on disk; size and type limits; CSV export neutralises spreadsheet formula injection                                                                              |
| AI data        | Categorization sends merchant names only, never people; the statement reader gets transaction rows only, with PAN, Aadhaar, email and long digit runs masked; both can be switched off |
| Logs           | One structured line per request with a request ID; query strings and bodies never logged; unexpected errors reach the user only as a short reference                                   |
| Configuration  | Startup `[config]` warnings for missing mail, CORS, model key, and demo mode in production                                                                                             |

---

## 9. Design system

The "Ledger" theme — a bank passbook rather than a SaaS template.

- **Surfaces.** Cream paper `#F6F3EC`, card `#FBF9F4`, ink `#1D1C1A`, hairline
  rules instead of shadows, a double rule under the masthead. Night theme on a
  warm near-black with re-stepped inks, following the system setting until the
  person chooses, applied before first paint.
- **Type.** Fraunces for headings, IBM Plex Sans for text, IBM Plex Mono for
  every figure so amounts line up in columns.
- **Meaning.** Forest green `#1E5B45` for money in, brick `#A8382A` for money
  out, ochre for "nearly there". Every non-zero amount also carries a + or −
  sign, so direction never rests on colour alone.
- **Charts.** Five categorical inks validated with a colour-vision checker in
  both themes (worst adjacent colour-blind separation ΔE 8.3 light / 8.5 dark;
  every mark at least 3:1 against its surface). Single-series charts use one
  ink; category spend is a ranked bar list rather than a donut, so colour is
  never assigned by rank.
- **Accessibility.** Every text colour clears WCAG 4.5:1; focus rings;
  labelled controls; tables behind every chart.

---

## 10. API reference

All routes are under `/api`. Everything except health and the auth routes
requires a bearer token; a demo session is refused every write.

| Method             | Path                                                                  | Purpose                                                   |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------- |
| GET                | `/health`                                                             | Liveness and whether the demo is offered                  |
| POST               | `/auth/register`, `/auth/login`, `/auth/google`, `/auth/demo`         | Start a session                                           |
| POST               | `/auth/refresh`, `/auth/logout`                                       | Rotate or end a session                                   |
| GET                | `/auth/me`                                                            | The signed-in profile                                     |
| POST               | `/auth/forgot-password`, `/auth/reset-password`                       | Password reset                                            |
| POST               | `/me/password` · DELETE `/me`                                         | Change password · delete account and data                 |
| GET/POST           | `/accounts` · PATCH/DELETE `/accounts/:id`                            | Bank accounts                                             |
| POST               | `/transactions/upload`                                                | CSV/Excel preview (writes nothing)                        |
| POST               | `/statements/inspect`, `/statements/parse`, `/statements/parse-batch` | PDF (and batch) preview                                   |
| POST               | `/transactions/commit`                                                | Save confirmed rows, then categorize                      |
| POST               | `/transactions/categorize`                                            | Re-run rules and the AI fallback                          |
| GET                | `/transactions`, `/transactions/:id`, `/transactions/export`          | List, detail, CSV export                                  |
| POST               | `/transactions/:id/category`                                          | Correct a category (learns a rule)                        |
| POST/DELETE        | `/transactions/:id/split`                                             | Split one charge across categories                        |
| GET                | `/review-queue`                                                       | What still needs a person                                 |
| GET · PATCH/DELETE | `/rules` · `/rules/:id`                                               | Learned rules                                             |
| GET · DELETE       | `/imports` · `/imports/:id`                                           | Import history · undo an import                           |
| GET                | `/dashboard`                                                          | Month aggregates                                          |
| GET · DELETE       | `/insights` · `/insights/:id`                                         | Anomaly flags · dismiss                                   |
| GET                | `/india`                                                              | Salary, savings, EMIs, SIPs, upcoming bills, festive note |
| GET                | `/payees`, `/payees/:id`                                              | Payee ledger                                              |
| GET · PUT/DELETE   | `/budgets` · `/budgets/:category`                                     | Budgets                                                   |
| GET                | `/totals`                                                             | Debits/credits for a range                                |
| GET · POST         | `/summary` · `/summary/regenerate`                                    | Monthly summary                                           |

---

## 11. Data model

PostgreSQL via Prisma. Money is `Decimal(12,2)`, debit-positive (money out is
positive, money in negative).

| Entity                               | Holds                                                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`                               | Email, optional password hash, optional Google ID                                                                                                                                              |
| `RefreshToken`, `PasswordResetToken` | Hashed, expiring, single-use tokens                                                                                                                                                            |
| `Account`                            | A user's bank account (savings, current, credit card)                                                                                                                                          |
| `ImportBatch`                        | One confirmed import — file names and row count — so it can be undone                                                                                                                          |
| `Transaction`                        | Date, posted date, description, raw and normalized merchant, counterparty, UPI address, amount, category, confidence, source (rule / AI / manual), duplicate, refund and transfer links, payee |
| `Split`                              | Parts of one charge in different categories                                                                                                                                                    |
| `Rule`                               | Built-in (no user) or learned from a correction, with priority                                                                                                                                 |
| `CategoryOverride`                   | Every correction: from what, to what, and whether it taught a rule                                                                                                                             |
| `MerchantCategoryCache`              | The model's answer per merchant, so it is asked once                                                                                                                                           |
| `Payee`                              | A counterparty, with UPI address and person/business type                                                                                                                                      |
| `AnomalyFlag`                        | A detected insight, idempotent by fingerprint, dismissible                                                                                                                                     |
| `Budget`                             | Monthly limit per category                                                                                                                                                                     |
| `MonthlySummary`                     | The recap and the figures it was written from                                                                                                                                                  |

The fixed category list: groceries, dining, transportation, housing, utilities,
subscriptions, entertainment, shopping, health & fitness, travel, income,
transfer, fees & interest, insurance, EMI & loans, investments, cash
withdrawal, education, personal care, gifts & donations, business, refund,
uncategorized.

---

## 12. Configuration

**Server (`server/.env`)**

| Variable                                  | Required      | Purpose                                                |
| ----------------------------------------- | ------------- | ------------------------------------------------------ |
| `DATABASE_URL`                            | yes           | PostgreSQL connection string                           |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | yes           | Token signing secrets                                  |
| `CORS_ORIGIN`                             | in production | The client's origin                                    |
| `ANTHROPIC_API_KEY`                       | no            | AI categorization, statement reader, written summaries |
| `AI_CATEGORIZATION`                       | no            | `off` keeps merchant names on the server               |
| `AI_STATEMENT_READER`                     | no            | `off` refuses PDFs no built-in reader knows            |
| `GOOGLE_CLIENT_ID`                        | no            | Enables Google sign-in                                 |
| `RESEND_API_KEY`, `EMAIL_FROM`            | for email     | Welcome and password-reset emails                      |
| `APP_URL`                                 | no            | Where email links point (defaults to `CORS_ORIGIN`)    |
| `DEMO_MODE`, `DEMO_USER_EMAIL`            | no            | Public read-only demo                                  |
| `TRUST_PROXY`, `PORT`                     | no            | Proxy hops and listen port                             |

**Client (`client/.env`)**: `VITE_API_BASE_URL` (the API origin) and
`VITE_GOOGLE_CLIENT_ID` (same value as the server's `GOOGLE_CLIENT_ID`).

**Google sign-in setup.** In Google Cloud Console create an OAuth client of
type _Web application_, add the client's origin (e.g. `http://localhost:5173`
and the deployed URL) under _Authorized JavaScript origins_, and put the client
ID in both variables above. No client secret or redirect URI is needed.

---

## 13. Running, testing and deploying

```bash
npm install
cp server/.env.example server/.env        # set DATABASE_URL and the two JWT secrets
cp client/.env.example client/.env
npm run db:generate --workspace server
npm run db:migrate  --workspace server
npm run db:seed     --workspace server    # optional: synthetic dataset
npm run dev                               # API on :4000, client on :5173
```

| Command                                                 | Does                                                      |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `npm test`                                              | All tests (database tests run when `DATABASE_URL` is set) |
| `npm run lint` · `npm run typecheck` · `npm run format` | Code quality                                              |
| `npm run build`                                         | Production builds of both workspaces                      |
| `npm run demo:seed --workspace server`                  | Build the demo account (then `DEMO_MODE=on`)              |
| `npm run accuracy:report --workspace server`            | Regenerate `docs/ACCURACY_REPORT.md`                      |

**Deploying.** The server deploys to Render (`render.yaml`) or Railway
(`railway.json`) with migrations applied before start; the client to Vercel
(`vercel.json`) or Netlify (`netlify.toml`). The README has the full steps and a
"Before you store real statements" checklist (no `[config]` warnings, demo off,
email tested, AI switches decided, backups restored once, logs located).

---

## 14. Quality and verification

**Automated tests** (91 test files):

| Suite                                                 | Result                                   |
| ----------------------------------------------------- | ---------------------------------------- |
| Server, with a PostgreSQL database                    | **1,470 passed**, 0 skipped              |
| Server, without a database (as a contributor runs it) | 1,347 passed, 123 database tests skipped |
| Client                                                | **278 passed**                           |
| Lint, typecheck, Prettier                             | Clean in both workspaces                 |
| Production builds                                     | Client and server both build             |

**End-to-end check (27 September 2026)** against a real PostgreSQL database
and the production server build, driven in a browser:

| Flow                                                      | Result                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| Landing page, API health, demo button                     | ✓                                                               |
| Register a new account; first-run "add your bank account" | ✓                                                               |
| Import the 731-row sample CSV                             | ✓ 721 imported, 10 duplicates flagged and skipped               |
| Import an HDFC-style Excel statement                      | ✓ account details skipped, Excel dates correct, merchants clean |
| Import result without an AI key                           | ✓ says AI is unavailable; lists what needs review               |
| Review queue: correct a salary credit to INCOME           | ✓ stored as manual, rule learned, dashboard totals corrected    |
| Dashboard, insights, India features, charts               | ✓                                                               |
| Budgets, range totals, CSV export, import history         | ✓                                                               |
| Undo an import                                            | ✓ rows and orphaned payees removed                              |
| Monthly summary without an AI key                         | ✓ figures-only recap with an explanation                        |
| Payee ledger, settings                                    | ✓                                                               |
| Demo session                                              | ✓ served; every write refused with 403                          |
| Paper and Night themes                                    | ✓                                                               |

Issues found by that run were fixed and committed: a budgets integration test
that never categorized its data, `POS` left in front of card-purchase
merchants, and the signed-in masthead wrapping at desktop width.

**Measured categorization results** (on the 704-row synthetic dataset; see
[RESULTS.md](../RESULTS.md) and [ACCURACY_REPORT.md](./ACCURACY_REPORT.md)):
96.6% of transactions categorized correctly with zero miscategorizations (the
rest routed to review), 4 of 4 planted anomalies detected, 13 of 13 recurring
bills identified with no false positives, 6 of 6 sync-glitch duplicates caught.

---

## 15. Build history

| Phase | Delivered                                                                                                              |
| ----- | ---------------------------------------------------------------------------------------------------------------------- |
| 0     | Monorepo, React client and Express server talking to each other                                                        |
| 1     | Data model and a deterministic synthetic dataset covering every edge case                                              |
| 2     | CSV upload, parsing and duplicate detection with a preview                                                             |
| 3     | Rule engine: keywords, transfer pairing, refund linking, splits                                                        |
| 4     | LLM categorization fallback with caching and schema validation                                                         |
| 5     | Dashboard and charts                                                                                                   |
| 6     | Statistical anomaly detection                                                                                          |
| 7     | Monthly plain-English summary from computed figures                                                                    |
| 8     | Edge-case hardening and the full test suite                                                                            |
| 9     | Auth, multi-user isolation and a security pass                                                                         |
| 10    | Deployment configuration, documentation and measured results                                                           |
| 11    | Indian rupee formatting and an Indian dataset                                                                          |
| 12    | PDF statements, with password handling                                                                                 |
| 13    | HDFC, SBI and PhonePe layouts; multi-file imports                                                                      |
| 14    | Indian merchant intelligence: brands, bills, payment rails, people vs shops                                            |
| 15    | Payee ledger                                                                                                           |
| 16    | Google sign-in                                                                                                         |
| 17    | Welcome email                                                                                                          |
| 18    | Money-direction colour coding and range totals                                                                         |
| 19    | India-specific insights: salary, savings, EMIs, SIPs, upcoming bills, festive months                                   |
| 20    | Completeness: accounts, import undo, learned rules, export, budgets, password flows — then real-data readiness (below) |

**Phase 20, real-data readiness (September 2026)**

- Indian CSV exports: header below account details, debit/credit columns,
  ₹/Cr/Dr amounts, day-first dates with an explicit "assumed" notice.
- Excel import (SheetJS), including in quarterly and custom imports.
- AI categorization on every import, never for payments to people, with an off
  switch; demo mode off in the deployment blueprint.
- The AI statement reader receives transaction rows only, identifiers masked.
- Counterparty extraction from hyphen-separated NEFT/IMPS/RTGS/UPI/NACH
  narrations, and from card-purchase (`POS`) lines.
- Startup configuration warnings; an honest "reset unavailable" without email.
- Request IDs, structured logs, and error references shown to the user.
- The Ledger redesign with Paper and Night themes.

---

## 16. Known limitations and next steps

- **Salary needs three months to be recognised.** An NEFT salary credit that
  names only the employer is filed as income once three consecutive months
  show the pattern; before that it waits in review (one correction also
  teaches a rule). Meanwhile it is shown as money "to review", never as
  negative spending.
- **Scanned PDFs** are refused — there is no OCR.
- **Dedicated PDF layouts** exist for HDFC, SBI and PhonePe only; others go to
  the generic reader, then the AI reader.
- **Password-protected Excel** files cannot be opened; the user is asked to save
  a copy without the password.
- **A first large import** waits for the AI to categorize many new merchants.
- **Existing rows keep old merchant keys** after normalizer improvements; the
  improvements apply to new imports.
- **Error tracking** (e.g. Sentry) is not added; request-ID logs are the
  current tool.
- **README screenshots** show the pre-redesign interface and should be
  re-captured from the demo account.
- **Phone-width layouts** follow standard breakpoints but have not been checked
  on a device since the redesign.

---

## 17. Resume summary

**FinTrack — personal finance ledger for Indian bank statements.**
React 19 · TypeScript · Express 5 · PostgreSQL/Prisma · Claude API.

- Built a full-stack app that imports CSV, Excel and password-protected PDF
  statements from Indian banks, detects duplicates across overlapping files,
  and categorizes transactions with a deterministic rule engine plus an LLM
  fallback — **96.6% categorized correctly with zero miscategorizations** on a
  704-transaction benchmark.
- Designed privacy-first AI use: the model sees merchant names only, never
  payments to individuals; statements sent for AI transcription are reduced to
  transaction rows with PAN, Aadhaar, account and phone numbers masked; every
  AI path has an off switch and degrades gracefully without a key.
- Implemented statistical insights with no model calls — price rises, new
  subscriptions, unusual charges, salary, EMIs, SIPs and upcoming bills —
  detecting **4/4 planted anomalies** and **13/13 recurring bills** with no
  false positives.
- Secured multi-user data with rotating refresh tokens, Google sign-in,
  per-row ownership checks, rate limiting, a server-enforced read-only demo,
  and structured request-ID logging.
- Designed a distinctive accessible interface ("Ledger") with light and dark
  themes and a chart palette validated for colour-blind readers.
- Backed by **1,700+ automated tests** (1,470 server tests against PostgreSQL,
  278 client tests) and CI on every change.
