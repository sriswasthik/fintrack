/**
 * Resolving which window a dashboard request covers, and what to compare it to.
 *
 * Pure date arithmetic, kept out of the controller so it can be tested without
 * a database or an HTTP request.
 *
 * Every window is half-open — `from` inclusive, `to` exclusive — which is the
 * only convention that gets month boundaries right without an off-by-one on the
 * last day.
 */

export interface Window {
  from: Date;
  to: Date;
}

const DAY_MS = 86400000;

export const utcDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
export const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
export const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);
export const toIsoMonth = (date: Date): string => date.toISOString().slice(0, 7);

/** The half-open window covering a YYYY-MM calendar month. */
export function monthWindow(month: string): Window {
  const [year, monthIndex] = month.split('-').map(Number);
  return {
    from: new Date(Date.UTC(year, monthIndex - 1, 1)),
    to: new Date(Date.UTC(year, monthIndex, 1)),
  };
}

/** The half-open window covering an inclusive from..to pair of ISO dates. */
export function rangeWindow(fromIso: string, toIso: string): Window {
  return { from: utcDate(fromIso), to: addDays(utcDate(toIso), 1) };
}

/**
 * The window to compare against.
 *
 * For a calendar month that is the previous calendar month, because that is what
 * "month over month" means to a reader — not "the previous 30 days", which would
 * make February look like a collapse every year.
 *
 * For a custom range it is the immediately preceding window of the same length,
 * so a 10-day range is compared with the 10 days before it.
 */
export function comparisonWindow(current: Window, month?: string): Window {
  if (month) {
    const [year, monthIndex] = month.split('-').map(Number);
    return {
      from: new Date(Date.UTC(year, monthIndex - 2, 1)),
      to: new Date(Date.UTC(year, monthIndex - 1, 1)),
    };
  }
  const lengthDays = Math.round((current.to.getTime() - current.from.getTime()) / DAY_MS);
  return { from: addDays(current.from, -lengthDays), to: current.from };
}

/** Percentage change against a baseline, or null when the baseline was zero. */
export function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}
