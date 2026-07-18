'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';

interface RepRow {
  repId: string;
  repName: string;
  sentCount: number;
  sentValue: number;
  wonCount: number;
  wonValue: number;
  lostCount: number;
  lostValue: number;
  openCount: number;
  openValue: number;
  winRate: number | null;
  avgDaysToClose: number | null;
}

interface QuoteRow {
  type: 'estimate' | 'wrap';
  number: string;
  customer: string;
  total: number;
  sentAt: string | null;
  outcome: 'won' | 'lost' | 'open';
}

interface Report {
  range: { start: string; end: string };
  totals: Omit<RepRow, 'repId' | 'repName'>;
  perRep: RepRow[];
  quotes: QuoteRow[];
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtPct = (r: number | null) => r == null ? '—' : `${Math.round(r * 100)}%`;
const OUTCOME_COLORS = { won: '#22c55e', lost: '#ef4444', open: '#fbbf24' } as const;

export default function SalesPerformancePage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();

  const [start, setStart] = useState(() => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (s: string, e: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/sales-performance?start=${s}&end=${e}`);
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Report failed');
      else setReport(data);
    } catch (err: any) {
      setError(err.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    run(start, end);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after auth resolves
  }, [authLoading, isAdmin, isSales, router]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `sales-performance-${report.range.start}-to-${report.range.end}.csv`,
      ['Rep', 'Quotes Sent', 'Sent $', 'Won', 'Won $', 'Lost', 'Open', 'Open $', 'Win Rate %', 'Avg Days to Close'],
      report.perRep.map(r => [
        r.repName, r.sentCount, Math.round(r.sentValue), r.wonCount, Math.round(r.wonValue),
        r.lostCount, r.openCount, Math.round(r.openValue),
        r.winRate != null ? Math.round(r.winRate * 100) : '', r.avgDaysToClose != null ? r.avgDaysToClose.toFixed(1) : '',
      ]),
    );
  };

  const cell: React.CSSProperties = { padding: '7px 8px', borderBottom: '1px solid var(--border)', fontSize: '12px' };
  const inputStyle: React.CSSProperties = {
    padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)',
    background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px',
  };
  const t = report?.totals;

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Sales Performance</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Win rate, time-to-close, and quoted-vs-won by rep — from estimates and wrap quotes sent in the range. Won = accepted or pushed to NetSuite; win rate counts decided quotes only.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>From</div>
          <input type="date" style={inputStyle} value={start} onChange={e => setStart(e.target.value)} />
        </div>
        <div>
          <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>To</div>
          <input type="date" style={inputStyle} value={end} onChange={e => setEnd(e.target.value)} />
        </div>
        <button onClick={() => run(start, end)} disabled={loading} style={{ padding: '9px 16px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer' }}>
          {loading ? 'Running…' : 'Run'}
        </button>
        {report && report.perRep.length > 0 && (
          <button onClick={exportCsv} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
            Export CSV
          </button>
        )}
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '14px' }}>{error}</div>}

      {t && !loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {[
            { label: 'Quoted', value: `${fmtMoney(t.sentValue)}`, sub: `${t.sentCount} quotes`, color: 'var(--text-primary)' },
            { label: 'Won', value: `${fmtMoney(t.wonValue)}`, sub: `${t.wonCount} quotes`, color: '#22c55e' },
            { label: 'Win rate (decided)', value: fmtPct(t.winRate), sub: `${t.wonCount}W / ${t.lostCount}L`, color: '#60a5fa' },
            { label: 'Avg days to close', value: t.avgDaysToClose != null ? t.avgDaysToClose.toFixed(1) : '—', sub: 'sent → won', color: '#a78bfa' },
            { label: 'Still open', value: `${fmtMoney(t.openValue)}`, sub: `${t.openCount} quotes`, color: '#fbbf24' },
          ].map(tile => (
            <div key={tile.label} style={{ padding: '12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{tile.label}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: tile.color, marginTop: '2px' }}>{tile.value}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{tile.sub}</div>
            </div>
          ))}
        </div>
      )}

      {report && !loading && report.perRep.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto', marginBottom: '14px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                <th style={{ ...cell, textAlign: 'left' }}>Rep</th>
                <th style={{ ...cell, textAlign: 'right' }}>Sent</th>
                <th style={{ ...cell, textAlign: 'right' }}>Quoted $</th>
                <th style={{ ...cell, textAlign: 'right' }}>Won</th>
                <th style={{ ...cell, textAlign: 'right' }}>Won $</th>
                <th style={{ ...cell, textAlign: 'right' }}>Lost</th>
                <th style={{ ...cell, textAlign: 'right' }}>Open</th>
                <th style={{ ...cell, textAlign: 'right' }}>Win Rate</th>
                <th style={{ ...cell, textAlign: 'right' }}>Days to Close</th>
              </tr>
            </thead>
            <tbody>
              {report.perRep.map(r => (
                <tr key={r.repId}>
                  <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{r.repName}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{r.sentCount}</td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.sentValue)}</td>
                  <td style={{ ...cell, textAlign: 'right', color: '#22c55e', fontWeight: 700 }}>{r.wonCount}</td>
                  <td style={{ ...cell, textAlign: 'right', color: '#22c55e' }}>{fmtMoney(r.wonValue)}</td>
                  <td style={{ ...cell, textAlign: 'right', color: r.lostCount > 0 ? '#ef4444' : 'var(--text-muted)' }}>{r.lostCount}</td>
                  <td style={{ ...cell, textAlign: 'right', color: '#fbbf24' }}>{r.openCount}</td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmtPct(r.winRate)}</td>
                  <td style={{ ...cell, textAlign: 'right' }}>{r.avgDaysToClose != null ? r.avgDaysToClose.toFixed(1) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && !loading && report.quotes.length > 0 && (
        <details>
          <summary style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer', marginBottom: '8px' }}>
            Quote detail ({report.quotes.length})
          </summary>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  <th style={{ ...cell, textAlign: 'left' }}>Quote</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                  <th style={{ ...cell, textAlign: 'right' }}>Total</th>
                  <th style={{ ...cell, textAlign: 'right' }}>Sent</th>
                  <th style={{ ...cell, textAlign: 'center' }}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.quotes.map((q, i) => (
                  <tr key={`${q.type}-${q.number}-${i}`}>
                    <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {q.number}
                      <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '6px', textTransform: 'uppercase' }}>{q.type}</span>
                    </td>
                    <td style={{ ...cell, color: 'var(--text-secondary)' }}>{q.customer}</td>
                    <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(q.total)}</td>
                    <td style={{ ...cell, textAlign: 'right', color: 'var(--text-muted)' }}>{q.sentAt ? new Date(q.sentAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—'}</td>
                    <td style={{ ...cell, textAlign: 'center' }}>
                      <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '5px', textTransform: 'uppercase', color: OUTCOME_COLORS[q.outcome], background: `${OUTCOME_COLORS[q.outcome]}1f` }}>
                        {q.outcome}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
