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
