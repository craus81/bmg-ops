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

/** One sentence telling the sender what to do about a failed delivery. */
export function bounceNextStep(status: string, detail: string | null | undefined): string {
  if (status === 'complained') return 'Check with the customer before sending again.';
  if (status === 'bounced' && isTemporaryBounce(detail)) {
    return 'The address is probably fine — their mail server refused it for now (often a full mailbox or a size or content filter). Resend, leaving off large attachments, and call them if it bounces again.';
  }
  return 'Fix the address and resend.';
}
