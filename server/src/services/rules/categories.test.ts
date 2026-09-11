import { describe, expect, it } from 'vitest';

import { CATEGORIES } from './categories';

describe('the taxonomy', () => {
  it('carries the three categories Phase 14 added', () => {
    expect(CATEGORIES).toContain('EMI_LOAN');
    expect(CATEGORIES).toContain('INVESTMENTS');
    expect(CATEGORIES).toContain('CASH_WITHDRAWAL');
  });

  it('matches the client copy value for value and in order', async () => {
    // `client/src/lib/transactions.ts` hand-maintains a mirror of the Prisma
    // enum, because the client cannot import the generated Prisma client. A
    // category the server can store but the client has never heard of would
    // disappear from every picker with nothing to say it had — so this is the
    // only thing standing between the two copies and quiet drift.
    //
    // Path is from the workspace root: the server compiles to CommonJS, where
    // `import.meta` is not available.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile('../client/src/lib/transactions.ts', 'utf8');

    const block = /export const CATEGORIES = \[([\s\S]*?)\] as const;/.exec(source);
    expect(block, 'client CATEGORIES array not found').not.toBeNull();

    const clientCategories = [...block![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(clientCategories).toEqual([...CATEGORIES]);
  });
});
