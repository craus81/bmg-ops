/**
 * Forgiving text search: the ONE rule every search box uses to decide whether
 * typed words match a record (owner ask 2026-10-12, from Valarie: "St.
 * Charles" and "St Charles" should find each other, and Saint / St. / St
 * are all the same).
 *
 *   - Case doesn't matter.
 *   - Punctuation and spacing between words don't matter: "St Charles",
 *     "St. Charles", "St.Charles" and "st-charles" all match each other, and
 *     "O'Fallon" finds "O Fallon".
 *   - Common short forms are the same word: Saint/St, Street/St, Mount/Mt,
 *     Fort/Ft, and/&, Company/Co, Incorporated/Inc, Corporation/Corp,
 *     Brothers/Bros, Avenue/Ave, Road/Rd.
 *   - Otherwise it is still a "contains" match, as before: "char" finds
 *     "St. Charles", so results narrow as you type.
 *
 * Two dialects of the same pattern, so the browser and the database agree:
 *   looseMatcher(q)     — a JS predicate for lists filtered in the page.
 *   looseSearchRegex(q) — a Postgres regex for `imatch` (case-insensitive
 *                         `~*`), and looseOrFilter() for a PostgREST `.or()`
 *                         across several columns. Trigram indexes (migration
 *                         354) still serve these: the literal words in the
 *                         pattern are what pg_trgm looks up.
 *
 * Pure and client-safe.
 */

/** Words that mean the same thing. A query word expands to its whole group. */
const SYNONYM_GROUPS: string[][] = [
  ['saint', 'st'],
  ['street', 'st'],
  ['mount', 'mt'],
  ['fort', 'ft'],
  ['and', '&'],
  ['company', 'co'],
  ['incorporated', 'inc'],
  ['corporation', 'corp'],
  ['brothers', 'bros'],
  ['avenue', 'ave'],
  ['road', 'rd'],
];

/** Each word → every word it may stand for (itself first). */
const ALTERNATIVES: Map<string, string[]> = (() => {
  const m = new Map<string, Set<string>>();
  for (const group of SYNONYM_GROUPS) {
    for (const w of group) {
      if (!m.has(w)) m.set(w, new Set([w]));
      for (const other of group) m.get(w)!.add(other);
    }
  }
  return new Map([...m].map(([k, v]) => [k, [...v]]));
})();

/**
 * The query as lowercase words: accents dropped, `&` kept as the word "and",
 * an apostrophe splits a word ("O'Fallon" → o, fallon), everything else
 * that isn't a letter or digit separates words.
 */
export function searchWords(query: string | null | undefined): string[] {
  return String(query || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 12);
}

type Dialect = { gap: string; boundary: string; group: (alts: string[]) => string };

const JS: Dialect = {
  gap: '[^a-z0-9]*',
  boundary: '(?:^|[^a-z0-9])',
  group: alts => `(?:${alts.join('|')})`,
};

const PG: Dialect = {
  gap: '[^[:alnum:]]*',
  boundary: '(^|[^[:alnum:]])',
  group: alts => `(${alts.join('|')})`,
};

/**
 * Words joined by "any punctuation or spacing, or none". A word with short
 * forms becomes its whole group, and each spelled-out form must start a word
 * ("st" mustn't turn "First" into a match for "Saint"); "&" needs no
 * boundary. Words are only ever [a-z0-9] (searchWords), so nothing needs
 * escaping in either dialect, and the pattern never holds a double quote or
 * comma that could break out of a quoted PostgREST value.
 */
function buildPattern(words: string[], d: Dialect): string {
  return words.map(w => {
    const alts = ALTERNATIVES.get(w);
    // An apostrophe after a word's first letter may be missing from what
    // was typed: "ofallon" finds "O'Fallon", "dangelo" finds "D'Angelo".
    if (!alts) return w.length >= 3 && /^[a-z]/.test(w) ? `${w[0]}['\u2019]?${w.slice(1)}` : w;
    return d.group(alts.map(a => (a === '&' ? '&' : `${d.boundary}${a}`)));
  }).join(d.gap);
}

/**
 * A predicate for filtering a list in the page. Pass one string or several
 * fields; it matches when any field contains the words. An empty query
 * matches everything, as an empty search box always has.
 */
