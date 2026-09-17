/**
 * The debit/credit convention, in one place.
 *
 * **Debit-positive**, the same convention the database, the payee ledger and
 * `/api/totals` use: money *leaving* is a positive number, money *arriving* is
 * negative. So a positive amount is a debit and shows red — the opposite of the
 * reflex that a minus sign means red.
 *
 * Getting this backwards would mis-colour every screen at once, so the
 * inference lives here and the `<Amount>` component is the only thing that
 * reads it.
 */

export type AmountDirection = 'debit' | 'credit';

/** Which way the money went. Zero is neither, and gets no colour and no sign. */
export function directionOf(value: number): AmountDirection | null {
  // Rounded to paise first, so an amount that only reaches a direction in the
  // third decimal place is not coloured on a difference nobody can see.
  const paise = Math.round(value * 100);
  if (paise > 0) return 'debit';
  if (paise < 0) return 'credit';
  return null;
}

export const AMOUNT_STYLE: Record<
  AmountDirection,
  { className: string; sign: string; label: string }
> = {
  // U+2212 MINUS SIGN, not a hyphen: it matches the digits in weight and width,
  // which a hyphen does not in a column of tabular figures.
  debit: { className: 'text-destructive', sign: '−', label: 'debit' },
  credit: { className: 'text-chart-positive', sign: '+', label: 'credit' },
};
