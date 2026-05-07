'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function CustomersWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, withSpend: 0 });
  const [topCustomers, setTopCustomers] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: customers } = await supabase
      .from('customers')
      .select('id, company_name, ytd_spend')
      .eq('active', true)
      .order('ytd_spend', { ascending: false })
      .limit(100);

    const all = customers || [];
    const withSpend = all.filter((c: any) => c.ytd_spend > 0);

    setStats({ total: all.length, withSpend: withSpend.length });
    setTopCustomers(all.slice(0, 5));
    setLoading(false);
  };

  const formatSpend = (val: number) => {
    if (val >= 1000) return `$${(val / 1000).toFixed(1)}k`;
    return `$${val}`;
  };

  return (
    <WidgetShell title="Customers" icon="" loading={loading} onHeaderClick={() => router.push('/admin/customers')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.total}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Active</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.withSpend}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>With Spend</div>
          </div>
        </div>

        {topCustomers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {topCustomers.map(c => (
              <button key={c.id} onClick={() => router.push('/admin/customers')} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                  {c.company_name || 'Unknown'}
                </span>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#4ade80' }}>
                  {formatSpend(c.ytd_spend || 0)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
