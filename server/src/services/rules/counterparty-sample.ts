/**
 * A hand-labeled sample for the person-vs-business classifier.
 *
 * Kept as data rather than as assertions inside a test so the sample can be
 * read, extended and argued with on its own terms — the same reason
 * `ai/eval-set.ts` exists for categorization.
 *
 * The labels are what a person reading the statement line would say, which is
 * the only ground truth available: nothing upstream records whether a UPI
 * counterparty was a shop or a human. Where a reader could not tell either,
 * the label is UNKNOWN and a confident answer is the failure.
 */
import type { CounterpartyInput, CounterpartyType } from './counterparty';

export interface CounterpartySample extends CounterpartyInput {
  expected: CounterpartyType;
  note: string;
}

export const COUNTERPARTY_SAMPLE: CounterpartySample[] = [
  // --- People -----------------------------------------------------------
  {
    counterpartyRaw: 'Ramesh Kumar',
    upiVpa: 'ramesh.kumar@okaxis',
    expected: 'PERSON',
    note: 'Two title-cased words, and a personal-name handle agreeing',
  },
  {
    counterpartyRaw: 'Anita R Nair',
    upiVpa: 'anitanair@ybl',
    expected: 'PERSON',
    note: 'Three words with a middle initial',
  },
  {
    counterpartyRaw: null,
    upiVpa: '9876543210@ybl',
    expected: 'PERSON',
    note: 'A bare mobile number is how an individual address is made',
  },
  {
    counterpartyRaw: null,
    upiVpa: '918123456789@paytm',
    expected: 'PERSON',
    note: 'Same, with the country code the app sometimes prints',
  },
  {
    counterpartyRaw: 'Priya Sharma',
    upiVpa: null,
    expected: 'PERSON',
    note: 'A name with no UPI address at all',
  },
  {
    counterpartyRaw: null,
    upiVpa: 'sunil.mehta@oksbi',
    expected: 'PERSON',
    note: 'firstname.lastname handle, no counterparty string',
  },
  {
    counterpartyRaw: 'Dr Meera Iyer',
    upiVpa: null,
    expected: 'PERSON',
    note: 'An honorific is not part of the name and must not add a word',
  },

  // --- Businesses -------------------------------------------------------
  {
    counterpartyRaw: 'Shree Ganesh Kirana Stores',
    upiVpa: 'shreeganesh@ybl',
    expected: 'BUSINESS',
    note: 'STORES — a business word, on an otherwise person-shaped handle',
  },
  {
    counterpartyRaw: 'BALAJI TRADERS',
    upiVpa: null,
    expected: 'BUSINESS',
    note: 'TRADERS, in the ALL-CAPS a bank narration arrives in',
  },
  {
    counterpartyRaw: 'Kumar Enterprises',
    upiVpa: null,
    expected: 'BUSINESS',
    note: 'ENTERPRISES: the surname does not make it a person',
  },
  {
    counterpartyRaw: 'Sunrise Apparels Pvt Ltd',
    upiVpa: null,
    expected: 'BUSINESS',
    note: 'A legal form is decisive',
  },
  {
    counterpartyRaw: 'Anand Sweets',
    upiVpa: 'anandsweets@okbizaxis',
    expected: 'BUSINESS',
    note: 'A merchant-only Google Pay handle settles it on its own',
  },
  {
    counterpartyRaw: 'Swiggy',
    upiVpa: null,
    normalizedMerchant: 'SWIGGY',
    expected: 'BUSINESS',
    note: 'A merchant the built-in rules already recognise',
  },
  {
    counterpartyRaw: null,
    upiVpa: null,
    normalizedMerchant: 'BESCOM',
    expected: 'BUSINESS',
    note: 'Recognised from the merchant key with no name or address',
  },
  {
    counterpartyRaw: 'Sri Venkateshwara Medicals',
    upiVpa: null,
    expected: 'BUSINESS',
    note: 'MEDICALS — a shop word the categorization keywords miss',
  },
  {
    counterpartyRaw: 'Reliance Fresh',
    upiVpa: null,
    normalizedMerchant: 'RELIANCE FRESH',
    expected: 'BUSINESS',
    note: 'Two title-cased words that are emphatically not a person',
  },

  // --- Genuinely undecidable -------------------------------------------
  // The honest answers. A wrong confident label here is worse than no label:
  // it is a fact about a person invented from a formatting accident.
  {
    counterpartyRaw: 'RAMESH KUMAR',
    upiVpa: null,
    expected: 'UNKNOWN',
    note: 'The same name upper-cased by the bank. The signal is gone',
  },
  {
    counterpartyRaw: null,
    upiVpa: 'q629384756@paytm',
    expected: 'UNKNOWN',
    note: 'An opaque QR-terminal id; could be a stallholder or a chain',
  },
  {
    counterpartyRaw: 'PAYTMQR2810050501011',
    upiVpa: null,
    expected: 'UNKNOWN',
    note: 'A QR string with the shop behind it nowhere in it',
  },
  {
    counterpartyRaw: 'Adda',
    upiVpa: null,
    expected: 'UNKNOWN',
    note: 'One word. A cafe, or somebody nicknamed',
  },
];
