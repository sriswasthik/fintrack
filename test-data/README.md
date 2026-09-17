# Synthetic transaction dataset

`synthetic_transactions.csv` is a deliberately messy, six-month bank export for a
single fictional person with two accounts. It exists so every edge case in
[PROJECT_CONTEXT.md §8](../PROJECT_CONTEXT.md) has concrete rows to test against,
and so the dashboard has something realistic to render.

**Every row below is fictional.** No real person, account or card is involved.

## Files

| File | What it is |
| --- | --- |
| `synthetic_transactions.csv` | 731 rows in a generic bank-export shape: `date,description,amount,account` |
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
| Rows | 731 |
| Window | 2026-03-01 → 2026-09-07 (7 calendar months: 2026-03, 2026-04, 2026-05, 2026-06, 2026-07, 2026-08, 2026-09) |
| Accounts | Everyday Checking (258), Sapphire Credit Card (473) |
| Total spend | ₹12,48,851.08 (excludes INCOME and TRANSFER, per §5) |
| Total income | ₹10,18,201.52 |

Intended category mix (what a perfect categorizer would produce — the CSV itself
carries no category column):

| Category | Rows | Share |
| --- | ---: | ---: |
| DINING | 212 | 29.0% |
| TRANSPORTATION | 88 | 12.0% |
| SHOPPING | 82 | 11.2% |
| GROCERIES | 65 | 8.9% |
| ENTERTAINMENT | 44 | 6.0% |
| SUBSCRIPTIONS | 39 | 5.3% |
| TRAVEL | 25 | 3.4% |
| TRANSFER | 24 | 3.3% |
| HEALTH_FITNESS | 21 | 2.9% |
| INCOME | 21 | 2.9% |
| UTILITIES | 19 | 2.6% |
| BUSINESS | 16 | 2.2% |
| GIFTS_DONATIONS | 14 | 1.9% |
| INVESTMENTS | 13 | 1.8% |
| PERSONAL_CARE | 10 | 1.4% |
| EMI_LOAN | 9 | 1.2% |
| HOUSING | 7 | 1.0% |
| INSURANCE | 7 | 1.0% |
| REFUND | 6 | 0.8% |
| FEES_INTEREST | 6 | 0.8% |
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
| 89 | 2026-03-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹41,714.36 | Everyday Checking | out of checking |
| 90 | 2026-03-22 | `PAYMENT THANK YOU - MOBILE` | -₹41,714.36 | Sapphire Credit Card | onto the card |
| 212 | 2026-04-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹32,982.26 | Everyday Checking | out of checking |
| 213 | 2026-04-22 | `PAYMENT THANK YOU - MOBILE` | -₹32,982.26 | Sapphire Credit Card | onto the card |
| 344 | 2026-05-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹40,706.02 | Everyday Checking | out of checking |
| 345 | 2026-05-22 | `PAYMENT THANK YOU - MOBILE` | -₹40,706.02 | Sapphire Credit Card | onto the card |
| 463 | 2026-06-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹26,027.84 | Everyday Checking | out of checking |
| 464 | 2026-06-22 | `PAYMENT THANK YOU - MOBILE` | -₹26,027.84 | Sapphire Credit Card | onto the card |
| 564 | 2026-07-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹26,830.18 | Everyday Checking | out of checking |
| 565 | 2026-07-22 | `PAYMENT THANK YOU - MOBILE` | -₹26,830.18 | Sapphire Credit Card | onto the card |
| 667 | 2026-08-22 | `ONLINE PAYMENT TO HDFC CARD ...4021` | ₹34,738.37 | Everyday Checking | out of checking |
| 668 | 2026-08-22 | `PAYMENT THANK YOU - MOBILE` | -₹34,738.37 | Sapphire Credit Card | onto the card |

Person-to-person round trips are also transfers — see case 9.

## 2. Refunds matched back to the originating purchase (§8 case 2)

