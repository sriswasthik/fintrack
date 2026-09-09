/**
 * Merchant normalization.
 *
 * Bank descriptors are messy in a small number of recognisable ways: a payment
 * processor prefixes its own name, a gateway appends the thing you bought, a
 * store number or order reference trails the merchant, and the whole thing is
 * shouted in inconsistent case with stray punctuation. `normalizeMerchant`
 * reduces all of that to a stable key that the rule engine (Phase 3) can match
 * on and the LLM merchant cache (Phase 4) can be keyed by.
 *
 * The pipeline is deliberately algorithmic, with three small curated tables for
 * the parts no algorithm can derive: which `*` prefixes are pass-through
 * processors rather than the merchant itself, which trailing words are noise,
 * and which brands have a canonical name that differs from their descriptor.
 * Real normalizers work the same way; the tables are the part that grows.
 *
 * `test-data/README.md` documents the expected output for every descriptor in
 * the synthetic dataset, and `normalize.test.ts` asserts against all of them.
 */

/**
 * Prefixes before a `*` that belong to a payment processor, not the merchant.
 * `SQ *JOES COFFEE` is a coffee shop taking Square payments — the merchant is
 * on the right. Anything with a `*` that is NOT in this list is treated the
 * other way round: `DOORDASH*THAI BASIL` is a DoorDash order, so the merchant
 * is on the left and the restaurant is the line item.
 */
const PASS_THROUGH_PROCESSORS = new Set([
  'SQ',
  'SQC',
  'TST',
  'PAYPAL',
  'PP',
  'PY',
  'SP',
  'POS',
  'DONATION',
  'DD',
]);

/**
 * Trailing words that describe the outlet rather than the brand. Only stripped
 * from the end, and never when they are the only word left.
 */
const TRAILING_NOISE = new Set([
  'STORE',
  'STORES',
  'MKT',
  'MARKET',
  'WHSE',
  'SUPERCENTER',
  'CLUB',
  'GROUP',
  'ONLINE',
  'ORDER',
  'INTERNET',
  'WEB',
  'USA',
  'US',
  'INC',
  'LLC',
  'INTL',
  'INTERNATIONAL',
  'HOTELS',
  'OIL',
  'PO',
  'WIRELESS',
  'MEMBERSHIP',
  'PAYMENT',
  'TRANSFER',
  'CASHOUT',
  'BONUS',
  'DIRECT',
  'DEP',
  'PURCHASE',
  'DEBIT',
  'CREDIT',
  'POS',
  // What the money was for, rather than who it went to. A return has to reduce
  // to the same key as the purchase it reverses or Phase 3 can never match the
  // two (§8 case 2).
  'REFUND',
  'RETURN',
  'RETURNED',
  'REVERSAL',
  'ADJUSTMENT',
  'FREELANCE',
  'INVOICE',
]);

/** Domain suffixes stripped from the end of a merchant token. */
const DOMAIN_SUFFIXES = ['.COM', '.ORG', '.NET', '.CO.UK', '.IO'];

/**
 * Trailing place names. Two-letter country codes are handled generically; these
 * are the city and neighbourhood names that would otherwise survive.
 */
const TRAILING_PLACES = new Set([
  'AMSTERDAM',
  'BERLIN',
  'BROOKLYN',
  'DOWNTOWN',
  'LONDON',
  'MADRID',
  'PARIS',
  'ROMA',
  'ROME',
  'SHIBUYA',
  'SOHO',
  'TOKYO',
]);

/** Two-letter ISO country codes that appear as a trailing token on foreign charges. */
const COUNTRY_CODES = new Set([
  'NL',
  'FR',
  'JP',
  'ES',
  'UK',
  'GB',
  'IT',
  'DE',
  'CA',
  'AU',
  'IE',
  'MX',
  'SE',
  'CH',
]);

