import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { AddAccountForm } from '@/components/AddAccountForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatINR } from '@/lib/currency';
import {
  commitImport,
  fetchAccounts,
  uploadCsv,
  type ColumnMapping,
  type CommitResult,
  type DateOrder,
  type NeedsMapping,
  type PreviewRow,
  type Resolution,
  type UploadPreview,
} from '@/lib/transactions';
import {
  ALLOWS_MULTIPLE,
  inspectStatement,
  isWrongPassword,
  parseStatement,
  parseStatementBatch,
  PERIOD_LABELS,
  type BatchPreview,
  type StatementPeriod,
} from '@/lib/statements';
import { errorMessage } from '@/lib/errors';

const PREVIEW_LIMIT = 20;

/** Chosen by extension rather than MIME type, which browsers disagree about. */
function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

export function UploadPage() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [accountId, setAccountId] = useState('');
  /**
   * Monthly is one statement; a quarter or a custom range is several, and the
   * whole point of picking them together is that duplicate detection then runs
   * across the lot rather than once per file.
   */
  const [period, setPeriod] = useState<StatementPeriod>('monthly');
  const [file, setFile] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [batch, setBatch] = useState<BatchPreview | null>(null);
  const [batchPasswords, setBatchPasswords] = useState<Record<number, string>>({});
  /** null until a PDF has been inspected; false means "no password needed". */
  const [requiresPassword, setRequiresPassword] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [needsMapping, setNeedsMapping] = useState<NeedsMapping | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({});
  const [result, setResult] = useState<CommitResult | null>(null);
  const [addingAccount, setAddingAccount] = useState(false);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  /** A new user has no accounts, and nothing can be imported until they add one. */
  const noAccounts = accounts.isSuccess && accounts.data.length === 0;

  const multiple = ALLOWS_MULTIPLE[period];
  const fileLabel = multiple ? 'CSV, Excel or PDF files' : 'CSV, Excel or PDF file';

  /**
   * A PDF is inspected the moment it is chosen, and only then does a password
   * field appear — and only if the file actually has one. The answer to "does
   * this need a password?" is knowable without asking the user anything, so it
   * is answered before they are asked anything.
   */
  const inspectMutation = useMutation({
    mutationFn: (chosen: File) => inspectStatement(chosen),
    onSuccess: (data) => setRequiresPassword(data.requiresPassword),
    onError: (error) => {
      setRequiresPassword(null);
      setInspectError(errorMessage(error));
    },
  });

  /** Everything a new selection invalidates. */
  function resetSelection() {
    setPreview(null);
    setBatch(null);
    setNeedsMapping(null);
    setResult(null);
    setPassword('');
    setBatchPasswords({});
    setRequiresPassword(null);
    setInspectError(null);
    uploadMutation.reset();
    batchMutation.reset();
  }

  function chooseFiles(chosen: File[]) {
    resetSelection();

    if (multiple) {
      setFiles(chosen);
      setFile(null);
      // No inspection here: with several files the answer is per file, and the
      // batch preview is where it gets asked and answered.
      return;
    }

    const one = chosen[0] ?? null;
    setFiles([]);
    setFile(one);
    if (one && isPdf(one)) inspectMutation.mutate(one);
  }

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; accountId: string; mapping?: ColumnMapping }) =>
      isPdf(input.file)
        ? parseStatement({
            file: input.file,
            accountId: input.accountId,
            ...(password ? { password } : {}),
          })
        : uploadCsv(input),
    onSuccess: (data) => {
      setResult(null);
      if (data.status === 'needs-mapping') {
        setNeedsMapping(data);
        setPreview(null);
        return;
      }
      setNeedsMapping(null);
      setPreview(data);
      // Likely duplicates default to skip; the user opts back in per row.
      setResolutions(
        Object.fromEntries(
          data.rows.filter((r) => r.duplicate).map((r) => [r.index, 'skip' as Resolution]),
        ),
      );
    },
  });

  const batchMutation = useMutation({
    mutationFn: () => parseStatementBatch({ files, accountId, passwords: batchPasswords }),
    onSuccess: (data) => {
      setResult(null);
      setBatch(data);
      // Likely duplicates default to skip, exactly as in a single-file import.
      setResolutions(
        Object.fromEntries(
          data.rows.filter((r) => r.duplicate).map((r) => [r.index, 'skip' as Resolution]),
        ),
      );
    },
  });

  const commitMutation = useMutation({
    mutationFn: () =>
      commitImport({
        accountId,
        rows: (batch ?? preview!).rows,
        resolutions,
        // Recorded on the import, so the history on the settings page can say
        // which statement it was when somebody wants to undo one.
        fileNames: batch
          ? batch.files.filter((f) => f.status === 'parsed').map((f) => f.fileName)
          : preview
            ? [preview.fileName]
            : [],
      }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setBatch(null);
      setNeedsMapping(null);
      setFile(null);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  /**
   * The review card reads from this, so a batch and a single file get the same
   * screen — the same duplicate tab, the same keep/skip toggles and the same
   * Confirm Import. Two cards that did the same job would drift apart.
   */
  const review = useMemo(() => {
    if (batch) {
      return {
        totalRows: batch.totalRows,
        duplicateCount: batch.duplicateCount,
        rows: batch.rows,
        skippedRows: batch.files.flatMap((f) => f.skippedRows),
        heading: `${batch.totalRows} rows from ${batch.filesParsed} file${batch.filesParsed === 1 ? '' : 's'}`,
      };
    }
    if (preview) {
      return {
        totalRows: preview.totalRows,
        duplicateCount: preview.duplicateCount,
        rows: preview.rows,
        skippedRows: preview.skippedRows,
        heading: `${preview.totalRows} rows parsed from ${preview.fileName}${preview.preset ? ` using the ${preview.preset} format` : ''}`,
      };
    }
    return null;
  }, [batch, preview]);

  const reviewRows = useMemo(() => review?.rows ?? [], [review]);
  const duplicates = useMemo(() => reviewRows.filter((row) => row.duplicate), [reviewRows]);
  const skipCount = duplicates.filter((row) => resolutions[row.index] === 'skip').length;

  const chosenCount = multiple ? files.length : file ? 1 : 0;
  const pdfChosen = Boolean(file && isPdf(file));
  // A PDF cannot be sent until it has been inspected, and an encrypted one
  // cannot be sent without the password the inspection said it needs.
  const pdfReady =
    !pdfChosen ||
    requiresPassword === false ||
    (requiresPassword === true && password.trim().length > 0);
  const canUpload =
    chosenCount > 0 &&
    Boolean(accountId) &&
    (multiple || pdfReady) &&
    !uploadMutation.isPending &&
    !batchMutation.isPending &&
    !inspectMutation.isPending;

  function submitUpload(mapping?: ColumnMapping) {
    if (!accountId) return;
    if (multiple) {
      if (files.length === 0) return;
      batchMutation.mutate();
      return;
    }
    if (!file) return;
    uploadMutation.mutate({ file, accountId, mapping });
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import transactions</h1>
        <p className="text-muted-foreground text-sm">
          Upload a CSV or Excel export, or a PDF statement. Nothing is saved until you confirm the
          preview.
        </p>
      </div>

      {(noAccounts || addingAccount) && (
        <Card>
          <CardHeader>
            <CardTitle>
              {noAccounts ? 'First, add your bank account' : 'Add a bank account'}
            </CardTitle>
            <CardDescription>
              {noAccounts
                ? 'Every import goes into an account, so FinTrack can tell a transfer between two of yours from spending. You can add more, rename or remove them later in Settings.'
                : 'It will be selected for this import.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddAccountForm
              submitLabel={noAccounts ? 'Add account and continue' : 'Add account'}
              onCreated={(account) => {
                setAccountId(account.id);
                setAddingAccount(false);
              }}
              onCancel={noAccounts ? undefined : () => setAddingAccount(false)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>1. Choose a file</CardTitle>
          <CardDescription>
            The server detects common export formats, and asks you to map the columns if it does not
            recognise one.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm font-medium" htmlFor="account">
                Account
              </label>
              {!noAccounts && !addingAccount && accounts.isSuccess && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
                  onClick={() => setAddingAccount(true)}
                >
                  New account
                </button>
              )}
            </div>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="account" aria-label="Account" className="w-full">
                <SelectValue
                  placeholder={accounts.isPending ? 'Loading accounts…' : 'Choose an account'}
                />
              </SelectTrigger>
              <SelectContent>
                {(accounts.data ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="period">
              Statement period
            </label>
            <Select
              value={period}
              onValueChange={(value) => {
                setPeriod(value as StatementPeriod);
                setFile(null);
                setFiles([]);
                resetSelection();
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
            >
              <SelectTrigger aria-label="Statement period" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PERIOD_LABELS) as StatementPeriod[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {PERIOD_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-2">
            <label className="text-sm font-medium" htmlFor="statement">
              {fileLabel}
            </label>
            <Input
              id="statement"
              ref={fileInputRef}
              type="file"
              multiple={multiple}
              accept=".csv,text/csv,.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,application/pdf"
              aria-label={fileLabel}
              onChange={(event) => chooseFiles([...(event.target.files ?? [])])}
            />
            {multiple && (
              <p className="text-muted-foreground text-xs">
                {chosenCount > 0
                  ? `${chosenCount} file${chosenCount === 1 ? '' : 's'} selected — duplicates are checked across all of them.`
                  : 'Choose every statement in the period. Duplicates are checked across all of them.'}
              </p>
            )}
          </div>

          <Button onClick={() => submitUpload()} disabled={!canUpload}>
            {uploadMutation.isPending || batchMutation.isPending ? 'Parsing…' : 'Upload'}
          </Button>
        </CardContent>

        {!multiple && pdfChosen && (
          <CardContent className="pt-0">
            {inspectMutation.isPending && (
              <output aria-live="polite" className="text-muted-foreground text-sm">
                Checking whether this statement needs a password…
              </output>
            )}

            {requiresPassword === false && (
              <p className="text-muted-foreground text-sm">
                This statement is not password-protected.
              </p>
            )}

            {requiresPassword === true && (
              <div className="max-w-sm space-y-2">
                <label className="text-sm font-medium" htmlFor="statement-password">
                  Statement password
                </label>
                <Input
                  id="statement-password"
                  type="password"
                  autoComplete="off"
                  aria-label="Statement password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Required to open this file"
                />
                <p className="text-muted-foreground text-xs">
                  This file is encrypted. The password is used to open it and is never stored.
                </p>
              </div>
            )}

            {inspectError && (
              <p role="alert" className="text-destructive text-sm">
                {inspectError}
              </p>
            )}
          </CardContent>
        )}
      </Card>

      {accounts.isError && (
        <p role="alert" className="text-destructive text-sm">
          Could not load accounts. {errorMessage(accounts.error)}
        </p>
      )}

      {batchMutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(batchMutation.error)}
        </p>
      )}

      {uploadMutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(uploadMutation.error)}
          {isWrongPassword(uploadMutation.error) &&
            ' Nothing was imported — check the password and upload again.'}
        </p>
      )}

      {needsMapping && (
        <ColumnMappingForm
          needsMapping={needsMapping}
          onSubmit={submitUpload}
          pending={uploadMutation.isPending}
        />
      )}

      {batch && (
        <Card>
          <CardHeader>
            <CardTitle>2. Files</CardTitle>
            <CardDescription>
              {batch.filesParsed} of {batch.files.length} file
              {batch.files.length === 1 ? '' : 's'} parsed, {batch.totalRows} rows in total.{' '}
              {batch.duplicateCount > 0
                ? `${batch.duplicateCount} look like duplicates and are set to skip` +
                  (batch.crossFileDuplicateCount > 0
                    ? `, ${batch.crossFileDuplicateCount} of them repeated between files.`
                    : '.')
                : 'No duplicates found.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Table aria-label="Files in this import">
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Detected format</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batch.files.map((f) => (
                  <TableRow key={f.index}>
                    <TableCell className="font-medium">{f.fileName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {f.sourceLabel ?? '—'}
                      {f.via === 'layout' && ' (read by layout)'}
                      {f.via === 'model' && ' (read by the fallback)'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.status === 'parsed' ? f.rowCount : '—'}
                    </TableCell>
                    <TableCell>
                      {f.status === 'parsed' ? (
                        <div className="space-y-1">
                          <Badge variant="secondary">Parsed OK</Badge>
                          {f.message && (
                            <p className="text-muted-foreground text-xs">{f.message}</p>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="destructive">
                            {f.status === 'needs-password'
                              ? 'Needs password'
                              : f.status === 'wrong-password'
                                ? 'Wrong password'
                                : 'Failed to parse'}
                          </Badge>
                          {(f.status === 'needs-password' || f.status === 'wrong-password') && (
                            <Input
                              type="password"
                              autoComplete="off"
                              className="h-8 max-w-56"
                              aria-label={`Password for ${f.fileName}`}
                              placeholder="Password for this file"
                              value={batchPasswords[f.index] ?? ''}
                              onChange={(event) =>
                                setBatchPasswords((current) => ({
                                  ...current,
                                  [f.index]: event.target.value,
                                }))
                              }
                            />
                          )}
                          {f.message && (
                            <p className="text-muted-foreground text-xs">{f.message}</p>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {batch.filesFailed > 0 && (
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={batchMutation.isPending}
                  onClick={() => batchMutation.mutate()}
                >
                  {batchMutation.isPending ? 'Retrying…' : 'Retry the files that failed'}
                </Button>
                <p className="text-muted-foreground text-xs">
                  The files that parsed are still ready to import.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {review && review.totalRows > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{batch ? '3. Review' : '2. Review'}</CardTitle>
            <CardDescription>
              {review.heading}.{' '}
              {review.duplicateCount > 0
                ? `${review.duplicateCount} look like duplicates and are set to skip.`
                : 'No duplicates found.'}
              {review.skippedRows.length > 0
                ? ` ${review.skippedRows.length} row(s) could not be parsed and will be ignored.`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!batch && preview?.dateOrder && preview.dateOrder.basis !== 'file' && (
              <DateOrderNotice
                dateOrder={preview.dateOrder}
                pending={uploadMutation.isPending}
                onSwitch={(order) => submitUpload({ ...preview.mapping, dateOrder: order })}
              />
            )}

            <Tabs defaultValue="rows">
              <TabsList>
                <TabsTrigger value="rows">First {PREVIEW_LIMIT} rows</TabsTrigger>
                <TabsTrigger value="duplicates">
                  Flagged duplicates ({review.duplicateCount})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="rows" className="pt-4">
                <PreviewTable
                  rows={review.rows.slice(0, PREVIEW_LIMIT)}
                  resolutions={resolutions}
                  onToggle={(index, choice) =>
                    setResolutions((prev) => ({ ...prev, [index]: choice }))
                  }
                />
              </TabsContent>

              <TabsContent value="duplicates" className="pt-4">
                {duplicates.length === 0 ? (
                  <p className="text-muted-foreground text-sm">Nothing was flagged.</p>
                ) : (
                  <PreviewTable
                    rows={duplicates}
                    resolutions={resolutions}
                    onToggle={(index, choice) =>
                      setResolutions((prev) => ({ ...prev, [index]: choice }))
                    }
                  />
                )}
              </TabsContent>
            </Tabs>

            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button onClick={() => commitMutation.mutate()} disabled={commitMutation.isPending}>
                {commitMutation.isPending ? 'Importing…' : 'Confirm Import'}
              </Button>
              <span className="text-muted-foreground text-sm">
                {review.totalRows - skipCount} of {review.totalRows} rows will be imported
                {skipCount > 0 ? `, ${skipCount} skipped` : ''}.
              </span>
            </div>

            {commitMutation.isError && (
              <p role="alert" className="text-destructive text-sm">
                {errorMessage(commitMutation.error)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Import complete</CardTitle>
            <CardDescription>
              Imported {result.imported} transaction(s)
              {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CategorizationOutcome result={result} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}

/**
 * What categorization made of the import: the rules ran, then — when the
 * server has it — the AI fallback for whatever they left.
 *
 * Counts are across all of the user's transactions, not just this import:
 * that is what the Review page will show.
 */
function CategorizationOutcome({ result }: { result: CommitResult }) {
  const { ai, categorization } = result;
  const left = ai?.status === 'done' ? ai.stillUnresolved : (categorization?.uncategorized ?? 0);

  const parts: string[] = [];
  if (ai?.status === 'done' && ai.categorized > 0) {
    parts.push(
      `AI categorized ${ai.categorized} transaction(s) the rules could not` +
        (ai.lowConfidence > 0 ? `, ${ai.lowConfidence} of them tentatively.` : '.'),
    );
  }
  if (ai?.status === 'unavailable') parts.push(ai.reason);
  if (ai?.status === 'done' && ai.skippedPeople > 0) {
    parts.push(
      `${ai.skippedPeople} payment(s) to people were not sent to the AI — only you know what those were for.`,
    );
  }

  return (
    <div className="space-y-1 text-sm">
      {parts.map((part) => (
        <p key={part}>{part}</p>
      ))}
      {left > 0 ? (
        <p>
          {left} transaction(s) still need a category.{' '}
          <Link to="/review" className="underline underline-offset-4">
            Review them
          </Link>
        </p>
      ) : (
        <p>Everything is categorized.</p>
      )}
    </div>
  );
}

function PreviewTable({
  rows,
  resolutions,
  onToggle,
}: {
  rows: PreviewRow[];
  resolutions: Record<number, Resolution>;
  onToggle: (index: number, choice: Resolution) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">#</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead className="text-right">Amount</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const choice = resolutions[row.index] ?? 'keep';
          return (
            <TableRow
              key={row.index}
              data-duplicate={row.duplicate ? 'true' : undefined}
              className={row.duplicate ? 'bg-destructive/5' : undefined}
            >
              <TableCell className="text-muted-foreground">{row.index}</TableCell>
              <TableCell>{row.date}</TableCell>
              <TableCell className="max-w-[16rem] truncate font-mono text-xs">
                {row.description}
              </TableCell>
              <TableCell className="text-muted-foreground">{row.normalizedMerchant}</TableCell>
              <TableCell className="text-right tabular-nums">{formatINR(row.amount)}</TableCell>
              <TableCell>
                {row.duplicate ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive" title={row.duplicate.reason}>
                      duplicate
                    </Badge>
                    <Button
                      size="sm"
                      variant={choice === 'skip' ? 'outline' : 'default'}
                      onClick={() => onToggle(row.index, choice === 'skip' ? 'keep' : 'skip')}
                      aria-label={`${choice === 'skip' ? 'Keep' : 'Skip'} row ${row.index}`}
                    >
                      {choice === 'skip' ? 'Skipped' : 'Keeping'}
                    </Button>
                  </div>
                ) : (
                  <Badge variant="secondary">new</Badge>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const DATE_ORDER_LABELS: Record<DateOrder, string> = {
  dmy: 'day first (03/05/2026 is 3 May)',
  mdy: 'month first (03/05/2026 is 5 March)',
};

/**
 * Says how the dates in a CSV were read, when the file itself did not prove it.
 *
 * A wrong day/month order fails no row — every date just moves — so the one
 * time it is a guess is the one time the preview has to say so.
 */
function DateOrderNotice({
  dateOrder,
  pending,
  onSwitch,
}: {
  dateOrder: NonNullable<UploadPreview['dateOrder']>;
  pending: boolean;
  onSwitch: (order: DateOrder) => void;
}) {
  const other: DateOrder = dateOrder.order === 'dmy' ? 'mdy' : 'dmy';
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p>
        {dateOrder.basis === 'default' &&
          'Nothing in this file shows whether its dates are day-first or month-first. '}
        Dates were read {DATE_ORDER_LABELS[dateOrder.order]}. Check a few rows below against your
        statement.
      </p>
      <Button size="sm" variant="outline" disabled={pending} onClick={() => onSwitch(other)}>
        {pending ? 'Re-reading…' : `Read ${other === 'dmy' ? 'day' : 'month'} first instead`}
      </Button>
    </div>
  );
}

type AmountLayout = 'single' | 'split';

function ColumnMappingForm({
  needsMapping,
  onSubmit,
  pending,
}: {
  needsMapping: NeedsMapping;
  onSubmit: (mapping: ColumnMapping) => void;
  pending: boolean;
}) {
  const [layout, setLayout] = useState<AmountLayout>('split');
  const [columns, setColumns] = useState({
    date: '',
    description: '',
    amount: '',
    debit: '',
    credit: '',
  });
  const [amountSign, setAmountSign] = useState<ColumnMapping['amountSign']>('debit-positive');
  const [dateOrder, setDateOrder] = useState<DateOrder | 'auto'>('auto');

  const money =
    layout === 'single' ? Boolean(columns.amount) : Boolean(columns.debit || columns.credit);
  const complete = Boolean(columns.date && columns.description && money);

  const fields =
    layout === 'single'
      ? ([
          { key: 'date', label: 'Date' },
          { key: 'description', label: 'Description' },
          { key: 'amount', label: 'Amount' },
        ] as const)
      : ([
          { key: 'date', label: 'Date' },
          { key: 'description', label: 'Description' },
          { key: 'debit', label: 'Money out (debit / withdrawal)' },
          { key: 'credit', label: 'Money in (credit / deposit)' },
        ] as const);

  function submit() {
    const mapping: ColumnMapping = {
      date: columns.date,
      description: columns.description,
      amountSign,
      ...(layout === 'single'
        ? { amount: columns.amount }
        : {
            ...(columns.debit ? { debit: columns.debit } : {}),
            ...(columns.credit ? { credit: columns.credit } : {}),
          }),
      ...(dateOrder === 'auto' ? {} : { dateOrder }),
    };
    onSubmit(mapping);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Map the columns</CardTitle>
        <CardDescription>
          <code>{needsMapping.fileName}</code> does not match a known export format. Tell the server
          which column is which and it will parse the file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="map-layout">
              Amounts are in
            </label>
            <Select value={layout} onValueChange={(value) => setLayout(value as AmountLayout)}>
              <SelectTrigger id="map-layout" aria-label="Amounts are in" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="split">Separate debit and credit columns</SelectItem>
                <SelectItem value="single">One amount column</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="map-date-order">
              Dates are written
            </label>
            <Select
              value={dateOrder}
              onValueChange={(value) => setDateOrder(value as DateOrder | 'auto')}
            >
              <SelectTrigger id="map-date-order" aria-label="Dates are written" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Work it out from the file</SelectItem>
                <SelectItem value="dmy">Day first (31/01/2026)</SelectItem>
                <SelectItem value="mdy">Month first (01/31/2026)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`map-${field.key}`}>
                {field.label}
              </label>
              <Select
                value={columns[field.key]}
                onValueChange={(value) => setColumns((prev) => ({ ...prev, [field.key]: value }))}
              >
                <SelectTrigger id={`map-${field.key}`} aria-label={field.label} className="w-full">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {needsMapping.headers
                    .filter((header) => header.trim())
                    .map((header) => (
                      <SelectItem key={header} value={header}>
                        {header}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          {layout === 'single' && (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="map-sign">
                Amount sign
              </label>
              <Select
                value={amountSign}
                onValueChange={(value) => setAmountSign(value as ColumnMapping['amountSign'])}
              >
                <SelectTrigger id="map-sign" aria-label="Amount sign" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit-positive">Purchases are positive</SelectItem>
                  <SelectItem value="credit-positive">Purchases are negative</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <Button onClick={submit} disabled={!complete || pending}>
          {pending ? 'Parsing…' : 'Parse with this mapping'}
        </Button>
      </CardContent>
    </Card>
  );
}

export default UploadPage;
