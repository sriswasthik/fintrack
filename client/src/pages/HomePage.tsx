import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { DemoButton } from '@/components/DemoButton';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
import { API_BASE_URL } from '@/lib/api';
import { fetchHealth } from '@/lib/health';

const STEPS = [
  [
    'Import',
    'A CSV, Excel or PDF statement from your bank — or a quarter of them at once. Account details above the table, day-first dates and separate debit and credit columns are read as they are.',
  ],
  [
    'Categorize',
    'Deterministic rules settle the familiar merchants. A model sees only the names they could not, never a payment to a person, and every answer is checked against a fixed list.',
  ],
  [
    'Understand',
    'Where the month went, what changed, and what is coming up — with transfers between your own accounts left out and refunds netted against what they returned.',
  ],
];

const FEATURES = [
  [
    'Duplicates, never dropped',
    'Overlapping statements are flagged for you to decide, across every file in an import.',
  ],
  [
    'Corrections that stick',
    'Recategorize a merchant once and a rule is learned; a re-import never overwrites you.',
  ],
  [
    'Told what changed',
    'Price rises, new subscriptions and unusual charges, found by plain statistics.',
  ],
  [
    'EMIs, SIPs and salary',
    'Recurring commitments and your savings rate, read from the transactions themselves.',
  ],
];

/** Figures for the sample statement in the hero. Illustrative, and labelled so. */
const SAMPLE = [
  ['Shopping', 47219, 100],
  ['Housing', 32000, 68],
  ['Dining', 14620, 31],
  ['Travel', 9133, 19],
  ['Groceries', 8205, 17],
] as const;

const inr = (value: number) => `₹${value.toLocaleString('en-IN')}`;

/**
 * A small statement drawn in the app's own style: the product, shown rather
 * than described. Every figure is invented and the sheet says so.
 */
