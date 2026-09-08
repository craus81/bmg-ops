'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

/**
 * CNI payout console (R5-13 b/c): the pay-period batch flow — gather one
 * installer's unlinked CNI credits across ALL jobs into ONE payout → ONE
 * NetSuite vendor bill — plus the aging strip that makes draft-to-paid
 * latency a visible number. Per-job payouts still live on each job's
 * Crew & Pay panel; the NetSuite paid-sync flips billed payouts to paid
 * automatically (the Mark Paid button stays as the override).
 */

interface PeriodPayout {
  id: string; profile_id: string; profile_name: string;
  netsuite_vendor_id: string | null;
  period_start: string | null; period_end: string | null;
  total_amount: number | null; status: string; netsuite_bill_id: string | null;
  created_at: string; paid_at: string | null;
}
interface PendingRow {
  profile_id: string; profile_name: string; netsuite_vendor_id: string | null;
  credits: number; total: number; unpriced: number; oldest: string;
}
interface View {
  payouts: PeriodPayout[];
  aging: Record<string, { count: number; oldestDays: number }>;
  pending: PendingRow[];
}

const BILL_LOCATIONS = ['Wentzville', 'Kansas City', "O'Fallon", 'Social Circle'] as const;
const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toDateStr = (d: Date) => d.toISOString().split('T')[0];

const STATUS_COLORS: Record<string, string> = {
  draft: '#fbbf24', approved: '#60a5fa', billed: '#a78bfa', paid: '#22c55e',
};

