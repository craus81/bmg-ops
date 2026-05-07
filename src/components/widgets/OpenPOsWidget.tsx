'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function OpenPOsWidget() {
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ count: 0, totalValue: 0, remaining: 0 });
  const [pos, setPOs] = useState<any[]>([]);

  useEffect(() => { load(); }, []);

  const load = async () => {
    const { data: poData } = await supabase
      .from('purchase_orders')
      .select('id, po_number, customer, status')
      .eq('status', 'open');

    let totalValue = 0, remaining = 0;
    const details: any[] = [];

    if (poData && poData.length > 0) {
      const { data: lines } = await supabase
        .from('po_line_items')
        .select('po_id, quantity, installed, unit_price')
        .in('po_id', poData.map((p: any) => p.id));

      for (const po of poData) {
        const poLines = (lines || []).filter((l: any) => l.po_id === po.id);
        const tv = poLines.reduce((s: any, l: any) => s + (l.quantity * l.unit_price), 0);
        const rv = poLines.reduce((s: any, l: any) => s + ((l.quantity - l.installed) * l.unit_price), 0);
        totalValue += tv;
        remaining += rv;
        details.push({ ...po, totalValue: tv, remaining: rv });
      }
    }

    setPOs(details.sort((a, b) => b.remaining - a.remaining).slice(0, 5));
    setStats({ count: (poData || []).length, totalValue, remaining });
    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <WidgetShell title="Open PO Balance" icon="" loading={loading} accentColor={theme.orange}>
      <div>
        <div style={{ fontSize: '28px', fontWeight: 800, color: theme.textPrimary, letterSpacing: '-1px' }}>
          {fmt(stats.remaining)}
        </div>
        <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '2px' }}>
          {stats.count} open PO{stats.count !== 1 ? 's' : ''} &bull; {fmt(stats.totalValue)} total
        </div>

        {pos.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {pos.map(po => (
              <div key={po.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: '11px', padding: '6px 8px', borderRadius: '8px',
                background: 'var(--subtle-bg)',
              }}>
                <span style={{ fontWeight: 700, color: theme.textPrimary }}>PO #{po.po_number}</span>
                <span style={{ fontWeight: 700, color: theme.orange }}>{fmt(po.remaining)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </WidgetShell>
  );
}
