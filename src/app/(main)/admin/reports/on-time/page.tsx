'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { downloadCsv } from '@/lib/csv';

/**
 * On-Time Delivery scorecard (R4-6): promises kept vs missed, from
 * promised_back_date vs the completion transition — plus the discipline
 * number (completions that never had a promise recorded) and what's
 * overdue on the floor right now. The daily promised-back guardian cron
 * defends what this page measures; both read src/lib/on-time.ts.
 */

interface Bucket {
  completed: number; onTime: number; late: number; noPromise: number;
  pct: number | null; avgDaysLate: number;
}

interface OpenRow {
  id: string; vin: string | null; label: string; customerName: string | null;
  status: string; promised: string; daysUntil: number; daysLate?: number;
}

interface Report {
  sinceDay: string;
  months: number;
  overall: Bucket;
  monthly: ({ month: string } & Bucket)[];
  perCustomer: ({ customer: string } & Bucket)[];
  open: { total: number; overdue: OpenRow[]; dueThisWeek: OpenRow[] };
}

const STAGE_LABELS: Record<string, string> = {
  received: 'received', checked_in: 'received', in_progress: 'in progress',
  stuck_parts: 'waiting on parts', stuck_graphics: 'waiting on graphics',
};

const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const fmtMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const pctColor = (pct: number | null) =>
  pct === null ? 'var(--text-muted)' : pct >= 90 ? '#22c55e' : pct >= 75 ? '#f59e0b' : '#ef4444';