function SampleStatement() {
  return (
    <figure
      aria-label="A sample monthly statement, with invented figures"
      className="bg-card relative rounded-md border p-5 shadow-[0_24px_48px_-32px_rgb(29_28_26/0.45)] sm:p-6"
    >
      <div className="flex items-baseline justify-between border-b-[3px] border-double pb-3">
        <span className="font-display text-xl font-semibold tracking-tight">June 2026</span>
        <span className="eyebrow">Sample</span>
      </div>

      <dl className="grid grid-cols-3 gap-3 border-b py-4">
        {[
          ['Spent', '₹1,40,240', 'text-foreground'],
          ['Received', '₹2,00,283', 'text-positive'],
          ['Net', '+₹60,043', 'text-positive'],
        ].map(([label, value, tone]) => (
          <div key={label} className="min-w-0">
            <dt className="eyebrow">{label}</dt>
            <dd className={`truncate text-base font-medium tabular-nums sm:text-lg ${tone}`}>
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <ul className="space-y-2 pt-4" aria-hidden>
        {SAMPLE.map(([label, amount, width]) => (
          <li
            key={label}
            className="grid grid-cols-[5.5rem_1fr_auto] items-center gap-3 text-[13px]"
          >
            <span>{label}</span>
            <span className="relative h-2">
              <span
                className="bg-chart-1 absolute inset-y-0 left-0 rounded-r-[4px]"
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="tabular-nums">{inr(amount)}</span>
          </li>
        ))}
      </ul>

      <figcaption className="text-muted-foreground mt-4 border-t pt-3 text-xs">
        <span className="text-negative font-medium">Netflix</span> went up from ₹499 to ₹649 — about
        ₹1,800 more a year.
      </figcaption>
    </figure>
  );
}

/**
 * The landing page.
 *
 * It has two audiences and says something useful to each: a visitor with no
 * account needs to know what this is before being asked to make one, and a
 * signed-in person arriving at `/` should be pointed at their month rather than
 * shown marketing.
 */
export function HomePage() {
  const { user, isRestoring } = useAuth();
  const navigate = useNavigate();

  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth, retry: false });

  return (
    <main className="mx-auto flex max-w-6xl flex-col px-4 sm:px-6">
      <section className="grid items-center gap-10 py-12 sm:py-16 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14 lg:py-20">
        <div className="space-y-6">
          <p className="eyebrow">Personal finance for Indian bank statements</p>
          <h1 className="font-display text-[2.75rem] leading-[1.02] font-semibold tracking-tight sm:text-[3.75rem]">
            Where your money <em className="text-primary font-medium">actually</em> went.
          </h1>
          <p className="text-muted-foreground max-w-xl text-[1.0625rem] leading-relaxed">
            FinTrack reads a bank statement, works out what each charge was, and shows you the month
            — including the parts that are easy to get wrong: transfers between your own accounts,
            refunds against the thing they refunded, and one charge split across categories.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {isRestoring ? (
              <output aria-live="polite" className="text-muted-foreground text-sm">
                Restoring your session…
              </output>
            ) : user ? (
              <>
                <Button asChild size="lg">
                  <Link to="/dashboard">Open your dashboard</Link>
                </Button>
                <Button asChild variant="outline" size="lg">
                  <Link to="/upload">Import a statement</Link>
                </Button>
              </>
            ) : (
              <>
                <Button asChild size="lg">
                  <Link to="/register">Create an account</Link>
                </Button>
                <Button asChild variant="outline" size="lg">
                  <Link to="/login">Sign in</Link>
                </Button>
                <DemoButton />
              </>
            )}
          </div>

          {/* The shortest way in, when the deployment offers it. Renders
              nothing without a Google client id. */}
          {!isRestoring && !user && (
            <div className="max-w-xs">
              <GoogleSignInButton
                label="signup_with"
                onSignedIn={() => navigate('/dashboard', { replace: true })}
              />
            </div>
          )}

          <p className="text-muted-foreground text-sm">
            Reads CSV, Excel and PDF — HDFC, SBI and ICICI exports, and UPI app statements.
          </p>
        </div>

        <SampleStatement />
      </section>

      <section aria-labelledby="how" className="border-t py-12 sm:py-14">
        <h2 id="how" className="eyebrow mb-8">
          How it works
        </h2>
        <ol className="grid gap-8 md:grid-cols-3 md:gap-10">
          {STEPS.map(([title, description], i) => (
            <li key={title} className="space-y-3">
              <span className="text-muted-foreground font-mono text-sm">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display border-foreground border-t pt-3 text-2xl font-semibold tracking-tight">
                {title}
              </h3>
              <p className="text-muted-foreground leading-relaxed">{description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="features" className="border-t py-12 sm:py-14">
        <h2 id="features" className="eyebrow mb-6">
          What it gets right
        </h2>
        <dl className="grid sm:grid-cols-2">
          {FEATURES.map(([title, description], i) => (
            <div
              key={title}
              className="flex gap-4 border-b py-5 sm:odd:border-r sm:odd:pr-8 sm:even:pl-8"
            >
              <span className="text-muted-foreground pt-1 font-mono text-xs">
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="space-y-1">
                <dt className="font-display text-lg font-semibold tracking-tight">{title}</dt>
                <dd className="text-muted-foreground">{description}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section
        aria-label="Technology"
        className="flex flex-col gap-3 border-t py-8 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-muted-foreground font-mono text-xs">
          React 19 · TypeScript · Tailwind · Express 5 · Prisma · PostgreSQL · Claude API
        </p>

        {/* Kept from Phase 0: the fastest way to tell a misconfigured dev setup
            from a broken app. Quiet when everything is fine. */}
        <div className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="font-mono" title={API_BASE_URL}>
            API
          </span>
          {health.isPending ? (
            <output aria-live="polite">Checking API…</output>
          ) : health.isError ? (
            <span role="alert" className="flex items-center gap-2">
              <Badge variant="destructive">unreachable</Badge>
              <span>
                Is the server running, and does <code>VITE_API_BASE_URL</code> point at it?
              </span>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Badge variant="secondary">{health.data.status}</Badge>
              <span>Reachable.</span>
            </span>
          )}
        </div>
      </section>
    </main>
  );
}

export default HomePage;
