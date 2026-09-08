/**
 * The built-in categorization rules.
 *
 * These are seeded into the `Rule` table with a null `userId`, which makes them
 * apply to everyone and lets a user's own learned rules sit above them by
 * priority. Keeping them in code as well gives the seed and the re-apply script
 * a single source of truth.
 *
 * Two kinds of rule live here:
 *
 *   * **Keyword rules** (priority 200) — a word that reliably implies a
 *     category wherever it appears: COFFEE, PHARMACY, AIRLINES. These are the
 *     rules that generalise beyond any merchant list.
 *   * **Brand rules** (priority 300) — named national merchants. Cheap,
 *     deterministic, and free of an LLM call.
 *
 * Deliberately *not* here: local and ambiguous merchants. A neighbourhood
 * restaurant, a processor string like `WWWSTORE`, or a market stall cannot be
 * resolved by a keyword list without guessing, and PROJECT_CONTEXT.md §7 is
 * explicit that nothing is ever guessed silently. Those fall through to
 * UNCATEGORIZED and are what the Phase 4 LLM fallback exists to handle.
 *
 * Patterns are case-insensitive regular expressions matched against the
 * normalized merchant (see services/parsing/normalize.ts).
 */
import type { Category } from '../../generated/prisma/enums';

export interface RuleDefinition {
  pattern: string;
  category: Category;
  priority: number;
}

/**
 * Priority for a rule learned from a user's correction. Below every built-in,
 * so a human's decision always wins (PROJECT_CONTEXT.md §7).
 */
export const LEARNED_RULE_PRIORITY = 10;

/** A word that implies a category regardless of which merchant it belongs to. */
const KEYWORD_PRIORITY = 200;
/** A specific national brand. */
const BRAND_PRIORITY = 300;

function keywords(category: Category, patterns: string[]): RuleDefinition[] {
  return patterns.map((pattern) => ({ pattern, category, priority: KEYWORD_PRIORITY }));
}

function brands(category: Category, patterns: string[]): RuleDefinition[] {
  return patterns.map((pattern) => ({ pattern, category, priority: BRAND_PRIORITY }));
}

