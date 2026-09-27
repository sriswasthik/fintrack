import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SplitDialog } from '@/components/SplitDialog';
import { splitTransaction, type Transaction } from '@/lib/transactions';

vi.mock('@/lib/transactions', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), splitTransaction: vi.fn() };
});

const splitTransactionMock = vi.mocked(splitTransaction);

const TRANSACTION: Transaction = {
  id: 'txn_1',
  accountId: 'acct_1',
  date: '2026-03-09',
  postedDate: '2026-03-11',
  description: 'TARGET 0002341',
  rawMerchant: 'TARGET 0002341',
  normalizedMerchant: 'TARGET',
  amount: 187.43,
  currency: 'INR',
  category: 'SHOPPING',
  confidence: 1,
  source: 'RULE',
  transferPairId: null,
  linkedRefundId: null,
  splits: [],
};

function renderDialog(transaction: Transaction | null = TRANSACTION, onSaved = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SplitDialog transaction={transaction} onOpenChange={vi.fn()} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onSaved };
}

/**
 * Replaces a field's value by typing over a selection of all of it.
 *
 * Not clear-then-type: those are two separate interactions, and on a loaded
 * machine the controlled input could re-render between them and put the old
 * value back, so the part ended up 187.43 instead of 100.
 */
async function setAmount(user: ReturnType<typeof userEvent.setup>, label: string, value: string) {
  const field = screen.getByLabelText(label) as HTMLInputElement;
  await user.type(field, value, {
    initialSelectionStart: 0,
    initialSelectionEnd: field.value.length,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  splitTransactionMock.mockResolvedValue({ ...TRANSACTION, splits: [] });
});

describe('SplitDialog', () => {
  it('renders nothing until a transaction is selected', () => {
    renderDialog(null);
    expect(screen.queryByText('Split this transaction')).not.toBeInTheDocument();
  });

  it('opens on the transaction with its whole amount allocated', async () => {
    renderDialog();

    expect(await screen.findByText('Split this transaction')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for part 1')).toHaveValue('187.43');
    expect(screen.getByRole('status')).toHaveTextContent('Allocated ₹187.43 of ₹187.43');
  });

  it('shows what is left to allocate while the parts do not sum', async () => {
    const user = userEvent.setup();
    renderDialog();

    await setAmount(user, 'Amount for part 1', '96.40');

    expect(screen.getByRole('status')).toHaveTextContent('₹91.03 left to allocate');
    expect(screen.getByRole('button', { name: 'Save split' })).toBeDisabled();
  });

  it('says when the parts exceed the total', async () => {
    const user = userEvent.setup();
    renderDialog();

    await setAmount(user, 'Amount for part 2', '50');

    expect(screen.getByRole('status')).toHaveTextContent('₹50.00 over the total');
    expect(screen.getByRole('button', { name: 'Save split' })).toBeDisabled();
  });

  it('will not save a one-cent discrepancy', async () => {
    const user = userEvent.setup();
    renderDialog();

    await setAmount(user, 'Amount for part 1', '187.42');

    expect(screen.getByRole('button', { name: 'Save split' })).toBeDisabled();
    expect(splitTransactionMock).not.toHaveBeenCalled();
  });

  it('enables saving once the parts sum exactly', async () => {
    const user = userEvent.setup();
    renderDialog();

    await setAmount(user, 'Amount for part 1', '96.40');
    await setAmount(user, 'Amount for part 2', '91.03');

    expect(screen.getByRole('status')).toHaveTextContent('Allocated ₹187.43 of ₹187.43');
    expect(screen.getByRole('button', { name: 'Save split' })).toBeEnabled();
  });

  it('sends the parts to the server and reports success', async () => {
    const user = userEvent.setup();
    const { onSaved } = renderDialog();

    await setAmount(user, 'Amount for part 1', '96.40');
    await setAmount(user, 'Amount for part 2', '91.03');
    await user.type(screen.getByLabelText('Note for part 1'), 'Weekly food shop');
    await user.click(screen.getByRole('button', { name: 'Save split' }));

    await vi.waitFor(() => expect(splitTransactionMock).toHaveBeenCalledTimes(1));
    expect(splitTransactionMock.mock.calls[0][0]).toEqual({
      transactionId: 'txn_1',
      splits: [
        { category: 'SHOPPING', amount: 96.4, note: 'Weekly food shop' },
        { category: 'UNCATEGORIZED', amount: 91.03 },
      ],
    });
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('adds a new part pre-filled with the outstanding remainder', async () => {
    const user = userEvent.setup();
    renderDialog();

    await setAmount(user, 'Amount for part 1', '100');
    await user.click(screen.getByRole('button', { name: 'Add part' }));

    expect(screen.getByLabelText('Amount for part 3')).toHaveValue('87.43');
  });

  it('keeps at least two parts', async () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Remove part 1' })).toBeDisabled();
  });

  it('loads an existing split for editing', async () => {
    renderDialog({
      ...TRANSACTION,
      splits: [
        { id: 's1', category: 'GROCERIES', amount: 96.4, note: 'Food' },
        { id: 's2', category: 'SHOPPING', amount: 91.03, note: null },
      ],
    });

    expect(await screen.findByLabelText('Amount for part 1')).toHaveValue('96.40');
    expect(screen.getByLabelText('Note for part 1')).toHaveValue('Food');
    expect(screen.getByRole('button', { name: 'Save split' })).toBeEnabled();
  });

  it('surfaces the server rejecting a split', async () => {
    splitTransactionMock.mockRejectedValue({
      response: { data: { error: 'Split amounts must sum to the transaction total' } },
    });

    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Save split' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Split amounts must sum to the transaction total',
    );
  });
});
