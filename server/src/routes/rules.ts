import { Router } from 'express';

import { deleteRule, listRules, updateRule } from '../controllers/rules';
import { asyncHandler } from '../middleware/errorHandler';
import { categorizeLimiter } from '../middleware/rateLimit';

export const rulesRouter = Router();

rulesRouter.get('/rules', asyncHandler(listRules));
// A change re-runs the whole deterministic pass, like a categorization run.
rulesRouter.patch('/rules/:id', categorizeLimiter, asyncHandler(updateRule));
rulesRouter.delete('/rules/:id', categorizeLimiter, asyncHandler(deleteRule));
