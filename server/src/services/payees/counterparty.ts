/**
 * Who was on the other end of this line?
 *
 * Phase 14 answers *what kind* of counterparty a transaction has. This answers
 * *which one*, which is a harder question, because the merchant key deliberately
 * throws the answer away.
 *
 * `PAYTM WALLET TO SAM R` normalizes to `PAYTM WALLET`, and it has to: the rule
 * engine needs that key to categorize a wallet payment as a TRANSFER rather than
 * as spending (§8 case 9). But a ledger built on that key files Sam and Priya
 * and everyone else the user has ever paid through Paytm under one heading
 * called "PAYTM WALLET" — which is exactly the confusion the ledger exists to
 * undo. So the person is lifted out of the narration separately, and the
 * merchant key is left alone.
 *
 * Nothing here invents an identity. Where a narration carries only a reference
 * number (`GPAY PAYMENT 1039485`), there is no name in the string and none is
 * produced: that transaction gets the rail as its payee, which is honest, or no
 * payee at all.
 */
import { normalizeMerchant } from '../parsing/normalize';
import { parseVpa } from '../parsing/upi';
import { classifyCounterparty, type CounterpartyType } from '../rules/counterparty';

/** The fields payee resolution reads off a transaction. */
export interface CounterpartySource {
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
}

/** An identified counterparty, ready to become or match a `Payee`. */
export interface ResolvedCounterparty {
  /** The name as a person should read it. */
  displayName: string;
  /** Lower-cased, whitespace-collapsed: what two transactions are matched on. */
  matchKey: string;
  upiVpa: string | null;
  phone: string | null;
  type: CounterpartyType;
}

/**
 * Wallet and P2P narrations that name the other party in the line itself.
 *
 * Each captures the name and nothing else. Anchored at the start, because these
 * are prefixes a rail prints — a merchant genuinely called "Gpay Something" is
 * not what any of these are matching.
 */
const NAMED_COUNTERPARTY: RegExp[] = [
  // "PAYTM WALLET TO SAM R", "PAYTM WALLET FROM SAM R"
  /^PAYTM\s+WALLET\s+(?:TO|FROM)\s+(.+)$/i,
  // "PHONEPE*ARJUN M", "GPAY*MEENA S"
  /^(?:PHONEPE|GPAY|GOOGLE\s*PAY|BHIM)\s*[*/]\s*(.+)$/i,
  // "UPI TO RAMESH KUMAR", "UPI/TO/RAMESH KUMAR", "IMPS FROM ANITA NAIR" — the
  // rail word is stripped by the normalizer, but the raw description still
  // carries it, and the separator on either side of the direction word is
  // whatever the bank felt like: a space, a slash, or a dash.
  /^(?:UPI|IMPS|NEFT|RTGS)[\s*/-]+(?:TO|FROM)[\s*/-]+(.+)$/i,
  // "PAID TO ANAND SWEETS", "RECEIVED FROM RAMESH KUMAR" — the UPI-app phrasing
  // Phase 13's adapter produces when it has no separate counterparty field.
  /^(?:PAID\s+TO|MONEY\s+SENT\s+TO|RECEIVED\s+FROM|MONEY\s+RECEIVED\s+FROM)\s+(.+)$/i,
];

/**
 * Words that occupy the name position without being a name.
 *
 * `PHONEPE*REFUND` is the return leg of a payment, not a payee called Refund.
 * Filing it as one would invent a person and split a round trip across two
 * ledger entries.
 */
const NOT_A_NAME = new Set([
  'REFUND',
  'REFUNDS',
  'PAYMENT',
  'PAYMENTS',
  'RETURN',
  'REVERSAL',
  'CASHBACK',
  'RECHARGE',
  'TRANSFER',
  'SELF',
  'ADD MONEY',
  'WALLET',
  'TOPUP',
  'TOP UP',
]);

