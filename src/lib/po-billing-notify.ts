/**
 * "A PO's billing needs attention" alerts for super admins.
 *
 * The invoiced-quantity sweep (po-invoice-verify) flags POs whose linked
 * NetSuite invoices bill more than the PO ordered, or parts the PO never
 * had. That verdict used to be only a badge on the PO page — someone had to
 * go look, and an over-billed PO could sit unnoticed. Money-out problems
 * shouldn't wait to be stumbled on, so the sweep fans out an alert the
 * moment a PO FLIPS to 'attention'; while it stays flagged, later sweeps
 * stay silent.
 */

import { notifyMany, getSuperAdminIds } from '@/lib/notify';

export const PO_BILLING_ATTENTION_NOTIFICATION_TYPE = 'po_billing_attention';

export interface FlaggedPoAlert {
  poId: string;
  poNumber: string;
  problems: string[];
}

/** Per-PO wording. Pure so it's unit-testable. */
export function buildPoBillingAttentionNotification(po: FlaggedPoAlert): { title: string; body: string } {
  const shown = po.problems.slice(0, 3);
  const more = po.problems.length - shown.length;
  return {
    title: `Billing needs attention on PO #${po.poNumber}`,
    body: shown.join(' · ') + (more > 0 ? ` · +${more} more` : ''),
  };
}

/** One digest instead of a notification storm when a sweep flags many POs at once. */
export function buildPoBillingAttentionDigest(pos: FlaggedPoAlert[]): { title: string; body: string } {
  const numbers = pos.map(p => `#${p.poNumber}`);
  const shown = numbers.slice(0, 8);
  const more = numbers.length - shown.length;
  return {
    title: `Billing needs attention on ${pos.length} POs`,
    body: `Invoices no longer match what these POs ordered: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Review them on the POs page.`,
  };
}

const DIGEST_THRESHOLD = 5;

/**
 * Fan newly-flagged POs out to the super admins. Never throws: a failed
 * notification must not fail the sweep (or the invoice flow that ran it).
 * Returns the number of notifications sent per recipient.
 */
export async function notifyPoBillingAttention(pos: FlaggedPoAlert[]): Promise<number> {
  if (pos.length === 0) return 0;
  try {
    const recipients = await getSuperAdminIds();
    if (recipients.length === 0) return 0;

    // A backlog-clearing sweep can flag a pile of POs in one run — collapse
    // those into a single digest so the bell doesn't take 30 pings at once.
    if (pos.length > DIGEST_THRESHOLD) {
      const { title, body } = buildPoBillingAttentionDigest(pos);
      await notifyMany(recipients, {
        type: PO_BILLING_ATTENTION_NOTIFICATION_TYPE,
        title,
        body,
        url: '/admin/pos',
        // Money-out alert: skip the per-type preference gate the same way the
        // PO-imported alert does, so it can't be silenced by accident.
        channels: ['in_app', 'email', 'push'],
        forceChannels: true,
      });
      return 1;
    }

    for (const po of pos) {
      const { title, body } = buildPoBillingAttentionNotification(po);
      await notifyMany(recipients, {
        type: PO_BILLING_ATTENTION_NOTIFICATION_TYPE,
        title,
        body,
        url: `/admin/pos/${po.poId}`,
        channels: ['in_app', 'email', 'push'],
        forceChannels: true,
      });
    }
    return pos.length;
  } catch (err) {
    console.warn('notifyPoBillingAttention failed:', err);
    return 0;
  }
}
