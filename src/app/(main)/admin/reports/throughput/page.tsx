'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';
import { PIPELINES, type PipelineKey } from '@/lib/throughput';

/**
 * Cycle-Time & Throughput (R6-12) — one report over all three pipelines.
 *
 * Every number here carries its sample count, because the reason a report
 * like this misleads is a median over two data points presented like a
 * fact. p90 is blank below the floor rather than printed as the maximum,
 * nothing is "the bottleneck" without enough cycles through it, and the
 * in-flight work excluded from the medians is stated rather than hidden.
 */

interface StageStat { stage: string; label: string; medianDays: number; p90Days: number | null; samples: number }
interface MonthPoint { month: string; medianDays: number; completions: number }
interface ReworkRow {
  from: string; to: string; label: string; count: number;
  reasons: { reason: string; count: number }[]; withoutReason: number;
}
interface Report {
  pipeline: PipelineKey;
  label: string;
  days: number;
  stages: StageStat[];
  bottleneck: StageStat | null;
  byMonth: MonthPoint[];
  rework: { rows: ReworkRow[]; events: number; affectedRecords: number; totalRecords: number };
  completions: number;
  medianTurnaroundDays: number | null;
  p90TurnaroundDays: number | null;
  inFlight: number;
  closers: { name: string; count: number }[];
  arrivals: {
    samples: number; onDay: number; early: number; late: number;
    medianDaysLate: number | null; noForecast: number; noArrivalStamp: number;
  } | null;
  meta: { minBottleneckSamples: number; minP90Samples: number; generatedAt: string };
}

const PIPELINE_KEYS = Object.keys(PIPELINES) as PipelineKey[];
const RANGES = [30, 90, 180, 365];

const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