export const DEFAULT_RULES: RuleDefinition[] = [
  // --- Transfers and card payments -------------------------------------
  // Highest of the built-ins: a card payment must never be read as spending,
  // whatever else its descriptor happens to contain (§5, §8 case 1).
  { pattern: '\\bCARD PAYMENT\\b', category: 'TRANSFER', priority: 150 },
  { pattern: '\\bVENMO\\b', category: 'TRANSFER', priority: 150 },
  { pattern: '\\bZELLE\\b', category: 'TRANSFER', priority: 150 },
  { pattern: '\\bCASH APP\\b', category: 'TRANSFER', priority: 150 },

  // --- Fees and interest -------------------------------------------------
  ...keywords('FEES_INTEREST', [
    '\\bFOREIGN TRANSACTION FEE\\b',
    '\\bATM FEE\\b',
    '\\bINTEREST CHARGE\\b',
    '\\bLATE FEE\\b',
    '\\bOVERDRAFT\\b',
    '\\bANNUAL FEE\\b',
  ]),

  // --- Groceries ---------------------------------------------------------
  ...keywords('GROCERIES', ['\\bGROCER', '\\bSUPERMARKET\\b']),
  ...brands('GROCERIES', [
    '^WHOLE FOODS',
    '^TRADER JOES',
    '^SAFEWAY',
    '^ALDI$',
    '^KROGER',
    '^PUBLIX',
    '^WEGMANS',
    '^SPROUTS',
  ]),

  // --- Dining ------------------------------------------------------------
  ...keywords('DINING', [
    '\\bCOFFEE\\b',
    '\\bCAFE\\b',
    '\\bRESTAURANT\\b',
    '\\bPIZZA\\b',
    '\\bTAQUERIA\\b',
    '\\bBREWING\\b',
    '\\bDELI\\b',
  ]),
  ...brands('DINING', [
    '^STARBUCKS',
    '^PEETS',
    '^DUNKIN',
    '^CHIPOTLE',
    '^SWEETGREEN',
    '^DOORDASH',
    '^UBER EATS',
    '^GRUBHUB',
    '^MCDONALDS',
    '^SUBWAY$',
    '^PANERA',
  ]),

  // --- Transportation ----------------------------------------------------
  ...keywords('TRANSPORTATION', [
    '\\bPARKING\\b',
    '\\bTRANSIT\\b',
    '\\bTOLL\\b',
    '\\bGAS STATION\\b',
  ]),
  ...brands('TRANSPORTATION', [
    '^UBER$',
    '^LYFT$',
    '^SHELL$',
    '^CHEVRON$',
    '^EXXON',
    '^BP$',
    '^MOBIL$',
    '^MTA$',
    '^BART$',
  ]),

  // --- Housing -----------------------------------------------------------
  ...keywords('HOUSING', [
    '\\bPROPERTY MGMT\\b',
    '\\bRENT\\b',
    '\\bMORTGAGE\\b',
    '\\bAPARTMENTS\\b',
    '\\bLEASING\\b',
  ]),

  // --- Utilities ---------------------------------------------------------
  ...keywords('UTILITIES', [
    '\\bELECTRIC\\b',
    '\\bWATER DEPT\\b',
    '\\bFIBER\\b',
    '\\bBROADBAND\\b',
    '\\bWIRELESS\\b',
    '\\bMOBILE\\b',
    '\\bENERGY\\b',
  ]),
  ...brands('UTILITIES', [
    '^PGE$',
    '^CONED',
    '^COMCAST',
    '^XFINITY',
    '^VERIZON',
    '^AT&?T$',
    '^T-MOBILE',
  ]),

  // --- Subscriptions -----------------------------------------------------
  ...brands('SUBSCRIPTIONS', [
    '^NETFLIX',
    '^SPOTIFY',
    '^HULU',
    '^DISNEY PLUS',
    '^AMAZON PRIME',
    '^APPLE ICLOUD',
    '^ADOBE',
    '^NEW YORK TIMES',
    '^YOUTUBE PREMIUM',
    '^DROPBOX',
  ]),

  // --- Entertainment -----------------------------------------------------
  ...keywords('ENTERTAINMENT', ['\\bTHEATRE', '\\bTHEATER', '\\bCINEMA\\b']),
  ...brands('ENTERTAINMENT', [
    '^AMC ',
    '^STEAM$',
    '^TICKETMASTER',
    '^PATREON',
    '^SPOTIFY LIVE',
    '^EVENTBRITE',
  ]),

  // --- Shopping ----------------------------------------------------------
  ...brands('SHOPPING', [
    '^AMAZON MARKETPLACE',
    '^TARGET$',
    '^WALMART',
    '^COSTCO',
    '^BJS WHOLESALE',
    '^IKEA',
    '^BEST BUY',
    '^APPLE STORE',
    '^ETSY$',
    '^EBAY$',
    '^ZARA$',
    '^NIKE$',
    '^WAYFAIR',
    '^HOME DEPOT',
    '^LOWES',
    '^REI$',
  ]),

  // --- Health & fitness --------------------------------------------------
  ...keywords('HEALTH_FITNESS', [
    '\\bFITNESS\\b',
    '\\bMEDICAL\\b',
    '\\bDENTAL\\b',
    '\\bCLINIC\\b',
    '\\bDIAGNOSTICS\\b',
    '\\bHOSPITAL\\b',
  ]),
  ...brands('HEALTH_FITNESS', ['^WALGREENS', '^EQUINOX', '^PLANET FITNESS']),

  // --- Personal care -----------------------------------------------------
  ...keywords('PERSONAL_CARE', ['\\bPHARMACY\\b', '\\bSALON\\b', '\\bBARBER\\b', '\\bSPA\\b']),
  ...brands('PERSONAL_CARE', ['^SUPERCUTS', '^SEPHORA', '^ULTA']),

  // --- Travel ------------------------------------------------------------
  ...keywords('TRAVEL', ['\\bAIRLINES\\b', '\\bHOTEL', '\\bAIRWAYS\\b', '\\bRESORT\\b']),
  ...brands('TRAVEL', [
    '^DELTA AIR',
    '^UNITED AIR',
    '^AMERICAN AIR',
    '^SOUTHWEST',
    '^MARRIOTT',
    '^HILTON',
    '^AIRBNB',
    '^EXPEDIA',
    '^BOOKING',
    '^AMTRAK',
  ]),

  // --- Insurance ---------------------------------------------------------
  ...keywords('INSURANCE', [
    '\\bINSURANCE\\b',
    '\\bGEICO\\b',
    '\\bALLSTATE\\b',
    '\\bSTATE FARM\\b',
  ]),

  // --- Education ---------------------------------------------------------
  ...keywords('EDUCATION', ['\\bUNIVERSITY\\b', '\\bTUITION\\b', '\\bBOOKSTORE\\b']),
  ...brands('EDUCATION', ['^COURSERA', '^UDEMY', '^EDX$', '^KHAN ACADEMY']),

  // --- Gifts & donations -------------------------------------------------
  ...keywords('GIFTS_DONATIONS', [
    '\\bDONATION\\b',
    '\\bRED CROSS\\b',
    '\\bCHARITY\\b',
    '\\bFLOWERS\\b',
  ]),

  // --- Business ----------------------------------------------------------
  ...brands('BUSINESS', ['^USPS$', '^GITHUB', '^STAPLES', '^FEDEX', '^UPS STORE', '^OFFICE DEPOT']),

  // --- Income ------------------------------------------------------------
  ...keywords('INCOME', ['\\bPAYROLL\\b', '\\bDIRECT DEP\\b', '\\bSALARY\\b']),
  ...brands('INCOME', ['^STRIPE$', '^NORTHWIND LABS']),
];
