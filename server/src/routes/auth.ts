import { Router } from 'express';

import { login, logout, me, refresh, register } from '../controllers/auth';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { authLimiter } from '../middleware/rateLimit';

export const authRouter = Router();

authRouter.post('/auth/register', authLimiter, asyncHandler(register));
authRouter.post('/auth/login', authLimiter, asyncHandler(login));
authRouter.post('/auth/refresh', authLimiter, asyncHandler(refresh));
authRouter.post('/auth/logout', asyncHandler(logout));
authRouter.get('/auth/me', requireAuth, asyncHandler(me));
