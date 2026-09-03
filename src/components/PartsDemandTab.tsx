'use client';

/**
 * "What do we need to buy to finish everything we've sold" — every part
 * across every open job, rolled up by part number
 * (/api/purchasing/demand, src/lib/parts-demand.ts).
 *
 * Deliberately inventory-blind: the Needed column is what the work
 * requires, with nothing on the shelf subtracted from it. "On order" sits
 * beside it as its own figure rather than being netted out, so a glance
 * says what's already covered without the arithmetic hiding anything.
 *
 * Each part expands to the jobs driving its number, and any row can be
 * pushed into the purchase-request queue on the other tab.
 */

import { Fragment, useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';

interface DemandSourceRef {
  kind: 'sales_order' | 'estimate';
  id: string;
  label: string;
  customerName: string | null;
  date: string | null;
  statusLabel: string | null;
  quantity: number;
}

interface DemandPoRef {
  tranid: string | null;
  vendor_name: string | null;
  eta_date: string | null;
  remaining: number;
}

interface DemandRow {
  item_number: string;
  description: string | null;
  netsuite_item_id: string | null;
  vendor: string | null;
  item_type: string | null;
  in_catalog: boolean;
  needed: number;
  on_order: number;
  requested: number;
  pos: DemandPoRef[];
  sources: DemandSourceRef[];
  /** Dismissed by staff and its needed quantity hasn't grown since (server
   *  clears a dismissal the moment new demand outgrows it). */
  dismissed: { at: string; by: string | null; reason: string | null; neededAtDismiss: number } | null;
}

interface DemandMeta {
  salesOrders: number;
  estimates: number;
  parts: number;
  units: number;
  skippedNonStock: number;
  /** Rows hidden by a live dismissal. Optional for the deploy window. */
  dismissed?: number;
  soSyncedAt: string | null;
  /** Health of the NetSuite sales-order mirror the SO half reads from.
   *  Optional only for the deploy window where an older API answers. */
  soSync?: {
    mirrorRows: number;
    status: 'ok' | 'partial' | 'stale' | 'error' | 'never';
    lastRunAt: string | null;
    problem: string | null;
  };
}

/**
 * Why the sales-order half of the list might be short — said out loud, so
 * "0 open sales orders" is never a silent zero. The mirror's first sync
 * silently never finished and this page reported a confident 0 for weeks.
 */
function soMirrorNotice(meta: DemandMeta): { warn: boolean; text: string } | null {
  const s = meta.soSync;
  if (!s) return null;
  switch (s.status) {
    case 'never':
      return { warn: true, text: 'Sales orders have never been pulled from NetSuite, so this list only reflects approved estimates.' };
    case 'error':
      return { warn: true, text: `The last sales-order sync failed (${s.problem || 'unknown error'}), so open jobs may be missing.` };
    case 'stale':
      return { warn: true, text: `The sales-order sync is overdue (${s.problem || 'no recent run'}), so jobs entered since may be missing.` };
    case 'partial':
      return { warn: false, text: `NetSuite sales orders are still backfilling (${s.problem || 'in progress'}). Open orders sync first, so this list is usable now.` };
    default:
      break;
  }
  if (s.mirrorRows === 0) {
    return { warn: true, text: 'The sync ran but NetSuite returned no sales orders at all — the integration role most likely can\'t see Sales Orders (NetSuite permission "Sales Order → View").' };
  }
  if (meta.salesOrders === 0) {
    return { warn: false, text: `${s.mirrorRows} sales order${s.mirrorRows !== 1 ? 's' : ''} on file, none open right now — every one is billed, closed or cancelled in NetSuite.` };
  }
  return null;
}

const qty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** CSV cell: quote everything, double inner quotes. Item numbers and
 *  customer names both carry commas often enough to matter. */
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function PartsDemandTab({ onQueued }: { onQueued?: () => void }) {
  const dialog = useDialog();
  const { isAdmin } = useAuth();

  const [rows, setRows] = useState<DemandRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [meta, setMeta] = useState<DemandMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [queueing, setQueueing] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hideCovered, setHideCovered] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/purchasing/demand');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setRows(body.rows || []);
      setMeta(body.meta || null);
    } catch (e: any) {
      // The list is either whole or wrong — say so instead of showing a
      // number somebody might order against.
      setError(e?.message || 'Could not load the demand list');
      setRows([]);
      setMeta(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Admin: pull sales orders from NetSuite right now (full resync, newest
   *  first) and say what came back in the terms that tell a NetSuite
   *  permission problem from a FleetSuite save problem. */
  const syncSalesOrders = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/purchasing/sync-sales-orders', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        await dialog.alert(`Sales order sync failed: ${data.error || `HTTP ${res.status}`}`);
        return;
      }
      const modified = data.modified ?? 0;   // SOs NetSuite returned
      const totalSos = data.totalSos ?? 0;   // SOs now on file in FleetSuite
      let msg: string;
      if (totalSos > 0) {
        msg = `NetSuite returned ${modified} sales order(s) · ${data.synced ?? 0} saved · ${data.lines ?? 0} line(s). ${totalSos} on file now, ${data.openSos ?? 0} open.`
          + (data.partial ? '\n\nNewest orders came first; older history keeps backfilling on the 2-hour sync.' : '')
          + (Array.isArray(data.droppedColumns) && data.droppedColumns.length > 0
            ? `\n\nNetSuite refuses these optional header columns for this role, so the sync runs without them: ${data.droppedColumns.join(', ')}.`
            : '');
      } else if (modified === 0) {
        msg = 'NetSuite returned 0 sales orders across all history.\n\nOther NetSuite data syncs fine, so the integration role most likely can\'t see Sales Orders. Fix in NetSuite: grant that role "Sales Order → View". This is a NetSuite permission, not a FleetSuite bug.';
      } else {
        msg = `NetSuite returned ${modified} sales order(s) but none saved to FleetSuite${data.headerErrors ? ` (${data.headerErrors} header error(s))` : ''} — that's a FleetSuite-side problem. Screenshot this and report it.`;
      }
      await dialog.alert(msg);
      await load();
    } finally {
      setSyncing(false);
    }
  };

  const addToQueue = async (row: DemandRow) => {
    const suggested = Math.max(0, row.needed - row.on_order - row.requested);
    const raw = await dialog.prompt(
      `How many ${row.item_number} to request?\n\n`
      + `Needed across open jobs: ${qty(row.needed)}`
      + `${row.on_order > 0 ? `\nAlready on order: ${qty(row.on_order)}` : ''}`
      + `${row.requested > 0 ? `\nAlready in the queue: ${qty(row.requested)}` : ''}`,
      String(suggested > 0 ? suggested : row.needed),
      { title: 'Add to purchasing queue', confirmLabel: 'Add to queue' },
    );
    const amount = parseFloat(raw || '');
    if (!raw || !Number.isFinite(amount) || amount <= 0) return;

    setQueueing(row.item_number);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{
            itemNumber: row.item_number,
            quantity: amount,
            description: row.description,
            netsuiteItemId: row.netsuite_item_id,
          }],
          // No project: this demand spans jobs, so pinning it to one would
          // misattribute it. The note carries where the number came from.
          note: `Open-job demand: ${qty(row.needed)} needed across ${row.sources.length} job${row.sources.length !== 1 ? 's' : ''}`
            + ` (${row.sources.slice(0, 3).map(s => s.label).join(', ')}${row.sources.length > 3 ? '…' : ''})`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
      onQueued?.();
    } catch (e: any) {
      await dialog.alert(`Could not add to the queue: ${e?.message || 'unknown error'}`);
    }
    setQueueing(null);
  };

  /** "Not buying this one" — hides the part until its needed quantity
   *  grows past today's (new demand un-hides it server-side). */
  const dismissRow = async (row: DemandRow) => {
    const reason = await dialog.prompt(
      `Dismiss ${row.item_number} from the demand list?\n\nIt stays hidden while the needed quantity is ${qty(row.needed)} or less — if a new job pushes it higher, it comes back on its own. You can also bring it back any time with "Show dismissed".`,
      '',
      { title: 'Dismiss part', placeholder: 'Why? (optional — e.g. covered from stock, customer supplies)', confirmLabel: 'Dismiss' },
    );
    if (reason === null || reason === undefined) return;
    setDismissing(row.item_number);
    try {
      const res = await fetch('/api/purchasing/demand/dismiss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemNumber: row.item_number, needed: row.needed, reason: reason.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      await dialog.alert(`Could not dismiss: ${e?.message || 'unknown error'}`);
    }
    setDismissing(null);
  };

  const restoreRow = async (row: DemandRow) => {
    setDismissing(row.item_number);
    try {
      const res = await fetch('/api/purchasing/demand/dismiss', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemNumber: row.item_number }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      await dialog.alert(`Could not restore: ${e?.message || 'unknown error'}`);
    }
    setDismissing(null);
  };

  const dismissedCount = rows.filter(r => r.dismissed).length;

  const filtered = rows.filter(r => {
    if (r.dismissed && !showDismissed) return false;
    if (hideCovered && r.on_order + r.requested >= r.needed) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return r.item_number.toLowerCase().includes(q)
      || (r.description || '').toLowerCase().includes(q)
      || (r.vendor || '').toLowerCase().includes(q)
      || r.sources.some(s => s.label.toLowerCase().includes(q) || (s.customerName || '').toLowerCase().includes(q));
  });

  const downloadCsv = () => {
    const header = ['Part', 'Description', 'Vendor', 'Needed', 'On order', 'In queue', 'Jobs'];
    const lines = [header.map(csvCell).join(',')];
    for (const r of filtered) {
      lines.push([
        r.item_number, r.description || '', r.vendor || '',
        qty(r.needed), qty(r.on_order), qty(r.requested),
        r.sources.map(s => `${s.label} ×${qty(s.quantity)}`).join('; '),
      ].map(csvCell).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `parts-demand-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const soNotice = meta ? soMirrorNotice(meta) : null;

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Building the demand list…</div>;

  if (error) {
    return (
      <div style={{ padding: '16px', border: '1px solid rgba(248,113,113,0.3)', background: 'rgba(248,113,113,0.06)', borderRadius: '12px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: '#f87171', marginBottom: '4px' }}>Could not build the list</div>
        <div style={{ fontSize: '12px', color: 'var(--text-body)', marginBottom: '10px' }}>{error}</div>
        <div style={{ fontSize: '11px', color: theme.textMuted, marginBottom: '10px' }}>
          Nothing partial is shown on purpose — a short read would understate a number you'd order against.
        </div>
        <button onClick={load} style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: 'var(--text-body)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      {meta && (
        <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '12px' }}>
          <b style={{ color: 'var(--text-primary)' }}>{meta.parts}</b> part{meta.parts !== 1 ? 's' : ''}
          {' · '}<b style={{ color: 'var(--text-primary)' }}>{qty(meta.units)}</b> total units
          {' · from '}{meta.salesOrders} open sales order{meta.salesOrders !== 1 ? 's' : ''}
          {meta.estimates > 0 && ` + ${meta.estimates} approved estimate${meta.estimates !== 1 ? 's' : ''} not yet converted`}
          {meta.skippedNonStock > 0 && (
            <span style={{ color: theme.textMuted }}> · {meta.skippedNonStock} labor/service line{meta.skippedNonStock !== 1 ? 's' : ''} excluded</span>
          )}
          {meta.soSyncedAt ? (
            <span style={{ color: theme.textMuted }}> · sales orders synced {new Date(meta.soSyncedAt).toLocaleString()}</span>
          ) : meta.soSync?.lastRunAt ? (
            <span style={{ color: theme.textMuted }}> · sales-order sync last ran {new Date(meta.soSync.lastRunAt).toLocaleString()}</span>
          ) : null}
        </div>
      )}

      {soNotice && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          padding: '10px 12px', marginBottom: '12px', borderRadius: '10px', fontSize: '12px', color: 'var(--text-body)',
          border: `1px solid ${soNotice.warn ? 'rgba(245,158,11,0.35)' : theme.border}`,
          background: soNotice.warn ? 'rgba(245,158,11,0.07)' : 'var(--subtle-bg)',
        }}>
          <span style={{ flex: '1 1 260px' }}>{soNotice.warn ? '⚠ ' : ''}{soNotice.text}</span>
          {isAdmin ? (
            <button onClick={syncSalesOrders} disabled={syncing}
              title="Pull sales orders from NetSuite now — newest first, so open jobs land immediately"
              style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(96,165,250,0.3)', background: 'rgba(96,165,250,0.1)', color: '#60a5fa', fontSize: '11px', fontWeight: 800, cursor: syncing ? 'wait' : 'pointer', opacity: syncing ? 0.7 : 1 }}>
              {syncing ? 'Syncing from NetSuite…' : 'Sync sales orders now'}
            </button>
          ) : (
            <span style={{ color: theme.textMuted, fontSize: '11px' }}>An admin can run the sync from this tab.</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by part, description, vendor, job…"
          style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'var(--input-bg, var(--bg))', color: 'var(--text-body)', fontSize: '12px' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: theme.textSecondary, cursor: 'pointer' }}>
          <input type="checkbox" checked={hideCovered} onChange={e => setHideCovered(e.target.checked)} style={{ accentColor: '#3b82f6' }} />
          Hide parts already on order or queued
        </label>
        <button onClick={downloadCsv} disabled={filtered.length === 0}
          style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: filtered.length ? 'pointer' : 'not-allowed', opacity: filtered.length ? 1 : 0.5 }}>
          ⬇ CSV
        </button>
        {dismissedCount > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: theme.textSecondary, cursor: 'pointer' }}>
            <input type="checkbox" checked={showDismissed} onChange={e => setShowDismissed(e.target.checked)} style={{ accentColor: '#3b82f6' }} />
            Show dismissed ({dismissedCount})
          </label>
        )}
        <button onClick={load}
          style={{ padding: '6px 12px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: 'transparent', color: theme.textSecondary, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
          Refresh
        </button>
        {/* Always available, not just when the mirror looks unhealthy: a
            sales order entered in NetSuite five minutes ago shouldn't wait
            for the 2-hour sync to show up here. */}
        {isAdmin && (
          <button onClick={syncSalesOrders} disabled={syncing}
            title="Pull sales orders from NetSuite now — newest first, so a job entered minutes ago lands immediately"
            style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(96,165,250,0.3)', background: 'rgba(96,165,250,0.1)', color: '#60a5fa', fontSize: '11px', fontWeight: 800, cursor: syncing ? 'wait' : 'pointer', opacity: syncing ? 0.7 : 1 }}>
            {syncing ? 'Syncing…' : '⟳ Sync from NetSuite'}
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '28px', textAlign: 'center', border: `1px dashed ${theme.border}`, borderRadius: '14px', color: theme.textMuted, fontSize: '13px' }}>
          {rows.length > 0
            ? 'Nothing matches those filters.'
            : meta?.soSync && meta.soSync.status !== 'ok'
              ? 'Nothing to show until sales orders come over from NetSuite.'
              : 'No open jobs need parts right now.'}
        </div>
      ) : (
        <div style={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ color: theme.textMuted, textTransform: 'uppercase', fontSize: '9px', letterSpacing: '0.5px' }}>
                  <th style={{ textAlign: 'left', padding: '8px 14px' }}>Part</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Vendor</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px' }}>Needed</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px' }}>On order</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px' }}>In queue</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px' }}>Jobs</th>
                  <th style={{ padding: '8px 14px' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const open = expanded === r.item_number;
                  return (
                    <Fragment key={r.item_number}>
                      <tr style={{ borderTop: `1px solid ${theme.border}` }}>
                        <td style={{ padding: '9px 14px' }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{r.item_number}</div>
                          {r.description && <div style={{ fontSize: '11px', color: theme.textSecondary }}>{r.description}</div>}
                          {!r.in_catalog && (
                            <div title="No catalog row matched — no vendor or NetSuite item id could be resolved"
                              style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>⚠ not in the parts catalog</div>
                          )}
                          {r.dismissed && (
                            <div title={`Dismissed ${new Date(r.dismissed.at).toLocaleString()}${r.dismissed.reason ? ` — ${r.dismissed.reason}` : ''}. Comes back on its own if the needed quantity grows past ${qty(r.dismissed.neededAtDismiss)}.`}
                              style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 700 }}>
                              dismissed{r.dismissed.reason ? ` — ${r.dismissed.reason}` : ''}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '9px 10px', color: r.vendor ? 'var(--text-body)' : theme.textMuted }}>
                          {r.vendor || '—'}
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                          <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--text-primary)' }}>{qty(r.needed)}</span>
                        </td>
                        <td
                          style={{ padding: '9px 10px', textAlign: 'right', color: r.on_order > 0 ? '#60a5fa' : theme.textMuted }}
                          title={r.pos.map(p => `${p.tranid || 'PO'} · ${qty(p.remaining)}${p.eta_date ? ` · ETA ${p.eta_date}` : ''}`).join('\n') || undefined}
                        >
                          {r.on_order > 0 ? qty(r.on_order) : '—'}
                        </td>
                        <td style={{ padding: '9px 10px', textAlign: 'right', color: r.requested > 0 ? '#f59e0b' : theme.textMuted }}>
                          {r.requested > 0 ? qty(r.requested) : '—'}
                        </td>
                        <td style={{ padding: '9px 10px' }}>
                          <button onClick={() => setExpanded(open ? null : r.item_number)}
                            style={{ background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer', textAlign: 'left' }}>
                            {r.sources.length} job{r.sources.length !== 1 ? 's' : ''} {open ? '▴' : '▾'}
                          </button>
                        </td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button onClick={() => addToQueue(r)} disabled={queueing === r.item_number}
                            title="Add this part to the purchase-request queue"
                            style={{ padding: '4px 10px', borderRadius: '6px', background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa', fontSize: '10px', fontWeight: 800, cursor: 'pointer' }}>
                            {queueing === r.item_number ? 'Adding…' : '+ Queue'}
                          </button>
                          {r.dismissed ? (
                            <button onClick={() => restoreRow(r)} disabled={dismissing === r.item_number}
                              title="Bring this part back onto the list"
                              style={{ marginLeft: '6px', padding: '4px 10px', borderRadius: '6px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e', fontSize: '10px', fontWeight: 800, cursor: 'pointer' }}>
                              {dismissing === r.item_number ? '…' : 'Restore'}
                            </button>
                          ) : (
                            <button onClick={() => dismissRow(r)} disabled={dismissing === r.item_number}
                              title="Not buying this — hide it until new demand appears"
                              style={{ marginLeft: '6px', padding: '4px 10px', borderRadius: '6px', background: 'transparent', border: `1px solid ${theme.border}`, color: theme.textMuted, fontSize: '10px', fontWeight: 800, cursor: 'pointer' }}>
                              {dismissing === r.item_number ? '…' : 'Dismiss'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={7} style={{ padding: '0 14px 12px' }}>
                            <div style={{ background: 'var(--subtle-bg)', border: `1px solid ${theme.border}`, borderRadius: '10px', padding: '8px 12px' }}>
                              {r.sources.map(s => (
                                <div key={`${s.kind}-${s.id}`} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap', padding: '3px 0', fontSize: '11px' }}>
                                  <span style={{ fontWeight: 800, color: 'var(--text-primary)', minWidth: '46px' }}>{qty(s.quantity)}×</span>
                                  <span style={{ fontWeight: 700, color: 'var(--text-body)' }}>{s.label}</span>
                                  <span style={{
                                    fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.4px',
                                    padding: '1px 5px', borderRadius: '4px',
                                    background: s.kind === 'estimate' ? 'rgba(251,191,36,0.12)' : 'rgba(96,165,250,0.12)',
                                    color: s.kind === 'estimate' ? '#f59e0b' : '#60a5fa',
                                  }}>
                                    {s.kind === 'estimate' ? 'Estimate — not yet an SO' : (s.statusLabel || 'Sales order')}
                                  </span>
                                  {s.customerName && <span style={{ color: theme.textSecondary }}>{s.customerName}</span>}
                                  {s.date && <span style={{ color: theme.textMuted }}>{s.date.slice(0, 10)}</span>}
                                </div>
                              ))}
                              {r.pos.length > 0 && (
                                <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: `1px solid ${theme.border}`, fontSize: '11px', color: theme.textSecondary }}>
                                  <b style={{ color: 'var(--text-body)' }}>On order:</b>{' '}
                                  {r.pos.map(p => `${qty(p.remaining)} on ${p.tranid || 'a PO'}${p.vendor_name ? ` (${p.vendor_name})` : ''}${p.eta_date ? ` — ETA ${p.eta_date}` : ''}`).join(' · ')}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
