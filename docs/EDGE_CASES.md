# Edge Cases

Every case in [`PROJECT_CONTEXT.md` §8](../PROJECT_CONTEXT.md), what the app is
supposed to do about it, and the automated test that proves it does.

The tests come in three shapes, and the shape matters:

- **Unit** — the pure logic, with a fixture built for the property under test.
- **End-to-end (pure)** — `server/src/services/edge-cases.test.ts` runs the real
  pipeline (parse → normalize → dedup → rule engine → anomaly detection) over
  the Phase-1 synthetic dataset and asserts the *planted* rows behave. This is
  where a regression that only appears when the stages compose gets caught; it
  is how the merchant-normalization defect in this phase was found.
- **Integration (Postgres)** — `server/src/services/dashboard/aggregate.integration.test.ts`.
  The rules that decide the headline totals live in SQL, so a mocked Prisma
  cannot test them. CI runs these against a `postgres:16` service; they skip
  locally when `DATABASE_URL` is unset.
- **Client** — Vitest + Testing Library, for the cases a person resolves by hand.

Quantitative results are in [`ACCURACY_REPORT.md`](./ACCURACY_REPORT.md).

---

## 1. Transfers between the user's own accounts

**Expected:** both legs are found from amounts and dates alone, categorized
`TRANSFER`, linked to each other, and excluded from spend *and* income.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | pairs every planted transfer, one leg to one leg |
| `server/src/services/edge-cases.test.ts` | categorizes both legs TRANSFER, so neither is spend nor income |
| `server/src/services/edge-cases.test.ts` | links the two legs so the pairing is visible in the data, not just implied |
| `server/src/services/dashboard/aggregate.integration.test.ts` | excludes transfers from spend and from income alike |
| `server/src/services/rules/engine.test.ts` | pairs equal and opposite amounts across two accounts |
| `server/src/services/rules/engine.test.ts` | ranks card payments above merchant rules so a transfer is never spend |
| `server/src/services/parsing/normalize.test.ts` | rewrites a card-payment descriptor to BANK CARD PAYMENT |

**Status:** covered.

## 2. Refunds and returns

**Expected:** a negative amount is matched back to the earlier purchase it
offsets — same merchant, same account, same magnitude — the refund is
categorized `REFUND`, the link is stored on the purchase, and the money nets
against the purchase's category rather than forming a bucket of its own. A
purchase that came back in full is not unusual spending.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | links every planted refund to its own original purchase |
| `server/src/services/edge-cases.test.ts` | marks the refund REFUND and stores the link on the purchase |
| `server/src/services/dashboard/aggregate.integration.test.ts` | nets a refund against the category it came from, not a bucket of its own |
| `server/src/services/rules/engine.test.ts` | links a refund back to the earlier purchase it offsets |
| `server/src/services/anomalies/detect.test.ts` | judges a charge by what was kept, not what was rung up (§8 case 2) |
| `server/src/services/anomalies/detect.test.ts` | still flags what is left after a partial refund |
| `server/src/services/parsing/normalize.test.ts` | reduces a return to the same key as the purchase it reverses: %s |

**Status:** covered.

## 3. Split transactions

**Expected:** a single charge can be divided across categories; the parts must
sum to the total exactly; the parent is counted by its parts and never also by
itself.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | plants charges that genuinely span categories, with parts summing to the whole |
| `server/src/services/edge-cases.test.ts` | categorizes the parent by its dominant merchant until a user splits it |
| `server/src/services/dashboard/aggregate.integration.test.ts` | counts a split by its parts and never also by its parent |
| `server/src/routes/transactions.test.ts` | accepts parts that sum exactly to the transaction total |
| `client/src/components/SplitDialog.test.tsx` | will not save a one-cent discrepancy |

**Status:** covered.

## 4. Recurring subscriptions and price changes

