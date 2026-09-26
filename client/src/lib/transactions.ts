import { api } from '@/lib/api';

export interface Account {
  id: string;
  name: string;
  type: string;
  /** How many transactions it holds — what deleting it would take with it. */
  transactionCount?: number;
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

export type DateOrder = 'dmy' | 'mdy';

export interface ColumnMapping {
  date: string;
  description: string;
  /** One signed amount column — or the debit/credit pair below. */
  amount?: string;
  debit?: string;
  credit?: string;
  /** With `amount`: a column saying Dr or Cr. */
  drCr?: string;
  postedDate?: string;
  amountSign: AmountSign;
  /** How numeric dates are written. Absent means the server works it out. */
  dateOrder?: DateOrder;
}

export interface UploadPreview {
  status: 'preview';
  fileName: string;
  accountId: string;
  preset: string | null;
  headers: string[];
  mapping: ColumnMapping;
  /**
   * How numeric dates were read. `basis: 'default'` means nothing in the file
   * proved the order and day-first was assumed. Absent on a PDF preview.
   */
  dateOrder?: { order: DateOrder; basis: 'mapping' | 'file' | 'default' };
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
  /** The import this commit created; null when every row was skipped. */
  importId?: string | null;
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
  /** Recorded on the import, so the history can say which statement it was. */
  fileNames?: string[];
}): Promise<CommitResult> {
  const { data } = await api.post<CommitResult>('/api/transactions/commit', {
    accountId: input.accountId,
    fileNames: input.fileNames ?? [],
    rows: input.rows.map(({ duplicate: _duplicate, ...row }) => row),
    resolutions: Object.fromEntries(
      Object.entries(input.resolutions).map(([index, choice]) => [String(index), choice]),
    ),
  });
  return data;
}

/**
 * The fixed taxonomy from PROJECT_CONTEXT.md §5, mirroring the Prisma enum.
 *
 * Hand-maintained, so `transactions.taxonomy.test.ts` reads the Prisma schema
 * and asserts this list matches it value for value and in order — a category
 * the server can store but this array has never heard of would vanish from
 * every picker on the client with nothing to say it had.
 */
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
  'EMI_LOAN',
  'INVESTMENTS',
  'CASH_WITHDRAWAL',
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
  /** Who was on the other end, as the server's heuristic reads it (Phase 14). */
  counterpartyType?: CounterpartyType;
  /** The counterparty with any `@bank` UPI suffix stripped, ready to render. */
  counterpartyDisplay?: string | null;
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
}

/**
 * Whether the other side of a transaction was a person or a business.
 *
 * UNKNOWN is the common answer on bank narrations, which upper-case everything
 * and throw away the capitalisation a name is recognised by — so treat it as
 * "not stated" rather than as a third kind of counterparty.
 */
export type CounterpartyType = 'PERSON' | 'BUSINESS' | 'UNKNOWN';

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

export interface ExportFilters {
  accountId?: string;
  category?: string;
  /** YYYY-MM, or give from/to instead. */
  month?: string;
  from?: string;
  to?: string;
}

/**
 * Downloads the filtered transactions as a CSV.
 *
 * Fetched through the API client rather than linked to directly: the request
 * needs the bearer token, which lives in memory and never in a URL. The file
 * is handed to the browser as an object URL and released straight after.
 */
export async function downloadTransactionsCsv(filters: ExportFilters = {}): Promise<string> {
  const response = await api.get<Blob>('/api/transactions/export', {
    params: filters,
    responseType: 'blob',
  });

  const disposition = String(response.headers['content-disposition'] ?? '');
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'fintrack-transactions.csv';

  const url = URL.createObjectURL(response.data);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return fileName;
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
