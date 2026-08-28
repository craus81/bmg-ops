/**
 * Access control for the FleetSuite AI agent (`/api/ai-agent/chat`).
 *
 * The agent runs raw SuiteQL and service-role SQL on the caller's behalf, so
 * "who is allowed to see what" cannot live in the prompt — a determined user
 * just asks differently. These helpers are the authoritative gate the route's
 * executor enforces on every query, keyed off the SERVER-resolved profile
 * role (never a client-supplied one — that was the bypass this closes).
 *
 * Two tiers, matching the rest of the app:
 *   - Office staff may query NetSuite at all (OFFICE_STAFF_ROLES).
 *   - Only financials-eligible roles (super_admin / executive — the same gate
 *     as `requireFinancials` and the Financials tab) may reach GL / A/R / A/P
 *     / payment data, on ANY source.
 */

export const OFFICE_STAFF_ROLES = [
  'admin', 'super_admin', 'executive', 'sales', 'graphics_production', 'finance',
];

/** Roles from a profile: the `roles` array if present, else the single `role`. */
export function rolesOf(profile: any): string[] {
  const arr = profile?.roles?.length ? profile.roles : [profile?.role];
  return (Array.isArray(arr) ? arr : []).filter(Boolean);
}

/** Office staff — may query NetSuite and take write actions. */
export function canQueryNetSuite(roles: string[]): boolean {
  return roles.some(r => OFFICE_STAFF_ROLES.includes(r));
}

/** Financials-eligible — may reach GL / A/R / A/P / payment / pay data. */
export function canSeeFinancials(roles: string[]): boolean {
  return roles.includes('super_admin') || roles.includes('executive');
}

// SuiteQL touching GL accounts, customer/vendor balances, credit limits, or
// payment/bill/journal transactions — the "bank-balance-like figures" the
// audit flagged. Revenue via SalesOrd/foreigntotal is intentionally NOT here
// so sales staff keep their sales-order reporting.
export const NETSUITE_FINANCIAL_PATTERNS: RegExp[] = [
  /transactionaccountingline/i,
  /\bfrom\s+account\b/i,
  /\bjoin\s+account\b/i,
  /\.\s*balance\b/i,
  /overduebalance/i,
  /foreignamountunpaid/i,
  /creditlimit/i,
  /\.\s*(?:debit|credit)\b/i,
  /\bacctnumber\b/i,
  /'(?:CustInvc|CustPymt|CustCred|CustDep|VendBill|VendPymt|VendCred|Journal|Deposit|Check)'/i,
];

// Supabase pay / payout / audit tables — money data otherwise reachable
// through the service-role SQL path. Same financials gate as the GL data.
export const SUPABASE_FINANCIAL_PATTERNS: RegExp[] = [
  /\bpayouts?\b/i,
  /\bpay_rates?\b/i,
  /\bpay_splits?\b/i,
  /\bpay_credits?\b/i,
  /\baudit_log\b/i,
];

// Secrets and forgery material: blocked for EVERY role, including
// super_admin and executive. This is a different question from the financial
// gate above -- leadership may legitimately ask about money, but nobody
// should be able to pull an OAuth refresh token or a customer's approval
// token out of a chat box.
//
//   * approval_token authenticates the PUBLIC, unauthenticated approval
//     endpoints (estimates, wrap quotes, graphics proofs). Anyone holding one
//     can forge the customer's e-signature -- the exact record the
//     sales-order gate trusts. Same for the fleet check-in portal token.
//   * google_tokens / native_push_tokens / app_settings hold live
//     integration credentials.
//   * credit_applications holds EINs and bank references, and has no agent
//     use case at all: nothing in the app reads that table.
//
// NOTE: this is a stopgap of the same shape as the patterns above -- a regex
// over the SQL string, so it stops the model from asking, not a privilege
// boundary. The durable fix is an `ai_ro` schema of security-barrier views
// exposing only safe columns, with exec_readonly_sql running as a role that
// can read nothing else; a table-level allowlist cannot express "estimates
// minus approval_token", which is exactly what is needed here. Tracked in
// docs/workflow-audit-2026-08.md Part 6.
export const ALWAYS_BLOCKED_PATTERNS: RegExp[] = [
  /\bapproval_token\b/i,
  /\bcustomer_portal_token\b/i,
  /\brefresh_token\b/i,
  /\baccess_token\b/i,
  /\bgoogle_tokens?\b/i,
  /\bnative_push_tokens?\b/i,
  /\bapp_settings\b/i,
  /\bcredit_applications?\b/i,
];

/**
 * True when a query reaches a secret or forgeable credential. Applies to
 * every role -- there is no override.
 */
export function touchesForbiddenData(sql: string | undefined): boolean {
  if (!sql) return false;
  return ALWAYS_BLOCKED_PATTERNS.some(re => re.test(sql));
}

/** True when a query reaches financial data for the given source. */
export function touchesFinancialData(source: string, sql: string | undefined): boolean {
  if (!sql) return false;
  if (source === 'netsuite') return NETSUITE_FINANCIAL_PATTERNS.some(re => re.test(sql));
  if (source === 'supabase') return SUPABASE_FINANCIAL_PATTERNS.some(re => re.test(sql));
  return false;
}

/**
 * For non-financials callers, drop the A/R, A/P, revenue and overdue SuiteQL
 * examples from the system prompt so the model doesn't steer them toward
 * queries the executor will reject. Enforcement lives in the per-query gate —
 * this just keeps the prompt and the gate in agreement. Anchored on stable
 * section headers; a no-op if either header moves.
 */
export function stripFinancialGuidance(prompt: string): string {
  const start = prompt.indexOf('COMMON NETSUITE PATTERNS:');
  const end = prompt.indexOf('ANSWER FORMAT:');
  if (start !== -1 && end !== -1 && end > start) {
    return prompt.slice(0, start) + prompt.slice(end);
  }
  return prompt;
}
