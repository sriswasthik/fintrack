import { describe, expect, it } from 'vitest';

import { redactStatementText } from './redact';

// Every name, number and address below is invented.
const STATEMENT = [
  'EXAMPLE BANK LTD',
  'A SAMPLE PERSON',
  '12 Example Road, Sample Nagar, Bengaluru 560001',
  'Account No : 123456789012     IFSC : EXMP0001234',
  'Customer ID : 88776655    PAN : ABCDE1234F',
  'Email : sample.person@example.com',
  'Statement from 01/03/2026 to 31/03/2026',
  '',
  'Date Narration Withdrawal Deposit Balance',
  '01/03/2026 UPI/606012345678/SWIGGY/swiggy@icici 450.00 52,550.00',
  '05/03/2026 NEFT CR-NORTHWIND LABS SALARY 85,000.00 1,37,550.00',
  'SALARY FOR FEB',
  '',
  'EXAMPLE BANK LTD      Page 2',
  'Account No : 123456789012',
  'Date Narration Withdrawal Deposit Balance',
  '13/03/2026 UPI/9876543210@ybl/RAMESH KUMAR 1,234.50 1,36,315.50',
  '14/03/2026 AADHAAR PAY 1234 5678 9012 99.00 1,36,216.50',
  '',
  'Closing balance 1,36,216.50',
  'Registered office: 1 Example Tower, Mumbai. Call 1800-000-0000.',
].join('\n');

describe('redactStatementText', () => {
  const { text, droppedLines, masked } = redactStatementText(STATEMENT);

  it('keeps every transaction row and continuation line', () => {
    expect(text).toContain('01/03/2026 UPI/XXXXXXXX5678/SWIGGY/swiggy@icici 450.00 52,550.00');
    expect(text).toContain('05/03/2026 NEFT CR-NORTHWIND LABS SALARY 85,000.00 1,37,550.00');
    expect(text).toContain('SALARY FOR FEB');
    expect(text).toContain('13/03/2026 UPI/XXXXXX3210@ybl/RAMESH KUMAR 1,234.50 1,36,315.50');
  });

  it('keeps the column titles, which say which figure is which', () => {
    expect(text).toContain('Date Narration Withdrawal Deposit Balance');
  });

  it('drops the account holder, address and identifiers above the table', () => {
    expect(text).not.toMatch(/A SAMPLE PERSON|Example Road|560001|EXMP0001234|88776655/);
    expect(text).not.toMatch(/sample\.person@example\.com|ABCDE1234F/);
  });

  it('drops the account details a statement repeats on every page', () => {
    expect(text).not.toContain('123456789012');
    expect(text).not.toMatch(/Account No/);
  });

  it('drops the footer below the last transaction', () => {
    expect(text).not.toMatch(/Registered office|1800-000-0000/);
  });

  it('masks an Aadhaar-shaped number inside a row', () => {
    expect(text).toContain('14/03/2026 AADHAAR PAY [ID] 99.00 1,36,216.50');
  });

  it('never touches a date or an amount', () => {
    expect(text).toContain('85,000.00');
    expect(redactStatementText('01/03/2026 BIG TRANSFER 123456789012.00').text).toBe(
      '01/03/2026 BIG TRANSFER 123456789012.00',
    );
  });

  it('says how much it held back', () => {
    expect(droppedLines).toBeGreaterThanOrEqual(8);
    expect(masked).toBe(3);
  });

  it('masks PAN and email even inside a row', () => {
    expect(
      redactStatementText('02/03/2026 TAX ABCDE1234F refund to a.b@example.com 10.00').text,
    ).toBe('02/03/2026 TAX [PAN] refund to [email] 10.00');
  });

  it('takes the span of dated lines when no line carries a date and an amount', () => {
    const split = ['Name : A SAMPLE PERSON', '01/03/2026', 'SWIGGY', '450', '02/03/2026', 'ZOMATO'];
    expect(redactStatementText(split.join('\n')).text).toBe(
      ['01/03/2026', 'SWIGGY', '450', '02/03/2026'].join('\n'),
    );
  });

  it('sends nothing when there is no transaction to read', () => {
    expect(redactStatementText('Dear customer,\nThank you for banking with us.')).toEqual({
      text: '',
      droppedLines: 2,
      masked: 0,
    });
  });
});
