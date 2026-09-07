# Synthetic transaction dataset

`synthetic_transactions.csv` is a deliberately messy, six-month bank export for a
single fictional person with two accounts. It exists so every edge case in
[PROJECT_CONTEXT.md §8](../PROJECT_CONTEXT.md) has concrete rows to test against,
and so the dashboard has something realistic to render.

**Every row below is fictional.** No real person, account or card is involved.

## Files

| File | What it is |
| --- | --- |
| `synthetic_transactions.csv` | 704 rows in a generic bank-export shape: `date,description,amount,account` |
| `README.md` | This file — the index from edge case to CSV row |

## Regenerating

Both files are generated, not hand-written:

```bash
npm run test-data:export --workspace server
```

The generator (`server/prisma/seed-data.ts`) is a pure function of a fixed seed
(`20260301`) and a fixed date window, so regenerating produces byte-identical
files and **the row numbers quoted below stay valid**. `server/prisma/seed.ts`
loads the same data into Postgres, so the CSV and the database always agree.
A test (`server/prisma/seed-data.test.ts`) fails if the committed files drift.

If you change the generator, re-run the command above and update this README's
row references — they are regenerated for you.

## Shape of the data

| | |
| --- | --- |
| Rows | 704 |
| Window | 2026-03-01 → 2026-09-07 (7 calendar months: 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08, 2026-09) |
| Accounts | Everyday Checking (236), Sapphire Credit Card (468) |
| Total spend | $62349.40 (excludes INCOME and TRANSFER, per §5) |
| Total income | $57163.46 |

Intended category mix (what a perfect categorizer would produce — the CSV itself
carries no category column):

| Category | Rows | Share |
| --- | ---: | ---: |
| DINING | 212 | 30.1% |
| TRANSPORTATION | 88 | 12.5% |
| SHOPPING | 80 | 11.4% |
| GROCERIES | 65 | 9.2% |
| ENTERTAINMENT | 44 | 6.3% |
| SUBSCRIPTIONS | 39 | 5.5% |
| TRAVEL | 25 | 3.6% |
| TRANSFER | 24 | 3.4% |
| HEALTH_FITNESS | 21 | 3.0% |
| INCOME | 21 | 3.0% |
| UTILITIES | 19 | 2.7% |
| BUSINESS | 16 | 2.3% |
| GIFTS_DONATIONS | 11 | 1.6% |
| PERSONAL_CARE | 10 | 1.4% |
| HOUSING | 7 | 1.0% |
| INSURANCE | 7 | 1.0% |
| REFUND | 6 | 0.9% |
| FEES_INTEREST | 6 | 0.9% |
| EDUCATION | 3 | 0.4% |

## Sign convention

`amount` is **debit-positive**:

* **positive** — money leaving the account: purchases, fees, a card payment sent
  from checking, money sent to a friend.
* **negative** — money arriving: salary, freelance income, refunds, the credit
  card's side of a payment, money coming back from a friend.

This is what makes a refund "a negative amount" as §8 case 2 describes, and it
matches how most credit-card exports are shaped. Note the consequence: **income
rows are negative**, which is why §5 excludes `INCOME` and `TRANSFER` from spend
totals rather than relying on the sign.

## Pending vs. posted

The CSV is a flat export and has no posted-date column. In the seeded database,
transactions dated on or after **2026-09-04** have a null `postedDate` and are
still pending (§8 case 6); everything earlier cleared one to three days after the
transaction date.

---

# Edge case index

Row numbers are **1-based data rows**, excluding the CSV header line. Row *n* is
line *n + 1* of the file.

## 1. Transfers between the user's own accounts (§8 case 1)

A monthly credit-card payment, recorded twice — leaving checking and arriving on
the card. Both sides must be excluded from spend *and* income totals, and the two
rows must not be double-counted.

