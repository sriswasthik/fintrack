import { Router } from 'express';

import { listAccounts } from '../controllers/accounts';
import { asyncHandler } from '../middleware/errorHandler';

export const accountsRouter = Router();

accountsRouter.get('/accounts', asyncHandler(listAccounts));
