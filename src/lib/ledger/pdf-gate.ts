import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The R2 privacy-flip gate for ledger documents.
 *
 * Owner rule (2026-09-13, item 4): imported financial PDFs and attachments
 * are NOT written to R2 until the C2 privacy flip in docs/r2-private-flip.md
 * has been verified. Until then the public bucket domain would serve any
 * `ledger/…` object to anyone who guessed the key, and the whole QuickBooks
 * history is exactly the material that must not be guessable.
 *
 * Two ways to say "the flip is done", both explicit and both auditable:
 *   - env `LEDGER_PDFS_ENABLED=true` (the literal string 'true' — '1' does
 *     NOT count, so a stray truthy value can't open the gate); or
 *   - a stamp on `app_settings.ledger` written from Settings → Company by a
 *     super admin, for when the owner would rather not redeploy.
 *
 * Everything else — unset, blank, 'false', an unreadable settings row — is
 * off. The gate fails CLOSED: a settings read that errors leaves it shut.
 * Enforcement itself lives in `putLedgerObject` (./storage.ts), not at the
 * call sites, so no future caller can forget to ask.
 *
 * "Shut" and "we could not tell" are still different facts, though, and a
 * surface that prints the first when the second is true is stating something
 * it does not know (R7-1). So `readLedgerSettings` THROWS on a failed read
 * and `ledgerPdfsEnabled` reports it as `readError` while keeping
 * `enabled: false` — writes stay closed, the Connections row says "could not
 * read" instead of "Off".
 */

export const LEDGER_SETTINGS_KEY = 'ledger';

export interface LedgerSettings {
  /** ISO timestamp the R2 privacy flip was confirmed. Presence = gate open. */
  pdfs_enabled_at?: string;
  /** profiles.id of the super admin who stamped it. */
  pdfs_enabled_by?: string;
  /**
   * The confirmed QuickBooks → NetSuite cutover. `confirmedBy` is NULLABLE:
   * the import route is driven with `Authorization: Bearer $CRON_SECRET`
   * from outside the app, and such a run has no session user.
   */
  cutover?: {
    date: string;
    confirmedBy: string | null;
    confirmedAt: string;
    dryRunId: string;
  };
  /** How far back the NetSuite ledger mirror reaches (YYYY-MM-DD). */
  netsuite_since?: string;
}

/**
 * Read the `ledger` settings blob.
 *
 * An ABSENT row (or a value that is not an object) reads as {} — nothing has
 * been confirmed yet, which is a real answer. A FAILED read THROWS: "the row
 * says nothing" and "we could not ask" are different facts, and swallowing
 * the second would let every caller — the gate, the cutover reader, the
 * Connections row — render an outage as a confirmed "nothing". Callers that
 * must fail closed catch it; callers that render it say so.
 */
export async function readLedgerSettings(service: SupabaseClient): Promise<LedgerSettings> {
  const { data, error } = await service
    .from('app_settings')
    .select('value')
    .eq('key', LEDGER_SETTINGS_KEY)
    .maybeSingle();
  if (error) {
    throw new Error(`app_settings.${LEDGER_SETTINGS_KEY} could not be read: ${error.message || 'unknown error'}`);
  }
  const raw = data?.value != null && typeof data.value === 'string' ? safeParse(data.value) : data?.value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as LedgerSettings) : {};
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Is the R2 privacy flip confirmed? `enabled` is the write decision and it
 * fails CLOSED. `readError` is set ONLY when the settings row could not be
 * read at all — same `enabled: false`, but a reader (System Health →
 * Connections) can then say "could not read the gate" instead of asserting
 * the flat fact "Off".
 */
export async function ledgerPdfsEnabled(
  service: SupabaseClient,
): Promise<{ enabled: boolean; reason: string; via: 'env' | 'settings' | null; readError?: string }> {
  if ((process.env.LEDGER_PDFS_ENABLED || '').trim() === 'true') {
    return { enabled: true, reason: 'Enabled via LEDGER_PDFS_ENABLED', via: 'env' };
  }

  let settings: LedgerSettings = {};
  try {
    settings = await readLedgerSettings(service);
  } catch (e: any) {
    // Fail closed — an unreadable settings row is not permission to write —
    // but report WHY, so nothing downstream prints "Off" as a fact.
    const why = e?.message ? String(e.message).slice(0, 200) : 'unknown error';
    return { enabled: false, reason: `Could not read the gate — ${why}`, via: null, readError: why };
  }

  const stampedAt = typeof settings.pdfs_enabled_at === 'string' ? settings.pdfs_enabled_at.trim() : '';
  if (stampedAt) {
    return {
      enabled: true,
      reason: `Enabled via Settings → Company (stamped ${stampedAt.slice(0, 10)})`,
      via: 'settings',
    };
  }

  return {
    enabled: false,
    reason: 'Off — ledger PDFs are not written until the R2 privacy flip is verified (docs/r2-private-flip.md)',
    via: null,
  };
}
