import { Router } from 'express';

import { changePassword, deleteMe } from '../controllers/me';
import { asyncHandler } from '../middleware/errorHandler';
import { authLimiter } from '../middleware/rateLimit';

export const meRouter = Router();

// Both check a password, so both sit behind the limiter that counts wrong ones.
meRouter.post('/me/password', authLimiter, asyncHandler(changePassword));
meRouter.delete('/me', authLimiter, asyncHandler(deleteMe));
