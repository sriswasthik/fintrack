/**
 * Google Sign-In (Phase 16).
 *
 * The client runs Google's flow and comes back holding an **ID token** — a JWT
 * Google signed. This module does two jobs with it: prove it is genuine, and
 * work out which FinTrack account it belongs to.
 *
 * Nothing the browser sends is trusted. The email, the name and the picture are
 * read out of the *verified* token payload rather than out of the request body,
 * because a request body is written by whoever is making the request and a
 * signed token is not.
 *
 * `verifyIdToken` checks the signature against Google's published keys, that
 * the issuer is Google, that the token has not expired, and — because the
 * audience is passed — that it was minted for *this* application. That last one
 * matters more than it looks: without it, an ID token issued to any other
 * Google app whose user happens to share an email address would be accepted
 * here, which is an account takeover with extra steps.
 */
import { OAuth2Client, type TokenPayload } from 'google-auth-library';

import type { PrismaClient } from '../../generated/prisma/client';
import { AuthConfigurationError } from './tokens';

/** The client ID the token must have been issued for. */
export function googleClientId(): string {
  const value = process.env.GOOGLE_CLIENT_ID;
  if (!value) {
    throw new AuthConfigurationError(
      'GOOGLE_CLIENT_ID is not set — add it to server/.env from the Google Cloud console (APIs & Services → Credentials → OAuth 2.0 Client IDs)',
    );
  }
  return value;
}

/** True when this deployment offers Google Sign-In at all. */
export function googleSignInEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}

/** Raised when the browser presented something that is not a usable Google token. */
export class InvalidGoogleTokenError extends Error {
  constructor(message = 'That Google sign-in could not be verified') {
    super(message);
    this.name = 'InvalidGoogleTokenError';
  }
}

/** What a verified Google ID token tells us. Every field comes from the token. */
export interface GoogleIdentity {
  /** Google's `sub`: stable for the life of the Google account. */
  googleId: string;
  email: string;
  name: string | null;
  picture: string | null;
}

/** One client, reused: it caches Google's signing keys between requests. */
let client: OAuth2Client | null = null;
function oauthClient(): OAuth2Client {
  client ??= new OAuth2Client();
  return client;
}

/** Test seam — lets the route suite drive a stub instead of reaching Google. */
export function setGoogleOAuthClient(replacement: OAuth2Client | null): void {
  client = replacement;
}

/**
 * Verifies a Google ID token and returns the identity inside it.
 *
 * Throws `InvalidGoogleTokenError` for anything that does not verify, and lets
 * `AuthConfigurationError` through untouched — a deployment with no client ID
 * configured is broken, not a visitor sending something wrong, and the two must
 * not produce the same answer.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audience = googleClientId();

  let payload: TokenPayload | undefined;
  try {
    const ticket = await oauthClient().verifyIdToken({ idToken, audience });
    payload = ticket.getPayload();
  } catch {
    // Bad signature, expired, wrong audience, malformed. The caller gets one
    // answer for all of them: which specific check failed is of use to an
    // attacker probing the endpoint and of none to an honest client.
    throw new InvalidGoogleTokenError();
  }

  if (!payload?.sub) throw new InvalidGoogleTokenError();
  if (!payload.email) throw new InvalidGoogleTokenError('That Google account has no email address');

  // The load-bearing check. Account linking below matches an existing FinTrack
  // account by email, so an unverified Google email would let anyone who can
  // create a Google account claiming someone else's address walk into that
  // person's account. Google sets this to false when it has not confirmed the
  // address; we refuse rather than link on it.
  if (payload.email_verified !== true) {
    throw new InvalidGoogleTokenError(
      'That Google account’s email address is not verified with Google',
    );
  }

  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: payload.name?.trim() || null,
    picture: payload.picture?.trim() || null,
  };
}

/** How an identity was matched to an account. */
export type GoogleResolution =
  /** A `googleId` we had already seen: an ordinary repeat sign-in. */
  | 'signed-in'
  /** An account that existed with this email and now has Google attached. */
  | 'linked'
  /** No account existed; one was created. */
  | 'created';

export interface ResolvedGoogleUser {
  user: { id: string; email: string; name: string | null; picture: string | null };
  resolution: GoogleResolution;
  /**
   * True only when this request is what brought the `User` row into existence.
   *
   * Phase 17 reads this to decide whether to send a welcome email. It is
   * deliberately *not* the same as "first Google sign-in": somebody who
   * registered with a password last year and links Google today is not new, and
   * welcoming them would be worse than saying nothing.
   */
  isNewUser: boolean;
}

const USER_FIELDS = { id: true, email: true, name: true, picture: true } as const;

/**
 * Finds or creates the account behind a verified Google identity.
 *
 * Three paths, tried in this order, and the order is the point:
 *
 *   1. **By `googleId`.** The strongest key there is. A Google account's `sub`
 *      never changes, while its email address can — so matching on the id first
 *      means someone who changes their Gmail address keeps their FinTrack data.
 *   2. **By verified email.** Somebody who signed up with a password and later
 *      clicks "Sign in with Google" means to reach the account they already
 *      have, not to start an empty second one. Google is attached to the
 *      existing row. Safe only because the email was verified above.
 *   3. **Create.** No account either way, so this is a new person.
 *
 * The name and picture from Google fill in blanks but never overwrite: a name
 * already on the account was set here, and Google's copy is not more correct
 * than the user's own.
 */
export async function resolveGoogleUser(
  prisma: PrismaClient,
  identity: GoogleIdentity,
): Promise<ResolvedGoogleUser> {
  const byGoogleId = await prisma.user.findUnique({
    where: { googleId: identity.googleId },
    select: USER_FIELDS,
  });

  if (byGoogleId) {
    const filled = await fillBlanks(prisma, byGoogleId, identity);
    return { user: filled, resolution: 'signed-in', isNewUser: false };
  }

  const byEmail = await prisma.user.findUnique({
    where: { email: identity.email },
    select: USER_FIELDS,
  });

  if (byEmail) {
    const linked = await prisma.user.update({
      where: { id: byEmail.id },
      data: {
        googleId: identity.googleId,
        name: byEmail.name ?? identity.name,
        picture: byEmail.picture ?? identity.picture,
      },
      select: USER_FIELDS,
    });
    return { user: linked, resolution: 'linked', isNewUser: false };
  }

  // No password hash at all: this account has only ever been reachable through
  // Google, and `login` refuses an account with nothing to compare against.
  const created = await prisma.user.create({
    data: {
      email: identity.email,
      googleId: identity.googleId,
      name: identity.name,
      picture: identity.picture,
      passwordHash: null,
    },
    select: USER_FIELDS,
  });

  return { user: created, resolution: 'created', isNewUser: true };
}

/** Fills in a name or picture the account does not have yet. Never overwrites. */
async function fillBlanks(
  prisma: PrismaClient,
  user: { id: string; email: string; name: string | null; picture: string | null },
  identity: GoogleIdentity,
): Promise<{ id: string; email: string; name: string | null; picture: string | null }> {
  const name = user.name ?? identity.name;
  const picture = user.picture ?? identity.picture;
  if (name === user.name && picture === user.picture) return user;

  return prisma.user.update({
    where: { id: user.id },
    data: { name, picture },
    select: USER_FIELDS,
  });
}
