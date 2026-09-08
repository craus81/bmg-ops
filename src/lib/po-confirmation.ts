/**
 * Automatic PO receipt confirmation (migration 256).
 *
 * Once a customer PO's lines are imported (Gmail import or PDF upload),
 * the buyer who sent it gets an email saying we have it: PO number, the
 * lines with quantities and requested delivery dates, the total, and the
 * PO PDF attached as the transaction copy (CLAUDE.md "every transaction
 * email carries a PDF copy"). Owner decision 2026-09-03: automatic, not a
 * button — nobody composes it, so it is an automated send under
 * docs/customer-email-standard.md (Reply-To falls back to
 * RESEND_REPLY_TO_EMAIL) and is logged like every other email.
 *
 * Recipient: the PO's Buyer Information email (extracted at import), else
 * the person who emailed us the PO (the From on the Gmail import), else
 * nothing — the import never fails over the confirmation, and a skipped
 * send says why.
 *
 * NEVER the customer's billing emails. That was the original fallback and
 * it mailed a PO acknowledgement to Masterack's AP department, because
 * `prospects.billing_emails` is the *invoice* list (what EmailInvoicesModal
 * saves), not the buyer. An accounts-payable mailbox is not the person who
 * placed the order, so an AP-shaped address is refused on every derived
 * path — only a human at the manual send screen can aim this email at one.
 *
 * Sent once per PO: a re-import of the same PO number does not email
 * again unless the first confirmation never went out. Staff can correct
 * the buyer and re-send from the PO page (`force`/`overrideTo`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailDetailed } from './resend';
import { deepLinks } from './deep-links';
import { r2GetBytes } from './r2';
import { MAX_ATTACHMENT_BYTES } from './email-attachments';

export type PoConfirmationResult =
  | { sent: true; to: string[]; attachments: number }
  | { sent: false; reason: string };

export interface PoConfirmationOptions {
  /** Re-send a PO that already has a confirmation on record. */
  force?: boolean;
  /**
   * Send to this address verbatim, skipping the derivation below and the
   * AP guard with it. Only for the manual send screen, where a person
   * typed the address and owns the choice.
   */
  overrideTo?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtD = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split('-');
  return y && m && d ? `${Number(m)}/${Number(d)}/${y}` : String(iso);
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Mailboxes that belong to an accounts-payable / invoicing function rather
 * than to the buyer who placed the order. A PO receipt confirmation sent
 * there is a dead end — AP can't answer a question about the order — so no
 * derived address matching this ever becomes a recipient. Only the mailbox
 * (local part) is judged, and the tests below pin both directions.
 */
// Terms distinctive enough to spot anywhere in the mailbox, because no
// person is named them — "MSRAccountsPayable", "corp_invoices".
const AP_STRONG_RE = /accounts?[._-]?payable|payables|invoices|invoicing|remittance/i;
// Terms that only read as AP when they are a whole separator-delimited
// segment, so a person is never caught: aparker@ and billings@ are people,
// ap@ and msr.billing@ are desks.
const AP_SEGMENTS = new Set([
  'ap', 'ar', 'acctspay', 'acctspayable', 'accountspayable',
  'payable', 'payables', 'invoice', 'invoices', 'invoicing',
  'billing', 'remit', 'remittance',
]);

/** true when `email`'s mailbox looks like an AP/invoicing function. */
export function isApMailbox(email: string): boolean {
  const local = String(email).split('@')[0] || '';
  if (!local) return false;
  if (AP_STRONG_RE.test(local)) return true;
  return local.toLowerCase().split(/[._+-]+/).some(seg => AP_SEGMENTS.has(seg));
}

