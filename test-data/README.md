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
| Total spend | ₹9,82,861.08 (excludes INCOME and TRANSFER, per §5) |
| Total income | ₹10,18,201.52 |

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
| 85 | 2026-03-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹41,714.36 | Everyday Checking | out of checking |
| 86 | 2026-03-22 | `PAYMENT THANK YOU - MOBILE` | -₹41,714.36 | Sapphire Credit Card | onto the card |
| 205 | 2026-04-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹32,982.26 | Everyday Checking | out of checking |
| 206 | 2026-04-22 | `PAYMENT THANK YOU - MOBILE` | -₹32,982.26 | Sapphire Credit Card | onto the card |
| 334 | 2026-05-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹40,706.02 | Everyday Checking | out of checking |
| 335 | 2026-05-22 | `PAYMENT THANK YOU - MOBILE` | -₹40,706.02 | Sapphire Credit Card | onto the card |
| 450 | 2026-06-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹26,027.84 | Everyday Checking | out of checking |
| 451 | 2026-06-22 | `PAYMENT THANK YOU - MOBILE` | -₹26,027.84 | Sapphire Credit Card | onto the card |
| 547 | 2026-07-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹26,830.18 | Everyday Checking | out of checking |
| 548 | 2026-07-22 | `PAYMENT THANK YOU - MOBILE` | -₹26,830.18 | Sapphire Credit Card | onto the card |
| 647 | 2026-08-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹34,738.37 | Everyday Checking | out of checking |
| 648 | 2026-08-22 | `PAYMENT THANK YOU - MOBILE` | -₹34,738.37 | Sapphire Credit Card | onto the card |

Person-to-person round trips are also transfers — see case 9.

## 2. Refunds matched back to the originating purchase (§8 case 2)

Each pair is the same merchant and the exact same amount, `6–13` days apart. The
refund should net against the original purchase's category in aggregates while
still being stored as `REFUND`.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 21 | 2026-03-06 | `MYNTRA #482` | ₹2,899.00 | Sapphire Credit Card | original purchase |
| 60 | 2026-03-15 | `MYNTRA #482 REFUND` | -₹2,899.00 | Sapphire Credit Card | refund |
| 160 | 2026-04-11 | `NIKE.COM` | ₹4,599.00 | Sapphire Credit Card | original purchase |
| 212 | 2026-04-23 | `NIKE.COM REFUND` | -₹4,599.00 | Sapphire Credit Card | refund |
| 319 | 2026-05-19 | `CROMA #1120` | ₹8,999.00 | Sapphire Credit Card | original purchase |
| 355 | 2026-05-26 | `CROMA #1120 REFUND` | -₹8,999.00 | Sapphire Credit Card | refund |
| 385 | 2026-06-04 | `DECATHLON.COM ONLINE` | ₹5,499.00 | Sapphire Credit Card | original purchase |
| 434 | 2026-06-17 | `DECATHLON.COM ONLINE REFUND` | -₹5,499.00 | Sapphire Credit Card | refund |
| 524 | 2026-07-13 | `AMZN Mktp IN*RT4G21` | ₹1,899.00 | Sapphire Credit Card | original purchase |
| 541 | 2026-07-19 | `AMZN Mktp IN*RT4G21 REFUND` | -₹1,899.00 | Sapphire Credit Card | refund |
| 609 | 2026-08-08 | `PEPPERFRY.COM ORDER` | ₹9,499.00 | Sapphire Credit Card | original purchase |
| 640 | 2026-08-19 | `PEPPERFRY.COM ORDER REFUND` | -₹9,499.00 | Sapphire Credit Card | refund |

## 3. Split-worthy purchases (§8 case 3)

Single charges that really span several categories. The CSV has one row each; the
intended breakdown is listed so Phase 3 can assert against it.

