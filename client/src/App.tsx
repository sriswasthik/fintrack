import { Link, Route, Routes } from 'react-router-dom';

import { HomePage } from '@/pages/HomePage';
import { DashboardPage } from '@/pages/DashboardPage';
import { ReviewPage } from '@/pages/ReviewPage';
import { SummaryPage } from '@/pages/SummaryPage';
import { TransactionsPage } from '@/pages/TransactionsPage';
import { UploadPage } from '@/pages/UploadPage';

export function App() {
  return (
    <div className="min-h-svh">
      <nav className="border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 p-4 text-sm">
          <Link to="/" className="font-semibold">
            FinTrack
          </Link>
          <Link to="/dashboard" className="text-muted-foreground hover:text-foreground">
            Dashboard
          </Link>
          <Link to="/upload" className="text-muted-foreground hover:text-foreground">
            Import
          </Link>
          <Link to="/transactions" className="text-muted-foreground hover:text-foreground">
            Transactions
          </Link>
          <Link to="/summary" className="text-muted-foreground hover:text-foreground">
            Summary
          </Link>
          <Link to="/review" className="text-muted-foreground hover:text-foreground">
            Review
          </Link>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/summary" element={<SummaryPage />} />
        <Route path="/review" element={<ReviewPage />} />
      </Routes>
    </div>
  );
}

export default App;
