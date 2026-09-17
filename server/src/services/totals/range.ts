/**
 * Resolving which window a totals request covers.
 *
 * Three shapes, one half-open window: `from` inclusive, `to` exclusive, which
 * is the only convention that gets a month boundary right without an
 * off-by-one on the last day. The month and custom cases reuse Phase 5's
 * helpers rather than re-deriving the arithmetic, so a fix to one is a fix to
 * both.
 *
 * "This Quarter" is deliberately not a range kind. The client computes its
 * dates and asks for a custom range, because a quarter is just a range with a
 * name and a fourth server-side branch would be a fourth thing to keep in step
 * with the calendar.
 */
import {
  addDays,
  monthWindow,
  rangeWindow,
  toIsoDate,
  utcDate,
  type Window,
} from '../dashboard/window';

export const RANGE_KINDS = ['daily', 'monthly', 'custom'] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];

export interface RangeRequest {
  range: RangeKind;
  /** YYYY-MM-DD, for `daily`. */
  date?: string;
  /** YYYY-MM, for `monthly`. */
  month?: string;
  /** YYYY-MM-DD, for `custom`. */
  startDate?: string;
  /** YYYY-MM-DD, inclusive, for `custom`. */
  endDate?: string;
}

/** The window, plus the inclusive dates to echo back to the caller. */
export interface ResolvedRange extends Window {
  kind: RangeKind;
  /** Inclusive ISO start. */
  startDate: string;
  /** Inclusive ISO end — `to` minus a day, because `to` is exclusive. */
  endDate: string;
  /** The YYYY-MM asked for, on a monthly request only. */
  month: string | null;
}

/** Thrown for a combination zod cannot express as a single field rule. */
export class InvalidRangeError extends Error {}

/**
 * The window a request covers.
 *
 * Every branch requires its own fields rather than filling them in from the
 * clock: a totals figure with no stated range is a number nobody can check,
 * and "today" means different days either side of midnight UTC.
 */
export function resolveRange(request: RangeRequest): ResolvedRange {
  const window = windowFor(request);
  if (window.to <= window.from) {
    throw new InvalidRangeError('endDate must not be before startDate');
  }

  return {
    ...window,
    kind: request.range,
    startDate: toIsoDate(window.from),
    // Back to the inclusive last day, which is the one the caller named and
    // the one a UI should show.
    endDate: toIsoDate(addDays(window.to, -1)),
    month: request.range === 'monthly' ? (request.month ?? null) : null,
  };
}

function windowFor(request: RangeRequest): Window {
  switch (request.range) {
    case 'daily': {
      if (!request.date) throw new InvalidRangeError('date is required when range=daily');
      const from = utcDate(request.date);
      return { from, to: addDays(from, 1) };
    }
    case 'monthly': {
      if (!request.month) throw new InvalidRangeError('month is required when range=monthly');
      return monthWindow(request.month);
    }
    case 'custom': {
      if (!request.startDate || !request.endDate) {
        throw new InvalidRangeError('startDate and endDate are required when range=custom');
      }
      return rangeWindow(request.startDate, request.endDate);
    }
  }
}
