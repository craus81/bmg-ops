'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';

interface AtRiskRow {
  netsuite_id: string;
  company_name: string;
  entity_id: string | null;
  last_year_spend: number;
  ytd_spend: number;
  total_spend: number;
  last_order_date: string | null;
  days_quiet: number | null;
  pace: number;
  severity: 'critical' | 'watch';
  account_owner_name: string | null;
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function AtRiskReportPage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();

  const [rows, setRows] = useState<AtRiskRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [minSpend, setMinSpend] = useState('10000');
  const [quietDays, setQuietDays] = useState('60');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (ms: string, qd: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/at-risk?minSpend=${encodeURIComponent(ms)}&quietDays=${encodeURIComponent(qd)}`);
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Report failed');
      else { setRows(data.flagged || []); setScanned(data.scanned || 0); }
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    run(minSpend, quietDays);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after auth resolves
  }, [authLoading, isAdmin, isSales, router]);

  const exportCsv = () => {
    downloadCsv(
      `at-risk-accounts-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Customer', 'Entity ID', 'Severity', 'Last Year Spend', 'YTD Spend', 'Pace %', 'Last Order', 'Days Quiet', 'All-Time Spend', 'Account Owner'],
      rows.map(r => [
        r.company_name, r.entity_id, r.severity, r.last_year_spend, r.ytd_spend,
        Math.round(r.pace * 100), r.last_order_date, r.days_quiet, r.total_spend, r.account_owner_name,
      ]),
    );
  };

  const critical = rows.filter(r => r.severity === 'critical');
  const revenueAtRisk = rows.reduce((s, r) => s + r.last_year_spend, 0);

  const cell: React.CSSProperties = { padding: '7px 8px', borderBottom: '1px solid var(--border)', fontSize: '12px' };
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', width: '110px',
  };

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>At-Risk Accounts</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Customers who spent real money last year and have gone quiet — behind pace and no recent orders. A daily check alerts admins and the account&apos;s rep when a new one appears.
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Min last-year spend ($)</div>
          <input style={inputStyle} inputMode="numeric" value={minSpend} onChange={e => setMinSpend(e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Quiet for at least (days)</div>
          <input style={inputStyle} inputMode="numeric" value={quietDays} onChange={e => setQuietDays(e.target.value)} />
        </div>
        <button onClick={() => run(minSpend, quietDays)} disabled={loading} style={{ padding: '9px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
          {loading ? 'Running…' : 'Run'}
        </button>
        {rows.length > 0 && (
          <button onClick={exportCsv} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
            Export CSV
          </button>
        )}
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '14px' }}>{error}</div>}

      {/* Summary tiles */}
      {!loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {[
            { label: 'At risk', value: String(rows.length), color: rows.length > 0 ? '#fbbf24' : '#22c55e' },
            { label: 'Critical (zero / <20% pace)', value: String(critical.length), color: critical.length > 0 ? '#ef4444' : '#22c55e' },
            { label: 'Last-year revenue at risk', value: fmtMoney(revenueAtRisk), color: '#f472b6' },
            { label: 'Accounts scanned', value: String(scanned), color: 'var(--text-muted)' },
          ].map(t => (
            <div key={t.label} style={{ padding: '12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{t.label}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: t.color, marginTop: '2px' }}>{t.value}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          No at-risk accounts with these thresholds — nice.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                <th style={{ ...cell, textAlign: 'center' }}>Severity</th>
                <th style={{ ...cell, textAlign: 'right' }}>Last Year</th>
                <th style={{ ...cell, textAlign: 'right' }}>YTD</th>
                <th style={{ ...cell, textAlign: 'right' }}>Pace</th>
                <th style={{ ...cell, textAlign: 'right' }}>Last Order</th>
                <th style={{ ...cell, textAlign: 'right' }}>Quiet</th>
                <th style={{ ...cell, textAlign: 'left' }}>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.netsuite_id}>
                  <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {r.company_name}
                    {r.entity_id && <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '6px', fontSize: '10px' }}>{r.entity_id}</span>}
                  </td>
                  <td style={{ ...cell, textAlign: 'center' }}>
                    <span style={{
                      fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', textTransform: 'uppercase',
                      background: r.severity === 'critical' ? 'rgba(239,68,68,0.12)' : 'rgba(251,191,36,0.12)',
                      color: r.severity === 'critical' ? '#ef4444' : '#fbbf24',
                    }}>{r.severity}</span>
                  </td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.last_year_spend)}</td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700, color: r.ytd_spend === 0 ? '#ef4444' : 'var(--text-primary)' }}>{fmtMoney(r.ytd_spend)}</td>
                  <td style={{ ...cell, textAlign: 'right', color: r.pace < 0.2 ? '#ef4444' : '#fbbf24' }}>{Math.round(r.pace * 100)}%</td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{r.last_order_date ? new Date(r.last_order_date).toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' }) : 'never'}</td>
                  <td style={{ ...cell, textAlign: 'right', color: (r.days_quiet ?? 999) >= 90 ? '#ef4444' : 'var(--text-secondary)' }}>{r.days_quiet != null ? `${r.days_quiet}d` : '—'}</td>
                  <td style={{ ...cell, color: r.account_owner_name ? 'var(--text-secondary)' : 'var(--text-muted)' }}>{r.account_owner_name || 'unassigned'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
