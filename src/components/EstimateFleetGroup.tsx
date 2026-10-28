'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { closeOnEscape } from '@/lib/modal-escape';
import { deepLinks } from '@/lib/deep-links';
import type { FleetMember } from '@/lib/estimate-fleet';

interface JoinableEstimate {
  id: string;
  estimate_number: string;
  title: string | null;
  unit_number: string | null;
  grand_total: number | null;
  status: string | null;
}

/**
 * Fleet orders on the estimate builder (Craig, 2026-10-19): the same build
 * on several vehicles, one estimate per vehicle (each becomes its own sales
 * order and work order). Shows the other estimates of this one's order and
 * the "Copy for more vehicles" button that makes them, and "Join an
 * existing estimate" (Craig, 2026-10-28), which pulls in the same
 * customer's estimates that were built on their own.
 *
 * Server side: /api/estimates/[id]/fleet-copies and /fleet-group,
 * src/lib/estimate-fleet.ts, migration 410.
 */
export default function EstimateFleetGroup({
  estimateId,
  estimateNumber,
  unitNumber,
  poNumber,
  locked,
  busy,
  prepare,
  onOpen,
  onCopied,
}: {
  estimateId: string;
  estimateNumber: string;
  /** The unit number on screen for this estimate. */
  unitNumber: string;
  poNumber: string;
  locked: boolean;
  busy: boolean;
  /** Save the estimate first so the copies match the screen. False = stop. */
  prepare: () => Promise<boolean>;
  onOpen: (id: string) => void;
  /** Copies made; `sourceUnit` is set when this estimate got its unit number from the form. */
  onCopied: (sourceUnit: string | null) => void;
}) {
  const dialog = useDialog();
  const [members, setMembers] = useState<FleetMember[]>([]);
  const [joinable, setJoinable] = useState<JoinableEstimate[]>([]);
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinPick, setJoinPick] = useState<string[]>([]);
  const [joining, setJoining] = useState(false);
  const [job, setJob] = useState<{ id: string; job_number: string | null; status: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<{ unit: string; stock: string; vin: string }[]>([{ unit: '', stock: '', vin: '' }]);
  const [sourceUnit, setSourceUnit] = useState('');
  const [keepPo, setKeepPo] = useState(true);
  const [saving, setSaving] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/estimates/${estimateId}/fleet-group`);
      const d = await res.json().catch(() => ({}));
      setMembers(res.ok && Array.isArray(d.members) ? d.members : []);
      setJob(res.ok && d.job ? d.job : null);
      setJoinable(res.ok && Array.isArray(d.joinable) ? d.joinable : []);
    } catch {
      setMembers([]);
      setJoinable([]);
      setJob(null);
    }
  }, [estimateId]);

  useEffect(() => { load(); }, [load]);

  const inGroup = members.length > 1;
  const needsSourceUnit = !unitNumber.trim();

  const startCopy = () => {
    setRows([{ unit: '', stock: '', vin: '' }]);
    setSourceUnit('');
    setKeepPo(true);
    setOpen(true);
  };

  const filled = rows.filter(r => r.unit.trim());
  const canCopy = filled.length > 0 && (!needsSourceUnit || (!locked && sourceUnit.trim()));

  const makeCopies = async () => {
    if (!canCopy || saving) return;
    setSaving(true);
    try {
      if (!(await prepare())) return;
      const res = await fetch(`/api/estimates/${estimateId}/fleet-copies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicles: filled.map(r => ({ unitNumber: r.unit.trim(), stockNumber: r.stock.trim() || null, vin: r.vin.trim() || null })),
          sourceUnitNumber: needsSourceUnit ? sourceUnit.trim() : null,
          keepPo: !!poNumber.trim() && keepPo,
        }),
      });
      const d = await res.json().catch(() => ({}));
      await load();
      if (!res.ok || !d.success) {
        await dialog.alert(d.error || 'Could not make the copies.');
        return;
      }
      setOpen(false);
      onCopied(needsSourceUnit ? sourceUnit.trim() : null);
    } catch {
      await dialog.alert('Network error. Nothing new was saved, try again.');
    } finally {
      setSaving(false);
    }
  };

  const startJoin = () => {
    setJoinPick([]);
    setJoinOpen(true);
    load();
  };

  const joinOrder = async () => {
    if (joinPick.length === 0 || joining) return;
    setJoining(true);
    try {
      if (!(await prepare())) return;
      const res = await fetch(`/api/estimates/${estimateId}/fleet-group`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ joinIds: joinPick }),
      });
      const d = await res.json().catch(() => ({}));
      await load();
      if (!res.ok || !d.success) {
        await dialog.alert(d.error || 'Could not join them to the order.');
        return;
      }
      setJoinOpen(false);
      onCopied(null);
    } catch {
      await dialog.alert('Network error. Nothing was joined, try again.');
    } finally {
      setJoining(false);
    }
  };

  const leaveGroup = async () => {
    if (!(await dialog.confirm(`Take ${estimateNumber} out of this fleet order? The other estimates stay together, and Graphics Builder changes stop reaching this one.`, { confirmLabel: 'Take it out' }))) return;
    setLeaving(true);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/fleet-group`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        await dialog.alert(d.error || 'Could not take it out of the order.');
      }
      await load();
    } finally {
      setLeaving(false);
    }
  };

  const chip = (m: FleetMember) => {
    if (m.netsuite_so_id) return { text: m.netsuite_so_number || 'On SO', color: '#60a5fa' };
    if (m.customer_approved || m.status === 'accepted') return { text: 'Approved', color: '#34d399' };
    if (m.status === 'rejected') return { text: 'Declined', color: '#f87171' };
    return { text: m.status === 'draft' ? 'Draft' : (m.status || 'Draft'), color: 'var(--text-muted)' };
  };

  const input: React.CSSProperties = {
    padding: '7px 9px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', minWidth: 0, width: '100%',
  };

  return (
    <>
      {inGroup && (
        <div style={{ border: '1px solid rgba(238,49,32,0.3)', background: 'rgba(238,49,32,0.06)', borderRadius: '10px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)' }}>Fleet order · {members.length} vehicles</span>
            {job && (
              <a
                href={deepLinks.graphicsJob(job.id)}
                title="The order's one graphics job, with a kit for each unit"
                style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}
              >
                Graphics {job.job_number || 'job'} · {members.length} kits ›
              </a>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {members.map(m => {
              const c = chip(m);
              const me = m.id === estimateId;
              return (
                <button
                  key={m.id}
                  onClick={() => !me && onOpen(m.id)}
                  disabled={me}
                  title={me ? 'This estimate' : `Open ${m.estimate_number}`}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                    padding: '6px 9px', borderRadius: '8px', textAlign: 'left',
                    border: me ? '1px solid rgba(238,49,32,0.55)' : '1px solid var(--border)',
                    background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px',
                    cursor: me ? 'default' : 'pointer',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b>Unit {m.unit_number || '?'}</b>{m.stock_number ? ` · Stock ${m.stock_number}` : ''} · {m.estimate_number}
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: c.color, whiteSpace: 'nowrap' }}>{c.text}</span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
            Saving the graphics in Graphics Builder updates every estimate here that isn&rsquo;t approved or on a sales order yet.
          </div>
          <button
            onClick={leaveGroup}
            disabled={leaving}
            style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: 'var(--text-muted)', fontSize: '11px', textDecoration: 'underline', cursor: 'pointer' }}
          >
            {leaving ? 'Taking it out…' : `Take ${estimateNumber} out of this order`}
          </button>
        </div>
      )}

      <button
        onClick={startCopy}
        disabled={busy || saving}
        title="Make an estimate for each other vehicle in this order: same customer, lines, graphics and price, with its own unit number and VIN."
        style={{
          width: '100%', padding: '10px', borderRadius: '10px',
          background: 'rgba(238,49,32,0.08)', border: '1px solid rgba(238,49,32,0.3)',
          color: '#ee3120', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
          opacity: busy || saving ? 0.5 : 1,
        }}
      >
        {inGroup ? '+ Add a vehicle to this order' : 'Copy for more vehicles'}
      </button>

      {!locked && (
        <button
          onClick={startJoin}
          disabled={busy || joining}
          title="Pull in this customer's other estimates that were built on their own, so they become one order and can be sent for approval in one email."
          style={{
            width: '100%', padding: '10px', borderRadius: '10px',
            background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.25)',
            color: '#60a5fa', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
            opacity: busy || joining ? 0.5 : 1,
          }}
        >
          ⇄ Join an existing estimate{inGroup ? ' to this order' : ''}
        </button>
      )}

      {joinOpen && (
        <div
          ref={closeOnEscape(() => !joining && setJoinOpen(false))}
          onClick={() => !joining && setJoinOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 70 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: '100%', maxWidth: '520px', maxHeight: 'calc(88vh / var(--ts))', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Join estimates to {estimateNumber}&rsquo;s fleet order
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              They become one order, the same as Copy for more vehicles. Send for Approval then offers them all in one email, the order&rsquo;s graphics job gets a kit for each, and saving the graphics in Graphics Builder updates all of them. Only this customer&rsquo;s open estimates that aren&rsquo;t in another order are listed.
            </div>
            {joinable.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                No other open estimates for this customer.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {joinable.map(j => {
                  const on = joinPick.includes(j.id);
                  return (
                    <label
                      key={j.id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
                        border: `1px solid ${on ? 'rgba(52,211,153,0.45)' : 'var(--border)'}`,
                        background: on ? 'rgba(52,211,153,0.08)' : 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '12px',
                      }}
                    >
                      <input
                        id={`fleet-join-${j.id}`}
                        type="checkbox"
                        checked={on}
                        onChange={() => setJoinPick(p => (on ? p.filter(x => x !== j.id) : [...p, j.id]))}
                        style={{ width: '16px', height: '16px', accentColor: '#34d399', flexShrink: 0 }}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {j.estimate_number}{j.unit_number ? ` · Unit ${j.unit_number}` : ''}
                        </span>
                        {j.title && <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.title}</span>}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        ${(Number(j.grand_total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
              <button
                onClick={() => setJoinOpen(false)}
                disabled={joining}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={joinOrder}
                disabled={joinPick.length === 0 || joining}
                style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: '#059669', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: joinPick.length ? 'pointer' : 'default', opacity: joinPick.length === 0 || joining ? 0.5 : 1 }}
              >
                {joining ? 'Joining…' : `Join ${joinPick.length || ''} to this order`.replace('  ', ' ')}
              </button>
            </div>
          </div>
        </div>
      )}

      {open && (
        <div
          ref={closeOnEscape(() => !saving && setOpen(false))}
          onClick={() => !saving && setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 70 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: '100%', maxWidth: '520px', maxHeight: 'calc(88vh / var(--ts))', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Copy {estimateNumber} for more vehicles
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Each vehicle gets its own draft estimate with the same customer, lines, graphics and price. They stay linked as one order, so the graphics department makes one job with a kit per unit number.
            </div>

            {needsSourceUnit && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>
                {estimateNumber}&rsquo;s own unit number
                {locked
                  ? <span style={{ fontWeight: 400, color: '#f87171' }}>This estimate is locked and has no unit number, so it can&rsquo;t start an order. Copy it from a draft instead.</span>
                  : <input id="fleet-source-unit" value={sourceUnit} onChange={e => setSourceUnit(e.target.value)} placeholder="e.g. 101" style={input} />}
              </label>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr) 28px', gap: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <span>Unit #</span><span>Stock #</span><span>VIN (can add later)</span><span />
              </div>
              {rows.map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.6fr) 28px', gap: '6px', alignItems: 'center' }}>
                  <input
                    id={`fleet-unit-${i}`}
                    value={r.unit}
                    onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))}
                    placeholder="Unit #"
                    style={input}
                  />
                  <input
                    id={`fleet-stock-${i}`}
                    value={r.stock}
                    onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, stock: e.target.value } : x))}
                    placeholder="Stock #"
                    style={input}
                  />
                  <input
                    id={`fleet-vin-${i}`}
                    value={r.vin}
                    maxLength={17}
                    onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, vin: e.target.value.toUpperCase() } : x))}
                    placeholder="VIN"
                    style={{ ...input, fontFamily: 'ui-monospace, monospace' }}
                  />
                  <button
                    onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, j) => j !== i) : [{ unit: '', stock: '', vin: '' }])}
                    title="Remove this vehicle"
                    style={{ border: 'none', background: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer' }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                onClick={() => setRows(rs => [...rs, { unit: '', stock: '', vin: '' }])}
                disabled={rows.length >= 25}
                style={{ alignSelf: 'flex-start', padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
              >
                + Another vehicle
              </button>
            </div>

            {poNumber.trim() && (
              <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--text-primary)' }}>
                <input id="fleet-keep-po" type="checkbox" checked={keepPo} onChange={e => setKeepPo(e.target.checked)} />
                Use the same customer PO # ({poNumber.trim()}) on every copy
              </label>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {filled.length > 0 ? `Makes ${filled.length} draft estimate${filled.length === 1 ? '' : 's'}` : 'Add a unit number for each vehicle'}
              </span>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setOpen(false)}
                  disabled={saving}
                  style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={makeCopies}
                  disabled={!canCopy || saving}
                  style={{ padding: '8px 14px', borderRadius: '8px', border: 'none', background: '#ee3120', color: '#fff', fontSize: '12px', fontWeight: 800, cursor: canCopy ? 'pointer' : 'default', opacity: !canCopy || saving ? 0.5 : 1 }}
                >
                  {saving ? 'Making estimates…' : `Make ${filled.length || ''} estimate${filled.length === 1 ? '' : 's'}`.replace('  ', ' ')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
