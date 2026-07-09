'use client';

/**
 * The operations dashboard (admin + sales home). Answers two questions —
 * "what needs me today?" and "is the business flowing?" — and every number
 * links to the screen where you act on it.
 *
 * Data sources are the same ones the destination pages use, so the dashboard
 * never disagrees with the screen it links to:
 *  - Invoiced $        → NetSuite via /api/reports/invoiced-summary (same
 *                        line filters as the Sales by Customer report)
 *  - Ready to invoice  → the Invoicing hub's queries (done-status uninvoiced
 *                        graphics jobs + ready scan batches)
 *  - PO backlog        → purchase_orders + po_line_items remaining math
 *  - Triage rows       → the exact queries behind each destination screen
 *  - Top customers     → customers.ytd_spend (synced from NetSuite)
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import type { GraphicsJobStatus } from '@/lib/types';

// Stage buckets over graphics statuses (mirrors the pipeline on /graphics).
const RECEIVED: GraphicsJobStatus[] = ['received', 'designing', 'revision'];
const IN_PRODUCTION: GraphicsJobStatus[] = ['printing', 'outgassing', 'cutting', 'packing'];
const READY_SHIPPED: GraphicsJobStatus[] = ['ready', 'ready_to_pickup', 'shipped', 'picked_up'];
// Billable = physical work done (same DONE set as the Invoicing hub).
const DONE_STATUSES: GraphicsJobStatus[] = ['ready', 'ready_to_pickup', 'shipped', 'picked_up', 'installed'];

interface QueueItem {
  key: string;
  count: number;
  title: string;
  detail: string;
  money?: number;
  tone: 'warn' | 'err' | 'blue';
  path: string;
}

interface ScheduleItem {
  id: string;
  date: string;
  title: string;
  subtitle: string;
  type: 'graphics' | 'upfit' | 'cni';
}

interface DashData {
  invoiced: { total: number; invoices: number; deltaPct: number | null } | null;
  readyToInvoice: { jobs: number; batches: number; oldest: string | null };
  poBacklog: { remaining: number; total: number; count: number };
  pipelineValue: { total: number; deals: number; quotes: number };
  queue: QueueItem[];
  stages: { received: number; inProduction: number; readyShipped: number; toInvoice: number; dueThisWeek: number; rush: number };
  lanes: { gfxActive: number; gfxTop: string | null; shopActive: number; shopStuck: number; cniOpen: number; cniUnassigned: number };
  schedule: ScheduleItem[];
  now: { clockedIn: number; scansToday: number; inShop: number };
  messages: { id: string; sender: string; body: string; ago: string }[];
  sales: {
    stages: { stage: string; label: string; count: number; value: number }[];
    wonValue: number;
    topCustomers: { name: string; ytd: number }[];
    openQuotes: { count: number; value: number };
    estimatesWeek: number;
  };
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : fmtMoney(n));

const timeAgo = (d: string) => {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
};

const OPP_STAGES: { stage: string; label: string }[] = [
  { stage: 'lead', label: 'Lead' },
  { stage: 'quoted', label: 'Quoted' },
  { stage: 'negotiating', label: 'Negotiating' },
];

export default function OpsDashboard() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashData | null>(null);
  const [preset, setPreset] = useState<'ops' | 'sales'>('ops');

  useEffect(() => {
    try {
      const saved = localStorage.getItem('bmg-dash-preset');
      if (saved === 'sales' || saved === 'ops') setPreset(saved);
    } catch {}
  }, []);

  const pickPreset = (p: 'ops' | 'sales') => {
    setPreset(p);
    try { localStorage.setItem('bmg-dash-preset', p); } catch {}
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    const todayStr = new Date().toISOString().split('T')[0];
    const in7 = new Date(); in7.setDate(in7.getDate() + 7);
    const in7Str = in7.toISOString().split('T')[0];
    const todayStart = `${todayStr}T00:00:00`;
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      invoicedRes, gfxRes, scansRes, partsRes, poRes,
      importsRes, photosRes, unpaidRes, usersRes, cniPhotosRes, cniInvRes,
      shopRes, cniRes,
      schedGfxRes, schedUpfitRes, schedCniRes,
      clockRes, scansTodayRes, msgRes,
      oppsRes, custRes, quotesRes, estRes,
    ] = await Promise.allSettled([
      // KPI 1 — NetSuite invoiced totals (authoritative revenue)
      fetch('/api/reports/invoiced-summary').then(r => r.json()),
      // Graphics jobs (all uninvoiced non-cancelled — feeds stages, queue, lanes)
      supabase.from('graphics_jobs')
        .select('id, title, customer, status, priority, due_date, po_number, netsuite_invoice_id, updated_at')
        .neq('status', 'cancelled')
        .is('netsuite_invoice_id', null)
        .limit(2000),
      // Ready-to-invoice scan batches (Invoicing hub semantics)
      supabase.from('scan_logs')
        .select('id, billable_customer, po_id, po_number, part_number, exported_at')
        .is('archived_at', null).is('invoice_number', null).limit(1000),
      supabase.from('netsuite_parts').select('item_number, requires_po_match'),
      // KPI 3 — open PO backlog
      supabase.from('purchase_orders').select('id, po_line_items(quantity, installed, unit_price)').eq('status', 'open'),
      // Queue rows — same queries as each destination screen
      supabase.from('gmail_po_imports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('scanned_vehicles').select('*', { count: 'exact', head: true }).eq('submitted_for_review', true).eq('review_status', 'pending'),
      supabase.from('fleet_checkins').select('*', { count: 'exact', head: true }).not('invoice_number', 'is', null).eq('is_paid', false),
      supabase.from('profiles').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('cni_job_photos').select('*', { count: 'exact', head: true }).eq('review_status', 'pending'),
      supabase.from('cni_jobs').select('*', { count: 'exact', head: true }).eq('invoice_status', 'submitted'),
      // Lanes
      supabase.from('fleet_checkins').select('id, status').in('status', ['received', 'checked_in', 'in_progress', 'stuck_parts', 'stuck_graphics', 'complete']),
      supabase.from('cni_jobs').select('id, status').not('status', 'in', '("closed","cancelled")'),
      // Schedule — next 7 days (same sources as the scheduler widget, 7-day window)
      supabase.from('graphics_jobs')
        .select('id, title, customer, status, scheduled_install_date, quantity')
        .not('scheduled_install_date', 'is', null)
        .gte('scheduled_install_date', todayStr).lte('scheduled_install_date', in7Str)
        .order('scheduled_install_date').limit(10),
      supabase.from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, scheduled_upfit_date')
        .not('scheduled_upfit_date', 'is', null)
        .gte('scheduled_upfit_date', todayStr).lte('scheduled_upfit_date', in7Str)
        .order('scheduled_upfit_date').limit(10),
      supabase.from('cni_jobs')
        .select('id, title, customer_name, deadline')
        .not('deadline', 'is', null).neq('status', 'cancelled')
        .gte('deadline', todayStr).lte('deadline', in7Str)
        .order('deadline').limit(10),
      // Right now
      supabase.from('time_entries').select('*', { count: 'exact', head: true }).is('clock_out', null),
      supabase.from('scan_logs').select('*', { count: 'exact', head: true }).gte('scanned_at', todayStart),
      supabase.from('messages').select('id, body, sender_id, created_at').order('created_at', { ascending: false }).limit(3),
      // Sales
      supabase.from('prospect_opportunities').select('stage, value'),
      supabase.from('customers').select('company_name, ytd_spend').eq('active', true).gt('ytd_spend', 0).order('ytd_spend', { ascending: false }).limit(4),
      supabase.from('quotes').select('total').in('status', ['draft', 'sent', 'pending']),
      supabase.from('estimates').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()),
    ]);

    const val = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
    const count = (r: PromiseSettledResult<any>): number => (r.status === 'fulfilled' ? (r.value?.count || 0) : 0);
    const rows = (r: PromiseSettledResult<any>): any[] => (r.status === 'fulfilled' ? (r.value?.data || []) : []);

    // ── KPI 1: invoiced this month (NetSuite) ──
    const inv = val(invoicedRes) as any;
    const invoiced = inv?.success
      ? {
          total: inv.thisMonth.total,
          invoices: inv.thisMonth.invoices,
          deltaPct: inv.lastMonthToDate.total > 0
            ? Math.round(((inv.thisMonth.total - inv.lastMonthToDate.total) / inv.lastMonthToDate.total) * 100)
            : null,
        }
      : null;

    // ── Graphics jobs → stages + ready-to-invoice + lanes ──
    const gfxJobs = rows(gfxRes);
    const inStatus = (set: GraphicsJobStatus[]) => gfxJobs.filter(j => set.includes(j.status)).length;
    const doneJobs = gfxJobs.filter(j => DONE_STATUSES.includes(j.status));
    const activeGfx = gfxJobs.filter(j => [...RECEIVED, ...IN_PRODUCTION, ...READY_SHIPPED].includes(j.status));
    const dueThisWeek = activeGfx.filter(j => j.due_date && j.due_date <= in7Str && j.due_date >= todayStr).length;
    const rush = activeGfx.filter(j => j.priority === 'rush').length;
    const nextDue = [...activeGfx].filter(j => j.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
    const oldestDone = [...doneJobs].sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))[0];

    // ── Ready-to-invoice scan batches (mirror Invoicing hub grouping) ──
    const poRequired: Record<string, boolean> = {};
    for (const p of rows(partsRes)) poRequired[p.item_number] = p.requires_po_match !== false;
    const readyScans = rows(scansRes).filter(s =>
      !s.exported_at && (s.po_id || poRequired[s.part_number || ''] === false)
    );
    const batchKeys = new Set(readyScans.map(s => `${s.billable_customer || 'Unknown'}|||${s.po_number || 'NO_PO'}`));

    // ── PO backlog ──
    let poRemaining = 0, poTotal = 0;
    const openPos = rows(poRes);
    for (const po of openPos) {
      for (const l of po.po_line_items || []) {
        poTotal += (l.quantity || 0) * (l.unit_price || 0);
        poRemaining += Math.max(0, (l.quantity || 0) - (l.installed || 0)) * (l.unit_price || 0);
      }
    }

    // ── Sales ──
    const opps = rows(oppsRes);
    const stageAgg = OPP_STAGES.map(({ stage, label }) => {
      const inStage = opps.filter((o: any) => o.stage === stage);
      return { stage, label, count: inStage.length, value: inStage.reduce((s: number, o: any) => s + (o.value || 0), 0) };
    });
    const wonValue = opps.filter((o: any) => o.stage === 'won').reduce((s: number, o: any) => s + (o.value || 0), 0);
    const quotes = rows(quotesRes);
    const pipelineTotal = stageAgg.reduce((s, x) => s + x.value, 0);
    const pipelineDeals = stageAgg.reduce((s, x) => s + x.count, 0);

    // ── Queue ──
    const queue: QueueItem[] = [];
    if (doneJobs.length > 0 || batchKeys.size > 0) {
      queue.push({
        key: 'invoice', count: doneJobs.length + batchKeys.size, tone: 'warn', path: '/invoices',
        title: 'Completed work awaiting invoice',
        detail: [
          doneJobs.length ? `${doneJobs.length} graphics job${doneJobs.length !== 1 ? 's' : ''}` : null,
          batchKeys.size ? `${batchKeys.size} scan batch${batchKeys.size !== 1 ? 'es' : ''}` : null,
          oldestDone ? `oldest: ${oldestDone.title || oldestDone.customer || ''}`.trim() : null,
        ].filter(Boolean).join(' · '),
      });
    }
    const pendingImports = count(importsRes);
    if (pendingImports > 0) queue.push({
      key: 'imports', count: pendingImports, tone: 'blue', path: '/admin/pos',
      title: 'Imported POs waiting for review', detail: 'From the email import queue',
    });
    const flagged = gfxJobs.filter(j => j.status === 'flagged');
    if (flagged.length > 0) queue.push({
      key: 'flagged', count: flagged.length, tone: 'err', path: '/graphics',
      title: 'Graphics jobs flagged for review',
      detail: flagged.slice(0, 3).map(j => j.part_number || j.title).filter(Boolean).join(' · '),
    });
    const photos = count(photosRes);
    if (photos > 0) queue.push({
      key: 'photos', count: photos, tone: 'blue', path: '/admin/reviews',
      title: 'Photo sets to review', detail: 'Submitted by installers',
    });
    const unpaid = count(unpaidRes);
    if (unpaid > 0) queue.push({
      key: 'unpaid', count: unpaid, tone: 'warn', path: '/tracking',
      title: 'Vehicles invoiced, awaiting payment', detail: 'From in-shop tracking',
    });
    const cniPhotos = count(cniPhotosRes);
    if (cniPhotos > 0) queue.push({
      key: 'cniphotos', count: cniPhotos, tone: 'blue', path: '/admin/cni',
      title: 'CNI photos to review', detail: 'Network installer submissions',
    });
    const cniInvoices = count(cniInvRes);
    if (cniInvoices > 0) queue.push({
      key: 'cniinv', count: cniInvoices, tone: 'warn', path: '/admin/cni',
      title: 'CNI invoices submitted', detail: 'Waiting on coordinator approval',
    });
    const pendingUsers = count(usersRes);
    if (pendingUsers > 0) queue.push({
      key: 'users', count: pendingUsers, tone: 'blue', path: '/admin/users',
      title: `User${pendingUsers !== 1 ? 's' : ''} waiting for approval`, detail: 'New account requests',
    });

    // ── Lanes ──
    const shopRows = rows(shopRes);
    const cniRows = rows(cniRes);

    // ── Schedule ──
    const schedule: ScheduleItem[] = [];
    for (const g of rows(schedGfxRes)) {
      if (['installed', 'picked_up', 'cancelled'].includes(g.status || '')) continue;
      schedule.push({
        id: g.id, date: g.scheduled_install_date, type: 'graphics',
        title: g.title || 'Graphics install',
        subtitle: `${g.customer || ''}${g.quantity > 1 ? ` · ${g.quantity} units` : ''}`.trim(),
      });
    }
    for (const u of rows(schedUpfitRes)) {
      schedule.push({
        id: u.id, date: u.scheduled_upfit_date, type: 'upfit',
        title: [u.vehicle_year, u.vehicle_make, u.vehicle_model].filter(Boolean).join(' ') || u.vin,
        subtitle: u.customer_name || '',
      });
    }
    for (const c of rows(schedCniRes)) {
      schedule.push({ id: c.id, date: c.deadline, type: 'cni', title: c.title || 'CNI job', subtitle: c.customer_name || '' });
    }
    schedule.sort((a, b) => a.date.localeCompare(b.date));

    // ── Messages ──
    const msgRows = rows(msgRes);
    let senderNames: Record<string, string> = {};
    if (msgRows.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name')
        .in('id', [...new Set(msgRows.map((m: any) => m.sender_id))]);
      for (const p of profs || []) senderNames[p.id] = p.full_name;
    }

    setData({
      invoiced,
      readyToInvoice: {
        jobs: doneJobs.length, batches: batchKeys.size,
        oldest: oldestDone ? (oldestDone.title || oldestDone.customer || null) : null,
      },
      poBacklog: { remaining: poRemaining, total: poTotal, count: openPos.length },
      pipelineValue: { total: pipelineTotal, deals: pipelineDeals, quotes: quotes.length },
      queue,
      stages: {
        received: inStatus(RECEIVED),
        inProduction: inStatus(IN_PRODUCTION),
        readyShipped: inStatus(READY_SHIPPED),
        toInvoice: doneJobs.length + batchKeys.size,
        dueThisWeek, rush,
      },
      lanes: {
        gfxActive: activeGfx.length,
        gfxTop: nextDue ? `${nextDue.customer || nextDue.title || ''} — due ${nextDue.due_date}` : null,
        shopActive: shopRows.length,
        shopStuck: shopRows.filter((s: any) => String(s.status).startsWith('stuck')).length,
        cniOpen: cniRows.length,
        cniUnassigned: cniRows.filter((c: any) => c.status === 'unassigned').length,
      },
      schedule: schedule.slice(0, 6),
      now: { clockedIn: count(clockRes), scansToday: count(scansTodayRes), inShop: shopRows.length },
      messages: msgRows.map((m: any) => ({
        id: m.id, sender: senderNames[m.sender_id] || 'Unknown',
        body: m.body || '', ago: timeAgo(m.created_at),
      })),
      sales: {
        stages: stageAgg, wonValue,
        topCustomers: rows(custRes).map((c: any) => ({ name: c.company_name, ytd: Number(c.ytd_spend) || 0 })),
        openQuotes: { count: quotes.length, value: quotes.reduce((s: number, q: any) => s + (q.total || 0), 0) },
        estimatesWeek: count(estRes),
      },
    });
    setLoading(false);
  };

  // ── Styles ──
  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' };
  const cardHead: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 10px' };
  const headTitle: React.CSSProperties = { margin: 0, fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-secondary)' };
  const headLink: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 };
  const toneStyles: Record<QueueItem['tone'], { bg: string; color: string }> = {
    warn: { bg: 'var(--warning-bg)', color: 'var(--warning)' },
    err: { bg: 'var(--error-bg)', color: 'var(--error)' },
    blue: { bg: 'rgba(96,165,250,0.1)', color: '#60a5fa' },
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '36px', height: '36px', border: '3px solid var(--border)', borderTopColor: 'var(--orange)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ color: 'var(--text-muted)', marginTop: '12px', fontSize: '12px', fontWeight: 600 }}>Loading dashboard…</div>
      </div>
    );
  }
  if (!data) return null;

  const d = data;
  const today = new Date();

  const kpis = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px', marginBottom: '12px' }}>
      <button onClick={() => router.push('/admin/reports')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>
          Invoiced · {today.toLocaleDateString('en-US', { month: 'long' })}
        </div>
        <div style={{ fontSize: '25px', fontWeight: 800, letterSpacing: '-0.5px', marginTop: '4px', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {d.invoiced ? fmtMoney(d.invoiced.total) : '—'}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {d.invoiced
            ? <>{d.invoiced.deltaPct !== null && (
                <span style={{ color: d.invoiced.deltaPct >= 0 ? 'var(--success)' : 'var(--error)', fontWeight: 700 }}>
                  {d.invoiced.deltaPct >= 0 ? '▲' : '▼'} {Math.abs(d.invoiced.deltaPct)}%
                </span>
              )} {d.invoiced.deltaPct !== null ? 'vs last month · ' : ''}{d.invoiced.invoices} invoices · NetSuite</>
            : 'NetSuite unavailable'}
        </div>
      </button>
      <button onClick={() => router.push('/invoices')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>Ready to invoice</div>
        <div style={{ fontSize: '25px', fontWeight: 800, letterSpacing: '-0.5px', marginTop: '4px', color: d.stages.toInvoice > 0 ? 'var(--warning)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {d.stages.toInvoice}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {d.readyToInvoice.jobs} graphics job{d.readyToInvoice.jobs !== 1 ? 's' : ''} · {d.readyToInvoice.batches} scan batch{d.readyToInvoice.batches !== 1 ? 'es' : ''}
        </div>
      </button>
      <button onClick={() => router.push('/admin/pos')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>Open PO backlog</div>
        <div style={{ fontSize: '25px', fontWeight: 800, letterSpacing: '-0.5px', marginTop: '4px', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMoney(d.poBacklog.remaining)}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {d.poBacklog.count} open POs{d.poBacklog.total > 0 ? ` · ${Math.round(((d.poBacklog.total - d.poBacklog.remaining) / d.poBacklog.total) * 100)}% delivered` : ''}
        </div>
      </button>
      <button onClick={() => router.push('/admin/prospects')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
        <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.7px', color: 'var(--text-muted)' }}>Sales pipeline</div>
        <div style={{ fontSize: '25px', fontWeight: 800, letterSpacing: '-0.5px', marginTop: '4px', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMoney(d.pipelineValue.total)}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {d.pipelineValue.deals} deals · {d.pipelineValue.quotes} open quotes
        </div>
      </button>
    </div>
  );

  const needsAttention = (
    <div style={card}>
      <div style={cardHead}>
        <h2 style={headTitle}>Needs attention</h2>
        <span style={{ fontSize: '11px', fontWeight: 700, color: d.queue.length > 0 ? 'var(--warning)' : 'var(--success)' }}>
          {d.queue.length > 0 ? `${d.queue.length} item${d.queue.length !== 1 ? 's' : ''}` : 'All clear'}
        </span>
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {d.queue.length === 0 && (
          <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: '13px', fontWeight: 700, color: 'var(--success)' }}>
            Nothing needs you — all caught up.
          </div>
        )}
        {d.queue.map(q => (
          <button key={q.key} onClick={() => router.push(q.path)} style={{
            display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 16px', width: '100%',
            borderBottom: '1px solid var(--border)', background: 'transparent', border: 'none',
            borderTop: 'none', borderLeft: 'none', borderRight: 'none', cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{
              minWidth: '34px', height: '26px', borderRadius: '7px', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '13px', fontWeight: 800, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
              background: toneStyles[q.tone].bg, color: toneStyles[q.tone].color,
            }}>{q.count}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{q.title}</span>
              <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.detail}</span>
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '15px' }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );

  const stageDefs = [
    { n: d.poBacklog.count, l: 'POs open', m: `${fmtK(d.poBacklog.remaining)} remaining`, color: '#60a5fa', path: '/admin/pos' },
    { n: d.stages.received, l: 'Received', m: `${d.stages.dueThisWeek} due this week`, color: '#a78bfa', path: '/graphics' },
    { n: d.stages.inProduction, l: 'In production', m: d.stages.rush > 0 ? `${d.stages.rush} rush` : 'no rush jobs', color: 'var(--warning)', path: '/graphics' },
    { n: d.stages.readyShipped, l: 'Ready / shipped', m: 'awaiting install or pickup', color: 'var(--success)', path: '/graphics' },
    { n: d.stages.toInvoice, l: 'To invoice', m: `${d.readyToInvoice.batches} scan batches too`, color: 'var(--orange)', path: '/invoices' },
  ];
  const maxStage = Math.max(1, ...stageDefs.map(s => s.n));

  const workInMotion = (
    <div style={card}>
      <div style={cardHead}>
        <h2 style={headTitle}>Work in motion</h2>
        <button onClick={() => router.push('/graphics')} style={headLink}>{d.lanes.gfxActive} active jobs →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', padding: '2px 8px 12px' }}>
        {stageDefs.map((s, i) => (
          <button key={s.l} onClick={() => router.push(s.path)} style={{ padding: '8px 10px', borderRadius: '8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', position: 'relative' }}>
            {i > 0 && <span style={{ position: 'absolute', left: '-4px', top: '38%', color: 'var(--text-muted)', opacity: 0.6, fontSize: '14px' }}>›</span>}
            <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
            <div style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginTop: '1px' }}>{s.l}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.m}</div>
            <div style={{ height: '3px', borderRadius: '2px', marginTop: '7px', background: 'var(--progress-track)' }}>
              <div style={{ height: '100%', borderRadius: '2px', width: `${Math.round((s.n / maxStage) * 100)}%`, background: s.color }} />
            </div>
          </button>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {([
          { tag: 'GFX', tagBg: 'var(--success-bg)', tagColor: 'var(--success)', path: '/graphics',
            who: d.lanes.gfxTop || `${d.lanes.gfxActive} active graphics jobs`,
            st: `${d.lanes.gfxActive} active · ${d.stages.rush} rush`,
            dot: d.stages.rush > 0 ? 'var(--warning)' : 'var(--success)' },
          { tag: 'SHOP', tagBg: 'rgba(96,165,250,0.1)', tagColor: '#60a5fa', path: '/tracking',
            who: `${d.lanes.shopActive} vehicle${d.lanes.shopActive !== 1 ? 's' : ''} in shop`,
            st: d.lanes.shopStuck > 0 ? `${d.lanes.shopStuck} stuck` : 'none stuck',
            dot: d.lanes.shopStuck > 0 ? 'var(--error)' : 'var(--success)' },
          { tag: 'CNI', tagBg: 'rgba(167,139,250,0.1)', tagColor: '#a78bfa', path: '/admin/cni',
            who: `${d.lanes.cniOpen} network install${d.lanes.cniOpen !== 1 ? 's' : ''} open`,
            st: d.lanes.cniUnassigned > 0 ? `${d.lanes.cniUnassigned} unassigned` : 'all assigned',
            dot: d.lanes.cniUnassigned > 0 ? '#60a5fa' : 'var(--success)' },
        ]).map(lane => (
          <button key={lane.tag} onClick={() => router.push(lane.path)} style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 16px', width: '100%',
            background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{ fontSize: '9px', fontWeight: 800, letterSpacing: '0.5px', padding: '2px 7px', borderRadius: '5px', flexShrink: 0, width: '44px', textAlign: 'center', background: lane.tagBg, color: lane.tagColor }}>{lane.tag}</span>
            <span style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{lane.who}</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{lane.st}</span>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0, background: lane.dot }} />
          </button>
        ))}
      </div>
    </div>
  );

  const salesBand = (
    <div style={card}>
      <div style={cardHead}>
        <h2 style={headTitle}>Sales</h2>
        <button onClick={() => router.push('/admin/prospects')} style={headLink}>CRM →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', borderTop: '1px solid var(--border)' }}>
        <div style={{ padding: '12px 16px', borderRight: '1px solid var(--border)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Pipeline by stage</div>
          {d.sales.stages.map(s => (
            <div key={s.stage} style={{ marginBottom: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{s.label} ({s.count})</span>
                <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{fmtK(s.value)}</span>
              </div>
              <div style={{ height: '4px', background: 'var(--progress-track)', borderRadius: '2px', marginTop: '2px' }}>
                <div style={{ height: '100%', borderRadius: '2px', background: '#60a5fa', width: `${d.pipelineValue.total > 0 ? Math.round((s.value / d.pipelineValue.total) * 100) : 0}%` }} />
              </div>
            </div>
          ))}
          {d.sales.wonValue > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginTop: '8px' }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Won (all time)</span>
              <span style={{ fontWeight: 800, color: 'var(--success)' }}>{fmtK(d.sales.wonValue)}</span>
            </div>
          )}
        </div>
        <button onClick={() => router.push('/admin/prospects')} style={{ padding: '12px 16px', borderRight: '1px solid var(--border)', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Top customers · YTD (NetSuite)</div>
          {d.sales.topCustomers.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No YTD spend synced yet</div>}
          {d.sales.topCustomers.map(c => (
            <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', padding: '3px 0', fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '8px' }}>{c.name}</span>
              <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{fmtK(c.ytd)}</span>
            </div>
          ))}
        </button>
        <div style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Quotes &amp; estimates</div>
          <button onClick={() => router.push('/admin/quotes')} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '12px', padding: '3px 0', background: 'none', border: 'none', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Open quotes</span>
            <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{d.sales.openQuotes.count} · {fmtK(d.sales.openQuotes.value)}</span>
          </button>
          <button onClick={() => router.push('/estimates')} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '12px', padding: '3px 0', background: 'none', border: 'none', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Estimates this week</span>
            <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{d.sales.estimatesWeek}</span>
          </button>
        </div>
      </div>
    </div>
  );

  const schedRow = (item: ScheduleItem) => {
    const dt = new Date(item.date + 'T12:00:00');
    const tagColors: Record<ScheduleItem['type'], string> = { graphics: 'var(--success)', upfit: '#60a5fa', cni: '#a78bfa' };
    const tagLabels: Record<ScheduleItem['type'], string> = { graphics: 'GFX', upfit: 'SHOP', cni: 'CNI' };
    const goTo = () => {
      if (item.type === 'graphics') router.push(`/graphics?id=${item.id}`);
      else if (item.type === 'upfit') router.push('/tracking');
      else router.push(`/admin/cni/jobs/${item.id}`);
    };
    return (
      <button key={`${item.type}-${item.id}`} onClick={goTo} style={{
        display: 'flex', gap: '10px', alignItems: 'center', padding: '9px 16px', width: '100%',
        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
      }}>
        <span style={{ width: '40px', textAlign: 'center', flexShrink: 0 }}>
          <span style={{ display: 'block', fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)' }}>
            {dt.toLocaleDateString('en-US', { weekday: 'short' })}
          </span>
          <span style={{ display: 'block', fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{dt.getDate()}</span>
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
          <span style={{ display: 'block', fontSize: '10.5px', color: 'var(--text-muted)' }}>
            <b style={{ color: tagColors[item.type] }}>{tagLabels[item.type]}</b>{item.subtitle ? ` · ${item.subtitle}` : ''}
          </span>
        </span>
      </button>
    );
  };

  const rightRail = (
    <div style={{ display: 'grid', gap: '12px', alignContent: 'start' }}>
      <div style={card}>
        <div style={cardHead}>
          <h2 style={headTitle}>Next 7 days</h2>
          <button onClick={() => router.push('/admin/schedule')} style={headLink}>Schedule →</button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {d.schedule.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Nothing scheduled in the next 7 days</div>
          )}
          {d.schedule.map(schedRow)}
        </div>
      </div>
      <div style={card}>
        <div style={cardHead}><h2 style={headTitle}>Right now</h2></div>
        <div style={{ display: 'flex', gap: '10px', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
          {([
            { n: d.now.clockedIn, l: 'Clocked in', path: '/time' },
            { n: d.now.scansToday, l: 'Scans today', path: '/admin/scans' },
            { n: d.now.inShop, l: 'In shop', path: '/tracking' },
          ]).map(p => (
            <button key={p.l} onClick={() => router.push(p.path)} style={{ flex: 1, background: 'var(--subtle-bg)', borderRadius: '9px', padding: '9px 11px', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{p.n}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>{p.l}</div>
            </button>
          ))}
        </div>
      </div>
      <div style={card}>
        <div style={cardHead}>
          <h2 style={headTitle}>Messages</h2>
          <button onClick={() => router.push('/messages')} style={headLink}>All →</button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {d.messages.length === 0 && (
            <div style={{ padding: '14px 16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>No messages yet</div>
          )}
          {d.messages.map(m => (
            <button key={m.id} onClick={() => router.push('/messages')} style={{
              display: 'flex', gap: '9px', padding: '9px 16px', width: '100%', background: 'transparent',
              border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
            }}>
              <span style={{
                width: '26px', height: '26px', borderRadius: '50%', background: 'rgba(96,165,250,0.1)', color: '#60a5fa',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800, flexShrink: 0,
              }}>{m.sender.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: '11.5px', fontWeight: 700, color: 'var(--text-primary)' }}>{m.sender} · {m.ago}</span>
                <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.body}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const leftColumn = preset === 'sales'
    ? [salesBand, needsAttention, workInMotion]
    : [needsAttention, workInMotion, salesBand];

  return (
    <div>
      {/* Page head */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '19px', fontWeight: 800, letterSpacing: '-0.2px', color: 'var(--text-primary)' }}>
            {today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            {d.queue.length > 0 ? `${d.queue.length} item${d.queue.length !== 1 ? 's' : ''} need attention` : 'Nothing needs attention'}
            {' · '}{d.lanes.gfxActive + d.lanes.shopActive + d.lanes.cniOpen} jobs in motion
            {d.stages.toInvoice > 0 ? ` · ${d.stages.toInvoice} ready to invoice` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['ops', 'sales'] as const).map(p => (
            <button key={p} onClick={() => pickPreset(p)} style={{
              fontSize: '11px', fontWeight: 700, padding: '5px 12px', borderRadius: '8px', cursor: 'pointer',
              border: preset === p ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
              background: preset === p ? 'var(--tab-active-bg)' : 'transparent',
              color: preset === p ? 'var(--orange)' : 'var(--text-muted)',
            }}>{p === 'ops' ? 'Operations' : 'Sales'}</button>
          ))}
        </div>
      </div>

      {kpis}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)', gap: '12px', alignItems: 'start' }} className="dash-cols">
        <div style={{ display: 'grid', gap: '12px' }}>
          {leftColumn.map((el, i) => <div key={i}>{el}</div>)}
        </div>
        {rightRail}
      </div>

      <style>{`@media (max-width: 860px) { .dash-cols { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
