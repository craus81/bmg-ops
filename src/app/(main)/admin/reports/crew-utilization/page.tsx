'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';

/**
 * Crew Utilization & Field Productivity (R6-12).
 *
 * The audit's "shop utilization %" half died with the punch clock (#838):
 * a utilization percentage needs clocked attendance as its denominator and
 * that now lives in the payroll app. The page says so in as many words
 * rather than inventing a denominator, and shows the hours that ARE
 * measured — job timers — against what was planned.
 */

interface HoursSplit {
  measuredHours: number; autoClosedHours: number; totalHours: number;
  shifts: number; autoClosedShifts: number; openShifts: number;
}
interface JobRow extends HoursSplit {
  jobId: string; jobNumber: string | null; title: string | null; companyName: string | null;
  status: string | null; estimatedHours: number | null; variancePct: number | null;
  vehiclesCompleted: number; vehiclesPerCrewHour: number | null; url: string;
}
interface CompanyRow extends HoursSplit {
  companyId: string | null; companyName: string; vehiclesCompleted: number;
  vehiclesPerCrewHour: number | null; weeks: { week: string; hours: number; completions: number }[];
}
interface PersonRow extends HoursSplit {
  profileId: string; name: string; byContext: Record<string, number>;
}
interface Report {
  days: number;
  jobs: JobRow[];
  companies: CompanyRow[];
  people: PersonRow[];
  totals: HoursSplit & { vehiclesCompleted: number; jobsWithoutEstimate: number };
  meta: { generatedAt: string; shopUtilizationAvailable: false; shopUtilizationWhy: string };
}

const RANGES = [30, 90, 180, 365];
const CONTEXT_LABEL: Record<string, string> = {
  cni: 'CNI', field: 'Field', shop: 'Shop', graphics: 'Print room',
};

