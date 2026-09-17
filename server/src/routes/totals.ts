import { Router } from 'express';

import { getTotals } from '../controllers/totals';
import { asyncHandler } from '../middleware/errorHandler';

export const totalsRouter = Router();

totalsRouter.get('/totals', asyncHandler(getTotals));
