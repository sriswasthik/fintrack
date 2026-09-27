import { lazy, Suspense } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { DemoBanner } from '@/components/DemoBanner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
import { cn } from '@/lib/utils';
import { HomePage } from '@/pages/HomePage';
import { LoginPage, RegisterPage } from '@/pages/AuthPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { ForgotPasswordPage, ResetPasswordPage } from '@/pages/PasswordResetPages';

/*
 * The signed-in pages are loaded on first visit rather than in the first
 * download. The landing and sign-in pages are what a stranger sees first, and
 * they should not wait for Recharts, the PDF import flow and every table in
 * the app — which together were a single 930 kB bundle.
 */
const BudgetsPage = lazy(() => import('@/pages/BudgetsPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const PayeesPage = lazy(() => import('@/pages/PayeesPage'));
const ReviewPage = lazy(() => import('@/pages/ReviewPage'));
const RulesPage = lazy(() => import('@/pages/RulesPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const SummaryPage = lazy(() => import('@/pages/SummaryPage'));
const TransactionsPage = lazy(() => import('@/pages/TransactionsPage'));
const UploadPage = lazy(() => import('@/pages/UploadPage'));

/**
 * `writes: true` marks a page whose whole purpose is to change something. A
 * demo session is refused those by the server, so offering them would be
 * offering a 403.
 */
const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/upload', label: 'Import', writes: true },
  { to: '/transactions', label: 'Transactions' },
  { to: '/payees', label: 'People & Businesses' },
  { to: '/budgets', label: 'Budgets' },
  { to: '/summary', label: 'Summary' },
  { to: '/review', label: 'Review', writes: true },
];

/**
 * The masthead: a serif wordmark, the pages, and a double rule underneath, the
 * way a ledger's heading is ruled off from its entries.
 */
function Nav() {
  const { user, isRestoring, isDemo, signOut } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'shrink-0 py-1 text-sm transition-colors',
      isActive
        ? 'text-foreground font-medium underline decoration-2 underline-offset-[7px]'
        : 'text-muted-foreground hover:text-foreground',
    );

  return (
    <header className="border-rule bg-background border-b-[3px] border-double">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
        <Link to="/" className="flex items-baseline gap-2">
          <span className="font-display text-[1.375rem] leading-none font-semibold tracking-tight">
            FinTrack
          </span>
          {/* With the pages beside it on a wide screen there is no room for the
              tagline too; everywhere else there is. */}
          <span className={cn('eyebrow hidden md:inline', user && 'xl:hidden')}>
            Personal ledger
          </span>
        </Link>

        {/* The app's pages are only reachable with a session, so offering them
            to a signed-out visitor would just be a list of redirects. On a
            narrow screen they take a row of their own and scroll sideways. */}
        {user && (
          <nav
            aria-label="Main"
            className="order-last -mx-4 flex w-[calc(100%+2rem)] items-center gap-5 overflow-x-auto px-4 xl:order-none xl:mx-0 xl:w-auto xl:px-0"
          >
            {NAV.filter((item) => !(isDemo && item.writes)).map((item) => (
              <NavLink key={item.to} to={item.to} className={linkClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          {user ? (
            <>
              <span className="text-muted-foreground hidden max-w-48 truncate px-1 text-sm lg:inline xl:hidden">
                {isDemo ? 'Sample account' : user.email}
              </span>
              <NavLink to="/settings" className={(state) => cn(linkClass(state), 'px-1')}>
                Settings
              </NavLink>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                {isDemo ? 'Leave demo' : 'Sign out'}
              </Button>
            </>
          ) : (
            !isRestoring && (
              <>
                <NavLink to="/login" className={(state) => cn(linkClass(state), 'px-2')}>
                  Sign in
                </NavLink>
                <Button asChild size="sm">
                  <Link to="/register">Create account</Link>
                </Button>
              </>
            )
          )}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t">
      <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col gap-1 px-4 py-6 text-xs sm:flex-row sm:justify-between sm:px-6">
        <p>
          <span className="font-display text-foreground text-sm font-semibold">FinTrack</span> — a
          personal ledger for Indian bank statements.
        </p>
        <p>
          <a
            href="https://github.com/sriswasthik/fintrack"
            className="hover:text-foreground underline underline-offset-4"
          >
            Source on GitHub
          </a>
        </p>
      </div>
    </footer>
  );
}

const protect = (element: React.ReactNode, writes = false) => (
  <ProtectedRoute writes={writes}>{element}</ProtectedRoute>
);

export function App() {
  const location = useLocation();

  return (
    <div className="flex min-h-svh flex-col">
      <Nav />
      <DemoBanner />
      {/* Keyed on the path, so leaving a page that failed to render is enough
          to recover from it. The wrapper is what lets each page's centred
          column take the full width inside the flex column around it. */}
      <div className="w-full flex-1">
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />

              <Route path="/dashboard" element={protect(<DashboardPage />)} />
              <Route path="/upload" element={protect(<UploadPage />, true)} />
              <Route path="/transactions" element={protect(<TransactionsPage />)} />
              <Route path="/payees" element={protect(<PayeesPage />)} />
              <Route path="/budgets" element={protect(<BudgetsPage />)} />
              <Route path="/summary" element={protect(<SummaryPage />)} />
              <Route path="/review" element={protect(<ReviewPage />, true)} />
              <Route path="/rules" element={protect(<RulesPage />)} />
              <Route path="/settings" element={protect(<SettingsPage />)} />

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </div>
      <Footer />
    </div>
  );
}

export default App;
