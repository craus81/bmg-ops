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
import { useAuth } from '@/components/AuthProvider';
import RecentActivity from '@/components/RecentActivity';
import type { GraphicsJobStatus } from '@/lib/types';
import { fetchAllRows } from '@/lib/fetch-all';
import { customerRequiresPo, loadBillableCustomers } from '@/lib/billable-customers';

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
  type: 'graphics' | 'upfit' | 'cni' | 'event';
}

interface DashData {
  invoiced: { total: number; invoices: number; deltaPct: number | null } | null;
  readyToInvoice: { jobs: number; batches: number; oldest: string | null };
  poBacklog: { remaining: number; total: number; count: number };
  pipelineValue: { total: number; deals: number; quotes: number };
  queue: QueueItem[];
  stages: { received: number; inProduction: number; readyShipped: number; toInvoice: number; dueThisWeek: number; rush: number };
  lanes: { gfxActive: number; gfxTop: string | null; shopActive: number; shopStuck: number; cniOpen: number; cniUnassigned: number };
  upfit: { received: number; inProgress: number; stuck: number; complete: number; unpaid: number };
  schedule: ScheduleItem[];
  now: { scansToday: number; scansWeek: number; inShop: number };
  messages: { id: string; sender: string; body: string; ago: string }[];
  unread: { id: string; title: string; body: string; url: string | null; ago: string }[];
  sales: {
    stages: { stage: string; label: string; count: number; value: number }[];
    wonValue: number;
    topCustomers: { name: string; ytd: number; nsId: string | null }[];
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
  const { user, isAdmin, hasFeature } = useAuth();
  const supabase = createClient();

  // The dashboard renders for every role that lands on /home (sales, finance,
  // …), but its links point at feature-gated pages that bounce back here —
  // so every navigation goes through one gate map. canOpen() decides whether
  // a control renders/navigates; go() is the click handler. Paths not listed
  // are open to anyone who can see the dashboard.
  const canOpen = (path: string): boolean => {
    if (path.startsWith('/tracking')) return hasFeature('in_shop') || hasFeature('fleet_checkin');
    if (path.startsWith('/admin/scans')) return hasFeature('reports');
    if (path.startsWith('/admin/schedule')) return hasFeature('schedule');
    if (path.startsWith('/admin/cni')) return hasFeature('cni_admin');
    if (path.startsWith('/upfit')) return hasFeature('upfit_projects');
    return true;
  };
  const go = (path: string) => { if (canOpen(path)) router.push(path); };
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<DashData | null>(null);
  const [preset, setPreset] = useState<'ops' | 'sales'>('ops');
  const [unreadExpanded, setUnreadExpanded] = useState(false);

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
    // Scan counts use LOCAL midnight, not UTC — "today" means the user's day.
    const localMidnight = new Date(); localMidnight.setHours(0, 0, 0, 0);
    const todayStart = localMidnight.toISOString();
    const weekStart = new Date(localMidnight); weekStart.setDate(weekStart.getDate() - 6);
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      invoicedRes, gfxRes, scansRes, partsRes, poRes,
      importsRes, unpaidRes, usersRes, cniPhotosRes, cniInvRes,
      shopRes, cniRes,
      schedGfxRes, schedUpfitRes, schedCniRes, schedEventsRes,
      scansTodayRes, scansWeekRes, msgRes, unreadRes,
      oppsRes, custRes, quotesRes, estRes, unpricedRes,
      apSubmittedRes, sentEstRes, sentWrapRes, staleProofRes, healthRes, atRiskRes,
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
      // Paginated: a truncated map counts no-PO parts past the 1000-row cap
      // as "waiting on a PO" and skews the queue/batch numbers.
      fetchAllRows<{ item_number: string; requires_po_match: boolean | null }>((from, to) =>
        supabase.from('netsuite_parts').select('item_number, requires_po_match').order('id').range(from, to)),
      // KPI 3 — open PO backlog
      supabase.from('purchase_orders').select('id, po_line_items(quantity, installed, unit_price)').eq('status', 'open'),
      // Queue rows — same queries as each destination screen
      supabase.from('gmail_po_imports').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
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
      // Manual calendar entries created on the Schedule page (admins see all,
      // like the schedule page itself; others see their own).
      (isAdmin
        ? supabase.from('calendar_events').select('id, title, description, event_date')
        : supabase.from('calendar_events').select('id, title, description, event_date').eq('user_id', user?.id || '')
      ).is('completed_at', null).gte('event_date', todayStr).lte('event_date', in7Str).order('event_date').limit(10),
      // Right now
      supabase.from('scan_logs').select('*', { count: 'exact', head: true }).gte('scanned_at', todayStart),
      supabase.from('scan_logs').select('*', { count: 'exact', head: true }).gte('scanned_at', weekStart.toISOString()),
      supabase.from('messages').select('id, body, sender_id, created_at').order('created_at', { ascending: false }).limit(3),
      // Unread notifications for the "New for you" strip — same rows as the
      // bell, but only the ones not yet read/acted on. Load a generous batch:
      // the strip shows 5 with a "show all" toggle, and dismissal only ever
      // touches loaded rows, so nothing unseen can be marked read.
      supabase.from('notifications').select('id, title, body, url, created_at')
        .eq('user_id', user?.id || '').is('read_at', null)
        .order('created_at', { ascending: false }).limit(50),
      // Sales
      supabase.from('prospect_opportunities').select('stage, value'),
      supabase.from('customers').select('netsuite_id, company_name, ytd_spend').eq('active', true).gt('ytd_spend', 0).order('ytd_spend', { ascending: false }).limit(4),
      supabase.from('wrap_quotes').select('total').in('status', ['draft', 'sent']),
      supabase.from('estimates').select('*', { count: 'exact', head: true }).gte('created_at', weekAgo.toISOString()),
      // Unpriced pay — credits with no dollar amount. Accumulating unseen is
      // how someone works for weeks before anyone notices they're unpaid.
      supabase.from('install_credits').select('*', { count: 'exact', head: true }).is('amount', null).is('voided_at', null),
      // Remaining needs-attention queues — payments, quiet quotes, stalled
      // proofs, plus admin-only API checks (at-risk, system health).
      supabase.from('vendor_invoices').select('*', { count: 'exact', head: true }).eq('status', 'submitted'),
      supabase.from('estimates').select('id, sent_for_approval_at, updated_at, last_followup_at').eq('status', 'sent').limit(500),
      supabase.from('wrap_quotes').select('id, sent_at, last_followup_at').eq('status', 'sent').is('archived_at', null).limit(500),
      supabase.from('graphics_jobs').select('*', { count: 'exact', head: true })
        .eq('customer_approved', false).is('customer_rejected_at', null)
        .not('sent_for_approval_at', 'is', null)
        .lte('sent_for_approval_at', new Date(Date.now() - 3 * 86_400_000).toISOString())
        .not('status', 'in', '("cancelled","shipped","picked_up","installed")'),
      isAdmin ? fetch('/api/system-health').then(r => r.ok ? r.json() : null) : Promise.resolve(null),
      isAdmin ? fetch('/api/reports/at-risk').then(r => r.ok ? r.json() : null) : Promise.resolve(null),
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
    // Invoice-first customers (billable_customers.requires_po = FALSE, e.g.
    // Reading Truck) count as ready without a PO — matching the Invoicing hub.
    const billableCustomers = await loadBillableCustomers(supabase);
    const readyScans = rows(scansRes).filter(s =>
      !s.exported_at && (s.po_id || poRequired[s.part_number || ''] === false
        || !customerRequiresPo(s.billable_customer, billableCustomers))
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
    if (pendingUsers > 0 && hasFeature('user_management')) queue.push({
      key: 'users', count: pendingUsers, tone: 'blue', path: '/admin/users',
      title: `User${pendingUsers !== 1 ? 's' : ''} waiting for approval`, detail: 'New account requests',
    });
    const unpricedPay = count(unpricedRes);
    if (unpricedPay > 0) queue.push({
      key: 'unpriced', count: unpricedPay, tone: 'warn', path: '/admin/pay-rates',
      title: 'Pay credits without a dollar amount',
      detail: 'Someone worked; nobody priced it yet',
    });
    const apSubmitted = count(apSubmittedRes);
    if (apSubmitted > 0) queue.push({
      key: 'ap', count: apSubmitted, tone: 'warn', path: '/admin/ap',
      title: 'Vendor payments awaiting approval', detail: 'CNI invoices submitted for payment',
    });
    // Quotes quiet 5+ days since the last touch (send or logged follow-up).
    const quietCutoff = Date.now() - 5 * 86_400_000;
    const quoteQuiet = (sentAt: string | null, followUp: string | null) => {
      const ref = Math.max(sentAt ? new Date(sentAt).getTime() : 0, followUp ? new Date(followUp).getTime() : 0);
      return ref > 0 && ref < quietCutoff;
    };
    const quietQuotes =
      rows(sentEstRes).filter(e => quoteQuiet(e.sent_for_approval_at || e.updated_at, e.last_followup_at)).length +
      rows(sentWrapRes).filter(w => quoteQuiet(w.sent_at, w.last_followup_at)).length;
    if (quietQuotes > 0) queue.push({
      key: 'quotes', count: quietQuotes, tone: 'warn', path: '/quotes',
      title: 'Quotes needing a follow-up', detail: 'Sent 5+ days ago with no answer',
    });
    const staleProofs = count(staleProofRes);
    if (staleProofs > 0) queue.push({
      key: 'proofs', count: staleProofs, tone: 'warn', path: '/graphics',
      title: 'Proofs stuck with customers 3+ days', detail: 'Production blocked on approval',
    });
    // Scans stuck waiting on a PO (part requires one, none matched yet).
    const waitingPo = rows(scansRes).filter(s =>
      !s.po_id && !s.exported_at && poRequired[s.part_number || ''] !== false
    ).length;
    if (waitingPo > 0) queue.push({
      key: 'waitingpo', count: waitingPo, tone: 'blue', path: '/admin/scans',
      title: 'Scans waiting on a PO', detail: 'Auto-matcher retries as POs import',
    });
    const health = val(healthRes) as any;
    const badJobs = (health?.checks || []).filter((c: any) => c.status === 'error' || c.status === 'stale').length;
    if (badJobs > 0 && hasFeature('system_health')) queue.push({
      key: 'health', count: badJobs, tone: 'err', path: '/admin/system-health',
      title: 'Background jobs down', detail: 'Syncs or crons stale/erroring',
    });
    const atRisk = val(atRiskRes) as any;
    const atRiskCount = (atRisk?.flagged || []).length;
    if (atRiskCount > 0) queue.push({
      key: 'atrisk', count: atRiskCount, tone: 'warn', path: '/admin/reports/at-risk',
      title: 'At-risk accounts gone quiet', detail: 'Big spenders behind pace — worth a call',
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
    for (const e of rows(schedEventsRes)) {
      schedule.push({ id: e.id, date: e.event_date, type: 'event', title: e.title || 'Calendar event', subtitle: e.description || '' });
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
      upfit: {
        received: shopRows.filter((s: any) => s.status === 'received' || s.status === 'checked_in').length,
        inProgress: shopRows.filter((s: any) => s.status === 'in_progress').length,
        stuck: shopRows.filter((s: any) => String(s.status).startsWith('stuck')).length,
        complete: shopRows.filter((s: any) => s.status === 'complete').length,
        unpaid,
      },
      schedule: schedule.slice(0, 7),
      now: { scansToday: count(scansTodayRes), scansWeek: count(scansWeekRes), inShop: shopRows.length },
      messages: msgRows.map((m: any) => ({
        id: m.id, sender: senderNames[m.sender_id] || 'Unknown',
        body: m.body || '', ago: timeAgo(m.created_at),
      })),
      unread: rows(unreadRes).map((n: any) => ({
        id: n.id, title: n.title || 'Notification', body: n.body || '',
        url: n.url || null, ago: timeAgo(n.created_at),
      })),
      sales: {
        stages: stageAgg, wonValue,
        topCustomers: rows(custRes).map((c: any) => ({ name: c.company_name, ytd: Number(c.ytd_spend) || 0, nsId: c.netsuite_id ? String(c.netsuite_id) : null })),
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

  // "New for you": unread notifications act on click — open the deep link and
  // mark read, so the strip drains itself and disappears when nothing's new.
  // Chat notifications clear as a group: every message in a conversation
  // notifies separately, but opening the chat reads them all, so one click
  // drains every notification pointing at that conversation.
  const openUnread = async (n: { id: string; url: string | null }) => {
    const isChat = !!n.url && n.url.startsWith('/messages?conversation=');
    const ids = isChat ? d.unread.filter(u => u.url === n.url).map(u => u.id) : [n.id];
    setData(prev => prev ? { ...prev, unread: prev.unread.filter(u => !ids.includes(u.id)) } : prev);
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids);
    if (n.url) router.push(n.url);
  };
  // Dismiss only what's on screen — never notifications the user hasn't seen.
  const dismissVisibleUnread = async (visible: DashData['unread']) => {
    const ids = visible.map(u => u.id);
    setData(prev => prev ? { ...prev, unread: prev.unread.filter(u => !ids.includes(u.id)) } : prev);
    await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .in('id', ids);
  };

  const visibleUnread = unreadExpanded ? d.unread : d.unread.slice(0, 5);
  const hiddenUnread = d.unread.length - visibleUnread.length;

  const newForYou = d.unread.length === 0 ? null : (
    <div style={{ ...card, marginBottom: '12px', border: '1px solid rgba(238,49,32,0.25)' }}>
      <div style={{ ...cardHead, paddingBottom: '6px' }}>
        <h2 style={{ ...headTitle, color: 'var(--orange)' }}>New for you</h2>
        <button onClick={() => dismissVisibleUnread(visibleUnread)} style={{ ...headLink, color: 'var(--text-muted)' }}>
          {hiddenUnread > 0 ? `Dismiss these ${visibleUnread.length}` : 'Dismiss all'}
        </button>
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {visibleUnread.map(n => (
          <button key={n.id} onClick={() => openUnread(n)} style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 16px', width: '100%',
            background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)',
            cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--orange)', flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title}</span>
              {n.body && <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</span>}
            </span>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{n.ago}</span>
            {/* Chevron only when the click actually navigates — a url-less
                row is dismiss-only and shouldn't promise a destination. */}
            {n.url && <span style={{ color: 'var(--text-muted)', fontSize: '15px' }}>›</span>}
          </button>
        ))}
        {(hiddenUnread > 0 || unreadExpanded) && (
          <button
            onClick={() => setUnreadExpanded(v => !v)}
            style={{
              display: 'block', width: '100%', padding: '8px 16px', background: 'transparent',
              border: 'none', cursor: 'pointer', textAlign: 'center',
              fontSize: '11.5px', fontWeight: 700, color: 'var(--orange)',
            }}
          >
            {unreadExpanded ? 'Show less' : `Show ${hiddenUnread} more`}
          </button>
        )}
      </div>
    </div>
  );

  const kpis = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px', marginBottom: '12px' }}>
      <button onClick={() => router.push('/invoices?tab=sent')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
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
      <button onClick={() => router.push('/admin/prospects?stage=open')} style={{ ...card, textAlign: 'left', padding: '14px 16px 12px', cursor: 'pointer' }}>
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
        {d.queue.filter(q => canOpen(q.path)).map(q => (
          <button key={q.key} onClick={() => go(q.path)} style={{
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
        <h2 style={headTitle}>Graphics — work in motion</h2>
        <button onClick={() => router.push('/graphics')} style={headLink}>{d.lanes.gfxActive} active jobs →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', padding: '2px 8px 12px' }}>
        {stageDefs.map((s, i) => (
          <button key={s.l} onClick={() => go(s.path)} style={{ padding: '8px 10px', borderRadius: '8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', position: 'relative' }}>
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
          { tag: 'NEXT', tagBg: 'var(--success-bg)', tagColor: 'var(--success)', path: '/graphics',
            who: d.lanes.gfxTop || `${d.lanes.gfxActive} active graphics jobs`,
            st: `${d.lanes.gfxActive} active · ${d.stages.rush} rush`,
            dot: d.stages.rush > 0 ? 'var(--warning)' : 'var(--success)' },
        ]).map(lane => (
          <button key={lane.tag} onClick={() => go(lane.path)} style={{
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

  const upfitStages = [
    { n: d.upfit.received, l: 'Received', color: '#60a5fa' },
    { n: d.upfit.inProgress, l: 'In progress', color: 'var(--warning)' },
    { n: d.upfit.stuck, l: 'Stuck', color: 'var(--error)' },
    { n: d.upfit.complete, l: 'Complete', color: 'var(--success)' },
  ];
  const maxUpfit = Math.max(1, ...upfitStages.map(s => s.n));

  const upfitGlance = (
    <div style={card}>
      <div style={cardHead}>
        <h2 style={headTitle}>Upfit — at a glance</h2>
        {canOpen('/tracking') ? <button onClick={() => go('/tracking')} style={headLink}>{d.lanes.shopActive} in shop →</button> : <span style={{ ...headLink, cursor: 'default' }}>{d.lanes.shopActive} in shop</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', padding: '2px 8px 12px' }}>
        {upfitStages.map((s, i) => (
          <button key={s.l} onClick={() => go('/tracking')} style={{ padding: '8px 10px', borderRadius: '8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', position: 'relative' }}>
            {i > 0 && <span style={{ position: 'absolute', left: '-4px', top: '38%', color: 'var(--text-muted)', opacity: 0.6, fontSize: '14px' }}>›</span>}
            <div style={{ fontSize: '20px', fontWeight: 800, color: s.l === 'Stuck' && s.n > 0 ? 'var(--error)' : 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
            <div style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginTop: '1px' }}>{s.l}</div>
            <div style={{ height: '3px', borderRadius: '2px', marginTop: '7px', background: 'var(--progress-track)' }}>
              <div style={{ height: '100%', borderRadius: '2px', width: `${Math.round((s.n / maxUpfit) * 100)}%`, background: s.color }} />
            </div>
          </button>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)' }}>
        {([
          { tag: 'PAY', tagBg: 'var(--warning-bg)', tagColor: 'var(--warning)', path: '/tracking',
            who: d.upfit.unpaid > 0 ? `${d.upfit.unpaid} vehicle${d.upfit.unpaid !== 1 ? 's' : ''} invoiced, awaiting payment` : 'No vehicles awaiting payment',
            st: '', dot: d.upfit.unpaid > 0 ? 'var(--warning)' : 'var(--success)' },
          { tag: 'CNI', tagBg: 'rgba(167,139,250,0.1)', tagColor: '#a78bfa', path: '/admin/cni',
            who: `${d.lanes.cniOpen} network install${d.lanes.cniOpen !== 1 ? 's' : ''} open`,
            st: d.lanes.cniUnassigned > 0 ? `${d.lanes.cniUnassigned} unassigned` : 'all assigned',
            dot: d.lanes.cniUnassigned > 0 ? '#60a5fa' : 'var(--success)' },
        ]).map(lane => (
          <button key={lane.tag} onClick={() => go(lane.path)} style={{
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
        <button onClick={() => router.push('/admin/prospects')} style={headLink}>Customers →</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', borderTop: '1px solid var(--border)' }}>
        <div style={{ padding: '12px 16px', borderRight: '1px solid var(--border)' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Pipeline by stage</div>
          {d.sales.stages.map(s => (
            <button key={s.stage} onClick={() => router.push(`/admin/prospects?stage=${s.stage}`)}
              title={`See ${s.label.toLowerCase()} deals in Customers`}
              style={{ display: 'block', width: '100%', marginBottom: '6px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{s.label} ({s.count})</span>
                <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{fmtK(s.value)} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>›</span></span>
              </div>
              <div style={{ height: '4px', background: 'var(--progress-track)', borderRadius: '2px', marginTop: '2px' }}>
                <div style={{ height: '100%', borderRadius: '2px', background: '#60a5fa', width: `${d.pipelineValue.total > 0 ? Math.round((s.value / d.pipelineValue.total) * 100) : 0}%` }} />
              </div>
            </button>
          ))}
          {d.sales.wonValue > 0 && (
            <button onClick={() => router.push('/admin/prospects?stage=won')}
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '12px', marginTop: '8px', padding: 0, background: 'none', border: 'none', cursor: 'pointer' }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>Won (all time)</span>
              <span style={{ fontWeight: 800, color: 'var(--success)', fontVariantNumeric: 'tabular-nums' }}>{fmtK(d.sales.wonValue)} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>›</span></span>
            </button>
          )}
        </div>
        <div style={{ padding: '12px 16px', borderRight: '1px solid var(--border)' }}>
          <button onClick={() => router.push('/admin/prospects?sort=ytd_spend')}
            title="Open Customers sorted by YTD spend"
            style={{ display: 'block', width: '100%', fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px', padding: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
            Top customers · YTD (NetSuite) ›
          </button>
          {d.sales.topCustomers.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No YTD spend synced yet</div>}
          {d.sales.topCustomers.map(c => (
            <button key={c.name}
              onClick={() => {
                // Customer Record opens in a new tab so the dashboard stays put;
                // without a NetSuite id there's no record page — search the CRM.
                if (c.nsId) window.open(`/admin/prospects/ns-${c.nsId}`, '_blank');
                else router.push(`/admin/prospects?q=${encodeURIComponent(c.name)}`);
              }}
              title={`Open ${c.name}'s customer record`}
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '12px', padding: '3px 0', background: 'none', border: 'none', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '8px' }}>{c.name}</span>
              <span style={{ fontWeight: 800, color: 'var(--text-primary)' }}>{fmtK(c.ytd)} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>›</span></span>
            </button>
          ))}
        </div>
        <div style={{ padding: '12px 16px' }}>
          <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Quotes &amp; estimates</div>
          <button onClick={() => router.push('/admin/wrap-quote')} style={{ display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: '12px', padding: '3px 0', background: 'none', border: 'none', cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
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
    const tagColors: Record<ScheduleItem['type'], string> = { graphics: 'var(--success)', upfit: '#60a5fa', cni: '#a78bfa', event: 'var(--warning)' };
    const tagLabels: Record<ScheduleItem['type'], string> = { graphics: 'GFX', upfit: 'SHOP', cni: 'CNI', event: 'CAL' };
    const goTo = () => {
      if (item.type === 'graphics') router.push(`/graphics?id=${item.id}`);
      else if (item.type === 'upfit') go('/tracking');
      else if (item.type === 'cni') go(`/admin/cni/jobs/${item.id}`);
      else go('/admin/schedule');
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
          <span style={{ display: 'flex', gap: '10px' }}>
            {canOpen('/admin/schedule') && <>
              <button onClick={() => go('/admin/schedule')} style={headLink} title="Add a calendar event on the Schedule page">+ Add</button>
              <button onClick={() => go('/admin/schedule')} style={headLink}>Schedule →</button>
            </>}
          </span>
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
            // Land on the All Scans tab pre-filtered by scan date, so the list
            // matches the count regardless of what happened to each scan since
            // (exported, archived, invoiced, ...). A tile only navigates when
            // the viewer's features admit the destination — otherwise the
            // gated page just bounces the tap back here (sales lacks
            // `reports`, finance lacks `in_shop`), so it renders as a plain
            // stat instead.
            { n: d.now.scansToday, l: 'Scans today', path: '/admin/scans?tab=all&range=today', ok: canOpen('/admin/scans') },
            { n: d.now.scansWeek, l: 'Scans · 7 days', path: '/admin/scans?tab=all&range=7d', ok: canOpen('/admin/scans') },
            { n: d.now.inShop, l: 'In shop', path: '/tracking', ok: canOpen('/tracking') },
          ]).map(p => (
            <button key={p.l} onClick={() => { if (p.ok) router.push(p.path); }} style={{ flex: 1, background: 'var(--subtle-bg)', borderRadius: '9px', padding: '9px 11px', border: 'none', cursor: p.ok ? 'pointer' : 'default', textAlign: 'left' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{p.n}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>{p.l}</div>
            </button>
          ))}
        </div>
      </div>
      <RecentActivity />
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
    ? [salesBand, needsAttention, workInMotion, upfitGlance]
    : [needsAttention, workInMotion, upfitGlance, salesBand];

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

      {newForYou}

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
