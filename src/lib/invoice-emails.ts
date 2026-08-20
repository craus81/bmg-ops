/**
 * Shared "has this invoice been emailed?" lookup over the invoice_emails
 * log (written by /api/netsuite/email-invoices, delivery-status updated by
 * the Resend webhook). Used by the Invoicing hub, the Scan Log, and the
 * email modal so every surface shows the same emailed/delivered/bounced
 * state for an invoice number.
 */

export interface EmailedInfo {
  sent_at: string;
  recipients: string[];
  delivery_status: string | null;
  delivery_detail: string | null;
  history: { sent_at: string; recipients: string[]; delivery_status: string | null }[];
}

/** Delivery statuses that mean the email did NOT reach the customer. */
export const isBadDelivery = (status: string | null | undefined) =>
  ['bounced', 'failed', 'complained'].includes(status || '');

/**
 * Latest customer email per invoice number, with the full send history.
 * Queries in chunks of 200 numbers so the .in() list stays bounded.
 */
export async function fetchEmailedByNumber(
  supabase: any,
  numbers: string[],
): Promise<Record<string, EmailedInfo>> {
  const latest: Record<string, EmailedInfo> = {};
  const unique = [...new Set(numbers.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 200) {
    const { data } = await supabase
      .from('invoice_emails')
      .select('invoice_number, sent_at, recipients, delivery_status, delivery_detail')
      .in('invoice_number', unique.slice(i, i + 200))
      .order('sent_at', { ascending: false });
    for (const row of (data || []) as any[]) {
      if (!latest[row.invoice_number]) {
        latest[row.invoice_number] = {
          sent_at: row.sent_at,
          recipients: row.recipients || [],
          delivery_status: row.delivery_status || null,
          delivery_detail: row.delivery_detail || null,
          history: [],
        };
      }
      latest[row.invoice_number].history.push({
        sent_at: row.sent_at,
        recipients: row.recipients || [],
        delivery_status: row.delivery_status || null,
      });
    }
  }
  return latest;
}
