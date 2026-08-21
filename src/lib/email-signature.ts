/**
 * Per-user email signature for staff-composed customer emails.
 *
 * The signature is plain text on profiles.email_signature plus an optional
 * company-logo toggle (profiles.email_signature_logo), both edited on
 * Settings. Compose routes fetch it with getEmailSignature and hand it to
 * their HTML builder, which renders it via renderSignatureHtml — BEFORE the
 * preview is returned, so the sender sees exactly what will go out.
 * Automated sends (crons, digests, invites) have no composing user and
 * therefore no signature.
 *
 * The logo is the letterhead logo from wrap_quote_settings.company
 * (logo_path in the vehicle-templates R2 bucket) — the same image the
 * quote/estimate documents already use — not a per-user upload. R2 is
 * imported lazily so the pure renderer stays safe to import anywhere.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface EmailSignature {
  text: string | null;
  /** Public URL of the company logo, when the user opted in and one is set. */
  logoUrl: string | null;
}

/** The sender's signature, or null when they have neither text nor logo. */
export async function getEmailSignature(
  supabase: { from: (t: string) => any },
  userId?: string | null,
): Promise<EmailSignature | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from('profiles')
      .select('email_signature, email_signature_logo')
      .eq('id', userId)
      .maybeSingle();
    const text = (data?.email_signature || '').trim() || null;
    let logoUrl: string | null = null;
    if (data?.email_signature_logo) {
      const { data: settings } = await supabase
        .from('wrap_quote_settings')
        .select('company')
        .eq('id', 1)
        .maybeSingle();
      const path = settings?.company?.logo_path;
      if (path) {
        const { r2PublicUrl } = await import('./r2');
        logoUrl = r2PublicUrl('vehicle-templates', path);
      }
    }
    if (!text && !logoUrl) return null;
    return { text, logoUrl };
  } catch {
    // A signature must never break a send.
    return null;
  }
}

/**
 * The signature as an email-safe HTML block (inline styles only), themed to
 * match the two template families: 'light' for the white customer documents
 * (estimate, wrap quote, statement, install guide), 'dark' for the dark
 * notification/invoice cards — where the logo sits on a white chip so dark
 * logo artwork stays legible. Accepts the plain text alone for convenience.
 * Empty string when there's nothing to render.
 */
export function renderSignatureHtml(
  signature: EmailSignature | string | null | undefined,
  theme: 'light' | 'dark' = 'light',
): string {
  const sig: EmailSignature | null =
    typeof signature === 'string' ? { text: signature, logoUrl: null } : signature || null;
  const text = (sig?.text || '').trim();
  const logoUrl = sig?.logoUrl || null;
  if (!text && !logoUrl) return '';
  const border = theme === 'dark' ? '#1e2d3d' : '#e5e7eb';
  const color = theme === 'dark' ? '#dbe4ee' : '#374151';
  const textHtml = text
    ? `<div style="white-space:pre-line;">${escapeHtml(text)}</div>`
    : '';
  const logoHtml = logoUrl
    ? `<div style="margin-top:${text ? '8px' : '0'};"><img src="${escapeHtml(logoUrl)}" alt="Company logo" height="36" style="height:36px;max-width:200px;display:block;${theme === 'dark' ? 'background:#ffffff;padding:5px 8px;border-radius:6px;' : ''}"></div>`
    : '';
  return `<div style="margin-top:18px;padding-top:12px;border-top:1px solid ${border};font-size:12px;color:${color};line-height:1.5;">${textHtml}${logoHtml}</div>`;
}
