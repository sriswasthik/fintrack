import { Link, Route, Routes } from 'react-router-dom';

import { HomePage } from '@/pages/HomePage';
import { TransactionsPage } from '@/pages/TransactionsPage';
import { UploadPage } from '@/pages/UploadPage';

export function App() {
  return (
    <div className="min-h-svh">
      <nav className="border-b">
        <div className="mx-auto flex max-w-5xl items-center gap-4 p-4 text-sm">
          <Link to="/" className="font-semibold">
            FinTrack
          </Link>
          <Link to="/upload" className="text-muted-foreground hover:text-foreground">
            Import
          </Link>
          <Link to="/transactions" className="text-muted-foreground hover:text-foreground">
            Transactions
          </Link>
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
      </Routes>
    </div>
  );
}

export default App;
