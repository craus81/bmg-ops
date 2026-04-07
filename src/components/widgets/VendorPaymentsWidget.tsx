'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function VendorPaymentsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ pending: 0, approved: 0, paid: 0 });

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: invoices } = await supabase
      .from('po_invoices')
      .select('id, status')
      .limit(1000);

    const all = invoices || [];
    const pending = all.filter(i => i.status === 'pending');
    const approved = all.filter(i => i.status === 'approved');
    const paid = all.filter(i => i.status === 'paid');

    setStats({ pending: pending.length, approved: approved.length, paid: paid.length });
    setLoading(false);
  };

  return (
    <WidgetShell title="Vendor Payments" icon="" loading={loading} onHeaderClick={() => router.push('/admin/jobs?tab=invoices')}>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#fbbf24' }}>{stats.pending}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Pending</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{stats.approved}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Approved</div>
          </div>
          <div style={{ textAlign: 'center', background: 'var(--subtle-bg)', borderRadius: '8px', padding: '8px 4px' }}>
            <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>{stats.paid}</div>
            <div style={{ fontSize: '9px', fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase' }}>Paid</div>
          </div>
        </div>
      </div>
    </WidgetShell>
  );
}
