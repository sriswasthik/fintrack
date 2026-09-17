/**
 * The built-in categorization rules.
 *
 * These are seeded into the `Rule` table with a null `userId`, which makes them
 * apply to everyone and lets a user's own learned rules sit above them by
 * priority. Keeping them in code as well gives the seed and the re-apply script
 * a single source of truth.
 *
 * Four kinds of rule live here, in the order they get to decide:
 *
 *   * **Disambiguators** (priority 180) — a specific name that would otherwise
 *     lose to a broader rule. LIC is an insurer and LIC HFL is a home lender;
 *     ICICI Prudential sells mutual funds and ICICI Prudential Life sells
 *     policies; Swiggy is dinner and Swiggy Instamart is the weekly shop. Each
 *     of these is one rule shadowing another, and the band makes which one wins
 *     a property of the rule set rather than of the order of an array.
 *   * **Keyword rules** (priority 200) — a word that reliably implies a
 *     category wherever it appears: COFFEE, PHARMACY, AIRLINES. These are the
 *     rules that generalise beyond any merchant list.
 *   * **Narration rules** (priority 250) — words that describe what the *line*
 *     is rather than who was paid: EMI, SIP, ATM, CASH WDL. They sit below the
 *     keywords on purpose, so the specific "ATM FEE" keeps its FEES_INTEREST
 *     answer instead of being swallowed by the generic ATM rule.
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

/**
 * A specific name that has to beat a broader rule further down. Above the
 * keywords, below the card-payment rules — a transfer is still never spend.
 */
export const DISAMBIGUATION_PRIORITY = 180;
/** A word that implies a category regardless of which merchant it belongs to. */
const KEYWORD_PRIORITY = 200;
/** A word describing what the line is, not who was paid. */
const NARRATION_PRIORITY = 250;
/** A specific national brand. */
export const BRAND_PRIORITY = 300;

/**
 * The bands whose rules name a specific business rather than describe a line.
 *
 * The difference matters to the counterparty classifier: `\bEMI\b` matching
 * says the line is a loan repayment, not that "EMI HDB FINANCIAL" is a merchant
 * anyone has heard of — and an ATM withdrawal has no counterparty at all.
 */
export const MERCHANT_NAME_PRIORITIES: readonly number[] = [
  DISAMBIGUATION_PRIORITY,
  BRAND_PRIORITY,
];

function disambiguators(category: Category, patterns: string[]): RuleDefinition[] {
  return patterns.map((pattern) => ({ pattern, category, priority: DISAMBIGUATION_PRIORITY }));
}

function keywords(category: Category, patterns: string[]): RuleDefinition[] {
  return patterns.map((pattern) => ({ pattern, category, priority: KEYWORD_PRIORITY }));
}

