'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { deepLinks } from '@/lib/deep-links';
import type { BrowsePart, KitWithMembers } from '@/components/PartCatalogBrowser';

/**
 * "Add to estimate" chooser for the standalone catalog (the /parts Visual
 * Catalog, where no estimate builder is open — the builder's own Browse
 * Catalog overlay adds directly instead). Takes one part or one package and
 * either appends it to an existing open estimate
 * (POST /api/estimates/[id]/add-lines) or creates a fresh draft estimate
 * around it (POST /api/estimates), then deep-links into the builder.
 *
 * Lines are built exactly like the builder's own addPartLine/addKitLines,
 * so a part added from either door lands identically — packages explode
 * into member lines plus the assembly-labor line.
 */

interface EstimateLite {
  id: string;
  estimate_number: string;
  title: string | null;
  customer_name: string | null;
  status: string;
  grand_total: number;
  updated_at: string;
  netsuite_so_id: string | null;
}

// Stages that can still take lines — accepted estimates are locked to the
// customer-signed snapshot and converted ones already drove a Sales Order
// (the add-lines API enforces the same rule).
const EDITABLE_STATUSES = ['draft', 'pushed', 'sent'];

const STATUS_COLORS: Record<string, string> = {
  draft: '#60a5fa',
  sent: '#fbbf24',
  pushed: '#a78bfa',
};

