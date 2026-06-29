'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { periodForDate, shiftPeriod, toDateString, formatPeriod, type PayPeriod } from '@/lib/payroll';

interface PayrollCredit {
  id: string;
  profile_id: string;
  profile_name: string;
  vin: string | null;
  part_number: string | null;
  share_weight: number;
  crew_size: number;
  amount: number | null;
  payout_id: string | null;
  created_at: string;
}

/**
 * Biweekly payroll report for field installs (anchored 6/15/26). Field
 * workers are W-2 — credits here are never NetSuite-billed: export the CSV
 * for payroll, then mark the period paid to lock its credits.
 */
export default function PayrollPage() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const supabase = createClient();

  const [period, setPeriod] = useState<PayPeriod>(() => periodForDate(new Date()));
  const [credits, setCredits] = useState<PayrollCredit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [confirmPay, setConfirmPay] = useState(false);
  // How the per-installer list is ordered. Default keeps the old behavior
  // (biggest payout first); 'name' lets you find a given installer fast.
  const [sortBy, setSortBy] = useState<'total' | 'name' | 'vehicles'>('total');

  const authHeaders = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    return {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    } as Record<string, string>;
  };

  const load = useCallback(async (p: PayPeriod) => {
    setLoading(true);
    setError('');
    const res = await fetch(
      `/api/admin/payroll?start=${toDateString(p.start)}&endExclusive=${toDateString(p.endExclusive)}`,
      { headers: await authHeaders() },
    );
    if (res.ok) setCredits((await res.json()).credits || []);
    else setCredits([]);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    load(period);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, period]);

  const byPerson = new Map<string, { name: string; rows: PayrollCredit[]; total: number; unpriced: number; locked: number }>();
  for (const c of credits) {
    const t = byPerson.get(c.profile_id) || { name: c.profile_name, rows: [], total: 0, unpriced: 0, locked: 0 };
    t.rows.push(c);
    if (c.amount != null) t.total += Number(c.amount);
    else t.unpriced++;
    if (c.payout_id) t.locked++;
    byPerson.set(c.profile_id, t);
  }
  const people = [...byPerson.entries()].sort((a, b) =>
    sortBy === 'name' ? a[1].name.localeCompare(b[1].name)
    : sortBy === 'vehicles' ? b[1].rows.length - a[1].rows.length
    : b[1].total - a[1].total,
  );
  const grandTotal = people.reduce((s, [, p]) => s + p.total, 0);
  const unpricedTotal = credits.filter(c => c.amount == null).length;
  const openCount = credits.filter(c => !c.payout_id).length;
  const allPaid = credits.length > 0 && openCount === 0;

  const exportCsv = () => {
    const esc = (v: string | number | null) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      ['Employee', 'Vehicles', 'Total', 'Period Start', 'Period End'].join(','),
      ...people.map(([, p]) => [
        esc(p.name), p.rows.length, p.total.toFixed(2),
        toDateString(period.start), toDateString(period.end),
      ].join(',')),
      '',
      ['Employee', 'Date', 'VIN', 'Part', 'Crew Size', 'Share', 'Amount'].join(','),
      ...credits.map(c => [
        esc(c.profile_name),
        new Date(c.created_at).toLocaleDateString(),
        esc(c.vin), esc(c.part_number), c.crew_size, c.share_weight,
        c.amount != null ? Number(c.amount).toFixed(2) : 'UNPRICED',
      ].join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payroll-${toDateString(period.start)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const markPaid = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/payroll', {
        method: 'POST', headers: await authHeaders(),
        body: JSON.stringify({
          action: 'mark_paid',
          start: toDateString(period.start),
          endExclusive: toDateString(period.endExclusive),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Failed to mark period paid'); return; }
      setNotice(`Marked paid — ${json.payoutsCreated} payout${json.payoutsCreated === 1 ? '' : 's'}, ${json.creditsPaid} credits locked`);
      setTimeout(() => setNotice(''), 5000);
      setConfirmPay(false);
      await load(period);
    } finally {
      setBusy(false);
    }
  };

  if (!isAdmin) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.back()} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>Payroll — Field Installs</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Biweekly per-vehicle pay, split by crew shift</div>
        </div>
      </div>

      {/* Period picker */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 16px', borderRadius: '12px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)',
      }}>
        <button onClick={() => setPeriod(shiftPeriod(period, -1))} style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-secondary)', padding: '4px 10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '8px' }}>←</button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{formatPeriod(period)}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: allPaid ? 'var(--success)' : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            {credits.length === 0 ? 'No credits' : allPaid ? '✓ Paid' : `${openCount} credits open`}
          </div>
        </div>
        <button onClick={() => setPeriod(shiftPeriod(period, 1))} style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-secondary)', padding: '4px 10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', borderRadius: '8px' }}>→</button>
      </div>

      {notice && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--success-bg)', border: '1px solid var(--success-border)', color: 'var(--success)', fontSize: '12px', fontWeight: 700 }}>✓ {notice}</div>
      )}
      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', fontSize: '12px', fontWeight: 600 }}>{error}</div>
      )}
      {unpricedTotal > 0 && (
        <button onClick={() => router.push('/admin/pay-rates')} style={{ width: '100%', textAlign: 'left', padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
          {unpricedTotal} credit{unpricedTotal === 1 ? '' : 's'} unpriced — tap to set rates before paying this period
        </button>
      )}

      {loading ? (
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
      ) : credits.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          No field credits in this period.
        </div>
      ) : (
        <>
          {/* Sort control — order the installer list by name, vehicles, or pay */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sort</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              {([
                { id: 'total' as const, label: 'Pay' },
                { id: 'vehicles' as const, label: 'Vehicles' },
                { id: 'name' as const, label: 'Installer' },
              ]).map(s => (
                <button key={s.id} onClick={() => setSortBy(s.id)} style={{
                  padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                  background: sortBy === s.id ? 'var(--orange)' : 'var(--card)',
                  color: sortBy === s.id ? '#fff' : 'var(--text-secondary)',
                  border: sortBy === s.id ? 'none' : '1px solid var(--border)',
                }}>{s.label}</button>
              ))}
            </div>
          </div>

          {/* Per-person totals with drill-down */}
          <div style={{ borderRadius: '12px', marginBottom: '14px', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            {people.map(([pid, p]) => (
              <div key={pid} style={{ borderBottom: '1px solid var(--border)' }}>
                <button onClick={() => setOpenPerson(openPerson === pid ? null : pid)} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                  padding: '12px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
                }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{p.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {p.rows.length} vehicle{p.rows.length === 1 ? '' : 's'}
                      {p.unpriced > 0 && <span style={{ color: 'var(--warning)' }}> · {p.unpriced} unpriced</span>}
                      {p.locked > 0 && <span style={{ color: 'var(--success)' }}> · {p.locked} paid</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--success)' }}>${p.total.toFixed(2)}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{openPerson === pid ? '▾' : '▸'}</span>
                  </div>
                </button>
                {openPerson === pid && p.rows.map(c => (
                  <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px', borderTop: '1px solid var(--border)', background: 'var(--input-bg)' }}>
                    <div>
                      <span style={{ fontSize: '11px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{c.vin || '—'}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                        {new Date(c.created_at).toLocaleDateString()} · {c.part_number || '—'} · ÷{c.crew_size}{Number(c.share_weight) !== 1 ? ` ×${c.share_weight}` : ''}
                      </span>
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 700, color: c.amount != null ? 'var(--text-primary)' : 'var(--warning)' }}>
                      {c.amount != null ? `$${Number(c.amount).toFixed(2)}` : 'unpriced'}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--subtle-bg)' }}>
              <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>Period Total</span>
              <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--success)' }}>${grandTotal.toFixed(2)}</span>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
            <button onClick={exportCsv} style={{
              flex: 1, padding: '13px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: 'var(--subtle-bg)', color: 'var(--text-primary)', border: '1px solid var(--border)',
            }}>Download CSV</button>
            {!allPaid && (
              confirmPay ? (
                <div style={{ flex: 1, display: 'flex', gap: '6px' }}>
                  <button onClick={markPaid} disabled={busy || unpricedTotal > 0} style={{
                    flex: 1, padding: '13px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                    background: busy || unpricedTotal > 0 ? 'var(--text-muted)' : 'var(--success)', color: '#fff', border: 'none',
                  }}>{busy ? 'Paying...' : 'Confirm'}</button>
                  <button onClick={() => setConfirmPay(false)} disabled={busy} style={{
                    padding: '13px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                    background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)',
                  }}>✕</button>
                </div>
              ) : (
                <button onClick={() => setConfirmPay(true)} disabled={unpricedTotal > 0} style={{
                  flex: 1, padding: '13px', borderRadius: '10px', fontSize: '13px', fontWeight: 800,
                  background: unpricedTotal > 0 ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
                  opacity: unpricedTotal > 0 ? 0.6 : 1,
                }}>Mark Period Paid</button>
              )
            )}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
            Marking paid creates one payout per employee for this period and locks those credits
            against edits — do it after payroll runs. Already-paid credits are skipped.
          </div>
        </>
      )}

      <div style={{ height: '80px' }} />
    </div>
  );
}
