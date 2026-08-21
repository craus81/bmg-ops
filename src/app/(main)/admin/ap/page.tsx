'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage, storageDownloadUrl } from '@/lib/storage';
import EditVendorInvoiceModal from '@/components/EditVendorInvoiceModal';

interface ApInvoice {
  id: string;
  status: 'recorded' | 'submitted' | 'approved' | 'rejected' | 'billed' | 'paid';
  vendor_name: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  location_id: string | null;
  location_name: string | null;
  file_name: string | null;
  storage_path: string | null;
  notes: string | null;
  netsuite_bill_id: string | null;
  created_at: string;
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  billed_by: string | null;
  billed_at: string | null;
  paid_by: string | null;
  paid_at: string | null;
  company: { id: string; name: string; netsuite_vendor_id: string | null } | null;
  lines: { id: string; vin: string; part_number: string | null; amount: number | null }[];
}

type ApTab = 'submitted' | 'approved' | 'billed' | 'paid' | 'rejected' | 'recorded';

const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'];

// Best-guess NetSuite bill location from the invoice's work location name.
const guessBillLocation = (locationName: string | null): string => {
  const n = (locationName || '').toLowerCase();
  if (n.includes('wentzville')) return 'Wentzville';
  if (n.includes('kansas')) return 'Kansas City';
  if (n.includes('social')) return 'Social Circle';
  return "O'Fallon";
};

