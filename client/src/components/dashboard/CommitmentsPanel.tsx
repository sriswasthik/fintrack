import { Amount } from '@/components/Amount';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { asPercent, type DetectedEmi, type IndiaInsights } from '@/lib/india';

/**
 * Loans, EMIs and SIPs — the money that leaves every month whatever else happens.
 *
 * Two lists in one card on purpose. An instalment and a SIP are the same shape
 * — a fixed sum on a fixed day — and what a person wants to know is what they
 * add up to against what comes in. Splitting them across the page would make
 * that comparison something you have to do in your head.
 *
 * The remaining-tenure figure is the weakest inference in the phase and is
 * marked as such everywhere it appears: the word "est.", and the assumption
 * spelled out underneath in full rather than hidden behind a tooltip.
 */

function Row({
  merchant,
  amount,
  day,
  since,
  children,
}: {
  merchant: string;
  amount: number;
  day: number;
  since: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-3 first:pt-0 last:pb-0">
      {/* `flex-1 min-w-0` rather than wrapping: a row with a tenure estimate
          under it is tall, and a wrapping amount would drop below the caveat
          instead of staying in the column the other rows put it in. */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{merchant}</p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {ordinal(day)} of the month · since {since}
        </p>
        {children}
      </div>
      <Amount value={amount} direction="debit" className="shrink-0 text-sm font-medium" />
    </li>
  );
}

function Estimate({ emi }: { emi: DetectedEmi }) {
  if (!emi.estimate) return null;
  const { remainingMonths, assumedTenureMonths, projectedFinalMonth, caveat } = emi.estimate;

  return (
    <p className="text-muted-foreground mt-1 text-xs">
      <Badge variant="outline" className="mr-1.5 align-middle">
        est.
      </Badge>
      <span className="tabular-nums">~{remainingMonths}</span> left, to{' '}
      <span className="tabular-nums">{projectedFinalMonth}</span>, if this is a{' '}
      <span className="tabular-nums">{assumedTenureMonths}</span>-month loan.{' '}
      <span className="block italic">{caveat}</span>
    </p>
  );
}

const ordinal = (day: number): string => {
  const suffix =
    day % 10 === 1 && day !== 11
      ? 'st'
      : day % 10 === 2 && day !== 12
        ? 'nd'
        : day % 10 === 3 && day !== 13
          ? 'rd'
          : 'th';
  return `${day}${suffix}`;
};

export function CommitmentsPanel({ insights }: { insights: IndiaInsights }) {
  const loans = insights.loans.loans.filter((l) => l.active);
  const plans = insights.investments.plans.filter((p) => p.active);

  if (loans.length === 0 && plans.length === 0) return null;

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>Loans, EMIs and SIPs</CardTitle>
        <CardDescription>
          Fixed commitments found in your statements — the same amount on the same day, month after
          month.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {loans.length > 0 && (
          <section>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              Loans and EMIs
            </h3>
            <ul className="divide-y">
              {loans.map((emi) => (
                <Row
                  key={emi.merchant}
                  merchant={emi.merchant}
                  amount={emi.monthlyAmount}
                  day={emi.debitDay}
                  since={emi.firstSeen}
                >
                  <Estimate emi={emi} />
                </Row>
              ))}
            </ul>
            <Total
              label="Every month in instalments"
              amount={insights.loans.totalMonthly}
              share={insights.loans.shareOfIncome}
            />
          </section>
        )}

        {plans.length > 0 && (
          <section>
            <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
              Investments and SIPs
            </h3>
            <ul className="divide-y">
              {plans.map((sip) => (
                <Row
                  key={sip.merchant}
                  merchant={sip.merchant}
                  amount={sip.monthlyAmount}
                  day={sip.debitDay}
                  since={sip.firstSeen}
                />
              ))}
            </ul>
            <Total
              label="Every month into investments"
              amount={insights.investments.totalMonthly}
              share={insights.investments.shareOfIncome}
            />
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function Total({
  label,
  amount,
  share,
}: {
  label: string;
  amount: number;
  /** Null when no salary was found, in which case no share is claimed. */
  share: number | null;
}) {
  return (
    <p className="text-muted-foreground mt-3 flex flex-wrap items-baseline gap-x-2 border-t pt-3 text-xs">
      <span>{label}</span>
      <Amount value={amount} direction="debit" className="text-sm font-medium" />
      {share !== null && <span>· {asPercent(share)} of your monthly income</span>}
    </p>
  );
}

export default CommitmentsPanel;