export default function ThroughputPage() {
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const router = useRouter();
  const [pipeline, setPipeline] = useState<PipelineKey>('vehicles');
  const [days, setDays] = useState(180);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: PipelineKey, d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reports/throughput?pipeline=${p}&days=${d}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Report failed');
      setReport(data as Report);
    } catch (e: any) {
      setError(e.message || 'Report failed');
      setReport(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load(pipeline, days);
  }, [authLoading, isAdmin, isSales, router, load, pipeline, days]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `throughput-${report.pipeline}-${report.days}d.csv`,
      ['Stage', 'Median days', 'p90 days', 'Cycles measured'],
      report.stages.map(s => [s.label, s.medianDays, s.p90Days ?? 'too few samples', s.samples]),
    );
  };

  const tile = (label: string, value: string, color: string, sub?: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );

  const pill = (active: boolean) => ({
    padding: '7px 13px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
    border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
    background: active ? 'var(--card)' : 'transparent',
    color: 'var(--text-primary)',
  });

  if (authLoading || (!isAdmin && !isSales)) return null;

  const maxMonth = Math.max(1, ...(report?.byMonth || []).map(p => p.medianDays));

  return (
    <div style={{ maxWidth: '1000px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Cycle Time &amp; Throughput</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        How long each stage really takes, where the work piles up, and how often it goes backwards — read straight off the
        boards&rsquo; own status history. Every figure shows the number of cycles behind it.
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        {PIPELINE_KEYS.map(k => (
          <button key={k} onClick={() => setPipeline(k)} style={pill(pipeline === k)}>{PIPELINES[k].label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        {RANGES.map(d => (
          <button key={d} onClick={() => setDays(d)} style={{ ...pill(days === d), fontSize: '11px' }}>
            {d >= 365 ? '1 year' : `${d} days`}
          </button>
        ))}
        <button onClick={exportCsv} disabled={!report}
          style={{ padding: '7px 13px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
          Export stages CSV
        </button>
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {tile('Completed', String(report.completions), '#2563eb', `cycles closed in ${report.days} days`)}
            {tile('Median turnaround',
              report.medianTurnaroundDays == null ? '—' : `${report.medianTurnaroundDays}d`,
              '#2563eb',
              report.p90TurnaroundDays == null
                ? `p90 needs ${report.meta.minP90Samples}+ cycles`
                : `p90 ${report.p90TurnaroundDays}d`)}
            {tile('Bottleneck',
              report.bottleneck ? report.bottleneck.label : '—',
              report.bottleneck ? '#f59e0b' : 'var(--text-muted)',
              report.bottleneck
                ? `${report.bottleneck.medianDays}d median · ${report.bottleneck.samples} cycles`
                : `no stage has ${report.meta.minBottleneckSamples}+ cycles yet`)}
            {tile('Rework', String(report.rework.events),
              report.rework.events > 0 ? '#ef4444' : '#22c55e',
              `${report.rework.affectedRecords} of ${report.rework.totalRecords} records went backwards`)}
          </div>
          {report.inFlight > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              {report.inFlight} record{report.inFlight === 1 ? ' is' : 's are'} still in flight and excluded — only closed cycles are measured,
              so work sitting on the floor right now can&rsquo;t drag these medians around.
            </div>
          )}

          <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '14px 0 8px' }}>Dwell by stage</h2>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Stage</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Median</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>p90</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Cycles</th>
                </tr>
              </thead>
              <tbody>
                {report.stages.map(s => {
                  const thin = s.samples < report.meta.minBottleneckSamples;
                  return (
                    <tr key={s.stage} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontWeight: report.bottleneck?.stage === s.stage ? 800 : 400 }}>
                        {s.label}
                        {report.bottleneck?.stage === s.stage && <span style={{ color: '#f59e0b', marginLeft: '7px', fontSize: '11px', fontWeight: 800 }}>BOTTLENECK</span>}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: thin ? 'var(--text-muted)' : 'inherit' }}>{s.medianDays}d</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>
                        {s.p90Days == null ? <span title={`Needs ${report.meta.minP90Samples}+ cycles`}>—</span> : `${s.p90Days}d`}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: thin ? '#f59e0b' : 'var(--text-muted)' }}>
                        {s.samples}{thin ? ' (thin)' : ''}
                      </td>
                    </tr>
                  );
                })}
                {report.stages.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No closed cycles in this window.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {report.byMonth.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>Turnaround by month</h2>
              <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px' }}>
                {report.byMonth.map(p => (
                  <div key={p.month} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px' }}>
                    <div style={{ width: '58px', fontSize: '12px', color: 'var(--text-muted)' }}>{monthLabel(p.month)}</div>
                    <div style={{ flex: 1, background: 'var(--border)', borderRadius: '4px', height: '14px', overflow: 'hidden' }}>
                      <div style={{ width: `${(p.medianDays / maxMonth) * 100}%`, background: '#2563eb', height: '100%' }} />
                    </div>
                    <div style={{ width: '110px', textAlign: 'right', fontSize: '12px' }}>
                      <strong>{p.medianDays}d</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {p.completions} done</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {report.rework.rows.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>Rework</h2>
              <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px' }}>
                {report.rework.rows.map(r => (
                  <div key={`${r.from}-${r.to}`} style={{ marginBottom: '10px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>
                      {r.label} <span style={{ color: '#ef4444' }}>× {r.count}</span>
                    </div>
                    {r.reasons.length > 0 && (
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                        {r.reasons.slice(0, 4).map(x => `${x.reason} (${x.count})`).join(' · ')}
                      </div>
                    )}
                    {r.withoutReason > 0 && (
                      <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '2px' }}>
                        {r.withoutReason} of these were sent back with no reason typed.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {report.closers.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>Completions by person</h2>
              <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', fontSize: '13px' }}>
                {report.closers.map(c => (
                  <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                    <span style={{ color: c.name === 'Not attributed' ? 'var(--text-muted)' : 'inherit' }}>{c.name}</span>
                    <strong>{c.count}</strong>
                  </div>
                ))}
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                  Who moved the job to its final status. Rows with no recorded actor are counted as
                  &ldquo;Not attributed&rdquo; rather than dropped, so this adds up to {report.completions}.
                </div>
              </div>
            </>
          )}

          {report.arrivals && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>Arrival forecast accuracy</h2>
              <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', fontSize: '13px' }}>
                {report.arrivals.samples === 0 ? (
                  <div style={{ color: 'var(--text-muted)' }}>
                    No arrival in this window had both an expected date and a linked check-in to compare.
                    {report.arrivals.noForecast > 0 && ` ${report.arrivals.noForecast} arrived with no forecast on file.`}
                    {report.arrivals.noArrivalStamp > 0 && ` ${report.arrivals.noArrivalStamp} were marked arrived with no linked check-in to date them.`}
                  </div>
                ) : (
                  <>
                    <div>
                      <strong>{report.arrivals.onDay}</strong> on the day ·{' '}
                      <strong>{report.arrivals.early}</strong> early ·{' '}
                      <strong style={{ color: report.arrivals.late > 0 ? '#f59e0b' : 'inherit' }}>{report.arrivals.late}</strong> late
                      {report.arrivals.medianDaysLate != null && (
                        <span style={{ color: 'var(--text-muted)' }}> · median slip {report.arrivals.medianDaysLate}d</span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                      Over {report.arrivals.samples} arrival{report.arrivals.samples === 1 ? '' : 's'} that had an expected date.
                      {report.arrivals.noForecast > 0 && (
                        <> {report.arrivals.noForecast} more arrived with no forecast on file — those are unmeasurable, not on time.</>
                      )}
                      {report.arrivals.noArrivalStamp > 0 && (
                        <> {report.arrivals.noArrivalStamp} were marked arrived without a linked check-in, so there is no trustworthy arrival date to compare.</>
                      )}
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '14px' }}>
            A returning vehicle or reopened job starts a NEW cycle, so a previous visit&rsquo;s dwell never lands in this one.
            p90 is withheld below {report.meta.minP90Samples} cycles and no stage is called the bottleneck below{' '}
            {report.meta.minBottleneckSamples}. Promised-vs-actual delivery lives in the{' '}
            <Link href="/admin/reports/on-time" style={{ color: 'var(--accent, #2563eb)' }}>on-time scorecard</Link>;
            approval overrides live in the exceptions digest.
          </div>
        </>
      )}
    </div>
  );
}