/** Pull the address out of a raw From header ("Name <a@b.com>" or "a@b.com"). */
function addressOf(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const angled = s.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : s).trim().replace(/^["']|["']$/g, '').toLowerCase();
  return EMAIL_RE.test(candidate) ? candidate : null;
}

interface PoLine {
  part_number: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  delivery_date: string | null;
}

function confirmationHtml(po: any, lines: PoLine[], company: any, attachmentNames: string[]): string {
  const coName = company?.name || 'BMG Fleet';
  const total = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
  const td = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;';
  const tdNum = td + 'text-align:right;white-space:nowrap;';
  const th = 'padding:8px 10px;background:#f9fafb;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;text-align:left;';
  const rows = lines.map(l => `
      <tr>
        <td style="${td}">${esc(l.part_number || '—')}</td>
        <td style="${td}">${esc(l.description || '')}</td>
        <td style="${tdNum}">${esc(l.quantity ?? '')}</td>
        <td style="${tdNum}">${l.unit_price != null ? usd(Number(l.unit_price)) : '—'}</td>
        <td style="${td}white-space:nowrap;">${esc(fmtD(l.delivery_date))}</td>
      </tr>`).join('');
  const companyLines = [
    company?.address,
    [company?.city, company?.state, company?.zip].filter(Boolean).join(', '),
    company?.phone, company?.email,
  ].filter(Boolean).map((l: string) => esc(l)).join('<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:680px;margin:0 auto;padding:24px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <div style="font-size:22px;font-weight:800;color:#111827;">Purchase order received</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:18px;">PO ${esc(po.po_number)}${po.ordered_date ? ` · ordered ${esc(fmtD(po.ordered_date))}` : ''}</div>
      <div style="font-size:14px;color:#374151;line-height:1.6;margin-bottom:16px;">
        ${po.buyer_name ? `Hi ${esc(String(po.buyer_name).split(' ')[0])},<br><br>` : ''}
        Thank you — ${esc(coName)} has received purchase order <b>${esc(po.po_number)}</b>${po.customer ? ` from ${esc(po.customer)}` : ''} and it is entered in our system.
        ${po.requested_delivery_date ? ` The requested delivery date on file is <b>${esc(fmtD(po.requested_delivery_date))}</b>.` : ''}
        A PDF copy of the PO is attached for your records.
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr>
          <th style="${th}">Item</th><th style="${th}">Description</th>
          <th style="${th}text-align:right;">Qty</th><th style="${th}text-align:right;">Unit price</th><th style="${th}">Requested</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        ${total > 0 ? `<tfoot><tr>
          <td colspan="3" style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">PO total</td>
          <td style="${tdNum}font-weight:800;border-bottom:none;padding-top:12px;">${usd(total)}</td>
          <td style="border-bottom:none;"></td>
        </tr></tfoot>` : ''}
      </table>
      ${po.ship_to?.name || po.ship_to?.address ? `
      <div style="font-size:12px;color:#374151;margin-top:16px;line-height:1.5;">
        <b style="color:#111827;">Ship to</b><br>${[po.ship_to.name, po.ship_to.address, [po.ship_to.city, po.ship_to.state, po.ship_to.zip].filter(Boolean).join(', ')].filter(Boolean).map((l: string) => esc(l)).join('<br>')}
      </div>` : ''}
      ${attachmentNames.length > 0 ? `<div style="font-size:12px;color:#6b7280;margin-top:14px;"><b style="color:#374151;">Attached:</b> ${attachmentNames.map(n => esc(n)).join(', ')}</div>` : ''}
      <div style="font-size:12px;color:#6b7280;margin-top:18px;border-top:1px solid #e5e7eb;padding-top:12px;line-height:1.5;">
        Questions or changes? Reply to this email and it comes straight to us.<br>
        <b style="color:#374151;">${esc(coName)}</b>${companyLines ? `<br>${companyLines}` : ''}
      </div>
    </div>
    <div style="text-align:center;padding:14px;font-size:11px;color:#9ca3af;">Sent by ${esc(coName)}</div>
  </div>
</body>
</html>`;
}

/**
 * Send the receipt confirmation for a PO whose lines just landed. Never
 * throws — the import already succeeded, and a confirmation problem is
 * reported, not fatal. Skips when the PO already has a confirmation on
 * record, so re-imports don't re-send.
 */
export async function sendPoConfirmation(
  supabase: SupabaseClient,
  poId: string,
  opts: PoConfirmationOptions = {},
): Promise<PoConfirmationResult> {
  try {
    const { data: po, error } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, customer_netsuite_id, ordered_date, requested_delivery_date, ship_to, buyer_name, buyer_email, confirmation_sent_at')
      .eq('id', poId)
      .maybeSingle();
    if (error || !po) return { sent: false, reason: error?.message || 'PO not found' };
    if (po.confirmation_sent_at && !opts.force) return { sent: false, reason: 'already confirmed' };

    const { data: lines } = await supabase
      .from('po_line_items')
      .select('*')
      .eq('po_id', poId)
      .order('id');
    const poLines: PoLine[] = (lines || []).map((l: any) => ({
      part_number: l.part_number ?? null,
      description: l.description ?? null,
      quantity: l.quantity ?? null,
      unit_price: l.unit_price ?? null,
      delivery_date: l.delivery_date ?? l.requested_delivery_date ?? null,
    }));
    if (poLines.length === 0) return { sent: false, reason: 'no lines imported yet' };

    // Recipient. An address a person typed at the send screen wins
    // outright; otherwise derive it, and an AP mailbox is never derived —
    // the buyer placed the order, AP just pays for it.
    let to: string[] = [];
    let skipReason = 'no buyer email on the PO and no sender on the import';
    const override = addressOf(opts.overrideTo);
    if (opts.overrideTo && !override) return { sent: false, reason: 'the address given is not a valid email' };

    if (override) {
      to = [override];
    } else {
      const buyer = addressOf(po.buyer_email);
      if (buyer && !isApMailbox(buyer)) {
        to = [buyer];
      } else {
        if (buyer) skipReason = `the buyer email on the PO (${buyer}) is an accounts-payable mailbox, not the buyer`;
        // Who actually emailed us the PO. In practice that IS the buyer,
        // and it is the only other address on file that belongs to a person.
        const { data: imports } = await supabase
          .from('gmail_po_imports')
          .select('from_email, received_at, created_at')
          .eq('po_id', poId)
          .order('received_at', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(50);
        for (const row of imports || []) {
          const sender = addressOf(row.from_email);
          if (sender && !isApMailbox(sender)) { to = [sender]; break; }
        }
      }
    }
    if (to.length === 0) return { sent: false, reason: skipReason };

    // Letterhead — the same settings singleton every customer document uses.
    const { data: settings } = await supabase.from('wrap_quote_settings').select('company').eq('id', 1).maybeSingle();
    const company = settings?.company || null;

    // The PO PDF(s) on file — the transaction copy. Budget-capped; a PDF
    // that can't be read is skipped and the email still names what went.
    const { data: files } = await supabase
      .from('po_files')
      .select('file_name, storage_path, file_type')
      .eq('po_id', poId)
      .order('uploaded_at');
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    let used = 0;
    for (const f of files || []) {
      if (!/pdf/i.test(f.file_type || '') && !/\.pdf$/i.test(f.file_name || '')) continue;
      const got = await r2GetBytes('graphics-proofs', f.storage_path, MAX_ATTACHMENT_BYTES - used);
      if (!got) continue;
      used += got.bytes.byteLength;
      attachments.push({ filename: f.file_name || `PO_${po.po_number}.pdf`, content: got.bytes, contentType: 'application/pdf' });
    }

    const subject = `PO ${po.po_number} received — ${company?.name || 'BMG Fleet'}`;
    const html = confirmationHtml(po, poLines, company, attachments.map(a => a.filename));
    const { ok } = await sendEmailDetailed(
      to, subject, html, undefined,
      attachments.length > 0 ? attachments : undefined,
      undefined, undefined,
      {
        kind: 'po_confirmation',
        contextUrl: deepLinks.po(po.id),
        netsuiteCustomerId: po.customer_netsuite_id ? String(po.customer_netsuite_id) : undefined,
      },
    );
    if (!ok) return { sent: false, reason: 'email delivery service refused the send' };

    await supabase
      .from('purchase_orders')
      .update({ confirmation_sent_at: new Date().toISOString(), confirmation_sent_to: to })
      .eq('id', poId);
    return { sent: true, to, attachments: attachments.length };
  } catch (err: any) {
    console.error('[po-confirmation] failed:', err?.message || err);
    return { sent: false, reason: err?.message || 'unexpected error' };
  }
}
