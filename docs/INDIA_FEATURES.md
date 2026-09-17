# India-specific insights (Phase 19)

Five features that read an Indian bank or UPI statement and say something useful
about it. All five are **statistics only** — no model call, no stored state, no
clock. Each is a pure function of the transactions handed in, so the same data
always produces the same answer and every threshold below can be changed and
tested in isolation.

This document is the tuning guide. Every threshold has a named constant, a
default, and the reasoning behind where it sits. **Changing a default here means
changing it in the file named against it** — the values are not duplicated.

| Feature                     | Detector                                | Thresholds                            |
| --------------------------- | --------------------------------------- | ------------------------------------- |
| 1. Salary and savings rate  | `server/src/services/india/salary.ts`   | `SALARY_DEFAULTS`                     |
| 2. Loans and EMIs           | `server/src/services/india/emi.ts`      | `EMI_DEFAULTS`                        |
| 3. SIPs and investments     | `server/src/services/india/sip.ts`      | `SIP_DEFAULTS`                        |
| 4. Bill due-date prediction | `server/src/services/india/upcoming.ts` | `UPCOMING_DEFAULTS`                   |
| 5. Festive-season spending  | `server/src/services/india/festive.ts`  | `FESTIVE_DEFAULTS`, `FESTIVE_WINDOWS` |

All five are assembled by `buildIndiaInsights` in `server/src/services/india/index.ts`
and served from `GET /api/india?month=YYYY-MM`.

**Sign convention throughout: debit-positive.** Money leaving the account is a
positive amount; money arriving is negative. A "credit" below always means a
negative row.

---

## 1. Salary detection and savings rate

### What it answers

Which of these credits is the paycheque, and what share of the month's income
was not spent.

### How salary is detected

The unit of comparison is **what one payer paid in one calendar month**, not one
transaction. This is the central design decision, and it exists because plenty
of Indian employers pay twice a month: looking for a single credit on a monthly
cadence misses semi-monthly payroll entirely. A monthly payroll and a
semi-monthly one both come out as a stable monthly total from a stable payer.

For each payer (`normalizedMerchant`) in the lookback window:

1. Sum every credit in each month. Record the **day of the first credit** of
   that month as the anchor — not the largest, because with semi-monthly pay the
   larger of the two alternates and the pay day would look unstable when it is not.
2. Take the median of the monthly totals as the reference.
3. Walk the months in order and grow the longest run where, against the last
   month **counted**:
   - the total is within `amountTolerance` of the reference,
   - the month is the next calendar month after the last month **seen**,
   - the anchor day is within `dayTolerance`,
   - the number of credits matches.
4. A month **above** the reference from the same payer does not break the run.
   It is skipped rather than counted. See "bonus months" below.
5. The run must reach `minMonths` and the reference must clear `minMonthlyAmount`.

Where several payers qualify, the one with the largest monthly total wins — "the
largest recurring monthly credit".

### Bonus months

A thirteenth-month bonus, arrears or a reimbursement lands from the same payer
and blows that month's total past the tolerance. Treating that as a break would
mean one bonus in July stops the app finding the salary for the rest of the
year. So a month above the reference is skipped: not counted towards the typical
figure (it would drag it up), but not fatal to the chain either.

The chain's _anchor_ deliberately does not move to a skipped month. A bonus paid
on the 18th when payday is the 28th would otherwise make the following month
look like it had moved.

A month **below** the reference, or a missing month, does break the run. More
money from your employer is not evidence against employment; less money is.

### Thresholds — `SALARY_DEFAULTS`

