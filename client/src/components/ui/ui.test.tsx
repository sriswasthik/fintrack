import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * Smoke tests for the shadcn/ui components added in Phase 0. They assert the
 * components mount and forward props/refs correctly — no behaviour of our own
 * is under test here, only that the Tailwind + Radix wiring is sound.
 */
describe('shadcn/ui components', () => {
  it('renders button, badge and input', () => {
    render(
      <>
        <Button>Save</Button>
        <Badge variant="secondary">GROCERIES</Badge>
        <Input aria-label="Amount" defaultValue="12.34" />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByText('GROCERIES')).toBeInTheDocument();
    expect(screen.getByLabelText('Amount')).toHaveValue('12.34');
  });

  it('renders a card', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Spending</CardTitle>
        </CardHeader>
        <CardContent>Content</CardContent>
      </Card>,
    );

    expect(screen.getByText('Spending')).toBeInTheDocument();
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('renders a table', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Merchant</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>SQ *JOES COFFEE</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'SQ *JOES COFFEE' })).toBeInTheDocument();
  });

  it('renders tabs and switches panels via the active trigger', () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="insights">Insights panel</TabsContent>
      </Tabs>,
    );

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('Overview panel')).toBeInTheDocument();
    expect(screen.queryByText('Insights panel')).not.toBeInTheDocument();
  });

  it('renders a dialog when open', () => {
    render(
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Confirm import</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Confirm import')).toBeInTheDocument();
  });

  it('renders a select trigger with its placeholder', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Account">
          <SelectValue placeholder="Choose an account" />
        </SelectTrigger>
      </Select>,
    );

    expect(screen.getByLabelText('Account')).toBeInTheDocument();
    expect(screen.getByText('Choose an account')).toBeInTheDocument();
  });
});
