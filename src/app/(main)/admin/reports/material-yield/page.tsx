'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

/**
 * Material yield & scrap (R6-6). How much of every roll became graphic and
 * how much went in the bin — per film, worst waste first.
 *
 * Coverage is stated rather than hidden: lines with no recorded graphic
 * area are counted separately, never scored as total waste, so one
 * hand-typed line can't make a film look catastrophic.
 */

interface Film {
  key: string; materialName: string; measuredLines: number; unmeasuredLines: number;
  rollSqft: number; graphicSqft: number; wasteSqft: number;
  utilization: number | null; wasteCost: number | null;
}
interface Report {
  range: { start: string; end: string };
  films: Film[];
  totals: {
    rollSqft: number; graphicSqft: number; wasteSqft: number;
    utilization: number | null; wasteCost: number | null;
    measuredLines: number; unmeasuredLines: number;
  };
  jobsCovered: number;
  note: string | null;
}

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
const money = (v: number | null) => (v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const utilColor = (u: number | null) => (u == null ? 'var(--text-muted)' : u >= 0.8 ? '#22c55e' : u >= 0.65 ? '#f59e0b' : '#ef4444');

export default function MaterialYieldPage() {
  const router = useRouter();
  const { user, isAdmin, hasFeature, loading: authLoading } = useAuth();
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const start = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
      const res = await fetch(`/api/reports/material-yield?start=${start}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e: any) {
      setError(e?.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading || !user) return;
    if (!isAdmin && !hasFeature('reports') && !hasFeature('graphics')) { router.push('/home'); return; }
    load(days);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load after auth
  }, [authLoading, user]);

  const th: React.CSSProperties = { padding: '10px 12px', fontWeight: 700, fontSize: '11px', color: 'var(--text-muted)', textAlign: 'left', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '9px 12px', borderTop: '1px solid var(--border)', fontSize: '12.5px' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)' }}>Material Yield &amp; Scrap</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            How much of each roll ended up as graphic. Worst waste first.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {[30, 90, 180, 365].map(d => (
            <button key={d} onClick={() => { setDays(d); load(d); }} style={{
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              background: days === d ? 'var(--tab-active-bg)' : 'transparent',
              border: `1px solid ${days === d ? 'var(--tab-active-border)' : 'var(--border)'}`,
              color: days === d ? 'var(--tab-active-color)' : 'var(--text-muted)',
            }}>{d}d</button>
          ))}
        </div>
      </div>

      {error && <div style={{ fontSize: '12px', color: '#ef4444', marginBottom: '10px' }}>{error}</div>}
      {loading && !data && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '16px 0' }}>Loading…</div>}

      {data?.note && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', background: 'var(--subtle-bg)', border: '1px dashed var(--border)', borderRadius: '9px', padding: '9px 11px', marginBottom: '14px' }}>
          {data.note}
        </div>
      )}

      {data && data.totals.measuredLines > 0 && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {[
              { label: 'Roll used', value: `${data.totals.rollSqft.toLocaleString()} ft²` },
              { label: 'Printed', value: `${data.totals.graphicSqft.toLocaleString()} ft²` },
              { label: 'Scrap', value: `${data.totals.wasteSqft.toLocaleString()} ft²`, tone: '#ef4444' },
              { label: 'Utilization', value: pct(data.totals.utilization), tone: utilColor(data.totals.utilization) },
              { label: 'Scrap cost', value: money(data.totals.wasteCost) },
            ].map(t => (
              <div key={t.label} style={{ flex: '1 1 130px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '11px', padding: '11px 13px' }}>
                <div style={{ fontSize: '19px', fontWeight: 800, color: t.tone || 'var(--text-primary)' }}>{t.value}</div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600 }}>{t.label}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '10px' }}>
            From {data.totals.measuredLines} measured line{data.totals.measuredLines !== 1 ? 's' : ''} across {data.jobsCovered} job{data.jobsCovered !== 1 ? 's' : ''}
            {data.totals.unmeasuredLines > 0 && (
              <> · {data.totals.unmeasuredLines} line{data.totals.unmeasuredLines !== 1 ? 's' : ''} had no recorded printed area and were left out rather than counted as scrap</>
            )}
          </div>

          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={th}>Film</th><th style={th}>Roll ft²</th><th style={th}>Printed ft²</th>
                  <th style={th}>Scrap ft²</th><th style={th}>Utilization</th><th style={th}>Scrap cost</th><th style={th}>Lines</th>
                </tr></thead>
                <tbody>
                  {data.films.map(f => (
                    <tr key={f.key}>
                      <td style={{ ...td, fontWeight: 700 }}>{f.materialName}</td>
                      <td style={td}>{f.rollSqft.toLocaleString()}</td>
                      <td style={td}>{f.graphicSqft.toLocaleString()}</td>
                      <td style={{ ...td, color: f.wasteSqft > 0 ? '#ef4444' : 'var(--text-body)' }}>{f.wasteSqft.toLocaleString()}</td>
                      <td style={{ ...td, fontWeight: 800, color: utilColor(f.utilization) }}>{pct(f.utilization)}</td>
                      <td style={td}>{money(f.wasteCost)}</td>
                      <td style={{ ...td, color: 'var(--text-muted)', fontSize: '11px' }}>
                        {f.measuredLines}{f.unmeasuredLines > 0 ? ` (+${f.unmeasuredLines} unmeasured)` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
