/**
 * Person or business?
 *
 * A UPI-era statement is half shops and half people. "Paid to Swiggy" and
 * "Paid to Ramesh Kumar" arrive through the same rail, in the same shape, and
 * mean entirely different things: one is spending and the other is usually
 * settling up. Nothing upstream records which is which, because the bank does
 * not know either.
 *
 * This is a heuristic and is written to behave like one. It answers PERSON or
 * BUSINESS only on a signal it can point at, and UNKNOWN the rest of the time —
 * which, on ALL-CAPS bank narrations that have thrown away the capitalisation a
 * name is recognised by, is most of the time. That is the intended outcome:
 * PROJECT_CONTEXT.md §7 is explicit that nothing is guessed silently, and a
 * confident wrong answer here would mislabel a person as a merchant in a
 * feature built on the distinction.
 *
 * The signals, strongest first:
 *
 *   1. a merchant-only PSP suffix (`@okbizaxis`) — issued to businesses only
 *   2. a business word in the name (STORE, TRADERS, PVT LTD)
 *   3. a merchant a built-in rule already recognises
 *   4. a bare mobile number as the UPI handle — how a person's address is made
 *   5. a title-cased personal name of two or three words
 *
 * Order matters at 1-3 against 5: "Reliance Fresh" is two title-cased words and
 * is not a person.
 */
import { normalizeMerchant } from '../parsing/normalize';
import { parseVpa } from '../parsing/upi';
import { DEFAULT_RULES, MERCHANT_NAME_PRIORITIES } from './defaults';
import { matchRule, orderRules, type EngineRule } from './engine';

export type CounterpartyType = 'PERSON' | 'BUSINESS' | 'UNKNOWN';

/** What was decided, and the evidence for it. */
export interface CounterpartyVerdict {
  type: CounterpartyType;
  /** One short clause naming the signal that decided it. */
  reason: string;
  /** The cleaned-up name to show, with any `@psp` suffix stripped. */
  display: string;
}

/**
 * Words that only appear in the name of a business.
 *
 * Matched as whole words against the upper-cased name. Deliberately excludes
 * words that a person's name can contain — SINGH ENTERPRISES is a business,
 * but KUMAR and TRADING-as-a-verb are not evidence of anything.
 */
const BUSINESS_WORDS = [
  // Legal form
  'PVT',
  'PRIVATE',
  'LTD',
  'LIMITED',
  'LLP',
  'INC',
  'CORP',
  'CORPORATION',
  'COMPANY',
  'CO',
  'INDUSTRIES',
  'ASSOCIATES',
  'AND SONS',
  'SONS',
  // Trade
  'STORE',
  'STORES',
  'MART',
  'SUPERMARKET',
  'HYPERMARKET',
  'BAZAAR',
  'BAZAR',
  'KIRANA',
  'PROVISION',
  'PROVISIONS',
  'TRADERS',
  'TRADING',
  'ENTERPRISE',
  'ENTERPRISES',
  'AGENCIES',
  'AGENCY',
  'DISTRIBUTORS',
  'SUPPLIERS',
  'WHOLESALE',
  'RETAIL',
  'EMPORIUM',
  'COLLECTION',
  'COLLECTIONS',
  // Sector
  'RESTAURANT',
  'HOTEL',
  'CAFE',
  'BAKERY',
  'SWEETS',
  'DHABA',
  'CATERERS',
  'CATERING',
  'FOODS',
  'MESS',
  'CANTEEN',
  'MEDICAL',
  'MEDICALS',
  'PHARMACY',
  'CLINIC',
  'HOSPITAL',
  'DIAGNOSTICS',
  'LABS',
  'HARDWARE',
  'ELECTRICALS',
  'ELECTRONICS',
  'AUTOMOBILES',
  'MOTORS',
  'GARAGE',
  'GARMENTS',
  'TEXTILES',
  'FASHION',
  'JEWELLERS',
  'JEWELLERY',
  'SALON',
  'STUDIO',
  'ACADEMY',
  'INSTITUTE',
  'TRAVELS',
  'TOURS',
  'TRANSPORT',
  'LOGISTICS',
  'BUILDERS',
  'DEVELOPERS',
  'CONSULTANCY',
  'CONSULTANTS',
  'SERVICES',
  'SOLUTIONS',
  'TECHNOLOGIES',
  'COMMUNICATIONS',
  'STATIONERY',
  'FUELS',
  'PETROLEUM',
  'FILLING STATION',
];

const BUSINESS_WORD_PATTERN = new RegExp(
  `\\b(?:${BUSINESS_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})\\b`,
);

/** Honorifics that sit in front of a personal name without being part of it. */
const HONORIFICS = new Set(['MR', 'MRS', 'MS', 'DR', 'SHRI', 'SMT', 'SRI', 'PROF']);

