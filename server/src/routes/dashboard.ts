import { Router } from 'express';

import { getDashboard } from '../controllers/dashboard';
import { asyncHandler } from '../middleware/errorHandler';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', asyncHandler(getDashboard));
