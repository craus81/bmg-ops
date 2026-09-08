'use client';

/**
 * Purchasing queue (audit item 17A/B) — every pending purchase request,
 * grouped by vendor, so "we're short, someone should order this" finally
 * has a place to land. Requests arrive from the parts-readiness card's
 * short rows (or the API); admins turn a vendor group into a REAL
 * NetSuite purchase order right here (17B): pick the NetSuite vendor,
 * hit Create PO, and the create-po route places the PO, mirrors it
 * locally so readiness flips to "on order" immediately, and stamps the
 * source projects' PO columns. Non-admins keep the queue as a worklist:
 * fix vendors, adjust quantities, cancel noise.
 *
 * ?req=<id> (deepLinks.purchaseRequests) scroll-flashes one row — the
 * landing for the "parts requested" notification.
 *
 * The Demand tab (?tab=demand) answers the other question: not "what did
 * someone ask for" but "what does ALL the open work need" — every part
 * across every open sales order and every approved-but-unconverted
 * estimate, inventory deliberately not netted out (PartsDemandTab).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';
import PartsDemandTab from '@/components/PartsDemandTab';
import { theme } from '@/lib/theme';
import { deepLinks } from '@/lib/deep-links';

interface RequestRow {
  id: string;
  item_number: string;
  netsuite_item_id: string | null;
  description: string | null;
  quantity: number;
  vendor_name: string | null;
  vendor_netsuite_id: string | null;
  source_project_id: string | null;
  needed_by: string | null;
  note: string | null;
  status: string;
  /** NULL = raised by a person; 'auto_reorder' = the nightly reorder sweep (migration 271). */
  source?: string | null;
  created_at: string;
  upfit_projects?: { id: string; project_name: string | null; netsuite_so_number: string | null } | null;
  requester?: { full_name: string | null } | null;
  /** Joined only on the ?id= single-row lookup, for rows already ordered. */
  ordered_po?: { tranid: string | null; vendor_name: string | null } | null;
}

const UNASSIGNED = 'No vendor — assign one';