const money = (v: number | null | undefined) =>
  `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

export default function AddToEstimateModal({ part, kit, onClose }: {
  part?: BrowsePart;
  kit?: KitWithMembers;
  onClose: () => void;
}) {
  const router = useRouter();
  const [estimates, setEstimates] = useState<EstimateLite[] | null>(null);
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState<string | null>(null); // estimate id or 'new'
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; number: string; added: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/estimates');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Failed to load estimates (${res.status})`);
        if (!cancelled) {
          setEstimates(((data.estimates || []) as EstimateLite[])
            .filter(e => !e.netsuite_so_id && EDITABLE_STATUSES.includes(e.status)));
        }
      } catch (err: any) {
        if (!cancelled) {
          setEstimates([]);
          setError(err?.message || 'Failed to load estimates');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = estimates || [];
    const matched = s
      ? list.filter(e =>
          e.estimate_number?.toLowerCase().includes(s) ||
          e.title?.toLowerCase().includes(s) ||
          e.customer_name?.toLowerCase().includes(s))
      : list;
    return matched.slice(0, 40);
  }, [estimates, search]);

  // Mirrors the builder's addPartLine / addKitLines line shapes.
  const buildLines = () => {
    if (part) {
      return [{
        part_id: part.id,
        netsuite_item_id: part.netsuite_id,
        item_number: part.item_number,
        description: part.display_name || part.description || part.item_number,
        quantity: qty,
        unit_price: part.sales_price || 0,
        labor_hours: part.labor_hours || 0,
        is_custom: false,
      }];
    }
    if (!kit) return [];
    return [
      ...kit.members.map(m => ({
        part_id: m.part.id,
        netsuite_item_id: m.part.netsuite_id,
        item_number: m.part.item_number,
        description: m.part.display_name || m.part.marketing_description || m.part.description || m.part.item_number,
        quantity: m.quantity,
        unit_price: m.part.sales_price || 0,
        labor_hours: m.part.labor_hours || 0,
        is_custom: false,
      })),
      // Package-level assembly overhead as its own visible zero-price line,
      // same as the builder's package add.
      ...(kit.labor_adder_hours > 0 ? [{
        part_id: null,
        netsuite_item_id: null,
        item_number: '',
        description: `${kit.name} — assembly labor`,
        quantity: 1,
        unit_price: 0,
        labor_hours: kit.labor_adder_hours,
        is_custom: true,
      }] : []),
    ];
  };

  const addToExisting = async (est: EstimateLite) => {
    if (busy) return;
    setBusy(est.id);
    setError('');
    try {
      const res = await fetch(`/api/estimates/${est.id}/add-lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line_items: buildLines() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Add failed');
      setDone({ id: est.id, number: data.estimate_number || est.estimate_number, added: data.added || 0 });
    } catch (err: any) {
      setError(err?.message || 'Network error — please try again');
    }
    setBusy(null);
  };

  const createNew = async () => {
    if (busy) return;
    setBusy('new');
    setError('');
    try {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      const res = await fetch('/api/estimates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'draft',
          title: kit ? kit.name : '',
          line_items: buildLines(),
          created_by: u?.user?.id || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Create failed');
      // A brand-new draft has no customer yet — jump straight into the
      // builder to finish it.
      router.push(deepLinks.estimate(data.id));
      onClose();
      return;
    } catch (err: any) {
      setError(err?.message || 'Network error — please try again');
    }
    setBusy(null);
  };

  const subjectLabel = part
    ? (part.display_name || part.item_number)
    : `${kit?.name} (${kit?.members.length} part${kit?.members.length !== 1 ? 's' : ''}${(kit?.labor_adder_hours || 0) > 0 ? ' + assembly labor' : ''})`;
  const subjectPrice = part ? (part.sales_price || 0) * qty : kit?.totalPrice || 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg, var(--card))', borderRadius: '16px', border: '1px solid var(--border)', width: '100%', maxWidth: '520px', maxHeight: 'calc(85vh / var(--ts))', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>Add to estimate</div>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>

        {/* What's being added */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subjectLabel}</div>
            {part && <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{part.item_number}</div>}
          </div>
          {part && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>
              Qty
              <input
                type="number"
                min={1}
                value={qty}
                onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                style={{ width: '58px', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))', color: 'var(--text-primary)', fontSize: '12px' }}
              />
            </label>
          )}
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{money(subjectPrice)}</div>
        </div>

        {done ? (
          <div style={{ padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center' }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' }}>
              ✓ Added {done.added} line{done.added !== 1 ? 's' : ''} to {done.number}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => { router.push(deepLinks.estimate(done.id)); onClose(); }}
                style={{ padding: '8px 16px', borderRadius: '9px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer' }}
              >Open estimate</button>
              <button
                onClick={onClose}
                style={{ padding: '8px 16px', borderRadius: '9px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >Keep browsing</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{ padding: '12px 16px 0' }}>
              <button
                onClick={createNew}
                disabled={!!busy}
                style={{ width: '100%', padding: '10px 14px', borderRadius: '10px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer', opacity: busy && busy !== 'new' ? 0.6 : 1 }}
              >
                {busy === 'new' ? 'Creating…' : '+ Create new estimate with this'}
              </button>
              <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', margin: '14px 0 6px' }}>
                …or add to an open estimate
              </div>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by number, title, or customer…"
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg, var(--card))', color: 'var(--text-primary)', fontSize: '12px' }}
              />
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 14px', display: 'flex', flexDirection: 'column', gap: '6px', minHeight: '120px' }}>
              {estimates === null && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>Loading estimates…</div>
              )}
              {estimates !== null && filtered.length === 0 && (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px' }}>
                  {search ? 'No open estimates match.' : 'No open estimates — create a new one above.'}
                </div>
              )}
              {filtered.map(e => (
                <button
                  key={e.id}
                  onClick={() => addToExisting(e)}
                  disabled={!!busy}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '9px 12px', borderRadius: '9px', textAlign: 'left', width: '100%', background: 'var(--card)', border: '1px solid var(--border)', cursor: 'pointer', opacity: busy && busy !== e.id ? 0.6 : 1 }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 800, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{e.estimate_number}</span>
                      <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 6px', borderRadius: '5px', background: `${STATUS_COLORS[e.status] || '#94a3b8'}22`, color: STATUS_COLORS[e.status] || '#94a3b8', textTransform: 'uppercase' }}>{e.status}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[e.title, e.customer_name].filter(Boolean).join(' — ') || 'Untitled'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-primary)' }}>{busy === e.id ? 'Adding…' : money(e.grand_total)}</div>
                    <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{new Date(e.updated_at).toLocaleDateString()}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {error && (
          <div style={{ padding: '0 16px 12px', fontSize: '11px', color: '#f87171' }}>{error}</div>
        )}
      </div>
    </div>
  );
}
