import { Router } from 'express';

import { getSummary, postRegenerateSummary } from '../controllers/summary';
import { asyncHandler } from '../middleware/errorHandler';

export const summaryRouter = Router();

summaryRouter.get('/summary', asyncHandler(getSummary));
summaryRouter.post('/summary/regenerate', asyncHandler(postRegenerateSummary));
