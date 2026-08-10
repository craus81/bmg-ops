'use client';

/**
 * Email NetSuite invoice PDFs to a customer — the same flow as the Scans
 * admin page: recipients prefill from the customer's saved billing emails,
 * the message body is editable, PDFs can be verified before sending, and a
 * test send goes to the signed-in user. Recipients that work are merged back
 * into prospects.billing_emails for next time.
 *
 * Rendered as a standalone overlay modal so any screen that produces an
 * invoice (graphics jobs today, others later) can reuse it. Sends via
 * POST /api/netsuite/email-invoices.
 */

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

export interface EmailableInvoice {
  invoiceId?: string;
  invoiceNumber: string;
  po?: string;
}

interface InvoiceRow extends EmailableInvoice {
  include: boolean;
  verifyStatus?: 'ok' | 'error';
  verifyError?: string;
}

interface Props {
  customerName: string;
  invoices: EmailableInvoice[];
  onClose: () => void;
}

const parseEmails = (input: string): string[] =>
  input.split(/[,;\s]+/).map(e => e.trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

export default function EmailInvoicesModal({ customerName, invoices: initialInvoices, onClose }: Props) {
  const { user } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  const [invoices, setInvoices] = useState<InvoiceRow[]>(
    initialInvoices.map(inv => ({ ...inv, include: true }))
  );
  // Latest customer send per invoice number, so already-emailed invoices are
  // visible (and unchecked by default) before anyone sends a duplicate.
  const [lastSent, setLastSent] = useState<Record<string, { sent_at: string; recipients: string[]; delivery_status: string | null }>>({});

  useEffect(() => {
    const numbers = initialInvoices.map(i => i.invoiceNumber).filter(Boolean);
    if (numbers.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('invoice_emails')
        .select('invoice_number, sent_at, recipients, delivery_status')
        .in('invoice_number', numbers)
        .order('sent_at', { ascending: false });
      if (cancelled || !data || data.length === 0) return;
      const latest: Record<string, { sent_at: string; recipients: string[]; delivery_status: string | null }> = {};
      for (const row of data as any[]) {
        if (!latest[row.invoice_number]) latest[row.invoice_number] = { sent_at: row.sent_at, recipients: row.recipients || [], delivery_status: row.delivery_status || null };
      }
      setLastSent(latest);
      // A bounced/failed send doesn't count as "already emailed" — keep those
      // invoices checked so the resend is one click.
      setInvoices(prev => prev.map(i => {
        const ls = latest[i.invoiceNumber];
        if (!ls) return i;
        const bad = ['bounced', 'failed', 'complained'].includes(ls.delivery_status || '');
        return bad ? i : { ...i, include: false };
      }));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once per invoice set
  }, []);
  const [email, setEmail] = useState('');
  const [body, setBody] = useState(
    `Please find the attached invoice${initialInvoices.length !== 1 ? 's' : ''} for your recent services.`
  );
  const [verifying, setVerifying] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendingTest, setSendingTest] = useState(false);

  // Billing workflow (K3): customers.billing_workflow routes invoices —
  // po_portal customers get a "submit in the portal, don't email" banner and
  // a send guard; email_ap/no notes surface too. Every call site passes only
  // a display name, so the lookup happens here (same name-match the
  // prospects prefill below uses) and all five screens get it for free.
  const [billing, setBilling] = useState<{ workflow: string | null; portal: string | null; notes: string | null } | null>(null);
  const [portalOverride, setPortalOverride] = useState(false);

  // Prefill the recipient field with the customer's saved billing emails,
  // falling back to the customer profile's AP / billing-contact emails
  // (migration 080 — finally read by the invoice path).
  useEffect(() => {
    if (!customerName) return;
    let cancelled = false;
    (async () => {
      const [prospectRes, customerRes] = await Promise.all([
        supabase
          .from('prospects')
          .select('billing_emails')
          .ilike('company_name', customerName)
          .limit(1)
          .maybeSingle(),
        supabase
          .from('customers')
          .select('billing_workflow, billing_portal, billing_notes, ap_email, billing_contact_email')
          .ilike('company_name', customerName)
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      const cust = customerRes.data as any;
      if (cust) {
        setBilling({ workflow: cust.billing_workflow || null, portal: cust.billing_portal || null, notes: cust.billing_notes || null });
      }
      const saved: string[] = (prospectRes.data as any)?.billing_emails || [];
      const profileEmails = [cust?.ap_email, cust?.billing_contact_email]
        .filter((e: any): e is string => !!e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
      const prefill = saved.length > 0 ? saved : [...new Set(profileEmails)];
      if (prefill.length > 0) {
        setEmail(prev => prev || prefill.join(', '));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once per customer
  }, [customerName]);

  // Merge successful recipients back into the matching prospect record.
  const saveBillingEmails = async (newEmails: string[]) => {
    if (!customerName || newEmails.length === 0) return;
    const { data: prospect } = await supabase
      .from('prospects')
      .select('id, billing_emails')
      .ilike('company_name', customerName)
      .limit(1)
      .maybeSingle();
    if (!prospect) return;
    const existing: string[] = (prospect as any).billing_emails || [];
    const merged = Array.from(new Set([...existing, ...newEmails].map(e => e.toLowerCase())));
    await supabase.from('prospects').update({ billing_emails: merged }).eq('id', (prospect as any).id);
  };

  const applyResults = (results: { invoiceNumber: string; invoiceId?: string; status: 'ok' | 'error'; error?: string }[]) => {
    const statusByNumber: Record<string, { invoiceId?: string; status: 'ok' | 'error'; error?: string }> = {};
    for (const r of results || []) statusByNumber[r.invoiceNumber] = { invoiceId: r.invoiceId, status: r.status, error: r.error };
    setInvoices(prev => prev.map(i => {
      if (!i.include) return { ...i, verifyStatus: undefined, verifyError: undefined };
      const s = statusByNumber[i.invoiceNumber];
      return s ? { ...i, invoiceId: i.invoiceId || s.invoiceId, verifyStatus: s.status, verifyError: s.error } : i;
    }));
  };

  // Open an invoice's PDF in a new tab so it can be eyeballed before sending.
  // The window opens synchronously (popup blockers require a direct user
  // gesture) and is pointed at the PDF once it arrives from NetSuite.
  const [viewingIdx, setViewingIdx] = useState<number | null>(null);
  const viewPdf = async (idx: number) => {
    const inv = invoices[idx];
    if (!inv || viewingIdx !== null) return;
    setViewingIdx(idx);
    const w = window.open('about:blank', '_blank');
    try {
      let invoiceId = inv.invoiceId;
      if (!invoiceId) {
        // Resolve the id from the invoice number via the verify dry run.
        const res = await fetch('/api/netsuite/email-invoices', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoices: [{ invoiceNumber: inv.invoiceNumber }],
            customerName,
            customerEmail: [],
            dryRun: true,
          }),
        });
        const data = await res.json();
        invoiceId = data.results?.[0]?.invoiceId;
        if (invoiceId) {
          setInvoices(prev => prev.map((r, i) => i === idx ? { ...r, invoiceId } : r));
        }
      }
      if (!invoiceId) throw new Error(`Invoice #${inv.invoiceNumber} not found in NetSuite`);

      const res = await fetch(`/api/netsuite/pdf?type=invoice&id=${encodeURIComponent(invoiceId)}`);
      const data = await res.json();
      if (!data.success || !data.pdfBase64) throw new Error(data.error || 'PDF fetch failed');
      const bytes = Uint8Array.from(atob(data.pdfBase64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      if (w) w.location.href = url;
      else window.open(url, '_blank');
    } catch (e: any) {
      w?.close();
      await dialog.alert(`Could not open the PDF: ${e.message}`);
    }
    setViewingIdx(null);
  };

  const includedInvoices = invoices.filter(i => i.include);

  const verifyInvoices = async () => {
    if (includedInvoices.length === 0) return;
    setVerifying(true);
    try {
      const res = await fetch('/api/netsuite/email-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoices: includedInvoices.map(({ include, verifyStatus, verifyError, ...rest }) => rest),
          customerName,
          customerEmail: [],
          dryRun: true,
        }),
      });
      const data = await res.json();
      applyResults(data.results || []);
    } catch (e: any) {
      await dialog.alert(`Verification failed: ${e.message}`);
    }
    setVerifying(false);
  };

  const sendInvoices = async (overrideEmail?: string) => {
    const isTest = !!overrideEmail;
    const recipients = isTest ? [overrideEmail!] : parseEmails(email);
    if (recipients.length === 0) {
      await dialog.alert('Please enter at least one valid email address');
      return;
    }
    if (includedInvoices.length === 0) {
      await dialog.alert('Please select at least one invoice to send');
      return;
    }
    if (isTest) setSendingTest(true); else setSending(true);
    try {
      const res = await fetch('/api/netsuite/email-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoices: includedInvoices.map(({ include, verifyStatus, verifyError, ...rest }) => rest),
          customerName,
          customerEmail: recipients,
          customBody: body,
          testSend: isTest,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (Array.isArray(data.results)) applyResults(data.results);
        await dialog.alert(`${data.error || 'Email failed'}`);
      } else if (isTest) {
        await dialog.alert(`Test email sent to ${recipients[0]} — check your inbox to preview`);
      } else {
        await saveBillingEmails(recipients);
        await dialog.alert(`Sent ${data.sent} invoice${data.sent !== 1 ? 's' : ''} to ${recipients.join(', ')}`);
        onClose();
      }
    } catch (e: any) {
      await dialog.alert(`Email failed: ${e.message}`);
    }
    if (isTest) setSendingTest(false); else setSending(false);
  };

  const includedCount = includedInvoices.length;
  const allChecked = includedCount === invoices.length;
  const toggleAll = () => setInvoices(prev => prev.map(i => ({ ...i, include: !allChecked })));
  const toggleOne = (idx: number) => setInvoices(prev => prev.map((i, j) => j === idx ? { ...i, include: !i.include } : i));

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1100, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '560px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
        padding: '14px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Email {includedCount} of {invoices.length} Invoice{invoices.length !== 1 ? 's' : ''}{customerName ? ` to ${customerName}` : ''}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer' }}
          >✕</button>
        </div>

        {/* Billing workflow (K3) — portal customers shouldn't be emailed */}
        {billing?.workflow === 'po_portal' && (
          <div style={{ marginBottom: '10px', fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '8px 10px' }}>
            <div style={{ fontWeight: 700 }}>
              ⚠ {customerName} bills via the {billing.portal || 'customer'} portal — invoices are submitted there, not emailed.
            </div>
            {billing.notes && <div style={{ marginTop: '3px', color: 'var(--text-muted)' }}>{billing.notes}</div>}
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', cursor: 'pointer', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={portalOverride} onChange={e => setPortalOverride(e.target.checked)} style={{ accentColor: '#fbbf24' }} />
              Email anyway (one-off exception)
            </label>
          </div>
        )}
        {billing?.workflow !== 'po_portal' && billing?.notes && (
          <div style={{ marginBottom: '10px', fontSize: '11px', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: '8px', padding: '8px 10px' }}>
            Billing notes: {billing.notes}
          </div>
        )}

        {/* Email preview */}
        <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', marginBottom: '10px', fontSize: '11px' }}>
          <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Subject: {includedCount === 1 ? `Invoice #${includedInvoices[0]?.invoiceNumber} from BMG Fleet` : `${includedCount} Invoices from BMG Fleet`}
          </div>
          <div style={{ color: 'var(--text-muted)', marginBottom: '3px', fontSize: '10px', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px' }}>Message Body</div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical', marginBottom: '8px', lineHeight: 1.5, boxSizing: 'border-box' }}
            placeholder="Write a note for the customer..."
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ color: 'var(--text-muted)' }}>Invoices ({includedCount} selected):</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                onClick={verifyInvoices}
                disabled={verifying || includedCount === 0}
                title="Checks that each invoice's PDF can be generated in NetSuite — click a row's 'view' to open one"
                style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', cursor: verifying || includedCount === 0 ? 'not-allowed' : 'pointer', opacity: verifying || includedCount === 0 ? 0.5 : 1 }}
              >
                {verifying ? 'Verifying...' : 'Verify PDFs'}
              </button>
              {invoices.length > 1 && (
                <button
                  onClick={toggleAll}
                  style={{ padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer' }}
                >
                  {allChecked ? 'Uncheck All' : 'Check All'}
                </button>
              )}
            </div>
          </div>
          <div style={{ maxHeight: '260px', overflowY: 'auto', padding: '4px 0' }}>
            {invoices.map((inv, i) => {
              const statusColor = inv.verifyStatus === 'ok' ? '#22c55e' : inv.verifyStatus === 'error' ? '#ef4444' : 'var(--text-muted)';
              const statusIcon = inv.verifyStatus === 'ok' ? '✓' : inv.verifyStatus === 'error' ? '✕' : '';
              return (
                <label key={i} title={inv.verifyError || ''} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 6px', borderRadius: '4px', cursor: 'pointer', color: inv.include ? 'var(--text-secondary)' : 'var(--text-muted)', opacity: inv.include ? 1 : 0.55 }}>
                  <input
                    type="checkbox"
                    checked={inv.include}
                    onChange={() => toggleOne(i)}
                    style={{ cursor: 'pointer', accentColor: '#22c55e' }}
                  />
                  <span style={{ flex: 1 }}>#{inv.invoiceNumber}{inv.po ? ` (PO #${inv.po})` : ''}</span>
                  {lastSent[inv.invoiceNumber] && (() => {
                    const ls = lastSent[inv.invoiceNumber];
                    const bad = ['bounced', 'failed', 'complained'].includes(ls.delivery_status || '');
                    return (
                      <span
                        title={`Emailed ${new Date(ls.sent_at).toLocaleString()} to ${ls.recipients.join(', ') || 'customer'}${bad ? ` — ${ls.delivery_status}, did not deliver` : ls.delivery_status === 'delivered' ? ' — delivered' : ''}`}
                        style={{ fontSize: '10px', fontWeight: 700, color: bad ? 'var(--error)' : ls.delivery_status === 'delivered' ? '#22c55e' : '#fbbf24', flexShrink: 0 }}
                      >
                        {bad ? `✉ ${(ls.delivery_status || '').toUpperCase()}` : `✉ Sent ${new Date(ls.sent_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}`}
                      </span>
                    );
                  })()}
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); viewPdf(i); }}
                    disabled={viewingIdx !== null}
                    title="Open this invoice's PDF in a new tab"
                    style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: viewingIdx !== null ? 'wait' : 'pointer', padding: '0 4px', flexShrink: 0 }}
                  >
                    {viewingIdx === i ? 'opening…' : 'view'}
                  </button>
                  {statusIcon && (
                    <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, minWidth: '14px', textAlign: 'right' }}>
                      {statusIcon}
                    </span>
                  )}
                  {inv.verifyStatus === 'error' && inv.verifyError && (
                    <span style={{ fontSize: '10px', color: '#ef4444', fontStyle: 'italic', flexShrink: 0 }}>
                      {inv.verifyError.length > 40 ? inv.verifyError.substring(0, 40) + '...' : inv.verifyError}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* Customer email + send buttons */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Customer email(s) — separate multiple with commas"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ flex: 1, minWidth: '180px', padding: '8px 10px', borderRadius: '6px', fontSize: '12px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}
          />
          {(() => {
            const portalBlocked = billing?.workflow === 'po_portal' && !portalOverride;
            const disabled = sending || sendingTest || !email || includedCount === 0 || portalBlocked;
            return (
              <button
                onClick={() => sendInvoices()}
                disabled={disabled}
                title={portalBlocked ? `This customer bills via the ${billing?.portal || 'customer'} portal — check "Email anyway" to override` : undefined}
                style={{ padding: '8px 14px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: disabled ? 'not-allowed' : 'pointer', opacity: (!email || includedCount === 0 || portalBlocked) ? 0.5 : 1, whiteSpace: 'nowrap' }}
              >
                {sending ? 'Sending...' : `Send ${includedCount} to Customer`}
              </button>
            );
          })()}
        </div>

        {/* Test send */}
        {user?.email && (
          <div style={{ marginTop: '8px' }}>
            <button
              onClick={() => sendInvoices(user.email!)}
              disabled={sendingTest || sending}
              style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)', color: '#fbbf24', cursor: sendingTest || sending ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}
            >
              {sendingTest ? 'Sending test...' : `Send Test to ${user.email}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
