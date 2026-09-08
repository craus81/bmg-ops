'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';

/**
 * Materials on hand (R6-2): rolls of film and premask, cartridges of ink.
 * The shop bought all three by the roll and counted none of them — the roll
 * plan could say a job needs 38 linear feet while nobody could say whether
 * 38 feet existed in the building.
 *
 * Each physical roll is its own row on purpose: that is what makes "the
 * longest single roll" answerable, and it lets remnants track themselves
 * instead of dissolving into one bulk number that lies about what can
 * actually print.
 */

interface Summary {
  key: string; materialName: string; kind: string; unit: string;
  openRolls: number; totalRemaining: number; longestRoll: number;
}
interface Roll {
  id: string; materialName: string; kind: string; unit: string;
  widthIn: number | null; initialQty: number; remainingQty: number;
  cost: number | null; vendorName: string | null; receivedAt: string;
  status: string; notes: string | null;
}
interface LowStock {
  key: string; kind: string; materialName: string; unit: string;
  onHand: number; reorderAt: number; suggestedQty: number; vendorName: string | null;
}
interface Setting {
  id: string; kind: string; material_key: string; material_name: string;
  unit: string; reorder_at: number | null; order_up_to: number | null;
  vendor_name: string | null; item_number: string | null;
}

const KIND_LABEL: Record<string, string> = { film: 'Film', premask: 'Premask', ink: 'Ink' };
const num = (v: string) => (v.trim() === '' ? null : parseFloat(v));

