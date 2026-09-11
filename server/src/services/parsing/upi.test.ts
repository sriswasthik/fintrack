import { describe, expect, it } from 'vitest';

import { normalizeVpa, parseVpa } from './upi';

describe('parseVpa', () => {
  it('splits an address into its handle and PSP suffix', () => {
    expect(parseVpa('ramesh.kumar@okaxis')).toMatchObject({
      handle: 'ramesh.kumar',
      psp: 'okaxis',
      knownPsp: true,
      merchantPsp: false,
      phoneHandle: false,
    });
  });

  it('lowercases whatever case the statement shouted in', () => {
    expect(parseVpa('  RAMESH.KUMAR@OKAXIS  ')?.vpa).toBe('ramesh.kumar@okaxis');
  });

  it('recognises a mobile number as the handle', () => {
    expect(parseVpa('9876543210@ybl')?.phoneHandle).toBe(true);
    expect(parseVpa('919876543210@paytm')?.phoneHandle).toBe(true);
  });

  it('rejects a handle carrying a +, which a VPA cannot', () => {
    expect(parseVpa('+919876543210@paytm')).toBeNull();
  });

  it('does not mistake a short or non-mobile number for one', () => {
    // Indian mobile numbers start 6-9; a ten-digit number starting 1 is not one.
    expect(parseVpa('1234567890@ybl')?.phoneHandle).toBe(false);
    expect(parseVpa('98765@ybl')?.phoneHandle).toBe(false);
  });

  it('marks a merchant-only PSP suffix', () => {
    expect(parseVpa('anandsweets@okbizaxis')?.merchantPsp).toBe(true);
    expect(parseVpa('ramesh@okaxis')?.merchantPsp).toBe(false);
  });

  it('reports an unrecognised suffix rather than rejecting it', () => {
    // NPCI adds handles continuously; an unknown one is still a VPA.
    const parsed = parseVpa('someone@brandnewbank');
    expect(parsed).not.toBeNull();
    expect(parsed?.knownPsp).toBe(false);
    expect(parsed?.display).toBe('Someone');
  });

  it.each([
    ['', 'empty'],
    ['ramesh.kumar', 'no @ at all'],
    ['@okaxis', 'no handle'],
    ['ramesh@', 'no suffix'],
    ['care@phonepe.com', 'an email: the dotted domain gives it away'],
    ['a@b@c', 'two @ signs'],
  ])('rejects %s (%s)', (input) => {
    expect(parseVpa(input)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(parseVpa(null)).toBeNull();
    expect(parseVpa(undefined)).toBeNull();
  });
});

describe('normalizeVpa', () => {
  it.each([
    ['ramesh.kumar@okaxis', 'Ramesh Kumar'],
    ['ramesh_kumar@ybl', 'Ramesh Kumar'],
    ['ramesh-kumar@paytm', 'Ramesh Kumar'],
    ['sunilmehta@oksbi', 'Sunilmehta'],
    ['priya@upi', 'Priya'],
  ])('strips the bank suffix from %s', (vpa, expected) => {
    expect(normalizeVpa(vpa)).toBe(expected);
  });

  it.each(['okaxis', 'oksbi', 'ybl', 'ibl', 'paytm', 'upi', 'apl', 'axl', 'hdfcbank', 'kotak'])(
    'strips the @%s handle',
    (psp) => {
      expect(normalizeVpa(`arjun@${psp}`)).toBe('Arjun');
    },
  );

  it('leaves a phone-number handle as digits rather than title-casing it', () => {
    expect(normalizeVpa('9876543210@ybl')).toBe('9876543210');
  });

  it('leaves an opaque merchant id alone', () => {
    // "Q629384756" is no more readable than "q629384756", and pretending it is
    // a name would be asserting something nobody recorded.
    expect(normalizeVpa('q629384756@paytm')).toBe('q629384756');
    expect(normalizeVpa('paytmqr2810050501@paytm')).toBe('paytmqr2810050501');
  });

  it('passes a non-VPA through trimmed, so a caller can hand it anything', () => {
    expect(normalizeVpa('  Ramesh Kumar  ')).toBe('Ramesh Kumar');
    expect(normalizeVpa('care@phonepe.com')).toBe('care@phonepe.com');
    expect(normalizeVpa(null)).toBe('');
  });
});
