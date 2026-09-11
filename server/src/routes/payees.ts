import { Router } from 'express';

import { getPayeeHandler, listPayeesHandler } from '../controllers/payees';
import { asyncHandler } from '../middleware/errorHandler';

export const payeesRouter = Router();

payeesRouter.get('/payees', asyncHandler(listPayeesHandler));
payeesRouter.get('/payees/:id', asyncHandler(getPayeeHandler));