**Expected:** a monthly cadence is detected from spacing and amount stability;
a material price rise is flagged in the month the new price appears, once and
not again; a subscription is categorized without a model call.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | detects the price change in the month the new price first appears |
| `server/src/services/edge-cases.test.ts` | detects the new subscription on its confirming second charge |
| `server/src/services/edge-cases.test.ts` | categorizes the running subscriptions without an LLM call |
| `server/src/services/anomalies/detect.test.ts` | finds the subscription price change, in the month the new price appears |
| `server/src/services/anomalies/detect.test.ts` | does not repeat the price change in the months that follow it |
| `server/src/services/anomalies/detect.test.ts` | will not call a bill that is different every month a price change |
| `client/src/components/dashboard/InsightsPanel.test.tsx` | renders each flag with a plain-language type and its explanation |

**Status:** covered.

## 5. Sync-glitch duplicates vs legitimate repeats

**Expected:** an apparent duplicate is *flagged*, never silently dropped —
the two are indistinguishable in bank data, so the import preview asks and the
user decides. Separately, a legitimately repeated small charge must never be
read as a new recurring charge.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | flags every planted sync glitch |
| `server/src/services/edge-cases.test.ts` | leaves the original of each pair alone |
| `server/src/services/edge-cases.test.ts` | flags a legitimate same-day repeat too, and says why, rather than guessing |
| `server/src/services/edge-cases.test.ts` | never confuses the daily coffee for a new recurring charge |
| `server/src/services/anomalies/detect.test.ts` | does not flag the daily coffee as a new recurring charge |
| `server/src/services/anomalies/detect.test.ts` | separates the monthly bills from everyday spending exactly |
| `server/src/services/parsing/dedup.test.ts` | flags an exact match on date, amount and merchant |
| `client/src/pages/UploadPage.test.tsx` | defaults flagged rows to skip and says how many will be imported |

**Status:** covered.

## 6. Pending vs posted

**Expected:** a pending row has no posted date, is categorized exactly as a
settled row from the same merchant, counts towards the month's spend, and is
matched for duplicates on its transaction date rather than its posted date.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | plants pending rows with no posted date |
| `server/src/services/edge-cases.test.ts` | categorizes a pending charge exactly as it would once posted |
| `server/src/services/edge-cases.test.ts` | matches duplicates on the transaction date, not the posted date |
| `server/src/services/dashboard/aggregate.integration.test.ts` | counts a pending transaction, which is money already gone |
| `server/prisma/seed-data.test.ts` | marks only the most recent transactions as pending |

**Status:** covered.

## 7. Foreign transaction fees

**Expected:** the fee stays its own row rather than being folded into the
purchase; the fee is `FEES_INTEREST` and the purchase is whatever was bought;
the two are not read as duplicates of each other.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | keeps the fee as its own row rather than folding it into the purchase |
| `server/src/services/edge-cases.test.ts` | categorizes the fee as FEES_INTEREST and the purchase as what was bought |
| `server/src/services/edge-cases.test.ts` | does not read the fee and its purchase as a duplicate of each other |
| `server/src/services/dashboard/aggregate.integration.test.ts` | keeps a foreign transaction fee as its own line |
| `server/src/services/parsing/normalize.test.ts` | foreign charges keep the brand, drop the place |

**Status:** covered.

## 8. Ambiguous and processor-mangled merchant strings

**Expected:** `SQ *JOES COFFEE`, `TST* THE HALL` and `PAYPAL *STEAMGAMES`
reduce to the same key a clean descriptor would, so the rule engine and the
merchant cache see one merchant. What genuinely cannot be decided from the
string is left `UNCATEGORIZED` rather than guessed.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | normalizes every descriptor in the dataset to its documented merchant |
| `server/src/services/edge-cases.test.ts` | parses the committed CSV to the same merchants the generator recorded |
| `server/src/services/edge-cases.test.ts` | categorizes a mangled descriptor as well as a clean one |
| `server/src/services/parsing/normalize.test.ts` | normalizes every descriptor to its documented value |
| `server/src/services/rules/engine.test.ts` | leaves the ambiguous merchant %s for the LLM fallback |
| `server/src/routes/transactions.test.ts` | normalizes the processor-mangled descriptors (§8 case 8) |

**Status:** covered.

## 9. Peer-to-peer round trips

