'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function RevenueSummaryWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    invoicedTotal: 0, invoicedCount: 0,
    thisMonth: 0, lastMonth: 0,
    pendingCount: 0,
  });

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const { data: jobs } = await supabase
      .from('graphics_jobs')
      .select('id, status, invoice_amount, invoiced_at')
      .gte('invoiced_at', yearStart);

    const invoiced = (jobs || []).filter((j: any) => j.invoiced_at);
    const invoicedTotal = invoiced.reduce((s: number, j: any) => s + (Number(j.invoice_amount) || 0), 0);

    const { count: pendingCount } = await supabase
      .from('graphics_jobs')
      .select('*', { count: 'exact', head: true })
      .in('status', ['ready', 'shipped'])
      .is('invoiced_at', null);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const thisMonth = invoiced
      .filter((j: any) => new Date(j.invoiced_at) >= monthStart)
      .reduce((s: number, j: any) => s + (Number(j.invoice_amount) || 0), 0);
    const lastMonth = invoiced
      .filter((j: any) => new Date(j.invoiced_at) >= lastMonthStart && new Date(j.invoiced_at) <= lastMonthEnd)
      .reduce((s: number, j: any) => s + (Number(j.invoice_amount) || 0), 0);

    setStats({
      invoicedTotal,
      invoicedCount: invoiced.length,
      thisMonth,
      lastMonth,
      pendingCount: pendingCount || 0,
    });
    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });
  const lastMonthName = new Date(new Date().getFullYear(), new Date().getMonth() - 1).toLocaleDateString('en-US', { month: 'long' });

  const change = stats.lastMonth > 0
    ? Math.round(((stats.thisMonth - stats.lastMonth) / stats.lastMonth) * 100)
    : 0;

  return (
    <WidgetShell title="Revenue Summary" icon="" loading={loading} accentColor="var(--success)" onHeaderClick={() => router.push('/admin/reports')}>
      <div>
        <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, letterSpacing: '-1px' }}>
          {fmt(stats.invoicedTotal)}
        </div>
        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
          {stats.invoicedCount} invoiced YTD &bull; {stats.pendingCount} awaiting invoice
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
