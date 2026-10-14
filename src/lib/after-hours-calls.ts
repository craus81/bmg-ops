/**
 * Display helpers for after-hours calls (Retell), shared by the webhook's
 * email and the After-hours Calls page. Kept free of node imports so the
 * page can use them in the browser.
 */

const digits10 = (phone: string | null | undefined): string => {
  const d = String(phone || '').replace(/\D+/g, '');
  return d.length > 10 ? d.slice(-10) : d;
};

/** (636) 555-0142 for a 10-digit US number, else as given. */
export function prettyPhone(phone: string | null | undefined): string {
  const d = digits10(phone);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(phone || '');
}

/** tel: href for a call-back button. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

const REASON_LABELS: Record<string, string> = {
  quote: 'Quote request', status: 'Job or estimate status', billing: 'Billing', other: 'Other',
};

export function reasonLabel(reason: string | null): string {
  if (!reason) return 'Message';
  return REASON_LABELS[reason.toLowerCase()] || reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Retell's "Agent: …\nUser: …" transcript as speaker turns. */
export function transcriptTurns(transcript: string | null): Array<{ speaker: 'Assistant' | 'Caller' | null; text: string }> {
  if (!transcript) return [];
  return transcript.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const m = /^(Agent|User)\s*:\s*(.*)$/i.exec(line);
    if (!m) return { speaker: null, text: line };
    return { speaker: m[1].toLowerCase() === 'agent' ? 'Assistant' as const : 'Caller' as const, text: m[2] };
  });
}