/** Collapses whitespace and trailing reference junk from a captured name. */
function tidy(name: string): string {
  return name
    .replace(/[*/|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A trailing reference number is not part of anybody's name.
    .replace(/\s+\d{4,}$/, '')
    .trim();
}

/**
 * Lifts the other party's name out of a narration, or returns null when the
 * line does not carry one.
 */
export function nameFromNarration(description: string): string | null {
  for (const pattern of NAMED_COUNTERPARTY) {
    const match = pattern.exec(description.trim());
    if (!match) continue;

    const name = tidy(match[1]);
    if (!name) continue;
    if (NOT_A_NAME.has(name.toUpperCase())) continue;
    // A capture that is only digits or a reference is not a name either.
    if (!/[A-Za-z]/.test(name)) continue;
    // A VPA on its own is handled by the address path, which keeps the suffix.
    if (parseVpa(name)) continue;
    return name;
  }
  return null;
}

/** The key two transactions must share to be the same payee. */
export function matchKeyFor(displayName: string): string {
  return displayName.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Works out which counterparty a transaction belongs to.
 *
 * The name is taken from the best source available, in this order:
 *
 *   1. `counterpartyRaw` — what a Phase 13 UPI adapter read off the export.
 *      The source said who this was; nothing here can improve on that.
 *   2. a name in the narration — the wallet and P2P forms above.
 *   3. the UPI address, with its `@bank` suffix stripped.
 *   4. the normalized merchant — for an ordinary shop, the merchant key *is*
 *      the counterparty, and it is already stable across statements.
 *
 * Returns null when none of those yields anything: a bank fee or an ATM
 * withdrawal has no counterparty, and inventing one would put a fictional
 * person in the ledger.
 */
export function resolveCounterparty(source: CounterpartySource): ResolvedCounterparty | null {
  const vpa = parseVpa(source.upiVpa);

  const fromNarration =
    nameFromNarration(source.description) ?? nameFromNarration(source.rawMerchant);

  const displayName =
    source.counterpartyRaw?.trim() ||
    fromNarration ||
    vpa?.display ||
    source.normalizedMerchant.trim();

  if (!displayName) return null;

  const { type } = classifyCounterparty({
    counterpartyRaw: source.counterpartyRaw ?? displayName,
    upiVpa: source.upiVpa,
    normalizedMerchant: source.normalizedMerchant,
    // Only when the narration is where the name actually came from: a shop that
    // happens to also have a counterparty string gets no such benefit.
    viaPersonToPersonRail: !source.counterpartyRaw?.trim() && fromNarration !== null,
  });

  return {
    displayName,
    matchKey: matchKeyFor(displayName),
    upiVpa: vpa?.vpa ?? null,
    phone: vpa?.phoneHandle ? vpa.handle : null,
    type,
  };
}

/**
 * Lines that get no payee at all.
 *
 * Cash out of an ATM has no other party — the money moved from an account to a
 * pocket. A bank fee's counterparty is the bank, which is not a relationship
 * anybody wants a running total of. Both would otherwise land as a payee named
 * after a narration fragment.
 */
export function hasNoCounterparty(category: string): boolean {
  return category === 'CASH_WITHDRAWAL' || category === 'FEES_INTEREST';
}

/** Re-exported so callers do not need two imports to read a verdict. */
export type { CounterpartyType };

/** Phase 15 stores two values where Phase 14 answers three. */
export function payeeTypeOf(type: CounterpartyType): 'PERSON' | 'BUSINESS' {
  // UNKNOWN is Phase 14's commonest honest answer, and the brief's `Payee.type`
  // has nowhere to put it. BUSINESS is the collapse, chosen because most
  // counterparties in a statement are shops and because a wrongly-labelled shop
  // is a smaller claim than a wrongly-invented person. It is a real loss of
  // information and the only place in the codebase that makes it.
  return type === 'PERSON' ? 'PERSON' : 'BUSINESS';
}

/** Exposed for the resolver's own use and for tests. */
export { normalizeMerchant };