Each pair is the same merchant and the exact same amount, `6–13` days apart. The
refund should net against the original purchase's category in aggregates while
still being stored as `REFUND`.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 22 | 2026-03-06 | `MYNTRA #482` | ₹2,899.00 | Sapphire Credit Card | original purchase |
| 63 | 2026-03-15 | `MYNTRA #482 REFUND` | -₹2,899.00 | Sapphire Credit Card | refund |
| 166 | 2026-04-11 | `NIKE.COM` | ₹4,599.00 | Sapphire Credit Card | original purchase |
| 219 | 2026-04-23 | `NIKE.COM REFUND` | -₹4,599.00 | Sapphire Credit Card | refund |
| 329 | 2026-05-19 | `CROMA #1120` | ₹8,999.00 | Sapphire Credit Card | original purchase |
| 365 | 2026-05-26 | `CROMA #1120 REFUND` | -₹8,999.00 | Sapphire Credit Card | refund |
| 395 | 2026-06-04 | `DECATHLON.COM ONLINE` | ₹5,499.00 | Sapphire Credit Card | original purchase |
| 447 | 2026-06-17 | `DECATHLON.COM ONLINE REFUND` | -₹5,499.00 | Sapphire Credit Card | refund |
| 541 | 2026-07-13 | `AMZN Mktp IN*RT4G21` | ₹1,899.00 | Sapphire Credit Card | original purchase |
| 558 | 2026-07-19 | `AMZN Mktp IN*RT4G21 REFUND` | -₹1,899.00 | Sapphire Credit Card | refund |
| 628 | 2026-08-08 | `PEPPERFRY.COM ORDER` | ₹9,499.00 | Sapphire Credit Card | original purchase |
| 660 | 2026-08-19 | `PEPPERFRY.COM ORDER REFUND` | -₹9,499.00 | Sapphire Credit Card | refund |

## 3. Split-worthy purchases (§8 case 3)

Single charges that really span several categories. The CSV has one row each; the
intended breakdown is listed so Phase 3 can assert against it.

| Row | Date | Description | Amount | Account | Intended split |
| ---: | --- | --- | ---: | --- | --- |
| 37 | 2026-03-09 | `FLIPKART 0002341` | ₹2,895.00 | Sapphire Credit Card | GROCERIES ₹1,490.00<br>PERSONAL_CARE ₹635.00<br>SHOPPING ₹770.00 |
| 193 | 2026-04-17 | `RELIANCE SMART #2201` | ₹2,930.00 | Sapphire Credit Card | GROCERIES ₹2,045.00<br>SHOPPING ₹885.00 |
| 359 | 2026-05-25 | `METRO CASH CARRY #1188` | ₹5,270.00 | Sapphire Credit Card | GROCERIES ₹3,310.00<br>HEALTH_FITNESS ₹1,055.00<br>SHOPPING ₹905.00 |
| 431 | 2026-06-12 | `AMZN Mktp IN*8H2K1LM` | ₹2,405.00 | Sapphire Credit Card | SHOPPING ₹1,605.00<br>BUSINESS ₹800.00 |
| 559 | 2026-07-20 | `SPENCERS HYPER #331` | ₹2,750.00 | Sapphire Credit Card | GROCERIES ₹1,865.00<br>TRANSPORTATION ₹885.00 |
| 610 | 2026-08-03 | `IKEA HYDERABAD #442` | ₹4,415.00 | Sapphire Credit Card | SHOPPING ₹4,130.00<br>DINING ₹285.00 |

## 4. Recurring subscriptions, including a price change (§8 case 4)

7 distinct subscriptions bill monthly. Two are special:

* **NETFLIX** rises from ₹499.00 to ₹649.00 partway through — a price hike Phase 6
  must flag (rows 69, 192, 322, 446, 553, 654).
* **DISNEY PLUS** only starts partway through the window — a *new* recurring
  charge, not a one-off (rows 544, 645).

| Subscription | Charges | Rows | Amounts |
| --- | ---: | --- | --- |
| ADOBE | 6 | 103, 241, 369, 483, 583, 685 | ₹699.00 |
| AMAZON PRIME | 6 | 83, 207, 340, 459, 561, 664 | ₹299.00 |
| APPLE ICLOUD | 7 | 21, 144, 278, 403, 522, 619, 723 | ₹75.00 |
| HOTSTAR | 2 | 544, 645 | ₹299.00 |
| NETFLIX | 6 | 69, 192, 322, 446, 553, 654 | ₹499.00, ₹649.00 |
| SPOTIFY | 6 | 36, 159, 290, 416, 531, 632 | ₹119.00 |
| ZEE5 | 6 | 96, 227, 356, 472, 573, 677 | ₹99.00 |

