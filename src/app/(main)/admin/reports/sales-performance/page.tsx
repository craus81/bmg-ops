'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';
import { deepLinks } from '@/lib/deep-links';

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

interface FunnelBucketRow {
  source: string; leads: number; withDeal: number; quoted: number;
  won: number; lost: number; wonValue: number;
  conversion: number | null; avgDealSize: number | null;
}
interface FunnelPayload {
  totals: Omit<FunnelBucketRow, 'source'>;
  bySource: FunnelBucketRow[];
  byRep: { repId: string; repName: string; deals: number; value: number; won: number; wonValue: number; lost: number }[];
}
interface OutcomeSummaryRow {
  sent: number; approved: number; rejected: number; pending: number;
  medianDaysToDecision: number | null;
  remindersAtApproval: { none: number; one: number; two: number; threePlus: number };
  channels: { email: number; sms: number };
}
interface LostReasonsPayload {
  reasonCounts: { reason: string; count: number; value: number }[];
  deals: { id: string; prospectId: string; title: string; customer: string; value: number; reason: string | null; note: string | null; at: string | null }[];
  rejections: { kind: 'estimate' | 'wrap'; id: string; number: string; customer: string; total: number; reason: string | null; at: string }[];
}
type SectionOr<T> = T | { error: string } | null;

interface Report {
  range: { start: string; end: string };
  totals: Omit<RepRow, 'repId' | 'repName'>;
  perRep: RepRow[];
  quotes: QuoteRow[];
  funnel: SectionOr<FunnelPayload>;
  outcomes: SectionOr<{ estimates: OutcomeSummaryRow; proofs: OutcomeSummaryRow }>;
  lostReasons: SectionOr<LostReasonsPayload>;
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtPct = (r: number | null) => r == null ? '—' : `${Math.round(r * 100)}%`;
const OUTCOME_COLORS = { won: '#22c55e', lost: '#ef4444', open: '#fbbf24' } as const;
const LOST_LABELS: Record<string, string> = {
  price: 'Price', timing: 'Timing', competitor: 'Competitor',
  no_response: 'No response', other: 'Other', '(no reason recorded)': 'No reason recorded',
};
const isErr = (s: unknown): s is { error: string } =>
  !!s && typeof s === 'object' && 'error' in (s as Record<string, unknown>);
const TABS = [
  { key: 'performance', label: 'Performance' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'outcomes', label: 'Outcomes' },
  { key: 'lost', label: 'Lost reasons' },
] as const;

export default function SalesPerformancePage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();

