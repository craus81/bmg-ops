/**
 * Per-user email signature for staff-composed customer emails.
 *
 * The signature is plain text on profiles.email_signature (edited on
 * Settings). Compose routes fetch it with getEmailSignature and hand it to
 * their HTML builder, which renders it via renderSignatureHtml — BEFORE the
 * preview is returned, so the sender sees exactly what will go out.
 * Automated sends (crons, digests, invites) have no composing user and
 * therefore no signature.
 *
 * Server-safe: pure string building + one Supabase read.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The sender's signature text, or null when unset/blank. */
export async function getEmailSignature(
  supabase: { from: (t: string) => any },
  userId?: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('email_signature')
      .eq('id', userId)
      .maybeSingle();
    const sig = (data?.email_signature || '').trim();
    return sig || null;
  } catch {
    // A signature must never break a send.
    return null;
  }
}

/**
 * The signature as an email-safe HTML block (inline styles only), themed to
 * match the two template families: 'light' for the white customer documents
 * (estimate, wrap quote, statement, install guide), 'dark' for the dark
 * notification/invoice cards. Empty string when there's no signature.
 */
export function renderSignatureHtml(
  signature: string | null | undefined,
  theme: 'light' | 'dark' = 'light',
): string {
  const sig = (signature || '').trim();
  if (!sig) return '';
  const border = theme === 'dark' ? '#1e2d3d' : '#e5e7eb';
  const color = theme === 'dark' ? '#dbe4ee' : '#374151';
  return `<div style="margin-top:18px;padding-top:12px;border-top:1px solid ${border};font-size:12px;color:${color};line-height:1.5;white-space:pre-line;">${escapeHtml(sig)}</div>`;
}