## 5. Duplicates from a sync glitch — and legitimate repeats (§8 case 5)

The hard part is telling these two groups apart. **Both** groups contain rows with
an identical merchant, amount and date.

### Sync-glitch duplicates — should be flagged

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 26 | 2026-03-07 | `DMART #14027` | ₹1,284.00 | Sapphire Credit Card | the real one |
| 27 | 2026-03-07 | `DMART #14027` | ₹1,284.00 | Sapphire Credit Card | the glitch copy |
| 180 | 2026-04-14 | `INDIAN OIL 574812` | ₹1,250.00 | Sapphire Credit Card | the real one |
| 181 | 2026-04-14 | `INDIAN OIL 574812` | ₹1,250.00 | Sapphire Credit Card | the glitch copy |
| 350 | 2026-05-23 | `TST* BARBEQUE NATION` | ₹1,899.00 | Sapphire Credit Card | the real one |
| 351 | 2026-05-23 | `TST* BARBEQUE NATION` | ₹1,899.00 | Sapphire Credit Card | the glitch copy |
| 419 | 2026-06-10 | `AMZN Mktp IN*QQ91ZP` | ₹649.00 | Sapphire Credit Card | the real one |
| 420 | 2026-06-10 | `AMZN Mktp IN*QQ91ZP` | ₹649.00 | Sapphire Credit Card | the glitch copy |
| 549 | 2026-07-16 | `RELIANCE FRESH #104` | ₹2,374.00 | Sapphire Credit Card | the real one |
| 550 | 2026-07-16 | `RELIANCE FRESH #104` | ₹2,374.00 | Sapphire Credit Card | the glitch copy |
| 605 | 2026-08-02 | `UBER   *TRIP` | ₹289.00 | Sapphire Credit Card | the real one |
| 606 | 2026-08-02 | `UBER   *TRIP` | ₹289.00 | Sapphire Credit Card | the glitch copy |

### Legitimate repeats — must NOT be flagged

Two coffees on the same day at the same price. A dedupe rule that keys only on
(merchant, amount, date) will produce a false positive on every one of these.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 15 | 2026-03-05 | `PAYTM*CHAI POINT` | ₹150.00 | Sapphire Credit Card |
| 16 | 2026-03-05 | `PAYTM*CHAI POINT` | ₹150.00 | Sapphire Credit Card |
| 195 | 2026-04-18 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 196 | 2026-04-18 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 426 | 2026-06-11 | `PAYTM*CHAI POINT` | ₹160.00 | Sapphire Credit Card |
| 427 | 2026-06-11 | `PAYTM*CHAI POINT` | ₹160.00 | Sapphire Credit Card |
| 579 | 2026-07-26 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |
| 580 | 2026-07-26 | `PAYTM*CHAI POINT` | ₹130.00 | Sapphire Credit Card |

## 6. Pending vs. posted transactions (§8 case 6)