| Row | Date | Description | Amount | Account | Direction |
| ---: | --- | --- | ---: | --- | --- |
| 85 | 2026-03-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1471.81 | Everyday Checking | out of checking |
| 86 | 2026-03-22 | `PAYMENT THANK YOU - MOBILE` | -$1471.81 | Sapphire Credit Card | onto the card |
| 205 | 2026-04-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1221.49 | Everyday Checking | out of checking |
| 206 | 2026-04-22 | `PAYMENT THANK YOU - MOBILE` | -$1221.49 | Sapphire Credit Card | onto the card |
| 334 | 2026-05-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1442.91 | Everyday Checking | out of checking |
| 335 | 2026-05-22 | `PAYMENT THANK YOU - MOBILE` | -$1442.91 | Sapphire Credit Card | onto the card |
| 450 | 2026-06-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1022.13 | Everyday Checking | out of checking |
| 451 | 2026-06-22 | `PAYMENT THANK YOU - MOBILE` | -$1022.13 | Sapphire Credit Card | onto the card |
| 547 | 2026-07-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1045.13 | Everyday Checking | out of checking |
| 548 | 2026-07-22 | `PAYMENT THANK YOU - MOBILE` | -$1045.13 | Sapphire Credit Card | onto the card |
| 647 | 2026-08-22 | `ONLINE PAYMENT TO CHASE CARD ...4021` | $1271.83 | Everyday Checking | out of checking |
| 648 | 2026-08-22 | `PAYMENT THANK YOU - MOBILE` | -$1271.83 | Sapphire Credit Card | onto the card |

Person-to-person round trips are also transfers — see case 9.

## 2. Refunds matched back to the originating purchase (§8 case 2)

Each pair is the same merchant and the exact same amount, `6–13` days apart. The
refund should net against the original purchase's category in aggregates while
still being stored as `REFUND`.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 21 | 2026-03-06 | `ZARA #482 SOHO` | $128.90 | Sapphire Credit Card | original purchase |
| 60 | 2026-03-15 | `ZARA #482 SOHO REFUND` | -$128.90 | Sapphire Credit Card | refund |
| 160 | 2026-04-11 | `NIKE.COM` | $174.25 | Sapphire Credit Card | original purchase |
| 212 | 2026-04-23 | `NIKE.COM REFUND` | -$174.25 | Sapphire Credit Card | refund |
| 319 | 2026-05-19 | `BEST BUY #1120` | $319.99 | Sapphire Credit Card | original purchase |
| 355 | 2026-05-26 | `BEST BUY #1120 REFUND` | -$319.99 | Sapphire Credit Card | refund |
| 385 | 2026-06-04 | `REI.COM ONLINE` | $246.50 | Sapphire Credit Card | original purchase |
| 434 | 2026-06-17 | `REI.COM ONLINE REFUND` | -$246.50 | Sapphire Credit Card | refund |
| 524 | 2026-07-13 | `AMZN Mktp US*RT4G21` | $89.99 | Sapphire Credit Card | original purchase |
| 541 | 2026-07-19 | `AMZN Mktp US*RT4G21 REFUND` | -$89.99 | Sapphire Credit Card | refund |
| 609 | 2026-08-08 | `WAYFAIR.COM ORDER` | $412.75 | Sapphire Credit Card | original purchase |
| 640 | 2026-08-19 | `WAYFAIR.COM ORDER REFUND` | -$412.75 | Sapphire Credit Card | refund |

## 3. Split-worthy purchases (§8 case 3)

Single charges that really span several categories. The CSV has one row each; the
intended breakdown is listed so Phase 3 can assert against it.

| Row | Date | Description | Amount | Account | Intended split |
| ---: | --- | --- | ---: | --- | --- |
| 35 | 2026-03-09 | `TARGET 0002341` | $187.43 | Sapphire Credit Card | GROCERIES $96.40<br>PERSONAL_CARE $41.15<br>SHOPPING $49.88 |
| 186 | 2026-04-17 | `WALMART SUPERCENTER #2201` | $214.88 | Sapphire Credit Card | GROCERIES $132.60<br>SHOPPING $82.28 |
| 349 | 2026-05-25 | `COSTCO WHSE #1188` | $342.17 | Sapphire Credit Card | GROCERIES $214.90<br>HEALTH_FITNESS $68.50<br>SHOPPING $58.77 |
| 419 | 2026-06-12 | `AMZN Mktp US*8H2K1LM` | $156.32 | Sapphire Credit Card | SHOPPING $104.32<br>BUSINESS $52.00 |
| 542 | 2026-07-20 | `BJ'S WHOLESALE #331` | $178.55 | Sapphire Credit Card | GROCERIES $121.05<br>TRANSPORTATION $57.50 |
| 593 | 2026-08-03 | `IKEA BROOKLYN #442` | $286.40 | Sapphire Credit Card | SHOPPING $268.00<br>DINING $18.40 |

