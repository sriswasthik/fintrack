import { api } from '@/lib/api';

import type { UploadPreview } from '@/lib/transactions';

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
  const reason = (
    error as { response?: { data?: { details?: { reason?: string } } } } | null
  )?.response?.data?.details?.reason;
  return (reason as StatementFailure | undefined) ?? null;
}

/** True when the file is encrypted and the password we sent was not right. */
export function isWrongPassword(error: unknown): boolean {
  return statementFailure(error) === 'incorrect-password';
}
