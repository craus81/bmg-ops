'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import InstallerPreviewBanner from '@/components/InstallerPreviewBanner';
import { getInstallerPreview } from '@/lib/installer-preview';

interface EarningRow {
  id: string;
  vin: string | null;
  source: 'cni' | 'field';
  partNumber: string | null;
  crewSize: number;
  shareWeight: number;
  amount: number | null;
  createdAt: string;
  group: string;
  payoutStatus: string; // pending | draft | approved | billed | paid
}

interface PayoutRow {
  id: string;
  kind: 'cni_job' | 'payroll_period';
  label: string;
  amount: number | null;
  status: string; // draft | approved | billed | paid
  createdAt: string;
  paidAt: string | null;
  billedAt: string | null;
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'var(--text-muted)' },
  draft: { label: 'Pending', color: 'var(--text-muted)' },
  approved: { label: 'Approved', color: '#60a5fa' },
  billed: { label: 'Billed', color: '#a78bfa' },
  paid: { label: 'Paid', color: 'var(--success)' },
};

/**
 * My Earnings: every vehicle the signed-in user has pay credit on — CNI jobs
 * and field shifts — with their cut, the crew size it split across, and
 * payout status. Each person sees only their own dollars. Field-source dollar
 * figures are admin-only (field techs are payroll employees; the server
 * strips them) — field rows still list so techs can verify their vehicles
 * were tracked.
 */
export default function MyEarningsPage() {
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  // Admin preview: show the previewed installer's earnings instead.
  const [preview] = useState(() => getInstallerPreview());
  const supabase = createClient();
  const [rows, setRows] = useState<EarningRow[]>([]);
  const [payouts, setPayouts] = useState<PayoutRow[]>([]);
  const [fieldAmountsHidden, setFieldAmountsHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [showAllPayouts, setShowAllPayouts] = useState(false);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const previewParam = isAdmin && preview?.profileId ? `?profileId=${preview.profileId}` : '';
      const res = await fetch(`/api/my/earnings${previewParam}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      if (res.ok) {
        const body = await res.json();
        setRows(body.credits || []);
        setPayouts(body.payouts || []);
        setFieldAmountsHidden(!!body.fieldAmountsHidden);
      }
      setLoading(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user]);

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  // Rows whose dollars the server withheld (field work for non-admins) still
  // list for vehicle verification but stay out of every money computation —
  // otherwise they'd read as $0 earned or "awaiting a pay rate".
  const amountHidden = (r: EarningRow) => fieldAmountsHidden && r.source === 'field';
  const moneyRows = rows.filter(r => !amountHidden(r));
  const showMoney = moneyRows.length > 0;

  const total = moneyRows.reduce((s, r) => s + (r.amount || 0), 0);
  const paid = moneyRows.filter(r => r.payoutStatus === 'paid').reduce((s, r) => s + (r.amount || 0), 0);
  const unpriced = moneyRows.filter(r => r.amount == null).length;

  const groups = new Map<string, EarningRow[]>();
  for (const r of rows) {
    const arr = groups.get(r.group) || [];
    arr.push(r);
    groups.set(r.group, arr);
  }

  const toggle = (g: string) => {
    const next = new Set(openGroups);
    if (next.has(g)) next.delete(g); else next.add(g);
    setOpenGroups(next);
  };

  return (
    <div>
      <InstallerPreviewBanner preview={isAdmin ? preview : null} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.back()} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>My Earnings</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {showMoney || rows.length === 0 ? 'Your cut per completed vehicle' : 'Your completed vehicles'}
          </div>
        </div>
      </div>

      {/* Totals — dollars when any are visible, otherwise just the vehicle count
          (field-work dollars are admin-only; the API withholds them). */}
      {showMoney ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginBottom: '16px' }}>
          {[
            { label: 'Total Earned', value: `$${total.toFixed(2)}`, color: 'var(--success)' },
            { label: 'Paid Out', value: `$${paid.toFixed(2)}`, color: 'var(--text-primary)' },
            { label: 'Awaiting Payout', value: `$${(total - paid).toFixed(2)}`, color: 'var(--orange)' },
          ].map(card => (
            <div key={card.label} style={{ padding: '14px 12px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'center' }}>
              <div style={{ fontSize: '16px', fontWeight: 800, color: card.color }}>{card.value}</div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px' }}>{card.label}</div>
            </div>
          ))}
        </div>
      ) : rows.length > 0 && (
        <div style={{ padding: '14px 12px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)', textAlign: 'center', marginBottom: '16px' }}>
          <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>{rows.length}</div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: '2px' }}>
            Vehicle{rows.length === 1 ? '' : 's'} Credited to You
          </div>
        </div>
      )}

      {unpriced > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: '10px', marginBottom: '12px', background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', color: 'var(--warning)', fontSize: '12px', fontWeight: 600 }}>
          {unpriced} vehicle{unpriced === 1 ? '' : 's'} awaiting a pay rate — the amount will appear once it&apos;s set.
        </div>
      )}

      {/* Payout history — when was I paid, and for which period/job */}
      {payouts.length > 0 && (
        <div style={{ borderRadius: '12px', marginBottom: '16px', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
          <div style={{ padding: '12px 16px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', borderBottom: '1px solid var(--border)' }}>
            Payout History
          </div>
          {(showAllPayouts ? payouts : payouts.slice(0, 5)).map(p => {
            const st = STATUS_STYLE[p.status] || STATUS_STYLE.pending;
            return (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{p.label}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    {p.status === 'paid' && p.paidAt
                      ? `Paid ${new Date(p.paidAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`
                      : `Created ${new Date(p.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {p.amount != null ? `$${p.amount.toFixed(2)}` : '—'}
                  </div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: st.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{st.label}</div>
                </div>
              </div>
            );
          })}
          {payouts.length > 5 && (
            <button
              onClick={() => setShowAllPayouts(s => !s)}
              style={{ width: '100%', padding: '10px', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
            >
              {showAllPayouts ? 'Show fewer' : `Show all ${payouts.length} payouts`}
            </button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
          No earnings yet — vehicles you complete while tagged on a shift will show up here.
        </div>
      ) : [...groups.entries()].map(([group, items]) => {
        // Groups are one CNI job or one field part, so hidden-ness is uniform
        // within a group.
        const groupHidden = amountHidden(items[0]);
        const groupTotal = items.reduce((s, r) => s + (r.amount || 0), 0);
        const open = openGroups.has(group);
        return (
          <div key={group} style={{ borderRadius: '12px', marginBottom: '10px', background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
            <button onClick={() => toggle(group)} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
              padding: '14px 16px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left',
            }}>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{group}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {items.length} vehicle{items.length === 1 ? '' : 's'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {!groupHidden && (
                  <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--success)' }}>${groupTotal.toFixed(2)}</span>
                )}
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
              </div>
            </button>
            {open && items.map(r => {
              const st = STATUS_STYLE[r.payoutStatus] || STATUS_STYLE.pending;
              return (
                <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>{r.vin || '—'}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                      {new Date(r.createdAt).toLocaleDateString()} · {r.crewSize === 1 ? 'solo' : `split ${r.crewSize} ways`}
                      {r.shareWeight !== 1 ? ` · ×${r.shareWeight} share` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {!groupHidden && (
                      <div style={{ fontSize: '13px', fontWeight: 800, color: r.amount != null ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {r.amount != null ? `$${r.amount.toFixed(2)}` : 'TBD'}
                      </div>
                    )}
                    <div style={{ fontSize: '9px', fontWeight: 700, color: st.color, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{st.label}</div>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{ height: '80px' }} />
    </div>
  );
}
