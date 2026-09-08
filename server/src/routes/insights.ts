import { Router } from 'express';

import { deleteInsight, getInsights } from '../controllers/insights';
import { asyncHandler } from '../middleware/errorHandler';

export const insightsRouter = Router();

insightsRouter.get('/insights', asyncHandler(getInsights));
insightsRouter.delete('/insights/:id', asyncHandler(deleteInsight));
