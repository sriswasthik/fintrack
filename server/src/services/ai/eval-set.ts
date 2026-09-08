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
 * `difficulty` is a note for reading the results, not an input to scoring:
 *   * `unresolved` — the rule engine left these for the model. The real test.
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
    difficulty: 'unresolved',
    note: 'Local bakery; no keyword match',
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
    difficulty: 'unresolved',
    note: 'Restaurant; cuisine word is the only clue',
  },
  {
    merchant: 'ALLBIRDS',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'Direct-to-consumer shoe brand',
  },
  { merchant: 'TESCO', expected: 'GROCERIES', difficulty: 'unresolved', note: 'UK supermarket' },
  {
    merchant: 'MUJI',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'Japanese homeware retailer',
  },
  {
    merchant: 'EL CORTE INGLES',
    expected: 'SHOPPING',
    difficulty: 'unresolved',
    note: 'Spanish department store',
  },
  {
    merchant: 'SNCF',
    expected: 'TRAVEL',
    difficulty: 'unresolved',
    note: 'French railway; an acronym',
  },
  { merchant: 'TRENITALIA', expected: 'TRAVEL', difficulty: 'unresolved', note: 'Italian railway' },

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
  { merchant: 'DELTA AIR LINES', expected: 'TRAVEL', difficulty: 'control', note: 'Airline' },
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
    difficulty: 'control',
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
    difficulty: 'control',
    note: 'P2P network, not real spend (§8 case 9)',
  },
  { merchant: 'ZELLE', expected: 'TRANSFER', difficulty: 'control', note: 'P2P network' },
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
    difficulty: 'control',
    note: 'Recurring digital subscription',
  },
  { merchant: 'PGE', expected: 'UTILITIES', difficulty: 'control', note: 'Utility, as an acronym' },
  {
    merchant: 'USPS',
    expected: 'BUSINESS',
    difficulty: 'control',
    note: 'Postage; business expense in this dataset',
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