export default function OnTimePage() {
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);
  const [months, setMonths] = useState(6);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (m: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/reports/on-time?months=${m}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Report failed');
      setReport(data as Report);
    } catch (e: any) {
      setError(e.message || 'Report failed');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin && !isSales) { router.push('/home'); return; }
    load(months);
  }, [authLoading, isAdmin, isSales, router, load, months]);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      'on-time-by-customer.csv',
      ['Customer', 'Completed', 'On time', 'Late', 'Avg days late', 'No promise', 'On-time %'],
      report.perCustomer.map(c => [
        c.customer, c.completed, c.onTime, c.late, c.avgDaysLate, c.noPromise, c.pct ?? '',
      ]),
    );
  };

  const tile = (label: string, value: string, color: string, sub?: string) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', minWidth: '150px' }}>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, color, marginTop: '2px' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );

  const th = (label: string, right?: boolean) => (
    <th style={{ padding: '8px 12px', textAlign: right ? 'right' : 'left' }}>{label}</th>
  );
  const td = (v: React.ReactNode, opts?: { right?: boolean; bold?: boolean; color?: string; nowrap?: boolean }) => (
    <td style={{
      padding: '8px 12px',
      textAlign: opts?.right ? 'right' : 'left',
      fontWeight: opts?.bold ? 700 : 400,
      color: opts?.color || 'inherit',
      whiteSpace: opts?.nowrap ? 'nowrap' : undefined,
    }}>{v}</td>
  );

  if (authLoading || (!isAdmin && !isSales)) return null;
  const o = report?.overall;

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>On-Time Delivery</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Promises kept: vehicles completed on or before their promised-back date, from the completion history.
      </div>

      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px' }}>
        {[3, 6, 12].map(m => (
          <button
            key={m}
            onClick={() => setMonths(m)}
            style={{
              padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${months === m ? 'var(--accent, #2563eb)' : 'var(--border)'}`,
              background: months === m ? 'var(--accent, #2563eb)' : 'var(--card)',
              color: months === m ? '#fff' : 'var(--text-primary)',
            }}
          >{m} mo</button>
        ))}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', marginBottom: '12px' }}>{error}</div>}
      {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

      {report && o && !loading && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '18px' }}>
            {tile('On-time rate', o.pct === null ? '—' : `${o.pct}%`, pctColor(o.pct), `${o.onTime} of ${o.onTime + o.late} promised, since ${fmtDay(report.sinceDay)}`)}
            {tile('Delivered late', String(o.late), o.late > 0 ? '#ef4444' : '#22c55e', o.late > 0 ? `avg ${o.avgDaysLate}d past the promise` : 'none in this window')}
            {tile('No promise recorded', String(o.noPromise), o.noPromise > 0 ? '#f59e0b' : '#22c55e', `of ${o.completed} completions — can't keep a date never set`)}
            {tile('Overdue right now', String(report.open.overdue.length), report.open.overdue.length > 0 ? '#ef4444' : '#22c55e', `${report.open.dueThisWeek.length} more due this week`)}
          </div>

          {report.open.overdue.length > 0 && (
            <>
              <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '0 0 8px' }}>Overdue on the floor</h2>
              <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px', marginBottom: '18px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                      {th('Vehicle')}{th('Customer')}{th('Stage')}{th('Promised')}{th('Days late', true)}
                    </tr>
                  </thead>
                  <tbody>
                    {report.open.overdue.map(v => (
                      <tr
                        key={v.id}
                        onClick={() => router.push(`/tracking?vehicle=${v.id}`)}
                        style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                      >
                        {td(v.label, { bold: true, nowrap: true })}
                        {td(v.customerName || '—')}
                        {td(STAGE_LABELS[v.status] || v.status)}
                        {td(fmtDay(v.promised), { nowrap: true })}
                        {td(`${v.daysLate}d`, { right: true, bold: true, color: '#ef4444' })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2 style={{ fontSize: '15px', fontWeight: 800, margin: '0 0 8px' }}>By month</h2>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px', marginBottom: '18px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  {th('Month')}{th('Completed', true)}{th('On time', true)}{th('Late', true)}{th('Avg days late', true)}{th('No promise', true)}{th('On-time %', true)}
                </tr>
              </thead>
              <tbody>
                {report.monthly.map(m => (
                  <tr key={m.month} style={{ borderTop: '1px solid var(--border)' }}>
                    {td(fmtMonth(m.month), { bold: true, nowrap: true })}
                    {td(m.completed, { right: true })}
                    {td(m.onTime, { right: true })}
                    {td(m.late, { right: true, color: m.late > 0 ? '#ef4444' : 'inherit' })}
                    {td(m.late > 0 ? `${m.avgDaysLate}d` : '—', { right: true })}
                    {td(m.noPromise, { right: true, color: m.noPromise > 0 ? '#f59e0b' : 'inherit' })}
                    {td(m.pct === null ? '—' : `${m.pct}%`, { right: true, bold: true, color: pctColor(m.pct) })}
                  </tr>
                ))}
                {report.monthly.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>No completions in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <h2 style={{ fontSize: '15px', fontWeight: 800, margin: 0 }}>By customer</h2>
            <button
              onClick={exportCsv}
              style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            >Export CSV</button>
          </div>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--card)', textAlign: 'left' }}>
                  {th('Customer')}{th('Completed', true)}{th('On time', true)}{th('Late', true)}{th('Avg days late', true)}{th('No promise', true)}{th('On-time %', true)}
                </tr>
              </thead>
              <tbody>
                {report.perCustomer.map(c => (
                  <tr key={c.customer} style={{ borderTop: '1px solid var(--border)' }}>
                    {td(c.customer, { bold: true })}
                    {td(c.completed, { right: true })}
                    {td(c.onTime, { right: true })}
                    {td(c.late, { right: true, color: c.late > 0 ? '#ef4444' : 'inherit' })}
                    {td(c.late > 0 ? `${c.avgDaysLate}d` : '—', { right: true })}
                    {td(c.noPromise, { right: true, color: c.noPromise > 0 ? '#f59e0b' : 'inherit' })}
                    {td(c.pct === null ? '—' : `${c.pct}%`, { right: true, bold: true, color: pctColor(c.pct) })}
                  </tr>
                ))}
                {report.perCustomer.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)' }}>No completions in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            On time = completed on or before the promised-back date (shop calendar days). The on-time % counts only completions that had a promise; &ldquo;no promise&rdquo; is tracked separately — a date never recorded can&rsquo;t be kept. Overdue rows open the vehicle on the board.
          </div>
        </>
      )}
    </div>
  );
}
