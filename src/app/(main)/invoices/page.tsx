'use client';

/**
 * Invoicing hub — one place to create and send every NetSuite invoice.
 *
 * Tabs:
 *  - Graphics: uninvoiced graphics jobs → Review & Invoice (same modal as the
 *    Graphics page), then offer to email the fresh invoice.
 *  - Scans: scans ready to invoice, grouped by customer + PO exactly the way
 *    /api/netsuite/invoice-vehicles bills them (one invoice per group), with
 *    email buttons on the results.
 *  - Sent: recent invoices from both sources, grouped by customer, with
 *    per-invoice and per-customer email actions (shared EmailInvoicesModal).
 *
 * Deep scan management (PO matching, bulk edit, archive) stays on the Scan
 * Log page; job editing stays on the Graphics page. This page is only about
 * turning finished work into invoices and getting them to the customer.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import GraphicsInvoiceReviewModal from '@/components/GraphicsInvoiceReviewModal';
import EmailInvoicesModal, { type EmailableInvoice } from '@/components/EmailInvoicesModal';
import type { GraphicsJob, GraphicsJobStatus } from '@/lib/types';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_COLORS } from '@/lib/types';

type HubTab = 'graphics' | 'scans' | 'sent';

// Graphics statuses that mean the physical work is done and the job is
// billable. Everything else is still moving through production.
const DONE_STATUSES: GraphicsJobStatus[] = ['ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed'];

interface ScanRow {
  id: string;
  vin: string;
  part_number: string | null;
  part_description: string | null;
  billable_customer: string | null;
  location_name: string | null;
  po_id: string | null;
  po_number: string | null;
  exported_at: string | null;
  invoice_number: string | null;
}

interface ScanInvoiceRow {
  billable_customer: string | null;
  invoice_number: string;
  po_number: string | null;
  date_invoiced: string | null;
}

interface ScanGroup {
  key: string;
  customer: string;
  po: string | null;
  scans: ScanRow[];
}

interface SentInvoice {
  source: 'Graphics' | 'Scans';
  customer: string;
  invoiceNumber: string;
  invoiceId?: string;
  po?: string;
  date: string | null;
  amount?: number | null;
}

interface InvoiceVehiclesResult {
  results: { customer: string; po?: string | null; invoiceId?: string; invoiceNumber?: string; vehicleCount: number; status: string; error?: string }[];
  summary: { success: number; errors: number };
}

export default function InvoicingHubPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAdmin, isSales } = useAuth();
  const dialog = useDialog();
  const supabase = createClient();

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales) router.push('/home');
  }, [user, isAdmin, isSales, router]);

  const [tab, setTab] = useState<HubTab>('graphics');
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // ── Data ──
  const [uninvoicedJobs, setUninvoicedJobs] = useState<GraphicsJob[]>([]);
  const [invoicedJobs, setInvoicedJobs] = useState<GraphicsJob[]>([]);
  const [readyScans, setReadyScans] = useState<ScanRow[]>([]);
  const [waitingScanCount, setWaitingScanCount] = useState(0);
  const [scanInvoices, setScanInvoices] = useState<ScanInvoiceRow[]>([]);

  // ── Graphics flow ──
  const [graphicsFilter, setGraphicsFilter] = useState<'done' | 'all'>('done');
  const [invoiceJob, setInvoiceJob] = useState<GraphicsJob | null>(null);

  // ── Scans flow ──
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [invoicing, setInvoicing] = useState(false);
  const [invoiceResult, setInvoiceResult] = useState<InvoiceVehiclesResult | null>(null);

  // ── Email flow (shared) ──
  const [emailTarget, setEmailTarget] = useState<{ customerName: string; invoices: EmailableInvoice[] } | null>(null);

  // Deep link from the "Graphics shipped — create invoice?" notification:
  // /invoices?invoiceJob=<id>. Fetches the job by id directly (never depends
  // on the tab lists being loaded or filtered) and opens the review modal.
  const invoicePromptHandled = useRef<Set<string>>(new Set());
  useEffect(() => {
    const invoiceJobId = searchParams.get('invoiceJob');
    if (!invoiceJobId || invoicePromptHandled.current.has(invoiceJobId)) return;
    invoicePromptHandled.current.add(invoiceJobId);
    router.replace('/invoices', { scroll: false });
    (async () => {
      const { data: job } = await supabase
        .from('graphics_jobs')
        .select('*')
        .eq('id', invoiceJobId)
        .maybeSingle();
      if (!job) {
        await dialog.alert('Could not find that graphics job — it may have been deleted.');
        return;
      }
      if ((job as GraphicsJob).netsuite_invoice_id) {
        await dialog.alert(`This job is already invoiced as #${(job as GraphicsJob).netsuite_invoice_number || (job as GraphicsJob).netsuite_invoice_id}.`);
        return;
      }
      setInvoiceJob(job as GraphicsJob);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: handle the param once per id
  }, [searchParams]);

  const loadAll = async () => {
    setLoading(true);
    const [uninvRes, invRes, scansRes, partsRes, scanInvRes] = await Promise.all([
      supabase.from('graphics_jobs').select('*')
        .is('netsuite_invoice_id', null)
        .neq('status', 'cancelled')
        .order('updated_at', { ascending: false })
        .limit(500),
      supabase.from('graphics_jobs').select('*')
        .not('netsuite_invoice_id', 'is', null)
        .order('invoiced_at', { ascending: false })
        .limit(200),
      supabase.from('scan_logs')
        .select('id, vin, part_number, part_description, billable_customer, location_name, po_id, po_number, exported_at, invoice_number')
        .is('archived_at', null)
        .is('invoice_number', null)
        .order('scanned_at', { ascending: false })
        .limit(1000),
      supabase.from('netsuite_parts').select('item_number, requires_po_match'),
      supabase.from('scan_logs')
        .select('billable_customer, invoice_number, po_number, date_invoiced')
        .not('invoice_number', 'is', null)
        .order('date_invoiced', { ascending: false })
        .limit(1000),
    ]);

    setUninvoicedJobs((uninvRes.data as GraphicsJob[]) || []);
    setInvoicedJobs((invRes.data as GraphicsJob[]) || []);

    // Mirror the Scan Log's "Ready to Export" semantics: not exported yet, and
    // either matched to a PO or the part doesn't require one.
    const poRequired: Record<string, boolean> = {};
    (partsRes.data || []).forEach((p: any) => { poRequired[p.item_number] = p.requires_po_match !== false; });
    const needsPO = (s: ScanRow) => poRequired[s.part_number || ''] !== false;
    const pending = ((scansRes.data as ScanRow[]) || []).filter(s => !s.exported_at);
    setReadyScans(pending.filter(s => s.po_id || !needsPO(s)));
    setWaitingScanCount(pending.filter(s => !s.po_id && needsPO(s)).length);

    setScanInvoices(((scanInvRes.data as ScanInvoiceRow[]) || []).filter(r => r.invoice_number));
    setSelectedGroups(new Set());
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { loadAll(); }, []);

  // ── Graphics tab derivations ──
  const doneJobs = uninvoicedJobs.filter(j => DONE_STATUSES.includes(j.status));
  const graphicsJobs = (graphicsFilter === 'done' ? doneJobs : uninvoicedJobs).filter(j => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (j.title || '').toLowerCase().includes(q)
      || (j.customer || '').toLowerCase().includes(q)
      || (j.job_number || '').toLowerCase().includes(q)
      || (j.po_number || '').toLowerCase().includes(q)
      || (j.part_number || '').toLowerCase().includes(q);
  });

  // ── Scans tab derivations: one group per customer + PO (one invoice each) ──
  const scanGroups: ScanGroup[] = useMemo(() => {
    const byKey: Record<string, ScanGroup> = {};
    for (const s of readyScans) {
      const customer = s.billable_customer || 'Unknown';
      const po = s.po_number || null;
      const key = `${customer}|||${po || 'NO_PO'}`;
      if (!byKey[key]) byKey[key] = { key, customer, po, scans: [] };
      byKey[key].scans.push(s);
    }
    return Object.values(byKey).sort((a, b) =>
      a.customer.localeCompare(b.customer) || (a.po || '').localeCompare(b.po || ''));
  }, [readyScans]);

  const visibleScanGroups = scanGroups.filter(g => {
    if (!search) return true;
    const q = search.toLowerCase();
    return g.customer.toLowerCase().includes(q)
      || (g.po || '').toLowerCase().includes(q)
      || g.scans.some(s => (s.part_number || '').toLowerCase().includes(q) || s.vin.toLowerCase().includes(q));
  });

  const selectedScanIds = scanGroups
    .filter(g => selectedGroups.has(g.key))
    .flatMap(g => g.scans.map(s => s.id));

  // ── Sent tab derivations ──
  const sentInvoices: SentInvoice[] = useMemo(() => {
    const rows: SentInvoice[] = invoicedJobs
      .filter(j => j.netsuite_invoice_number || j.netsuite_invoice_id)
      .map(j => ({
        source: 'Graphics' as const,
        customer: j.customer || 'Unknown',
        invoiceNumber: j.netsuite_invoice_number || String(j.netsuite_invoice_id),
        invoiceId: j.netsuite_invoice_id || undefined,
        po: j.po_number || undefined,
        date: j.invoiced_at,
        amount: j.invoice_amount,
      }));
    const seen = new Set<string>();
    for (const r of scanInvoices) {
      if (seen.has(r.invoice_number)) continue;
      seen.add(r.invoice_number);
      rows.push({
        source: 'Scans',
        customer: r.billable_customer || 'Unknown',
        invoiceNumber: r.invoice_number,
        po: r.po_number || undefined,
        date: r.date_invoiced,
      });
    }
    return rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [invoicedJobs, scanInvoices]);

  const sentByCustomer = useMemo(() => {
    const filtered = sentInvoices.filter(r => {
      if (!search) return true;
      const q = search.toLowerCase();
      return r.customer.toLowerCase().includes(q)
        || r.invoiceNumber.toLowerCase().includes(q)
        || (r.po || '').toLowerCase().includes(q);
    });
    const byCustomer: Record<string, SentInvoice[]> = {};
    for (const r of filtered) {
      if (!byCustomer[r.customer]) byCustomer[r.customer] = [];
      byCustomer[r.customer].push(r);
    }
    return Object.entries(byCustomer).sort(([, a], [, b]) =>
      (b[0].date || '').localeCompare(a[0].date || ''));
  }, [sentInvoices, search]);

  // ── Actions ──
  const toggleGroup = (key: string) => {
    setSelectedGroups(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  };

  const createScanInvoices = async () => {
    if (selectedScanIds.length === 0) return;
    const groupCount = selectedGroups.size;
    if (!(await dialog.confirm(
      `Create ${groupCount} NetSuite invoice${groupCount !== 1 ? 's' : ''} for ${selectedScanIds.length} scanned vehicle${selectedScanIds.length !== 1 ? 's' : ''}? This will bill the customer${groupCount !== 1 ? 's' : ''} directly.`
    ))) return;
    setInvoicing(true);
    setInvoiceResult(null);
    try {
      const res = await fetch('/api/netsuite/invoice-vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanIds: selectedScanIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        await dialog.alert(`Invoice failed: ${data.error || 'Unknown error'}`);
      } else {
        setInvoiceResult(data);
        loadAll();
      }
    } catch (e: any) {
      await dialog.alert(`Invoice failed: ${e.message}`);
    }
    setInvoicing(false);
  };

  const emailForJob = (job: GraphicsJob, override?: { invoiceId?: string | null; invoiceNumber?: string | null }) => {
    const invoiceId = override?.invoiceId ?? job.netsuite_invoice_id;
    const invoiceNumber = override?.invoiceNumber ?? job.netsuite_invoice_number;
    if (!invoiceId && !invoiceNumber) return;
    setEmailTarget({
      customerName: job.customer || '',
      invoices: [{
        invoiceId: invoiceId || undefined,
        invoiceNumber: invoiceNumber || String(invoiceId),
        po: job.po_number || undefined,
      }],
    });
  };

  // ── Styles ──
  const card: React.CSSProperties = {
    background: 'var(--card)', border: '1px solid var(--border)',
    borderRadius: '12px', padding: '12px 14px',
  };
  const smallBtn = (color: string, bg: string, border: string): React.CSSProperties => ({
    padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
    cursor: 'pointer', background: bg, border: `1px solid ${border}`, color, whiteSpace: 'nowrap',
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>Invoicing</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Create NetSuite invoices from finished work and email them to customers — all in one place.
          </div>
        </div>
        <button
          onClick={() => router.push('/invoices/bulk-download')}
          style={smallBtn('#60a5fa', 'rgba(59,130,246,0.08)', 'rgba(59,130,246,0.25)')}
        >Download Open Invoices (ZIP) →</button>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {([
          { id: 'graphics' as HubTab, label: `Graphics Jobs (${doneJobs.length})`, color: '#22c55e' },
          { id: 'scans' as HubTab, label: `Scanned Vehicles (${scanGroups.length})`, color: '#fbbf24' },
          { id: 'sent' as HubTab, label: `Invoiced (${sentInvoices.length})`, color: '#60a5fa' },
        ]).map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(''); }} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: tab === t.id ? 'var(--tab-active-bg)' : 'transparent',
            border: tab === t.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: tab === t.id ? t.color : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
      </div>

      <input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder={tab === 'graphics' ? 'Search job, customer, PO, part…' : tab === 'scans' ? 'Search customer, PO, part, VIN…' : 'Search customer, invoice #, PO…'}
        style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontWeight: 600, marginBottom: '12px', boxSizing: 'border-box' }}
      />

      {loading ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      ) : tab === 'graphics' ? (
        <>
          {/* Done vs all filter */}
          <div style={{ display: 'flex', gap: '4px', marginBottom: '10px' }}>
            {([
              { id: 'done' as const, label: `Completed (${doneJobs.length})` },
              { id: 'all' as const, label: `All uninvoiced (${uninvoicedJobs.length})` },
            ]).map(f => (
              <button key={f.id} onClick={() => setGraphicsFilter(f.id)} style={{
                padding: '5px 12px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: graphicsFilter === f.id ? 'var(--tab-active-bg)' : 'transparent',
                border: graphicsFilter === f.id ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
                color: graphicsFilter === f.id ? '#22c55e' : 'var(--text-muted)',
              }}>{f.label}</button>
            ))}
          </div>

          {graphicsJobs.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '28px' }}>
              {graphicsFilter === 'done' ? 'No completed graphics jobs waiting on an invoice.' : 'No uninvoiced graphics jobs.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {graphicsJobs.map(job => (
                <div key={job.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: '220px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {job.title || 'Untitled job'}{job.job_number ? ` · #${job.job_number}` : ''}
                      </span>
                      <span style={{
                        fontSize: '9px', fontWeight: 700, padding: '2px 7px', borderRadius: '5px',
                        background: `${GRAPHICS_STATUS_COLORS[job.status]}22`, color: GRAPHICS_STATUS_COLORS[job.status],
                      }}>{GRAPHICS_STATUS_LABELS[job.status]}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                      {job.customer || 'No customer'}
                      {job.po_number ? ` · PO #${job.po_number}` : ''}
                      {job.quantity ? ` · Qty ${job.quantity}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => setInvoiceJob(job)}
                    style={smallBtn('#22c55e', 'rgba(34,197,94,0.08)', 'rgba(34,197,94,0.25)')}
                  >Review &amp; Invoice</button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : tab === 'scans' ? (
        <>
          {waitingScanCount > 0 && (
            <div style={{ ...card, marginBottom: '10px', fontSize: '12px', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <span>{waitingScanCount} scan{waitingScanCount !== 1 ? 's are' : ' is'} waiting for a PO match and can&apos;t be invoiced yet.</span>
              <button onClick={() => router.push('/admin/scans')} style={smallBtn('#f59e0b', 'rgba(245,158,11,0.08)', 'rgba(245,158,11,0.3)')}>
                Fix in Scan Log →
              </button>
            </div>
          )}

          {/* Invoice result banner (mirrors the Scan Log one) */}
          {invoiceResult && (
            <div style={{ ...card, marginBottom: '10px', border: `1px solid ${invoiceResult.summary.errors > 0 ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: invoiceResult.results.length > 0 ? '8px' : 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  Invoice Result: {invoiceResult.summary.success} created{invoiceResult.summary.errors > 0 ? `, ${invoiceResult.summary.errors} failed` : ''}
                </div>
                <button onClick={() => setInvoiceResult(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '14px', cursor: 'pointer' }}>✕</button>
              </div>
              {invoiceResult.results.map((r, i) => (
                <div key={i} style={{ fontSize: '11px', fontWeight: 600, color: r.status === 'success' ? '#22c55e' : '#ef4444', marginBottom: '2px' }}>
                  {r.customer}{r.po ? ` · PO #${r.po}` : ''} ({r.vehicleCount} VIN{r.vehicleCount !== 1 ? 's' : ''})
                  {r.status === 'success' ? ` → Invoice #${r.invoiceNumber}` : ` — ${r.error}`}
                </div>
              ))}
              {invoiceResult.summary.success > 0 && (() => {
                const successByCustomer: Record<string, EmailableInvoice[]> = {};
                for (const r of invoiceResult.results) {
                  if (r.status === 'success' && r.invoiceId && r.invoiceNumber) {
                    if (!successByCustomer[r.customer]) successByCustomer[r.customer] = [];
                    successByCustomer[r.customer].push({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, po: r.po || undefined });
                  }
                }
                return (
                  <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {Object.entries(successByCustomer).map(([customer, invs]) => (
                      <button key={customer} onClick={() => setEmailTarget({ customerName: customer, invoices: invs })} style={smallBtn('#60a5fa', 'rgba(59,130,246,0.1)', 'rgba(59,130,246,0.25)')}>
                        Email {invs.length} Invoice{invs.length !== 1 ? 's' : ''} to {customer}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={() => setSelectedGroups(selectedGroups.size === visibleScanGroups.length && visibleScanGroups.length > 0 ? new Set() : new Set(visibleScanGroups.map(g => g.key)))}
              style={smallBtn('var(--text-secondary)', 'var(--subtle-bg)', 'var(--border)')}
            >
              {selectedGroups.size === visibleScanGroups.length && visibleScanGroups.length > 0 ? 'Deselect All' : `Select All (${visibleScanGroups.length})`}
            </button>
            {selectedGroups.size > 0 && (
              <button onClick={createScanInvoices} disabled={invoicing} style={smallBtn('#fbbf24', 'rgba(251,191,36,0.1)', 'rgba(251,191,36,0.3)')}>
                {invoicing ? 'Creating…' : `Create ${selectedGroups.size} Invoice${selectedGroups.size !== 1 ? 's' : ''} (${selectedScanIds.length} VINs)`}
              </button>
            )}
          </div>

          {visibleScanGroups.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '28px' }}>
              No scanned vehicles ready to invoice.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {visibleScanGroups.map(g => {
                const partCounts: Record<string, number> = {};
                for (const s of g.scans) {
                  const pn = s.part_number || 'No part';
                  partCounts[pn] = (partCounts[pn] || 0) + 1;
                }
                const checked = selectedGroups.has(g.key);
                return (
                  <label key={g.key} style={{ ...card, display: 'flex', alignItems: 'flex-start', gap: '10px', cursor: 'pointer', border: `1px solid ${checked ? 'rgba(251,191,36,0.4)' : 'var(--border)'}` }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroup(g.key)}
                      style={{ cursor: 'pointer', accentColor: '#fbbf24', marginTop: '2px' }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {g.customer}
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600, marginLeft: '8px', fontSize: '11px' }}>
                          {g.po ? `PO #${g.po}` : 'No PO'} · {g.scans.length} VIN{g.scans.length !== 1 ? 's' : ''} · 1 invoice
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                        {Object.entries(partCounts).map(([pn, n]) => `${pn} × ${n}`).join(' · ')}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {sentByCustomer.length === 0 ? (
            <div style={{ ...card, textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', padding: '28px' }}>
              No invoices found.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {sentByCustomer.map(([customer, invs]) => (
                <div key={customer} style={card}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{customer}</div>
                    <button
                      onClick={() => setEmailTarget({
                        customerName: customer,
                        invoices: invs.map(r => ({ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, po: r.po })),
                      })}
                      style={smallBtn('#60a5fa', 'rgba(59,130,246,0.08)', 'rgba(59,130,246,0.25)')}
                    >Email {invs.length} Invoice{invs.length !== 1 ? 's' : ''}</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {invs.map((r, i) => (
                      <div key={`${r.invoiceNumber}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none', flexWrap: 'wrap' }}>
                        <span style={{
                          fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '5px',
                          background: r.source === 'Graphics' ? 'rgba(34,197,94,0.12)' : 'rgba(251,191,36,0.12)',
                          color: r.source === 'Graphics' ? '#22c55e' : '#fbbf24',
                        }}>{r.source}</span>
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>#{r.invoiceNumber}</span>
                        {r.po && <span style={{ color: 'var(--text-muted)' }}>PO #{r.po}</span>}
                        {r.date && <span style={{ color: 'var(--text-muted)' }}>{new Date(r.date).toLocaleDateString()}</span>}
                        {typeof r.amount === 'number' && (
                          <span style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>
                            ${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        )}
                        <span style={{ flex: 1 }} />
                        <button
                          onClick={() => setEmailTarget({
                            customerName: customer,
                            invoices: [{ invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber, po: r.po }],
                          })}
                          style={{ background: 'transparent', border: 'none', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: '2px 4px' }}
                        >Email</button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Graphics review & invoice modal (shared with the Graphics page) */}
      {invoiceJob && (
        <GraphicsInvoiceReviewModal
          job={invoiceJob}
          onClose={() => setInvoiceJob(null)}
          onComplete={async (result) => {
            const job = invoiceJob;
            setInvoiceJob(null);
            if (!job) return;
            // Move the job from "uninvoiced" to "invoiced" locally.
            const updated: GraphicsJob = {
              ...job,
              netsuite_invoice_id: result.invoiceId ?? job.netsuite_invoice_id,
              netsuite_invoice_number: result.invoiceNumber ?? job.netsuite_invoice_number,
              invoice_amount: result.invoiceAmount ?? job.invoice_amount,
              invoiced_at: new Date().toISOString(),
            };
            setUninvoicedJobs(prev => prev.filter(j => j.id !== job.id));
            setInvoicedJobs(prev => [updated, ...prev]);
            // Best-effort: pull the invoice PDF and store it on the record.
            fetch('/api/graphics/invoice-pdf', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: job.id }),
            }).catch(() => {});
            const emailNow = await dialog.confirm(
              `Invoice ${result.invoiceNumber || result.invoiceId || 'created'} in NetSuite.\n\nEmail it to the customer now?`
            );
            if (emailNow) {
              emailForJob(updated, {
                invoiceId: result.invoiceId ?? null,
                invoiceNumber: result.invoiceNumber ?? null,
              });
            }
          }}
        />
      )}

      {/* Shared email modal */}
      {emailTarget && (
        <EmailInvoicesModal
          customerName={emailTarget.customerName}
          invoices={emailTarget.invoices}
          onClose={() => setEmailTarget(null)}
        />
      )}
    </div>
  );
}