| Constant           | Default | Why                                                                                                                                                                                                                    |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookbackMonths`   | 6       | Months of history considered, including the month analysed.                                                                                                                                                            |
| `minMonths`        | 3       | Two months of similar credits from one payer is obtainable by coincidence — two invoices to the same client, a deposit and its reversal. Three consecutive months is where "this is their income" stops being a guess. |
| `amountTolerance`  | 0.10    | ±10%. Wide enough for overtime and a benefit change, tight enough to exclude invoicing.                                                                                                                                |
| `dayTolerance`     | 5       | Pay days move: a payday on a Sunday is paid on the Friday, and a 31-day month shifts an end-of-month run.                                                                                                              |
| `minMonthlyAmount` | ₹10,000 | Below this, a regular credit is far more likely a standing transfer from family or a rent share than employment income — and a wrong salary figure makes every share-of-income figure wrong too.                       |

### Savings rate

`(income − expense) / income` for the month, where:

- **Transfers are excluded from both sides** (PROJECT_CONTEXT.md §5). Moving
  money to a credit card is neither income nor spending; counting it would make
  the rate swing wildly in a month somebody paid their card off early.
- **A refund nets against expense**, not income. A returned ₹4,599 pair of shoes
  is spending that came back; counting it as income would flatter the rate twice.
- **The rate is `null`, never `0`, when there is no income.** A month with no
  income does not have a savings rate of zero percent; it does not have one.

### What it must not do

Call irregular freelance income a salary. Three independent gates stand in the
way — consecutive months, a tight amount band, and a stable pay day — and
invoicing fails all three.

---

## 2. Loans and EMIs

### What it answers

Which fixed monthly instalments are running, what they cost, and — as an
estimate, never a fact — roughly how many payments are left.

### How an EMI is detected

An instalment is the most rigid thing in an Indian bank statement: the _same_
amount, on the _same_ day, every month, until the tenure ends. That rigidity is
what makes it detectable without a model, and it is what separates it from two
unrelated transfers that happen to be for similar money.

A row is a **candidate** if its category is `EMI_LOAN` (from Phase 14's rule
set) **or** its narration matches an EMI pattern:

```
\bEMI\b   \bLOAN\s*EMI\b   \bLOANEMI\b   \bINSTALMENT\b
\bINSTALLMENT\b   \bACH[ -]?D[ -]   \bNACH\b   \bEQUATED\s+MONTHLY\b
```

Being a candidate is not being an EMI. Grouped by merchant, a candidate set is
reported only if **all** of these hold:

1. At most one debit per calendar month (two is a prepayment or a second product).
2. The median instalment is at least `minAmount`.
3. **Every** instalment is within `amountTolerance` of the median.
4. Every debit day is within `dayTolerance` of the median day.
5. The months are strictly consecutive.
6. There are at least `minOccurrences` of them.

### Thresholds — `EMI_DEFAULTS`

| Constant          | Default                                            | Why                                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lookbackMonths`  | 12                                                 | A year of history, so a long-running loan shows its length.                                                                                                                                                   |
| `minOccurrences`  | 3                                                  | **The gate that rejects "two unrelated transfers of a similar amount".** Two of anything is a coincidence.                                                                                                    |
| `amountTolerance` | 0.02                                               | 2%. An instalment is a contract: the number does not move. Phase 6 allows _subscriptions_ 15% because a subscription genuinely drifts; allowing an EMI the same would let two similar transfers in as a loan. |
| `dayTolerance`    | 4                                                  | Auto-debit mandates land on their date, give or take a weekend.                                                                                                                                               |
| `minAmount`       | ₹1,000                                             | Below this it is more likely a standing order than a loan.                                                                                                                                                    |
| `staleMonths`     | 2                                                  | Two missed months and the loan is reported as finished rather than current.                                                                                                                                   |
| `commonTenures`   | 3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120, 180, 240 | The tenures Indian lenders actually write: consumer durables 3–12, personal loans 12–36, car loans 36–60, home loans 120–240.                                                                                 |

### The remaining-tenure estimate

**This is the weakest inference in the phase and is labelled as such everywhere
it appears.** Two things are unknowable from a bank statement: when the loan
actually started (the statement may begin mid-loan) and how long it runs.

The estimate assumes the first instalment visible is the first instalment there
was, snaps the tenure to the smallest `commonTenures` entry strictly greater
than the count observed, and returns a `caveat` string spelling out both
assumptions. It returns `null` — no guess at all — when the observed run already
exceeds the longest tenure known, and it can never say zero payments remain,
because "your loan is finished" is a claim rather than an estimate.

The UI renders the caveat in full next to an `est.` badge, not behind a tooltip.

---

## 3. SIPs and investments

### What it answers

What leaves every month into investments, and what share of income that is.

### How a SIP is detected

The same shape as an EMI, with two deliberate differences:

- **The category does the qualifying, not a keyword.** Phase 14 already routes
  Zerodha, Groww, Upstox, the AMCs, the registrars and the literal word "SIP" to
  `INVESTMENTS`. Re-deriving that here would be a second rule set to keep in step.
