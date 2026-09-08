/**
 * The deterministic categorization engine.
 *
 * This is the first pass over every transaction and runs before any LLM call
 * (PROJECT_CONTEXT.md §4). Everything here is pure — the caller supplies the
 * rules and the transactions, and gets back the changes to write — so the whole
 * engine is testable without a database.
 *
 * Order matters, and it is:
 *
 *   1. rules      — a user's own learned rules first, then the built-ins
 *   2. transfers  — cross-account pairs, which override whatever a rule decided
 *   3. refunds    — negative amounts matched back to an earlier purchase
 *
 * Transfers and refunds run after rules because they are decided by the shape of
 * the data rather than by the merchant string, and a merchant rule should not be
 * able to mask a card payment or a return.
 *
 * Nothing here guesses. A transaction no rule matches stays UNCATEGORIZED with
 * zero confidence, which is what Phase 4's LLM fallback picks up.
 */
import type { Category, TransactionSource } from '../../generated/prisma/enums';

/** A rule as stored, whether built-in (null user) or learned from an override. */
export interface EngineRule {
  id: string;
  /** Case-insensitive regular expression, matched against the normalized merchant. */
  pattern: string;
  category: Category;
  /** Lower numbers win. */
  priority: number;
  /** Null for a built-in rule; set for one learned from a user's correction. */
  userId: string | null;
  learnedFromOverride: boolean;
}

/** The fields the engine reads. */
export interface EngineTransaction {
  id: string;
  accountId: string;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  normalizedMerchant: string;
  /** Debit-positive: purchases positive, refunds and income negative. */
  amount: number;
  category: Category;
  confidence: number;
  source: TransactionSource;
}

/** One transaction's outcome. */
export interface CategorizationResult {
  transactionId: string;
  category: Category;
  confidence: number;
  source: TransactionSource;
  /** Which rule fired, when one did. */
  ruleId?: string;
  /** Why the engine decided this, for the review UI and for debugging. */
  reason: string;
  /** Set on the outgoing leg of a transfer pair. */
  transferPairId?: string;
  /** Set on an original purchase, pointing at the refund that offsets it. */
  linkedRefundId?: string;
}

/** Cross-account transfers must land within this many days of each other. */
export const TRANSFER_DAY_WINDOW = 2;
/** How long after a purchase a refund can still be matched to it. */
export const REFUND_DAY_WINDOW = 90;

function cents(amount: number): number {
  return Math.round(amount * 100);
}

function daysApart(a: string, b: string): number {
  return Math.abs(
    Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000),
  );
}

/**
 * Orders rules the way the engine applies them: a user's own learned rules
 * before the built-ins, then by ascending priority, then by id so the result is
 * stable when two rules tie.
 */