## 4. Recurring subscriptions, including a price change (§8 case 4)

7 distinct subscriptions bill monthly. Two are special:

* **NETFLIX** rises from $15.49 to $17.99 partway through — a price hike Phase 6
  must flag (rows 66, 185, 312, 433, 536, 634).
* **DISNEY PLUS** only starts partway through the window — a *new* recurring
  charge, not a one-off (rows 527, 625).

| Subscription | Charges | Rows | Amounts |
| --- | ---: | --- | --- |
| ADOBE | 6 | 99, 234, 359, 469, 566, 665 | $22.99 |
| AMAZON PRIME | 6 | 79, 200, 330, 446, 544, 644 | $14.99 |
| APPLE ICLOUD | 7 | 20, 139, 270, 392, 507, 601, 697 | $2.99 |
| DISNEY PLUS | 2 | 527, 625 | $13.99 |
| NETFLIX | 6 | 66, 185, 312, 433, 536, 634 | $15.49, $17.99 |
| NEW YORK TIMES | 6 | 92, 220, 346, 458, 556, 657 | $4.00 |
| SPOTIFY | 6 | 34, 153, 281, 404, 515, 613 | $11.99 |

## 5. Duplicates from a sync glitch — and legitimate repeats (§8 case 5)

The hard part is telling these two groups apart. **Both** groups contain rows with
an identical merchant, amount and date.

### Sync-glitch duplicates — should be flagged

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 25 | 2026-03-07 | `SAFEWAY #14027` | $64.18 | Sapphire Credit Card | the real one |
| 26 | 2026-03-07 | `SAFEWAY #14027` | $64.18 | Sapphire Credit Card | the glitch copy |
| 173 | 2026-04-14 | `SHELL OIL 574812` | $52.40 | Sapphire Credit Card | the real one |
| 174 | 2026-04-14 | `SHELL OIL 574812` | $52.40 | Sapphire Credit Card | the glitch copy |
| 340 | 2026-05-23 | `TST* RAMEN TATSU-YA` | $38.75 | Sapphire Credit Card | the real one |
| 341 | 2026-05-23 | `TST* RAMEN TATSU-YA` | $38.75 | Sapphire Credit Card | the glitch copy |
| 407 | 2026-06-10 | `AMZN Mktp US*QQ91ZP` | $27.99 | Sapphire Credit Card | the real one |
| 408 | 2026-06-10 | `AMZN Mktp US*QQ91ZP` | $27.99 | Sapphire Credit Card | the glitch copy |
| 532 | 2026-07-16 | `WHOLE FOODS MKT #104` | $118.62 | Sapphire Credit Card | the real one |
| 533 | 2026-07-16 | `WHOLE FOODS MKT #104` | $118.62 | Sapphire Credit Card | the glitch copy |
| 588 | 2026-08-02 | `UBER   *TRIP` | $31.20 | Sapphire Credit Card | the real one |
| 589 | 2026-08-02 | `UBER   *TRIP` | $31.20 | Sapphire Credit Card | the glitch copy |

### Legitimate repeats — must NOT be flagged

Two coffees on the same day at the same price. A dedupe rule that keys only on
(merchant, amount, date) will produce a false positive on every one of these.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 15 | 2026-03-05 | `SQ *JOES COFFEE` | $5.25 | Sapphire Credit Card |
| 16 | 2026-03-05 | `SQ *JOES COFFEE` | $5.25 | Sapphire Credit Card |
| 188 | 2026-04-18 | `SQ *JOES COFFEE` | $4.75 | Sapphire Credit Card |
| 189 | 2026-04-18 | `SQ *JOES COFFEE` | $4.75 | Sapphire Credit Card |
| 414 | 2026-06-11 | `SQ *JOES COFFEE` | $5.50 | Sapphire Credit Card |
| 415 | 2026-06-11 | `SQ *JOES COFFEE` | $5.50 | Sapphire Credit Card |
| 562 | 2026-07-26 | `SQ *JOES COFFEE` | $4.75 | Sapphire Credit Card |
| 563 | 2026-07-26 | `SQ *JOES COFFEE` | $4.75 | Sapphire Credit Card |

## 6. Pending vs. posted transactions (§8 case 6)