export default function PurchasingQueuePage() {
  useRequireFeature('parts_ordering');
  const { isAdmin } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();

  const [tab, setTab] = useState<'requests' | 'demand' | 'metrics'>(
    searchParams.get('tab') === 'demand' ? 'demand' : 'requests',
  );
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  /** R6-7: the one-click buy list raises dozens of requests at once, so
   *  ?reqs=a,b,c (and the modal's own callback) flashes the whole set. */
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [reqNotice, setReqNotice] = useState<string | null>(null);
  const flashedRef = useRef(false);
  const batchFlashedRef = useRef(false);

  // R5-11: vendor reality chips for the group headers — "Meyer: avg 8d
  // late vs promise · 2 ETA slips" — so the scorecard is in front of the
  // buyer at the moment of ordering. Keyed by lowercased vendor name;
  // missing key = no history yet, no chip.
  // R6-7: cycle-time KPIs and the stale-cost worklist. Loaded only when
  // the tab is opened — neither is needed to work the queue.
  const [kpis, setKpis] = useState<any | null>(null);
  const [drift, setDrift] = useState<any | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  useEffect(() => {
    if (tab !== 'metrics' || kpis || metricsLoading) return;
    setMetricsLoading(true);
    Promise.all([
      fetch('/api/reports/purchasing-kpis?days=180').then(r => r.json()).catch(() => null),
      fetch('/api/parts/cost-history').then(r => r.json()).catch(() => null),
    ]).then(([k, d]) => { setKpis(k); setDrift(d); }).finally(() => setMetricsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per tab open
  }, [tab]);

  const [vendorChips, setVendorChips] = useState<Record<string, string>>({});
  useEffect(() => {
    fetch('/api/reports/vendors?chips=1&days=90')
      .then(r => r.ok ? r.json() : null)
      .then(body => { if (body?.chips) setVendorChips(body.chips); })
      .catch(() => { /* chips are garnish — the queue works without them */ });
  }, []);

  // 17B: per-group NetSuite vendor selection + PO creation.
  const [vendorSel, setVendorSel] = useState<Record<string, { id: string; name: string }>>({});
  const [pickerOpen, setPickerOpen] = useState<string | null>(null);
  const [creatingPo, setCreatingPo] = useState<string | null>(null);
  const [lastPo, setLastPo] = useState<{ number: string; url: string | null; mirrored: boolean; stamped: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/purchase-requests?status=pending');
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) setRequests(body.requests || []);
    } catch { /* the empty state below says so */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ?req= — scroll-flash the notified row once loaded. A row that already
  // left the pending queue (ordered/cancelled) can't flash, so fetch its
  // fate and say so instead — the deep link must never land on nothing.
  useEffect(() => {
    if (loading || flashedRef.current) return;
    const req = searchParams.get('req');
    if (!req) return;
    flashedRef.current = true;
    if (requests.some(r => r.id === req)) {
      setFlashId(req);
      setTimeout(() => {
        document.getElementById(`preq-${req}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
      setTimeout(() => setFlashId(null), 3500);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/purchase-requests?id=${req}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) return;
        const r: RequestRow | undefined = body.requests?.[0];
        if (!r) { setReqNotice('That request no longer exists.'); return; }
        if (r.status === 'ordered') {
          setReqNotice(`${r.quantity}× ${r.item_number} was ordered${r.ordered_po?.tranid ? ` on PO ${r.ordered_po.tranid}` : ''}${r.ordered_po?.vendor_name ? ` from ${r.ordered_po.vendor_name}` : ''}.`);
        } else if (r.status === 'cancelled') {
          setReqNotice(`The request for ${r.quantity}× ${r.item_number} was cancelled.`);
        }
      } catch { /* banner is best-effort */ }
    })();
  }, [loading, requests, searchParams]);

  // ?reqs=a,b,c — the batch form. Flashes every row that's still pending
  // and scrolls to the first; ids that already left the queue are simply
  // not flashed (the single-id path above is the one that explains a fate).
  useEffect(() => {
    if (loading || batchFlashedRef.current) return;
    const raw = searchParams.get('reqs');
    if (!raw) return;
    const wanted = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
    if (wanted.size === 0) return;
    // Once per landing, like ?req=. Without this, every later reload of the
    // queue (a cancel, a PO created) re-flashes the same rows.
    batchFlashedRef.current = true;
    const present = requests.filter(r => wanted.has(r.id)).map(r => r.id);
    if (present.length === 0) return;
    setFlashIds(new Set(present));
    setTimeout(() => {
      document.getElementById(`preq-${present[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    const t = setTimeout(() => setFlashIds(new Set()), 4500);
    return () => clearTimeout(t);
  }, [loading, requests, searchParams]);

  const patch = async (id: string, fields: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !(await dialog.confirm(confirmText, { destructive: true, confirmLabel: 'Cancel Request' }))) return;
    setBusyId(id);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...fields }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      await dialog.alert(`Update failed: ${e?.message || 'unknown error'}`);
    }
    setBusyId(null);
  };

  const editQty = async (r: RequestRow) => {
    const raw = await dialog.prompt(`Quantity for ${r.item_number}:`, String(r.quantity));
    const qty = parseFloat(raw || '');
    if (!raw || !Number.isFinite(qty) || qty <= 0) return;
    await patch(r.id, { quantity: qty });
  };

  const editVendor = async (r: RequestRow) => {
    const name = await dialog.prompt(`Vendor for ${r.item_number} (as named in NetSuite):`, r.vendor_name || '');
    if (name === null) return;
    await patch(r.id, { vendorName: name });
  };

  /** The NetSuite vendor a group's PO would go to: an explicit pick wins;
   *  otherwise, if every row already agrees on one vendor id (the
   *  last-purchase enrichment), that's the default. */
  const groupVendor = (vendor: string, rows: RequestRow[]): { id: string; name: string } | null => {
    if (vendorSel[vendor]) return vendorSel[vendor];
    const ids = [...new Set(rows.map(r => r.vendor_netsuite_id).filter(Boolean))] as string[];
    if (ids.length === 1 && vendor !== UNASSIGNED) return { id: ids[0], name: vendor };
    return null;
  };

  const createPo = async (vendor: string, rows: RequestRow[], gv: { id: string; name: string }) => {
    const ok = await dialog.confirm(
      `Create a NetSuite purchase order with ${gv.name} for ${rows.length} line${rows.length !== 1 ? 's' : ''}? This places a real PO in NetSuite.`,
      { confirmLabel: 'Create PO' },
    );
    if (!ok) return;
    setCreatingPo(vendor);
    try {
      const res = await fetch('/api/purchase-requests/create-po', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestIds: rows.map(r => r.id), vendorNetsuiteId: gv.id, vendorName: gv.name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setLastPo({
        number: body.poNumber || (body.poId ? `#${body.poId}` : '(number pending)'),
        url: body.netsuiteUrl || null,
        mirrored: !!body.mirrored,
        stamped: !!body.stamped,
      });
      setVendorSel(prev => { const next = { ...prev }; delete next[vendor]; return next; });
      await load();
    } catch (e: any) {
      await dialog.alert(`PO creation failed: ${e?.message || 'unknown error'}\n\nNothing was ordered — the requests are still in the queue.`);
    }
    setCreatingPo(null);
  };

  // Group by vendor for the purchaser's eye — one group = one future PO.
  const groups = new Map<string, RequestRow[]>();
  for (const r of requests) {
    const key = r.vendor_name?.trim() || UNASSIGNED;
    groups.set(key, [...(groups.get(key) || []), r]);
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    a === UNASSIGNED ? -1 : b === UNASSIGNED ? 1 : a.localeCompare(b));

  const age = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return days === 0 ? 'today' : `${days}d ago`;
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto', padding: '20px 16px 60px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Purchasing</h1>
        {requests.length > 0 && (
          <span style={{ fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>{requests.length} pending</span>
        )}
      </div>
      <div style={{ display: 'flex', gap: '6px', margin: '12px 0 14px', borderBottom: `1px solid ${theme.border}` }}>
        {([
          ['requests', 'Request queue'],
          ['demand', 'Open-job demand'],
          ['metrics', 'Cycle time & cost'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              padding: '7px 14px', background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '12px', fontWeight: 800,
              color: tab === key ? 'var(--text-primary)' : theme.textMuted,
              borderBottom: `2px solid ${tab === key ? '#60a5fa' : 'transparent'}`,
              marginBottom: '-1px',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'metrics' && (
        <div>
          {metricsLoading && <div style={{ fontSize: '12px', color: theme.textMuted, padding: '14px 0' }}>Loading…</div>}

          {kpis && !kpis.error && (
            <>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                {[
                  { label: 'Request → order', value: kpis.medianRequestToOrderDays != null ? `${kpis.medianRequestToOrderDays}d` : '—', sub: `${kpis.requestToOrderSamples} samples` },
                  { label: 'Order → arrival', value: kpis.medianOrderToReceiptDays != null ? `${kpis.medianOrderToReceiptDays}d` : '—', sub: `${kpis.orderToReceiptSamples} samples` },
                  { label: 'Needed-by hit rate', value: kpis.neededByHitRate != null ? `${Math.round(kpis.neededByHitRate * 100)}%` : '—', sub: `${kpis.neededBySamples} with a date` },
                  { label: 'Cancelled', value: kpis.cancellationRate != null ? `${Math.round(kpis.cancellationRate * 100)}%` : '—', sub: `${kpis.cancelled} of ${kpis.requests}` },
                  { label: 'Oldest open ask', value: `${kpis.oldestOpenDays}d`, sub: `${kpis.openAging.d30plus} over 30d` },
                ].map(t => (
                  <div key={t.label} style={{ flex: '1 1 130px', background: 'var(--card)', border: `1px solid ${theme.border}`, borderRadius: '11px', padding: '11px 13px' }}>
                    <div style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-primary)' }}>{t.value}</div>
                    <div style={{ fontSize: '10.5px', color: theme.textMuted, fontWeight: 600 }}>{t.label}</div>
                    <div style={{ fontSize: '9.5px', color: theme.textMuted }}>{t.sub}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '16px' }}>
                Medians over the last {kpis.days} days — a median, so one back-ordered part that took
                ninety days doesn&apos;t redefine a normal week.
              </div>

              {kpis.byVendor?.length > 0 && (
                <div style={{ marginBottom: '18px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>Slowest vendors to arrive</div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {kpis.byVendor.slice(0, 8).map((v: any) => (
                      <span key={v.vendor} style={{ fontSize: '11px', padding: '4px 9px', borderRadius: '999px', background: 'var(--subtle-bg)', color: 'var(--text-body)' }}>
                        {v.vendor}: <b>{v.medianOrderToReceiptDays ?? '—'}d</b> <span style={{ color: theme.textMuted }}>({v.ordered})</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {drift && !drift.error && (
            <div>
              <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>
                Catalog cost stale ({drift.totals?.material || 0} material)
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '9px' }}>
                What we actually pay, against the catalog&apos;s purchase price. Every margin built on a stale
                number is off by the same amount.
                {drift.totals?.noCatalogPrice > 0 && ` ${drift.totals.noCatalogPrice} bought part${drift.totals.noCatalogPrice !== 1 ? 's have' : ' has'} no catalog price at all.`}
              </div>
              {(drift.worklist || []).length === 0 ? (
                <div style={{ fontSize: '12px', color: theme.textMuted, fontStyle: 'italic' }}>Nothing has drifted past the threshold.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  {drift.worklist.slice(0, 25).map((d: any) => (
                    <div key={d.itemNumber} style={{ display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '7px 10px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{d.itemNumber}</span>
                      <span style={{ fontSize: '11px', color: theme.textMuted, flex: 1, minWidth: '120px' }}>{d.displayName || ''}</span>
                      <span style={{ fontSize: '11px', color: theme.textSecondary }}>
                        catalog ${Number(d.catalogPrice).toFixed(2)} → last paid ${Number(d.lastRate).toFixed(2)}
                      </span>
                      <span style={{
                        fontSize: '11px', fontWeight: 800,
                        color: d.severity === 'material' ? '#ef4444' : '#f59e0b',
                      }}>{d.driftPct > 0 ? '+' : ''}{d.driftPct}%</span>
                      {d.lastVendor && <span style={{ fontSize: '10px', color: theme.textMuted }}>{d.lastVendor}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'demand' && (
        <>
          <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '14px' }}>
            Every part all the open work needs, rolled up by part number — open sales orders
            plus approved estimates that haven’t become sales orders yet.
            <b style={{ color: 'var(--text-body)' }}> Stock on the shelf is not subtracted</b>:
            this is what the jobs require. Parts already on a vendor PO show in their own column
            rather than being netted out.
          </div>
          <PartsDemandTab
            onQueued={load}
            onBatchQueued={async (ids) => {
              // Land on the rows that were just created, not on a list the
              // buyer then has to search — same contract as the ?reqs= link.
              await load();
              setTab('requests');
              setFlashIds(new Set(ids));
              setTimeout(() => {
                document.getElementById(`preq-${ids[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 150);
              setTimeout(() => setFlashIds(new Set()), 4500);
            }}
          />
        </>
      )}

      {tab === 'requests' && (<>
      <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '18px' }}>
        Parts requested from short readiness cards land here, grouped by vendor.
        {isAdmin
          ? ' Pick the NetSuite vendor on a group and create the PO right here — readiness cards flip to “on order” immediately.'
          : ' An admin turns a vendor group into a NetSuite PO; readiness cards flip to “on order” once it’s placed.'}
      </div>

      {reqNotice && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px', marginBottom: '16px', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.3)', borderRadius: '12px' }}>
          <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-body)' }}>{reqNotice}</div>
          <button onClick={() => setReqNotice(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '13px', padding: 0 }}>✕</button>
        </div>
      )}

      {lastPo && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px', marginBottom: '16px', background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', borderRadius: '12px' }}>
          <div style={{ flex: 1, fontSize: '12px', color: 'var(--text-body)' }}>
            <span style={{ fontWeight: 800, color: '#4ade80' }}>✓ PO {lastPo.number} created in NetSuite.</span>{' '}
            {lastPo.mirrored
              ? 'Readiness cards show these parts on order now.'
              : 'The 2-hourly sync will mirror it into FleetSuite shortly.'}
            {!lastPo.stamped && ' Heads up: the queue rows could not be marked ordered — refresh, and cancel them by hand so they aren’t ordered twice.'}
            {lastPo.url && (
              <>
                {' '}
                <a href={lastPo.url} target="_blank" rel="noreferrer" style={{ color: '#60a5fa', fontWeight: 700 }}>Open in NetSuite ↗</a>
              </>
            )}
          </div>
          <button onClick={() => setLastPo(null)} title="Dismiss"
            style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '13px', padding: 0 }}>✕</button>
        </div>
      )}

      {loading && <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && requests.length === 0 && (
        <div style={{ padding: '28px', textAlign: 'center', border: `1px dashed ${theme.border}`, borderRadius: '14px', color: theme.textMuted, fontSize: '13px' }}>
          Nothing waiting to be ordered. Short parts on any upfit readiness card can be requested from there.
        </div>
      )}

      {groupNames.map(vendor => {
        const rows = groups.get(vendor)!;
        const unassigned = vendor === UNASSIGNED;
        const gv = groupVendor(vendor, rows);
        const noId = rows.filter(r => !r.netsuite_item_id).length;
        return (
          <div key={vendor} style={{ marginBottom: '18px', background: theme.card, border: `1px solid ${unassigned ? 'rgba(251,191,36,0.4)' : theme.border}`, borderRadius: '14px', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderBottom: `1px solid ${theme.border}`, background: unassigned ? 'rgba(251,191,36,0.06)' : 'var(--subtle-bg)' }}>
              <div style={{ fontSize: '13px', fontWeight: 800, color: unassigned ? '#f59e0b' : 'var(--text-primary)' }}>{vendor}</div>
              <div style={{ fontSize: '11px', color: theme.textMuted }}>{rows.length} part{rows.length !== 1 ? 's' : ''}</div>
              {!unassigned && vendorChips[vendor.toLowerCase()] && (
                <button onClick={() => router.push('/admin/reports/vendors')}
                  title="Last 90 days — open the vendor scorecard"
                  style={{ fontSize: '10px', fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: '7px', padding: '2px 8px', cursor: 'pointer' }}>
                  {vendorChips[vendor.toLowerCase()]}
                </button>
              )}
              {isAdmin && (
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {gv && pickerOpen !== vendor && (
                    <span style={{ fontSize: '10px', color: theme.textMuted }}>
                      PO vendor: <b style={{ color: 'var(--text-body)' }}>{gv.name}</b> #{gv.id}
                      <button onClick={() => setPickerOpen(vendor)}
                        style={{ marginLeft: '6px', background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
                        change
                      </button>
                    </span>
                  )}
                  {!gv && pickerOpen !== vendor && (
                    <button onClick={() => setPickerOpen(vendor)}
                      style={{ padding: '5px 10px', borderRadius: '7px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      Pick NetSuite vendor…
                    </button>
                  )}
                  {gv && (
                    <button onClick={() => createPo(vendor, rows, gv)} disabled={creatingPo !== null || noId > 0}
                      title={noId > 0 ? `${noId} row${noId !== 1 ? 's have' : ' has'} no NetSuite item id — match in the parts catalog or cancel them first` : `Create a NetSuite PO with ${gv.name}`}
                      style={{ padding: '5px 12px', borderRadius: '7px', background: noId > 0 ? 'var(--subtle-bg)' : 'rgba(74,222,128,0.12)', border: `1px solid ${noId > 0 ? theme.border : 'rgba(74,222,128,0.4)'}`, color: noId > 0 ? theme.textMuted : '#4ade80', fontSize: '11px', fontWeight: 800, cursor: noId > 0 ? 'not-allowed' : 'pointer' }}>
                      {creatingPo === vendor ? 'Creating PO…' : '📦 Create PO in NetSuite'}
                    </button>
                  )}
                </div>
              )}
            </div>
            {isAdmin && pickerOpen === vendor && (
              <div style={{ padding: '10px 14px', borderBottom: `1px solid ${theme.border}`, background: 'var(--subtle-bg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>Which NetSuite vendor gets this PO?</div>
                  <button onClick={() => setPickerOpen(null)} title="Close"
                    style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: '12px', padding: 0 }}>✕</button>
                </div>
                <NetsuiteVendorSearch autoFocus placeholder={unassigned ? 'Search NetSuite vendors by name…' : `Search NetSuite for “${vendor}”…`}
                  onSelect={v => {
                    setVendorSel(prev => ({ ...prev, [vendor]: { id: v.id, name: v.companyName || v.entityId } }));
                    setPickerOpen(null);
                  }} />
              </div>
            )}
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ color: theme.textMuted, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.5px' }}>
                    <th style={{ textAlign: 'left', padding: '8px 14px' }}>Part</th>
                    <th style={{ textAlign: 'right', padding: '8px 10px' }}>Qty</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>For</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>Needed by</th>
                    <th style={{ textAlign: 'left', padding: '8px 10px' }}>Requested</th>
                    <th style={{ padding: '8px 14px' }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} id={`preq-${r.id}`} style={{
                      borderTop: `1px solid ${theme.border}`,
                      background: (flashId === r.id || flashIds.has(r.id)) ? 'rgba(96,165,250,0.12)' : 'transparent',
                      transition: 'background 0.6s',
                    }}>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.item_number}</div>
                        {r.description && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{r.description}</div>}
                        {r.note && <div style={{ fontSize: '11px', color: theme.textMuted, fontStyle: 'italic' }}>“{r.note}”</div>}
                        {!r.netsuite_item_id && (
                          <div title="No NetSuite item id resolved — the PO line will need it" style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>⚠ no NetSuite item id</div>
                        )}
                      </td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        <button onClick={() => editQty(r)} disabled={busyId === r.id} title="Edit quantity"
                          style={{ background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '6px', padding: '4px 10px', fontWeight: 800, fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                          {r.quantity}
                        </button>
                      </td>
                      <td style={{ padding: '9px 10px' }}>
                        {r.upfit_projects ? (
                          <button onClick={() => router.push(deepLinks.upfitProject(r.upfit_projects!.id))}
                            style={{ background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                            {r.upfit_projects.project_name || 'Upfit project'}
                            {r.upfit_projects.netsuite_so_number ? ` · SO ${r.upfit_projects.netsuite_so_number}` : ''}
                          </button>
                        ) : <span style={{ color: theme.textMuted }}>stock</span>}
                      </td>
                      <td style={{ padding: '9px 10px', color: r.needed_by ? 'var(--text-body)' : theme.textMuted }}>{r.needed_by || '—'}</td>
                      <td style={{ padding: '9px 10px', color: theme.textMuted }}>
                        {age(r.created_at)}{r.requester?.full_name ? ` · ${r.requester.full_name}` : ''}
                        {r.source === 'auto_reorder' && (
                          <span title={r.note || 'Raised by the nightly reorder sweep'} style={{ marginLeft: '6px', fontSize: '9px', fontWeight: 800, padding: '1px 6px', borderRadius: '4px', background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.3)', color: '#38bdf8', whiteSpace: 'nowrap' }}>
                            AUTO
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button onClick={() => editVendor(r)} disabled={busyId === r.id} title="Set/change vendor"
                          style={{ marginRight: '6px', padding: '4px 9px', borderRadius: '6px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textSecondary, fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
                          Vendor
                        </button>
                        <button onClick={() => patch(r.id, { cancel: true }, `Cancel the request for ${r.quantity}× ${r.item_number}?`)} disabled={busyId === r.id}
                          style={{ padding: '4px 9px', borderRadius: '6px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', color: '#f87171', fontSize: '10px', fontWeight: 700, cursor: 'pointer' }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      </>)}
    </div>
  );
}