| Row | Date | Description | Amount | Account | Intended split |
| ---: | --- | --- | ---: | --- | --- |
| 35 | 2026-03-09 | `FLIPKART 0002341` | ₹2,895.00 | Sapphire Credit Card | GROCERIES ₹1,490.00<br>PERSONAL_CARE ₹635.00<br>SHOPPING ₹770.00 |
| 186 | 2026-04-17 | `RELIANCE SMART #2201` | ₹2,930.00 | Sapphire Credit Card | GROCERIES ₹2,045.00<br>SHOPPING ₹885.00 |
| 349 | 2026-05-25 | `METRO CASH CARRY #1188` | ₹5,270.00 | Sapphire Credit Card | GROCERIES ₹3,310.00<br>HEALTH_FITNESS ₹1,055.00<br>SHOPPING ₹905.00 |
| 419 | 2026-06-12 | `AMZN Mktp IN*8H2K1LM` | ₹2,405.00 | Sapphire Credit Card | SHOPPING ₹1,605.00<br>BUSINESS ₹800.00 |
| 542 | 2026-07-20 | `SPENCERS HYPER #331` | ₹2,750.00 | Sapphire Credit Card | GROCERIES ₹1,865.00<br>TRANSPORTATION ₹885.00 |
| 593 | 2026-08-03 | `IKEA HYDERABAD #442` | ₹4,415.00 | Sapphire Credit Card | SHOPPING ₹4,130.00<br>DINING ₹285.00 |

## 4. Recurring subscriptions, including a price change (§8 case 4)

7 distinct subscriptions bill monthly. Two are special:

* **NETFLIX** rises from ₹499.00 to ₹649.00 partway through — a price hike Phase 6
  must flag (rows 66, 185, 312, 433, 536, 634).
* **DISNEY PLUS** only starts partway through the window — a *new* recurring
  charge, not a one-off (rows 527, 625).

| Subscription | Charges | Rows | Amounts |
| --- | ---: | --- | --- |
| ADOBE | 6 | 99, 234, 359, 469, 566, 665 | ₹699.00 |
| AMAZON PRIME | 6 | 79, 200, 330, 446, 544, 644 | ₹299.00 |
| APPLE ICLOUD | 7 | 20, 139, 270, 392, 507, 601, 697 | ₹75.00 |
| HOTSTAR | 2 | 527, 625 | ₹299.00 |
| NETFLIX | 6 | 66, 185, 312, 433, 536, 634 | ₹499.00, ₹649.00 |
| SPOTIFY | 6 | 34, 153, 281, 404, 515, 613 | ₹119.00 |
| ZEE5 | 6 | 92, 220, 346, 458, 556, 657 | ₹99.00 |

## 5. Duplicates from a sync glitch — and legitimate repeats (§8 case 5)

The hard part is telling these two groups apart. **Both** groups contain rows with
an identical merchant, amount and date.

### Sync-glitch duplicates — should be flagged

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 25 | 2026-03-07 | `DMART #14027` | ₹1,284.00 | Sapphire Credit Card | the real one |
| 26 | 2026-03-07 | `DMART #14027` | ₹1,284.00 | Sapphire Credit Card | the glitch copy |
| 173 | 2026-04-14 | `INDIAN OIL 574812` | ₹1,250.00 | Sapphire Credit Card | the real one |
| 174 | 2026-04-14 | `INDIAN OIL 574812` | ₹1,250.00 | Sapphire Credit Card | the glitch copy |
| 340 | 2026-05-23 | `TST* BARBEQUE NATION` | ₹1,899.00 | Sapphire Credit Card | the real one |
| 341 | 2026-05-23 | `TST* BARBEQUE NATION` | ₹1,899.00 | Sapphire Credit Card | the glitch copy |
| 407 | 2026-06-10 | `AMZN Mktp IN*QQ91ZP` | ₹649.00 | Sapphire Credit Card | the real one |
| 408 | 2026-06-10 | `AMZN Mktp IN*QQ91ZP` | ₹649.00 | Sapphire Credit Card | the glitch copy |
| 532 | 2026-07-16 | `RELIANCE FRESH #104` | ₹2,374.00 | Sapphire Credit Card | the real one |
| 533 | 2026-07-16 | `RELIANCE FRESH #104` | ₹2,374.00 | Sapphire Credit Card | the glitch copy |
| 588 | 2026-08-02 | `UBER   *TRIP` | ₹289.00 | Sapphire Credit Card | the real one |
| 589 | 2026-08-02 | `UBER   *TRIP` | ₹289.00 | Sapphire Credit Card | the glitch copy |

### Legitimate repeats — must NOT be flagged

Two coffees on the same day at the same price. A dedupe rule that keys only on
(merchant, amount, date) will produce a false positive on every one of these.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 15 | 2026-03-05 | `PAYTM*CHAI POINT` | ₹150.00 | Sapphire Credit Card |
| 16 | 2026-03-05 | `PAYTM*CHAI POINT` | ₹150.00 | Sapphire Credit Card |
| 188 | 2026-04-18 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 189 | 2026-04-18 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 414 | 2026-06-11 | `PAYTM*CHAI POINT` | ₹160.00 | Sapphire Credit Card |
| 415 | 2026-06-11 | `PAYTM*CHAI POINT` | ₹160.00 | Sapphire Credit Card |
| 562 | 2026-07-26 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 563 | 2026-07-26 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |

