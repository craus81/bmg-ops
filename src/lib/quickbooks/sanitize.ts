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
 */

/**
 * Whole subtrees that exist only to carry an instrument. Removing the
 * subtree rather than its leaves is what makes the rule robust: Intuit can
 * add a field inside `CreditCardPayment` and we still store none of it.
 */
export const DROP_SUBTREE_KEYS = new Set([
  'CreditCardPayment',
  'CheckPayment',
  'BankAccount',
  'BankAccountRef',
  'CreditChargeInfo',
  'CreditChargeResponse',
]);

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
 */
export const DROP_KEY_RE =
  /^(TaxIdentifier|PrimaryTaxIdentifier|BusinessNumber|RoutingNumber|AccountNumber|CardNumber|NameOnCard|NameOnAcct|CcExpiryMonth|CcExpiryYear|CCExpiryMonth|CCExpiryYear|Cvc|Cvv|Ccv|TempDownloadUri)$/;

/**
 * A last net for names we did not predict — applied to PRIMITIVE-valued keys
 * only. Objects are left alone here on purpose: `CreditCardPayment` is
 * already a subtree rule, and a fuzzy match on a container would silently
 * eat structure (a hypothetical `CardTerminalRef`) instead of a value.
 */
export const DROP_KEY_FUZZY_RE = /(card|routing|cvv|cvc|ssn|taxid)/i;

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
      if (DROP_SUBTREE_KEYS.has(key)) {
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
