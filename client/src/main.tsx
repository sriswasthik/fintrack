import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

import App from '@/App';
import { AuthProvider } from '@/context/AuthContext';
import { GoogleAuthProvider } from '@/context/GoogleAuthProvider';
import './index.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        {/* Inside the router so the session can redirect, inside the query
            client so signing out can clear another account's cached data. */}
        <AuthProvider>
          {/* Outside nothing in particular — it only needs to enclose the
              buttons. Renders its children untouched when the build has no
              Google client id, so a deployment without one is unaffected. */}
          <GoogleAuthProvider>
            <App />
          </GoogleAuthProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