22 rows dated on or after 2026-09-04 are still pending — null `postedDate`
in the database. They should not be treated as settled.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 710 | 2026-09-04 | `BIG BAZAAR 6291` | ₹1,148.66 | Everyday Checking |
| 711 | 2026-09-04 | `TST* BARBEQUE NATION` | ₹1,119.58 | Sapphire Credit Card |
| 712 | 2026-09-04 | `INDIAN OIL 57480479` | ₹504.64 | Everyday Checking |
| 713 | 2026-09-04 | `PAYPAL *STEAMGAMES` | ₹1,427.18 | Sapphire Credit Card |
| 714 | 2026-09-04 | `PRACTO CONSULT` | ₹771.73 | Sapphire Credit Card |
| 715 | 2026-09-04 | `FERNS N PETALS.COM` | ₹3,900.00 | Sapphire Credit Card |
| 716 | 2026-09-05 | `JIO FIBER BROADBAND` | ₹899.00 | Everyday Checking |
| 717 | 2026-09-05 | `RELIANCE FRESH #104` | ₹647.39 | Everyday Checking |
| 718 | 2026-09-05 | `TST* THE ADDA - INDIRANAGAR` | ₹659.19 | Sapphire Credit Card |
| 719 | 2026-09-05 | `UBER   *TRIP` | ₹108.66 | Everyday Checking |
| 720 | 2026-09-05 | `IRCTC ETICKET` | ₹1,322.72 | Sapphire Credit Card |
| 721 | 2026-09-05 | `BAJAJ FINANCE EMI 4471902` | ₹18,450.00 | Everyday Checking |
| 722 | 2026-09-05 | `DONATION*GOONJ` | ₹3,900.00 | Sapphire Credit Card |
| 723 | 2026-09-06 | `APPLE.COM/BILL ICLOUD` | ₹75.00 | Sapphire Credit Card |
| 724 | 2026-09-06 | `THIRD WAVE COFFEE #1174` | ₹123.32 | Sapphire Credit Card |
| 725 | 2026-09-06 | `BIG BAZAAR 6216` | ₹509.02 | Everyday Checking |
| 726 | 2026-09-06 | `SWIGGY*THAI BASIL` | ₹226.14 | Sapphire Credit Card |
| 727 | 2026-09-06 | `OLA    *RIDE FRI` | ₹526.32 | Everyday Checking |
| 728 | 2026-09-06 | `IKEA HYDERABAD` | ₹2,855.71 | Sapphire Credit Card |
| 729 | 2026-09-07 | `IKEA HYDERABAD` | ₹1,577.71 | Sapphire Credit Card |
| 730 | 2026-09-07 | `APOLLO PHARMACY #02148` | ₹338.75 | Sapphire Credit Card |
| 731 | 2026-09-07 | `ZERODHA COIN SIP` | ₹5,000.00 | Everyday Checking |

## 7. Foreign transaction fees split from the purchase (§8 case 7)

Each foreign purchase is followed by its own 3% fee line on the same date. The fee
belongs in `FEES_INTEREST`, not in the purchase's category, but the two need to
stay associated.

| Row | Date | Description | Amount | Account | Role |
| ---: | --- | --- | ---: | --- | --- |
| 64 | 2026-03-15 | `BOOKING.COM AMSTERDAM NL` | ₹34,500.00 | Sapphire Credit Card | foreign purchase |
| 65 | 2026-03-15 | `FOREIGN TRANSACTION FEE` | ₹1,035.00 | Sapphire Credit Card | 3% fee |
| 208 | 2026-04-21 | `SNCF INTERNET PARIS FR` | ₹7,400.00 | Sapphire Credit Card | foreign purchase |
| 209 | 2026-04-21 | `FOREIGN TRANSACTION FEE` | ₹222.00 | Sapphire Credit Card | 3% fee |
| 286 | 2026-05-08 | `MUJI SHIBUYA TOKYO JP` | ₹5,400.00 | Sapphire Credit Card | foreign purchase |
| 287 | 2026-05-08 | `FOREIGN TRANSACTION FEE` | ₹162.00 | Sapphire Credit Card | 3% fee |
| 484 | 2026-06-27 | `EL CORTE INGLES MADRID ES` | ₹11,100.00 | Sapphire Credit Card | foreign purchase |
| 485 | 2026-06-27 | `FOREIGN TRANSACTION FEE` | ₹333.00 | Sapphire Credit Card | 3% fee |
| 515 | 2026-07-05 | `TESCO STORES 3411 LONDON UK` | ₹3,480.00 | Sapphire Credit Card | foreign purchase |
| 516 | 2026-07-05 | `FOREIGN TRANSACTION FEE` | ₹104.40 | Sapphire Credit Card | 3% fee |
| 661 | 2026-08-19 | `TRENITALIA ROMA IT` | ₹8,100.00 | Sapphire Credit Card | foreign purchase |
| 662 | 2026-08-19 | `FOREIGN TRANSACTION FEE` | ₹243.00 | Sapphire Credit Card | 3% fee |

## 8. Ambiguous, processor-mangled merchant strings (§8 case 8)

267 rows across 27 merchants carry a payment-processor prefix, a
gateway name, or a trailing store/order id that varies row to row. The
**normalizes to** column is what Phase 2's normalizer is expected to produce, and
what the LLM merchant cache is keyed on.

