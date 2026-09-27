import { Router } from 'express';

import { deleteBudget, getBudgets, putBudget } from '../controllers/budgets';
import { asyncHandler } from '../middleware/errorHandler';

export const budgetsRouter = Router();

budgetsRouter.get('/budgets', asyncHandler(getBudgets));
budgetsRouter.put('/budgets/:category', asyncHandler(putBudget));
budgetsRouter.delete('/budgets/:category', asyncHandler(deleteBudget));
