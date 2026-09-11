/**
 * A hand-labeled set of merchant strings for measuring categorization accuracy.
 *
 * Every entry is drawn from the Phase 1 synthetic dataset and its edge cases
 * (PROJECT_CONTEXT.md §8 case 8), with the label taken from that dataset's own
 * ground truth. The set is deliberately weighted towards the merchants the
 * Phase 3 rule engine could *not* resolve, because those are exactly the ones
 * the LLM fallback exists to handle — measuring it on merchants a keyword list
 * already gets right would flatter it.
 *
 * `difficulty` is a note for reading the results, not an input to scoring, and
 * it describes what the rule engine does *now* rather than what it did when the
 * case was written. `apply.test.ts` checks both labels against the live rule
 * set in both directions, so a rule that starts or stops covering a merchant
 * fails a test instead of leaving the label quietly wrong:
 *   * `unresolved` — the rule engine leaves these for the model. The real test.
 *   * `control`    — a rule already handles these; the model should agree.
 *   * `abstain`    — genuinely ambiguous. UNCATEGORIZED is an acceptable answer
 *                    here, and a confident wrong guess is the failure mode.
 */
import type { Category } from '../../generated/prisma/enums';

export interface EvalCase {
  merchant: string;
  expected: Category;
  difficulty: 'unresolved' | 'control' | 'abstain';
  note: string;
}