export default function CrewUtilizationPage() {
  const { isAdmin, loading: authLoading } = useAuth();
  const router = useRouter();
  const [days, setDays] = useState(90);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reports/crew-utilization?days=${d}`);
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
    if (!isAdmin) { router.push('/home'); return; }
    load(days);
  }, [authLoading, isAdmin, router, load, days]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `crew-productivity-${report.days}d.csv`,
      ['Job', 'Company', 'Status', 'Crew hours', 'Of which approximate', 'Estimated hours', 'Variance %', 'Vehicles', 'Vehicles/crew hour'],
      report.jobs.map(j => [
        j.jobNumber || j.title || j.jobId, j.companyName || '', j.status || '',
        j.totalHours, j.autoClosedHours,
        j.estimatedHours ?? 'no estimate',
        j.variancePct ?? 'n/a',
        j.vehiclesCompleted,
        j.vehiclesPerCrewHour ?? 'n/a',
      ]),
    );
  };

  const pill = (active: boolean) => ({
    padding: '7px 13px', borderRadius: '999px', cursor: 'pointer', fontSize: '12px', fontWeight: 700,
    border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border)'}`,
    background: active ? 'var(--card)' : 'transparent', color: 'var(--text-primary)',
  });

  const tile = (label: string, value: string, color: string, sub?: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );

  if (authLoading || !isAdmin) return null;

  return (
    <div style={{ maxWidth: '1000px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Crew Hours &amp; Field Productivity</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Crew hours from job timers (duration × crew) against what was planned — per job, per company, per person.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        {RANGES.map(d => (
          <button key={d} onClick={() => setDays(d)} style={pill(days === d)}>
            {d >= 365 ? '1 year' : `${d} days`}
          </button>
        ))}
        <button onClick={exportCsv} disabled={!report}
          style={{ padding: '7px 13px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
          Export jobs CSV
        </button>
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && !loading && (
        <>
          <div style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '11px 14px', marginBottom: '14px', fontSize: '12px', color: 'var(--text-muted)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>No utilization percentage here, on purpose.</strong>{' '}
            {report.meta.shopUtilizationWhy}
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {tile('Crew hours', String(report.totals.totalHours), '#2563eb', `${report.totals.shifts} shifts`)}
            {tile('Approximate', String(report.totals.autoClosedHours),
              report.totals.autoClosedHours > 0 ? '#f59e0b' : '#22c55e',
              `${report.totals.autoClosedShifts} timer${report.totals.autoClosedShifts === 1 ? '' : 's'} nobody stopped`)}
            {tile('Vehicles done', String(report.totals.vehiclesCompleted), '#22c55e',
              report.totals.totalHours > 0
                ? `${(report.totals.vehiclesCompleted / report.totals.totalHours).toFixed(2)} per crew hour`
                : 'no hours logged')}
          </div>
          {(report.totals.openShifts > 0 || report.totals.jobsWithoutEstimate > 0) && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
              {report.totals.openShifts > 0 && (
                <>{report.totals.openShifts} timer{report.totals.openShifts === 1 ? ' is' : 's are'} still running and contribute no hours yet. </>
              )}
              {report.totals.jobsWithoutEstimate > 0 && (
                <>{report.totals.jobsWithoutEstimate} job{report.totals.jobsWithoutEstimate === 1 ? ' has' : 's have'} no estimated hours on file, so there is nothing to compare them against.</>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '14px 0 8px' }}>By job — actual vs estimate</h2>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  <th style={{ padding: '8px 12px' }}>Job</th>
                  <th style={{ padding: '8px 12px' }}>Company</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Crew hrs</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Estimate</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Variance</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Vehicles</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right' }}>Per hr</th>
                </tr>
              </thead>
              <tbody>
                {report.jobs.map(j => (
                  <tr key={j.jobId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}>
                      <Link href={j.url} style={{ color: 'var(--accent, #2563eb)', fontWeight: 700, textDecoration: 'none' }}>
                        {j.jobNumber || j.title || 'Untitled job'}
                      </Link>
                      {j.autoClosedHours > 0 && (
                        <div style={{ fontSize: '10.5px', color: '#f59e0b' }}>{j.autoClosedHours}h approximate (timer not stopped)</div>
                      )}
                    </td>
                    <td style={{ padding: '8px 12px' }}>{j.companyName || '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{j.totalHours}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>
                      {j.estimatedHours ?? <span title="Nobody estimated this job">—</span>}
                    </td>
                    <td style={{
                      padding: '8px 12px', textAlign: 'right', fontWeight: 700,
                      color: j.variancePct == null ? 'var(--text-muted)' : j.variancePct > 15 ? '#ef4444' : j.variancePct < -15 ? '#22c55e' : 'inherit',
                    }}>
                      {j.variancePct == null ? '—' : `${j.variancePct > 0 ? '+' : ''}${j.variancePct}%`}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{j.vehiclesCompleted}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>
                      {j.vehiclesPerCrewHour ?? '—'}
                    </td>
                  </tr>
                ))}
                {report.jobs.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No CNI job timers in this window.
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          {report.companies.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>By company</h2>
              <div style={{ display: 'grid', gap: '8px' }}>
                {report.companies.map(c => (
                  <div key={c.companyId || 'none'} style={{ border: '1px solid var(--border)', borderRadius: '12px', padding: '11px 14px', background: 'var(--card)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                      <strong style={{ fontSize: '13.5px' }}>{c.companyName}</strong>
                      <span style={{ fontSize: '12.5px' }}>
                        {c.totalHours}h · {c.vehiclesCompleted} vehicles
                        {c.vehiclesPerCrewHour != null && <span style={{ color: 'var(--text-muted)' }}> · {c.vehiclesPerCrewHour}/hr</span>}
                      </span>
                    </div>
                    {c.weeks.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '5px' }}>
                        {c.weeks.slice(-8).map(w => `${w.week.slice(5)}: ${w.hours}h`).join(' · ')}
                      </div>
                    )}
                    {c.autoClosedHours > 0 && (
                      <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '3px' }}>
                        {c.autoClosedHours}h of that is approximate — timers the sweep had to close.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {report.people.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '18px 0 8px' }}>By person</h2>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px' }}>Person</th>
                      <th style={{ padding: '8px 12px' }}>Where the hours went</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Measured</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Approximate</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.people.map(p => (
                      <tr key={p.profileId} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{p.name}</td>
                        <td style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>
                          {Object.entries(p.byContext).map(([k, v]) => `${CONTEXT_LABEL[k] || k} ${v}h`).join(' · ') || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{p.measuredHours}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: p.autoClosedHours > 0 ? '#f59e0b' : 'var(--text-muted)' }}>{p.autoClosedHours}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{p.totalHours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '12px' }}>
            Crew hours are duration × the crew tagged on the shift, using each member&rsquo;s own presence window.
            Hours from timers nobody stopped (the nightly sweep capped them) are counted separately everywhere and
            never blended into a measured total. Vehicles per crew hour is blank rather than infinite when no hours were logged.
          </div>
        </>
      )}
    </div>
  );
}
