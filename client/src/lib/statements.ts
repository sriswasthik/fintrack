import { api } from '@/lib/api';

import type { PreviewRow, UploadPreview } from '@/lib/transactions';

/** Why a parse was refused, when the server could say precisely. */
export type StatementFailure =
  | 'password-required'
  | 'incorrect-password'
  | 'unreadable'
  | 'no-text'
  | 'no-rows'
  | 'unsupported-layout'
  | 'unreadable-layout';

/**
 * Asks only whether the file is encrypted.
 *
 * Called the moment a PDF is chosen, before anything else, so the page can
 * decide whether a password field belongs on screen at all. Showing one to
 * somebody whose statement has no password is a field they will assume they are
 * failing at.
 */
export async function inspectStatement(file: File): Promise<{ requiresPassword: boolean }> {
  const form = new FormData();
  form.append('file', file);

  const { data } = await api.post<{ requiresPassword: boolean }>(
    '/api/statements/inspect',
    form,
    // Let the browser set the multipart boundary.
    { headers: { 'Content-Type': undefined } },
  );
  return data;
}

/** Reads the statement into the same preview a CSV upload produces. */
export async function parseStatement(input: {
  file: File;
  accountId: string;
  password?: string;
}): Promise<UploadPreview> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('accountId', input.accountId);
  if (input.password) form.append('password', input.password);

  const { data } = await api.post<UploadPreview>('/api/statements/parse', form, {
    headers: { 'Content-Type': undefined },
  });
  return data;
}

/** The server's machine-readable reason, when it gave one. */
export function statementFailure(error: unknown): StatementFailure | null {
  const reason = (error as { response?: { data?: { details?: { reason?: string } } } } | null)
    ?.response?.data?.details?.reason;
  return (reason as StatementFailure | undefined) ?? null;
}

/** True when the file is encrypted and the password we sent was not right. */
export function isWrongPassword(error: unknown): boolean {
  return statementFailure(error) === 'incorrect-password';
}

// ---------------------------------------------------------------------------
// Batch import
// ---------------------------------------------------------------------------

/** How much of the calendar this import covers. */
export type StatementPeriod = 'monthly' | 'quarterly' | 'custom';

/** A monthly import is one statement; the other two are as many as you have. */
export const ALLOWS_MULTIPLE: Record<StatementPeriod, boolean> = {
  monthly: false,
  quarterly: true,
  custom: true,
};

export const PERIOD_LABELS: Record<StatementPeriod, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  custom: 'Custom range',
};

export type BatchFileStatus = 'parsed' | 'needs-password' | 'wrong-password' | 'failed';

export interface BatchFile {
  index: number;
  fileName: string;
  status: BatchFileStatus;
  source: string | null;
  sourceLabel: string | null;
  via: 'adapter' | 'layout' | 'model' | null;
  rowCount: number;
  skippedRows: { index: number; reason: string }[];
  reason?: string;
  message?: string;
}

export interface BatchRow extends PreviewRow {
  counterpartyRaw?: string | null;
  upiVpa?: string | null;
  fileIndex: number;
  fileName: string;
}

export interface BatchPreview {
  status: 'batch-preview';
  accountId: string;
  files: BatchFile[];
  filesParsed: number;
  filesFailed: number;
  totalRows: number;
  duplicateCount: number;
  /** Rows that repeat something in a *different* file of the same batch. */
  crossFileDuplicateCount: number;
  rows: BatchRow[];
}

/**
 * Reads several statements as one import.
 *
 * Passwords are keyed by the file's position in the selection, not by its name:
 * two files chosen together can share a name, and a password applied to the
 * wrong file fails in a way that looks like a wrong password.
 */
export async function parseStatementBatch(input: {
  files: File[];
  accountId: string;
  passwords?: Record<number, string>;
}): Promise<BatchPreview> {
  const form = new FormData();
  input.files.forEach((file) => form.append('files', file));
  form.append('accountId', input.accountId);

  const passwords = Object.entries(input.passwords ?? {}).filter(([, value]) => value);
  if (passwords.length > 0) form.append('passwords', JSON.stringify(Object.fromEntries(passwords)));

  const { data } = await api.post<BatchPreview>('/api/statements/parse-batch', form, {
    headers: { 'Content-Type': undefined },
  });
  return data;
}