/**
 * A name in the shape of a person's: two or three capitalised words, letters
 * only. "Ramesh Kumar" and "Anita R Nair" qualify; "RAMESH KUMAR" does not,
 * because a bank that upper-cases everything has destroyed the only signal.
 */
function looksLikePersonalName(raw: string): boolean {
  const words = raw
    .trim()
    .split(/\s+/)
    .filter((w) => !HONORIFICS.has(w.toUpperCase().replace(/\./g, '')));

  if (words.length < 2 || words.length > 3) return false;

  return words.every((word) => {
    // A middle initial is a name, "R." and "R" alike.
    const bare = word.replace(/\.$/, '');
    if (!/^[A-Z][a-z']*$/.test(bare)) return false;
    return bare.length >= 1;
  });
}

/**
 * The built-in rules that name a specific business, ordered once.
 *
 * Only the brand and disambiguator bands: a keyword or narration rule firing
 * says something about the *line*, not about who was on the other end of it.
 * Counting `\bEMI\b` or `\bATM\b` as merchant recognition labelled a cash
 * withdrawal — which has no counterparty at all — as a business.
 */
let orderedDefaults: EngineRule[] | null = null;
function merchantNameRules(): EngineRule[] {
  orderedDefaults ??= orderRules(
    DEFAULT_RULES.filter((rule) => MERCHANT_NAME_PRIORITIES.includes(rule.priority)).map(
      (rule, i) => ({
        id: `builtin-${String(i).padStart(4, '0')}`,
        pattern: rule.pattern,
        category: rule.category,
        priority: rule.priority,
        userId: null,
        learnedFromOverride: false,
      }),
    ),
  );
  return orderedDefaults;
}

export interface CounterpartyInput {
  /** The other party as the source named them, if the source named them. */
  counterpartyRaw?: string | null;
  /** The UPI address, if the source carried one. */
  upiVpa?: string | null;
  /** The normalized merchant key, used to recognise a known brand. */
  normalizedMerchant?: string | null;
}

export interface ClassifyOptions {
  /**
   * Overrides which merchants count as recognised. Defaults to the built-in
   * rule set; pass a user's own rules in as well to have their corrections
   * count.
   */
  isKnownMerchant?: (normalizedMerchant: string) => boolean;
}

/**
 * Decides whether the other side of a transaction is a person or a business.
 *
 * Every path returns a reason, because a heuristic nobody can audit is a
 * heuristic nobody should trust.
 */
export function classifyCounterparty(
  input: CounterpartyInput,
  options: ClassifyOptions = {},
): CounterpartyVerdict {
  const vpa = parseVpa(input.upiVpa);
  const name = (input.counterpartyRaw ?? '').trim();
  const display = name || vpa?.display || (input.normalizedMerchant ?? '').trim();
  const known =
    options.isKnownMerchant ??
    ((merchant: string) => matchRule(merchant, merchantNameRules()) !== null);

  // 1. A PSP that only issues to merchants settles it outright.
  if (vpa?.merchantPsp) {
    return { type: 'BUSINESS', reason: `Merchant-only UPI handle @${vpa.psp}`, display };
  }

  // 2. A business word in the name, wherever the name came from.
  const searchable = [name, vpa?.display ?? '', input.normalizedMerchant ?? '']
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  const businessWord = BUSINESS_WORD_PATTERN.exec(searchable);
  if (businessWord) {
    return { type: 'BUSINESS', reason: `Business word "${businessWord[0]}" in the name`, display };
  }

  // 3. A merchant the rule set already knows by name.
  const merchantKey = input.normalizedMerchant?.trim() || (name ? normalizeMerchant(name) : '');
  if (merchantKey && known(merchantKey)) {
    return { type: 'BUSINESS', reason: `${merchantKey} is a recognized merchant`, display };
  }

  // 4. A bare mobile number as the handle. Businesses are issued named
  //    addresses; a phone number is how an individual's address is made.
  if (vpa?.phoneHandle) {
    return { type: 'PERSON', reason: 'UPI handle is a mobile number', display };
  }

  // 5. A capitalised personal name — from the counterparty string, or from a
  //    `firstname.lastname` handle once its separators are opened out.
  if (name && looksLikePersonalName(name)) {
    return { type: 'PERSON', reason: 'Reads as a personal name', display };
  }
  if (vpa && vpa.display !== vpa.handle && looksLikePersonalName(vpa.display)) {
    return { type: 'PERSON', reason: `UPI handle "${vpa.handle}" reads as a personal name`, display };
  }

  return { type: 'UNKNOWN', reason: 'No signal either way', display };
}