**Expected:** money sent and returned over Venmo, Cash App or Zelle is
`TRANSFER` on both legs, is not spending, and — despite having the exact shape
of one — is never read as a refund.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | categorizes both halves TRANSFER, so a round trip is not spending |
| `server/src/services/edge-cases.test.ts` | does not mistake the money coming back for a refund |
| `server/src/services/edge-cases.test.ts` | collapses the payment network to one merchant however the descriptor reads |
| `server/src/services/dashboard/aggregate.integration.test.ts` | does not read a peer-to-peer round trip as spending |
| `server/src/services/rules/engine.test.ts` | does not read a person-to-person round trip as a refund |
| `server/src/services/parsing/normalize.test.ts` | normalizes %s to %s |

**Status:** covered.

## 10. Large one-off purchases

**Expected:** the charge is flagged, and — the harder half — it must not
quietly redefine "normal" for its category and mask what comes after it.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | flags each planted one-off as an unusual amount |
| `server/src/services/edge-cases.test.ts` | does not let the one-off raise the bar and hide itself |
| `server/src/services/edge-cases.test.ts` | still finds the anomalies in the months after it |
| `server/src/services/anomalies/statistics.test.ts` | is not dragged upwards by the outlier it is meant to catch |
| `server/src/services/anomalies/detect.test.ts` | uses a median baseline, so one huge month cannot hide the next |
| `server/src/services/anomalies/detect.test.ts` | rates the $3,299 laptop more severely than the $1,842 flight |

**Status:** covered.

## 11. Irregular and variable income

**Expected:** income arrives from several sources at different amounts on
different days; every source is `INCOME`, stays negative under the
debit-positive convention, is counted in the income total, and is never an
anomaly.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | plants income that varies in amount, date and source |
| `server/src/services/edge-cases.test.ts` | categorizes every source as INCOME, whatever it is called or worth |
| `server/src/services/edge-cases.test.ts` | keeps income negative under the debit-positive convention |
| `server/src/services/edge-cases.test.ts` | does not flag an irregular payday as an anomaly |
| `server/src/services/dashboard/aggregate.integration.test.ts` | reports income from every source, however irregular |
| `server/src/services/parsing/csv.test.ts` | keeps income negative under the debit-positive convention |

**Status:** covered.

## 12. Manual corrections survive

**Expected:** once a person sets a category, nothing takes it away — not a
re-run of the rule engine, not the LLM pass, not a re-import of the same file,
and not a rule added later that would have matched.

| Test | Name |
| --- | --- |
| `server/src/services/edge-cases.test.ts` | plants corrections on merchants no rule can resolve |
| `server/src/services/edge-cases.test.ts` | leaves a manual row untouched when the engine runs |
| `server/src/services/edge-cases.test.ts` | survives a re-run of the engine, however many times it runs |
| `server/src/services/edge-cases.test.ts` | survives a re-import of the same file |
| `server/src/services/edge-cases.test.ts` | is never re-categorized even once a rule learns to match the merchant |
| `server/src/services/rules/engine.test.ts` | never overwrites a manual correction (§8 case 12) |
| `server/src/services/rules/engine.test.ts` | leaves manual rows out of rule matching and out of pairing |
| `server/src/services/ai/apply.test.ts` | only considers UNCATEGORIZED rows the rule engine produced |
| `server/src/routes/transactions.test.ts` | stores the correction as MANUAL at full confidence |
| `server/src/routes/transactions.test.ts` | corrects the merchant cache so a stale AI answer cannot contradict the human |
| `client/src/pages/ReviewPage.test.tsx` | overrides to a different category from the dropdown |

**Status:** covered.

---

## Summary

| Case | Status |
| --- | --- |
| 1. Transfers | covered |
| 2. Refunds | covered |
| 3. Splits | covered |
| 4. Recurring and price changes | covered |
| 5. Duplicates vs legitimate repeats | covered |
| 6. Pending vs posted | covered |
| 7. Foreign transaction fees | covered |
| 8. Mangled merchant strings | covered |
| 9. Peer-to-peer round trips | covered |
| 10. Large one-off purchases | covered |
| 11. Irregular income | covered |
| 12. Manual corrections | covered |

Test names are the exact `it(...)` titles; `%s` marks a parameterised case.
`server/src/services/edge-cases-doc.test.ts` fails if any citation on this page
stops matching a real test.
