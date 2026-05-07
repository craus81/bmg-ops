'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { theme } from '@/lib/theme';
import WidgetShell from './WidgetShell';

export default function TopCustomersWidget() {
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [customers, setCustomers] = useState<{ name: string; vehicles: number; revenue: number }[]>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  useEffect(() => { load(); }, []);

  const load = async () => {
    // Get all scanned vehicles with PO line item linkage for revenue
    const { data: vehicles } = await supabase
      .from('scanned_vehicles')
      .select('id, customer, po_line_item_id')
      .gte('scanned_at', new Date(new Date().getFullYear(), 0, 1).toISOString());

    const { data: poLines } = await supabase
      .from('po_line_items')
      .select('id, unit_price');

    const priceMap: Record<string, number> = {};
    (poLines || []).forEach((l: any) => { priceMap[l.id] = l.unit_price || 0; });

    // Aggregate by customer
    const custMap: Record<string, { name: string; vehicles: number; revenue: number }> = {};
    for (const v of (vehicles || [])) {
      const name = v.customer || 'Unknown';
      if (!custMap[name]) custMap[name] = { name, vehicles: 0, revenue: 0 };
      custMap[name].vehicles++;
      if (v.po_line_item_id && priceMap[v.po_line_item_id]) {
        custMap[name].revenue += priceMap[v.po_line_item_id];
      }
    }

    const sorted = Object.values(custMap)
      .sort((a, b) => b.revenue - a.revenue || b.vehicles - a.vehicles)
      .slice(0, 5);

    setCustomers(sorted);
    setLoading(false);
  };

  const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const maxRevenue = customers.length > 0 ? customers[0].revenue : 1;

  return (
    <WidgetShell title="Top 5 Customers YTD" icon="" loading={loading} accentColor="var(--warning)">
      {customers.length === 0 ? (
        <div style={{ textAlign: 'center', color: theme.textMuted, fontSize: '12px', padding: '16px 0' }}>No data yet this year</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {customers.map((c, i) => (
            <div key={c.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{
                    width: '20px', height: '20px', borderRadius: '6px', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 800,
                    background: i === 0 ? 'var(--orange-glow)' : 'var(--subtle-bg)',
                    color: i === 0 ? 'var(--orange)' : theme.textMuted,
                  }}>{i + 1}</span>
                  <span style={{ fontSize: '12px', fontWeight: 700, color: theme.textPrimary }}>{c.name}</span>
                </div>
                <span style={{ fontSize: '12px', fontWeight: 800, color: theme.textPrimary }}>{fmt(c.revenue)}</span>
              </div>
              <div style={{ marginLeft: '26px' }}>
                <div style={{
                  height: '4px', borderRadius: '2px', background: 'var(--progress-track)',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%', borderRadius: '2px',
                    width: `${Math.max((c.revenue / maxRevenue) * 100, 4)}%`,
                    background: i === 0 ? 'var(--orange)' : 'var(--navy-light)',
                  }} />
                </div>
                <div style={{ fontSize: '10px', color: theme.textMuted, marginTop: '2px' }}>
                  {c.vehicles} vehicle{c.vehicles !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}
