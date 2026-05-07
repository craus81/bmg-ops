'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function PartsCatalogWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, upfit: 0, graphics: 0 });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: parts } = await supabase
      .from('netsuite_parts')
      .select('id, catalog')
      .eq('is_active', true)
      .limit(5000);

    const all = parts || [];
    const upfit = all.filter((p: any) => p.catalog === 'upfit');
    const graphics = all.filter((p: any) => p.catalog === 'graphics');

    setStats({ total: all.length, upfit: upfit.length, graphics: graphics.length });
    setLoading(false);
  };

  return (
    <WidgetShell title="Parts Catalog" icon="" loading={loading} onHeaderClick={() => router.push('/parts')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.total}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Total</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>{stats.upfit}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Upfit</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.graphics}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Graphics</div>
          </div>
        </div>
      </div>
    </WidgetShell>
  );
}
