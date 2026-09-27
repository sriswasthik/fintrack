/**
 * Dates as banks write them.
 *
 * Shared by every reader — CSV, PDF, the bank adapters — so `03/05/2026` means
 * the same thing whichever way the statement arrived.
 */

/** Which way round a numeric date is written: day first, or month first. */
export type DateOrder = 'dmy' | 'mdy';

/** How a file's date order was settled, so the preview can say when it was a guess. */
export type DateOrderBasis = 'mapping' | 'file' | 'default';

const NUMERIC = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;

/** A trailing time of day, which card and UPI exports often append to the date. */
const TIME_SUFFIX = /[\sT]+\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(\s*[AP]M)?(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Which way round the dates in a file are written, and whether the file
 * itself proved it.
 *
 * Settled from the whole file rather than row by row: any value above 12 in the
 * first position can only be a day, and a statement covering a month almost
 * always contains one. When nothing in the file settles it, the answer is
 * dd/mm — which is what an Indian bank means — and `basis` says it was assumed,
 * so the caller can ask rather than be quietly wrong. A file with no numeric
 * dates at all (ISO, or `15-Mar-2026`) has nothing to be wrong about, and
 * counts as settled.
 */
export function detectDateOrderFrom(values: string[]): {
  order: DateOrder;
  basis: 'file' | 'default';
} {
  let sawNumeric = false;
  let firstOver12 = false;
  let secondOver12 = false;
  for (const value of values) {
    const m = NUMERIC.exec(stripTime(value ?? ''));
    if (!m) continue;
    sawNumeric = true;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (firstOver12 && !secondOver12) return { order: 'dmy', basis: 'file' };
  if (secondOver12 && !firstOver12) return { order: 'mdy', basis: 'file' };
  return { order: 'dmy', basis: sawNumeric ? 'default' : 'file' };
}

/** `detectDateOrderFrom`, for a caller that only needs the answer. */
export function detectDateOrder(values: string[]): DateOrder {
  return detectDateOrderFrom(values).order;
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');

function stripTime(value: string): string {
  return value.trim().replace(TIME_SUFFIX, '');
}

/**
 * A date in any of the shapes a bank prints, as ISO `YYYY-MM-DD`.
 *
 * Takes `2026-03-15`, `2026/03/15`, `15/03/2026`, `15-03-26`, `15.03.2026`,
 * `15-Mar-2026`, `15 Mar 26`, with or without a trailing time. Numeric dates
 * are read in `order`, which the caller settles for the whole file. Returns
 * null for anything else, so the row is reported rather than coerced.
 */
export function parseStatementDate(value: string, order: DateOrder = 'dmy'): string | null {
  const trimmed = value ? stripTime(value) : '';
  if (!trimmed) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(trimmed);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 15-Mar-2026 and 15 Mar 2026, both common on Indian statements.
  const named = /^(\d{1,2})[\s-]([A-Za-z]{3,})[\s,-]+(\d{2}|\d{4})$/.exec(trimmed);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    if (month === 0) return null;
    return toIso(fullYear(named[3]), month, Number(named[1]));
  }

  const numeric = NUMERIC.exec(trimmed);
  if (numeric) {
    const [day, month] =
      order === 'dmy'
        ? [Number(numeric[1]), Number(numeric[2])]
        : [Number(numeric[2]), Number(numeric[1])];
    return toIso(fullYear(numeric[3]), month, day);
  }

  return null;
}

/** A two-digit year is this century: a bank statement is not from 1926. */
function fullYear(value: string): number {
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}
