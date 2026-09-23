/**
 * Reading Resend delivery failures (webhooks/resend) into what the sender
 * should do next.
 *
 * A bounce is not always a bad address. Resend reports a `bounce.type` of
 * Permanent (the address or domain doesn't take mail — fix it), Transient
 * (the receiving server refused it for now: full mailbox, size or content
 * filter, a busy server — the address is usually fine) or Undetermined.
 * Telling everyone "fix the address" on a transient bounce sends them
 * hunting for a typo that isn't there.
 */

/**
 * The stored delivery detail, e.g. "Transient (General): The recipient's
 * email provider sent a general bounce message…". The subtype
 * (MailboxFull, MessageTooLarge, ContentRejected…) is the most useful part
 * and is kept alongside the type. Older rows were stored as "Type: message"
 * without the subtype; both read the same way below.
 */
export function bounceDetail(data: any): string | null {
  const type = data?.bounce?.type || null;
  const subType = data?.bounce?.subType || null;
  const label = type && subType ? `${type} (${subType})` : type || subType;
  return [label, data?.bounce?.message || data?.failed?.reason || null]
    .filter(Boolean).join(': ') || null;
}

/** True when the receiving server refused the email for now rather than for good. */
export function isTemporaryBounce(detail: string | null | undefined): boolean {
  return /^(Transient|Undetermined)\b/i.test((detail || '').trim());
}

/** Everyone an email went to — the To line first, then CC/BCC — without repeats. */
export function allRecipients(to?: string[] | null, copies?: string[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of [...(to || []), ...(copies || [])]) {
    const a = String(addr || '').trim();
    if (a && !seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); out.push(a); }
  }
  return out;
}

/**
 * Resend's bounce/complaint event covers the whole email and doesn't say
 * which recipient it came from. With more than one address on the email
 * the culprit can't be named — a CC'd teammate's bounce is not the
 * customer's. A failed hand-off ('failed') reached nobody, so it is never
 * ambiguous.
 */
export function bounceIsAmbiguous(status: string, to?: string[] | null, copies?: string[] | null): boolean {
  return (status === 'bounced' || status === 'complained') && allRecipients(to, copies).length > 1;
}

/** "a@x.com, b@y.com (copied: c@bmgfleet.com)" — the To line, then the copies. */
export function recipientsLabel(to?: string[] | null, copies?: string[] | null): string {
  const toList = allRecipients(to);
  const toKeys = new Set(toList.map(a => a.toLowerCase()));
  const copyList = allRecipients(copies).filter(a => !toKeys.has(a.toLowerCase()));
  return [toList.join(', '), copyList.length ? `(copied: ${copyList.join(', ')})` : '']
    .filter(Boolean).join(' ');
}

/** One sentence telling the sender what to do about a failed delivery. */
export function bounceNextStep(
  status: string,
  detail: string | null | undefined,
  opts: { ambiguous?: boolean } = {},
): string {
  if (opts.ambiguous) {
    return "Resend doesn't say which address it was — if it was a teammate's copy, the customer still got it. Open the email in the Resend dashboard to see which one.";
  }
  if (status === 'complained') return 'Check with the customer before sending again.';
  if (status === 'bounced' && isTemporaryBounce(detail)) {
    return 'The address is probably fine — their mail server refused it for now (often a full mailbox or a size or content filter). Resend, leaving off large attachments, and call them if it bounces again.';
  }
  return 'Fix the address and resend.';
}
