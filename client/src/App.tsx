import { Link, NavLink, Route, Routes } from 'react-router-dom';

import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/auth-context';
import { DashboardPage } from '@/pages/DashboardPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage, RegisterPage } from '@/pages/AuthPage';
import { ReviewPage } from '@/pages/ReviewPage';
import { SummaryPage } from '@/pages/SummaryPage';
import { TransactionsPage } from '@/pages/TransactionsPage';
import { UploadPage } from '@/pages/UploadPage';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/upload', label: 'Import' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/summary', label: 'Summary' },
  { to: '/review', label: 'Review' },
];

function Nav() {
  const { user, isRestoring, signOut } = useAuth();

  return (
    <nav className="border-b">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
        <Link to="/" className="font-semibold">
          FinTrack
        </Link>

        {/* The app's pages are only reachable with a session, so offering them
            to a signed-out visitor would just be a list of redirects. */}
        {user &&
          NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }
            >
              {item.label}
            </NavLink>
          ))}

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <>
              <span className="text-muted-foreground hidden sm:inline">{user.email}</span>
              <Button variant="ghost" size="sm" onClick={() => void signOut()}>
                Sign out
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

const protect = (element: React.ReactNode) => <ProtectedRoute>{element}</ProtectedRoute>;

export function App() {
  return (
    <div className="min-h-svh">
      <Nav />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route path="/dashboard" element={protect(<DashboardPage />)} />
        <Route path="/upload" element={protect(<UploadPage />)} />
        <Route path="/transactions" element={protect(<TransactionsPage />)} />
        <Route path="/summary" element={protect(<SummaryPage />)} />
        <Route path="/review" element={protect(<ReviewPage />)} />
      </Routes>
    </div>
  );
}

export default App;