  const [start, setStart] = useState(() => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('performance');

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

      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {TABS.map(t2 => (
          <button key={t2.key} onClick={() => setTab(t2.key)} style={{
            padding: '7px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: tab === t2.key ? 'rgba(96,165,250,0.15)' : 'var(--card)',
            border: `1px solid ${tab === t2.key ? '#3b82f6' : 'var(--border)'}`,
            color: tab === t2.key ? '#60a5fa' : 'var(--text-secondary)',
          }}>{t2.label}</button>
        ))}
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

      {tab === 'performance' && t && !loading && !error && (
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

      {tab === 'performance' && report && !loading && report.perRep.length > 0 && (
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

      {tab === 'performance' && report && !loading && report.quotes.length > 0 && (
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

      {/* ── Funnel: leads created in range → quoted → won/lost, by source (R5-9) ── */}
      {tab === 'funnel' && report && !loading && (
        isErr(report.funnel) || !report.funnel ? (
          <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px' }}>
            Funnel unavailable: {isErr(report.funnel) ? report.funnel.error : 'no data returned'}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
              {[
                { label: 'Leads created', value: String(report.funnel.totals.leads), sub: 'prospects in range', color: 'var(--text-primary)' },
                { label: 'Got a deal', value: String(report.funnel.totals.withDeal), sub: `${report.funnel.totals.quoted} moved past lead`, color: '#60a5fa' },
                { label: 'Won', value: String(report.funnel.totals.won), sub: fmtMoney(report.funnel.totals.wonValue), color: '#22c55e' },
                { label: 'Conversion', value: fmtPct(report.funnel.totals.conversion), sub: 'won ÷ leads', color: '#a78bfa' },
                { label: 'Avg won deal', value: report.funnel.totals.avgDealSize != null ? fmtMoney(report.funnel.totals.avgDealSize) : '—', sub: 'per won deal', color: 'var(--text-primary)' },
              ].map(tile => (
                <div key={tile.label} style={{ padding: '12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{tile.label}</div>
                  <div style={{ fontSize: '18px', fontWeight: 800, color: tile.color, marginTop: '2px' }}>{tile.value}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{tile.sub}</div>
                </div>
              ))}
            </div>
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto', marginBottom: '14px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    <th style={{ ...cell, textAlign: 'left' }}>Lead source</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Leads</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Got a deal</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Quoted+</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Won</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Lost</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Won $</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Conversion</th>
                    <th style={{ ...cell, textAlign: 'right' }}>Avg deal</th>
                  </tr>
                </thead>
                <tbody>
                  {report.funnel.bySource.map(s => (
                    <tr key={s.source}>
                      <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{s.source}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{s.leads}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{s.withDeal}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{s.quoted}</td>
                      <td style={{ ...cell, textAlign: 'right', color: '#22c55e', fontWeight: 700 }}>{s.won}</td>
                      <td style={{ ...cell, textAlign: 'right', color: s.lost > 0 ? '#ef4444' : 'var(--text-muted)' }}>{s.lost}</td>
                      <td style={{ ...cell, textAlign: 'right', color: '#22c55e' }}>{fmtMoney(s.wonValue)}</td>
                      <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmtPct(s.conversion)}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{s.avgDealSize != null ? fmtMoney(s.avgDealSize) : '—'}</td>
                    </tr>
                  ))}
                  {report.funnel.bySource.length === 0 && (
                    <tr><td style={{ ...cell, color: 'var(--text-muted)' }} colSpan={9}>No prospects created in this range.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {report.funnel.byRep.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                      <th style={{ ...cell, textAlign: 'left' }}>Rep · deals created in range</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Deals</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Value</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Won</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Won $</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Lost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.funnel.byRep.map(r => (
                      <tr key={r.repId}>
                        <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{r.repName}</td>
                        <td style={{ ...cell, textAlign: 'right' }}>{r.deals}</td>
                        <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.value)}</td>
                        <td style={{ ...cell, textAlign: 'right', color: '#22c55e', fontWeight: 700 }}>{r.won}</td>
                        <td style={{ ...cell, textAlign: 'right', color: '#22c55e' }}>{fmtMoney(r.wonValue)}</td>
                        <td style={{ ...cell, textAlign: 'right', color: r.lost > 0 ? '#ef4444' : 'var(--text-muted)' }}>{r.lost}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )
      )}

      {/* ── Outcomes: sent → decided forensics for estimates & proofs (R5-9) ── */}
      {tab === 'outcomes' && report && !loading && (
        isErr(report.outcomes) || !report.outcomes ? (
          <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px' }}>
            Outcomes unavailable: {isErr(report.outcomes) ? report.outcomes.error : 'no data returned'}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', marginBottom: '10px' }}>
              {([
                { label: 'Estimates', s: report.outcomes.estimates },
                { label: 'Graphics proofs', s: report.outcomes.proofs },
              ] as const).map(({ label, s }) => {
                const decided = s.approved + s.rejected;
                const afterReminder = s.remindersAtApproval.one + s.remindersAtApproval.two + s.remindersAtApproval.threePlus;
                return (
                  <div key={label} style={{ padding: '14px', borderRadius: '12px', background: 'var(--card)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>{label} · {s.sent} sent</div>
                    <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '12px', marginBottom: '10px' }}>
                      <span style={{ color: '#22c55e', fontWeight: 700 }}>{s.approved} approved</span>
                      <span style={{ color: '#ef4444', fontWeight: 700 }}>{s.rejected} rejected</span>
                      <span style={{ color: '#fbbf24', fontWeight: 700 }}>{s.pending} pending</span>
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {decided > 0 ? `${Math.round((s.approved / decided) * 100)}% approval (decided)` : 'nothing decided yet'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                      <div>Median time to decision: <b style={{ color: 'var(--text-primary)' }}>{s.medianDaysToDecision != null ? `${s.medianDaysToDecision} days` : '—'}</b></div>
                      <div>
                        Approvals by reminders sent: <b style={{ color: 'var(--text-primary)' }}>{s.remindersAtApproval.none}</b> before any
                        · <b>{s.remindersAtApproval.one}</b> after #1
                        · <b>{s.remindersAtApproval.two}</b> after #2
                        · <b>{s.remindersAtApproval.threePlus}</b> after #3+
                        {s.approved > 0 && <span style={{ color: 'var(--text-muted)' }}> ({Math.round((afterReminder / s.approved) * 100)}% needed a reminder)</span>}
                      </div>
                      <div>Approval channel: <b style={{ color: 'var(--text-primary)' }}>{s.channels.email}</b> email link · <b>{s.channels.sms}</b> SMS link</div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Reminder counts are the record&apos;s reminder tally at decision time (the reminder crons stop once a record is decided). Wrap quotes have no reminder tracking and are excluded here — the Performance tab still counts their wins.
            </div>
          </>
        )
      )}

      {/* ── Lost reasons: structured deal reasons + the customer's words (R5-9) ── */}
      {tab === 'lost' && report && !loading && (
        isErr(report.lostReasons) || !report.lostReasons ? (
          <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px' }}>
            Lost reasons unavailable: {isErr(report.lostReasons) ? report.lostReasons.error : 'no data returned'}
          </div>
        ) : (
          <>
            {report.lostReasons.reasonCounts.length > 0 && (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
                {report.lostReasons.reasonCounts.map(rc => (
                  <div key={rc.reason} style={{ padding: '8px 12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)', fontSize: '12px' }}>
                    <b style={{ color: '#ef4444' }}>{LOST_LABELS[rc.reason] || rc.reason}</b>
                    <span style={{ color: 'var(--text-secondary)' }}> · {rc.count} deal{rc.count !== 1 ? 's' : ''} · {fmtMoney(rc.value)}</span>
                  </div>
                ))}
              </div>
            )}
            {report.lostReasons.deals.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto', marginBottom: '14px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                      <th style={{ ...cell, textAlign: 'left' }}>Deal lost</th>
                      <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Value</th>
                      <th style={{ ...cell, textAlign: 'left' }}>Reason</th>
                      <th style={{ ...cell, textAlign: 'left' }}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lostReasons.deals.map(d => (
                      <tr key={d.id} onClick={() => router.push(deepLinks.opportunity(d.prospectId, d.id))} style={{ cursor: 'pointer' }} title="Open this deal on the customer record">
                        <td style={{ ...cell, fontWeight: 700, color: '#60a5fa' }}>{d.title}</td>
                        <td style={{ ...cell, color: 'var(--text-secondary)' }}>{d.customer}</td>
                        <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(d.value)}</td>
                        <td style={{ ...cell, color: '#ef4444', fontWeight: 700 }}>{LOST_LABELS[d.reason || '(no reason recorded)'] || d.reason}</td>
                        <td style={{ ...cell, color: 'var(--text-muted)', maxWidth: '320px' }}>{d.note || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.lostReasons.rejections.length > 0 && (
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                      <th style={{ ...cell, textAlign: 'left' }}>Quote rejected</th>
                      <th style={{ ...cell, textAlign: 'left' }}>Customer</th>
                      <th style={{ ...cell, textAlign: 'right' }}>Total</th>
                      <th style={{ ...cell, textAlign: 'left' }}>The customer&apos;s words</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lostReasons.rejections.map(q => (
                      <tr key={`${q.kind}-${q.id}`}
                        onClick={() => router.push(q.kind === 'estimate' ? deepLinks.estimate(q.id) : deepLinks.wrapQuote(q.id))}
                        style={{ cursor: 'pointer' }} title="Open this quote">
                        <td style={{ ...cell, fontWeight: 700, color: '#60a5fa' }}>
                          {q.number}
                          <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginLeft: '6px', textTransform: 'uppercase' }}>{q.kind}</span>
                        </td>
                        <td style={{ ...cell, color: 'var(--text-secondary)' }}>{q.customer}</td>
                        <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(q.total)}</td>
                        <td style={{ ...cell, color: 'var(--text-muted)', maxWidth: '380px' }}>{q.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {report.lostReasons.deals.length === 0 && report.lostReasons.rejections.length === 0 && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing lost or rejected in this range.</div>
            )}
          </>
        )
      )}
    </div>
  );
}
