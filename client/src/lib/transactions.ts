import { api } from '@/lib/api';

export interface Account {
  id: string;
  name: string;
  type: string;
}

export type DuplicateKind = 'existing' | 'in-file';

export interface DuplicateMatch {
  kind: DuplicateKind;
  existingTransactionId?: string;
  matchesRowIndex?: number;
  existingDate: string;
  reason: string;
}

export interface PreviewRow {
  index: number;
  date: string;
  postedDate: string | null;
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  amount: number;
  duplicate: DuplicateMatch | null;
}

export interface RowError {
  index: number;
  reason: string;
}

export type AmountSign = 'debit-positive' | 'credit-positive';

export interface ColumnMapping {
  date: string;
  description: string;
  amount: string;
  postedDate?: string;
  amountSign: AmountSign;
}

export interface UploadPreview {
  status: 'preview';
  fileName: string;
  accountId: string;
  preset: string | null;
  headers: string[];
  mapping: ColumnMapping;
  totalRows: number;
  duplicateCount: number;
  skippedRows: RowError[];
  rows: PreviewRow[];
}

export interface NeedsMapping {
  status: 'needs-mapping';
  fileName: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  requiredFields: string[];
  knownPresets: { id: string; label: string; columns: string[] }[];
}

export type UploadResponse = UploadPreview | NeedsMapping;

export type Resolution = 'keep' | 'skip';

export interface CommitResult {
  accountId: string;
  imported: number;
  skipped: number;
}

export async function fetchAccounts(): Promise<Account[]> {
  const { data } = await api.get<{ accounts: Account[] }>('/api/accounts');
  return data.accounts;
}

/** Uploads the file for parsing. The server writes nothing at this stage. */
export async function uploadCsv(input: {
  file: File;
  accountId: string;
  mapping?: ColumnMapping;
}): Promise<UploadResponse> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('accountId', input.accountId);
  if (input.mapping) form.append('mapping', JSON.stringify(input.mapping));

  const { data } = await api.post<UploadResponse>('/api/transactions/upload', form, {
    // Let the browser set the multipart boundary.
    headers: { 'Content-Type': undefined },
  });
  return data;
}

/** Commits the reviewed rows, honouring the user's keep/skip decisions. */
export async function commitImport(input: {
  accountId: string;
  rows: PreviewRow[];
  resolutions: Record<number, Resolution>;
}): Promise<CommitResult> {
  const { data } = await api.post<CommitResult>('/api/transactions/commit', {
    accountId: input.accountId,
    rows: input.rows.map(({ duplicate: _duplicate, ...row }) => row),
    resolutions: Object.fromEntries(
      Object.entries(input.resolutions).map(([index, choice]) => [String(index), choice]),
    ),
  });
  return data;
}

/** The fixed taxonomy from PROJECT_CONTEXT.md §5, mirroring the Prisma enum. */
export const CATEGORIES = [
  'GROCERIES',
  'DINING',
  'TRANSPORTATION',
  'HOUSING',
  'UTILITIES',
  'SUBSCRIPTIONS',
  'ENTERTAINMENT',
  'SHOPPING',
  'HEALTH_FITNESS',
  'TRAVEL',
  'INCOME',
  'TRANSFER',
  'FEES_INTEREST',
  'INSURANCE',
  'EDUCATION',
  'PERSONAL_CARE',
  'GIFTS_DONATIONS',
  'BUSINESS',
  'REFUND',
  'UNCATEGORIZED',
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface TransactionSplit {
  id: string;
  category: Category;
  amount: number;
  note: string | null;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  postedDate: string | null;
  description: string;
  rawMerchant: string;
  normalizedMerchant: string;
  amount: number;
  currency: string;
  category: Category;
  confidence: number;
  source: 'RULE' | 'LLM' | 'MANUAL';
  transferPairId: string | null;
  linkedRefundId: string | null;
  splits: TransactionSplit[];
}

export interface TransactionPage {
  total: number;
  limit: number;
  offset: number;
  transactions: Transaction[];
}

export interface SplitInput {
  category: Category;
  amount: number;
  note?: string;
}

export async function fetchTransactions(params: {
  accountId?: string;
  category?: string;
  limit?: number;
  offset?: number;
}): Promise<TransactionPage> {
  const { data } = await api.get<TransactionPage>('/api/transactions', { params });
  return data;
}

/** Divides one charge across categories. The server rejects a set that does not sum. */
export async function splitTransaction(input: {
  transactionId: string;
  splits: SplitInput[];
}): Promise<Transaction> {
  const { data } = await api.post<{ transaction: Transaction }>(
    `/api/transactions/${input.transactionId}/split`,
    { splits: input.splits },
  );
  return data.transaction;
}

export async function clearSplit(transactionId: string): Promise<void> {
  await api.delete(`/api/transactions/${transactionId}/split`);
}

export interface ReviewQueue {
  total: number;
  limit: number;
  offset: number;
  counts: { uncategorized: number; lowConfidence: number };
  lowConfidenceThreshold: number;
  transactions: Transaction[];
}

export interface OverrideResult {
  transaction: Transaction;
  learnedRule: { id: string; pattern: string; category: Category } | null;
}

export async function fetchReviewQueue(params: {
  accountId?: string;
  limit?: number;
  offset?: number;
}): Promise<ReviewQueue> {
  const { data } = await api.get<ReviewQueue>('/api/review-queue', { params });
  return data;
}

/**
 * Records a human's category decision. `learn` (on by default) also teaches a
 * rule for the merchant, so future imports never reach the LLM for it.
 */
export async function overrideCategory(input: {
  transactionId: string;
  category: Category;
  learn?: boolean;
}): Promise<OverrideResult> {
  const { data } = await api.post<OverrideResult>(
    `/api/transactions/${input.transactionId}/category`,
    { category: input.category, learn: input.learn ?? true },
  );
  return data;
}
