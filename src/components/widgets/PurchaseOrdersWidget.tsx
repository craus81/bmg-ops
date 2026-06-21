'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { usePopout } from '@/components/Popout';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function PurchaseOrdersWidget() {
  const router = useRouter();
  const { open: openPopout } = usePopout();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ open: 0, total: 0 });
  const [recentPOs, setRecentPOs] = useState<any[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status, created_at')
      .order('created_at', { ascending: false })
      .limit(500);

    const all = pos || [];
    const open = all.filter((p: any) => p.status === 'open');

    setStats({ open: open.length, total: all.length });
    setRecentPOs(open.slice(0, 5));
    setLoading(false);
  };

  return (
    <WidgetShell title="Purchase Orders" icon="" loading={loading} onHeaderClick={() => router.push('/admin/pos')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '10px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.open}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Open</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: theme.textPrimary }}>{stats.total}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Total</div>
          </div>
        </div>

        {recentPOs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {recentPOs.map(po => (
              <button key={po.id} onClick={() => openPopout('purchase_orders', po.id)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                padding: '6px 8px', borderRadius: '6px', border: 'none', textAlign: 'left',
                background: 'var(--subtle-bg)', cursor: 'pointer', fontSize: '11px',
              }}>
                <span style={{ fontWeight: 600, color: theme.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '50%' }}>
                  {po.po_number || 'No PO#'}
                </span>
                <span style={{ fontSize: '10px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}>
                  {po.customer || ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
