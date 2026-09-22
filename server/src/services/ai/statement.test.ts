import { describe, expect, it } from 'vitest';

import {
  parseModelResponse,
  StatementReaderResponseError,
  stripFence,
  SYSTEM_PROMPT,
  toParsedRows,
} from './statement';

describe('parseModelResponse', () => {
  it('accepts the shape the prompt asks for', () => {
    const rows = parseModelResponse(
      JSON.stringify({
        rows: [
          { date: '01/03/2026', description: 'PAYTM*CHAI POINT', debit: '228.21', credit: null },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('PAYTM*CHAI POINT');
  });

  it('survives a markdown fence the model added anyway', () => {
    const rows = parseModelResponse(
      '```json\n{"rows":[{"date":"01/03/2026","description":"X"}]}\n```',
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses anything that is not JSON', () => {
    expect(() => parseModelResponse('I could not read that statement, sorry.')).toThrow(
      StatementReaderResponseError,
    );
  });

  it('refuses JSON of the wrong shape rather than half-trusting it', () => {
    // Nothing downstream should have to wonder whether `rows` is an array.
    expect(() => parseModelResponse('{"transactions":[]}')).toThrow(StatementReaderResponseError);
    expect(() => parseModelResponse('{"rows":[{"description":"no date here"}]}')).toThrow(
      StatementReaderResponseError,
    );
    expect(() => parseModelResponse('{"rows":[{"date":"","description":"blank"}]}')).toThrow(
      StatementReaderResponseError,
    );
  });

  it('takes amounts as strings, so the model cannot quietly reformat them', () => {
    // A bank prints 1,23,456.78; a model asked for a number would "help".
    const rows = parseModelResponse(
      '{"rows":[{"date":"01/03/2026","description":"X","debit":"1,23,456.78"}]}',
    );
    expect(rows[0].debit).toBe('1,23,456.78');
    expect(() =>
      parseModelResponse('{"rows":[{"date":"01/03/2026","description":"X","debit":123456.78}]}'),
    ).toThrow(StatementReaderResponseError);
  });
});

describe('stripFence', () => {
  it('leaves unfenced text alone', () => {
    expect(stripFence('{"rows":[]}')).toBe('{"rows":[]}');
  });
});

describe('toParsedRows', () => {
  const row = (over: Partial<Parameters<typeof toParsedRows>[0][number]> = {}) => ({
    date: '01/03/2026',
    description: 'PAYTM*CHAI POINT',
    debit: '228.21',
    credit: null,
    balance: null,
    ...over,
  });

  it('re-derives every field with the readers the deterministic path uses', () => {
    const { rows, errors } = toParsedRows([row()]);

    expect(errors).toEqual([]);
    expect(rows[0].date).toBe('2026-03-01');
    expect(rows[0].amount).toBe(228.21);
    // Normalized by the same normalizer, not by whatever the model returned.
    expect(rows[0].normalizedMerchant).toBe('CHAI POINT');
  });

  it('makes a credit negative, so the debit-positive convention holds', () => {
    const { rows } = toParsedRows([row({ debit: null, credit: '60,000.00' })]);
    expect(rows[0].amount).toBe(-60000);
  });

  it('reads the Indian grouping a statement prints', () => {
    const { rows } = toParsedRows([row({ debit: '1,23,456.78' })]);
    expect(rows[0].amount).toBe(123456.78);
  });

  it('settles the date convention across the whole batch, not row by row', () => {
    // 03/05 is ambiguous alone; 15/03 in the same file proves dd/mm.
    const { rows } = toParsedRows([row({ date: '03/05/2026' }), row({ date: '15/03/2026' })]);
    expect(rows[0].date).toBe('2026-05-03');
    expect(rows[1].date).toBe('2026-03-15');
  });

  it('turns a row it cannot read into an error, never a guess', () => {
    const { rows, errors } = toParsedRows([
      row({ date: 'sometime in March' }),
      row({ debit: null, credit: null }),
      row({ debit: '10', credit: '10' }),
      row({ description: '   ' }),
    ]);

    expect(rows).toEqual([]);
    expect(errors).toHaveLength(4);
    expect(errors.map((e) => e.reason)).toEqual([
      'Unrecognised date: "sometime in March"',
      'Row has neither a debit nor a credit',
      'Row has both a debit and a credit',
      'Missing description',
    ]);
  });
});

describe('the prompt', () => {
  it('tells the model to transcribe and nothing else', () => {
    expect(SYSTEM_PROMPT).toContain('Copy values EXACTLY');
    expect(SYSTEM_PROMPT).toContain('Never invent a row');
    expect(SYSTEM_PROMPT).toContain('Never categorize');
  });
});