export function looseMatcher(query: string | null | undefined): (...fields: unknown[]) => boolean {
  const words = searchWords(query);
  if (words.length === 0) return () => true;
  const re = new RegExp(buildPattern(words, JS), 'i');
  const test = (f: unknown): boolean => {
    if (Array.isArray(f)) return f.some(test);
    if (f === null || f === undefined || f === '') return false;
    return re.test(String(f).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
  };
  return (...fields: unknown[]) => fields.some(test);
}

/** One-off form of looseMatcher. Build the matcher once when filtering a list. */
export function looseIncludes(haystack: unknown, query: string | null | undefined): boolean {
  return looseMatcher(query)(haystack);
}

/**
 * The query as a Postgres regex for a case-insensitive match (`imatch` in
 * PostgREST, `~*` in SQL). Null when the query has no words.
 */
export function looseSearchRegex(query: string | null | undefined): string | null {
  const words = searchWords(query);
  return words.length ? buildPattern(words, PG) : null;
}

/**
 * A PostgREST `.or()` string matching the query in any of `columns`, e.g.
 * `.or(looseOrFilter(['company_name', 'contact_name'], q))`. Values are
 * double-quoted, so the regex's parentheses and commas stay part of it.
 * Columns may carry PostgREST paths (`customer->>name`). Null when the query
 * has no words — callers skip the filter (or the search) then.
 */
export function looseOrFilter(columns: string[], query: string | null | undefined, extra: string[] = []): string | null {
  const re = looseSearchRegex(query);
  if (!re) return null;
  return [...columns.map(c => `${c}.imatch."${re}"`), ...extra].join(',');
}

/**
 * Record numbers typed without their dashes (owner ask 2026-10-20: the top
 * bar didn't find FleetSuite estimate numbers). "EST2610014", "est 2610 014"
 * and "2610014" should all find EST-2610-014, but the word rule above keeps
 * a typed word whole, so "est2610014" never matched across the dashes.
 *
 * For a query that holds a digit, every letter and digit may be separated
 * by punctuation or spacing in the stored number. Null for a query with no
 * digit — a name isn't a record number. Meant for number columns only
 * (estimate, job, quote, transaction numbers): on long text it would match
 * scattered characters.
 */
export function looseNumberRegex(query: string | null | undefined): string | null {
  const chars = searchWords(query).join('');
  if (!/[0-9]/.test(chars)) return null;
  return chars.split('').join('[^[:alnum:]]*');
}

/** The JS twin of looseNumberRegex: does `value` hold the typed number? */
export function looseNumberIncludes(value: unknown, query: string | null | undefined): boolean {
  const chars = searchWords(query).join('');
  if (!/[0-9]/.test(chars)) return false;
  return searchWords(String(value ?? '')).join('').includes(chars);
}

/**
 * looseOrFilter for a search over number columns and text columns at once:
 * the text columns get the word rule, the number columns get it too plus
 * looseNumberRegex. Null when the query has no words.
 */
export function looseOrFilterWithNumbers(numberColumns: string[], textColumns: string[], query: string | null | undefined): string | null {
  const numRe = looseNumberRegex(query);
  const extra = numRe ? numberColumns.map(c => `${c}.imatch."${numRe}"`) : [];
  return looseOrFilter([...numberColumns, ...textColumns], query, extra);
}

/**
 * Part numbers typed without their dashes, or with them in other places
 * (owner ask 2026-10-22: "AR2000" should find AR-2000, and "n5rs48-3"
 * should find N5-RS48-3). The word rule above keeps "n5rs48" whole, so it
 * never matched across the stored dash.
 *
 * A part number's letters and digits are compared with every dash, space,
 * dot or slash dropped from both sides, still as a "contains" match: "n5rs48"
 * finds every N5-RS48 shelf. Unlike looseNumberRegex this doesn't need a
 * digit (some part numbers are all letters). Meant for part number columns
 * only — on long text it would match scattered letters.
 */
export function partNumberKey(value: unknown): string {
  return searchWords(String(value ?? '')).join('');
}

/** Does part number `value` hold the typed part number, punctuation aside? */
export function partNumberIncludes(value: unknown, query: string | null | undefined): boolean {
  const key = partNumberKey(query);
  return key.length > 0 && partNumberKey(value).includes(key);
}

/** The Postgres twin of partNumberIncludes for `imatch`. Null for an empty query. */
export function partNumberRegex(query: string | null | undefined): string | null {
  const key = partNumberKey(query);
  return key ? key.split('').join('[^[:alnum:]]*') : null;
}

/**
 * looseOrFilter for a parts search: the text columns get the word rule, and
 * the part number columns get it too plus partNumberRegex, so a part number
 * matches with or without its dashes. Null when the query has no words.
 */
export function partSearchOrFilter(partColumns: string[], textColumns: string[], query: string | null | undefined): string | null {
  const re = partNumberRegex(query);
  const extra = re ? partColumns.map(c => `${c}.imatch."${re}"`) : [];
  return looseOrFilter([...partColumns, ...textColumns], query, extra);
}
