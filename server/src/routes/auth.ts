import { Router } from 'express';

import {
  demoSession,
  googleSignIn,
  login,
  logout,
  me,
  refresh,
  register,
} from '../controllers/auth';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { authLimiter, refreshLimiter } from '../middleware/rateLimit';

export const authRouter = Router();

authRouter.post('/auth/register', authLimiter, asyncHandler(register));
authRouter.post('/auth/login', authLimiter, asyncHandler(login));
// Behind the same limiter as the password routes: verifying a Google token is
// cheap for us but the endpoint still creates accounts, and an unthrottled
// account-creation route is an invitation.
authRouter.post('/auth/google', authLimiter, asyncHandler(googleSignIn));
authRouter.post('/auth/refresh', refreshLimiter, asyncHandler(refresh));
authRouter.post('/auth/demo', authLimiter, asyncHandler(demoSession));
authRouter.post('/auth/logout', asyncHandler(logout));
authRouter.get('/auth/me', requireAuth, asyncHandler(me));