## 6. Pending vs. posted transactions (§8 case 6)

18 rows dated on or after 2026-09-04 are still pending — null `postedDate`
in the database. They should not be treated as settled.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 687 | 2026-09-04 | `BIG BAZAAR 6291` | ₹1,148.66 | Everyday Checking |
| 688 | 2026-09-04 | `TST* BARBEQUE NATION` | ₹1,119.58 | Sapphire Credit Card |
| 689 | 2026-09-04 | `INDIAN OIL 57480479` | ₹504.64 | Everyday Checking |
| 690 | 2026-09-04 | `PAYPAL *STEAMGAMES` | ₹1,427.18 | Sapphire Credit Card |
| 691 | 2026-09-04 | `PRACTO CONSULT` | ₹771.73 | Sapphire Credit Card |
| 692 | 2026-09-05 | `JIO FIBER BROADBAND` | ₹899.00 | Everyday Checking |
| 693 | 2026-09-05 | `RELIANCE FRESH #104` | ₹647.39 | Everyday Checking |
| 694 | 2026-09-05 | `TST* THE ADDA - INDIRANAGAR` | ₹659.19 | Sapphire Credit Card |
| 695 | 2026-09-05 | `UBER   *TRIP` | ₹108.66 | Everyday Checking |
| 696 | 2026-09-05 | `IRCTC ETICKET` | ₹1,322.72 | Sapphire Credit Card |
| 697 | 2026-09-06 | `APPLE.COM/BILL ICLOUD` | ₹75.00 | Sapphire Credit Card |
| 698 | 2026-09-06 | `THIRD WAVE COFFEE #1174` | ₹123.32 | Sapphire Credit Card |
| 699 | 2026-09-06 | `BIG BAZAAR 6216` | ₹509.02 | Everyday Checking |
| 700 | 2026-09-06 | `SWIGGY*THAI BASIL` | ₹226.14 | Sapphire Credit Card |
| 701 | 2026-09-06 | `OLA    *RIDE FRI` | ₹526.32 | Everyday Checking |
| 702 | 2026-09-06 | `IKEA HYDERABAD` | ₹2,855.71 | Sapphire Credit Card |
| 703 | 2026-09-07 | `IKEA HYDERABAD` | ₹1,577.71 | Sapphire Credit Card |
| 704 | 2026-09-07 | `APOLLO PHARMACY #02148` | ₹338.75 | Sapphire Credit Card |

## 7. Foreign transaction fees split from the purchase (§8 case 7)

Each foreign purchase is followed by its own 3% fee line on the same date. The fee
belongs in `FEES_INTEREST`, not in the purchase's category, but the two need to
stay associated.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 61 | 2026-03-15 | `BOOKING.COM AMSTERDAM NL` | ₹34,500.00 | Sapphire Credit Card | foreign purchase |
| 62 | 2026-03-15 | `FOREIGN TRANSACTION FEE` | ₹1,035.00 | Sapphire Credit Card | 3% fee |
| 201 | 2026-04-21 | `SNCF INTERNET PARIS FR` | ₹7,400.00 | Sapphire Credit Card | foreign purchase |
| 202 | 2026-04-21 | `FOREIGN TRANSACTION FEE` | ₹222.00 | Sapphire Credit Card | 3% fee |
| 277 | 2026-05-08 | `MUJI SHIBUYA TOKYO JP` | ₹5,400.00 | Sapphire Credit Card | foreign purchase |
| 278 | 2026-05-08 | `FOREIGN TRANSACTION FEE` | ₹162.00 | Sapphire Credit Card | 3% fee |
| 470 | 2026-06-27 | `EL CORTE INGLES MADRID ES` | ₹11,100.00 | Sapphire Credit Card | foreign purchase |
| 471 | 2026-06-27 | `FOREIGN TRANSACTION FEE` | ₹333.00 | Sapphire Credit Card | 3% fee |
| 501 | 2026-07-05 | `TESCO STORES 3411 LONDON UK` | ₹3,480.00 | Sapphire Credit Card | foreign purchase |
| 502 | 2026-07-05 | `FOREIGN TRANSACTION FEE` | ₹104.40 | Sapphire Credit Card | 3% fee |
| 641 | 2026-08-19 | `TRENITALIA ROMA IT` | ₹8,100.00 | Sapphire Credit Card | foreign purchase |
| 642 | 2026-08-19 | `FOREIGN TRANSACTION FEE` | ₹243.00 | Sapphire Credit Card | 3% fee |