- **The amount band is wider.** 5% against the EMI's 2%, because a fund house
  rounds to whole units and a step-up SIP raises itself deliberately. Too tight a
  band and an ordinary SIP stops being recognised the month it steps up.

### Thresholds — `SIP_DEFAULTS`

| Constant          | Default | Why                                                                                                                                        |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lookbackMonths`  | 12      | As for EMIs.                                                                                                                               |
| `minOccurrences`  | 3       | Two contributions is a coincidence.                                                                                                        |
| `amountTolerance` | 0.05    | 5%. Wide enough for unit rounding and a step-up; far tighter than ordinary spending, which is what keeps two trips to the same broker out. |
| `dayTolerance`    | 4       | Mandate dates, as for EMIs.                                                                                                                |
| `minAmount`       | ₹500    | The smallest SIP most Indian fund houses accept.                                                                                           |
| `staleMonths`     | 2       | Two missed months and the plan is reported as stopped.                                                                                     |

### Share of income

`totalMonthly / salary.monthlyAmount`, and **`null` when no salary was found** —
not zero. An unknown share shown as 0% reads as "you are investing nothing".

The denominator is the detected _salary_, not the month's total credits. A month
with a bonus in it would otherwise make the commitment look smaller than it is.

---

## 4. Recurring-bill due-date prediction

### What it answers

Which utility bills and subscriptions are expected next, and when.

### How it works

Phase 6 already knows which merchants bill on a monthly cadence — that is
`findRecurringCharges` in `server/src/services/anomalies/detect.ts`, and it
carries the hard-won gate that a merchant billing more than once in any month is
everyday spending rather than a subscription. This feature **reuses** it rather
than re-deriving it, so there is one definition of "recurring".

On top of that:

1. Keep only charges in `categories`.
2. Take the day of the month of each charge. The projected day is their median;
   the spread is the largest distance from that median, measured the short way
   round a 31-day dial so the 1st and the 30th are one day apart, not twenty-nine.
3. If the spread exceeds `maxSpreadDays`, **offer no prediction at all**.
4. Project onto that day in the month after the last charge, clamped to the
   month's length.
5. Drop anything already past `asOf`, or beyond `horizonDays`.

### Why day-of-month, not an average gap

A bill charged on the 17th of April, May and June has gaps of 30 and 31 days.
Adding their mean lands on the **18th** of July, and every subsequent projection
drifts further. The bill is not "every 30.5 days", it is "the 17th" — and on the
31st it is "the 31st, or the last day the month has", which is why the projected
date is clamped rather than allowed to roll into the next month.

### Thresholds — `UPCOMING_DEFAULTS`

| Constant                   | Default                      | Why                                                                                                                           |
| -------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `lookbackMonths`           | 6                            | Matches Phase 6's own window.                                                                                                 |
| `categories`               | `UTILITIES`, `SUBSCRIPTIONS` | A monthly grocery run is recurring in the statistical sense; a due date for it would be useless and slightly absurd.          |
| `horizonDays`              | 45                           | Far enough to cover next month's bill from anywhere in this month, short enough that nothing on the list is idle speculation. |
| `highConfidenceSpreadDays` | 2                            | Two days of drift is a fixed billing date landing around a weekend.                                                           |
| `maxSpreadDays`            | 7                            | Beyond a week there is no date worth naming. Saying nothing beats inventing one.                                              |

### How it is presented

Every row says **expected**, the heading says **Expected next**, and a
medium-confidence row carries an `approx.` badge so a row read on its own still
says so. The word "due" appears nowhere. A prediction that does not land is a
mild annoyance; a date presented as certain and wrong is a reason not to trust
the app again.

A charge that was predicted and has not appeared is **dropped**, not shown as
overdue: the absence of a charge is not something a statement can confirm — it
may have been paid from another account, or the import may not have caught up.

---

## 5. Festive-season spending

### What it answers

Whether a month that overlaps a major Indian shopping or festive window was
above the person's **own** trailing baseline in the categories festive spending
usually lands in.

### The tone rules

This is the feature with the most ways to go wrong, and almost none of them are
statistical. Three rules run through it:

1. **The baseline is the user's own trailing months** — never a benchmark, an
   average Indian household, or anybody else. The comparison is always to themselves.
2. **The festive window is a calendar fact, not a conclusion.** The note says
   the month overlaps one. It does not say the spending was _caused_ by it,
   because nothing here can know that. There is no "because" in the output.
3. **Nothing is said at all** unless the month clears both a ratio and a rupee
   floor.

There is no "unusually high", no advice, no exclamation mark, and no adjective
doing work the numbers are not doing. If a reader wants to conclude they
overspent, that is theirs to conclude. The wording is asserted by tests.

### The festive calendar — `FESTIVE_WINDOWS`

Defined at **month** level, not date level, on purpose. The lunar festivals move
by weeks between years — Diwali fell in October in 2025 and falls in November in
2026 — so a date-level calendar would need maintaining every year and would be
wrong the moment it was not.

| Key               | Label               | Months             | Covers                                                                                                                                           |
| ----------------- | ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dussehra-diwali` | Dussehra and Diwali | Sep, Oct, Nov      | Dussehra falls in late September or October and Diwali in October or November, and the sale season that trails them runs to the end of November. |
| `year-end-sales`  | year-end sales      | Dec, Jan           | The year-end and new-year sale season.                                                                                                           |
| `wedding-season`  | wedding season      | Nov, Dec, Jan, Feb | The November-to-February wedding season.                                                                                                         |

