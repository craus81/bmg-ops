'use client';

/**
 * Parts Mail — everything the email→ETA pipeline saw and what it did with
 * it. Review-queue rows (parts emails with no PO match) get resolved here:
 * type the PO number to link + apply, or dismiss. Admins also edit the
 * watched-mailbox list and can trigger a scan on demand.
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import IncomingParts from '@/components/IncomingParts';

interface MailRow {
  id: string;
  mailbox: string;
  from_address: string | null;
  subject: string | null;
  received_at: string | null;
  classification: 'applied' | 'linked' | 'review' | 'ignored' | 'error';
  vendor_name: string | null;
  po_number: string | null;
  ship_date: string | null;
  eta_date: string | null;
  tracking_number: string | null;
  carrier: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
}

const CLASS_STYLES: Record<MailRow['classification'], { label: string; color: string }> = {
  applied: { label: 'Applied', color: '#22c55e' },
  linked: { label: 'Linked', color: '#60a5fa' },
  review: { label: 'Needs Review', color: '#fbbf24' },
  ignored: { label: 'Ignored', color: '#94a3b8' },
  error: { label: 'Error', color: '#ef4444' },
};

const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

interface InvoiceRow {
  id: string;
  email_id: string | null;
  file_name: string;
  storage_path: string;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total: number | null;
  matched_po_id: string | null;
  status: 'captured' | 'billed' | 'dismissed';
  netsuite_bill_number: string | null;
  netsuite_bill_id: string | null;
  created_at: string;
  po?: { tranid: string | null; vendor_name: string | null } | null;
}

export default function PartsMailPage() {
  const supabase = createClient();
  const { isAdmin, hasFeature } = useAuth();
  const dialog = useDialog();
  const canBill = isAdmin || hasFeature('vendor_payments');

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invLinkInputs, setInvLinkInputs] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<MailRow[]>([]);
  const [filter, setFilter] = useState<'all' | MailRow['classification']>('all');
  const [loading, setLoading] = useState(true);
  const [linkInputs, setLinkInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [syncingPos, setSyncingPos] = useState(false);
  // Bumped after a successful scan so the Incoming Parts list picks up the
  // freshly-written ETAs without a page reload.
  const [scanKey, setScanKey] = useState(0);
  // In-app invoice PDF viewer. Opening the raw file in a new tab traps mobile
  // users on a chrome-less page with no back button, so we render it in an
  // overlay with an explicit Close instead.
  const [viewingInvoice, setViewingInvoice] = useState<{ url: string; name: string } | null>(null);

  // Settings (admin)
  const [mailboxText, setMailboxText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    const [emailsRes, invRes] = await Promise.all([
      supabase.from('vendor_shipment_emails').select('*').order('created_at', { ascending: false }).limit(150),
      supabase.from('vendor_parts_invoices')
        .select('*, po:matched_po_id (tranid, vendor_name)')
        .neq('status', 'dismissed')
        .order('created_at', { ascending: false })
        .limit(60),
    ]);
    setRows((emailsRes.data as MailRow[]) || []);
    setInvoices((invRes.data as InvoiceRow[]) || []);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => {
    load();
    (async () => {
      const { data } = await supabase.from('parts_email_settings').select('enabled, mailboxes').eq('id', 1).maybeSingle();
      if (data) {
        setEnabled(data.enabled);
        setMailboxText((data.mailboxes || []).join('\n'));
      }
      setSettingsLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, [load]);

  const resolve = async (row: MailRow, poNumber: string | null) => {
    setBusy(row.id);
    const res = await fetch('/api/parts-mail/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId: row.id, poNumber }),
    });
    const data = await res.json();
    if (!res.ok) {
      await dialog.alert(data.error || 'Failed');
    } else {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, classification: data.classification, po_number: poNumber || r.po_number } : r));
    }
    setBusy(null);
  };

  const scanNow = async () => {
    setScanning(true);
    const res = await fetch('/api/cron/parts-email-scan');
    const data = await res.json().catch(() => ({}));
    setScanning(false);
    if (!res.ok) {
      await dialog.alert(data.error || 'Scan failed');
    } else if (data.skipped) {
      await dialog.alert(`Scan skipped: ${data.skipped}`);
    } else {
      await dialog.alert(`Scanned ${data.mailboxes} mailboxes · ${data.processed} new emails · ${data.applied} ETAs applied · ${data.review} for review${data.errors ? ` · ${data.errors} errors` : ''}`);
      load();
      setScanKey(k => k + 1);
    }
  };

  const syncPosNow = async () => {
    setSyncingPos(true);
    const res = await fetch('/api/parts-mail/sync-pos', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    setSyncingPos(false);
    if (!res.ok || data.ok === false) {
      await dialog.alert(`Vendor PO sync failed: ${data.error || 'unknown error'}`);
      return;
    }
    const modified = data.modified ?? 0;   // POs NetSuite returned
    const totalPos = data.totalPos ?? 0;   // POs now saved in FleetSuite
    let msg: string;
    if (totalPos > 0) {
      msg = `NetSuite returned ${modified} PO(s) · ${data.synced ?? 0} saved · ${data.lines ?? 0} line(s). ${totalPos} PO(s) on file now.`;
    } else if (modified === 0) {
      msg = `NetSuite returned 0 purchase orders across all history.\n\nCustomer/sales data syncs fine, so the NetSuite integration role most likely can't see Purchase Orders. Fix in NetSuite: grant that role "Purchase Order → View". This is a NetSuite permission, not a FleetSuite bug.`;
    } else {
      msg = `NetSuite returned ${modified} PO(s) but none saved to FleetSuite — that's a FleetSuite-side issue. Screenshot this and send it to me.`;
    }
    await dialog.alert(msg);
    if (totalPos > 0) setScanKey(k => k + 1);
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    const mailboxes = mailboxText.split(/[\n,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@'));
    await supabase.from('parts_email_settings').update({
      enabled,
      mailboxes,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    setMailboxText(mailboxes.join('\n'));
    setSavingSettings(false);
  };

  const resolveInvoice = async (inv: InvoiceRow, poNumber: string | null) => {
    setBusy(inv.id);
    const res = await fetch('/api/parts-mail/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: inv.id, poNumber }),
    });
    const data = await res.json();
    if (!res.ok) await dialog.alert(data.error || 'Failed');
    else load();
    setBusy(null);
  };

  const createBill = async (inv: InvoiceRow) => {
    const label = `${inv.vendor_name || 'vendor'} invoice ${inv.invoice_number || inv.file_name}${inv.total ? ` for $${Number(inv.total).toLocaleString()}` : ''}`;
    const ok = await dialog.confirm(`Create a NetSuite vendor bill from PO ${inv.po?.tranid || ''} for ${label}? This posts a real bill in NetSuite.`);
    if (!ok) return;
    setBusy(inv.id);
    const res = await fetch('/api/parts-mail/create-bill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invoiceId: inv.id }),
    });
    const data = await res.json();
    if (!res.ok) await dialog.alert(data.error || 'Bill creation failed');
    else {
      await dialog.alert(`Bill created${data.billNumber ? `: ${data.billNumber}` : ''} from PO ${data.po || ''}.`);
      load();
    }
    setBusy(null);
  };

  const visible = filter === 'all' ? rows : rows.filter(r => r.classification === filter);
  const reviewCount = rows.filter(r => r.classification === 'review').length;

  // The same invoice is often captured from more than one watched mailbox, so
  // collapse to one row per vendor+invoice, keeping the most-progressed copy
  // (billed > PO-matched > captured). Guards existing dupes; the scan won't
  // create new ones.
  const invoiceRank = (i: InvoiceRow) => (i.status === 'billed' ? 2 : i.matched_po_id ? 1 : 0);
  const dedupedInvoices = (() => {
    const best = new Map<string, InvoiceRow>();
    for (const inv of invoices) {
      const key = `${(inv.vendor_name || '').toLowerCase()}|${(inv.invoice_number || inv.file_name).toLowerCase()}`;
      const cur = best.get(key);
      if (!cur || invoiceRank(inv) > invoiceRank(cur)) best.set(key, inv);
    }
    return [...best.values()];
  })();

  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' };
  const inputStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' };

  return (
    <div style={{ padding: '16px', maxWidth: '860px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Parts Mail</h1>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Vendor order confirmations → parts ETAs{reviewCount > 0 ? ` · ${reviewCount} need review` : ''}
          </div>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={syncPosNow} disabled={syncingPos} style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: syncingPos ? 0.6 : 1 }}>
              {syncingPos ? 'Syncing POs…' : 'Sync POs'}
            </button>
            <button onClick={scanNow} disabled={scanning} style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: scanning ? 0.6 : 1 }}>
              {scanning ? 'Scanning…' : 'Scan Now'}
            </button>
          </div>
        )}
      </div>

      {/* What's on order and when — checked against stock and job reservations */}
      <IncomingParts refreshKey={scanKey} />

      {/* Admin settings */}
      {isAdmin && settingsLoaded && (
        <div style={card}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Watched Mailboxes</div>
          <textarea
            value={mailboxText}
            onChange={e => setMailboxText(e.target.value)}
            rows={4}
            placeholder={'one@bmgfleet.com\ntwo@bmgfleet.com'}
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Scanning enabled
            </label>
            <button onClick={saveSettings} disabled={savingSettings} style={{ padding: '7px 14px', borderRadius: '8px', background: '#3b82f6', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: savingSettings ? 0.6 : 1 }}>
              {savingSettings ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Captured vendor invoices → NetSuite bills */}
      {dedupedInvoices.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
            Vendor Invoices ({dedupedInvoices.filter(i => i.status === 'captured').length} to bill)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {dedupedInvoices.map(inv => (
              <div key={inv.id} style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--input-bg)', border: `1px solid ${inv.status === 'billed' ? 'rgba(34,197,94,0.35)' : 'var(--border)'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => setViewingInvoice({ url: `/api/storage?bucket=parts-invoices&path=${encodeURIComponent(inv.storage_path)}`, name: inv.file_name })}
                    style={{ fontSize: '12px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                  >
                    📄 {inv.file_name}
                  </button>
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', background: inv.status === 'billed' ? 'rgba(34,197,94,0.2)' : 'rgba(96,165,250,0.2)', color: inv.status === 'billed' ? '#22c55e' : '#60a5fa' }}>
                    {inv.status === 'billed' ? `BILLED${inv.netsuite_bill_number ? ` · ${inv.netsuite_bill_number}` : ''}` : 'CAPTURED'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px', fontSize: '10px', color: 'var(--text-muted)' }}>
                  {inv.vendor_name && <span>{inv.vendor_name}</span>}
                  {inv.invoice_number && <span>Inv #<b style={{ color: 'var(--text-secondary)' }}>{inv.invoice_number}</b></span>}
                  {inv.invoice_date && <span>{fmt(inv.invoice_date)}</span>}
                  {inv.total != null && <span><b style={{ color: 'var(--text-secondary)' }}>${Number(inv.total).toLocaleString()}</b></span>}
                  {inv.po?.tranid ? <span>PO <b style={{ color: 'var(--text-secondary)' }}>{inv.po.tranid}</b></span> : <span style={{ color: '#fbbf24' }}>No PO linked</span>}
                </div>
                {inv.status === 'captured' && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                    {inv.matched_po_id ? (
                      canBill && (
                        <button onClick={() => createBill(inv)} disabled={busy === inv.id} style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: busy === inv.id ? 0.5 : 1 }}>
                          Create NetSuite Bill
                        </button>
                      )
                    ) : (
                      <>
                        <input
                          style={{ ...inputStyle, flex: 1, minWidth: '130px' }}
                          placeholder="PO number to link"
                          value={invLinkInputs[inv.id] || ''}
                          onChange={e => setInvLinkInputs(prev => ({ ...prev, [inv.id]: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && (invLinkInputs[inv.id] || '').trim() && resolveInvoice(inv, invLinkInputs[inv.id].trim())}
                        />
                        <button
                          onClick={() => resolveInvoice(inv, (invLinkInputs[inv.id] || '').trim() || null)}
                          disabled={busy === inv.id || !(invLinkInputs[inv.id] || '').trim()}
                          style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(96,165,250,0.15)', border: '1px solid rgba(96,165,250,0.4)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: busy === inv.id || !(invLinkInputs[inv.id] || '').trim() ? 0.5 : 1 }}
                        >
                          Link PO
                        </button>
                      </>
                    )}
                    <button onClick={() => resolveInvoice(inv, null)} disabled={busy === inv.id} style={{ padding: '7px 12px', borderRadius: '8px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {(['all', 'review', 'applied', 'linked', 'ignored', 'error'] as const).map(f => {
          const count = f === 'all' ? rows.length : rows.filter(r => r.classification === f).length;
          const active = filter === f;
          const color = f === 'all' ? '#60a5fa' : CLASS_STYLES[f].color;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '5px 11px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              background: active ? `${color}25` : 'var(--card)',
              border: `1px solid ${active ? color : 'var(--border)'}`,
              color: active ? color : 'var(--text-muted)',
            }}>
              {f === 'all' ? 'All' : CLASS_STYLES[f].label} ({count})
            </button>
          );
        })}
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>
          Nothing here yet — the scan runs hourly{isAdmin ? ', or hit Scan Now' : ''}.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(r => {
          const cls = CLASS_STYLES[r.classification];
          return (
            <div key={r.id} style={{ ...card, marginBottom: 0, padding: '11px 13px', borderColor: r.classification === 'review' ? 'rgba(251,191,36,0.4)' : 'var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.subject || '(no subject)'}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {[r.from_address, r.mailbox && `→ ${r.mailbox}`, r.received_at && fmt(r.received_at)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', background: `${cls.color}20`, color: cls.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{cls.label}</span>
              </div>
              {r.summary && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '5px' }}>{r.summary}</div>}
              {r.error && <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>{r.error}</div>}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '5px', fontSize: '10px', color: 'var(--text-muted)' }}>
                {r.vendor_name && <span>Vendor: <b style={{ color: 'var(--text-secondary)' }}>{r.vendor_name}</b></span>}
                {r.po_number && <span>PO: <b style={{ color: 'var(--text-secondary)' }}>{r.po_number}</b></span>}
                {r.eta_date && <span>ETA: <b style={{ color: '#60a5fa' }}>{fmt(r.eta_date)}</b></span>}
                {r.ship_date && <span>Shipped: <b style={{ color: 'var(--text-secondary)' }}>{fmt(r.ship_date)}</b></span>}
                {r.tracking_number && <span>Tracking: <b style={{ color: 'var(--text-secondary)' }}>{r.tracking_number}</b>{r.carrier ? ` (${r.carrier})` : ''}</span>}
              </div>
              {r.classification === 'review' && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <input
                    style={{ ...inputStyle, flex: 1, minWidth: '140px' }}
                    placeholder="PO number to link (e.g. PO1234)"
                    value={linkInputs[r.id] || ''}
                    onChange={e => setLinkInputs(prev => ({ ...prev, [r.id]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && (linkInputs[r.id] || '').trim() && resolve(r, linkInputs[r.id].trim())}
                  />
                  <button
                    onClick={() => resolve(r, (linkInputs[r.id] || '').trim() || null)}
                    disabled={busy === r.id || !(linkInputs[r.id] || '').trim()}
                    style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: busy === r.id || !(linkInputs[r.id] || '').trim() ? 0.5 : 1 }}
                  >
                    Link &amp; Apply
                  </button>
                  <button
                    onClick={() => resolve(r, null)}
                    disabled={busy === r.id}
                    style={{ padding: '7px 12px', borderRadius: '8px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* In-app invoice viewer — always exits via Close, even on mobile */}
      {viewingInvoice && (
        <div
          onClick={() => setViewingInvoice(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.9)', display: 'flex', flexDirection: 'column', padding: '12px' }}
        >
          <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
            <span style={{ color: '#fff', fontSize: '12px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {viewingInvoice.name}</span>
            <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
              <a href={viewingInvoice.url} target="_blank" rel="noopener noreferrer" style={{ padding: '8px 12px', borderRadius: '10px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff', fontSize: '12px', fontWeight: 700, textDecoration: 'none' }}>Open ↗</a>
              <button onClick={() => setViewingInvoice(null)} style={{ padding: '8px 14px', borderRadius: '10px', background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>✕ Close</button>
            </div>
          </div>
          <iframe
            src={viewingInvoice.url}
            title={viewingInvoice.name}
            onClick={e => e.stopPropagation()}
            style={{ flex: 1, width: '100%', border: 'none', borderRadius: '8px', background: '#fff' }}
          />
        </div>
      )}
    </div>
  );
}
