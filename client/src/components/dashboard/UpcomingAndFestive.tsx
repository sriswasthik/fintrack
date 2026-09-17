import { Amount } from '@/components/Amount';
import { Badge } from '@/components/ui/badge';
import type { FestiveNote, UpcomingBill } from '@/lib/india';

/**
 * Two additions to the insights panel, both of which have to be honest about
 * what they are.
 *
 * **Upcoming** is a prediction. Every row says "expected", the heading says
 * "Expected next", and a bill whose date the data cannot pin down is simply not
 * listed rather than given a made-up date. A prediction that does not land is a
 * mild annoyance; a date presented as certain and wrong is a reason not to
 * trust the app again.
 *
 * **The festive note** is an observation. It states what a category came to
 * against the person's own trailing median and which festive window the month
 * overlaps, and stops there — no verdict, no advice, and no claim that the
 * festival *caused* the spending, which is not something a bank statement can
 * know. The sentence comes from the server already written; it is rendered as
 * given rather than reassembled here, so there is one place the wording lives.
 */

export function UpcomingBills({
  bills,
  totalExpected,
}: {
  bills: UpcomingBill[];
  totalExpected: number;
}) {
  if (bills.length === 0) return null;

  return (
    <section className="border-t pt-3">
      <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
        Expected next
      </h3>

      <ul className="divide-y">
        {bills.map((bill) => (
          <li
            key={`${bill.merchant}-${bill.expectedDate}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">
                {bill.merchant}
                {/* Never stated as a fact, and the word carries it as well as
                    the heading does — a row read on its own still says so. */}
                {bill.confidence === 'medium' && (
                  <Badge variant="outline" className="ml-1.5 align-middle">
                    approx.
                  </Badge>
                )}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                expected {bill.expectedDate} · last charged {bill.lastCharged}
              </p>
            </div>
            <Amount value={bill.expectedAmount} direction="debit" className="text-sm" />
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span>{bills.length === 1 ? 'One bill' : `${bills.length} bills`} expected, totalling</span>
        <Amount value={totalExpected} direction="debit" className="text-xs font-medium" />
        <span>· predicted from past charges, not yet billed</span>
      </p>
    </section>
  );
}

/** Mirrors the server's labels so the list reads like the sentence above it. */
const CATEGORY_LABELS: Record<string, string> = {
  GIFTS_DONATIONS: 'gifts and donations',
  HEALTH_FITNESS: 'health and fitness',
  FEES_INTEREST: 'fees and interest',
};

const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category] ?? category.replace(/_/g, ' ').toLowerCase();

export function FestiveSpending({ note }: { note: FestiveNote }) {
  return (
    <section className="border-t pt-3">
      <h3 className="text-muted-foreground mb-2 flex flex-wrap items-center gap-2 text-xs font-medium tracking-wide uppercase">
        Festive season
        {note.windows.map((w) => (
          <Badge key={w.key} variant="secondary" className="normal-case">
            {w.label}
          </Badge>
        ))}
      </h3>

      {/* Rendered as the server wrote it. The wording is the feature, and
          reassembling it here would be a second place for the tone to drift. */}
      <p className="text-sm leading-snug">{note.note}</p>

      <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
        {note.categories.map((c) => (
          <li key={c.category} className="flex flex-wrap items-baseline gap-x-2">
            <span>{categoryLabel(c.category)}</span>
            <Amount value={c.amount} direction="debit" className="text-xs" />
            <span>
              vs a usual <Amount value={c.baseline} direction="debit" className="text-xs" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
