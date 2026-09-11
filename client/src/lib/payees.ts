import { api } from '@/lib/api';
import type { Category } from '@/lib/transactions';

/**
 * Whether the counterparty is a human being or a business.
 *
 * The server stores two values where Phase 14's classifier answers three, so a
 * BUSINESS here means "a business, or not enough in the name to tell" — see
 * `server/src/services/payees/counterparty.ts`.
 */
export type PayeeType = 'PERSON' | 'BUSINESS';

export interface Payee {
  id: string;
  displayName: string;
  upiVpa: string | null;
  phone: string | null;
  type: PayeeType;
  /** Total that left the account towards this payee. */
  paid: number;
  /** Total that arrived from this payee. */
  received: number;
  /** `paid - received`. Positive: you are out of pocket with them. */
  net: number;
  transactions: number;
  lastTransactionAt: string | null;
  firstTransactionAt: string | null;
}

export interface PayeeTransaction {
  id: string;
  accountId: string;
  accountName: string;
  date: string;
  description: string;
  normalizedMerchant: string;
  amount: number;
  category: Category;
  direction: 'paid' | 'received';
}

export interface PayeeDetail extends Payee {
  transactionHistory: PayeeTransaction[];
}

/** The columns the ledger can be ordered by. Mirrors `PAYEE_SORTS` on the server. */
export const PAYEE_SORTS = [
  { value: 'net', label: 'Net' },
  { value: 'paid', label: 'Paid' },
  { value: 'received', label: 'Received' },
  { value: 'transactions', label: 'Transactions' },
  { value: 'lastTransactionAt', label: 'Most recent' },
  { value: 'name', label: 'Name' },
] as const;

export type PayeeSort = (typeof PAYEE_SORTS)[number]['value'];
export type SortDirection = 'asc' | 'desc';

export interface PayeeListParams {
  q?: string;
  sort?: PayeeSort;
  direction?: SortDirection;
}

export async function fetchPayees(params: PayeeListParams = {}): Promise<Payee[]> {
  const { data } = await api.get<{ payees: Payee[] }>('/api/payees', { params });
  return data.payees;
}

export async function fetchPayee(id: string): Promise<PayeeDetail> {
  const { data } = await api.get<{ payee: PayeeDetail }>(`/api/payees/${id}`);
  return data.payee;
}