18 rows dated on or after 2026-09-04 are still pending — null `postedDate`
in the database. They should not be treated as settled.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 687 | 2026-09-04 | `ALDI 6291` | $107.37 | Everyday Checking |
| 688 | 2026-09-04 | `TST* RAMEN TATSU-YA` | $75.40 | Sapphire Credit Card |
| 689 | 2026-09-04 | `SHELL OIL 57480479` | $57.53 | Everyday Checking |
| 690 | 2026-09-04 | `PAYPAL *STEAMGAMES` | $96.47 | Sapphire Credit Card |
| 691 | 2026-09-04 | `ONE MEDICAL GROUP` | $51.81 | Sapphire Credit Card |
| 692 | 2026-09-05 | `SONIC FIBER INTERNET` | $79.99 | Everyday Checking |
| 693 | 2026-09-05 | `WHOLE FOODS MKT #104` | $64.03 | Everyday Checking |
| 694 | 2026-09-05 | `TST* THE HALL - DOWNTOWN` | $45.06 | Sapphire Credit Card |
| 695 | 2026-09-05 | `UBER   *TRIP` | $14.04 | Everyday Checking |
| 696 | 2026-09-05 | `AMTRAK .COM` | $130.20 | Sapphire Credit Card |
| 697 | 2026-09-06 | `APPLE.COM/BILL ICLOUD` | $2.99 | Sapphire Credit Card |
| 698 | 2026-09-06 | `PEET'S COFFEE #1174` | $5.16 | Sapphire Credit Card |
| 699 | 2026-09-06 | `ALDI 6216` | $52.07 | Everyday Checking |
| 700 | 2026-09-06 | `DOORDASH*THAI BASIL` | $16.52 | Sapphire Credit Card |
| 701 | 2026-09-06 | `LYFT   *RIDE FRI` | $59.91 | Everyday Checking |
| 702 | 2026-09-06 | `IKEA BROOKLYN` | $157.97 | Sapphire Credit Card |
| 703 | 2026-09-07 | `IKEA BROOKLYN` | $87.36 | Sapphire Credit Card |
| 704 | 2026-09-07 | `CVS/PHARMACY #02148` | $23.81 | Sapphire Credit Card |

## 7. Foreign transaction fees split from the purchase (§8 case 7)

Each foreign purchase is followed by its own 3% fee line on the same date. The fee
belongs in `FEES_INTEREST`, not in the purchase's category, but the two need to
stay associated.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 61 | 2026-03-15 | `BOOKING.COM AMSTERDAM NL` | $412.30 | Sapphire Credit Card | foreign purchase |
| 62 | 2026-03-15 | `FOREIGN TRANSACTION FEE` | $12.37 | Sapphire Credit Card | 3% fee |
| 201 | 2026-04-21 | `SNCF INTERNET PARIS FR` | $88.40 | Sapphire Credit Card | foreign purchase |
| 202 | 2026-04-21 | `FOREIGN TRANSACTION FEE` | $2.65 | Sapphire Credit Card | 3% fee |
| 277 | 2026-05-08 | `MUJI SHIBUYA TOKYO JP` | $64.20 | Sapphire Credit Card | foreign purchase |
| 278 | 2026-05-08 | `FOREIGN TRANSACTION FEE` | $1.93 | Sapphire Credit Card | 3% fee |
| 470 | 2026-06-27 | `EL CORTE INGLES MADRID ES` | $132.75 | Sapphire Credit Card | foreign purchase |
| 471 | 2026-06-27 | `FOREIGN TRANSACTION FEE` | $3.98 | Sapphire Credit Card | 3% fee |
| 501 | 2026-07-05 | `TESCO STORES 3411 LONDON UK` | $41.60 | Sapphire Credit Card | foreign purchase |
| 502 | 2026-07-05 | `FOREIGN TRANSACTION FEE` | $1.25 | Sapphire Credit Card | 3% fee |
| 641 | 2026-08-19 | `TRENITALIA ROMA IT` | $96.85 | Sapphire Credit Card | foreign purchase |
| 642 | 2026-08-19 | `FOREIGN TRANSACTION FEE` | $2.91 | Sapphire Credit Card | 3% fee |

## 8. Ambiguous, processor-mangled merchant strings (§8 case 8)