## 8. Ambiguous, processor-mangled merchant strings (§8 case 8)

267 rows across 27 merchants carry a payment-processor prefix, a
gateway name, or a trailing store/order id that varies row to row. The
**normalizes to** column is what Phase 2's normalizer is expected to produce, and
what the LLM merchant cache is keyed on.

| Example raw descriptor | Normalizes to | Rows | First row |
| --- | --- | ---: | ---: |
| `PAYTM*BLUE TOKAI` | `BLUE TOKAI` | 26 | 36 |
| `PAYTM*CHAI POINT` | `CHAI POINT` | 25 | 11 |
| `SWIGGY*THAI BASIL` | `SWIGGY` | 25 | 68 |
| `TST* THE ADDA - INDIRANAGAR` | `THE ADDA` | 20 | 3 |
| `TST* BARBEQUE NATION` | `BARBEQUE NATION` | 16 | 121 |
| `UBER   *TRIP` | `UBER` | 14 | 9 |
| `DMRC*METRO RECHARGE` | `DMRC` | 14 | 94 |
| `OLA    *RIDE FRI` | `OLA` | 12 | 43 |
| `AMZN Mktp IN*7100385` | `AMAZON MARKETPLACE` | 12 | 108 |
| `PAYPAL *STEAMGAMES` | `STEAM` | 11 | 170 |
| `RAZ*MEESHO` | `MEESHO` | 10 | 75 |
| `SP * BATA` | `BATA` | 10 | 105 |
| `BOOKMYSHOW*EVENT` | `BOOKMYSHOW` | 9 | 19 |
| `WWW.PATREON.COM* SUPPORT` | `PATREON` | 9 | 76 |
| `RAZORPAY TRANSFER` | `RAZORPAY` | 8 | 24 |
| `DONATION*GOONJ` | `GOONJ` | 7 | 7 |
| `AMAZON PRIME*MEMBERSHIP` | `AMAZON PRIME` | 6 | 79 |
| `ZEE5*PREMIUM PLAN` | `ZEE5` | 6 | 92 |
| `GITHUB.COM*ACCOUNT` | `GITHUB` | 5 | 10 |
| `GPAY PAYMENT 1039485` | `GPAY` | 4 | 40 |
| `AIRBNB * HM4X6422` | `AIRBNB` | 4 | 53 |
| `PHONEPE*ARJUN M` | `PHONEPE` | 4 | 221 |
| `PAYTM WALLET TO SAM R` | `PAYTM WALLET` | 4 | 271 |
| `MAKEMYTRIP*ITIN 7341508` | `MAKEMYTRIP` | 3 | 113 |
| `PAYTM*SABZI MANDI STALL 12` | `SABZI MANDI STALL 12` | 1 | 148 |
| `RAZ*WWWSTORE` | `WWWSTORE` | 1 | 336 |
| `TST* CATERING CO` | `CATERING CO` | 1 | 530 |

## 9. Person-to-person payments that round-trip (§8 case 9)

Money sent to a friend and paid back days later. Neither leg is real spending;
counting the outgoing leg alone overstates the month.

| Row | Date | Description | Amount | Account | Direction |
| ---: | --- | --- | ---: | --- | --- |
| 40 | 2026-03-10 | `GPAY PAYMENT 1039485` | ₹1,500.00 | Everyday Checking | sent |
| 54 | 2026-03-13 | `GPAY REFUND 1039912` | -₹1,500.00 | Everyday Checking | paid back |
| 221 | 2026-04-24 | `PHONEPE*ARJUN M` | ₹800.00 | Everyday Checking | sent |
| 228 | 2026-04-26 | `PHONEPE*REFUND` | -₹800.00 | Everyday Checking | paid back |
| 271 | 2026-05-06 | `PAYTM WALLET TO SAM R` | ₹3,500.00 | Everyday Checking | sent |
| 287 | 2026-05-11 | `PAYTM WALLET FROM SAM R` | -₹3,500.00 | Everyday Checking | paid back |
| 438 | 2026-06-18 | `GPAY PAYMENT 1104773` | ₹2,200.00 | Everyday Checking | sent |
| 452 | 2026-06-22 | `GPAY REFUND 1105220` | -₹2,200.00 | Everyday Checking | paid back |
| 488 | 2026-07-02 | `PAYTM WALLET TO PRIYA N` | ₹6,000.00 | Everyday Checking | sent |
| 511 | 2026-07-08 | `PAYTM WALLET FROM PRIYA N` | -₹6,000.00 | Everyday Checking | paid back |
| 621 | 2026-08-13 | `PHONEPE*ALEX T` | ₹1,800.00 | Everyday Checking | sent |
| 630 | 2026-08-16 | `PHONEPE*REFUND` | -₹1,800.00 | Everyday Checking | paid back |