export default function CniPayoutsPage() {
  const router = useRouter();
  const { hasFeature, loading: authLoading } = useAuth();
  const dialog = useDialog();

  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate form — prefilled by clicking a pending row.
  const [genProfile, setGenProfile] = useState<PendingRow | null>(null);
  const [genStart, setGenStart] = useState(() => toDateStr(new Date(Date.now() - 14 * 86_400_000)));
  const [genEnd, setGenEnd] = useState(() => toDateStr(new Date()));

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/payouts?view=periods');
      const body = await res.json();
      if (res.ok) setView(body);
      else setError(body?.error || 'Failed to load');
    } catch (e: any) {
      setError(e?.message || 'Failed to load');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once after auth
  }, [authLoading]);

  const act = async (payload: Record<string, unknown>, busyKey: string) => {
    setBusy(busyKey);
    setError(null);
    try {
      const res = await fetch('/api/admin/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) { setError(body?.error || 'Action failed'); return false; }
      await load();
      return true;
    } catch (e: any) {
      setError(e?.message || 'Action failed');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!genProfile) return;
    const ok = await act({
      action: 'generate_period', profileId: genProfile.profile_id,
      periodStart: genStart, periodEnd: genEnd,
    }, 'generate');
    if (ok) setGenProfile(null);
  };

  const createBill = async (p: PeriodPayout) => {
    const location = await dialog.prompt(
      `Bill location for ${p.profile_name} (${BILL_LOCATIONS.join(' / ')}):`, BILL_LOCATIONS[0]);
    if (!location) return;
    if (!(BILL_LOCATIONS as readonly string[]).includes(location.trim())) {
      await dialog.alert(`"${location}" isn't one of the bill locations: ${BILL_LOCATIONS.join(', ')}`);
      return;
    }
    await act({ action: 'create_bill', payoutId: p.id, location: location.trim() }, p.id);
  };

  const recordBill = async (p: PeriodPayout) => {
    const billId = await dialog.prompt('NetSuite bill number or internal id (created manually):', '');
    if (!billId?.trim()) return;
    await act({ action: 'record_bill', payoutId: p.id, netsuiteBillId: billId.trim() }, p.id);
  };

  const chip: React.CSSProperties = {
    padding: '10px 14px', borderRadius: '12px', background: 'var(--card)',
    border: '1px solid var(--border)', minWidth: '120px',
  };
  const btn = (label: string, onClick: () => void, color: string, disabled = false) => (
    <button key={label} onClick={onClick} disabled={disabled} style={{
      padding: '5px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700,
      background: `${color}1a`, border: `1px solid ${color}55`, color,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );

  if (loading) return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: '900px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px' }}>
        <button onClick={() => router.push('/admin/cni')} style={{ fontSize: '20px', color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}>←</button>
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Installer Payouts</h1>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Pay-period batches: one bill per installer per period instead of one per job. Billed payouts flip to Paid automatically when NetSuite pays the bill.
      </div>

      {error && <div style={{ padding: '10px 12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}

      {/* Aging strip — every unpaid payout (per-job AND period) by stage. */}
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {(['draft', 'approved', 'billed'] as const).map(stage => {
          const a = view?.aging?.[stage];
          return (
            <div key={stage} style={chip}>
              <div style={{ fontSize: '18px', fontWeight: 900, color: STATUS_COLORS[stage] }}>{a?.count || 0}</div>
              <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>{stage}</div>
              <div style={{ fontSize: '10px', color: (a?.oldestDays || 0) > 14 ? '#ef4444' : 'var(--text-muted)' }}>
                {a?.count ? `oldest ${a.oldestDays}d` : 'none waiting'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Unpaid work by installer → generate a period batch. */}
      <div style={{ fontSize: '13px', fontWeight: 800, marginBottom: '8px' }}>Unbatched CNI credits</div>
      {(view?.pending || []).length === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>No unassigned CNI credits — everything is on a payout.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
        {(view?.pending || []).map(p => (
          <div key={p.profile_id} style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--card)', border: `1px solid ${genProfile?.profile_id === p.profile_id ? '#3b82f6' : 'var(--border)'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.profile_name}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                  {p.credits} credit{p.credits !== 1 ? 's' : ''} · {fmtMoney(p.total)}
                  {p.unpriced > 0 ? ` · ${p.unpriced} unpriced` : ''} · oldest {p.oldest.slice(0, 10)}
                </span>
              </div>
              {btn(genProfile?.profile_id === p.profile_id ? 'Cancel' : 'Batch a pay period…',
                () => setGenProfile(prev => prev?.profile_id === p.profile_id ? null : p), '#60a5fa')}
            </div>
            {genProfile?.profile_id === p.profile_id && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' }}>
                <input type="date" value={genStart} onChange={e => setGenStart(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>to</span>
                <input type="date" value={genEnd} onChange={e => setGenEnd(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
                {btn(busy === 'generate' ? 'Batching…' : 'Create the batch payout', generate, '#22c55e', busy !== null)}
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  Gathers their unassigned CNI credits dated in the range — across all jobs — into one draft payout.
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Period payouts + lifecycle actions. */}
      <div style={{ fontSize: '13px', fontWeight: 800, marginBottom: '8px' }}>Pay-period payouts</div>
      {(view?.payouts || []).length === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No pay-period payouts yet — batch one above.</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {(view?.payouts || []).map(p => (
          <div key={p.id} style={{ padding: '10px 12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <div>
                <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.profile_name}</span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
                  {p.period_start} – {p.period_end} · {p.total_amount != null ? fmtMoney(p.total_amount) : '—'}
                  {p.netsuite_bill_id ? ` · bill ${p.netsuite_bill_id}` : ''}
                </span>
                <span style={{
                  fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', marginLeft: '8px',
                  textTransform: 'uppercase', color: STATUS_COLORS[p.status] || 'var(--text-muted)',
                  background: `${STATUS_COLORS[p.status] || '#888888'}1f`,
                }}>{p.status}</span>
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {p.status === 'draft' && btn('Approve', () => act({ action: 'approve', payoutId: p.id }, p.id), '#60a5fa', busy !== null)}
                {p.status === 'draft' && btn('Delete draft', () => act({ action: 'delete_draft', payoutId: p.id }, p.id), '#ef4444', busy !== null)}
                {p.status === 'approved' && btn(busy === p.id ? 'Billing…' : 'Create bill in NetSuite', () => createBill(p), '#22c55e', busy !== null)}
                {p.status === 'approved' && btn('Record bill…', () => recordBill(p), '#a78bfa', busy !== null)}
                {p.status === 'billed' && btn('Mark paid (override)', () => act({ action: 'mark_paid', payoutId: p.id }, p.id), '#22c55e', busy !== null)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px' }}>
        The bill's memo carries the per-job breakdown for reconciliation. Per-job payouts still live on each CNI job&apos;s Crew &amp; Pay panel.
      </div>
    </div>
  );
}
