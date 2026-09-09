import { Router } from 'express';

import { getSummary, postRegenerateSummary } from '../controllers/summary';
import { asyncHandler } from '../middleware/errorHandler';
import { summaryLimiter } from '../middleware/rateLimit';

export const summaryRouter = Router();

summaryRouter.get('/summary', summaryLimiter, asyncHandler(getSummary));
summaryRouter.post('/summary/regenerate', summaryLimiter, asyncHandler(postRegenerateSummary));