| Example raw descriptor | Normalizes to | Rows | First row |
| --- | --- | ---: | ---: |
| `PAYTM*BLUE TOKAI` | `BLUE TOKAI` | 26 | 38 |
| `PAYTM*CHAI POINT` | `CHAI POINT` | 25 | 11 |
| `SWIGGY*THAI BASIL` | `SWIGGY` | 25 | 71 |
| `TST* THE ADDA - INDIRANAGAR` | `THE ADDA` | 20 | 3 |
| `TST* BARBEQUE NATION` | `BARBEQUE NATION` | 16 | 125 |
| `UBER   *TRIP` | `UBER` | 14 | 9 |
| `DMRC*METRO RECHARGE` | `DMRC` | 14 | 98 |
| `OLA    *RIDE FRI` | `OLA` | 12 | 45 |
| `AMZN Mktp IN*7100385` | `AMAZON MARKETPLACE` | 12 | 112 |
| `PAYPAL *STEAMGAMES` | `STEAM` | 11 | 176 |
| `RAZ*MEESHO` | `MEESHO` | 10 | 78 |
| `SP * BATA` | `BATA` | 10 | 109 |
| `BOOKMYSHOW*EVENT` | `BOOKMYSHOW` | 9 | 19 |
| `WWW.PATREON.COM* SUPPORT` | `PATREON` | 9 | 79 |
| `RAZORPAY TRANSFER` | `RAZORPAY` | 8 | 25 |
| `DONATION*GOONJ` | `GOONJ` | 7 | 7 |
| `AMAZON PRIME*MEMBERSHIP` | `AMAZON PRIME` | 6 | 83 |
| `ZEE5*PREMIUM PLAN` | `ZEE5` | 6 | 96 |
| `GITHUB.COM*ACCOUNT` | `GITHUB` | 5 | 10 |
| `GPAY PAYMENT 1039485` | `GPAY` | 4 | 42 |
| `AIRBNB * HM4X6422` | `AIRBNB` | 4 | 55 |
| `PHONEPE*ARJUN M` | `PHONEPE` | 4 | 228 |
| `PAYTM WALLET TO SAM R` | `PAYTM WALLET` | 4 | 279 |
| `MAKEMYTRIP*ITIN 7341508` | `MAKEMYTRIP` | 3 | 117 |
| `PAYTM*SABZI MANDI STALL 12` | `SABZI MANDI STALL 12` | 1 | 154 |
| `RAZ*WWWSTORE` | `WWWSTORE` | 1 | 346 |
| `TST* CATERING CO` | `CATERING CO` | 1 | 547 |

## 9. Person-to-person payments that round-trip (§8 case 9)

Money sent to a friend and paid back days later. Neither leg is real spending;
counting the outgoing leg alone overstates the month.

| Row | Date | Description | Amount | Account | Direction |
| ---: | --- | --- | ---: | --- | --- |
| 42 | 2026-03-10 | `GPAY PAYMENT 1039485` | ₹1,500.00 | Everyday Checking | sent |
| 57 | 2026-03-13 | `GPAY REFUND 1039912` | -₹1,500.00 | Everyday Checking | paid back |
| 228 | 2026-04-24 | `PHONEPE*ARJUN M` | ₹800.00 | Everyday Checking | sent |
| 235 | 2026-04-26 | `PHONEPE*REFUND` | -₹800.00 | Everyday Checking | paid back |
| 279 | 2026-05-06 | `PAYTM WALLET TO SAM R` | ₹3,500.00 | Everyday Checking | sent |
| 296 | 2026-05-11 | `PAYTM WALLET FROM SAM R` | -₹3,500.00 | Everyday Checking | paid back |
| 451 | 2026-06-18 | `GPAY PAYMENT 1104773` | ₹2,200.00 | Everyday Checking | sent |
| 465 | 2026-06-22 | `GPAY REFUND 1105220` | -₹2,200.00 | Everyday Checking | paid back |
| 502 | 2026-07-02 | `PAYTM WALLET TO PRIYA N` | ₹6,000.00 | Everyday Checking | sent |
| 527 | 2026-07-08 | `PAYTM WALLET FROM PRIYA N` | -₹6,000.00 | Everyday Checking | paid back |
| 641 | 2026-08-13 | `PHONEPE*ALEX T` | ₹1,800.00 | Everyday Checking | sent |
| 650 | 2026-08-16 | `PHONEPE*REFUND` | -₹1,800.00 | Everyday Checking | paid back |

