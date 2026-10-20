import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import {
  searchWords, looseMatcher, looseIncludes, looseSearchRegex, looseOrFilter,
  looseNumberRegex, looseNumberIncludes, looseOrFilterWithNumbers,
} from './loose-search';

// [query, text, should match]
const CASES: Array<[string, string, boolean]> = [
  // Valarie's examples (2026-10-12)
  ['St. Charles', 'St Charles Plumbing', true],
  ['St Charles', 'City of St. Charles', true],
  ['Saint Charles', 'St. Charles County', true],
  ['st charles', 'SAINT CHARLES SCHOOL DISTRICT', true],
  ['St.Charles', 'St Charles', true],
  // Punctuation and spacing between words
  ["O'Fallon", 'OFallon Fleet', true],
  ['ofallon', "O'Fallon Fleet", true],
  ['ofallon', 'O’Fallon Fleet', true],
  ['dangelo', "D'Angelo Electric", true],
  ["O'Fallon", 'O Fallon Fleet', true],
  ['o fallon', "O'Fallon Fleet", true],
  ['ofallon', 'OFallon Fleet', true],
  ['A&B', 'A and B Towing', true],
  ['a and b', 'A&B Towing', true],
  ['a & b', 'A & B Towing', true],
  ['acme co', 'Acme Company', true],
  ['acme company', 'ACME CO.', true],
  ['acme inc', 'Acme, Incorporated', true],
  ['mt vernon', 'Mount Vernon Police', true],
  ['ft leonard wood', 'Fort Leonard Wood', true],
  ['main st', 'Main Street', true],
  // Still a "contains" search that narrows as you type
  ['char', 'St. Charles', true],
  ['st cha', 'St. Charles', true],
  ['transit 148', 'Ford Transit 148" HR', true],
  ['SO1102', 'so1102', true],
  // Short forms only count at a word start
  ['saint', 'First National', false],
  ['st charles', 'First Charles', false],
  // Words keep their order
  ['charles st', 'St. Charles', false],
  ['plumbing', 'St Charles Plumbing', true],
  ['plumbing x', 'St Charles Plumbing', false],
  // Accents
  ['jose', 'José Auto', true],
];

describe('searchWords', () => {
  it('splits on punctuation and keeps & as "and"', () => {
    expect(searchWords("St. Charles & O'Fallon")).toEqual(['st', 'charles', 'and', 'o', 'fallon']);
    expect(searchWords('  ')).toEqual([]);
  });
});

describe('looseMatcher (browser lists)', () => {
  it.each(CASES)('%j in %j → %s', (q, text, want) => {
    expect(looseIncludes(text, q)).toBe(want);
  });

  it('matches any of several fields and skips empties', () => {
    const m = looseMatcher('st charles');
    expect(m(null, undefined, '', 'City of St. Charles')).toBe(true);
    expect(m(['nope', ['St Charles']])).toBe(true);
    expect(m('nope', 12)).toBe(false);
  });

  it('matches everything on an empty query', () => {
    expect(looseMatcher('')('anything')).toBe(true);
    expect(looseMatcher(' . ')(null)).toBe(true);
  });
});

describe('looseSearchRegex (database)', () => {
  let db: PGlite;
  beforeAll(async () => { db = new PGlite(); });
  afterAll(async () => { await db.close(); });

  it.each(CASES.filter(([, text]) => !/é/.test(text)))('%j in %j → %s', async (q, text, want) => {
    const re = looseSearchRegex(q)!;
    const { rows } = await db.query<{ m: boolean }>('SELECT $1 ~* $2 AS m', [text, re]);
    expect(rows[0].m).toBe(want);
  });

  it('is null for a query with no words', () => {
    expect(looseSearchRegex(' .,')).toBeNull();
    expect(looseOrFilter(['a'], '')).toBeNull();
  });

  it('builds a quoted PostgREST .or() list', () => {
    const re = looseSearchRegex('acme');
    expect(looseOrFilter(['company_name', 'customer->>name'], 'acme')).toBe(
      `company_name.imatch."${re}",customer->>name.imatch."${re}"`,
    );
    expect(looseOrFilter(['a'], 'acme', ['id.eq.5'])).toBe(`a.imatch."${re}",id.eq.5`);
    expect(looseOrFilter(['a'], 'St. "x", (y)')).not.toMatch(/"[^"]*"[^,]/);
  });
});

// [query, stored number, should match] — numbers typed without their dashes
const NUMBER_CASES: Array<[string, string, boolean]> = [
  ['EST2610014', 'EST-2610-014', true],
  ['est 2610 014', 'EST-2610-014', true],
  ['2610014', 'EST-2610-014', true],
  ['EST-2610-014', 'EST-2610-014', true],
  ['2610-01', 'EST-2610-014', true],
  ['GFX2608017', 'GFX-2608-017', true],
  ['EST2610015', 'EST-2610-014', false],
  ['2610104', 'EST-2610-014', false],
];

describe('looseNumberRegex (record numbers)', () => {
  let db: PGlite;
  beforeAll(async () => { db = new PGlite(); });
  afterAll(async () => { await db.close(); });

  it.each(NUMBER_CASES)('%j in %j → %s', async (q, text, want) => {
    const re = looseNumberRegex(q)!;
    const { rows } = await db.query<{ m: boolean }>('SELECT $1 ~* $2 AS m', [text, re]);
    expect(rows[0].m).toBe(want);
    expect(looseNumberIncludes(text, q)).toBe(want);
  });

  it('is null for a query with no digit, so names keep the word rule', () => {
    expect(looseNumberRegex('acme')).toBeNull();
    expect(looseNumberIncludes('acme', 'acme')).toBe(false);
  });

  it('adds the number match to the number columns only', () => {
    const words = looseSearchRegex('est2610014');
    const num = looseNumberRegex('est2610014');
    expect(looseOrFilterWithNumbers(['estimate_number'], ['title'], 'est2610014')).toBe(
      `estimate_number.imatch."${words}",title.imatch."${words}",estimate_number.imatch."${num}"`,
    );
    expect(looseOrFilterWithNumbers(['estimate_number'], ['title'], 'acme')).toBe(looseOrFilter(['estimate_number', 'title'], 'acme'));
  });
});
