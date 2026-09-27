import { describe, expect, it } from 'vitest';

import { errorMessage } from './errors';

const failed = (data: unknown) => ({ response: { data } });

describe('errorMessage', () => {
  it("prefers the server's own sentence", () => {
    expect(errorMessage(failed({ error: 'The uploaded file is empty' }))).toBe(
      'The uploaded file is empty',
    );
  });

  it('adds a short reference to an unexpected server error', () => {
    expect(
      errorMessage(
        failed({
          error: 'Internal server error',
          requestId: '3f9c2a1b-7d4e-4c1a-9b2f-0e8d6c5a4b3c',
        }),
      ),
    ).toBe('Internal server error (reference 3f9c2a1b)');
  });

  it('unpacks a validation issue', () => {
    expect(
      errorMessage(
        failed({ error: 'Invalid request body', details: [{ message: 'month must be YYYY-MM' }] }),
      ),
    ).toBe('month must be YYYY-MM');
  });
});
