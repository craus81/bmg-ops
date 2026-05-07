/**
 * SQL-safe input helpers for SuiteQL (and similar) string-built queries.
 *
 * NetSuite's SuiteQL REST endpoint does not accept bind parameters via the
 * shape we use, so user-controllable values must be validated/escaped before
 * being interpolated into a query string. These helpers throw `SqlSafeError`
 * on invalid input — callers should catch and return a 400.
 */

export class SqlSafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlSafeError';
  }
}

/**
 * Validate an internal NetSuite id (or any numeric id) and return the canonical
 * decimal string. Rejects anything that isn't a positive integer of reasonable
 * length so it can be safely interpolated into a SQL fragment.
 */
export function safeIntId(value: unknown, field = 'id'): string {
  if (value == null) throw new SqlSafeError(`${field} required`);
  const s = String(value).trim();
  if (!/^\d{1,18}$/.test(s)) throw new SqlSafeError(`Invalid ${field}`);
  return s;
}

/**
 * Escape a string for use inside a single-quoted SuiteQL literal, including
 * inside a LIKE pattern. Escapes the SQL quote (' -> ''), backslashes, and the
 * LIKE wildcards (% and _) so user input cannot widen the pattern. Caps length
 * to mitigate query-size abuse.
 */
export function safeLikeTerm(value: unknown, maxLen = 80): string {
  const s = String(value ?? '').trim();
  if (s.length === 0) throw new SqlSafeError('search term required');
  if (s.length > maxLen) throw new SqlSafeError('search term too long');
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''")
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Escape a string for use inside a single-quoted SuiteQL literal (no LIKE
 * wildcards). Caps length and escapes quotes/backslashes.
 */
export function safeStringLiteral(value: unknown, maxLen = 120): string {
  const s = String(value ?? '').trim();
  if (s.length === 0) throw new SqlSafeError('value required');
  if (s.length > maxLen) throw new SqlSafeError('value too long');
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

/**
 * Validate an ISO-style date (YYYY-MM-DD). Rejects anything else so dates can
 * be interpolated safely into SuiteQL date predicates.
 */
export function safeIsoDate(value: unknown, field = 'date'): string {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new SqlSafeError(`Invalid ${field}`);
  return s;
}
