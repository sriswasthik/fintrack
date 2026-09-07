import { describe, expect, it } from 'vitest';

import {
  CsvMappingError,
  HEADER_PRESETS,
  detectPreset,
  inspectHeaders,
  parseAmount,
  parseDate,
  parseTransactions,
  type ColumnMapping,
} from './csv';

const GENERIC_MAPPING = HEADER_PRESETS.find((p) => p.id === 'generic')!.mapping;

describe('detectPreset', () => {
  it('detects the generic export', () => {
    expect(detectPreset(['date', 'description', 'amount', 'account'])?.id).toBe('generic');
  });

  it('detects a Chase export', () => {
    const headers = [
      'Transaction Date',
      'Post Date',
      'Description',
      'Category',
      'Type',
      'Amount',
      'Memo',
    ];
    expect(detectPreset(headers)?.id).toBe('chase');
  });

  it('detects an Amex export', () => {
    expect(detectPreset(['Date', 'Description', 'Card Member', 'Account #', 'Amount'])?.id).toBe(
      'amex',
    );
  });

  it('ignores header case and padding', () => {
    expect(detectPreset(['  DATE ', 'Description', 'AMOUNT'])?.id).toBe('generic');
  });

  it('returns null for an unrecognised layout', () => {
    expect(detectPreset(['Posted', 'Merchant Name', 'Debit', 'Credit'])).toBeNull();
  });

  it('prefers the more specific preset when both could match', () => {
    // A Chase export also contains "Description" and "Amount"; it must not be
    // read as the generic preset, whose date column does not exist there.
    const headers = ['Transaction Date', 'Post Date', 'Description', 'Amount'];
    expect(detectPreset(headers)?.id).toBe('chase');
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-04-10', '2026-04-10'],
    ['2026-4-9', '2026-04-09'],
    ['04/10/2026', '2026-04-10'],
    ['4/9/26', '2026-04-09'],
  ])('parses %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it.each([['', 'not a date', '2026-13-01', '2026-02-30', '10-04-2026']])('rejects %s', (input) => {
    expect(parseDate(input)).toBeNull();
  });
});

describe('parseAmount', () => {
  it.each([
    ['12.34', 12.34],
    ['-12.34', -12.34],
    ['$1,234.56', 1234.56],
    ['(12.34)', -12.34],
    ['  42 ', 42],
    ['.5', 0.5],
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([['', '-', 'abc', '1.2.3']])('rejects %s', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('parseTransactions', () => {
  const csv = [
    'date,description,amount,account',
    '2026-03-01,OAKWOOD PROPERTY MGMT,2150.00,Everyday Checking',
    '2026-03-01,SQ *JOES COFFEE,5.25,Sapphire Credit Card',
    '2026-03-02,NORTHWIND LABS DIRECT DEP,-3421.55,Everyday Checking',
  ].join('\r\n');

  it('parses and normalizes each row', () => {
    const { rows, errors } = parseTransactions(csv, GENERIC_MAPPING);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({
      index: 2,
      date: '2026-03-01',
      description: 'SQ *JOES COFFEE',
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
      amount: 5.25,
    });
  });

  it('numbers rows from 1, matching test-data/README.md', () => {
    expect(parseTransactions(csv, GENERIC_MAPPING).rows.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('keeps income negative under the debit-positive convention', () => {
    expect(parseTransactions(csv, GENERIC_MAPPING).rows[2].amount).toBe(-3421.55);
  });

  it('flips the sign for a credit-positive export', () => {
    const chase = [
      'Transaction Date,Post Date,Description,Category,Type,Amount,Memo',
      '03/01/2026,03/03/2026,SQ *JOES COFFEE,Food & Drink,Sale,-5.25,',
      '03/05/2026,03/06/2026,PAYMENT THANK YOU,,Payment,1200.00,',
    ].join('\n');

    const mapping = HEADER_PRESETS.find((p) => p.id === 'chase')!.mapping;
    const { rows } = parseTransactions(chase, mapping);

    // A purchase Chase writes as -5.25 is stored debit-positive as +5.25.
    expect(rows[0]).toMatchObject({ amount: 5.25, date: '2026-03-01', postedDate: '2026-03-03' });
    // A card payment Chase writes as +1200 becomes -1200 (money arriving).
    expect(rows[1].amount).toBe(-1200);
  });

  it('leaves an Amex export debit-positive', () => {
    const amex = [
      'Date,Description,Card Member,Account #,Amount',
      '03/01/2026,AMZN Mktp US*RT4G21,A CARDHOLDER,-12345,89.99',
    ].join('\n');

    const mapping = HEADER_PRESETS.find((p) => p.id === 'amex')!.mapping;
    const { rows } = parseTransactions(amex, mapping);

    expect(rows[0]).toMatchObject({ amount: 89.99, normalizedMerchant: 'AMAZON MARKETPLACE' });
  });

  it('reports unparseable rows instead of dropping them silently', () => {
    const messy = [
      'date,description,amount',
      '2026-03-01,GOOD ROW,10.00',
      'not-a-date,BAD DATE,10.00',
      '2026-03-02,BAD AMOUNT,abc',
      '2026-03-03,,10.00',
    ].join('\n');

    const { rows, errors } = parseTransactions(messy, GENERIC_MAPPING);

    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.index)).toEqual([2, 3, 4]);
    expect(errors[0].reason).toMatch(/date/i);
    expect(errors[1].reason).toMatch(/amount/i);
    expect(errors[2].reason).toMatch(/description/i);
  });

  it('throws CsvMappingError when a mapped column is absent', () => {
    const mapping: ColumnMapping = { ...GENERIC_MAPPING, amount: 'total' };
    expect(() => parseTransactions('date,description\n2026-03-01,X', mapping)).toThrow(
      CsvMappingError,
    );
  });

  it('handles quoted fields containing the delimiter', () => {
    const quoted = ['date,description,amount', '2026-03-01,"ACME, INC #22",10.00'].join('\n');
    expect(parseTransactions(quoted, GENERIC_MAPPING).rows[0].description).toBe('ACME, INC #22');
  });

  it('skips blank lines', () => {
    const padded = ['date,description,amount', '2026-03-01,X CORP,1.00', '', '  ', ''].join('\n');
    expect(parseTransactions(padded, GENERIC_MAPPING).rows).toHaveLength(1);
  });
});

describe('inspectHeaders', () => {
  it('returns the headers and a few sample rows for the mapping UI', () => {
    const csv = [
      'Posted,Merchant Name,Debit',
      '2026-03-01,ACME,10.00',
      '2026-03-02,BETA,11.00',
    ].join('\n');

    const { headers, sampleRows } = inspectHeaders(csv);

    expect(headers).toEqual(['Posted', 'Merchant Name', 'Debit']);
    expect(sampleRows).toHaveLength(2);
    expect(detectPreset(headers)).toBeNull();
  });
});
