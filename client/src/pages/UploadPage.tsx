import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

const PREVIEW_LIMIT = 20;


/** Chosen by extension rather than MIME type, which browsers disagree about. */
function isPdf(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
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

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const multiple = ALLOWS_MULTIPLE[period];

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
    mutationFn: () =>
      parseStatementBatch({ files, accountId, passwords: batchPasswords }),
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
      commitImport({ accountId, rows: (batch ?? preview!).rows, resolutions }),
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
    (requiresPassword === false) ||
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
          Upload a CSV export or a PDF statement. Nothing is saved until you confirm the
          preview.
        </p>
      </div>

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
            <label className="text-sm font-medium" htmlFor="account">
              Account
            </label>
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
              {multiple ? 'CSV or PDF files' : 'CSV or PDF file'}
            </label>
            <Input
              id="statement"
              ref={fileInputRef}
              type="file"
              multiple={multiple}
              accept=".csv,text/csv,.pdf,application/pdf"
              aria-label={multiple ? 'CSV or PDF files' : 'CSV or PDF file'}
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
                        <Badge variant="secondary">Parsed OK</Badge>
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
              {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}. They are stored
              uncategorized — categorization arrives in a later phase.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </main>
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

function ColumnMappingForm({
  needsMapping,
  onSubmit,
  pending,
}: {
  needsMapping: NeedsMapping;
  onSubmit: (mapping: ColumnMapping) => void;
  pending: boolean;
}) {
  const [mapping, setMapping] = useState<ColumnMapping>({
    date: '',
    description: '',
    amount: '',
    amountSign: 'debit-positive',
  });

  const complete = mapping.date && mapping.description && mapping.amount;
  const fields = [
    { key: 'date', label: 'Date' },
    { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount' },
  ] as const;

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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-2">
              <label className="text-sm font-medium" htmlFor={`map-${field.key}`}>
                {field.label}
              </label>
              <Select
                value={mapping[field.key]}
                onValueChange={(value) => setMapping((prev) => ({ ...prev, [field.key]: value }))}
              >
                <SelectTrigger id={`map-${field.key}`} aria-label={field.label} className="w-full">
                  <SelectValue placeholder="Choose a column" />
                </SelectTrigger>
                <SelectContent>
                  {needsMapping.headers.map((header) => (
                    <SelectItem key={header} value={header}>
                      {header}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="map-sign">
              Amount sign
            </label>
            <Select
              value={mapping.amountSign}
              onValueChange={(value) =>
                setMapping((prev) => ({
                  ...prev,
                  amountSign: value as ColumnMapping['amountSign'],
                }))
              }
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
        </div>

        <Button onClick={() => onSubmit(mapping)} disabled={!complete || pending}>
          {pending ? 'Parsing…' : 'Parse with this mapping'}
        </Button>
      </CardContent>
    </Card>
  );
}

export default UploadPage;
