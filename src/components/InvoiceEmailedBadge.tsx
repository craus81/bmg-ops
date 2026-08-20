'use client';

/**
 * The ✉ EMAILED / DELIVERED / BOUNCED chip for an invoice number, with the
 * full send history in its tooltip. Same rendering wherever invoices are
 * listed (Invoicing hub, Scan Log) so "was this emailed, and when?" reads
 * identically everywhere. Render nothing when there's no send on record —
 * pass showUnsent to get an explicit muted "Not emailed" instead.
 */

import { type EmailedInfo, isBadDelivery } from '@/lib/invoice-emails';

export function InvoiceEmailedBadge({ info, showUnsent = false }: { info: EmailedInfo | undefined; showUnsent?: boolean }) {
  if (!info) {
    if (!showUnsent) return null;
    return (
      <span style={{
        fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '5px',
        background: 'rgba(148,163,184,0.1)', color: 'var(--text-muted)',
      }}>
        Not emailed
      </span>
    );
  }
  const bad = isBadDelivery(info.delivery_status);
  const delivered = info.delivery_status === 'delivered';
  const label = bad
    ? `✉ ${(info.delivery_status || '').toUpperCase()}`
    : delivered
      ? `✉ DELIVERED ${new Date(info.sent_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
      : `✉ EMAILED ${new Date(info.sent_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  const historyLines = info.history
    .map(h => `${new Date(h.sent_at).toLocaleString()} → ${h.recipients.join(', ') || 'customer'}${h.delivery_status && h.delivery_status !== 'sent' ? ` (${h.delivery_status})` : ''}`)
    .join('\n');
  return (
    <span
      title={`${bad ? `Delivery failed${info.delivery_detail ? `: ${info.delivery_detail}` : ''} — resend this invoice.\n\n` : ''}Send history:\n${historyLines}`}
      style={{
        fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px',
        background: bad ? 'var(--error-bg)' : delivered ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.12)',
        color: bad ? 'var(--error)' : delivered ? '#22c55e' : '#fbbf24',
      }}
    >
      {label}
    </span>
  );
}