const STATUS_CHIP: Record<ApInvoice['status'], { label: string; color: string; bg: string }> = {
  recorded: { label: 'Recorded', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
  submitted: { label: 'Awaiting Approval', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  approved: { label: 'Approved', color: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  rejected: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  billed: { label: 'Billed', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  paid: { label: 'Paid', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
};

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

const daysSince = (d: string | null): number | null =>
  d ? Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000) : null;

// Aging: how long an invoice has been waiting since submission, unpaid.
// The number an installer would quote when they call asking about a check.
const UNPAID_STATUSES: ApInvoice['status'][] = ['submitted', 'approved', 'billed'];
const invoiceAge = (inv: ApInvoice): number | null =>
  UNPAID_STATUSES.includes(inv.status) ? daysSince(inv.submitted_at || inv.created_at) : null;
const ageColor = (days: number) => days >= 14 ? '#ef4444' : days >= 7 ? '#fbbf24' : 'var(--text-muted)';

export default function ApQueuePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, hasRole, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();
  const canAct = isAdmin || hasRole('finance');

  const [invoices, setInvoices] = useState<ApInvoice[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<ApTab>('submitted');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [billLocation, setBillLocation] = useState<Record<string, string>>({});
  // Deep link (e.g. from a CNI company page): focus one invoice — switch to
  // its status tab, then scroll to + briefly highlight its card.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const focusedDeepLink = useRef<string | null>(null);
  // The invoice currently open in the header editor (fix vendor link, dates,
  // amount, etc.) — null when the editor is closed.
  const [editing, setEditing] = useState<ApInvoice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/vendor-invoices');
      const data = await res.json();
      if (res.ok) {
        const list = (data.invoices || []) as ApInvoice[];
        setInvoices(list);
        const actorIds = [...new Set(list.flatMap(i => [i.created_by, i.submitted_by, i.approved_by, i.rejected_by, i.billed_by, i.paid_by]).filter(Boolean))] as string[];
        if (actorIds.length > 0) {
          const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', actorIds);
          const map: Record<string, string> = {};
          for (const p of profiles || []) map[p.id] = p.full_name;
          setNames(map);
        }
      }
    } catch { /* surfaced via empty list */ }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!canAct) { router.push('/home'); return; }
    load();
  }, [authLoading, canAct, router, load]);

  // Once invoices are loaded, honor ?invoice=<id>: jump to the right tab and
  // spotlight the card. One-shot per id so acting on it (which reloads)
  // doesn't yank the tab back, while a second invoice's notification clicked
  // from the bell (same-route push, no remount) still focuses.
  useEffect(() => {
    if (loading) return;
    const id = searchParams.get('invoice');
    if (!id || focusedDeepLink.current === id) return;
    const focus = (target: ApInvoice) => {
      focusedDeepLink.current = id;
      setTab(target.status);
      setHighlightId(id);
      setTimeout(() => document.getElementById(`ap-invoice-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
      setTimeout(() => setHighlightId(null), 2600);
    };
    const target = invoices.find(i => i.id === id);
    if (target) { focus(target); return; }
    // Outside the newest-200 window (e.g. an old bill finally marked paid by
    // the NetSuite sweep) — fetch the one invoice and merge it in.
    (async () => {
      try {
        const res = await fetch(`/api/vendor-invoices?id=${id}`);
        const data = await res.json();
        const fetched = (data.invoices || [])[0] as ApInvoice | undefined;
        if (!res.ok || !fetched) return;
        setInvoices(prev => prev.some(i => i.id === fetched.id) ? prev : [fetched, ...prev]);
        focus(fetched);
      } catch { /* deep link degrades to the plain queue */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per deep-linked id
  }, [loading, searchParams]);

  const act = async (invoiceId: string, payload: Record<string, unknown>, confirmMsg?: string) => {
    if (confirmMsg && !(await dialog.confirm(confirmMsg))) return;
    setBusy(invoiceId);
    try {
      const res = await fetch('/api/vendor-invoices/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: invoiceId, ...payload }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) await dialog.alert(data.error || 'Action failed');
      else await load();
    } catch (e: any) {
      await dialog.alert(e.message || 'Action failed');
    }
    setBusy(null);
  };

  const reject = async (inv: ApInvoice) => {
    const reason = await dialog.prompt(`Why is the ${inv.vendor_name} invoice being rejected? The submitter sees this.`);
    if (!reason?.trim()) return;
    await act(inv.id, { action: 'reject', reason: reason.trim() });
  };

  const recordBill = async (inv: ApInvoice) => {
    const billId = await dialog.prompt('NetSuite bill number (or internal id) that was created manually:');
    if (!billId?.trim()) return;
    await act(inv.id, { action: 'record_bill', netsuiteBillId: billId.trim() });
  };

  // On-demand run of the NetSuite payment sweep (the cron does the same
  // every 2 hours): flips billed invoices whose bill is Paid In Full.
  const [syncingPaid, setSyncingPaid] = useState(false);
  const checkNetsuitePaid = async () => {
    setSyncingPaid(true);
    try {
      const res = await fetch('/api/vendor-invoices/sync-paid', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        await dialog.alert(data.error || 'NetSuite payment check failed');
      } else {
        if (data.paid > 0) await load();
        await dialog.alert(
          data.checked === 0
            ? 'No billed invoices with a NetSuite bill to check.'
            : `Checked ${data.checked} bill${data.checked !== 1 ? 's' : ''} in NetSuite — ${data.paid > 0 ? `${data.paid} now paid` : 'none paid yet'}.${(data.errors || []).length > 0 ? `\n\nErrors: ${data.errors.join('; ')}` : ''}`,
        );
      }
    } catch (e: any) {
      await dialog.alert(e.message || 'NetSuite payment check failed');
    }
    setSyncingPaid(false);
  };

  const byStatus = (s: ApTab) => invoices.filter(i => i.status === s);
  const tabDefs: { id: ApTab; label: string }[] = [
    { id: 'submitted', label: `Awaiting Approval (${byStatus('submitted').length})` },
    { id: 'approved', label: `Ready to Bill (${byStatus('approved').length})` },
    { id: 'billed', label: `Awaiting Payment (${byStatus('billed').length})` },
    { id: 'paid', label: 'Paid' },
    { id: 'rejected', label: `Rejected (${byStatus('rejected').length})` },
    { id: 'recorded', label: `Not Submitted (${byStatus('recorded').length})` },
  ];
  const visible = byStatus(tab);

  const stamp = (who: string | null, when: string | null) =>
    who || when ? `${names[who || ''] || '—'} · ${when ? new Date(when).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}` : null;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Payments — CNI Vendor Invoices</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Approve installer invoices, create the NetSuite vendor bill in one click, and track through paid. Invoices arrive from Scan Log → Vendor Invoices or straight from installers via their portal.
        </div>
      </div>

      {/* Aging strip: what's owed and how long the oldest has been waiting */}
      {(() => {
        const unpaid = invoices.filter(i => UNPAID_STATUSES.includes(i.status));
        if (unpaid.length === 0) return null;
        const total = unpaid.reduce((s, i) => s + (i.total_amount != null
          ? Number(i.total_amount)
          : i.lines.reduce((ls, l) => ls + (l.amount != null ? Number(l.amount) : 0), 0)), 0);
        const oldest = Math.max(...unpaid.map(i => invoiceAge(i) ?? 0));
        const stale = unpaid.filter(i => (invoiceAge(i) ?? 0) >= 7).length;
        return (
          <div style={{
            display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'baseline',
            padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
            background: 'var(--card)', border: `1px solid ${oldest >= 14 ? 'rgba(239,68,68,0.35)' : oldest >= 7 ? 'rgba(251,191,36,0.35)' : 'var(--border)'}`,
            fontSize: '12px', color: 'var(--text-muted)',
          }}>
            <span><strong style={{ color: 'var(--text-primary)' }}>{unpaid.length}</strong> unpaid · <strong style={{ color: 'var(--text-primary)' }}>{fmtMoney(total)}</strong> owed</span>
            <span>oldest waiting <strong style={{ color: ageColor(oldest) }}>{oldest} day{oldest !== 1 ? 's' : ''}</strong></span>
            {stale > 0 && <span style={{ color: '#fbbf24', fontWeight: 700 }}>{stale} over a week old</span>}
          </div>
        );
      })()}

      <div style={{ display: 'flex', gap: '4px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {tabDefs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? 'var(--tab-active-color)' : 'var(--text-muted)', cursor: 'pointer',
          }}>{t.label}</button>
        ))}
      </div>

      {tab === 'billed' && !loading && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
          <button onClick={checkNetsuitePaid} disabled={syncingPaid} title="Ask NetSuite which of these bills are paid in full — runs automatically every 2 hours"
            style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer', opacity: syncingPaid ? 0.6 : 1 }}>
            {syncingPaid ? 'Checking NetSuite…' : '⟳ Check NetSuite for payments'}
          </button>
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {tab === 'submitted' ? 'Nothing awaiting approval — all caught up!' : `No ${tabDefs.find(t => t.id === tab)?.label.replace(/ \(\d+\)/, '').toLowerCase()} invoices`}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(inv => {
          const chip = STATUS_CHIP[inv.status];
          const amount = inv.total_amount != null
            ? Number(inv.total_amount)
            : inv.lines.reduce((s, l) => s + (l.amount != null ? Number(l.amount) : 0), 0);
          const vendorLinked = !!inv.company?.netsuite_vendor_id;
          const loc = billLocation[inv.id] || guessBillLocation(inv.location_name);
          const isBusy = busy === inv.id;
          const highlighted = highlightId === inv.id;
          return (
            <div key={inv.id} id={`ap-invoice-${inv.id}`} style={{ background: 'var(--card)', border: `1px solid ${highlighted ? 'var(--orange)' : inv.status === 'submitted' ? chip.color + '55' : 'var(--border)'}`, borderRadius: '12px', padding: '14px', boxShadow: highlighted ? '0 0 0 2px var(--orange)' : undefined, transition: 'box-shadow 0.3s, border-color 0.3s' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '220px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {inv.vendor_name}{inv.invoice_number ? ` · #${inv.invoice_number}` : ''}
                    </span>
                    <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: chip.bg, color: chip.color }}>{chip.label}</span>
                    {(() => {
                      const age = invoiceAge(inv);
                      if (age == null || age < 1) return null;
                      return (
                        <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '6px', background: 'var(--subtle-bg, rgba(148,163,184,0.08))', color: ageColor(age) }}>
                          ⏱ waiting {age}d
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    <span style={{ fontWeight: 800, color: '#f472b6' }}>{fmtMoney(amount)}</span>
                    {' · '}{inv.lines.length} VIN{inv.lines.length !== 1 ? 's' : ''}
                    {inv.location_name ? ` · ${inv.location_name}` : ''}
                    {' · invoice date '}{fmtDate(inv.invoice_date || inv.created_at)}
                    {inv.due_date && (() => {
                      const overdue = inv.due_date < new Date().toISOString().slice(0, 10) && inv.status !== 'paid';
                      return (
                        <span style={{ fontWeight: 700, color: overdue ? '#ef4444' : 'var(--text-muted)' }}>
                          {' · due '}{fmtDate(inv.due_date)}{overdue ? ' — overdue' : ''}
                        </span>
                      );
                    })()}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {stamp(inv.submitted_by, inv.submitted_at) && <span>Submitted: {stamp(inv.submitted_by, inv.submitted_at)}</span>}
                    {stamp(inv.approved_by, inv.approved_at) && <span>Approved: {stamp(inv.approved_by, inv.approved_at)}</span>}
                    {stamp(inv.billed_by, inv.billed_at) && <span>Billed: {stamp(inv.billed_by, inv.billed_at)}{inv.netsuite_bill_id ? ` · NS #${inv.netsuite_bill_id}` : ''}</span>}
                    {/* paid_by null + paid_at set = the NetSuite payment sync flipped it */}
                    {(inv.paid_by || inv.paid_at) && <span>Paid: {inv.paid_by ? stamp(inv.paid_by, inv.paid_at) : `NetSuite · ${inv.paid_at ? new Date(inv.paid_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}`}</span>}
                  </div>
                  {inv.status === 'rejected' && inv.rejection_reason && (
                    <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '4px' }}>
                      Rejected{inv.rejected_by ? ` by ${names[inv.rejected_by] || '—'}` : ''}: {inv.rejection_reason}
                    </div>
                  )}
                  {!vendorLinked && (inv.status === 'submitted' || inv.status === 'approved') && (
                    <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: '4px' }}>
                      ⚠ Not linked to a NetSuite vendor yet — billing will need that first.
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  {inv.storage_path && (
                    <a
                      href={storageDownloadUrl('invoices', inv.storage_path, inv.file_name || '')}
                      target="_blank" rel="noreferrer"
                      style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', textDecoration: 'none' }}
                    >Invoice</a>
                  )}
                  {['recorded', 'submitted', 'approved', 'rejected'].includes(inv.status) && (
                    <button disabled={isBusy} onClick={() => setEditing(inv)} title="Edit invoice details — fix the vendor link, dates, or amount"
                      style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'var(--subtle-bg, rgba(148,163,184,0.1))', border: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer' }}>
                      ✎ Edit
                    </button>
                  )}
                  {inv.status === 'recorded' && (
                    <button disabled={isBusy} onClick={() => act(inv.id, { action: 'submit' })} style={{ padding: '7px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: '#f472b6', color: '#fff', border: 'none', cursor: 'pointer', opacity: isBusy ? 0.6 : 1 }}>
                      Submit for Payment
                    </button>
                  )}
                  {inv.status === 'submitted' && (
                    <>
                      <button disabled={isBusy} onClick={() => act(inv.id, { action: 'approve' })} style={{ padding: '7px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', opacity: isBusy ? 0.6 : 1 }}>
                        ✓ Approve
                      </button>
                      <button disabled={isBusy} onClick={() => reject(inv)} style={{ padding: '7px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', cursor: 'pointer' }}>
                        Reject
                      </button>
                    </>
                  )}
                  {inv.status === 'approved' && (
                    <>
                      <select value={loc} onChange={e => setBillLocation(prev => ({ ...prev, [inv.id]: e.target.value }))}
                        style={{ padding: '6px 8px', borderRadius: '7px', fontSize: '11px', fontWeight: 600, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)' }}>
                        {BILL_LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                      <button
                        disabled={isBusy || !vendorLinked}
                        title={vendorLinked ? '' : 'Link this installer to a NetSuite vendor first'}
                        onClick={() => act(inv.id, { action: 'create_bill', location: loc }, `Create a NetSuite vendor bill for ${fmtMoney(amount)} to ${inv.vendor_name}?`)}
                        style={{ padding: '7px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 800, background: vendorLinked ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none', cursor: 'pointer', opacity: isBusy || !vendorLinked ? 0.6 : 1 }}
                      >
                        {isBusy ? 'Creating…' : 'Create Bill in NetSuite'}
                      </button>
                      <button disabled={isBusy} onClick={() => recordBill(inv)} style={{ padding: '7px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
                        Record Bill
                      </button>
                      <button disabled={isBusy} onClick={() => reject(inv)} style={{ padding: '7px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', cursor: 'pointer' }}>
                        Reject
                      </button>
                    </>
                  )}
                  {inv.status === 'billed' && (
                    <button disabled={isBusy} onClick={() => act(inv.id, { action: 'mark_paid' }, `Mark the ${inv.vendor_name} invoice (${fmtMoney(amount)}) as paid?`)} style={{ padding: '7px 14px', borderRadius: '7px', fontSize: '11px', fontWeight: 800, background: '#4ade80', color: '#0b3018', border: 'none', cursor: 'pointer', opacity: isBusy ? 0.6 : 1 }}>
                      Mark Paid
                    </button>
                  )}
                  {inv.status === 'rejected' && (
                    <button disabled={isBusy} onClick={() => act(inv.id, { action: 'submit' })} style={{ padding: '7px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24', cursor: 'pointer' }}>
                      Resubmit
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <EditVendorInvoiceModal
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
