/**
 * Reading a UPI virtual payment address.
 *
 * A VPA is `handle@psp` — `ramesh.kumar@okaxis`, `9876543210@ybl`,
 * `q629384756@ybl`. The half after the `@` is the bank or payment app that
 * issued the address, not part of anyone's name, and it is noise in every
 * context a person reads: a statement line that says "Paid to
 * ramesh.kumar@okaxis" is telling you the bank twice and the person once.
 *
 * So this module does two things with the suffix and they pull in opposite
 * directions. For display it is stripped. For classification it is kept,
 * because which PSP issued an address is one of the few honest signals about
 * what sits behind it: `@okbizaxis` is only ever a Google Pay *merchant*
 * account, and a handle that is a bare phone number is almost always a person.
 *
 * Nothing here guesses at identity. `ramesh.kumar` becomes "Ramesh Kumar"
 * because that is a formatting change, not an inference; `q629384756` stays as
 * it is, because inventing a name for it would be inventing a fact.
 */

/**
 * PSP suffixes that belong to a bank or a consumer payment app.
 *
 * Not exhaustive and never will be — NPCI adds handles continuously — which is
 * why an unrecognised suffix is reported rather than treated as an error. The
 * display name is stripped either way; only `knownPsp` depends on this list.
 */
const CONSUMER_PSP_SUFFIXES = new Set([
  // Google Pay
  'okaxis',
  'oksbi',
  'okhdfcbank',
  'okicici',
  // PhonePe
  'ybl',
  'ibl',
  'axl',
  // Paytm
  'paytm',
  'ptaxis',
  'ptsbi',
  'ptyes',
  'ptybl',
  // Amazon Pay
  'apl',
  'yapl',
  'rapl',
  // WhatsApp Pay
  'waaxis',
  'wahdfcbank',
  'wasbi',
  'waicici',
  // Banks issuing directly
  'upi',
  'sbi',
  'hdfcbank',
  'icici',
  'axisbank',
  'axisb',
  'kotak',
  'kmbl',
  'pnb',
  'barodampay',
  'yesbank',
  'yesbankltd',
  'idfcbank',
  'idfcfirst',
  'indus',
  'indianbank',
  'uco',
  'unionbankofindia',
  'unionbank',
  'cnrb',
  'cbin',
  'fbl',
  'federal',
  'rbl',
  'dbs',
  'jupiteraxis',
  'jio',
  'airtel',
  'freecharge',
  'slice',
  'fam',
  'naviaxis',
  'timecosmos',
  'abfspay',
]);

/**
 * PSP suffixes issued only to merchants. A handle carrying one of these is a
 * business by construction, whatever the name in front of it looks like.
 */
const MERCHANT_PSP_SUFFIXES = new Set([
  'okbizaxis',
  'ptybizaxis',
  'ptbiz',
  'mairtel',
  'rapidmerchant',
  'razorpay',
  'payu',
  'cashfree',
  'pinelabs',
  'ezeepay',
]);

/**
 * A VPA, taken apart.
 *
 * `display` is what to show a person; `psp`, `knownPsp` and `merchantPsp` are
 * what the counterparty classifier reads.
 */
export interface ParsedVpa {
  /** The whole address, lowercased and trimmed. */
  vpa: string;
  /** Everything before the `@`, lowercased. */
  handle: string;
  /** Everything after the `@`, lowercased. */
  psp: string;
  /** True when `psp` is a bank or consumer app this module recognises. */
  knownPsp: boolean;
  /** True when `psp` is only ever issued to merchants. */
  merchantPsp: boolean;
  /** True when the handle is nothing but an Indian mobile number. */
  phoneHandle: boolean;
  /**
   * The handle with its separators opened out and title-cased, when doing so
   * produces something a person would read as a name; otherwise the handle
   * unchanged. Never carries the `@psp` suffix.
   */
  display: string;
}

/**
 * An Indian mobile number, optionally with the 91 country code that the apps
 * prepend. No leading `+`: a VPA handle cannot contain one, so accepting it
 * here would describe a string `parseVpa` has already rejected.
 */
const PHONE_HANDLE = /^(?:91)?[6-9]\d{9}$/;

/** A handle that is a name rather than an identifier: letters and separators. */
const NAME_HANDLE = /^[a-z]+(?:[._-][a-z]+)*$/;

/**
 * Splits a VPA into its handle and PSP suffix.
 *
 * Returns null for anything that is not one — an empty string, a bare name with
 * no `@`, or an email address. Email is rejected on the same rule the Phase 13
 * statement reader uses: a PSP suffix never contains a dot, so `care@phonepe`
 * is an address and `care@phonepe.com` is a mailbox.
 */
export function parseVpa(raw: string | null | undefined): ParsedVpa | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;

  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return null;

  const handle = value.slice(0, at);
  const psp = value.slice(at + 1);

  // One `@` only, and no dotted domain: both mark an email rather than a VPA.
  if (psp.includes('@') || psp.includes('.')) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(handle)) return null;
  if (!/^[a-z][a-z0-9-]*$/.test(psp)) return null;

  const phoneHandle = PHONE_HANDLE.test(handle);

  return {
    vpa: `${handle}@${psp}`,
    handle,
    psp,
    knownPsp: CONSUMER_PSP_SUFFIXES.has(psp) || MERCHANT_PSP_SUFFIXES.has(psp),
    merchantPsp: MERCHANT_PSP_SUFFIXES.has(psp),
    phoneHandle,
    display: displayFromHandle(handle, phoneHandle),
  };
}

/**
 * The clean display name for a VPA: the handle with its bank suffix gone.
 *
 * `normalizeVpa('RAMESH.KUMAR@okaxis')` is `'Ramesh Kumar'`. Anything that is
 * not a VPA comes back trimmed and otherwise untouched, so a caller can pass a
 * counterparty string of unknown shape and always get something printable.
 */
export function normalizeVpa(raw: string | null | undefined): string {
  const parsed = parseVpa(raw);
  if (parsed) return parsed.display;
  return raw?.trim() ?? '';
}

/**
 * Title-cases a handle when it reads like a name.
 *
 * A handle that is a phone number, or that carries digits or a single opaque
 * run of letters and numbers, is returned verbatim: `q629384756` is a Paytm
 * merchant id and "Q629384756" is not an improvement on it.
 */
function displayFromHandle(handle: string, phoneHandle: boolean): string {
  if (phoneHandle) return handle;
  if (!NAME_HANDLE.test(handle)) return handle;

  return handle
    .split(/[._-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
