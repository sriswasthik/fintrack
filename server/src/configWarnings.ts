/**
 * What the server should say about its own configuration when it starts.
 *
 * Every optional integration here degrades quietly by design — no mail
 * provider, no model key — so that a missing one never breaks a request. The
 * cost of quiet is that a deployment can run for weeks without the operator
 * learning that password resets go nowhere. One line each at startup is the
 * whole remedy.
 *
 * A pure function of the environment, so it can be tested without starting
 * anything.
 */
export function configurationWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const production = env.NODE_ENV === 'production';
  const warnings: string[] = [];

  // Not optional anywhere: without them no token can be signed, so every
  // sign-up, sign-in and session refresh answers 500.
  const missingSecrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'].filter(
    (name) => !env[name]?.trim(),
  );
  if (missingSecrets.length > 0) {
    warnings.push(
      `${missingSecrets.join(' and ')} ${missingSecrets.length === 1 ? 'is' : 'are'} not set: nobody can sign up or sign in. Set each to a long random value, e.g. \`openssl rand -base64 32\`.`,
    );
  }

  if (production && !(env.RESEND_API_KEY && env.EMAIL_FROM)) {
    warnings.push(
      'RESEND_API_KEY and EMAIL_FROM are not set: password reset is unavailable and no welcome email is sent.',
    );
  }

  if (production && !env.CORS_ORIGIN) {
    warnings.push(
      'CORS_ORIGIN is not set: only http://localhost:5173 is allowed, so the deployed client cannot reach this API.',
    );
  }

  const aiWanted = env.AI_CATEGORIZATION !== 'off' || env.AI_STATEMENT_READER !== 'off';
  if (aiWanted && !env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    warnings.push(
      'ANTHROPIC_API_KEY is not set: unless another Anthropic credential is configured, AI categorization, the AI statement reader and written monthly summaries are unavailable.',
    );
  }

  if (production && env.DEMO_MODE === 'on') {
    warnings.push(
      'DEMO_MODE is on: anyone can get a read-only session on the demo account. Run it only on an instance that holds no real statements.',
    );
  }

  return warnings;
}