function narration(category: Category, patterns: string[]): RuleDefinition[] {
  return patterns.map((pattern) => ({ pattern, category, priority: NARRATION_PRIORITY }));
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

  // --- Disambiguators ----------------------------------------------------
  // Each of these shadows a broader rule further down. Written out here rather
  // than relied on by array position, because two rules at the same priority
  // are separated by their id, and an id is an accident of insertion order.
  //
  // A financial group in India lends, insures and manages funds under one name,
  // so the group name alone decides nothing — it is the word after it that says
  // which arm of it was paid.
  ...disambiguators('EMI_LOAN', [
    // LIC sells policies; LIC Housing Finance lends. Beats the LIC keyword.
    '^LIC ?HFL\\b',
    '\\bLICHFL\\b',
    '^LIC HOUSING',
  ]),
  ...disambiguators('INSURANCE', [
    // The life arms, against the asset managers of the same name below.
    '^ICICI PRU(DENTIAL)? LIFE',
    '^ADITYA BIRLA SUN LIFE INSURANCE',
    '^CHOLAMANDALAM MS',
    '^BAJAJ ALLIANZ',
  ]),
  ...disambiguators('GROCERIES', [
    // The weekly shop, not dinner. Beats the Swiggy brand rule.
    '^SWIGGY ?INSTAMART',
  ]),
  ...disambiguators('SUBSCRIPTIONS', [
    // A recurring membership, not the shop. Beats the Amazon brand rule.
    '^AMAZON PRIME',
  ]),
  ...disambiguators('SHOPPING', [
    // The hypermarket sells more than food; the supermarket rule below would
    // otherwise claim it. This tied at brand priority until now, and which of
    // the two won came down to which rule id sorted first — an accident, and
    // a different accident in the database than in the tests.
    '^SPENCERS HYPER',
  ]),

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
    '^BLINKIT',
    '^ZEPTO$',
    '^NATURES BASKET',
    // Quick commerce: ten-minute grocery, which is the weekly shop arriving in
    // instalments rather than a category of its own.
    '^INSTAMART',
    '^JIOMART',
    '^DUNZO',
    '^COUNTRY DELIGHT',
    '^LICIOUS',
    '^FRESHTOHOME',
    '^MILKBASKET',
    '^MORE (RETAIL|SUPERMARKET|MEGASTORE)',
    '^RATNADEEP',
    '^VISHAL MEGA MART',
    '^STAR BAZAAR',
    '^EASYDAY',
    '^NILGIRIS',
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
    '^EATSURE',
    '^BEHROUZ',
    '^OVENSTORY',
    '^FAASOS',
    '^BOX8',
    '^FRESHMENU',
    '^WOW ?MOMO',
    '^CHAAYOS',
    '^BIKANERVALA',
    '^SARAVANA BHAVAN',
    '^KFC$',
    '^BURGER KING',
    '^PIZZA HUT',
    '^THEOBROMA',
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
    '^NAMMA YATRI',
    '^BLUSMART',
    '^MERU$',
    '^QUICK ?RIDE',
    '^YULU$',
    '^BOUNCE$',
    '^VOGO$',
    '^ZOOMCAR',
    '^REVV$',
    '^HPCL',
    '^IOCL',
    '^NAYARA',
    '^JIO ?BP',
    '^RELIANCE PETROL',
    '^BMRCL$',
    '^MMRDA$',
    '^BEST UNDERTAKING',
    '^MSRTC$',
    '^KSRTC$',
    '^APSRTC$',
    '^TSRTC$',
    '^ONDC MOBILITY',
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
  ...keywords('UTILITIES', [
    // A distribution company is an electricity bill whatever its acronym is,
    // and there are dozens of acronyms. The generic words come first so a
    // discom this list has never heard of still lands in the right place.
    '\\bDISCOM\\b',
    '\\bVIDYUT\\b',
    '\\bBIJLI\\b',
    '\\bPOWER (CORP|SUPPLY|DISTRIBUTION)',
    '\\bVIJ COMPANY\\b',
    '\\bGAS (AGENCY|LIMITED|LTD)\\b',
    '\\bWATER (BOARD|SUPPLY|WORKS)\\b',
    '\\bDTH\\b',
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
    // State electricity boards and discoms, by the acronym each one bills under.
    '^MSEDCL\\b',
    '^MAHADISCOM',
    '^TNEB$',
    '^TANGEDCO',
    '^KSEB$',
    '^APSPDCL\\b',
    '^APEPDCL\\b',
    '^TSSPDCL\\b',
    '^TSNPDCL\\b',
    '^BSES',
    '^CESC',
    '^UPPCL\\b',
    '^PVVNL$',
    '^PSPCL\\b',
    '^JVVNL\\b',
    '^JDVVNL\\b',
    '^AVVNL\\b',
    '^PGVCL\\b',
    '^MGVCL\\b',
    '^DGVCL\\b',
    '^UGVCL\\b',
    '^WBSEDCL\\b',
    '^HESCOM\\b',
    '^MESCOM\\b',
    '^GESCOM\\b',
    '^CHESCOM\\b',
    '^DHBVN\\b',
    '^UHBVN\\b',
    '^NPCL$',
    '^JBVNL\\b',
    '^CSPDCL\\b',
    '^TORRENT POWER',
    '^ASSAM POWER',
    '^KESCO\\b',
    // Piped city gas and bottled LPG.
    '^MAHANAGAR GAS',
    '^MGL$',
    '^INDRAPRASTHA GAS',
    '^IGL$',
    '^GUJARAT GAS',
    '^ADANI (TOTAL )?GAS',
    '^GAIL GAS',
    '^SABARMATI GAS',
    '^TORRENT GAS',
    '^VADODARA GAS',
    '^INDANE',
    '^BHARAT ?GAS',
    '^HP ?GAS',
    // Water.
    '^BWSSB\\b',
    '^DELHI JAL BOARD',
    '^DJB$',
    '^CHENNAI METRO WATER',
    // Telecom, DTH and the wired internet.
    '^MTNL\\b',
    '^VODAFONE',
    '^TATA PLAY',
    '^DISH ?TV',
    '^SUN DIRECT',
    '^D2H$',
    '^HATHWAY',
    '^EXCITEL',
    '^TIKONA',
    '^SPECTRA$',
    '^RAILWIRE',
    '^ASIANET BROADBAND',
  ]),

  // --- Subscriptions -----------------------------------------------------
  ...brands('SUBSCRIPTIONS', [
    '^NETFLIX',
    '^SPOTIFY',
    '^HOTSTAR',
    '^ZEE5$',
    '^SONYLIV$',
    '^JIOCINEMA$',
    '^APPLE ICLOUD',
    '^ADOBE',
    '^YOUTUBE PREMIUM',
    '^DROPBOX',
    '^JIOSAAVN',
    '^JIOHOTSTAR',
    '^GAANA$',
    '^WYNK',
    '^AUDIBLE',
    '^AHA$',
    '^SUN ?NXT',
    '^ALTBALAJI',
    '^DISCOVERY ?PLUS',
    '^LIONSGATE ?PLAY',
    '^APPLE (TV|MUSIC|ONE)',
    '^PRIME VIDEO',
    '^GOOGLE ONE',
    '^MICROSOFT 365',
    '^CHATGPT',
    '^CLAUDE$',
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
    '^MUJI$',
    '^UNIQLO$',
    '^EL CORTE INGLES$',
    '^JOHN LEWIS$',
    '^DECATHLON$',
    // Amazon's shop, below the Prime disambiguator above.
    '^AMAZON\\b',
    '^TATA CLIQ',
    '^SNAPDEAL',
    '^FIRSTCRY',
    '^LENSKART',
    '^TITAN$',
    '^TANISHQ',
    '^BOAT ?LIFESTYLE',
    '^RELIANCE TRENDS',
    '^WESTSIDE$',
    '^LIFESTYLE STORES',
    '^SHOPPERS STOP',
    '^PANTALOONS',
    '^MAX FASHION',
    '^BIBA$',
    '^FABINDIA',
    '^WROGN$',
    '^PUMA$',
    '^ADIDAS$',
    '^SPORTS ?STATION',
    '^HOME ?CENTRE',
    '^NILKAMAL',
    '^GODREJ INTERIO',
    '^SANGEETHA MOBILES',
    '^POORVIKA',
    '^ONEPLUS',
    '^MI ?STORE',
    '^SAMSUNG ?SHOP',
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
    '^REDBUS',
    '^ABHIBUS',
    '^EASEMYTRIP',
    '^YATRA$',
    '^IXIGO',
    '^CLEARTRIP',
    '^TRAINMAN',
    '^CONFIRMTKT',
    '^PAYTM TRAVEL',
    '^AKASA AIR',
    '^TREEBO',
    '^FABHOTELS',
    '^ZOSTEL',
    '^GINGER HOTELS',
    '^LEMON TREE',
    '^ITC HOTELS',
    '^CLUB MAHINDRA',
    '^AGODA',
    '^TRIVAGO',
  ]),

  // --- Insurance ---------------------------------------------------------
  ...keywords('INSURANCE', [
    '\\bINSURANCE\\b',
    '\\bASSURANCE\\b',
    '\\bPOLICY PREMIUM\\b',
    '\\bHDFC ERGO\\b',
    '\\bLIC\\b',
    '\\bBAJAJ ALLIANZ\\b',
    '\\bICICI LOMBARD\\b',
    '\\bSTAR HEALTH\\b',
  ]),
  ...brands('INSURANCE', [
    // The life insurers, and the general insurers that do not carry the word.
    '^SBI (LIFE|GENERAL)',
    '^HDFC LIFE',
    '^MAX LIFE',
    '^TATA AIA',
    '^TATA AIG',
    '^KOTAK (MAHINDRA )?LIFE',
    '^PNB METLIFE',
    '^CANARA HSBC LIFE',
    '^AVIVA LIFE',
    '^EXIDE LIFE',
    '^FUTURE GENERALI',
    '^RELIANCE (GENERAL|NIPPON LIFE)',
    '^NIVA BUPA',
    '^CARE HEALTH',
    '^MANIPALCIGNA',
    '^ADITYA BIRLA HEALTH',
    '^GO ?DIGIT',
    '^ACKO',
    '^NEW INDIA ASSURANCE',
    '^ORIENTAL INSURANCE',
    '^UNITED INDIA',
    '^NATIONAL INSURANCE',
    '^IFFCO ?TOKIO',
    '^LIBERTY GENERAL',
    '^SHRIRAM GENERAL',
    '^ZUNO$',
    '^POLICYBAZAAR',
    '^AGRICULTURE INSURANCE',
  ]),

  // --- Investments -------------------------------------------------------
  // An SIP debit looks exactly like a bill: same amount, same day, same mandate
  // rail. It is not spending and it is not a transfer between the user's own
  // accounts either — the money has left for something they own elsewhere.
  ...narration('INVESTMENTS', [
    '\\bSIP\\b',
    '\\bMUTUAL ?FUND\\b',
    '\\bMF PURCHASE\\b',
    '\\bELSS\\b',
    '\\bNPS\\b',
    '\\bPPF\\b',
    '\\bSUKANYA\\b',
    '\\bDEMAT\\b',
    '\\bSOVEREIGN GOLD\\b',
    '\\bSGB\\b',
    '\\bSYSTEMATIC INVESTMENT\\b',
  ]),
  ...brands('INVESTMENTS', [
    // Brokers.
    '^ZERODHA',
    '^GROWW',
    '^UPSTOX',
    '^ANGEL ?(ONE|BROKING)',
    '^5PAISA',
    '^KUVERA',
    '^PAYTM MONEY',
    '^ICICI ?DIRECT',
    '^HDFC SECURITIES',
    '^KOTAK SECURITIES',
    '^SHAREKHAN',
    '^MOTILAL OSWAL',
    '^DHAN$',
    '^INDMONEY',
    '^SMALLCASE',
    '^COIN BY ZERODHA',
    // Registrars and exchanges — where a direct mutual-fund debit comes from.
    '^CAMS$',
    '^KFIN',
    '^BSE ?STAR',
    '^MF ?UTILITY',
    '^NSDL',
    '^CDSL',
    // Asset managers. The life-insurance arms of the same groups are handled by
    // the disambiguators at the top.
    '^SBI (MUTUAL FUND|MF|FUNDS)',
    '^HDFC (MUTUAL FUND|MF|AMC)',
    '^ICICI PRU',
    '^AXIS (MUTUAL FUND|MF)',
    '^NIPPON INDIA',
    '^ADITYA BIRLA SUN LIFE',
    '^ABSL',
    '^KOTAK (MAHINDRA )?(MUTUAL FUND|MF)',
    '^UTI (MUTUAL FUND|MF|AMC)',
    '^MIRAE ASSET',
    '^DSP (MUTUAL FUND|MF)',
    '^FRANKLIN TEMPLETON',
    '^QUANT (MUTUAL FUND|MF)',
    '^PPFAS',
    '^PARAG PARIKH',
    '^TATA (MUTUAL FUND|MF)',
    '^CANARA ROBECO',
    '^EDELWEISS (MUTUAL FUND|MF)',
    '^BANDHAN (MUTUAL FUND|MF)',
    '^HSBC (MUTUAL FUND|MF)',
    '^INVESCO',
  ]),

  // --- EMI and loan repayment --------------------------------------------
  // Repaying borrowed money, which is neither a fee the bank charged nor a
  // transfer between the user's own accounts.
  ...narration('EMI_LOAN', [
    '\\bEMI\\b',
    '\\bLOANEMI\\b',
    '\\bLOAN\\b',
    '\\bEQUATED MONTHLY\\b',
    '\\bINSTALMENT\\b',
    '\\bINSTALLMENT\\b',
    '\\bREPAYMENT\\b',
  ]),
  ...brands('EMI_LOAN', [
    '^BAJAJ FIN(ANCE|SERV)',
    '^HDB FINANCIAL',
    '^TATA CAPITAL',
    '^MAHINDRA FINANCE',
    '^SHRIRAM FINANCE',
    '^MUTHOOT',
    '^MANAPPURAM',
    '^CHOLAMANDALAM',
    '^LT FINANCE',
    '^ADITYA BIRLA FINANCE',
    '^PIRAMAL (FINANCE|CAPITAL)',
    '^IIFL',
    '^POONAWALLA',
    '^HERO FINCORP',
    '^TVS CREDIT',
    '^INDIABULLS',
    '^DMI FINANCE',
    '^FULLERTON',
    // Digital lenders and buy-now-pay-later.
    '^KREDITBEE',
    '^MONEYVIEW',
    '^NAVI$',
    '^PAYSENSE',
    '^CASHE$',
    '^SLICE$',
    '^LAZYPAY',
    '^SIMPL$',
    '^ZESTMONEY',
    '^HOME CREDIT',
    '^CAPITAL FLOAT',
    // Housing finance.
    '^PNB HOUSING',
    '^CAN FIN HOMES',
    '^AAVAS',
    '^HOME FIRST',
    '^SUNDARAM (HOME|FINANCE)',
    '^GRIHUM',
  ]),

  // --- Cash withdrawal ---------------------------------------------------
  // Cash taken out is not yet spent on anything. Filing it as spending in some
  // other category would be inventing a purchase that has not happened; this
  // category is where it waits until the user says what it went on.
  //
  // These sit at narration priority, below the ATM FEE keyword above — a
  // charge for using the machine is a fee, not the withdrawal itself.
  ...narration('CASH_WITHDRAWAL', [
    '\\bATM\\b',
    '\\bATW\\b',
    '\\bNWD\\b',
    '\\bCASH ?WDL\\b',
    '\\bCASH WITHDRAWAL\\b',
    '\\bCASH WDR\\b',
    '\\bSELF WITHDRAWAL\\b',
  ]),

  // --- Education ---------------------------------------------------------
  ...keywords('EDUCATION', ['\\bUNIVERSITY\\b', '\\bTUITION\\b', '\\bBOOKSTORE\\b']),
  ...brands('EDUCATION', [
    '^UNACADEMY',
    '^BYJUS',
    '^VEDANTU$',
    '^COURSERA',
    '^UDEMY',
    '^PHYSICS ?WALLAH',
    '^TOPPR',
    '^SIMPLILEARN',
    '^UPGRAD',
    '^SCALER',
    '^GREAT LEARNING',
    '^ALLEN CAREER',
    '^AAKASH INSTITUTE',
    '^EXTRAMARKS',
    '^DOUBTNUT',
  ]),

  // --- Gifts & donations -------------------------------------------------
  ...keywords('GIFTS_DONATIONS', [
    '\\bDONATION\\b',
    '\\bGOONJ\\b',
    '\\bCRY\\b',
    '\\bAKSHAYA PATRA\\b',
    '\\bCHARITY\\b',
    '\\bFLOWERS\\b',
  ]),
  // Gifting and flower-delivery brands. Their narrations carry none of the
  // keywords above — "FERNS N PETALS.COM" says nothing about flowers — so
  // without these they sit in the review queue forever.
  ...brands('GIFTS_DONATIONS', [
    '^FERNS N PETALS',
    '^IGP$',
    '^INDIAGIFTSPORTAL',
    '^ARCHIES',
    '^BAKINGO',
    '^WINNI$',
    '^FLOWERAURA',
  ]),

  // --- Business ----------------------------------------------------------
  ...brands('BUSINESS', ['^INDIA POST$', '^GITHUB', '^OFFICEYES', '^BLUE DART', '^DTDC$']),

  // --- Income ------------------------------------------------------------
  ...keywords('INCOME', ['\\bPAYROLL\\b', '\\bDIRECT DEP\\b', '\\bSALARY\\b']),
  ...brands('INCOME', ['^RAZORPAY$', '^INFOSYS LTD']),
];
