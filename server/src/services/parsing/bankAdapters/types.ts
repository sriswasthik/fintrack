/**
 * Statement adapters.
 *
 * Phase 12 reads a statement by geometry: rows from y, columns from x, and a
 * model when that will not settle it. That works, but it knows nothing about
 * who wrote the file — and the things worth knowing are bank-specific. SBI
 * prints two dates per row and means different things by them. A UPI app does
 * not print a table at all; it prints "Paid to Ramesh" and a VPA, and the VPA
 * is the most identifying thing in the row.
 *
 * An adapter is the place that knowledge lives. Each one recognises its own
 * format from the text and reads it on its own terms, and `detectSource` tries
 * them in turn. Nothing here replaces Phase 12: a file no adapter claims falls
 * through to the generic reader exactly as before, which is what keeps the
 * adapter list from being a list of the only banks that work.
 */
import type { ParsedRow } from '../csv';
import type { TextItemsByPage } from '../pdf';
import type { StatementLine } from '../statement';

/** Every source the adapters recognise, plus the honest answer. */
export type SourceId = 'sbi' | 'hdfc' | 'phonepe' | 'unknown';

/**
 * A row an adapter produced.
 *
 * `ParsedRow` plus the two things a bank statement cannot tell you and a UPI
 * export can: who the other party was, in their own words, and the address the
 * money moved to.
 */
export interface NormalizedRow extends ParsedRow {
  /**
   * The counterparty exactly as the source named them — "Ramesh Kumar" from a
   * "Paid to" line, or the narration from a bank row. Deliberately not run
   * through the merchant normalizer: a person is not a merchant, and the
   * normalizer's job is to make merchants comparable, not to tidy names.
   */
  counterpartyRaw?: string | null;
  /** `name@bank`, when the source carried one. */
  upiVpa?: string | null;
}

/** Everything an adapter is given to work from. */
export interface AdapterInput {
  /** The whole document as text, one statement line per line. */
  rawText: string;
  /** Lines with their geometry, for an adapter that wants columns. */
  lines: StatementLine[];
  /** The raw pages, for anything the two above have flattened away. */
  pages: TextItemsByPage;
}

export interface BankAdapter {
  id: Exclude<SourceId, 'unknown'>;
  /** Shown to the user on the import preview. */
  label: string;
  /**
   * Does this text come from this source?
   *
   * Deliberately cheap and deliberately strict. A signature that matches
   * loosely is worse than no adapter at all: the generic reader is a decent
   * fallback, and being read by the wrong adapter is not a fallback at all.
   */
  detectSignature(rawText: string): boolean;
  /** Reads the document on this format's terms. Returns [] if it cannot. */
  parse(input: AdapterInput): NormalizedRow[];
}
