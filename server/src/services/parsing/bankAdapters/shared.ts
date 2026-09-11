/**
 * Helpers the adapters share.
 *
 * Deliberately thin. An adapter exists because a format has its own rules, so
 * anything genuinely format-specific belongs in the adapter; what lives here is
 * the arithmetic every one of them would otherwise repeat.
 */
import { extractMerchant } from '../normalize';
import type { NormalizedRow } from './types';

/** An amount as a bank prints it: `1,23,456.78`, `(1,234.00)`, `-`, blank. */
export function money(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-') return null;

  const negated = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    // The marker goes first: strip the parens and the space ahead of it and
    // "9,371.92 (Cr)" becomes "9371.92Cr", where \b no longer sees a boundary.
    .replace(/\(\s*(?:cr|dr)\s*\)/gi, '')
    .replace(/\b(?:cr|dr)\b/gi, '')
    .replace(/[()₹$,\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negated ? -parsed : parsed;
}

/**
 * A VPA anywhere in a string: `name@bank`.
 *
 * The whole domain is captured, dots included, so an email address can be told
 * apart from a payment address. Matching only up to the first dot is not enough:
 * `care@phonepe.com` then yields `care@phonepe`, which is a support address
 * being filed as somebody's UPI id. A VPA handle has no dot in it.
 */
const VPA = /\b([a-z0-9][a-z0-9._-]{1,64})@([a-z][a-z0-9-]{1,32}(?:\.[a-z]{2,})*)\b/i;

export function findVpa(text: string): string | null {
  const match = VPA.exec(text);
  if (!match) return null;
  if (match[2].includes('.')) return null;
  return `${match[1]}@${match[2]}`.toLowerCase();
}

/**
 * Builds a row from the pieces every adapter ends up with.
 *
 * The merchant goes through the same normalizer every other source uses, so a
 * statement, a CSV and a UPI export all reduce a merchant to the same key —
 * which is what lets the rule engine, the duplicate check and the merchant
 * cache work across them.
 */
export function buildRow(input: {
  index: number;
  date: string;
  postedDate?: string | null;
  description: string;
  /** Debit-positive, like every other source. */
  amount: number;
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
  /**
   * What to derive the merchant key from, when the description is not it.
   *
   * A UPI export's description reads "Paid to Ramesh Kumar (T000…)", and
   * normalizing *that* gives a merchant key of "PAID TO RAMESH KUMAR" — which
   * matches nothing the same person's bank statement produced. The key has to
   * come from the counterparty alone, or a merchant is a different merchant
   * depending on which app exported it.
   */
  merchantFrom?: string;
}): NormalizedRow {
  const { rawMerchant, normalizedMerchant } = extractMerchant(input.merchantFrom ?? input.description);
  return {
    index: input.index,
    date: input.date,
    postedDate: input.postedDate ?? null,
    description: input.description,
    rawMerchant,
    normalizedMerchant,
    amount: input.amount,
    counterpartyRaw: input.counterpartyRaw ?? null,
    upiVpa: input.upiVpa ?? null,
  };
}
