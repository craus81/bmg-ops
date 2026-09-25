'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import type { FinancialHistory, MonthPnl, YearPnl } from '@/lib/financial-history';

/**
 * Financial History: every month's P&L, QuickBooks before the cutover and
 * NetSuite after, in one series (src/lib/financial-history.ts). Built so the
 * years NetSuite doesn't hold can sit beside the ones it does: yearly
 * totals, a month-by-month chart, and a month-by-year grid for seasonality.
 * Top-level totals only; the two charts of accounts differ below that.
 */

type Metric = 'income' | 'grossProfit' | 'netIncome';
const METRICS: { key: Metric; label: string }[] = [
  { key: 'income', label: 'Revenue' },
  { key: 'grossProfit', label: 'Gross profit' },
  { key: 'netIncome', label: 'Net income' },
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SOURCE_COLOR = { quickbooks: '#2ca01c', netsuite: '#3b82f6' } as const;
const SOURCE_LABEL = { quickbooks: 'QuickBooks', netsuite: 'NetSuite' } as const;
/** Re-asks while NetSuite months are still being filled, then stops. */
const MAX_FILL_ROUNDS = 6;

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtK = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1_000_000 ? `$${(a / 1_000_000).toFixed(2)}M` : a >= 1000 ? `$${Math.round(a / 1000)}k` : `$${Math.round(a)}`;
  return n < 0 ? `-${s}` : s;
};
const fmtPct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px' };
const eyebrow: React.CSSProperties = { fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '8px' };
const th: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { fontSize: '12.5px', padding: '6px 8px', borderBottom: '1px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' };

function SourceDots({ sources }: { sources: ('quickbooks' | 'netsuite')[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: '4px' }}>
      {sources.map(s => (
        <span key={s} style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '5px', background: `${SOURCE_COLOR[s]}22`, color: SOURCE_COLOR[s] }}>{SOURCE_LABEL[s]}</span>
      ))}
    </span>
  );
}

