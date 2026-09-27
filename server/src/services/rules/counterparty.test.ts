import { describe, expect, it } from 'vitest';

import { classifyCounterparty } from './counterparty';
import { COUNTERPARTY_SAMPLE } from './counterparty-sample';

describe('the labeled sample', () => {
  it.each(COUNTERPARTY_SAMPLE)('$note', ({ expected, note: _note, ...input }) => {
    expect(classifyCounterparty(input).type).toBe(expected);
  });

  it('is correct on every row of the sample', () => {
    const wrong = COUNTERPARTY_SAMPLE.filter(
      ({ expected, note: _note, ...input }) => classifyCounterparty(input).type !== expected,
    );
    expect(wrong).toEqual([]);
  });

  it('covers all three verdicts, so the sample can actually fail', () => {
    const labels = new Set(COUNTERPARTY_SAMPLE.map((s) => s.expected));
    expect([...labels].sort()).toEqual(['BUSINESS', 'PERSON', 'UNKNOWN']);
  });
});

describe('classifyCounterparty', () => {
  it('gives a reason for every verdict', () => {
    COUNTERPARTY_SAMPLE.forEach(({ expected: _expected, note: _note, ...input }) => {
      expect(classifyCounterparty(input).reason).not.toBe('');
    });
  });

  it('ranks a business word above a person-shaped name', () => {
    // "Reliance Fresh" is two title-cased words. It is not a person.
    expect(classifyCounterparty({ counterpartyRaw: 'Sharma Traders' })).toMatchObject({
      type: 'BUSINESS',
      reason: expect.stringContaining('TRADERS'),
    });
  });

  it('ranks a merchant-only handle above everything else', () => {
    expect(
      classifyCounterparty({ counterpartyRaw: 'Ramesh Kumar', upiVpa: 'ramesh@okbizaxis' }),
    ).toMatchObject({ type: 'BUSINESS' });
  });

  it('does not read a phone number as a person when the handle is a merchant one', () => {
    expect(classifyCounterparty({ upiVpa: '9876543210@okbizaxis' }).type).toBe('BUSINESS');
  });

  it('abstains rather than guessing from a single word', () => {
    expect(classifyCounterparty({ counterpartyRaw: 'Adda' }).type).toBe('UNKNOWN');
    expect(classifyCounterparty({ counterpartyRaw: 'Ramesh Kumar Sharma Iyer' }).type).toBe(
      'UNKNOWN',
    );
  });

  it('abstains on nothing at all', () => {
    expect(classifyCounterparty({}).type).toBe('UNKNOWN');
    expect(classifyCounterparty({ counterpartyRaw: null, upiVpa: null }).type).toBe('UNKNOWN');
  });

  it('strips the bank suffix from the name it hands back', () => {
    expect(classifyCounterparty({ upiVpa: 'ramesh.kumar@okaxis' }).display).toBe('Ramesh Kumar');
  });

  it('prefers the name the source gave over one derived from the handle', () => {
    expect(
      classifyCounterparty({ counterpartyRaw: 'Ramesh Kumar', upiVpa: 'rk1987@ybl' }).display,
    ).toBe('Ramesh Kumar');
  });

  it('does not read a narration keyword as recognising a merchant', () => {
    // `\bATM\b` and `\bEMI\b` say what the *line* is. A cash withdrawal has
    // no counterparty at all, so claiming it is a business is inventing one.
    expect(classifyCounterparty({ normalizedMerchant: 'ATW-4122 CASH WDL' }).type).toBe('UNKNOWN');
    expect(classifyCounterparty({ normalizedMerchant: 'NWD ATM HDFC BANK' }).type).toBe('UNKNOWN');
    expect(classifyCounterparty({ normalizedMerchant: 'EMI HDB FINANCIAL' }).type).toBe('UNKNOWN');
  });

  it('still recognises a merchant named by a brand rule', () => {
    ['SWIGGY', 'BESCOM', 'ZERODHA', 'MAHANAGAR GAS'].forEach((merchant) => {
      expect(classifyCounterparty({ normalizedMerchant: merchant })).toMatchObject({
        type: 'BUSINESS',
        reason: expect.stringContaining('recognized merchant'),
      });
    });
  });

  it('takes a caller-supplied notion of a known merchant', () => {
    // A user's own learned rules should be able to count, so the predicate is
    // injectable rather than hard-wired to the built-ins.
    expect(
      classifyCounterparty(
        { normalizedMerchant: 'THE ADDA' },
        { isKnownMerchant: (m) => m === 'THE ADDA' },
      ),
    ).toMatchObject({ type: 'BUSINESS' });
    expect(classifyCounterparty({ normalizedMerchant: 'THE ADDA' }).type).toBe('UNKNOWN');
  });
});
