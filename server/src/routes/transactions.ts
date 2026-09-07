import { Router } from 'express';

import { commitTransactions, uploadTransactions } from '../controllers/transactions';
import { asyncHandler } from '../middleware/errorHandler';
import { csvUpload } from '../middleware/upload';

export const transactionsRouter = Router();

/** Parse, normalize and flag duplicates. Writes nothing. */
transactionsRouter.post(
  '/transactions/upload',
  csvUpload.single('file'),
  asyncHandler(uploadTransactions),
);

/** Insert the rows the user confirmed. */
transactionsRouter.post('/transactions/commit', asyncHandler(commitTransactions));
