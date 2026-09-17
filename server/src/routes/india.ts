import { Router } from 'express';

import { getIndiaInsights } from '../controllers/india';
import { asyncHandler } from '../middleware/errorHandler';

export const indiaRouter = Router();

indiaRouter.get('/india', asyncHandler(getIndiaInsights));
