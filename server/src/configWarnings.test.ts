import { describe, expect, it } from 'vitest';

import { configurationWarnings } from './configWarnings';

const complete = {
  NODE_ENV: 'production',
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'FinTrack <hello@example.com>',
  CORS_ORIGIN: 'https://fintrack.example.com',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  DEMO_MODE: 'off',
};

describe('configurationWarnings', () => {
  it('says nothing about a complete production configuration', () => {
    expect(configurationWarnings(complete)).toEqual([]);
  });

  it('warns that password reset is unavailable without a mail provider', () => {
    const warnings = configurationWarnings({ ...complete, RESEND_API_KEY: undefined });
    expect(warnings).toEqual([expect.stringMatching(/password reset is unavailable/)]);
  });

  it('warns when the deployed client would be refused by CORS', () => {
    const warnings = configurationWarnings({ ...complete, CORS_ORIGIN: undefined });
    expect(warnings).toEqual([expect.stringMatching(/CORS_ORIGIN is not set/)]);
  });

  it('warns that the AI features are off without a key, unless they were switched off', () => {
    expect(configurationWarnings({ ...complete, ANTHROPIC_API_KEY: undefined })).toEqual([
      expect.stringMatching(/ANTHROPIC_API_KEY is not set/),
    ]);
    expect(
      configurationWarnings({
        ...complete,
        ANTHROPIC_API_KEY: undefined,
        AI_CATEGORIZATION: 'off',
        AI_STATEMENT_READER: 'off',
      }),
    ).toEqual([]);
  });

  it('warns that demo mode hands out sessions', () => {
    expect(configurationWarnings({ ...complete, DEMO_MODE: 'on' })).toEqual([
      expect.stringMatching(/DEMO_MODE is on/),
    ]);
  });

  it('keeps quiet about email, CORS and demo mode in local development', () => {
    expect(
      configurationWarnings({ NODE_ENV: 'development', ANTHROPIC_API_KEY: 'sk-ant-x' }),
    ).toEqual([]);
  });
});
