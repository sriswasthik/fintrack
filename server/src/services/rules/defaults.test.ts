/**
 * Tests for the Indian merchant rule set added in Phase 14, and for the
 * property that keeps a rule set this size honest: no two rules may be able to
 * claim the same merchant at the same priority with different answers.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES } from './defaults';
import { matchRule, orderRules, type EngineRule } from './engine';

const ordered: EngineRule[] = orderRules(
  DEFAULT_RULES.map((rule, i) => ({
    id: `builtin-${String(i).padStart(4, '0')}`,
    pattern: rule.pattern,
    category: rule.category,
    priority: rule.priority,
    userId: null,
    learnedFromOverride: false,
  })),
);

const categoryOf = (merchant: string) => matchRule(merchant, ordered)?.category ?? 'UNCATEGORIZED';

describe('the Indian merchant rules', () => {
  it.each([
    // Food delivery
    ['SWIGGY', 'DINING'],
    ['ZOMATO', 'DINING'],
    // Quick commerce and grocery
    ['BIGBASKET', 'GROCERIES'],
    ['BLINKIT', 'GROCERIES'],
    ['ZEPTO', 'GROCERIES'],
    ['INSTAMART', 'GROCERIES'],
    ['DMART', 'GROCERIES'],
    ['JIOMART', 'GROCERIES'],
    // E-commerce
    ['AMAZON', 'SHOPPING'],
    ['AMAZON MARKETPLACE', 'SHOPPING'],
    ['FLIPKART', 'SHOPPING'],
    ['MYNTRA', 'SHOPPING'],
    ['AJIO', 'SHOPPING'],
    // Ride hailing
    ['OLA', 'TRANSPORTATION'],
    ['UBER', 'TRANSPORTATION'],
    ['RAPIDO', 'TRANSPORTATION'],
    ['NAMMA YATRI', 'TRANSPORTATION'],
    // Rail and travel
    ['IRCTC', 'TRAVEL'],
    ['MAKEMYTRIP', 'TRAVEL'],
    ['REDBUS', 'TRAVEL'],
    ['IXIGO', 'TRAVEL'],
    // Telecom
    ['AIRTEL', 'UTILITIES'],
    ['JIO', 'UTILITIES'],
    ['VI', 'UTILITIES'],
    ['BSNL', 'UTILITIES'],
    // OTT and subscriptions
    ['JIOCINEMA', 'SUBSCRIPTIONS'],
    ['HOTSTAR', 'SUBSCRIPTIONS'],
    ['NETFLIX', 'SUBSCRIPTIONS'],
    ['SPOTIFY', 'SUBSCRIPTIONS'],
    // Investments
    ['ZERODHA', 'INVESTMENTS'],
    ['GROWW', 'INVESTMENTS'],
    ['UPSTOX', 'INVESTMENTS'],
    ['SIP PURCHASE', 'INVESTMENTS'],
    ['NIPPON INDIA', 'INVESTMENTS'],
    ['SBI MUTUAL FUND', 'INVESTMENTS'],
    ['PARAG PARIKH', 'INVESTMENTS'],
    // Insurance
    ['LIC', 'INSURANCE'],
    ['HDFC LIFE', 'INSURANCE'],
    ['MAX LIFE', 'INSURANCE'],
    ['TATA AIG', 'INSURANCE'],
    ['STAR HEALTH', 'INSURANCE'],
    ['ACKO', 'INSURANCE'],
    // EMI and loans
    ['EMI', 'EMI_LOAN'],
    ['LOANEMI', 'EMI_LOAN'],
    ['BAJAJ FINANCE', 'EMI_LOAN'],
    ['TATA CAPITAL', 'EMI_LOAN'],
    ['MUTHOOT', 'EMI_LOAN'],
    ['HDB FINANCIAL', 'EMI_LOAN'],
    // Cash
    ['ATM', 'CASH_WITHDRAWAL'],
    ['CASH WDL', 'CASH_WITHDRAWAL'],
    ['ATM WDL', 'CASH_WITHDRAWAL'],
    ['NWD', 'CASH_WITHDRAWAL'],
  ])('categorizes %s as %s', (merchant, expected) => {
    expect(categoryOf(merchant)).toBe(expected);
  });

  it.each([
    ['BESCOM', 'UTILITIES'],
    ['MSEDCL NAGPUR', 'UTILITIES'],
    ['TANGEDCO', 'UTILITIES'],
    ['TSSPDCL', 'UTILITIES'],
    ['BSES RAJDHANI', 'UTILITIES'],
    ['HESCOM HUBLI', 'UTILITIES'],
    ['PASCHIM GUJARAT VIJ COMPANY', 'UTILITIES'],
    ['MAHANAGAR GAS', 'UTILITIES'],
    ['INDRAPRASTHA GAS', 'UTILITIES'],
    ['BHARAT GAS', 'UTILITIES'],
    ['BWSSB', 'UTILITIES'],
  ])('reads the electricity, gas and water supplier %s as %s', (merchant, expected) => {
    expect(categoryOf(merchant)).toBe(expected);
  });

  it('keeps a discom acronym matching when a circle name trails it', () => {
    // Not every Indian city is in the normalizer's place list, so the acronym
    // patterns must not be anchored to the end of the string.
    expect(categoryOf('MSEDCL AURANGABAD')).toBe('UTILITIES');
    expect(categoryOf('UHBVN PANIPAT')).toBe('UTILITIES');
  });
});

describe('names one Indian group uses for two businesses', () => {
  it.each([
    ['LIC', 'INSURANCE'],
    ['LIC HFL', 'EMI_LOAN'],
    ['LICHFL', 'EMI_LOAN'],
    ['LIC HOUSING FINANCE', 'EMI_LOAN'],
    ['ICICI PRUDENTIAL', 'INVESTMENTS'],
    ['ICICI PRUDENTIAL LIFE', 'INSURANCE'],
    ['ICICI PRU LIFE', 'INSURANCE'],
    ['ADITYA BIRLA SUN LIFE', 'INVESTMENTS'],
    ['ADITYA BIRLA SUN LIFE INSURANCE', 'INSURANCE'],
    ['CHOLAMANDALAM', 'EMI_LOAN'],
    ['CHOLAMANDALAM MS', 'INSURANCE'],
    ['SWIGGY', 'DINING'],
    ['SWIGGY INSTAMART', 'GROCERIES'],
    ['AMAZON', 'SHOPPING'],
    ['AMAZON PRIME', 'SUBSCRIPTIONS'],
    ['SPENCERS', 'GROCERIES'],
    ['SPENCERS HYPER', 'SHOPPING'],
  ])('reads %s as %s', (merchant, expected) => {
    expect(categoryOf(merchant)).toBe(expected);
  });
});

describe('the narration band', () => {
  it('leaves ATM FEE a fee rather than a withdrawal', () => {
    // The specific keyword sits above the generic narration rule on purpose: a
    // charge for using the machine is not the cash that came out of it.
    expect(categoryOf('ATM FEE')).toBe('FEES_INTEREST');
    expect(categoryOf('ATM')).toBe('CASH_WITHDRAWAL');
  });

  it('still puts a card payment above everything', () => {
    // §8 case 1: a card payment is never spending, whatever else is in the line.
    expect(categoryOf('HDFC CARD PAYMENT')).toBe('TRANSFER');
    expect(categoryOf('HDFC CARD PAYMENT EMI')).toBe('TRANSFER');
  });
});

describe('rule ordering is decided by the rule set, not by rule ids', () => {
  /**
   * Turns a pattern back into a merchant string it would match, so every rule
   * can be probed against every other one.
   */
  const probe = (pattern: string): string =>
    pattern
      .replace(/\\b/g, '')
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\(([^)]*)\)\?/g, '')
      .replace(/\(([^)|]*)\|[^)]*\)/g, '$1')
      .replace(/\?/g, '')
      .replace(/\+/g, '')
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  it('never lets two rules of the same priority disagree about one merchant', () => {
    // `orderRules` breaks a priority tie with the rule id, and in the database
    // an id is a cuid — so a tie means the answer is decided by insertion order
    // and is a different answer in the tests than in production. This is the
    // test that caught `^SPENCERS` shadowing `^SPENCERS HYPER`.
    const ambiguous: string[] = [];

    for (const rule of DEFAULT_RULES) {
      const merchant = probe(rule.pattern);
      if (!merchant) continue;

      const matching = DEFAULT_RULES.filter((other) => new RegExp(other.pattern, 'i').test(merchant));
      const best = Math.min(...matching.map((m) => m.priority));
      const categories = new Set(
        matching.filter((m) => m.priority === best).map((m) => m.category),
      );
      if (categories.size > 1) {
        ambiguous.push(`${merchant} → ${[...categories].join(' vs ')}`);
      }
    }

    expect([...new Set(ambiguous)]).toEqual([]);
  });
});