export const EVAL_SET: EvalCase[] = [
  // --- The nine the Phase 3 rule engine could not resolve ----------------
  {
    merchant: 'BLUEBIRD BAKERY',
    expected: 'DINING',
    difficulty: 'control',
    note: 'Phase 8 added the BAKERY keyword',
  },
  {
    merchant: 'THE HALL',
    expected: 'DINING',
    difficulty: 'unresolved',
    note: 'Food hall; name gives nothing away',
  },
  {
    merchant: 'RAMEN TATSU-YA',
    expected: 'DINING',
    difficulty: 'control',
    note: 'Phase 8 added the RAMEN keyword',
  },
  {
    merchant: 'ALLBIRDS',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'Direct-to-consumer shoe brand',
  },
  { merchant: 'TESCO', expected: 'GROCERIES', difficulty: 'control', note: 'UK supermarket; Phase 8 added it as a brand' },
  {
    merchant: 'MUJI',
    expected: 'SHOPPING',
    difficulty: 'control',
    note: 'Japanese homeware retailer; a brand rule since Phase 8',
  },
  {
    merchant: 'EL CORTE INGLES',
    expected: 'SHOPPING',
    difficulty: 'control',
    note: 'Spanish department store; a brand rule since Phase 8',
  },
  {
    merchant: 'SNCF',
    expected: 'TRAVEL',
    difficulty: 'control',
    note: 'French railway; a brand rule since Phase 8',
  },
  { merchant: 'TRENITALIA', expected: 'TRAVEL', difficulty: 'control', note: 'Italian railway; a brand rule since Phase 8' },

  // --- More long-tail merchants of the same shape ------------------------
  {
    merchant: 'JOES COFFEE',
    expected: 'DINING',
    difficulty: 'control',
    note: 'Keyword COFFEE also catches this',
  },
  {
    merchant: 'PEETS COFFEE',
    expected: 'DINING',
    difficulty: 'control',
    note: 'National coffee chain',
  },
  { merchant: 'DELTA AIR LINES', expected: 'TRAVEL', difficulty: 'unresolved', note: 'Airline' },
  {
    merchant: 'PLANET FITNESS',
    expected: 'HEALTH_FITNESS',
    difficulty: 'control',
    note: 'Gym chain',
  },
  { merchant: 'OAKWOOD PROPERTY MGMT', expected: 'HOUSING', difficulty: 'control', note: 'Rent' },
  {
    merchant: 'LEMONADE INSURANCE',
    expected: 'INSURANCE',
    difficulty: 'control',
    note: 'Renters insurance',
  },
  {
    merchant: 'NORTHWIND LABS',
    expected: 'INCOME',
    difficulty: 'unresolved',
    note: 'Employer; salary deposits',
  },
  {
    merchant: 'FOREIGN TRANSACTION FEE',
    expected: 'FEES_INTEREST',
    difficulty: 'control',
    note: 'Bank fee line',
  },
  {
    merchant: 'CHASE CARD PAYMENT',
    expected: 'TRANSFER',
    difficulty: 'control',
    note: 'Card payment; must not read as spending',
  },
  {
    merchant: 'VENMO',
    expected: 'TRANSFER',
    difficulty: 'unresolved',
    note: 'P2P network, not real spend (§8 case 9)',
  },
  { merchant: 'ZELLE', expected: 'TRANSFER', difficulty: 'unresolved', note: 'P2P network' },
  {
    merchant: 'AMAZON MARKETPLACE',
    expected: 'SHOPPING',
    difficulty: 'control',
    note: 'Normalized from AMZN Mktp US*<id>',
  },
  {
    merchant: 'STEAM',
    expected: 'ENTERTAINMENT',
    difficulty: 'control',
    note: 'Normalized from PAYPAL *STEAMGAMES',
  },
  {
    merchant: 'NEW YORK TIMES',
    expected: 'SUBSCRIPTIONS',
    difficulty: 'unresolved',
    note: 'Recurring digital subscription',
  },
  { merchant: 'PGE', expected: 'UTILITIES', difficulty: 'unresolved', note: 'Utility, as an acronym' },
  {
    merchant: 'USPS',
    expected: 'BUSINESS',
    difficulty: 'unresolved',
    note: 'Postage; business expense in this dataset',
  },

  // --- Indian long tail: local businesses no brand list will hold --------
  // The shape of an Indian statement's unresolved rows. None of these is a
  // national brand, so none of them is a rule the set could reasonably carry —
  // but each one names what it sells clearly enough for a reader who knows the
  // country, which is exactly what the Phase 14 prompt asks the model to be.
  {
    merchant: 'SHREE GANESH KIRANA STORES',
    expected: 'GROCERIES',
    difficulty: 'unresolved',
    note: 'Neighbourhood kirana; "kirana" is the giveaway',
  },
  {
    merchant: 'ANNAPURNA MESS',
    expected: 'DINING',
    difficulty: 'unresolved',
    note: 'A mess serves meals; the word is regional',
  },
  {
    merchant: 'SRI VENKATESHWARA MEDICALS',
    expected: 'PERSONAL_CARE',
    difficulty: 'unresolved',
    note: 'A "medicals" is a pharmacy; the keyword needs the singular',
  },
  {
    merchant: 'KALYAN JEWELLERS',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'Jewellery chain, not a category the rules cover',
  },
  {
    merchant: 'VASANTH AND CO',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'South Indian electronics chain; the name says nothing',
  },
  {
    merchant: 'SRI LAKSHMI TIFFIN CENTRE',
    expected: 'DINING',
    difficulty: 'control',
    note: 'Keyword TIFFIN also catches this',
  },
  {
    merchant: 'HP GAS GRAMIN VITRAK',
    expected: 'UTILITIES',
    difficulty: 'control',
    note: 'An LPG distributor; Phase 14 added the HP GAS brand',
  },
  {
    merchant: 'JAI BHAVANI AUTO SERVICES',
    expected: 'TRANSPORTATION',
    difficulty: 'unresolved',
    note: 'Vehicle servicing; reads like a business-services name',
  },
  {
    merchant: 'BALAJI XEROX AND STATIONERY',
    expected: 'BUSINESS',
    difficulty: 'unresolved',
    note: 'Print shop; SHOPPING is defensible',
  },

  // --- Indian names that shadow another category ------------------------
  // The reason the prompt names the country. Each of these has a plausible
  // non-Indian reading, or two Indian readings under one group name.
  {
    merchant: 'LIC HFL',
    expected: 'EMI_LOAN',
    difficulty: 'control',
    note: 'Housing finance, not the insurer; disambiguator rule',
  },
  {
    merchant: 'ICICI PRUDENTIAL LIFE',
    expected: 'INSURANCE',
    difficulty: 'control',
    note: 'The life arm, not the asset manager',
  },
  {
    merchant: 'SWIGGY INSTAMART',
    expected: 'GROCERIES',
    difficulty: 'control',
    note: 'The weekly shop, not dinner',
  },
  {
    merchant: 'TSSPDCL',
    expected: 'UTILITIES',
    difficulty: 'control',
    note: 'Telangana discom; Phase 14 added the acronym',
  },
  {
    merchant: 'MAHANAGAR GAS',
    expected: 'UTILITIES',
    difficulty: 'control',
    note: 'Piped city gas in Mumbai',
  },
  {
    merchant: 'GROWW',
    expected: 'INVESTMENTS',
    difficulty: 'control',
    note: 'Broker; a new category this phase',
  },
  {
    merchant: 'BAJAJ FINSERV EMI',
    expected: 'EMI_LOAN',
    difficulty: 'control',
    note: 'NBFC instalment',
  },
  {
    merchant: 'ATM WDL',
    expected: 'CASH_WITHDRAWAL',
    difficulty: 'control',
    note: 'Cash out; must not be read as an ATM fee',
  },

  // --- UPI strings: a person on the other end ---------------------------
  // A UPI narration names whoever was paid, and most of the time that is a
  // human being. There is no honest category for "money to Ramesh" — the
  // failure mode being measured here is the model inventing one.
  {
    merchant: 'RAMESH KUMAR',
    expected: 'UNCATEGORIZED',
    difficulty: 'abstain',
    note: 'A person. Nothing says what the money was for',
  },
  {
    merchant: '9876543210',
    expected: 'UNCATEGORIZED',
    difficulty: 'abstain',
    note: 'A UPI handle that is a bare mobile number',
  },
  {
    merchant: 'Q629384756',
    expected: 'UNCATEGORIZED',
    difficulty: 'abstain',
    note: 'An opaque merchant id from a QR code',
  },
  {
    merchant: 'PAYTMQR2810',
    expected: 'UNCATEGORIZED',
    difficulty: 'abstain',
    note: 'A Paytm QR terminal; the shop behind it is not in the string',
  },

  // --- Genuinely ambiguous: abstaining is the right answer ---------------
  {
    merchant: 'WWWSTORE',
    expected: 'UNCATEGORIZED',
    difficulty: 'abstain',
    note: 'From PAYPAL *WWWSTORE; tells you nothing',
  },
  {
    merchant: 'CATERING CO',
    expected: 'BUSINESS',
    difficulty: 'abstain',
    note: 'DINING is defensible; the user corrected it to BUSINESS',
  },
  {
    merchant: 'FARMERS MKT STALL 12',
    expected: 'GROCERIES',
    difficulty: 'abstain',
    note: 'Reads like DINING; the user corrected it to GROCERIES',
  },
];

/** Merchants the Phase 3 rule engine leaves for the model. */
export const UNRESOLVED_CASES = EVAL_SET.filter((c) => c.difficulty === 'unresolved');
