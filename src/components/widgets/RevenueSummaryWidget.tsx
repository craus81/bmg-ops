'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function RevenueSummaryWidget() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    paidTotal: 0, paidCount: 0,
    thisMonth: 0, lastMonth: 0,
    pendingCount: 0,
  });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, status, payment_amount, paid_at');

    const paid = (invoices || []).filter((i: any) => i.status === 'paid');
    const pending = (invoices || []).filter((i: any) => i.status === 'pending');
    const paidTotal = paid.reduce((s: any, i: any) => s + (i.payment_amount || 0), 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59).toISOString();

    const thisMonth = paid
      .filter((i: any) => i.paid_at && new Date(i.paid_at) >= new Date(monthStart))
      .reduce((s: any, i: any) => s + (i.payment_amount || 0), 0);
    const lastMonth = paid
      .filter((i: any) => i.paid_at && new Date(i.paid_at) >= new Date(lastMonthStart) && new Date(i.paid_at) <= new Date(lastMonthEnd))
      .reduce((s: any, i: any) => s + (i.payment_amount || 0), 0);

    setStats({ paidTotal, paidCount: paid.length, thisMonth, lastMonth, pendingCount: pending.length });
    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });
  const lastMonthName = new Date(new Date().getFullYear(), new Date().getMonth() - 1).toLocaleDateString('en-US', { month: 'long' });

  const change = stats.lastMonth > 0
    ? Math.round(((stats.thisMonth - stats.lastMonth) / stats.lastMonth) * 100)
    : 0;

  return (
    <WidgetShell title="Revenue Summary" icon="" loading={loading} accentColor="var(--success)">
      <div>
        <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, letterSpacing: '-1px' }}>
          {fmt(stats.paidTotal)}
        </div>
        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
          {stats.paidCount} paid &bull; {stats.pendingCount} pending
        </div>

        <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          <div style={{ background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px' }}>
            <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>{monthName}</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginTop: '2px' }}>{fmt(stats.thisMonth)}</div>
            {change !== 0 && (
              <div style={{ fontSize: '10px', fontWeight: 700, color: change > 0 ? 'var(--success)' : 'var(--error)', marginTop: '2px' }}>
                {change > 0 ? '↑' : '↓'} {Math.abs(change)}%
              </div>
            )}
          </div>
          <div style={{ background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px' }}>
            <div style={{ fontSize: '10px', color: theme.textMuted, fontWeight: 600 }}>{lastMonthName}</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: theme.textPrimary, marginTop: '2px' }}>{fmt(stats.lastMonth)}</div>
          </div>
        </div>
      </div>
    </WidgetShell>
  );
}
