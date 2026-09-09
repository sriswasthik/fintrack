/**
 * Keeps `docs/EDGE_CASES.md` honest.
 *
 * That page claims every case in PROJECT_CONTEXT.md §8 is covered, and backs
 * each claim with a test name. A documentation table is the easiest thing in a
 * repository to let rot: a test gets renamed, the row still says "covered", and
 * the claim quietly becomes false while every suite stays green.
 *
 * So the citations are checked like anything else. Every row must name a file
 * that exists and a test that is really in it, and every §8 case must have at
 * least one row.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const DOC = readFileSync(join(ROOT, 'docs', 'EDGE_CASES.md'), 'utf8');

interface Citation {
  file: string;
  test: string;
  /** The §8 case whose section the row sits in. */
  section: string;
}

/** Every `| \`path\` | test name |` row, tagged with the section it is under. */
function citations(): Citation[] {
  const found: Citation[] = [];
  let section = '';

  for (const line of DOC.split('\n')) {
    const heading = /^## (\d+)\./.exec(line);
    if (heading) section = heading[1];

    const row = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/.exec(line);
    if (row && section) found.push({ file: row[1], test: row[2], section });
  }

  return found;
}

const CITED = citations();
const CASES = Array.from({ length: 12 }, (_, i) => String(i + 1));

/** An it.each title carries `%s` placeholders; match the literal template. */
const asSearch = (test: string): string => test;

describe('docs/EDGE_CASES.md', () => {
  it('cites a test for every one of the twelve §8 cases', () => {
    const covered = new Set(CITED.map((c) => c.section));
    expect([...covered].sort((a, b) => Number(a) - Number(b))).toEqual(CASES);
  });

  it('marks every case covered in the summary table', () => {
    const summary = DOC.slice(DOC.indexOf('## Summary'));
    CASES.forEach((one) => expect(summary).toMatch(new RegExp(`\\| ${one}\\..*\\| covered \\|`)));
  });

  it('cites enough tests to be worth reading', () => {
    // A guard against the table being quietly emptied rather than fixed.
    expect(CITED.length).toBeGreaterThanOrEqual(60);
    CASES.forEach((one) => {
      const rows = CITED.filter((c) => c.section === one);
      expect(rows.length, `§8 case ${one}`).toBeGreaterThanOrEqual(3);
    });
  });

  it.each(CITED.map((c) => [c.file, c.test] as const))(
    'cites a real test: %s — %s',
    (file, test) => {
      const path = join(ROOT, file);
      expect(existsSync(path), `${file} does not exist`).toBe(true);
      expect(readFileSync(path, 'utf8'), `${file} has no test named "${test}"`).toContain(
        asSearch(test),
      );
    },
  );
});
