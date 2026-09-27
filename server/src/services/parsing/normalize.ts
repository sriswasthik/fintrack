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
import { parseVpa } from './upi';

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
  // Indian rails. Same idea: the wallet or gateway prints its own name in
  // front of the merchant, and it is the merchant that matters.
  'PAYTM',
  'RAZ',
  'RAZORPAY',
  'BILLDESK',
  'UPI',
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
  // Indian statements: what the bill was for, or which flavour of the plan,
  // rather than who was billing.
  'ETICKET',
  'BROADBAND',
  'ELECTRICITY',
  'PREPAID',
  'POSTPAID',
  'RECHARGE',
  'CONSULT',
  'SALARY',
  'SUPER',
]);

/**
 * The payment rail a line came in on, which every Indian bank prints in front
 * of the narration: `UPI/SWIGGY INSTAMART/425512`, `NEFT/ZERODHA BROKING LTD`,
 * `ACH D- AXIS MF SIP`.
 *
 * Exactly the same idea as `PASS_THROUGH_PROCESSORS` above — the thing in front
 * is how the money moved, not who was paid — but reached by a different route.
 * A processor announces itself with a `*` and a rail with a `/`, and `/` is
 * already flattened to a space by the time tokens exist, so the rail word has
 * to be recognised by name instead.
 *
 * Leaving it in place is not cosmetic: it defeats every `^BRAND` rule in the
 * set, because the brand is no longer at the start of the string.
 */
const PAYMENT_RAILS = new Set([
  'UPI',
  'NEFT',
  'IMPS',
  'RTGS',
  'ACH',
  'NACH',
  'ECS',
  'MMT',
  'TPT',
  'INF',
  'MPS',
  'BIL',
  'BILLPAY',
  'VPS',
  'ATOM',
  'CMS',
  // A card swiped at a till: "POS 416021XXXXXX1234 BIGBASKET". The card number
  // is a reference and goes in step 3, which leaves POS where the brand should be.
  'POS',
]);

/**
 * Direction markers a rail prints right after itself: `ACH D-`, `UPI/DR`. They
 * say which way the money went, which the sign of the amount already says.
 */
const RAIL_DIRECTIONS = new Set(['DR', 'CR', 'D', 'C', 'P2M', 'P2A']);

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
  // Indian cities and localities, for the same reason: an outlet is not a brand.
  'BENGALURU',
  'BANGALORE',
  'CHENNAI',
  'DELHI',
  'GURGAON',
  'HYDERABAD',
  'INDIRANAGAR',
  'KOLKATA',
  'MUMBAI',
  'NOIDA',
  'PUNE',
  'INDIA',
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
  ['AMZN MKTP IN', 'AMAZON MARKETPLACE'],
  ['AMZN MKTP', 'AMAZON MARKETPLACE'],
  ['ETSYINC', 'ETSY'],
  ['STEAMGAMES', 'STEAM'],
  ['NYTIMES', 'NEW YORK TIMES'],
  ['PAYMENT THANK YOU', 'HDFC CARD PAYMENT'],
  ['APPLE.COM BILL ICLOUD', 'APPLE ICLOUD'],
  ['ADOBE CREATIVE CLOUD', 'ADOBE'],
  // Identity aliases: these would otherwise lose a meaningful trailing token.
  ['BOOKING.COM', 'BOOKING.COM'],
  ['HDFC CARD PAYMENT', 'HDFC CARD PAYMENT'],
  ['CROMA RETAIL', 'CROMA RETAIL'],
  ['TAJ HOTELS', 'TAJ HOTELS'],
  ['JIO FIBER', 'JIO FIBER'],
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
  [/^PAYTM WALLET (?:TO|FROM)\b/, 'PAYTM WALLET'],
  [/^GPAY\b/, 'GPAY'],
  [/^PHONEPE\b/, 'PHONEPE'],
  [/^INFOSYS LTD\b/, 'INFOSYS LTD'],
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

  // 0a. A narration built from rail fields: `NEFT CR-<IFSC>-<NAME>-<REF>`,
  //     `IMPS-<REF>-<NAME>-<BANK>`, `UPI-<NAME>-<VPA>-<IFSC>-<REF>`. The
  //     counterparty is one field among references, so it is picked out as a
  //     field before anything below reads the line as words.
  const fromFields = counterpartyField(value);
  if (fromFields) value = fromFields;

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

  // 3a. The payment rail, and the direction marker that trails it. Never the
  //     last token left: a line that is only "UPI" has nothing else to be.
  while (tokens.length > 1 && PAYMENT_RAILS.has(stripHyphens(tokens[0]))) {
    tokens = tokens.slice(1);
    while (tokens.length > 1 && RAIL_DIRECTIONS.has(stripHyphens(tokens[0]))) {
      tokens = tokens.slice(1);
    }
  }

  // 3b. A UPI address is kept on the transaction in its own column, and as part
  //     of the merchant key it would give the same person a different key on
  //     every app they paid from.
  if (tokens.length > 1) {
    const withoutVpa = tokens.filter((t) => !isVpaToken(t));
    if (withoutVpa.length > 0) tokens = withoutVpa;
  }

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

/**
 * A narration that opens with a payment rail and then separates its fields
 * with `-`, `/` or `*` — which is how Indian banks write NEFT, IMPS, RTGS, UPI
 * and NACH lines, sometimes behind SBI's `TO TRANSFER-` or `BY TRANSFER-`.
 */
const RAIL_NARRATION = new RegExp(
  `^(?:(?:TO|BY)\\s+TRANSFER\\s*-\\s*)?((?:${[...PAYMENT_RAILS].join('|')})\\b.*[-/*].*)$`,
);

/**
 * The counterparty field of a rail narration, or null when the line is not one.
 *
 * Splitting on `-` is only safe inside such a narration, where it is the field
 * separator: elsewhere it belongs to names like COCA-COLA and 7-ELEVEN. Within
 * one, every field that is not a name is dropped — the rail and its direction,
 * reference numbers, IFSC codes, masked card and account numbers, UPI
 * addresses — and the first field left is who the money went to or came from.
 * For an incoming NEFT that is the remitter, which is the counterparty; the
 * account holder's own name comes after it.
 */
function counterpartyField(value: string): string | null {
  const match = RAIL_NARRATION.exec(value.trim());
  if (!match) return null;

  const fields = match[1]
    .split(/\s*[-/*]\s*/)
    .map((field) => field.trim())
    .filter(Boolean);

  const isName = (field: string) => {
    const tokens = field.split(/\s+/);
    if (tokens.every((t) => PAYMENT_RAILS.has(t) || RAIL_DIRECTIONS.has(t))) return false;
    if (/^\d+$/.test(field) || isReferenceToken(field.replace(/\s+/g, ''))) return false;
    return !isVpaToken(field);
  };

  // Nothing but rails and references: the rail word is all the line can be
  // called, as for a bare "UPI".
  return fields.find(isName) ?? fields[0].split(/\s+/)[0];
}

/** Strips the hyphens a rail marker trails, so `D-` reads as `D`. */
function stripHyphens(token: string): string {
  return token.replace(/^-+|-+$/g, '');
}

/**
 * True for a token that is a UPI address.
 *
 * Uses the same reading as `services/parsing/upi.ts`, which is deliberately
 * strict about the difference between `ramesh@okaxis` and `care@phonepe.com`:
 * an email in a statement footer is not a payment address, and must not be
 * silently deleted from a merchant name.
 */
function isVpaToken(token: string): boolean {
  return parseVpa(token) !== null;
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