/**
 * Brands whose canonical name differs from anything the algorithm can derive.
 * Keys are matched against the cleaned descriptor, so they are already
 * uppercased and stripped of processor prefixes and reference numbers.
 */
const MERCHANT_ALIASES = new Map<string, string>([
  ['AMZN MKTP US', 'AMAZON MARKETPLACE'],
  ['AMZN MKTP', 'AMAZON MARKETPLACE'],
  ['ETSYINC', 'ETSY'],
  ['STEAMGAMES', 'STEAM'],
  ['NYTIMES', 'NEW YORK TIMES'],
  ['PAYMENT THANK YOU', 'CHASE CARD PAYMENT'],
  ['APPLE.COM BILL ICLOUD', 'APPLE ICLOUD'],
  ['ADOBE CREATIVE CLOUD', 'ADOBE'],
  // Identity aliases: these would otherwise lose a meaningful trailing token.
  ['BOOKING.COM', 'BOOKING.COM'],
  ['CHASE CARD PAYMENT', 'CHASE CARD PAYMENT'],
  ['APPLE STORE', 'APPLE STORE'],
]);

/**
 * Card-payment descriptors, rewritten to `<BANK> CARD PAYMENT`.
 *
 * Every bank writes this line differently — "ONLINE PAYMENT TO CHASE CARD
 * ...4021", "PAYMENT TO CAPITAL ONE CARD XXXX1234" — and the words that make it
 * a payment rather than a purchase are scattered through the wrapper. Losing
 * them means a credit-card payment is read as spending, which is the exact
 * failure §8 case 1 exists to prevent, so this runs before anything is stripped.
 */
const CARD_PAYMENT_WRAPPER =
  /^(?:ONLINE\s+|MOBILE\s+|AUTOMATIC\s+)?PAYMENT\s+(?:TO|FOR)\s+(.+?)\s+CARD\b.*$/;

/** Merchants that always collapse to a single name regardless of what follows. */
const MERCHANT_PREFIXES: [RegExp, string][] = [
  [/^ZELLE (?:TO|FROM)\b/, 'ZELLE'],
  [/^VENMO\b/, 'VENMO'],
  [/^CASH APP\b/, 'CASH APP'],
  [/^NORTHWIND LABS\b/, 'NORTHWIND LABS'],
];

