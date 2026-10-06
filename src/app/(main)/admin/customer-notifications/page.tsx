'use client';

/**
 * Customer Notifications — who has agreed to hear from us, and the place
 * the weekly customer update is sent from.
 *
 * As of 2026-09-14 NOTHING emails a customer on a schedule (owner decision
 * after a customer reported repeated automatic chasing). These switches no
 * longer gate a send; they record what the customer asked for, and the app
 * shows that to whoever is about to press Send. The Monday cron uses the
 * digest switch to decide who it offers, and "Send update" here is what
 * actually mails one — through the standard compose screen, with a preview
 * of that customer's week.
 *
 * These are the COMPANY-level settings. Since migration 306 each contact
 * can also override them for themselves from the customer portal's Email
 * preferences section, and that override wins in either direction — so a
 * company switched on here can still have one person who has opted out.
 *
 * "Portal invoices" is the one STAFF-facing column: the people alerted to
 * enter every new invoice for this customer in the customer's own AP portal
 * (Bodewell — they don't pay otherwise). See src/lib/portal-invoice-notify.ts.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { theme } from '@/lib/theme';

interface CustomerRow {
  id: string;
  company_name: string;
  email: string | null;
  notify_status_emails: boolean | null;
  weekly_digest: boolean | null;
  portal_invoice_contact_ids: string[] | null;
}

interface StaffRow {
  id: string;
  full_name: string | null;
  email: string | null;
}

export default function CustomerNotificationsPage() {
  const router = useRouter();
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [subscribedOnly, setSubscribedOnly] = useState(false);
  // The customer whose weekly update is being composed, and whether they
  // have the digest switched off (shown to the sender, never enforced).
  const [digestFor, setDigestFor] = useState<CustomerRow | null>(null);
  const [digestOptedOut, setDigestOptedOut] = useState(false);
  // Active staff, for naming and picking portal invoice contacts.
  const [staff, setStaff] = useState<StaffRow[]>([]);
  // The customer whose portal invoice contacts are being edited.
  const [portalFor, setPortalFor] = useState<CustomerRow | null>(null);
  const [portalPick, setPortalPick] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin && !hasFeature('customers')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once after auth resolves
  }, [authLoading, isAdmin]);

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: people }] = await Promise.all([
      supabase
        .from('customers')
        .select('id, company_name, email, notify_status_emails, weekly_digest, portal_invoice_contact_ids')
        .order('company_name'),
      supabase
        .from('profiles')
        .select('id, full_name, email, deactivated')
        .eq('status', 'approved')
        .order('full_name'),
    ]);
    setRows((data as CustomerRow[]) || []);
    setStaff(((people || []) as (StaffRow & { deactivated?: boolean })[]).filter(p => !p.deactivated));
    setLoading(false);
  };

  const staffName = (id: string) => {
    const p = staff.find(s => s.id === id);
    return p ? (p.full_name || p.email || 'Unnamed') : 'Former user';
  };

  const savePortalContacts = async () => {
    if (!portalFor) return;
    const ids = [...portalPick];
    setSavingId(portalFor.id);
    const { error } = await supabase.from('customers').update({ portal_invoice_contact_ids: ids }).eq('id', portalFor.id);
    setSavingId(null);
    if (error) {
      await dialog.alert('Could not save: ' + error.message);
      return;
    }
    setRows(prev => prev.map(r => r.id === portalFor.id ? { ...r, portal_invoice_contact_ids: ids } : r));
    setPortalFor(null);
  };

  const setFlag = async (row: CustomerRow, flag: 'notify_status_emails' | 'weekly_digest', value: boolean) => {
    setSavingId(row.id);
    const { error } = await supabase.from('customers').update({ [flag]: value }).eq('id', row.id);
    if (!error) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, [flag]: value } : r));
    }
    setSavingId(null);
  };

  const fetchDigestPreview = async (fields: EmailComposeFields) => {
    if (!digestFor) return { error: 'No customer selected' };
    try {
      const res = await apiFetch('/api/customers/digest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: digestFor.company_name, preview: true,
          emails: fields.emails, message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) {
        setDigestOptedOut(!!data.optedOut);
        return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      }
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const sendDigest = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!digestFor) return { ok: false };
    try {
      const res = await apiFetch('/api/customers/digest/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: digestFor.company_name,
          emails: fields.emails, bccSelf: fields.bccSelf, cc: fields.cc,
          message: fields.message || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (data.error || 'Unknown error'));
        return { ok: false };
      }
      await dialog.alert(`Weekly update sent to ${(data.dispatch?.to || []).join(', ') || 'the customer'}.`);
      return { ok: true };
    } catch {
      await dialog.alert('Network error — please try again.');
      return { ok: false };
    }
  };

  const visible = rows.filter(r => {
    if (subscribedOnly && r.notify_status_emails !== true && r.weekly_digest !== true && !(r.portal_invoice_contact_ids?.length)) return false;
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return r.company_name?.toLowerCase().includes(s) || (r.email || '').toLowerCase().includes(s);
  });

  const toggle = (row: CustomerRow, flag: 'notify_status_emails' | 'weekly_digest') => {
    const on = row[flag] === true;
    return (
      <button
        onClick={() => setFlag(row, flag, !on)}
        disabled={savingId === row.id}
        title={on ? 'Subscribed — click to unsubscribe' : 'Not subscribed — click to subscribe'}
        style={{
          padding: '3px 10px', borderRadius: '10px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
          background: on ? 'rgba(34,197,94,0.15)' : 'var(--subtle-bg)',
          border: `1px solid ${on ? 'rgba(34,197,94,0.45)' : 'var(--border)'}`,
          color: on ? '#22c55e' : 'var(--text-muted)',
        }}
      >
        {on ? 'On' : 'Off'}
      </button>
    );
  };

  if (authLoading || loading) {
    return <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>;
  }

  const subscribedCount = rows.filter(r => r.notify_status_emails === true || r.weekly_digest === true || !!r.portal_invoice_contact_ids?.length).length;

  return (
    <div style={{ maxWidth: '760px' }}>
      <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>Customer Notifications</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Nothing emails a customer on a schedule any more — every customer email is sent by a person.
        These switches record what the customer asked for: they decide who we&rsquo;re <i>prompted</i> to email,
        and anyone about to press Send is shown an opt-out. <b>Send update</b> mails this customer their
        weekly vehicle summary now, with a preview first.
        <b> Portal invoices</b> is for customers who only pay invoices entered in their own portal: the people
        picked there are alerted (email with the invoice PDF, push and in-app) every time an invoice is created for that customer.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customers…"
          style={{ flex: 1, minWidth: '200px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={subscribedOnly} onChange={e => setSubscribedOnly(e.target.checked)} />
          Subscribed only ({subscribedCount})
        </label>
      </div>

      {visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {rows.length === 0 ? 'No customers synced yet.' : 'No customers match.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 12px', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            <div style={{ flex: 1 }}>Customer</div>
            <div style={{ width: '90px', textAlign: 'center' }}>Status emails</div>
            <div style={{ width: '90px', textAlign: 'center' }}>Weekly digest</div>
            <div style={{ width: '120px', textAlign: 'center' }}>Portal invoices</div>
            <div style={{ width: '104px', textAlign: 'center' }}>Send now</div>
          </div>
          {visible.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px',
              background: 'var(--card)', border: `1px solid ${theme.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company_name}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || 'no email on file'}</div>
              </div>
              <div style={{ width: '90px', textAlign: 'center' }}>{toggle(r, 'notify_status_emails')}</div>
              <div style={{ width: '90px', textAlign: 'center' }}>{toggle(r, 'weekly_digest')}</div>
              <div style={{ width: '120px', textAlign: 'center' }}>
                <button
                  onClick={() => { setPortalPick(new Set(r.portal_invoice_contact_ids || [])); setPortalFor(r); }}
                  disabled={savingId === r.id}
                  title="Who is alerted to enter this customer's invoices in their portal"
                  style={{
                    maxWidth: '120px', padding: '3px 10px', borderRadius: '10px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    background: r.portal_invoice_contact_ids?.length ? 'rgba(245,158,11,0.15)' : 'var(--subtle-bg)',
                    border: `1px solid ${r.portal_invoice_contact_ids?.length ? 'rgba(245,158,11,0.45)' : 'var(--border)'}`,
                    color: r.portal_invoice_contact_ids?.length ? '#f59e0b' : 'var(--text-muted)',
                  }}
                >
                  {r.portal_invoice_contact_ids?.length ? r.portal_invoice_contact_ids.map(staffName).join(', ') : 'Off'}
                </button>
              </div>
              <div style={{ width: '104px', textAlign: 'center' }}>
                <button
                  onClick={() => { setDigestOptedOut(false); setDigestFor(r); }}
                  title="Preview and send this customer their weekly vehicle update"
                  style={{
                    padding: '4px 10px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                    background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.4)', color: '#60a5fa',
                  }}
                >
                  ✉ Send update
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {portalFor && (
        <div
          onClick={() => setPortalFor(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: '420px', maxHeight: 'calc(80vh / var(--ts))', display: 'flex', flexDirection: 'column', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px' }}
          >
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>Portal invoices — {portalFor.company_name}</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 10px', lineHeight: 1.5 }}>
              Everyone ticked here gets an alert right away (email with the invoice PDF, push and in-app) whenever an
              invoice is created for this customer from a graphics job, the Scan Log, a finished vehicle or a PO,
              so they can enter it in the customer&rsquo;s portal. Nobody ticked = no alert.
            </div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '12px' }}>
              {staff.map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', fontSize: '12px', color: 'var(--text-body)', cursor: 'pointer', background: portalPick.has(p.id) ? 'var(--subtle-bg)' : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={portalPick.has(p.id)}
                    onChange={e => setPortalPick(prev => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.id); else next.delete(p.id);
                      return next;
                    })}
                  />
                  <span style={{ fontWeight: 700 }}>{p.full_name || p.email || 'Unnamed'}</span>
                  {p.full_name && p.email && <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{p.email}</span>}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                onClick={() => setPortalFor(null)}
                style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, color: 'var(--text-secondary)' }}
              >
                Cancel
              </button>
              <button
                onClick={savePortalContacts}
                disabled={savingId === portalFor.id}
                style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.45)', color: '#60a5fa' }}
              >
                {savingId === portalFor.id ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {digestFor && (
        <EmailComposeModal
          title={`Weekly update — ${digestFor.company_name}`}
          customerId={digestFor.id}
          sendLabel="Send Update"
          messagePlaceholder="Personal note — shown above the vehicle list…"
          intro={(
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              The preview below is this customer&rsquo;s actual week — vehicles in the shop, what finished,
              shipped and was invoiced. Nothing sends on a schedule; this is the only way it goes out.
              {digestOptedOut && (
                <div style={{ color: '#f59e0b', marginTop: '6px' }}>
                  ⚠ This customer turned the weekly summary off. Sending is still allowed — just make sure you have a reason.
                </div>
              )}
            </div>
          )}
          fetchPreview={fetchDigestPreview}
          onSend={sendDigest}
          onClose={() => setDigestFor(null)}
        />
      )}
    </div>
  );
}
