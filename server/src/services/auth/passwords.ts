/**
 * Password hashing.
 *
 * bcrypt with a work factor of 12: high enough that an offline attack on a
 * leaked hash is expensive, low enough that a sign-in stays under a tenth of a
 * second on ordinary hardware. The factor is stored inside the hash, so raising
 * it later re-hashes new passwords without invalidating old ones.
 */
import bcrypt from 'bcrypt';

export const BCRYPT_ROUNDS = 12;

/** The shortest password worth accepting. Length beats character classes. */
export const MIN_PASSWORD_LENGTH = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A constant-time-ish stand-in used when no user matched.
 *
 * Without it, a login for an unknown address returns before bcrypt has run and
 * one for a known address returns after — a timing difference that tells an
 * attacker which email addresses have accounts.
 */
export async function burnPasswordTime(password: string): Promise<void> {
  await bcrypt.compare(password, '$2b$12$' + 'x'.repeat(53));
}