## 10. Large one-off purchases (§8 case 10)

Big enough to distort any category average they land in, but not anomalies —
anomaly detection must not simply flag "unusually large".

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 306 | 2026-05-16 | `CROMA RETAIL #R412` | ₹79,900.00 | Sapphire Credit Card |
| 508 | 2026-07-07 | `INDIGO AIRLINES 0062` | ₹24,500.00 | Sapphire Credit Card |

## 11. Irregular and variable income (§8 case 11)

Income arrives from three sources with different rhythms: a semi-monthly salary
that varies slightly, freelance payments that vary in both timing and size, and a
one-off bonus.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 24 | 2026-03-07 | `RAZORPAY TRANSFER FREELANCE` | -₹9,371.92 | Everyday Checking |
| 59 | 2026-03-15 | `INFOSYS LTD SALARY CREDIT` | -₹61,562.87 | Everyday Checking |
| 69 | 2026-03-18 | `RAZORPAY TRANSFER FREELANCE` | -₹20,772.51 | Everyday Checking |
| 109 | 2026-03-30 | `INFOSYS LTD SALARY CREDIT` | -₹61,072.25 | Everyday Checking |
| 134 | 2026-04-05 | `RAZORPAY TRANSFER FREELANCE` | -₹32,040.28 | Everyday Checking |
| 179 | 2026-04-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,119.55 | Everyday Checking |
| 195 | 2026-04-20 | `RAZORPAY TRANSFER FREELANCE` | -₹21,305.32 | Everyday Checking |
| 245 | 2026-04-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,822.36 | Everyday Checking |
| 300 | 2026-05-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,657.89 | Everyday Checking |
| 305 | 2026-05-16 | `RAZORPAY TRANSFER FREELANCE` | -₹28,660.20 | Everyday Checking |
| 366 | 2026-05-30 | `INFOSYS LTD SALARY CREDIT` | -₹58,323.53 | Everyday Checking |
| 413 | 2026-06-11 | `RAZORPAY TRANSFER FREELANCE` | -₹39,182.07 | Everyday Checking |
| 429 | 2026-06-15 | `INFOSYS LTD SALARY CREDIT` | -₹60,149.92 | Everyday Checking |
| 461 | 2026-06-25 | `RAZORPAY TRANSFER FREELANCE` | -₹40,192.85 | Everyday Checking |
| 480 | 2026-06-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,758.42 | Everyday Checking |
| 500 | 2026-07-05 | `RAZORPAY TRANSFER FREELANCE` | -₹28,012.50 | Everyday Checking |
| 529 | 2026-07-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,281.46 | Everyday Checking |
| 538 | 2026-07-18 | `INFOSYS LTD BONUS` | -₹75,000.00 | Everyday Checking |
| 575 | 2026-07-30 | `INFOSYS LTD SALARY CREDIT` | -₹61,127.93 | Everyday Checking |
| 627 | 2026-08-15 | `INFOSYS LTD SALARY CREDIT` | -₹61,187.81 | Everyday Checking |
| 671 | 2026-08-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,599.88 | Everyday Checking |

## 12. Manual corrections that must survive re-import (§8 case 12)

These rows are seeded already corrected — `source = MANUAL`, with the category a
human chose — and each one has a matching `Rule` with
`learnedFromOverride = true`. Re-importing the CSV or re-running the rule and LLM
passes must leave them alone.

| Row | Date | Description | Amount | Account | Corrected to |
| ---: | --- | --- | ---: | --- | --- |
| 148 | 2026-04-08 | `PAYTM*SABZI MANDI STALL 12` | ₹850.00 | Sapphire Credit Card | GROCERIES (a naive parser would guess otherwise) |
| 336 | 2026-05-22 | `RAZ*WWWSTORE` | ₹2,899.00 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
| 530 | 2026-07-15 | `TST* CATERING CO` | ₹6,400.00 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
