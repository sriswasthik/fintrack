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

// Imports run the AI categorizer, and an unfamiliar PDF goes to the AI
// statement reader. A developer's .env may hold a real key, and a test run must
// never spend it, so both are off unless a test turns them on.
process.env.AI_CATEGORIZATION = 'off';
process.env.AI_STATEMENT_READER = 'off';
