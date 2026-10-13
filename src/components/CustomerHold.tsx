'use client';

/**
 * The red "On hold" flag for customers past due (migration 366), used on the
 * customer record, the Past Due page, search, and the estimate picker and
 * builder. One cached read of customer_holds per page load (only rows that
 * can be on hold), shared by every badge on the page.
 */

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useDialog } from '@/components/DialogProvider';
import { fetchAllRows } from '@/lib/fetch-all';
import { isOnHold, holdReason, type CustomerHoldRow } from '@/lib/customer-hold';

export interface HoldIndex {
  byNs: Map<string, CustomerHoldRow>;
  byCustomer: Map<string, CustomerHoldRow>;
}

let cache: Promise<HoldIndex> | null = null;
const listeners = new Set<(idx: HoldIndex) => void>();

async function loadIndex(): Promise<HoldIndex> {
  const supabase = createClient();
  const { data } = await fetchAllRows<CustomerHoldRow>((from, to) => supabase
    .from('customer_holds').select('*')
    .or('auto_hold.eq.true,manual.not.is.null')
    .order('netsuite_customer_id')
    .range(from, to));
  const byNs = new Map<string, CustomerHoldRow>();
  const byCustomer = new Map<string, CustomerHoldRow>();
  for (const r of data || []) {
    byNs.set(String(r.netsuite_customer_id), r);
    if (r.customer_id) byCustomer.set(r.customer_id, r);
  }
  return { byNs, byCustomer };
}

function reloadHolds() {
  cache = loadIndex();
  cache.then(idx => listeners.forEach(l => l(idx))).catch(() => {});
  return cache;
}

/** All holds, keyed by NetSuite id and local customer id. Null until loaded. */
export function useCustomerHolds(): HoldIndex | null {
  const [idx, setIdx] = useState<HoldIndex | null>(null);
  useEffect(() => {
    let live = true;
    const l = (i: HoldIndex) => { if (live) setIdx(i); };
    listeners.add(l);
    (cache || reloadHolds()).then(l).catch(() => {});
    return () => { live = false; listeners.delete(l); };
  }, []);
  return idx;
}

/** The hold row for a customer when it is on hold, else null. */
export function holdFor(idx: HoldIndex | null, target: { netsuiteId?: string | number | null; customerId?: string | null }): CustomerHoldRow | null {
  if (!idx) return null;
  const row = (target.netsuiteId != null && target.netsuiteId !== '' ? idx.byNs.get(String(target.netsuiteId)) : undefined)
    || (target.customerId ? idx.byCustomer.get(target.customerId) : undefined);
  return row && isOnHold(row) ? row : null;
}

let canManageCache: Promise<boolean> | null = null;
function fetchCanManage(): Promise<boolean> {
  canManageCache ||= fetch('/api/customer-holds').then(r => r.ok ? r.json() : { canManage: false })
    .then(d => !!d.canManage).catch(() => false);
  return canManageCache;
}

/** May the signed-in person hold, release and override (admins and A/R)? */
export function useCanManageHolds(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => { let live = true; fetchCanManage().then(v => { if (live) setCan(v); }); return () => { live = false; }; }, []);
  return can;
}

/** Small red "On hold" pill; renders nothing when the customer isn't on hold. */
export function OnHoldBadge({ netsuiteId, customerId }: { netsuiteId?: string | number | null; customerId?: string | null }) {
  const idx = useCustomerHolds();
  const row = holdFor(idx, { netsuiteId, customerId });
  if (!row) return null;
  return (
    <span
      title={`On hold for nonpayment. ${holdReason(row)}.`}
      style={{
        display: 'inline-block', fontSize: '10px', fontWeight: 800, letterSpacing: '0.03em',
        padding: '2px 6px', borderRadius: '5px', whiteSpace: 'nowrap', verticalAlign: 'middle',
        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.5)', color: '#ef4444',
      }}
    >
      ⛔ ON HOLD
    </span>
  );
}

/**
 * Red banner saying the customer is on hold and why. With `controls`, admins
 * and A/R also get Put on hold / Release / Back to automatic.
 */
export function CustomerHoldBanner({ netsuiteId, customerId, customerName, controls = false }: {
  netsuiteId?: string | number | null;
  customerId?: string | null;
  customerName?: string | null;
  controls?: boolean;
}) {
  const idx = useCustomerHolds();
  const canManage = useCanManageHolds();
  const dialog = useDialog();
  const [busy, setBusy] = useState(false);
  const nsId = netsuiteId != null && netsuiteId !== '' ? String(netsuiteId) : null;
  const raw = idx ? ((nsId ? idx.byNs.get(nsId) : undefined) || (customerId ? idx.byCustomer.get(customerId) : undefined)) : undefined;
  const held = isOnHold(raw);
  const showControls = controls && canManage && !!(nsId || raw?.netsuite_customer_id);

  const act = useCallback(async (action: 'hold' | 'release' | 'clear') => {
    const id = nsId || raw?.netsuite_customer_id;
    if (!id) return;
    let note = '';
    if (action !== 'clear') {
      const typed = await dialog.prompt(
        action === 'hold'
          ? 'Why is this customer going on hold? The sales rep and A/R are told.'
          : 'Why release this customer? They stay off hold until someone puts them back to automatic, even if invoices stay past due.',
        '',
        { title: action === 'hold' ? 'Put on hold' : 'Release hold', confirmLabel: action === 'hold' ? 'Put on hold' : 'Release', placeholder: 'Reason (required)' },
      );
      if (typed === null || !typed.trim()) return;
      note = typed.trim();
    }
    setBusy(true);
    try {
      const res = await fetch('/api/customer-holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ netsuiteId: id, action, note, customerName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { await dialog.alert(data.error || `Request failed (${res.status})`); return; }
      await reloadHolds();
    } catch (e: any) {
      await dialog.alert(e?.message || 'Network error');
    } finally {
      setBusy(false);
    }
  }, [nsId, raw?.netsuite_customer_id, customerName, dialog]);

  if (!held && !showControls) return null;

  const btn = (label: string, action: 'hold' | 'release' | 'clear') => (
    <button
      type="button"
      disabled={busy}
      onClick={() => act(action)}
      style={{
        fontSize: '12px', fontWeight: 700, padding: '5px 10px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid var(--border)', background: 'var(--bg-card, transparent)', color: 'var(--text-primary)',
      }}
    >
      {label}
    </button>
  );

  if (!held) {
    // Not on hold: managers get a quiet control (and see a release they set).
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', margin: '8px 0', fontSize: '12px', color: 'var(--text-muted)' }}>
        {raw?.manual === 'release' && (
          <span>Hold released by hand{raw.manual_note ? `: ${raw.manual_note}` : ''}{raw.auto_hold ? ' (invoices are still 60+ days past due)' : ''}.</span>
        )}
        {btn('⛔ Put on hold', 'hold')}
        {raw?.manual === 'release' && btn('Back to automatic', 'clear')}
      </div>
    );
  }

  return (
    <div style={{
      margin: '8px 0', padding: '10px 12px', borderRadius: '8px',
      background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.5)',
    }}>
      <div style={{ fontWeight: 800, color: '#ef4444', fontSize: '14px' }}>
        ⛔ {customerName || raw?.customer_name || 'This customer'} is on hold for nonpayment
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
        {holdReason(raw!)}. Sending an estimate or quote and creating a sales order need an admin or A/R override with a reason.
      </div>
      {showControls && (
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
          {btn('✅ Release', 'release')}
          {raw?.manual === 'hold' && raw.auto_hold === false && btn('Back to automatic', 'clear')}
        </div>
      )}
    </div>
  );
}