export function orderRules(rules: EngineRule[]): EngineRule[] {
  return [...rules].sort((a, b) => {
    // A correction the user made by hand always beats a built-in (§8 case 12).
    const aLearned = a.userId !== null ? 0 : 1;
    const bLearned = b.userId !== null ? 0 : 1;
    if (aLearned !== bLearned) return aLearned - bLearned;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Compiles a rule's pattern, treating an invalid one as never matching. */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * Returns the first rule that matches, in engine order. Exported so the review
 * UI can explain a categorization.
 */
export function matchRule(merchant: string, orderedRules: EngineRule[]): EngineRule | null {
  for (const rule of orderedRules) {
    const expression = compile(rule.pattern);
    if (expression?.test(merchant)) return rule;
  }
  return null;
}

/**
 * Applies the rule set to one transaction.
 *
 * A transaction whose source is MANUAL is returned untouched: a human already
 * decided, and PROJECT_CONTEXT.md §7 says that decision is never overwritten.
 */
export function categorizeTransaction(
  transaction: EngineTransaction,
  orderedRules: EngineRule[],
): CategorizationResult {
  if (transaction.source === 'MANUAL') {
    return {
      transactionId: transaction.id,
      category: transaction.category,
      confidence: 1,
      source: 'MANUAL',
      reason: 'Manually categorized — left untouched',
    };
  }

  const rule = matchRule(transaction.normalizedMerchant, orderedRules);
  if (!rule) {
    // An answer the LLM fallback already supplied is kept. Re-running the
    // deterministic pass — which happens after every import — must not undo
    // Phase 4's work and send the whole review queue back to square one.
    if (transaction.source === 'LLM' && transaction.category !== 'UNCATEGORIZED') {
      return {
        transactionId: transaction.id,
        category: transaction.category,
        confidence: transaction.confidence,
        source: 'LLM',
        reason: 'No rule matched; keeping the existing AI categorization',
      };
    }
    return {
      transactionId: transaction.id,
      category: 'UNCATEGORIZED',
      confidence: 0,
      source: 'RULE',
      reason: 'No rule matched',
    };
  }

  return {
    transactionId: transaction.id,
    category: rule.category,
    // A deterministic rule match is certain by construction.
    confidence: 1,
    source: 'RULE',
    ruleId: rule.id,
    reason: rule.learnedFromOverride
      ? `Learned rule /${rule.pattern}/`
      : `Built-in rule /${rule.pattern}/`,
  };
}

export interface TransferPair {
  /** The leg where money left an account (positive amount). */
  outgoingId: string;
  /** The leg where it arrived (negative amount). */
  incomingId: string;
}

/**
 * Finds transfers between two of the user's own accounts (§8 case 1).
 *
 * A pair is two transactions on *different* accounts, with equal and opposite
 * amounts, dated within `TRANSFER_DAY_WINDOW` days of each other. Each
 * transaction is used at most once, and the closest candidate by date wins, so
 * a month of identical card payments pairs up one-to-one rather than all
 * matching the first one it sees.
 */
export function findTransferPairs(transactions: EngineTransaction[]): TransferPair[] {
  const outgoing = transactions.filter((t) => t.amount > 0).sort(byDateThenId);
  const incoming = transactions.filter((t) => t.amount < 0).sort(byDateThenId);

  const takenIncoming = new Set<string>();
  const pairs: TransferPair[] = [];

  for (const out of outgoing) {
    let best: EngineTransaction | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const inn of incoming) {
      if (takenIncoming.has(inn.id)) continue;
      if (inn.accountId === out.accountId) continue;
      if (cents(inn.amount) !== -cents(out.amount)) continue;

      const distance = daysApart(out.date, inn.date);
      if (distance > TRANSFER_DAY_WINDOW) continue;
      if (distance < bestDistance) {
        best = inn;
        bestDistance = distance;
      }
    }

    if (best) {
      takenIncoming.add(best.id);
      pairs.push({ outgoingId: out.id, incomingId: best.id });
    }
  }

  return pairs;
}

export interface RefundLink {
  /** The original positive purchase. */
  purchaseId: string;
  /** The negative transaction that offsets it. */
  refundId: string;
}

/**
 * Matches refunds back to the purchase they offset (§8 case 2).
 *
 * A refund is a negative amount from the same normalized merchant, on the same
 * account, after an earlier purchase of the same magnitude and within
 * `REFUND_DAY_WINDOW` days. Same-account is deliberate: a return goes back to
 * the card it was bought with, and requiring it keeps the two legs of a
 * cross-account transfer from looking like a purchase and its refund.
 *
 * Transactions already settled as transfers are skipped entirely, which is what
 * stops a person-to-person round trip (money sent, then paid back by the same
 * network days later) from being read as a return.
 */
export function findRefundLinks(
  transactions: EngineTransaction[],
  isTransfer: (id: string) => boolean,
): RefundLink[] {
  const eligible = transactions.filter((t) => !isTransfer(t.id));
  const purchases = eligible.filter((t) => t.amount > 0).sort(byDateThenId);
  const refunds = eligible.filter((t) => t.amount < 0).sort(byDateThenId);

  const takenPurchases = new Set<string>();
  const links: RefundLink[] = [];

  for (const refund of refunds) {
    let best: EngineTransaction | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const purchase of purchases) {
      if (takenPurchases.has(purchase.id)) continue;
      if (purchase.accountId !== refund.accountId) continue;
      if (purchase.normalizedMerchant !== refund.normalizedMerchant) continue;
      if (cents(purchase.amount) !== -cents(refund.amount)) continue;
      // The purchase must come first; a credit before the charge is not a return.
      if (purchase.date > refund.date) continue;

      const distance = daysApart(refund.date, purchase.date);
      if (distance > REFUND_DAY_WINDOW) continue;
      if (distance < bestDistance) {
        best = purchase;
        bestDistance = distance;
      }
    }

    if (best) {
      takenPurchases.add(best.id);
      links.push({ purchaseId: best.id, refundId: refund.id });
    }
  }

  return links;
}

function byDateThenId(a: EngineTransaction, b: EngineTransaction): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface EngineOutcome {
  results: CategorizationResult[];
  transferPairs: TransferPair[];
  refundLinks: RefundLink[];
}

/**
 * Runs the whole deterministic pass and returns what should be written.
 *
 * `transactions` must be the user's full set for the period being categorized —
 * transfer and refund matching both need to see the other side of a pair, which
 * may be on a different account or weeks earlier.
 */
export function runEngine(transactions: EngineTransaction[], rules: EngineRule[]): EngineOutcome {
  const ordered = orderRules(rules);
  const byId = new Map(transactions.map((t) => [t.id, t]));

  const results = new Map<string, CategorizationResult>(
    transactions.map((t) => [t.id, categorizeTransaction(t, ordered)]),
  );

  // Manual corrections are excluded from pairing as well as from rule matching:
  // a human's decision stands, whatever the shape of the data suggests.
  const automatic = transactions.filter((t) => t.source !== 'MANUAL');

  const transferPairs = findTransferPairs(automatic);
  const transferIds = new Set(transferPairs.flatMap((p) => [p.outgoingId, p.incomingId]));

  transferPairs.forEach((pair) => {
    const outgoing = results.get(pair.outgoingId)!;
    results.set(pair.outgoingId, {
      ...outgoing,
      category: 'TRANSFER',
      confidence: 1,
      source: 'RULE',
      reason: 'Paired with the matching leg on another account',
      transferPairId: pair.incomingId,
    });
    const incoming = results.get(pair.incomingId)!;
    results.set(pair.incomingId, {
      ...incoming,
      category: 'TRANSFER',
      confidence: 1,
      source: 'RULE',
      reason: 'Paired with the matching leg on another account',
    });
  });

  // A transfer is never a refund. The skip set has to include everything a rule
  // settled as TRANSFER, not just the cross-account pairs: a person-to-person
  // round trip (money sent, then paid back by the same network days later) sits
  // on one account and looks exactly like a purchase and its return (§8 case 9).
  const settledAsTransfer = new Set(
    [...results.values()].filter((r) => r.category === 'TRANSFER').map((r) => r.transactionId),
  );
  const skipForRefunds = (id: string) => transferIds.has(id) || settledAsTransfer.has(id);

  const refundLinks = findRefundLinks(automatic, skipForRefunds);

  refundLinks.forEach((link) => {
    const refund = results.get(link.refundId)!;
    results.set(link.refundId, {
      ...refund,
      category: 'REFUND',
      confidence: 1,
      source: 'RULE',
      reason: `Refund of ${byId.get(link.purchaseId)?.normalizedMerchant ?? 'an earlier purchase'}`,
    });
    // The link itself is stored on the purchase, per the Phase 1 schema.
    const purchase = results.get(link.purchaseId)!;
    results.set(link.purchaseId, { ...purchase, linkedRefundId: link.refundId });
  });

  return {
    results: transactions.map((t) => results.get(t.id)!),
    transferPairs,
    refundLinks,
  };
}
