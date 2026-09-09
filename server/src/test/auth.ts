/**
 * Signing in, for route tests.
 *
 * Every data route is behind `requireAuth`, so a Supertest request without a
 * bearer token now proves only that the middleware works. These helpers put a
 * real, correctly signed token on the request so the handler underneath is what
 * is actually being tested.
 */
import { signAccessToken } from '../services/auth/tokens';

/** The user the mocked Prisma layer answers for. */
export const TEST_USER_ID = 'user_1';

/** A second user, for asserting that one cannot reach the other's data. */
export const OTHER_USER_ID = 'user_2';

export function authHeader(userId: string = TEST_USER_ID): { Authorization: string } {
  return { Authorization: `Bearer ${signAccessToken(userId)}` };
}
