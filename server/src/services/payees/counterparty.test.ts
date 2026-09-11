import { describe, expect, it } from 'vitest';

import {
  hasNoCounterparty,
  matchKeyFor,
  nameFromNarration,
  payeeTypeOf,
  resolveCounterparty,
} from './counterparty';

describe('nameFromNarration', () => {
  it.each([
    ['PAYTM WALLET TO SAM R', 'SAM R'],
    ['PAYTM WALLET FROM SAM R', 'SAM R'],
    ['PAYTM WALLET TO PRIYA N', 'PRIYA N'],
    ['PHONEPE*ARJUN M', 'ARJUN M'],
    ['PHONEPE*ALEX T', 'ALEX T'],
    ['GPAY*MEENA S', 'MEENA S'],
    ['UPI/TO/RAMESH KUMAR', 'RAMESH KUMAR'],
    ['IMPS FROM ANITA NAIR', 'ANITA NAIR'],
    ['Paid to Anand Sweets', 'Anand Sweets'],
    ['Received from Ramesh Kumar', 'Ramesh Kumar'],
  ])('lifts the other party out of %s', (description, expected) => {
    expect(nameFromNarration(description)).toBe(expected);
  });

  it.each([
    ['PHONEPE*REFUND', 'the return leg of a payment, not a person called Refund'],
    ['PAYTM WALLET TO SELF', 'the user’s own wallet'],
    ['PHONEPE*PAYMENT', 'a word in the name position that is not a name'],
    ['PHONEPE*1039485', 'a reference number with no letters in it'],
  ])('refuses to make a payee out of %s (%s)', (description) => {
    expect(nameFromNarration(description)).toBeNull();
  });

  it.each([
    ['GPAY PAYMENT 1039485', 'the rail printed a reference, not a name'],
    ['SWIGGY', 'an ordinary merchant line'],
    ['ATW-41223 CASH WDL', 'a withdrawal has no other party'],
  ])('finds no name in %s (%s)', (description) => {
    expect(nameFromNarration(description)).toBeNull();
  });

  it('drops a trailing reference number from a captured name', () => {
    expect(nameFromNarration('PAYTM WALLET TO SAM R 88213')).toBe('SAM R');
  });
});

describe('resolveCounterparty', () => {
  const line = (description: string, normalizedMerchant: string, extra = {}) => ({
    description,
    rawMerchant: description,
    normalizedMerchant,
    ...extra,
  });

  it('prefers the counterparty a UPI export named over anything derived', () => {
    const resolved = resolveCounterparty(
      line('UPI/RAMESH KUMAR/9876543210@ybl', 'RAMESH KUMAR', {
        counterpartyRaw: 'Ramesh Kumar',
        upiVpa: '9876543210@ybl',
      }),
    );

    expect(resolved).toMatchObject({
      displayName: 'Ramesh Kumar',
      upiVpa: '9876543210@ybl',
      phone: '9876543210',
      type: 'PERSON',
    });
  });

  it('lifts the person out of a wallet narration the merchant key throws away', () => {
    // `PAYTM WALLET TO SAM R` normalizes to PAYTM WALLET, and has to — the rule
    // engine needs that key to read a wallet payment as a TRANSFER. A ledger
    // built on it would file everyone the user has ever paid under one heading.
    expect(resolveCounterparty(line('PAYTM WALLET TO SAM R', 'PAYTM WALLET'))).toMatchObject({
      displayName: 'SAM R',
      type: 'PERSON',
    });
  });

  it('gives the two legs of a round trip the same match key', () => {
    const out = resolveCounterparty(line('PAYTM WALLET TO SAM R', 'PAYTM WALLET'));
    const back = resolveCounterparty(line('PAYTM WALLET FROM SAM R', 'PAYTM WALLET'));

    expect(out?.matchKey).toBe(back?.matchKey);
  });

  it('keeps two people paid through the same wallet apart', () => {
    const sam = resolveCounterparty(line('PAYTM WALLET TO SAM R', 'PAYTM WALLET'));
    const priya = resolveCounterparty(line('PAYTM WALLET TO PRIYA N', 'PAYTM WALLET'));

    expect(sam?.matchKey).not.toBe(priya?.matchKey);
  });

  it('falls back to the rail when the narration names nobody', () => {
    // `GPAY PAYMENT 1039485` carries a reference and no name. The rail is the
    // honest answer; inventing a person from the digits would not be.
    expect(resolveCounterparty(line('GPAY PAYMENT 1039485', 'GPAY'))).toMatchObject({
      displayName: 'GPAY',
    });
  });

  it('uses the merchant key for an ordinary shop', () => {
    expect(resolveCounterparty(line('SWIGGY', 'SWIGGY'))).toMatchObject({
      displayName: 'SWIGGY',
      type: 'BUSINESS',
    });
  });

  it('does not call a shop a person just because a wallet paid it', () => {
    expect(resolveCounterparty(line('PAYTM WALLET TO SWIGGY', 'PAYTM WALLET'))).toMatchObject({
      displayName: 'SWIGGY',
      type: 'BUSINESS',
    });
  });

  it('strips the bank suffix from a name taken off a UPI address', () => {
    expect(resolveCounterparty(line('x', 'x', { upiVpa: 'ramesh.kumar@okaxis' }))).toMatchObject({
      displayName: 'Ramesh Kumar',
      upiVpa: 'ramesh.kumar@okaxis',
      phone: null,
    });
  });

  it('returns nothing when there is nothing to go on', () => {
    expect(resolveCounterparty(line('', ''))).toBeNull();
  });
});

