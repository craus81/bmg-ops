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
import { loadBccSelfPref, saveBccSelfPref } from '@/components/EmailComposeModal';
import { useDialog } from '@/components/DialogProvider';
import { closeOnEscape } from '@/lib/modal-escape';
import { openPdfBytes } from '@/lib/native-files';
import { invoiceRecipients, type RecipientSuggestion } from '@/lib/invoice-recipients';

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
  /** The customer's NetSuite id, when the screen has it: finds the customer even when names differ ("Hosemate" vs "Hosemate, LLC"). */
  customerNetsuiteId?: string | null;
  invoices: EmailableInvoice[];
  onClose: () => void;
}

const parseEmails = (input: string): string[] =>
  input.split(/[,;\s]+/).map(e => e.trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

export default function EmailInvoicesModal({ customerName, customerNetsuiteId, invoices: initialInvoices, onClose }: Props) {
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
  // Customer-email compose standard: one click copies the real send to the
  // signed-in sender's inbox.
  const [bccSelf, setBccSelf] = useState(loadBccSelfPref);

  // Billing workflow (K3): customers.billing_workflow routes invoices —
  // po_portal customers get a "submit in the portal, don't email" banner and
  // a send guard; email_ap/no notes surface too. Every call site passes only
  // a display name, so the lookup happens here (same name-match the
  // prospects prefill below uses) and all five screens get it for free.
  const [billing, setBilling] = useState<{ workflow: string | null; portal: string | null; notes: string | null } | null>(null);
  const [portalOverride, setPortalOverride] = useState(false);

  // Who this can go to (src/lib/invoice-recipients.ts): the customer's saved
  // billing emails and AP/billing contact (migration 080), its contacts (the
  // same list the estimate email offers), and whoever got its earlier
  // invoices. The best of them prefill To; all of them are chips to tap.
  // The customer is found by NetSuite id when the screen passes one, else by
  // name — exact first, then "starts with", so "Hosemate" finds "Hosemate, LLC".
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>([]);
  useEffect(() => {
    if (!customerName && !customerNetsuiteId) return;
    let cancelled = false;
    (async () => {
      const custCols = 'id, netsuite_id, billing_workflow, billing_portal, billing_notes, ap_email, billing_contact_email';
      const findCustomer = async () => {
        if (customerNetsuiteId) {
          const { data } = await supabase.from('customers').select(custCols).eq('netsuite_id', customerNetsuiteId).limit(1).maybeSingle();
          if (data) return data as any;
        }
        if (!customerName) return null;
        const exact = await supabase.from('customers').select(custCols).ilike('company_name', customerName).limit(1).maybeSingle();
        if (exact.data) return exact.data as any;
        const like = await supabase.from('customers').select(custCols)
          .ilike('company_name', `${customerName.replace(/[%_]/g, '')}%`).order('company_name').limit(1).maybeSingle();
        return (like.data as any) || null;
      };
      const [cust, recentRes] = await Promise.all([
        findCustomer(),
        customerName
          ? supabase.from('invoice_emails').select('recipients').ilike('customer_name', customerName).order('sent_at', { ascending: false }).limit(20)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      if (cancelled) return;
      if (cust) {
        setBilling({ workflow: cust.billing_workflow || null, portal: cust.billing_portal || null, notes: cust.billing_notes || null });
      }
      const nsId = customerNetsuiteId || cust?.netsuite_id || null;
      const prospectQuery = supabase.from('prospects').select('billing_emails');
      const [prospectRes, contactsRes] = await Promise.all([
        (nsId ? prospectQuery.eq('netsuite_id', nsId) : prospectQuery.ilike('company_name', customerName)).limit(1).maybeSingle(),
        cust?.id
          ? fetch(`/api/external-contacts?customerId=${encodeURIComponent(cust.id)}`).then(r => (r.ok ? r.json() : {})).catch(() => ({}))
          : Promise.resolve({}),
      ]);
      if (cancelled) return;
      const { prefill, suggestions: found } = invoiceRecipients({
        billingEmails: (prospectRes.data as any)?.billing_emails || [],
        apEmail: cust?.ap_email,
        billingContactEmail: cust?.billing_contact_email,
        contacts: Array.isArray((contactsRes as any).contacts) ? (contactsRes as any).contacts : [],
        recent: ((recentRes.data as any[]) || []).flatMap(r => r.recipients || []),
      });
      setSuggestions(found);
      if (prefill.length > 0) setEmail(prev => prev || prefill.join(', '));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once per customer
  }, [customerName, customerNetsuiteId]);

  const inTo = new Set(parseEmails(email).map(e => e.toLowerCase()));
  const addRecipient = (address: string) => {
    if (inTo.has(address)) return;
    setEmail(prev => (prev.trim() ? `${prev.trim().replace(/[,;\s]+$/, '')}, ${address}` : address));
  };

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
      openPdfBytes(w, bytes, data.filename || `Invoice_${inv.invoiceNumber}.pdf`);
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
          bccSelf: !isTest && bccSelf,
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
    <div ref={closeOnEscape(onClose)} style={{
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
            placeholder="Customer email(s) — type, or tap one below"
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

        {/* Tap to add: everyone FleetSuite knows for this customer. */}
        {suggestions.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Tap to add</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {suggestions.map(sg => {
                const added = inTo.has(sg.email);
                return (
                  <button
                    key={sg.email}
                    onClick={() => addRecipient(sg.email)}
                    disabled={added}
                    title={added ? 'Already on the To line' : `Add ${sg.email}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '6px 10px', minHeight: '32px', borderRadius: '999px',
                      fontSize: '11px', fontWeight: 600, cursor: added ? 'default' : 'pointer',
                      background: added ? 'rgba(34,197,94,0.1)' : 'rgba(96,165,250,0.08)',
                      border: `1px solid ${added ? 'rgba(34,197,94,0.3)' : 'rgba(96,165,250,0.3)'}`,
                      color: added ? '#22c55e' : 'var(--text-secondary)',
                    }}
                  >
                    <span>{added ? '✓' : '+'}</span>
                    <span>{sg.email}</span>
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>{sg.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Bcc me + test send */}
        {user?.email && (
          <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={bccSelf}
                onChange={e => { setBccSelf(e.target.checked); saveBccSelfPref(e.target.checked); }}
                style={{ accentColor: '#3b82f6' }}
              />
              Bcc me a copy ({user.email})
            </label>
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
