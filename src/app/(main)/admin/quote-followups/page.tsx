'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

interface FollowUpItem {
  type: 'estimate' | 'wrap';
  id: string;
  number: string;
  title: string;
  customer: string;
  total: number;
  repId: string | null;
  repName: string | null;
  sentAt: string | null;
  lastFollowupAt: string | null;
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

const quietDaysOf = (i: FollowUpItem): number => {
  const ref = Math.max(
    i.sentAt ? new Date(i.sentAt).getTime() : 0,
    i.lastFollowupAt ? new Date(i.lastFollowupAt).getTime() : 0,
  );
  return ref ? Math.floor((Date.now() - ref) / 86_400_000) : 0;
};
const quietColor = (d: number) => d >= 14 ? '#ef4444' : d >= 5 ? '#fbbf24' : 'var(--text-muted)';

export default function QuoteFollowUpsPage() {
  const router = useRouter();
  const { user, isAdmin, isSales, loading: authLoading } = useAuth();
  const dialog = useDialog();

  const [items, setItems] = useState<FollowUpItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/quotes/follow-up');
      const data = await res.json();
      if (res.ok) setItems(data.items || []);
    } catch { /* empty list signals it */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, isSales, router, load]);

  const act = async (item: FollowUpItem, action: 'log_followup' | 'mark_accepted' | 'mark_rejected', confirmMsg?: string) => {
    if (confirmMsg && !(await dialog.confirm(confirmMsg))) return;
    setBusy(item.id);
    try {
      const res = await fetch('/api/quotes/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: item.type, id: item.id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) await dialog.alert(data.error || 'Action failed');
      else await load();
    } catch (e: any) {
      await dialog.alert(e.message || 'Action failed');
    }
    setBusy(null);
  };

  const visible = items
    .filter(i => !mineOnly || i.repId === user?.id)
    .sort((a, b) => quietDaysOf(b) - quietDaysOf(a));
  const totalValue = visible.reduce((s, i) => s + i.total, 0);
  const overdue = visible.filter(i => quietDaysOf(i) >= 5);

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Quote Follow-Ups</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Every sent quote still waiting on an answer, quietest first. Log each follow-up so the clock resets — reps get a nudge after {5} quiet days.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div style={{ padding: '10px 14px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '12px', color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{visible.length}</strong> open · <strong style={{ color: '#f472b6' }}>{fmtMoney(totalValue)}</strong> quoted
          {overdue.length > 0 && <span style={{ color: '#fbbf24', fontWeight: 700 }}> · {overdue.length} overdue for a follow-up</span>}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} style={{ width: '15px', height: '15px' }} />
          My quotes only
        </label>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          Nothing waiting on an answer — every sent quote is resolved or fresh.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(item => {
          const quiet = quietDaysOf(item);
          const isBusy = busy === item.id;
          return (
            <div key={`${item.type}-${item.id}`} style={{ background: 'var(--card)', border: `1px solid ${quiet >= 14 ? 'rgba(239,68,68,0.35)' : quiet >= 5 ? 'rgba(251,191,36,0.35)' : 'var(--border)'}`, borderRadius: '12px', padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '220px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', textTransform: 'uppercase', background: item.type === 'estimate' ? 'rgba(96,165,250,0.12)' : 'rgba(167,139,250,0.12)', color: item.type === 'estimate' ? '#60a5fa' : '#a78bfa' }}>
                      {item.type === 'estimate' ? 'Estimate' : 'Wrap'}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{item.number}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{item.customer}</span>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: '#f472b6' }}>{fmtMoney(item.total)}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                    {item.title && <span>{item.title} · </span>}
                    sent {fmtDate(item.sentAt)}
                    {item.lastFollowupAt && <span> · last follow-up {fmtDate(item.lastFollowupAt)}</span>}
                    {item.repName && <span> · {item.repName}</span>}
                    <span style={{ fontWeight: 800, color: quietColor(quiet) }}> · quiet {quiet}d</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button disabled={isBusy} onClick={() => act(item, 'log_followup')} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
                    ☎ Log Follow-Up
                  </button>
                  <button disabled={isBusy} onClick={() => act(item, 'mark_accepted', `Mark ${item.number} (${fmtMoney(item.total)}) as accepted?`)} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    ✓ Won
                  </button>
                  <button disabled={isBusy} onClick={() => act(item, 'mark_rejected', `Mark ${item.number} as lost/rejected?`)} style={{ padding: '6px 12px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', cursor: 'pointer' }}>
                    ✕ Lost
                  </button>
                  <button onClick={() => router.push(item.type === 'estimate' ? '/estimates' : '/admin/wrap-quote')} style={{ padding: '6px 10px', borderRadius: '7px', fontSize: '11px', fontWeight: 700, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                    Open →
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
