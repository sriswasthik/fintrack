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
  { pattern: '\\bGPAY\\b', category: 'TRANSFER', priority: 150 },
  { pattern: '\\bPHONEPE\\b', category: 'TRANSFER', priority: 150 },
  { pattern: '\\bPAYTM WALLET\\b', category: 'TRANSFER', priority: 150 },

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
  ...keywords('GROCERIES', [
    '\\bGROCER',
    '\\bSUPERMARKET\\b',
    '\\bFARMERS M(AR)?KT?\\b',
    '\\bFARMERS MARKET\\b',
    '\\bBUTCHER\\b',
  ]),
  ...brands('GROCERIES', [
    '^DMART$',
    '^RELIANCE FRESH',
    '^BIG BAZAAR',
    '^SPENCERS',
    '^BIGBASKET',
    '^BLINKIT$',
    '^ZEPTO$',
    '^NATURES BASKET',
    // Chains a traveller's statement picks up. The list was US-only, which made
    // a fortnight abroad look like a category the app had never heard of.
    '^TESCO',
    '^SAINSBURYS',
    '^CARREFOUR',
    '^LIDL$',
    '^MERCADONA',
    '^MONOPRIX',
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
    // Venue and cuisine words are as reliable as the ones above and cover the
    // independents a brand list never will: a bakery is a bakery in any city.
    '\\bBAKERY\\b',
    '\\bPATISSERIE\\b',
    '\\bRAMEN\\b',
    '\\bNOODLE',
    '\\bSUSHI\\b',
    '\\bBISTRO\\b',
    '\\bTRATTORIA\\b',
    '\\bCANTINA\\b',
    '\\bTAPROOM\\b',
    '\\bSTEAKHOUSE\\b',
    '\\bDHABA\\b',
    '\\bBHAVAN\\b',
    '\\bSWEETS\\b',
    '\\bTIFFIN',
    '\\bBIRYANI\\b',
  ]),
  ...brands('DINING', [
    '^CHAI POINT',
    '^BLUE TOKAI',
    '^CAFE COFFEE DAY',
    '^THIRD WAVE COFFEE',
    '^STARBUCKS',
    '^HALDIRAMS',
    '^SAGAR RATNA',
    '^BARBEQUE NATION',
    '^SWIGGY',
    '^ZOMATO',
    '^DOMINOS',
    '^MCDONALDS',
    '^SUBWAY$',
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
    '^OLA$',
    '^RAPIDO$',
    '^INDIAN OIL',
    '^BHARAT PETROLEUM',
    '^HP PETROL',
    '^SHELL$',
    '^DMRC$',
    '^BMTC$',
    '^FASTAG',
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
    '\\bELECTRICITY\\b',
    '\\bPREPAID\\b',
    '\\bPOSTPAID\\b',
    '\\bRECHARGE\\b',
  ]),
  ...brands('UTILITIES', [
    '^BESCOM$',
    '^MSEB$',
    '^TATA POWER',
    '^ADANI ELECTRICITY',
    '^JIO FIBER',
    '^JIO$',
    '^AIRTEL',
    '^VI$',
    '^BSNL$',
    '^ACT FIBERNET',
  ]),

  // --- Subscriptions -----------------------------------------------------
  ...brands('SUBSCRIPTIONS', [
    '^NETFLIX',
    '^SPOTIFY',
    '^HOTSTAR',
    '^ZEE5$',
    '^SONYLIV$',
    '^JIOCINEMA$',
    '^AMAZON PRIME',
    '^APPLE ICLOUD',
    '^ADOBE',
    '^YOUTUBE PREMIUM',
    '^DROPBOX',
  ]),

  // --- Entertainment -----------------------------------------------------
  ...keywords('ENTERTAINMENT', ['\\bTHEATRE', '\\bTHEATER', '\\bCINEMA\\b']),
  ...brands('ENTERTAINMENT', [
    '^PVR CINEMAS',
    '^INOX$',
    '^STEAM$',
    '^BOOKMYSHOW',
    '^PATREON',
    '^EVENTBRITE',
  ]),

  // --- Shopping ----------------------------------------------------------
  ...brands('SHOPPING', [
    '^AMAZON MARKETPLACE',
    '^FLIPKART$',
    '^MYNTRA$',
    '^AJIO$',
    '^MEESHO$',
    '^NYKAA FASHION',
    '^CROMA',
    '^RELIANCE SMART',
    '^METRO CASH CARRY',
    '^RELIANCE DIGITAL',
    '^VIJAY SALES',
    '^IKEA',
    '^PEPPERFRY',
    '^URBAN LADDER',
    '^BATA$',
    '^NIKE$',
    '^DECATHLON$',
    '^SPENCERS HYPER',
    '^MUJI$',
    '^UNIQLO$',
    '^EL CORTE INGLES$',
    '^JOHN LEWIS$',
    '^DECATHLON$',
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
  ...brands('HEALTH_FITNESS', ['^MEDPLUS', '^PRACTO', '^DR LAL PATHLABS', '^CULT FIT', '^1MG$']),

  // --- Personal care -----------------------------------------------------
  ...keywords('PERSONAL_CARE', ['\\bPHARMACY\\b', '\\bSALON\\b', '\\bBARBER\\b', '\\bSPA\\b']),
  ...brands('PERSONAL_CARE', ['^LAKME SALON', '^NYKAA$', '^APOLLO PHARMACY', '^NATURALS$']),

  // --- Travel ------------------------------------------------------------
  ...keywords('TRAVEL', ['\\bAIRLINES\\b', '\\bHOTEL', '\\bAIRWAYS\\b', '\\bRESORT\\b']),
  ...brands('TRAVEL', [
    '^INDIGO AIRLINES',
    '^AIR INDIA',
    '^VISTARA$',
    '^SPICEJET$',
    '^TAJ HOTELS',
    '^OYO$',
    '^AIRBNB',
    '^MAKEMYTRIP',
    '^GOIBIBO$',
    '^BOOKING',
    '^IRCTC$',
    // National rail, for the same reason as the grocers above: AMTRAK was the
    // only railway in the set.
    '^SNCF$',
    '^TRENITALIA$',
    '^RENFE$',
    '^EUROSTAR$',
    '^DEUTSCHE BAHN',
    '^VIA RAIL',
  ]),

  // --- Insurance ---------------------------------------------------------
  ...keywords('INSURANCE', [
    '\\bINSURANCE\\b',
    '\\bHDFC ERGO\\b',
    '\\bLIC\\b',
    '\\bBAJAJ ALLIANZ\\b',
    '\\bICICI LOMBARD\\b',
    '\\bSTAR HEALTH\\b',
  ]),

  // --- Education ---------------------------------------------------------
  ...keywords('EDUCATION', ['\\bUNIVERSITY\\b', '\\bTUITION\\b', '\\bBOOKSTORE\\b']),
  ...brands('EDUCATION', ['^UNACADEMY', '^BYJUS', '^VEDANTU$', '^COURSERA', '^UDEMY']),

  // --- Gifts & donations -------------------------------------------------
  ...keywords('GIFTS_DONATIONS', [
    '\\bDONATION\\b',
    '\\bGOONJ\\b',
    '\\bCRY\\b',
    '\\bAKSHAYA PATRA\\b',
    '\\bCHARITY\\b',
    '\\bFLOWERS\\b',
  ]),

  // --- Business ----------------------------------------------------------
  ...brands('BUSINESS', ['^INDIA POST$', '^GITHUB', '^OFFICEYES', '^BLUE DART', '^DTDC$']),

  // --- Income ------------------------------------------------------------
  ...keywords('INCOME', ['\\bPAYROLL\\b', '\\bDIRECT DEP\\b', '\\bSALARY\\b']),
  ...brands('INCOME', ['^RAZORPAY$', '^INFOSYS LTD']),
];