Windows may overlap; a month reports every one it touches.

### How it works

For each category in `categories`, for a month that overlaps at least one window:

1. Total the month.
2. Total each of the `baselineMonths` months **before** it — excluding the month
   itself, because including it drags the baseline towards it and buries exactly
   the move being looked for.
3. **Drop baseline months with no data.** A month before the import began is
   absent, not a month they spent nothing; counting it as zero would halve the
   baseline and manufacture a finding.
4. Require at least `minBaselineMonths` surviving months.
5. Report the category only if the difference clears **both** `minRatio` and
   `minAbsolute`.

### Thresholds — `FESTIVE_DEFAULTS`

| Constant            | Default                                 | Why                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baselineMonths`    | 6                                       | Six months of the person's own history.                                                                                                                                                                               |
| `minBaselineMonths` | 3                                       | A "baseline" from one or two months is not a baseline, and the first months of any import would otherwise produce a note about every festival.                                                                        |
| `categories`        | `SHOPPING`, `DINING`, `GIFTS_DONATIONS` | What people actually buy more of in a festive season.                                                                                                                                                                 |
| `minRatio`          | 0.40                                    | 40% above their own median — deliberately _below_ Phase 6's 50% spike threshold, because this is an observation rather than an alert: worth mentioning at a level that would not be worth interrupting somebody over. |
| `minAbsolute`       | ₹8,000                                  | A note is only worth writing about money somebody would recognise as a real difference in the month.                                                                                                                  |

### A known limitation

The comparison is between **calendar-month totals** and does **not** pro-rate a
partial current month. Asked about a month that is half over, the detector
compares half a month against six whole ones, so it will under-report rather
than over-report. That is the right direction for a feature whose first rule is
not to invent claims, but it means a festive note may only appear once the month
has largely passed.

---

## Testing

Each detector has a suite that pins its thresholds against small hand-built
fixtures, split into "it fires on a real X" and "it does not fire where it
should not":

| File                                          | Covers                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `server/src/services/india/salary.test.ts`    | Monthly and semi-monthly payroll, bonus months, freelance rejection, savings-rate arithmetic |
| `server/src/services/india/emi.test.ts`       | Instalment detection, the two-similar-transfers rejection, the tenure estimate's caveats     |
| `server/src/services/india/sip.test.ts`       | Plan detection, ad-hoc buying rejection, share-of-income nulls                               |
| `server/src/services/india/upcoming.test.ts`  | Day-of-month projection, unpredictable-date rejection, category and horizon limits           |
| `server/src/services/india/festive.test.ts`   | The calendar, the thresholds, and the wording                                                |
| `server/src/services/india/seeded.test.ts`    | All five against the real seed dataset                                                       |
| `server/src/routes/india.integration.test.ts` | The route, against a real database and the real Phase 14 rule engine                         |

The seed generator carries a fixture for each: a semi-monthly salary with a
bonus month and irregular freelance income beside it, one EMI (`BAJAJ FINANCE
EMI`), a two-payment decoy for it (`MUTHOOT FINANCE`), two SIPs, and a
festive-season bump in September. They are tagged `emi`, `emi-decoy`, `sip` and
`festive` in `transactionsByEdgeCase`.
