/**
 * The adapter registry, and the one function that picks between them.
 */
import { hdfcAdapter } from './hdfc';
import { phonePeAdapter } from './phonepe';
import { sbiAdapter } from './sbi';
import type { AdapterInput, BankAdapter, NormalizedRow, SourceId } from './types';

export type { AdapterInput, BankAdapter, NormalizedRow, SourceId } from './types';
export { buildRow, findVpa, money } from './shared';

/**
 * Tried in order.
 *
 * The UPI app goes first because its signature is the most specific — it wants
 * both the brand and the block shape — and a bank statement can mention a UPI
 * id in a narration without being a UPI export.
 */
export const ADAPTERS: BankAdapter[] = [phonePeAdapter, hdfcAdapter, sbiAdapter];

/** A label for a source id, for the import screen. */
export function sourceLabel(id: SourceId): string {
  return ADAPTERS.find((a) => a.id === id)?.label ?? 'Unrecognised format';
}

/**
 * Which source wrote this document?
 *
 * Returns `unknown` when nothing claims it, which is not a failure: the caller
 * falls back to the Phase 12 generic reader, and that is what keeps the adapter
 * list from becoming the list of banks the app supports.
 */
export function detectSource(rawText: string): SourceId {
  for (const adapter of ADAPTERS) {
    if (adapter.detectSignature(rawText)) return adapter.id;
  }
  return 'unknown';
}

export interface AdapterResult {
  source: SourceId;
  label: string;
  rows: NormalizedRow[];
}

/**
 * Reads a document with whichever adapter claims it.
 *
 * Returns null when none does, or when the one that did came back with
 * nothing — a signature match that yields no rows means the file is from that
 * bank in a layout this adapter does not know, and the generic reader deserves
 * its turn rather than the import being declared empty.
 */
export function parseWithAdapter(input: AdapterInput): AdapterResult | null {
  const source = detectSource(input.rawText);
  if (source === 'unknown') return null;

  const adapter = ADAPTERS.find((a) => a.id === source)!;
  const rows = adapter.parse(input);
  return rows.length > 0 ? { source, label: adapter.label, rows } : null;
}
