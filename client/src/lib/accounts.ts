import { api } from '@/lib/api';
import type { Account } from '@/lib/transactions';

/** Mirrors the Prisma `AccountType` enum. */
export const ACCOUNT_TYPES = ['CHECKING', 'SAVINGS', 'CREDIT_CARD'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * What each type is called in front of a person. "Checking" is the schema's
 * word; an Indian bank calls the same thing a savings or current account, so
 * the label says both.
 */
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  CHECKING: 'Savings / current account',
  SAVINGS: 'Second savings account',
  CREDIT_CARD: 'Credit card',
};

export async function createAccount(input: { name: string; type: AccountType }): Promise<Account> {
  const { data } = await api.post<{ account: Account }>('/api/accounts', input);
  return data.account;
}

export async function updateAccount(input: {
  id: string;
  name?: string;
  type?: AccountType;
}): Promise<Account> {
  const { id, ...changes } = input;
  const { data } = await api.patch<{ account: Account }>(`/api/accounts/${id}`, changes);
  return data.account;
}

export interface RemovalResult {
  removedTransactions: number;
  payeesRemoved: number;
}

export async function deleteAccount(id: string): Promise<RemovalResult> {
  const { data } = await api.delete<RemovalResult>(`/api/accounts/${id}`);
  return data;
}

export interface ImportRecord {
  id: string;
  account: { id: string; name: string };
  fileNames: string[];
  rowCount: number;
  /** Rows still present — fewer than rowCount once some have been removed. */
  remaining: number;
  from: string | null;
  to: string | null;
  createdAt: string;
}

export async function fetchImports(): Promise<ImportRecord[]> {
  const { data } = await api.get<{ imports: ImportRecord[] }>('/api/imports');
  return data.imports;
}

export async function undoImport(id: string): Promise<RemovalResult> {
  const { data } = await api.delete<RemovalResult>(`/api/imports/${id}`);
  return data;
}

/**
 * Every query whose answer changes when transactions come or go. Removing an
 * import or an account moves all of them, so they are invalidated together
 * rather than each caller remembering its own list.
 */
export const TRANSACTION_DERIVED_QUERIES = [
  'accounts',
  'imports',
  'transactions',
  'review-queue',
  'dashboard',
  'insights',
  'india',
  'totals',
  'payees',
  'payee',
  'summary',
  'budgets',
  'rules',
] as const;