describe('matchKeyFor', () => {
  it.each([
    ['Ramesh Kumar', 'RAMESH KUMAR'],
    ['Ramesh  Kumar', ' ramesh kumar '],
  ])('matches %s and %s', (a, b) => {
    // A bank shouts; a UPI app does not. The same person must not become two
    // ledger entries over a capital letter.
    expect(matchKeyFor(a)).toBe(matchKeyFor(b));
  });

  it('keeps different people apart', () => {
    expect(matchKeyFor('SAM R')).not.toBe(matchKeyFor('SAM K'));
  });
});

describe('hasNoCounterparty', () => {
  it.each(['CASH_WITHDRAWAL', 'FEES_INTEREST'])('gives %s no payee', (category) => {
    expect(hasNoCounterparty(category)).toBe(true);
  });

  it.each(['GROCERIES', 'TRANSFER', 'INCOME', 'UNCATEGORIZED'])(
    'still resolves a payee for %s',
    (category) => {
      expect(hasNoCounterparty(category)).toBe(false);
    },
  );

  it.each([
    ['ATW-41223 CASH WDL', 'an SBI withdrawal code'],
    ['NWD ATM HDFC BANK', 'a withdrawal at another bank’s machine'],
    ['CASH WDL', 'the bare narration'],
    ['ATM FEE', 'a charge for using the machine'],
  ])('reads %s as having no counterparty even while UNCATEGORIZED (%s)', (merchant) => {
    // The bug CI caught. `applyRuleEngine` reads rules from the database and
    // does not seed them, so on a fresh database every row is UNCATEGORIZED
    // when resolution reaches it — and the rule engine leaves a tail
    // UNCATEGORIZED on every real import anyway. Either way a withdrawal was
    // becoming a payee named after its own narration.
    expect(hasNoCounterparty('UNCATEGORIZED', merchant)).toBe(true);
  });

  it.each(['SAM R', 'SWIGGY', 'PAYTM WALLET', 'RAMESH KUMAR'])(
    'still gives %s a payee when the category is not yet known',
    (merchant) => {
      expect(hasNoCounterparty('UNCATEGORIZED', merchant)).toBe(false);
    },
  );

  it('does not need a merchant key to answer from the category', () => {
    expect(hasNoCounterparty('CASH_WITHDRAWAL', '')).toBe(true);
    expect(hasNoCounterparty('UNCATEGORIZED', '')).toBe(false);
  });
});

describe('payeeTypeOf', () => {
  it('keeps what Phase 14 could tell', () => {
    expect(payeeTypeOf('PERSON')).toBe('PERSON');
    expect(payeeTypeOf('BUSINESS')).toBe('BUSINESS');
  });

  it('collapses UNKNOWN to BUSINESS, which is the one lossy step', () => {
    // `Payee.type` has two values and the classifier answers three. This is the
    // only place that gap is closed, so it is the only place to change if the
    // column ever gains an UNKNOWN.
    expect(payeeTypeOf('UNKNOWN')).toBe('BUSINESS');
  });
});
