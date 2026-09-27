import { Router } from 'express';

import { createAccount, deleteAccount, listAccounts, updateAccount } from '../controllers/accounts';
import { asyncHandler } from '../middleware/errorHandler';

export const accountsRouter = Router();

accountsRouter.get('/accounts', asyncHandler(listAccounts));
accountsRouter.post('/accounts', asyncHandler(createAccount));
accountsRouter.patch('/accounts/:id', asyncHandler(updateAccount));
accountsRouter.delete('/accounts/:id', asyncHandler(deleteAccount));
