import { Router } from 'express';

import {
  categorizeTransactions,
  clearSplit,
  commitTransactions,
  getTransaction,
  listTransactions,
  splitTransaction,
  uploadTransactions,
} from '../controllers/transactions';
import { asyncHandler } from '../middleware/errorHandler';
import { csvUpload } from '../middleware/upload';

export const transactionsRouter = Router();

/** Parse, normalize and flag duplicates. Writes nothing. */
transactionsRouter.post(
  '/transactions/upload',
  csvUpload.single('file'),
  asyncHandler(uploadTransactions),
);

/** Insert the rows the user confirmed, then run the deterministic engine. */
transactionsRouter.post('/transactions/commit', asyncHandler(commitTransactions));

/** Re-run the deterministic engine over everything already stored. */
transactionsRouter.post('/transactions/categorize', asyncHandler(categorizeTransactions));

transactionsRouter.get('/transactions', asyncHandler(listTransactions));
transactionsRouter.get('/transactions/:id', asyncHandler(getTransaction));

/** Divide one charge across categories (§8 case 3). */
transactionsRouter.post('/transactions/:id/split', asyncHandler(splitTransaction));
transactionsRouter.delete('/transactions/:id/split', asyncHandler(clearSplit));
