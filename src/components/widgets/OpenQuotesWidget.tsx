'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function OpenQuotesWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [quotes, setQuotes] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data } = await supabase
      .from('quotes')
      .select('id, quote_number, customer_name, total, status, created_at')
      .in('status', ['draft', 'sent', 'pending'])
      .order('created_at', { ascending: false })
      .limit(8);

    setQuotes(data || []);
    setLoading(false);
  };

  const fmt = (n: number) => n?.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }) || '$0';
  const timeAgo = (d: string) => {
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  };

  return (
    <WidgetShell title="Open Quotes" icon="" loading={loading} onHeaderClick={() => router.push('/admin/quotes')}>
      {quotes.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>No open quotes</div>
      ) : (
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: theme.textPrimary, marginBottom: '8px' }}>
            {quotes.length}
            <span style={{ fontSize: '12px', fontWeight: 600, color: theme.textMuted, marginLeft: '6px' }}>open</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {quotes.slice(0, 5).map(q => (
              <button key={q.id} onClick={() => router.push(`/admin/quotes?id=${q.id}`)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer',
              }}>
                <div>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: theme.textPrimary }}>
                    {q.customer_name || `Quote #${q.quote_number}`}
                  </div>
                  <div style={{ fontSize: '9px', color: theme.textMuted }}>{timeAgo(q.created_at)}</div>
                </div>
                <span style={{ fontSize: '12px', fontWeight: 800, color: theme.textPrimary }}>{fmt(q.total)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </WidgetShell>
  );
}
