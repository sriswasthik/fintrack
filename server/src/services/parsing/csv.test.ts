import { describe, expect, it } from 'vitest';

import {
  CsvMappingError,
  HEADER_PRESETS,
  amountMarker,
  detectMapping,
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
    // Day first unless told otherwise: this is what an Indian bank means.
    ['04/10/2026', '2026-10-04'],
    ['4/9/26', '2026-09-04'],
    ['10-04-2026', '2026-04-10'],
    ['10.04.2026', '2026-04-10'],
    ['10-Apr-2026', '2026-04-10'],
    ['10 Apr 26', '2026-04-10'],
    ['10/04/2026 14:32:05', '2026-04-10'],
  ])('parses %s', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('reads month first when told the file is written that way', () => {
    expect(parseDate('04/10/2026', 'mdy')).toBe('2026-04-10');
    expect(parseDate('4/9/26', 'mdy')).toBe('2026-04-09');
  });

  it.each([['', 'not a date', '2026-13-01', '2026-02-30', '31/02/2026']])('rejects %s', (input) => {
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
    ['₹1,23,456.78', 123456.78],
    ['Rs. 500.00', 500],
    ['INR 500', 500],
    ['1,200.00 Cr', 1200],
    ['1200.00DR', 1200],
    ['9,371.92 (Cr)', 9371.92],
  ])('parses %s', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([['', '-', 'abc', '1.2.3']])('rejects %s', (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe('amountMarker', () => {
  it('reads which way a figure says the money went', () => {
    expect(amountMarker('1,200.00 Cr')).toBe('cr');
    expect(amountMarker('1200.00DR')).toBe('dr');
    expect(amountMarker('9,371.92 (Cr)')).toBe('cr');
    expect(amountMarker('1,200.00')).toBeNull();
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

// ---------------------------------------------------------------------------
// Indian bank exports: account details above the header, separate debit and
// credit columns, day-first dates. The layouts below are modelled on the
// HDFC, SBI and ICICI net-banking exports; every value in them is invented.
// ---------------------------------------------------------------------------

const HDFC_STYLE = [
  'HDFC BANK Ltd.,,,,,,',
  'Account Holder : A SAMPLE PERSON,,,,,,',
  'Account No : XXXXXXXX1234,,,,,,',
  'Statement From : 01/03/26 To : 31/03/26,,,,,,',
  '',
  'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '********,********,********,********,********,********,********',
  '01/03/26,UPI-SWIGGY-SWIGGY@ICICI-ICIC0000001-606012345678,0000606012345678,01/03/26,450.00,,52550.00',
  '05/03/26,NEFT CR-NORTHWIND LABS SALARY,N064260012345,05/03/26,,85000.00,137550.00',
  '13/03/26,POS 4XXXXX1234 BIGBASKET,0000000000001,14/03/26,1234.50,0.00,136315.50',
  ',,,,,,',
  'STATEMENT SUMMARY :-,,,,,,',
].join('\n');

describe('Indian bank exports', () => {
  it('finds the header below the account details and reads debit/credit columns', () => {
    const { headers } = inspectHeaders(HDFC_STYLE);
    const detected = detectMapping(headers)!;
    expect(detected.id).toBe('debit-credit');
    expect(detected.mapping).toMatchObject({
      date: 'Date',
      description: 'Narration',
      debit: 'Withdrawal Amt.',
      credit: 'Deposit Amt.',
      postedDate: 'Value Dt',
    });

    const { rows, errors, dateOrder } = parseTransactions(HDFC_STYLE, detected.mapping);

    // The asterisk row, the blank row and the summary caption are not rows.
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-03-01', 450],
      ['2026-03-05', -85000],
      ['2026-03-13', 1234.5],
    ]);
    // 13/03/26 can only be day-first, so the whole file is read that way.
    expect(dateOrder).toEqual({ order: 'dmy', basis: 'file' });
    expect(rows[2].postedDate).toBe('2026-03-14');
  });

  it('reads an SBI-style export with spelled-out dates', () => {
    const csv = [
      'Account Name,: A SAMPLE PERSON',
      'Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance',
      '2 Mar 2026,2 Mar 2026,TO TRANSFER-UPI/DR/606112345678/ZOMATO,TRANSFER TO 1234,325.00,,10675.00',
      '4 Mar 2026,4 Mar 2026,BY TRANSFER-NEFT*SALARY,TRANSFER FROM 5678,,50000.00,60675.00',
    ].join('\n');

    const detected = detectMapping(inspectHeaders(csv).headers)!;
    expect(detected.mapping).toMatchObject({ date: 'Txn Date', postedDate: 'Value Date' });

    const { rows, errors } = parseTransactions(csv, detected.mapping);
    expect(errors).toEqual([]);
    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-03-02', 325],
      ['2026-03-04', -50000],
    ]);
  });

  it('reads ICICI-style headers that carry a currency in brackets', () => {
    const csv = [
      'S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount (INR ),Deposit Amount (INR ),Balance (INR )',
      '1,03/03/2026,03/03/2026,-,UPI/606212345678/AMAZON PAY,"1,499.00",0.00,"20,000.00"',
    ].join('\n');

    const detected = detectMapping(inspectHeaders(csv).headers)!;
    expect(detected.mapping).toMatchObject({
      date: 'Transaction Date',
      description: 'Transaction Remarks',
      debit: 'Withdrawal Amount (INR )',
      credit: 'Deposit Amount (INR )',
    });
    expect(parseTransactions(csv, detected.mapping).rows[0]).toMatchObject({
      date: '2026-03-03',
      amount: 1499,
    });
  });

  it('takes the sign from a Dr/Cr column when there is one amount column', () => {
    const csv = [
      'Date,Description,Amount,Dr / Cr',
      '15/03/2026,UPI FLIPKART,999.00,DR',
      '16/03/2026,REFUND FLIPKART,999.00,CR',
    ].join('\n');

    const detected = detectMapping(inspectHeaders(csv).headers)!;
    expect(detected.mapping.drCr).toBe('Dr / Cr');
    expect(parseTransactions(csv, detected.mapping).rows.map((r) => r.amount)).toEqual([999, -999]);
  });

  it('takes the sign from a Cr/Dr suffix on the figure', () => {
    const csv = ['Date,Description,Amount', '15/03/2026,SALARY,"50,000.00 Cr"'].join('\n');
    expect(parseTransactions(csv, GENERIC_MAPPING).rows[0].amount).toBe(-50000);
  });

  it('says when day-first was assumed rather than proved', () => {
    const csv = [
      'Date,Description,Amount',
      '03/05/2026,X CORP,1.00',
      '04/05/2026,Y CORP,2.00',
    ].join('\n');
    const { rows, dateOrder } = parseTransactions(csv, GENERIC_MAPPING);
    expect(dateOrder).toEqual({ order: 'dmy', basis: 'default' });
    expect(rows[0].date).toBe('2026-05-03');

    // The user can overrule it.
    const asUs = parseTransactions(csv, { ...GENERIC_MAPPING, dateOrder: 'mdy' });
    expect(asUs.dateOrder).toEqual({ order: 'mdy', basis: 'mapping' });
    expect(asUs.rows[0].date).toBe('2026-03-05');
  });

  it('reads a month-first file as month-first when the file proves it', () => {
    const csv = [
      'Date,Description,Amount',
      '03/05/2026,X CORP,1.00',
      '03/15/2026,Y CORP,2.00',
    ].join('\n');
    const { rows, dateOrder } = parseTransactions(csv, GENERIC_MAPPING);
    expect(dateOrder).toEqual({ order: 'mdy', basis: 'file' });
    expect(rows[0].date).toBe('2026-03-05');
  });

  it('does not call ISO dates an assumption', () => {
    const csv = ['date,description,amount', '2026-03-01,X CORP,1.00'].join('\n');
    expect(parseTransactions(csv, GENERIC_MAPPING).dateOrder.basis).toBe('file');
  });

  it('reports a row with both, or neither, of debit and credit', () => {
    const csv = [
      'Date,Narration,Debit,Credit',
      '01/03/2026,BOTH,10.00,20.00',
      '02/03/2026,NEITHER,,',
      '03/03/2026,BAD,abc,',
    ].join('\n');
    const mapping = detectMapping(inspectHeaders(csv).headers)!.mapping;
    const { rows, errors } = parseTransactions(csv, mapping);
    expect(rows).toEqual([]);
    expect(errors.map((e) => e.reason)).toEqual([
      'Row has both a debit and a credit',
      'Row has neither a debit nor a credit',
      'Unrecognised amount: "abc"',
    ]);
  });
});

describe('detectMapping', () => {
  it('keeps the exact US presets, with their month-first dates', () => {
    const chase = detectMapping(['Transaction Date', 'Post Date', 'Description', 'Amount'])!;
    expect(chase.id).toBe('chase');
    expect(chase.mapping.dateOrder).toBe('mdy');
  });

  it('reads the generic export as before', () => {
    expect(detectMapping(['date', 'description', 'amount', 'account'])).toMatchObject({
      id: 'generic',
      mapping: { date: 'date', description: 'description', amount: 'amount' },
    });
  });

  it('asks when it cannot find the date, the description and the money', () => {
    expect(detectMapping(['Posted', 'Merchant Name', 'Debit'])).toBeNull();
    expect(detectMapping(['Date', 'Narration', 'Balance'])).toBeNull();
  });
});
