import { lazy, Suspense } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';

import { DemoBanner } from '@/components/DemoBanner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Loading } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
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

function Nav() {
  const { user, isRestoring, isDemo, signOut } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground';

  return (
    <nav className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
        <Link to="/" className="font-semibold">
          FinTrack
        </Link>

        {/* The app's pages are only reachable with a session, so offering them
            to a signed-out visitor would just be a list of redirects. */}
        {user &&
          NAV.filter((item) => !(isDemo && item.writes)).map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <>
              <span className="text-muted-foreground hidden sm:inline">
                {isDemo ? 'Sample account' : user.email}
              </span>
              <NavLink to="/settings" className={linkClass}>
                Settings
              </NavLink>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                {isDemo ? 'Leave demo' : 'Sign out'}
              </Button>
            </>
          ) : (
            !isRestoring && (
              <>
                <NavLink to="/login" className="text-muted-foreground hover:text-foreground">
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
    </nav>
  );
}

const protect = (element: React.ReactNode, writes = false) => (
  <ProtectedRoute writes={writes}>{element}</ProtectedRoute>
);

export function App() {
  const location = useLocation();

  return (
    <div className="min-h-svh">
      <Nav />
      <DemoBanner />
      {/* Keyed on the path, so leaving a page that failed to render is enough
          to recover from it. */}
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
  );
}

export default App;
