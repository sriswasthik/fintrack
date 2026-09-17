import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CommitmentsPanel } from '@/components/dashboard/CommitmentsPanel';
import { SavingsRate } from '@/components/dashboard/SavingsRate';
import { FestiveSpending, UpcomingBills } from '@/components/dashboard/UpcomingAndFestive';
import type { FestiveNote, IndiaInsights, UpcomingBill } from '@/lib/india';

const MINUS = '−';

const insights = (over: Partial<IndiaInsights> = {}): IndiaInsights => ({
  month: '2026-08',
  salary: {
    payer: 'INFOSYS LTD',
    monthlyAmount: 120908.34,
    payDay: 15,
    creditsPerMonth: 2,
    months: [],
    presentInMonth: true,
    lastPaidMonth: '2026-08',
  },
  savings: { month: '2026-08', income: 120000, expense: 90000, saved: 30000, rate: 0.25 },
  loans: {
    loans: [
      {
        merchant: 'BAJAJ FINANCE EMI',
        monthlyAmount: 18450,
        debitDay: 5,
        firstSeen: '2026-03-05',
        lastSeen: '2026-08-05',
        instalmentsObserved: 6,
        active: true,
        nextInstalment: '2026-09-05',
        estimate: {
          assumedTenureMonths: 9,
          remainingMonths: 3,
          projectedFinalMonth: '2026-11',
          caveat: 'Estimate only. Assumes this loan began with the first instalment.',
        },
      },
    ],
    totalMonthly: 18450,
    shareOfIncome: 0.153,
  },
  investments: {
    plans: [
      {
        merchant: 'ZERODHA COIN SIP',
        monthlyAmount: 5000,
        debitDay: 7,
        firstSeen: '2026-03-07',
        lastSeen: '2026-08-07',
        contributionsObserved: 6,
        active: true,
      },
    ],
    totalMonthly: 5000,
    shareOfIncome: 0.041,
  },
  upcoming: { bills: [], totalExpected: 0 },
  festive: null,
  ...over,
});