267 rows across 27 merchants carry a payment-processor prefix, a
gateway name, or a trailing store/order id that varies row to row. The
**normalizes to** column is what Phase 2's normalizer is expected to produce, and
what the LLM merchant cache is keyed on.

| Example raw descriptor | Normalizes to | Rows | First row |
| --- | --- | ---: | ---: |
| `SQ *BLUEBIRD BAKERY` | `BLUEBIRD BAKERY` | 26 | 36 |
| `SQ *JOES COFFEE` | `JOES COFFEE` | 25 | 11 |
| `DOORDASH*THAI BASIL` | `DOORDASH` | 25 | 68 |
| `TST* THE HALL - DOWNTOWN` | `THE HALL` | 20 | 3 |
| `TST* RAMEN TATSU-YA` | `RAMEN TATSU-YA` | 16 | 121 |
| `UBER   *TRIP` | `UBER` | 14 | 9 |
| `MTA*NYCT PAYGO` | `MTA` | 14 | 94 |
| `LYFT   *RIDE FRI` | `LYFT` | 12 | 43 |
| `AMZN Mktp US*7100385` | `AMAZON MARKETPLACE` | 12 | 108 |
| `PAYPAL *STEAMGAMES` | `STEAM` | 11 | 170 |
| `PAYPAL *ETSYINC` | `ETSY` | 10 | 75 |
| `SP * ALLBIRDS` | `ALLBIRDS` | 10 | 105 |
| `TICKETMASTER*EVENT` | `TICKETMASTER` | 9 | 19 |
| `WWW.PATREON.COM* SUPPORT` | `PATREON` | 9 | 76 |
| `STRIPE TRANSFER` | `STRIPE` | 8 | 24 |
| `DONATION*RED CROSS` | `RED CROSS` | 7 | 7 |
| `AMAZON PRIME*MEMBERSHIP` | `AMAZON PRIME` | 6 | 79 |
| `NYTIMES*NYTIMES DIGITAL` | `NEW YORK TIMES` | 6 | 92 |
| `GITHUB.COM*ACCOUNT` | `GITHUB` | 5 | 10 |
| `VENMO PAYMENT 1039485` | `VENMO` | 4 | 40 |
| `AIRBNB * HM4X6422` | `AIRBNB` | 4 | 53 |
| `CASH APP*JORDAN M` | `CASH APP` | 4 | 221 |
| `ZELLE TO SAM RIVERA` | `ZELLE` | 4 | 271 |
| `EXPEDIA*ITIN 7341508` | `EXPEDIA` | 3 | 113 |
| `SQ *FARMERS MKT STALL 12` | `FARMERS MKT STALL 12` | 1 | 148 |
| `PAYPAL *WWWSTORE` | `WWWSTORE` | 1 | 336 |
| `TST* CATERING CO` | `CATERING CO` | 1 | 530 |

## 9. Person-to-person payments that round-trip (§8 case 9)

Money sent to a friend and paid back days later. Neither leg is real spending;
counting the outgoing leg alone overstates the month.

| Row | Date | Description | Amount | Account | Direction |
| ---: | --- | --- | ---: | --- | --- |
| 40 | 2026-03-10 | `VENMO PAYMENT 1039485` | $45.00 | Everyday Checking | sent |
| 54 | 2026-03-13 | `VENMO CASHOUT 1039912` | -$45.00 | Everyday Checking | paid back |
| 221 | 2026-04-24 | `CASH APP*JORDAN M` | $30.00 | Everyday Checking | sent |
| 228 | 2026-04-26 | `CASH APP*CASHOUT` | -$30.00 | Everyday Checking | paid back |
| 271 | 2026-05-06 | `ZELLE TO SAM RIVERA` | $120.00 | Everyday Checking | sent |
| 287 | 2026-05-11 | `ZELLE FROM SAM RIVERA` | -$120.00 | Everyday Checking | paid back |
| 438 | 2026-06-18 | `VENMO PAYMENT 1104773` | $72.50 | Everyday Checking | sent |
| 452 | 2026-06-22 | `VENMO CASHOUT 1105220` | -$72.50 | Everyday Checking | paid back |
| 488 | 2026-07-02 | `ZELLE TO PRIYA N` | $210.00 | Everyday Checking | sent |
| 511 | 2026-07-08 | `ZELLE FROM PRIYA N` | -$210.00 | Everyday Checking | paid back |
| 621 | 2026-08-13 | `CASH APP*ALEX T` | $64.00 | Everyday Checking | sent |
| 630 | 2026-08-16 | `CASH APP*CASHOUT` | -$64.00 | Everyday Checking | paid back |

