import { Router } from 'express';

import {
  demoSession,
  googleSignIn,
  login,
  logout,
  me,
  refresh,
  register,
  forgotPassword,
  resetPassword,
} from '../controllers/auth';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { authLimiter, passwordResetLimiter, refreshLimiter } from '../middleware/rateLimit';

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
// Every request counts here, not just failures: a request always "succeeds",
// and each one can send an email.
authRouter.post('/auth/forgot-password', passwordResetLimiter, asyncHandler(forgotPassword));
// A wrong or spent token is a failure and counts against the same budget as a
// wrong password.
authRouter.post('/auth/reset-password', authLimiter, asyncHandler(resetPassword));
authRouter.get('/auth/me', requireAuth, asyncHandler(me));