function MonthlyChart({ months, metric }: { months: MonthPnl[]; metric: Metric }) {
  const [hover, setHover] = useState<MonthPnl | null>(null);
  if (months.length === 0) return null;
  const values = months.map(m => m[metric]);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const W = Math.max(600, months.length * 9);
  const H = 180;
  const bw = W / months.length;
  const zeroY = (max / span) * H;
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H + 18}`} style={{ width: '100%', minWidth: `${Math.min(W, 900)}px`, height: 'auto', display: 'block' }} role="img" aria-label="Monthly chart">
          <line x1={0} x2={W} y1={zeroY} y2={zeroY} stroke="var(--border)" />
          {months.map((m, i) => {
            const v = m[metric];
            const h = (Math.abs(v) / span) * H;
            const y = v >= 0 ? zeroY - h : zeroY;
            const isJan = m.month.endsWith('-01');
            return (
              <g key={m.month} onMouseEnter={() => setHover(m)} onMouseLeave={() => setHover(null)} onClick={() => setHover(m)}>
                {isJan && <line x1={i * bw} x2={i * bw} y1={0} y2={H} stroke="var(--border)" strokeDasharray="2 3" />}
                {isJan && <text x={i * bw + 2} y={H + 13} fontSize={10} fill="var(--text-muted)">{m.month.slice(0, 4)}</text>}
                <rect x={i * bw + bw * 0.12} y={y} width={bw * 0.76} height={Math.max(h, 0.5)}
                  fill={SOURCE_COLOR[m.source]} opacity={m.directional ? 0.45 : hover?.month === m.month ? 1 : 0.8} />
                <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', minHeight: '18px', marginTop: '4px' }}>
        {hover
          ? <>{MONTHS[Number(hover.month.slice(5, 7)) - 1]} {hover.month.slice(0, 4)} · {SOURCE_LABEL[hover.source]} · revenue {fmtMoney(hover.income)}, gross profit {fmtMoney(hover.grossProfit)}, net {fmtMoney(hover.netIncome)}{hover.directional ? ' (month in progress)' : ''}</>
          : 'Point at or tap a bar for that month.'}
      </div>
    </div>
  );
}

export default function FinancialHistoryPage() {
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<FinancialHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>('income');
  const fillRounds = useRef(0);

  // Mirrors the route's requireFinancials — super_admin / executive only.
  const allowed = hasFeature('financials');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/reports/financial-history');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Report failed');
      setData(json as FinancialHistory);
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!allowed) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- hasFeature identity changes per render; auth state deps cover it
  }, [authLoading, isAdmin, router, load]);

  // NetSuite months are fetched a batch per request; keep asking until done.
  useEffect(() => {
    if (!data || data.netsuitePending === 0 || fillRounds.current >= MAX_FILL_ROUNDS) return;
    fillRounds.current++;
    load(true);
  }, [data, load]);

  const years = useMemo(() => data?.years || [], [data]);
  const grid = useMemo(() => {
    const byKey = new Map((data?.months || []).map(m => [m.month, m]));
    return { byKey, years: years.map(y => y.year) };
  }, [data, years]);

  if (authLoading || !allowed) return null;

  const qboMonths = data?.months.filter(m => m.source === 'quickbooks').length || 0;
  const prevOf = (y: YearPnl) => years.find(p => p.year === y.year - 1);

  return (
    <div style={{ maxWidth: '1000px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Financial History</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.5 }}>
        Every month&rsquo;s P&amp;L in one series: QuickBooks before the cutover{data?.cutover ? ` (${data.cutover})` : ''}, NetSuite from it on.
        Each month comes from one system only, so nothing is counted twice. Totals only: the two charts of accounts differ below that level.
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading… the first visit fetches each NetSuite month once, so it can take a minute.</div>}

      {data && !loading && (
        <>
          {(data.errors.length > 0 || data.netsuitePending > 0 || qboMonths === 0 || !data.cutover) && (
            <div style={{ border: '1px solid #f59e0b', background: '#f59e0b14', borderRadius: '12px', padding: '12px 16px', marginBottom: '14px', fontSize: '12.5px' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '5px' }}>
                What this report is missing
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {!data.cutover && <li>No QuickBooks cutover is confirmed, so only NetSuite months are shown.</li>}
                {data.cutover && qboMonths === 0 && <li>No QuickBooks monthly P&amp;L reports are imported for the years before the cutover yet.</li>}
                {data.netsuitePending > 0 && <li>{data.netsuitePending} NetSuite month{data.netsuitePending === 1 ? ' is' : 's are'} still loading{fillRounds.current < MAX_FILL_ROUNDS ? '…' : '. Reload the page to fetch the rest.'}</li>}
                {data.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          <div style={card}>
            <div style={eyebrow}>By year</div>
            <div className="responsive-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Year</th>
                    <th style={{ ...th, textAlign: 'left' }}>Source</th>
                    <th style={th}>Revenue</th>
                    <th style={th}>vs prior</th>
                    <th style={th}>Gross profit</th>
                    <th style={th}>GM %</th>
                    <th style={th}>Expenses</th>
                    <th style={th}>Net income</th>
                    <th style={th}>Net %</th>
                  </tr>
                </thead>
                <tbody>
                  {[...years].reverse().map(y => {
                    const prev = prevOf(y);
                    const partial = y.months < 12 || y.directional;
                    // Growth only compares full years; a partial year against a
                    // full one reads as a collapse that didn't happen.
                    const growth = prev && !partial && prev.months === 12 && prev.income
                      ? ((y.income - prev.income) / Math.abs(prev.income)) * 100 : null;
                    return (
                      <tr key={y.year}>
                        <td style={{ ...td, textAlign: 'left', fontWeight: 800 }}>
                          {y.year}
                          {partial && <span style={{ fontWeight: 500, color: 'var(--text-muted)', fontSize: '11px' }}> · {y.months} mo{y.directional ? ', in progress' : ''}</span>}
                        </td>
                        <td style={{ ...td, textAlign: 'left' }}><SourceDots sources={y.sources} /></td>
                        <td style={{ ...td, fontWeight: 700 }}>{fmtMoney(y.income)}</td>
                        <td style={{ ...td, color: growth === null ? 'var(--text-muted)' : growth >= 0 ? '#22c55e' : '#ef4444' }}>
                          {growth === null ? '—' : `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`}
                        </td>
                        <td style={td}>{fmtMoney(y.grossProfit)}</td>
                        <td style={td}>{fmtPct(y.grossMarginPct)}</td>
                        <td style={td}>{fmtMoney(y.expenses)}</td>
                        <td style={{ ...td, fontWeight: 700, color: y.netIncome < 0 ? '#ef4444' : undefined }}>{fmtMoney(y.netIncome)}</td>
                        <td style={td}>{fmtPct(y.netMarginPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
              <div style={{ ...eyebrow, marginBottom: 0, marginRight: 'auto' }}>By month</div>
              {METRICS.map(m => (
                <button key={m.key} onClick={() => setMetric(m.key)} style={{
                  padding: '4px 10px', borderRadius: '999px', fontSize: '10.5px', fontWeight: 700, cursor: 'pointer',
                  background: metric === m.key ? 'var(--tab-active-bg)' : 'transparent',
                  border: `1px solid ${metric === m.key ? 'var(--tab-active-border)' : 'var(--border)'}`,
                  color: metric === m.key ? 'var(--text-primary)' : 'var(--text-muted)',
                }}>{m.label}</button>
              ))}
            </div>
            <MonthlyChart months={data.months} metric={metric} />
            <div style={{ display: 'flex', gap: '12px', fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              <span><span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: SOURCE_COLOR.quickbooks, marginRight: '4px' }} />QuickBooks</span>
              <span><span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: SOURCE_COLOR.netsuite, marginRight: '4px' }} />NetSuite</span>
              <span>Faded bar = month in progress</span>
            </div>
          </div>

          <div style={card}>
            <div style={eyebrow}>{METRICS.find(m => m.key === metric)?.label} by month and year</div>
            <div className="responsive-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: 'left' }}>Month</th>
                    {grid.years.map(y => <th key={y} style={th}>{y}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {MONTHS.map((label, i) => (
                    <tr key={label}>
                      <td style={{ ...td, textAlign: 'left', fontWeight: 700 }}>{label}</td>
                      {grid.years.map(y => {
                        const m = grid.byKey.get(`${y}-${String(i + 1).padStart(2, '0')}`);
                        return (
                          <td key={y} style={{ ...td, color: !m ? 'var(--text-muted)' : m[metric] < 0 ? '#ef4444' : undefined, opacity: m?.directional ? 0.6 : 1 }}
                            title={m ? `${SOURCE_LABEL[m.source]}${m.directional ? ' · in progress' : ''}` : undefined}>
                            {m ? fmtK(m[metric]) : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 800 }}>Total</td>
                    {years.map(y => <td key={y.year} style={{ ...td, fontWeight: 800 }}>{fmtK(y[metric])}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
