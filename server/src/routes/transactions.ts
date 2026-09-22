import { Router } from 'express';

import {
  categorizeTransactions,
  clearSplit,
  commitTransactions,
  exportTransactions,
  getReviewQueue,
  getTransaction,
  listTransactions,
  overrideCategory,
  splitTransaction,
  uploadTransactions,
} from '../controllers/transactions';
import { asyncHandler } from '../middleware/errorHandler';
import { categorizeLimiter, uploadLimiter } from '../middleware/rateLimit';
import { csvUpload } from '../middleware/upload';

export const transactionsRouter = Router();

/** Parse, normalize and flag duplicates. Writes nothing. */
transactionsRouter.post(
  '/transactions/upload',
  uploadLimiter,
  csvUpload.single('file'),
  asyncHandler(uploadTransactions),
);

/** Insert the rows the user confirmed, then run the deterministic engine. */
transactionsRouter.post('/transactions/commit', asyncHandler(commitTransactions));

/** Re-run the deterministic engine over everything already stored. */
transactionsRouter.post(
  '/transactions/categorize',
  categorizeLimiter,
  asyncHandler(categorizeTransactions),
);

/** Everything a human still needs to look at. */
transactionsRouter.get('/review-queue', asyncHandler(getReviewQueue));

transactionsRouter.get('/transactions', asyncHandler(listTransactions));
/** As a CSV download. Registered before `/:id`, which would otherwise claim "export". */
transactionsRouter.get('/transactions/export', asyncHandler(exportTransactions));
transactionsRouter.get('/transactions/:id', asyncHandler(getTransaction));

/** Divide one charge across categories (§8 case 3). */
transactionsRouter.post('/transactions/:id/split', asyncHandler(splitTransaction));
transactionsRouter.delete('/transactions/:id/split', asyncHandler(clearSplit));

/** A human's category correction, which also teaches a rule. */
transactionsRouter.post(
  '/transactions/:id/category',
  categorizeLimiter,
  asyncHandler(overrideCategory),
);