/** A token that is purely a store number, order id or other reference. */
function isReferenceToken(token: string): boolean {
  if (/^#/.test(token)) return true;
  if (/^\d{3,}$/.test(token)) return true;
  // Masked account digits: "...4021", "****4021", "XXXX4021".
  if (/^(?:\.{2,}|\*{2,}|X{3,})\d{2,}$/.test(token)) return true;
  // Mixed alphanumerics with at least one digit and no separators, e.g. HM4X6422.
  if (token.length >= 5 && /\d/.test(token) && /^[A-Z0-9]+$/.test(token) && !/^\d+$/.test(token)) {
    return true;
  }
  return false;
}

function stripDomainSuffix(token: string): string {
  const bare = token.startsWith('WWW.') ? token.slice(4) : token;
  for (const suffix of DOMAIN_SUFFIXES) {
    if (bare === suffix) return '';
    if (bare.endsWith(suffix) && bare.length > suffix.length) {
      return bare.slice(0, -suffix.length);
    }
  }
  return bare;
}

/**
 * Reduces a raw bank descriptor to a stable merchant key.
 *
 * @example
 * normalizeMerchant('SQ *JOES COFFEE')       // 'JOES COFFEE'
 * normalizeMerchant('DOORDASH*THAI BASIL')   // 'DOORDASH'
 * normalizeMerchant('WHOLE FOODS MKT #104')  // 'WHOLE FOODS'
 */
export function normalizeMerchant(raw: string): string {
  if (!raw) return '';

  let value = raw.toUpperCase();

  // 0. Card payments, before any stripping can lose the words that identify one.
  //    The bank name is normalized on its own and the suffix put back after, so
  //    the trailing-noise pass cannot eat the word PAYMENT on the way through.
  const cardPayment = CARD_PAYMENT_WRAPPER.exec(value);
  if (cardPayment) {
    const bank = normalizeMerchant(cardPayment[1].trim());
    return bank ? `${bank} CARD PAYMENT` : 'CARD PAYMENT';
  }

  // 1. Split on the processor marker and decide which side is the merchant.
  const star = value.indexOf('*');
  if (star !== -1) {
    const left = value.slice(0, star).trim();
    const right = value.slice(star + 1).trim();
    const leftKey = left.replace(/\s+/g, ' ').trim();
    if (PASS_THROUGH_PROCESSORS.has(leftKey) && right) {
      value = right;
    } else if (left) {
      value = left;
    } else {
      value = right;
    }
  }

  // 2. Punctuation: apostrophes vanish, separators become spaces, & is dropped.
  value = value
    .replace(/['’`]/g, '')
    .replace(/[/\\]/g, ' ')
    .replace(/&/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A descriptor can carry a location or branch after a dash: "THE HALL - DOWNTOWN".
  value = value.replace(/\s+-\s+.*$/, '').trim();

  let tokens = value.split(' ').filter(Boolean);

  // 3. Drop reference tokens wherever they appear — store numbers show up in the
  //    middle too, e.g. "ZARA #482 SOHO".
  tokens = tokens.filter((t) => !isReferenceToken(t));
  if (tokens.length === 0) return '';

  // 4. Trailing place names and country codes (foreign charges).
  tokens = stripTrailingWhile(tokens, isTrailingPlace);

  const afterPlaces = tokens.join(' ');
  const aliased = lookupAlias(afterPlaces);
  if (aliased) return aliased;

  // 5. Trailing noise, places and domain suffixes, repeatedly. One pass is not
  //    enough because each kind can hide another: "ZARA SOHO REFUND" only shows
  //    its place once the purpose word is gone, and "REI.COM ONLINE" only shows
  //    its domain once the outlet word is.
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    if (TRAILING_NOISE.has(last) || isTrailingPlace(last)) {
      tokens = tokens.slice(0, -1);
      changed = true;
      continue;
    }
    const stripped = stripDomainSuffix(last);
    if (stripped !== last) {
      tokens = stripped ? [...tokens.slice(0, -1), stripped] : tokens.slice(0, -1);
      changed = true;
    }
  }
  if (tokens.length === 1) {
    tokens = [stripDomainSuffix(tokens[0])];
  }

  const result = tokens.join(' ').trim();
  return lookupAlias(result) ?? applyPrefixRules(result);
}

function isTrailingPlace(token: string): boolean {
  return TRAILING_PLACES.has(token) || (token.length === 2 && COUNTRY_CODES.has(token));
}

function stripTrailingWhile(tokens: string[], predicate: (t: string) => boolean): string[] {
  let end = tokens.length;
  while (end > 1 && predicate(tokens[end - 1])) end -= 1;
  return tokens.slice(0, end);
}

function lookupAlias(value: string): string | undefined {
  return MERCHANT_ALIASES.get(value);
}

function applyPrefixRules(value: string): string {
  for (const [pattern, canonical] of MERCHANT_PREFIXES) {
    if (pattern.test(value)) return canonical;
  }
  return value;
}

/**
 * Splits a full description line into the merchant portion kept verbatim as
 * `rawMerchant` and the normalized key. The synthetic exports put the merchant
 * on its own, but real exports append transaction chatter after a double space
 * or a trailing date, which is dropped here rather than in the normalizer.
 */
export function extractMerchant(description: string): {
  rawMerchant: string;
  normalizedMerchant: string;
} {
  const rawMerchant = description.trim().replace(/\s{3,}/g, ' ');
  return { rawMerchant, normalizedMerchant: normalizeMerchant(rawMerchant) };
}