## 10. Large one-off purchases (§8 case 10)

Big enough to distort any category average they land in, but not anomalies —
anomaly detection must not simply flag "unusually large".

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 316 | 2026-05-16 | `CROMA RETAIL #R412` | ₹79,900.00 | Sapphire Credit Card |
| 523 | 2026-07-07 | `INDIGO AIRLINES 0062` | ₹24,500.00 | Sapphire Credit Card |

## 11. Irregular and variable income (§8 case 11)

Income arrives from three sources with different rhythms: a semi-monthly salary
that varies slightly, freelance payments that vary in both timing and size, and a
one-off bonus.

| Row | Date | Description | Amount | Account |
| ---: | --- | --- | ---: | --- |
| 25 | 2026-03-07 | `RAZORPAY TRANSFER FREELANCE` | -₹9,371.92 | Everyday Checking |
| 62 | 2026-03-15 | `INFOSYS LTD SALARY CREDIT` | -₹61,562.87 | Everyday Checking |
| 72 | 2026-03-18 | `RAZORPAY TRANSFER FREELANCE` | -₹20,772.51 | Everyday Checking |
| 113 | 2026-03-30 | `INFOSYS LTD SALARY CREDIT` | -₹61,072.25 | Everyday Checking |
| 138 | 2026-04-05 | `RAZORPAY TRANSFER FREELANCE` | -₹32,040.28 | Everyday Checking |
| 186 | 2026-04-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,119.55 | Everyday Checking |
| 202 | 2026-04-20 | `RAZORPAY TRANSFER FREELANCE` | -₹21,305.32 | Everyday Checking |
| 252 | 2026-04-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,822.36 | Everyday Checking |
| 310 | 2026-05-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,657.89 | Everyday Checking |
| 315 | 2026-05-16 | `RAZORPAY TRANSFER FREELANCE` | -₹28,660.20 | Everyday Checking |
| 376 | 2026-05-30 | `INFOSYS LTD SALARY CREDIT` | -₹58,323.53 | Everyday Checking |
| 425 | 2026-06-11 | `RAZORPAY TRANSFER FREELANCE` | -₹39,182.07 | Everyday Checking |
| 442 | 2026-06-15 | `INFOSYS LTD SALARY CREDIT` | -₹60,149.92 | Everyday Checking |
| 475 | 2026-06-25 | `RAZORPAY TRANSFER FREELANCE` | -₹40,192.85 | Everyday Checking |
| 494 | 2026-06-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,758.42 | Everyday Checking |
| 514 | 2026-07-05 | `RAZORPAY TRANSFER FREELANCE` | -₹28,012.50 | Everyday Checking |
| 546 | 2026-07-15 | `INFOSYS LTD SALARY CREDIT` | -₹59,281.46 | Everyday Checking |
| 555 | 2026-07-18 | `INFOSYS LTD BONUS` | -₹75,000.00 | Everyday Checking |
| 592 | 2026-07-30 | `INFOSYS LTD SALARY CREDIT` | -₹61,127.93 | Everyday Checking |
| 647 | 2026-08-15 | `INFOSYS LTD SALARY CREDIT` | -₹61,187.81 | Everyday Checking |
| 691 | 2026-08-30 | `INFOSYS LTD SALARY CREDIT` | -₹60,599.88 | Everyday Checking |

## 12. Manual corrections that must survive re-import (§8 case 12)

These rows are seeded already corrected — `source = MANUAL`, with the category a
human chose — and each one has a matching `Rule` with
`learnedFromOverride = true`. Re-importing the CSV or re-running the rule and LLM
passes must leave them alone.

| Row | Date | Description | Amount | Account | Corrected to |
| ---: | --- | --- | ---: | --- | --- |
| 154 | 2026-04-08 | `PAYTM*SABZI MANDI STALL 12` | ₹850.00 | Sapphire Credit Card | GROCERIES (a naive parser would guess otherwise) |
| 346 | 2026-05-22 | `RAZ*WWWSTORE` | ₹2,899.00 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
| 547 | 2026-07-15 | `TST* CATERING CO` | ₹6,400.00 | Sapphire Credit Card | BUSINESS (a naive parser would guess otherwise) |