## 10. Large one-off purchases (§8 case 10)

Big enough to distort any category average they land in, but not anomalies —
anomaly detection must not simply flag "unusually large".

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 306 | 2026-05-16 | `APPLE STORE #R412` | $3299.00 | Sapphire Credit Card |
| 508 | 2026-07-07 | `DELTA AIR LINES 0062` | $1842.60 | Sapphire Credit Card |

## 11. Irregular and variable income (§8 case 11)

Income arrives from three sources with different rhythms: a semi-monthly salary
that varies slightly, freelance payments that vary in both timing and size, and a
one-off bonus.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 24 | 2026-03-07 | `STRIPE TRANSFER FREELANCE` | -$487.85 | Everyday Checking |
| 59 | 2026-03-15 | `NORTHWIND LABS DIRECT DEP` | -$3539.86 | Everyday Checking |
| 69 | 2026-03-18 | `STRIPE TRANSFER FREELANCE` | -$1051.72 | Everyday Checking |
| 109 | 2026-03-30 | `NORTHWIND LABS DIRECT DEP` | -$3511.65 | Everyday Checking |
| 134 | 2026-04-05 | `STRIPE TRANSFER FREELANCE` | -$1609.02 | Everyday Checking |
| 179 | 2026-04-15 | `NORTHWIND LABS DIRECT DEP` | -$3399.37 | Everyday Checking |
| 195 | 2026-04-20 | `STRIPE TRANSFER FREELANCE` | -$1078.07 | Everyday Checking |
| 245 | 2026-04-30 | `NORTHWIND LABS DIRECT DEP` | -$3497.29 | Everyday Checking |
| 300 | 2026-05-15 | `NORTHWIND LABS DIRECT DEP` | -$3430.33 | Everyday Checking |
| 305 | 2026-05-16 | `STRIPE TRANSFER FREELANCE` | -$1441.84 | Everyday Checking |
| 366 | 2026-05-30 | `NORTHWIND LABS DIRECT DEP` | -$3353.60 | Everyday Checking |
| 413 | 2026-06-11 | `STRIPE TRANSFER FREELANCE` | -$1962.25 | Everyday Checking |
| 429 | 2026-06-15 | `NORTHWIND LABS DIRECT DEP` | -$3458.62 | Everyday Checking |
| 461 | 2026-06-25 | `STRIPE TRANSFER FREELANCE` | -$2012.24 | Everyday Checking |
| 480 | 2026-06-30 | `NORTHWIND LABS DIRECT DEP` | -$3493.61 | Everyday Checking |
| 500 | 2026-07-05 | `STRIPE TRANSFER FREELANCE` | -$1409.81 | Everyday Checking |
| 529 | 2026-07-15 | `NORTHWIND LABS DIRECT DEP` | -$3408.68 | Everyday Checking |
| 538 | 2026-07-18 | `NORTHWIND LABS BONUS` | -$4500.00 | Everyday Checking |
| 575 | 2026-07-30 | `NORTHWIND LABS DIRECT DEP` | -$3514.86 | Everyday Checking |
| 627 | 2026-08-15 | `NORTHWIND LABS DIRECT DEP` | -$3518.30 | Everyday Checking |
| 671 | 2026-08-30 | `NORTHWIND LABS DIRECT DEP` | -$3484.49 | Everyday Checking |

## 12. Manual corrections that must survive re-import (§8 case 12)

These rows are seeded already corrected — `source = MANUAL`, with the category a
human chose — and each one has a matching `Rule` with
`learnedFromOverride = true`. Re-importing the CSV or re-running the rule and LLM
passes must leave them alone.

| Row | Date | Description | Amount | Account | Corrected to |
| ---: | --- | --- | ---: | --- | --- |
| 148 | 2026-04-08 | `SQ *FARMERS MKT STALL 12` | $38.50 | Sapphire Credit Card | GROCERIES (a naive parser would guess otherwise) |
| 336 | 2026-05-22 | `PAYPAL *WWWSTORE` | $129.00 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
| 530 | 2026-07-15 | `TST* CATERING CO` | $264.40 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
