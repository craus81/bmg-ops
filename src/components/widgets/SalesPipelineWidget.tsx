'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import WidgetShell from './WidgetShell';

const STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STAGE_COLORS: Record<string, string> = { lead: '#60a5fa', quoted: '#a78bfa', negotiating: '#fbbf24', won: '#4ade80', lost: '#f87171' };
const ACTIVE_STAGES = ['lead', 'quoted', 'negotiating'];

export default function SalesPipelineWidget() {
  const router = useRouter();
  const { user } = useAuth();
  const supabase = createClient();
  const [data, setData] = useState<{ stage: string; count: number; value: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    loadPipeline();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user]);

  const loadPipeline = async () => {
    const { data: opps } = await supabase
      .from('prospect_opportunities')
      .select('stage, value');

    if (!opps) { setLoading(false); return; }

    const byStage: Record<string, { count: number; value: number }> = {};
    for (const stage of Object.keys(STAGES)) {
      byStage[stage] = { count: 0, value: 0 };
    }
    for (const o of opps) {
      if (byStage[o.stage]) {
        byStage[o.stage].count++;
        byStage[o.stage].value += (o.value || 0);
      }
    }
    setData(Object.entries(byStage).map(([stage, d]) => ({ stage, ...d })));
    setLoading(false);
  };

  const activeData = data.filter(d => ACTIVE_STAGES.includes(d.stage));
  const totalPipeline = activeData.reduce((sum, d) => sum + d.value, 0);
  const totalDeals = activeData.reduce((sum, d) => sum + d.count, 0);
  const wonData = data.find(d => d.stage === 'won');

  return (
    <WidgetShell title="Sales Pipeline" icon="" onHeaderClick={() => router.push('/admin/prospects')}>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>Loading...</div>
      ) : (
        <div style={{ padding: '0 2px' }}>
          {/* Pipeline summary */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <div style={{ flex: 1, textAlign: 'center', padding: '8px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>{totalDeals}</div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Active Deals</div>
            </div>
            <div style={{ flex: 1, textAlign: 'center', padding: '8px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)' }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: '#60a5fa' }}>${totalPipeline >= 1000 ? `${(totalPipeline / 1000).toFixed(1)}k` : totalPipeline.toLocaleString()}</div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Pipeline Value</div>
            </div>
            {wonData && wonData.count > 0 && (
              <div style={{ flex: 1, textAlign: 'center', padding: '8px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, color: '#4ade80' }}>${wonData.value >= 1000 ? `${(wonData.value / 1000).toFixed(1)}k` : wonData.value.toLocaleString()}</div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Won</div>
              </div>
            )}
          </div>

          {/* Stage breakdown */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {data.filter(d => d.count > 0).map(d => (
              <div key={d.stage} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 8px', borderRadius: '6px', background: 'var(--bg)',
              }}>
                <div style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: STAGE_COLORS[d.stage], flexShrink: 0,
                }} />
                <div style={{ flex: 1, fontSize: '12px', fontWeight: 600, color: 'var(--text-body)' }}>
                  {STAGES[d.stage]}
                </div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>
                  {d.count}
                </div>
                {d.value > 0 && (
                  <div style={{ fontSize: '11px', fontWeight: 600, color: STAGE_COLORS[d.stage], minWidth: '50px', textAlign: 'right' }}>
                    ${d.value >= 1000 ? `${(d.value / 1000).toFixed(1)}k` : d.value.toLocaleString()}
                  </div>
                )}
              </div>
            ))}
            {data.every(d => d.count === 0) && (
              <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '12px' }}>
                No opportunities yet — add one in the CRM
              </div>
            )}
          </div>
        </div>
      )}
    </WidgetShell>
  );
}