export default function MaterialsPage() {
  const router = useRouter();
  const { user, isAdmin, hasFeature, loading: authLoading } = useAuth();

  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [rolls, setRolls] = useState<Roll[]>([]);
  const [lowStock, setLowStock] = useState<LowStock[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDepleted, setShowDepleted] = useState(false);

  const [rx, setRx] = useState({ materialName: '', kind: 'film', widthIn: '', quantity: '', rolls: '1', cost: '', vendorName: '' });
  const [pol, setPol] = useState({ materialName: '', kind: 'film', reorderAt: '', orderUpTo: '', vendorName: '', itemNumber: '' });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [stockRes, setRes] = await Promise.all([
        apiFetch('/api/materials/rolls'),
        apiFetch('/api/materials/stock-settings'),
      ]);
      const stock = await stockRes.json();
      if (!stockRes.ok) throw new Error(stock?.error || `HTTP ${stockRes.status}`);
      setSummaries(stock.summaries || []);
      setRolls(stock.rolls || []);
      setLowStock(stock.lowStock || []);
      if (setRes.ok) setSettings((await setRes.json()).settings || []);
    } catch (e: any) {
      setError(e?.message || 'Could not load materials');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isAdmin && !hasFeature('graphics') && !hasFeature('parts_ordering')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load after auth
  }, [authLoading, user]);

  const receive = async () => {
    if (busy || !rx.materialName.trim() || !num(rx.quantity)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/materials/rolls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          materialName: rx.materialName.trim(),
          kind: rx.kind,
          widthIn: rx.kind === 'ink' ? null : num(rx.widthIn),
          quantity: num(rx.quantity),
          rolls: parseInt(rx.rolls || '1', 10) || 1,
          cost: num(rx.cost),
          vendorName: rx.vendorName.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body?.error || 'Receive failed'); return; }
      setRx({ materialName: '', kind: 'film', widthIn: '', quantity: '', rolls: '1', cost: '', vendorName: '' });
      await load();
    } finally { setBusy(false); }
  };

  const savePolicy = async () => {
    if (busy || !pol.materialName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch('/api/materials/stock-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: pol.kind,
          materialName: pol.materialName.trim(),
          reorderAt: num(pol.reorderAt),
          orderUpTo: num(pol.orderUpTo),
          vendorName: pol.vendorName.trim() || null,
          itemNumber: pol.itemNumber.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body?.error || 'Save failed'); return; }
      setPol({ materialName: '', kind: 'film', reorderAt: '', orderUpTo: '', vendorName: '', itemNumber: '' });
      await load();
    } finally { setBusy(false); }
  };

  const adjust = async (id: string, patch: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/materials/rolls', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...patch }),
      });
      if (!res.ok) setError((await res.json())?.error || 'Update failed');
      await load();
    } finally { setBusy(false); }
  };

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px',
  };
  const th: React.CSSProperties = { padding: '9px 12px', fontWeight: 700, fontSize: '11px', color: 'var(--text-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: '12.5px' };
  const label: React.CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' };

  const visibleRolls = rolls.filter(r => showDepleted || r.status === 'open');

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Materials on hand</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Film and premask by the roll, ink by the cartridge. Every physical roll is its own row, so a run
          longer than the longest single roll shows up before it&apos;s on the printer.
        </div>
      </div>

      {error && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{error}</div>}

      {lowStock.length > 0 && (
        <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: '10px', padding: '10px 12px', marginBottom: '14px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: '#f59e0b', marginBottom: '4px' }}>
            {lowStock.length} material{lowStock.length !== 1 ? 's' : ''} at or below the reorder point
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-body)' }}>
            {lowStock.map(l => `${l.materialName}: ${l.onHand} ${l.unit} left, reorder at ${l.reorderAt} (suggest ${l.suggestedQty})`).join(' · ')}
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
            The nightly sweep raises these into <a href="/admin/purchasing" style={{ color: '#60a5fa' }}>Purchasing</a> as requests — it queues, it never cuts a PO.
          </div>
        </div>
      )}

      {loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '16px 0' }}>Loading…</div>}

      {/* On-hand rollup */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', marginBottom: '16px' }}>
        <div style={{ padding: '10px 12px', fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>By material</div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Material</th><th style={th}>Kind</th><th style={th}>Open rolls</th>
              <th style={th}>On hand</th><th style={th}>Longest roll</th><th style={th}>Reorder at</th>
            </tr></thead>
            <tbody>
              {summaries.map(s => {
                const setting = settings.find(x => x.kind === s.kind && x.material_name.trim().toUpperCase() === s.materialName.trim().toUpperCase());
                const low = setting?.reorder_at != null && s.totalRemaining <= Number(setting.reorder_at);
                return (
                  <tr key={s.key}>
                    <td style={{ ...td, fontWeight: 700 }}>{s.materialName}</td>
                    <td style={td}>{KIND_LABEL[s.kind] || s.kind}</td>
                    <td style={td}>{s.openRolls}</td>
                    <td style={{ ...td, fontWeight: 800, color: low ? '#f59e0b' : 'var(--text-primary)' }}>
                      {s.totalRemaining} {s.unit}
                    </td>
                    <td style={td}>{s.longestRoll} {s.unit}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>
                      {setting?.reorder_at != null ? `${setting.reorder_at} ${s.unit}` : 'watched only'}
                    </td>
                  </tr>
                );
              })}
              {!loading && summaries.length === 0 && (
                <tr><td style={{ ...td, color: 'var(--text-muted)', fontStyle: 'italic' }} colSpan={6}>Nothing received yet — log a roll below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Receive */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '16px' }}>
        <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Receive stock</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={label}>Material</div>
            <input value={rx.materialName} onChange={e => setRx({ ...rx, materialName: e.target.value })} placeholder="e.g. IJ280" style={{ ...input, width: '150px' }} /></div>
          <div><div style={label}>Kind</div>
            <select value={rx.kind} onChange={e => setRx({ ...rx, kind: e.target.value })} style={{ ...input, width: '110px' }}>
              <option value="film">Film</option><option value="premask">Premask</option><option value="ink">Ink</option>
            </select></div>
          {rx.kind !== 'ink' && (
            <div><div style={label}>Width (in)</div>
              <input type="number" value={rx.widthIn} onChange={e => setRx({ ...rx, widthIn: e.target.value })} placeholder="54" style={{ ...input, width: '80px' }} /></div>
          )}
          <div><div style={label}>{rx.kind === 'ink' ? 'Cartridges each' : 'Length (ft) each'}</div>
            <input type="number" value={rx.quantity} onChange={e => setRx({ ...rx, quantity: e.target.value })} placeholder={rx.kind === 'ink' ? '1' : '150'} style={{ ...input, width: '110px' }} /></div>
          <div><div style={label}>How many</div>
            <input type="number" min={1} value={rx.rolls} onChange={e => setRx({ ...rx, rolls: e.target.value })} style={{ ...input, width: '80px' }} /></div>
          <div><div style={label}>Cost each</div>
            <input type="number" value={rx.cost} onChange={e => setRx({ ...rx, cost: e.target.value })} placeholder="$" style={{ ...input, width: '90px' }} /></div>
          <div><div style={label}>Vendor</div>
            <input value={rx.vendorName} onChange={e => setRx({ ...rx, vendorName: e.target.value })} placeholder="Grimco" style={{ ...input, width: '130px' }} /></div>
          <button onClick={receive} disabled={busy || !rx.materialName.trim() || !num(rx.quantity)} style={{
            padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, border: 'none',
            background: busy ? 'var(--border)' : '#22c55e', color: '#fff', cursor: busy ? 'default' : 'pointer',
          }}>{busy ? 'Saving…' : 'Receive'}</button>
        </div>
      </div>

      {/* Reorder policy (admin) */}
      {isAdmin && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '16px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>Reorder point</div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
            Leave the point blank to watch a material without ever auto-ordering it — the same opt-in rule the parts sweep uses.
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div><div style={label}>Material</div>
              <input value={pol.materialName} onChange={e => setPol({ ...pol, materialName: e.target.value })} placeholder="e.g. IJ280" style={{ ...input, width: '150px' }} /></div>
            <div><div style={label}>Kind</div>
              <select value={pol.kind} onChange={e => setPol({ ...pol, kind: e.target.value })} style={{ ...input, width: '110px' }}>
                <option value="film">Film</option><option value="premask">Premask</option><option value="ink">Ink</option>
              </select></div>
            <div><div style={label}>Reorder at</div>
              <input type="number" value={pol.reorderAt} onChange={e => setPol({ ...pol, reorderAt: e.target.value })} style={{ ...input, width: '90px' }} /></div>
            <div><div style={label}>Order up to</div>
              <input type="number" value={pol.orderUpTo} onChange={e => setPol({ ...pol, orderUpTo: e.target.value })} style={{ ...input, width: '90px' }} /></div>
            <div><div style={label}>Vendor</div>
              <input value={pol.vendorName} onChange={e => setPol({ ...pol, vendorName: e.target.value })} style={{ ...input, width: '120px' }} /></div>
            <div><div style={label}>NetSuite item</div>
              <input value={pol.itemNumber} onChange={e => setPol({ ...pol, itemNumber: e.target.value })} placeholder="optional" style={{ ...input, width: '130px' }} /></div>
            <button onClick={savePolicy} disabled={busy || !pol.materialName.trim()} style={{
              padding: '8px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, border: 'none',
              background: busy ? 'var(--border)' : '#3b82f6', color: '#fff', cursor: busy ? 'default' : 'pointer',
            }}>Save point</button>
          </div>
        </div>
      )}

      {/* Individual rolls */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>Individual rolls</div>
          <span style={{ flex: 1 }} />
          <button onClick={() => setShowDepleted(v => !v)} style={{
            fontSize: '10.5px', fontWeight: 700, padding: '4px 10px', borderRadius: '6px',
            background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer',
          }}>{showDepleted ? 'Hide used up' : 'Show used up'}</button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Material</th><th style={th}>Width</th><th style={th}>Remaining</th>
              <th style={th}>Received</th><th style={th}>Vendor</th><th style={th}>Status</th><th style={th} />
            </tr></thead>
            <tbody>
              {visibleRolls.map(r => (
                <tr key={r.id}>
                  <td style={{ ...td, fontWeight: 700 }}>{r.materialName} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>{KIND_LABEL[r.kind]}</span></td>
                  <td style={td}>{r.widthIn ? `${r.widthIn}"` : '—'}</td>
                  <td style={td}>
                    {r.remainingQty} / {r.initialQty} {r.unit}
                    <div style={{ height: '4px', borderRadius: '2px', background: 'var(--subtle-bg)', marginTop: '3px', overflow: 'hidden' }}>
                      <div style={{ width: `${Math.min(100, (r.remainingQty / r.initialQty) * 100)}%`, height: '100%', background: r.remainingQty / r.initialQty < 0.25 ? '#f59e0b' : '#22c55e' }} />
                    </div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{r.receivedAt}</td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{r.vendorName || '—'}</td>
                  <td style={td}>{r.status}</td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.status === 'open' && (
                      <>
                        <button
                          onClick={() => {
                            const v = window.prompt(`Recount ${r.materialName} — ${r.unit} remaining on this roll:`, String(r.remainingQty));
                            if (v != null && v.trim() !== '') adjust(r.id, { remainingQty: parseFloat(v) });
                          }}
                          style={{ fontSize: '10.5px', fontWeight: 700, color: '#60a5fa', background: 'transparent', border: 'none', cursor: 'pointer' }}
                        >Recount</button>
                        <button onClick={() => adjust(r.id, { status: 'scrapped' })}
                          style={{ fontSize: '10.5px', fontWeight: 700, color: '#ef4444', background: 'transparent', border: 'none', cursor: 'pointer', marginLeft: '8px' }}
                        >Scrap</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && visibleRolls.length === 0 && (
                <tr><td style={{ ...td, color: 'var(--text-muted)', fontStyle: 'italic' }} colSpan={7}>No rolls to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
