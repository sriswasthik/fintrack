import { describe, expect, it } from 'vitest';

import { generateDataset } from '../../../prisma/seed-data';
import { extractMerchant, normalizeMerchant } from './normalize';

describe('normalizeMerchant', () => {
  describe('processor prefixes (PROJECT_CONTEXT.md §8 case 8)', () => {
    it.each([
      // Pass-through processors: the merchant is on the right of the star.
      ['SQ *JOES COFFEE', 'JOES COFFEE'],
      ['SQ *BLUEBIRD BAKERY', 'BLUEBIRD BAKERY'],
      ['SQ *FARMERS MKT STALL 12', 'FARMERS MKT STALL 12'],
      ['TST* RAMEN TATSU-YA', 'RAMEN TATSU-YA'],
      ['TST* CATERING CO', 'CATERING CO'],
      ['TST* THE HALL - DOWNTOWN', 'THE HALL'],
      ['PAYPAL *WWWSTORE', 'WWWSTORE'],
      ['SP * ALLBIRDS', 'ALLBIRDS'],
      ['DONATION*RED CROSS', 'RED CROSS'],
      // Gateways: the merchant is the gateway itself, the rest is the line item.
      ['DOORDASH*THAI BASIL', 'DOORDASH'],
      ['MTA*NYCT PAYGO', 'MTA'],
      ['CASH APP*JORDAN M', 'CASH APP'],
      ['TICKETMASTER*EVENT', 'TICKETMASTER'],
      ['AMAZON PRIME*MEMBERSHIP', 'AMAZON PRIME'],
      ['UBER   *TRIP', 'UBER'],
      ['LYFT   *RIDE FRI', 'LYFT'],
      ['EXPEDIA*ITIN 7341508', 'EXPEDIA'],
      ['AIRBNB * HM4X6422', 'AIRBNB'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('store numbers and order references', () => {
    it.each([
      ['TARGET 0002623', 'TARGET'],
      ['SAFEWAY #12689', 'SAFEWAY'],
      ['AMC THEATRES #0663', 'AMC THEATRES'],
      ['CHEVRON 0756461', 'CHEVRON'],
      ['DELTA AIR LINES 0062', 'DELTA AIR LINES'],
      ['CROMA RETAIL #R412', 'CROMA RETAIL'],
      // A reference in the middle of the descriptor, not just at the end.
      ['ZARA #482 SOHO', 'ZARA'],
      ['USPS PO 12230660', 'USPS'],
      // Digits that are part of the brand must survive.
      ['1-800-FLOWERS.COM', '1-800-FLOWERS'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('casing, punctuation and outlet words', () => {
    it.each([
      ['Spotify USA', 'SPOTIFY'],
      ["PEET'S COFFEE #1174", 'PEETS COFFEE'],
      ["TRADER JOE'S #421", 'TRADER JOES'],
      ["BJ'S WHOLESALE #331", 'BJS WHOLESALE'],
      ['CVS/PHARMACY #02315', 'CVS PHARMACY'],
      ['PG&E WEB ONLINE', 'PGE'],
      ['STARBUCKS STORE 04122', 'STARBUCKS'],
      ['WHOLE FOODS MKT #104', 'WHOLE FOODS'],
      ['COSTCO WHSE #1188', 'COSTCO'],
      ['WALMART SUPERCENTER #2201', 'WALMART'],
      ['PLANET FITNESS CLUB', 'PLANET FITNESS'],
      ['ONE MEDICAL GROUP', 'ONE MEDICAL'],
      ['REI.COM ONLINE', 'REI'],
      ['WAYFAIR.COM ORDER', 'WAYFAIR'],
      ['AMTRAK .COM', 'AMTRAK'],
      ['NETFLIX.COM', 'NETFLIX'],
      ['COURSERA.ORG', 'COURSERA'],
      ['WWW.PATREON.COM* SUPPORT', 'PATREON'],
      ['GITHUB.COM*ACCOUNT', 'GITHUB'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('foreign charges keep the brand, drop the place', () => {
    it.each([
      ['BOOKING.COM AMSTERDAM NL', 'BOOKING.COM'],
      ['SNCF INTERNET PARIS FR', 'SNCF'],
      ['MUJI SHIBUYA TOKYO JP', 'MUJI'],
      ['EL CORTE INGLES MADRID ES', 'EL CORTE INGLES'],
      ['TESCO STORES 3411 LONDON UK', 'TESCO'],
      ['TRENITALIA ROMA IT', 'TRENITALIA'],
      ['IKEA BROOKLYN #442', 'IKEA'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('brands whose canonical name differs from the descriptor', () => {
    it.each([
      ['AMZN Mktp US*RT4G21', 'AMAZON MARKETPLACE'],
      ['PAYPAL *ETSYINC', 'ETSY'],
      ['PAYPAL *STEAMGAMES', 'STEAM'],
      ['NYTIMES*NYTIMES DIGITAL', 'NEW YORK TIMES'],
      ['APPLE.COM/BILL ICLOUD', 'APPLE ICLOUD'],
      ['ADOBE CREATIVE CLOUD', 'ADOBE'],
      ['PAYMENT THANK YOU', 'HDFC CARD PAYMENT'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('person-to-person payments collapse to the network (§8 case 9)', () => {
    it.each([
      ['VENMO PAYMENT 1039485', 'VENMO'],
      ['VENMO CASHOUT 1039912', 'VENMO'],
      ['PAYTM WALLET TO SAM R', 'PAYTM WALLET'],
      ['PAYTM WALLET FROM SAM R', 'PAYTM WALLET'],
      ['PAYTM WALLET TO PRIYA N', 'PAYTM WALLET'],
      ['CASH APP*CASHOUT', 'CASH APP'],
    ])('normalizes %s to %s', (raw, expected) => {
      expect(normalizeMerchant(raw)).toBe(expected);
    });
  });

  describe('card payments keep what makes them transfers (§8 case 1)', () => {
    it('rewrites a card-payment descriptor to BANK CARD PAYMENT', () => {
      // If these lose the word PAYMENT, the rule that keeps a card payment out
      // of spend stops matching and the payment is counted as a purchase.
      expect(normalizeMerchant('ONLINE PAYMENT TO HDFC CARD ...4021')).toBe('HDFC CARD PAYMENT');
      expect(normalizeMerchant('PAYMENT TO CAPITAL ONE CARD XXXX1234')).toBe(
        'CAPITAL ONE CARD PAYMENT',
      );
      expect(normalizeMerchant('MOBILE PAYMENT TO AMEX CARD ****9001')).toBe('AMEX CARD PAYMENT');
    });

    it('treats masked account digits as the reference token they are', () => {
      expect(normalizeMerchant('HDFC CARD ...4021')).toBe('HDFC CARD');
      expect(normalizeMerchant('HDFC CARD XXXX4021')).toBe('HDFC CARD');
    });
  });

  describe('returns reduce to the merchant, not the event (§8 case 2)', () => {
    it.each([
      ['ZARA #482 SOHO REFUND', 'ZARA'],
      ['NIKE.COM REFUND', 'NIKE'],
      ['BEST BUY #1120 REFUND', 'BEST BUY'],
      ['REI.COM ONLINE REFUND', 'REI'],
      ['WAYFAIR.COM ORDER REFUND', 'WAYFAIR'],
    ])('reduces a return to the same key as the purchase it reverses: %s', (raw, expected) => {
      // A refund can only be matched to its purchase if both normalize alike.
      expect(normalizeMerchant(raw)).toBe(expected);
    });

    it('strips the purpose of a payment but not the payer', () => {
      expect(normalizeMerchant('STRIPE TRANSFER FREELANCE')).toBe('STRIPE');
      expect(normalizeMerchant('ACME CORP PAYROLL')).toBe('ACME CORP PAYROLL');
    });
  });

  describe('edges', () => {
    it('returns an empty string for empty input', () => {
      expect(normalizeMerchant('')).toBe('');
      expect(normalizeMerchant('   ')).toBe('');
    });

    it('never strips the last remaining token', () => {
      expect(normalizeMerchant('STORE')).toBe('STORE');
      expect(normalizeMerchant('ONLINE')).toBe('ONLINE');
    });

    it('is idempotent', () => {
      const samples = ['SQ *JOES COFFEE', 'WHOLE FOODS MKT #104', 'BOOKING.COM AMSTERDAM NL'];
      samples.forEach((raw) => {
        const once = normalizeMerchant(raw);
        expect(normalizeMerchant(once)).toBe(once);
      });
    });

    it('is stable across casing and padding of the same descriptor', () => {
      expect(normalizeMerchant('  sq *joes coffee  ')).toBe('JOES COFFEE');
    });
  });
});

describe('extractMerchant', () => {
  it('keeps the original descriptor as rawMerchant', () => {
    expect(extractMerchant('  SQ *JOES COFFEE  ')).toEqual({
      rawMerchant: 'SQ *JOES COFFEE',
      normalizedMerchant: 'JOES COFFEE',
    });
  });

  it('collapses the wide padding banks use to separate trailing chatter', () => {
    expect(extractMerchant('UBER   *TRIP').rawMerchant).toBe('UBER *TRIP');
  });
});

describe('the Phase 1 synthetic dataset', () => {
  // test-data/README.md documents the normalized form of every descriptor in the
  // dataset. This asserts the normalizer actually delivers that contract, which
  // is what Phase 3's rule engine and Phase 4's merchant cache will key on.
  const dataset = generateDataset();

  it('normalizes every descriptor to its documented value', () => {
    const mismatches = dataset
      .filter((t) => normalizeMerchant(t.rawMerchant) !== t.normalizedMerchant)
      .map(
        (t) =>
          `${t.rawMerchant} -> ${normalizeMerchant(t.rawMerchant)} (want ${t.normalizedMerchant})`,
      );

    expect(mismatches).toEqual([]);
  });

  it('covers every distinct descriptor shape in the dataset', () => {
    const shapes = new Set(dataset.map((t) => t.rawMerchant.replace(/\d/g, 'D')));
    expect(shapes.size).toBeGreaterThanOrEqual(90);
  });
});

describe('Indian payment-rail narrations (Phase 14)', () => {
  it.each([
    ['UPI/SWIGGY INSTAMART/425512', 'SWIGGY INSTAMART'],
    ['UPI/BLINKIT/998233', 'BLINKIT'],
    ['NEFT/ZERODHA BROKING LTD', 'ZERODHA BROKING LTD'],
    ['IMPS/BAJAJ FINANCE', 'BAJAJ FINANCE'],
    ['RTGS/TATA CAPITAL', 'TATA CAPITAL'],
    ['NACH/GROWW', 'GROWW'],
  ])('strips the rail prefix from %s', (raw, expected) => {
    // Without this the brand is no longer at the start of the string, and every
    // `^BRAND` rule in the set stops matching real UPI narrations.
    expect(normalizeMerchant(raw)).toBe(expected);
  });

  it.each([
    ['ACH D- AXIS MF SIP', 'AXIS MF SIP'],
    ['UPI/DR/MAHANAGAR GAS', 'MAHANAGAR GAS'],
    ['NEFT CR INFOSYS LTD', 'INFOSYS LTD'],
  ])('strips the direction marker that follows the rail in %s', (raw, expected) => {
    expect(normalizeMerchant(raw)).toBe(expected);
  });

  it('keeps the rail word when it is all there is', () => {
    // A line that says only "UPI" has nothing else to be called.
    expect(normalizeMerchant('UPI')).toBe('UPI');
    expect(normalizeMerchant('NEFT')).toBe('NEFT');
  });

  it('drops a UPI address from the merchant key', () => {
    // The address is kept in the transaction's own `upiVpa` column. Left in the
    // key, the same person would get a different key on every app they paid
    // from, and neither dedup nor the merchant cache would ever match them.
    expect(normalizeMerchant('UPI/RAMESH KUMAR/9876543210@ybl')).toBe('RAMESH KUMAR');
    expect(normalizeMerchant('UPI/ANAND SWEETS/anand@okbizaxis')).toBe('ANAND SWEETS');
  });

  it('keeps an email address, which is not a payment address', () => {
    // `care@phonepe.com` in a statement footer is a mailbox, so it survives the
    // VPA drop; the `.COM` then goes the way every domain suffix goes, and the
    // whole key is upper-cased as always.
    expect(normalizeMerchant('SUPPORT care@phonepe.com')).toBe('SUPPORT CARE@PHONEPE');
  });

  it('keeps the address when it is the only thing in the line', () => {
    // Dropping it would leave an empty merchant key, which is worse than an
    // ugly one.
    expect(normalizeMerchant('ramesh@okaxis')).toBe('RAMESH@OKAXIS');
  });

  it('leaves a merchant that merely starts with a rail-like word alone', () => {
    expect(normalizeMerchant('ATOM')).toBe('ATOM');
  });
});
