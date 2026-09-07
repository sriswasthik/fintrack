import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomePage } from '@/pages/HomePage';
import { fetchHealth } from '@/lib/health';

vi.mock('@/lib/health', () => ({
  fetchHealth: vi.fn(),
}));

const fetchHealthMock = vi.mocked(fetchHealth);

function renderWithQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('HomePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the status returned by GET /api/health', async () => {
    fetchHealthMock.mockResolvedValue({ status: 'ok' });

    renderWithQueryClient(<HomePage />);

    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByText('The client reached the API successfully.')).toBeInTheDocument();
    expect(fetchHealthMock).toHaveBeenCalledOnce();
  });

  it('shows an error state when the API cannot be reached', async () => {
    fetchHealthMock.mockRejectedValue(new Error('Network Error'));

    renderWithQueryClient(<HomePage />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('unreachable')).toBeInTheDocument();
  });
});
