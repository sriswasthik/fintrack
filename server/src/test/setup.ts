/**
 * Test environment.
 *
 * Signing secrets are set here rather than read from a developer's .env, so the
 * suite produces the same tokens on every machine and in CI, and so a checkout
 * with no .env still runs. They are obviously not secret — nothing signed with
 * them ever leaves the test process.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-not-used-anywhere-real';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-not-used-anywhere-real';
