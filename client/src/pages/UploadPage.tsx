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

const PREVIEW_LIMIT = 20;

const money = (amount: number) =>
  amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

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
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [needsMapping, setNeedsMapping] = useState<NeedsMapping | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, Resolution>>({});
  const [result, setResult] = useState<CommitResult | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const uploadMutation = useMutation({
    mutationFn: (input: { file: File; accountId: string; mapping?: ColumnMapping }) =>
      uploadCsv(input),
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

  const commitMutation = useMutation({
    mutationFn: () => commitImport({ accountId, rows: preview!.rows, resolutions }),
    onSuccess: (data) => {
      setResult(data);
      setPreview(null);
      setNeedsMapping(null);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      void queryClient.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const duplicates = useMemo(() => preview?.rows.filter((row) => row.duplicate) ?? [], [preview]);
  const skipCount = duplicates.filter((row) => resolutions[row.index] === 'skip').length;

  const canUpload = Boolean(file && accountId) && !uploadMutation.isPending;

  function submitUpload(mapping?: ColumnMapping) {
    if (!file || !accountId) return;
    uploadMutation.mutate({ file, accountId, mapping });
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import transactions</h1>
        <p className="text-muted-foreground text-sm">
          Upload a CSV export. Nothing is saved until you confirm the preview.
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

          <div className="flex-1 space-y-2">
            <label className="text-sm font-medium" htmlFor="csv">
              CSV file
            </label>
            <Input
              id="csv"
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <Button onClick={() => submitUpload()} disabled={!canUpload}>
            {uploadMutation.isPending ? 'Parsing…' : 'Upload'}
          </Button>
        </CardContent>
      </Card>

      {accounts.isError && (
        <p role="alert" className="text-destructive text-sm">
          Could not load accounts. {errorMessage(accounts.error)}
        </p>
      )}

      {uploadMutation.isError && (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(uploadMutation.error)}
        </p>
      )}

      {needsMapping && (
        <ColumnMappingForm
          needsMapping={needsMapping}
          onSubmit={submitUpload}
          pending={uploadMutation.isPending}
        />
      )}

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>2. Review</CardTitle>
            <CardDescription>
              {preview.totalRows} rows parsed from <code>{preview.fileName}</code>
              {preview.preset ? ` using the ${preview.preset} format` : ''}.{' '}
              {preview.duplicateCount > 0
                ? `${preview.duplicateCount} look like duplicates and are set to skip.`
                : 'No duplicates found.'}
              {preview.skippedRows.length > 0
                ? ` ${preview.skippedRows.length} row(s) could not be parsed and will be ignored.`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Tabs defaultValue="rows">
              <TabsList>
                <TabsTrigger value="rows">First {PREVIEW_LIMIT} rows</TabsTrigger>
                <TabsTrigger value="duplicates">
                  Flagged duplicates ({preview.duplicateCount})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="rows" className="pt-4">
                <PreviewTable
                  rows={preview.rows.slice(0, PREVIEW_LIMIT)}
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
                {preview.totalRows - skipCount} of {preview.totalRows} rows will be imported
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
              <TableCell className="text-right tabular-nums">{money(row.amount)}</TableCell>
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