describe('the savings rate', () => {
  it('leads with the percentage kept', () => {
    render(<SavingsRate savings={insights().savings} />);

    expect(screen.getByText('Savings rate')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  it('colours a negative rate, because the sign is a fact', () => {
    const savings = {
      month: '2026-08',
      income: 100000,
      expense: 130000,
      saved: -30000,
      rate: -0.3,
    };
    render(<SavingsRate savings={savings} />);
    expect(screen.getByText(`${MINUS}30%`)).toHaveClass('text-destructive');
  });

  it('does not say a deficit month "kept" anything', () => {
    // "Kept −₹30,000" is not a sentence anybody means.
    const savings = {
      month: '2026-08',
      income: 100000,
      expense: 130000,
      saved: -30000,
      rate: -0.3,
    };
    const { container } = render(<SavingsRate savings={savings} />);

    expect(screen.getByText(/more went out than came in/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/kept/);
  });

  it('says what was kept when there was something to keep', () => {
    render(<SavingsRate savings={insights().savings} />);
    expect(screen.getByText(/kept/)).toBeInTheDocument();
    expect(screen.getByText('+₹30,000.00')).toHaveClass('text-chart-positive');
  });

  it('does not pass judgement on a low but positive rate', () => {
    // There is no universal right savings rate. A red badge for 4% would be the
    // app telling somebody off about their month.
    const savings = { month: '2026-08', income: 100000, expense: 96000, saved: 4000, rate: 0.04 };
    render(<SavingsRate savings={savings} />);
    expect(screen.getByText('4%')).not.toHaveClass('text-destructive');
  });

  it('says there is no rate rather than showing zero', () => {
    const savings = { month: '2026-09', income: 0, expense: 8000, saved: -8000, rate: null };
    render(<SavingsRate savings={savings} />);

    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/No income recorded this month yet/)).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});

describe('loans, EMIs and SIPs', () => {
  it('lists each commitment with its amount, day and first sighting', () => {
    render(<CommitmentsPanel insights={insights()} />);

    const row = screen.getByText('BAJAJ FINANCE EMI').closest('li')!;
    expect(within(row).getByText(`${MINUS}₹18,450.00`)).toHaveClass('text-destructive');
    expect(within(row).getByText(/5th of the month · since 2026-03-05/)).toBeInTheDocument();
  });

  it('marks the remaining tenure as an estimate and shows the assumption', () => {
    render(<CommitmentsPanel insights={insights()} />);

    expect(screen.getByText('est.')).toBeInTheDocument();
    expect(screen.getByText(/if this is a/)).toBeInTheDocument();
    // The caveat is shown in full, not hidden behind a tooltip.
    expect(screen.getByText(/^Estimate only\./)).toBeInTheDocument();
  });

  it('shows what the commitments take of monthly income', () => {
    render(<CommitmentsPanel insights={insights()} />);
    expect(screen.getByText('· 15% of your monthly income')).toBeInTheDocument();
    expect(screen.getByText('· 4% of your monthly income')).toBeInTheDocument();
  });

  it('claims no share when no salary was found', () => {
    const data = insights();
    render(
      <CommitmentsPanel
        insights={{
          ...data,
          salary: null,
          loans: { ...data.loans, shareOfIncome: null },
          investments: { ...data.investments, shareOfIncome: null },
        }}
      />,
    );
    expect(screen.queryByText(/of your monthly income/)).not.toBeInTheDocument();
  });

  it('renders nothing at all when there is nothing to report', () => {
    const { container } = render(
      <CommitmentsPanel
        insights={insights({
          loans: { loans: [], totalMonthly: 0, shareOfIncome: null },
          investments: { plans: [], totalMonthly: 0, shareOfIncome: null },
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves a finished loan out of the list', () => {
    const data = insights();
    render(
      <CommitmentsPanel
        insights={{
          ...data,
          loans: { ...data.loans, loans: [{ ...data.loans.loans[0], active: false }] },
        }}
      />,
    );
    expect(screen.queryByText('BAJAJ FINANCE EMI')).not.toBeInTheDocument();
  });
});

describe('upcoming bills', () => {
  const bills: UpcomingBill[] = [
    {
      merchant: 'JIO FIBER',
      category: 'UTILITIES',
      expectedDate: '2026-09-05',
      expectedAmount: 899,
      lastCharged: '2026-08-05',
      cadenceDays: 31,
      expectedDay: 5,
      confidence: 'high',
      observations: 6,
    },
    {
      merchant: 'BESCOM',
      category: 'UTILITIES',
      expectedDate: '2026-09-08',
      expectedAmount: 1400,
      lastCharged: '2026-08-08',
      cadenceDays: 31,
      expectedDay: 8,
      confidence: 'medium',
      observations: 5,
    },
  ];

  it('says every date is expected, never due', () => {
    render(<UpcomingBills bills={bills} totalExpected={2299} />);

    expect(screen.getByText('Expected next')).toBeInTheDocument();
    expect(screen.getByText(/expected 2026-09-05/)).toBeInTheDocument();
    expect(screen.getByText(/predicted from past charges, not yet billed/)).toBeInTheDocument();
    // No row anywhere calls a prediction a due date.
    expect(screen.queryByText(/\bdue\b/i)).not.toBeInTheDocument();
  });

  it('marks a loose cadence so a row read on its own still says so', () => {
    render(<UpcomingBills bills={bills} totalExpected={2299} />);
    const bescom = screen.getByText('BESCOM').closest('li')!;
    expect(within(bescom).getByText('approx.')).toBeInTheDocument();

    const jio = screen.getByText(/JIO FIBER/).closest('li')!;
    expect(within(jio).queryByText('approx.')).not.toBeInTheDocument();
  });

  it('renders nothing when nothing is confidently coming', () => {
    const { container } = render(<UpcomingBills bills={[]} totalExpected={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the festive note', () => {
  const note: FestiveNote = {
    month: '2026-09',
    windows: [
      {
        key: 'dussehra-diwali',
        label: 'Dussehra and Diwali',
        months: [9, 10, 11],
        description: 'the Dussehra and Diwali period, when most large online sales run',
      },
    ],
    categories: [
      {
        category: 'SHOPPING',
        amount: 45008.4,
        baseline: 30057.11,
        ratio: 0.497,
        difference: 14951.29,
      },
    ],
    totalAbove: 14951.29,
    baselineMonths: 6,
    note: 'In September 2026, shopping came to ₹45,008.40 against a usual ₹30,057.11 — ₹14,951.29 more than your own six-month median across those categories. September 2026 overlaps the Dussehra and Diwali period.',
  };

  it('renders the sentence the server wrote, unchanged', () => {
    // One place the wording lives. Reassembling it here would be a second place
    // for the tone to drift.
    render(<FestiveSpending note={note} />);
    expect(screen.getByText(note.note)).toBeInTheDocument();
  });

  it('names the window it overlaps', () => {
    render(<FestiveSpending note={note} />);
    expect(screen.getByText('Dussehra and Diwali')).toBeInTheDocument();
  });

  it("shows each category against the person's own usual figure", () => {
    render(<FestiveSpending note={note} />);
    expect(screen.getByText('shopping')).toBeInTheDocument();
    expect(screen.getByText(`${MINUS}₹45,008.40`)).toBeInTheDocument();
    expect(screen.getByText(`${MINUS}₹30,057.11`)).toBeInTheDocument();
  });

  it('never tells anybody off', () => {
    const { container } = render(<FestiveSpending note={note} />);
    expect(container.textContent).not.toMatch(
      /overspen|too much|excessive|should|careful|unusually|warning|!/i,
    );
  });
});
