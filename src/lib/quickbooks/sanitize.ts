/**
 * Drop payment instruments at INTAKE, before anything is stored or mapped.
 *
 * Owner requirement 11: card numbers, CVV and bank routing/account numbers
 * are never stored — DROPPED, not masked. A mask is still a record that the
 * value passed through, and a masked PAN in a `raw` JSONB column is a PCI
 * conversation nobody here wants to have. Every QuickBooks payload goes
 * through this on the way in, so the raw column can only ever hold what
 * survived.
 *
 * Pure and idempotent: sanitizing twice is a no-op, which matters because
 * `appendEvents` re-runs it over anything a caller hands it (belt and
 * braces — `ledger_import_events` is reader-visible).
 *
 * Every rule below matches CASE-INSENSITIVELY. The names are written in
 * QuickBooks' PascalCase because that is where they came from, but the same
 * sanitizer is the intake guard for the NetSuite mirror (src/lib/ledger/
 * netsuite-mirror.ts), and SuiteQL hands back lowercase column names —
 * `ccnumber`, `ccsecuritycode`, `accountnumber`. Matching the spelling
 * rather than the field is how a guard quietly stops guarding.
 */

/**
 * Whole subtrees that exist only to carry an instrument. Removing the
 * subtree rather than its leaves is what makes the rule robust: Intuit can
 * add a field inside `CreditCardPayment` and we still store none of it.
 *
 * Matched case-insensitively, so NetSuite's `bankaccount` is the same rule
 * as QuickBooks' `BankAccount`.
 */
export const DROP_SUBTREE_KEYS = new Set([
  'CreditCardPayment',
  'CheckPayment',
  'BankAccount',
  'BankAccountRef',
  'CreditChargeInfo',
  'CreditChargeResponse',
]);

const DROP_SUBTREE_KEYS_LOWER = new Set([...DROP_SUBTREE_KEYS].map(k => k.toLowerCase()));

/**
 * Exact key names dropped wherever they appear.
 *
 * `AcctNum` is deliberately ABSENT: on `Account` it is the chart-of-accounts
 * number (→ `ledger_accounts.account_number`), which is reference data the
 * ledger needs. The only bank/card `AcctNum` lives under `CheckPayment` /
 * `BankAccount`, and those go whole.
 *
 * `TempDownloadUri` is here for a different reason — it is a short-lived
 * credential-bearing URL. It works for minutes and would sit in `raw`
 * forever looking like a link someone could click.
 *
 * Case-INSENSITIVE, which is also what covers NetSuite's lowercase
 * `accountnumber` / `routingnumber` spellings. The `AcctNum` carve-out
 * survives it: NetSuite's chart-of-accounts column is `acctnumber`, not
 * `accountnumber`.
 */
export const DROP_KEY_RE =
  /^(TaxIdentifier|PrimaryTaxIdentifier|BusinessNumber|RoutingNumber|AccountNumber|CardNumber|NameOnCard|NameOnAcct|CcExpiryMonth|CcExpiryYear|CCExpiryMonth|CCExpiryYear|Cvc|Cvv|Ccv|TempDownloadUri)$/i;

/**
 * A last net for names we did not predict — applied to PRIMITIVE-valued keys
 * only. Objects are left alone here on purpose: `CreditCardPayment` is
 * already a subtree rule, and a fuzzy match on a container would silently
 * eat structure (a hypothetical `CardTerminalRef`) instead of a value.
 *
 * The `cc*` family is NetSuite's own: the transaction table carries
 * `ccnumber` (the PAN), `ccsecuritycode` (the CVV), `ccname`, `ccexpiredate`
 * and the card's billing address on the same row a mirror SELECTs from. None
 * of those contain the word "card", so the generic half of this net misses
 * every one of them.
 */
export const DROP_KEY_FUZZY_RE =
  /(card|routing|cvv|cvc|ssn|taxid|^cc(number|name|expiredate|securitycode|street|zipcode)$|^accountnumber$|^bankaccount$)/i;

export interface SanitizeResult {
  clean: unknown;
  /** UNIQUE KEY NAMES ONLY — never the values. This list is reader-visible. */
  dropped: string[];
}

export function sanitizeQboPayload(entity: string, obj: unknown): SanitizeResult {
  const dropped = new Set<string>();

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_SUBTREE_KEYS_LOWER.has(key.toLowerCase())) {
        dropped.add(key);
        continue;
      }
      if (DROP_KEY_RE.test(key)) {
        dropped.add(key);
        continue;
      }
      const primitive = v == null || typeof v !== 'object';
      if (primitive && DROP_KEY_FUZZY_RE.test(key)) {
        dropped.add(key);
        continue;
      }
      out[key] = walk(v);
    }
    return out;
  };

  // `entity` is not used to decide anything — the rules are uniform, and a
  // per-entity allowlist is exactly the thing that goes stale the first time
  // Intuit adds a field. It stays in the signature so callers (and the
  // events table) record WHAT was sanitized.
  void entity;

  return { clean: walk(obj), dropped: [...dropped].sort() };
}
