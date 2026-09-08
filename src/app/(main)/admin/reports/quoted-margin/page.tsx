'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';
import { deepLinks } from '@/lib/deep-links';

/**
 * Quoted Margin (R5-10): what margin we OFFERED, frozen at each send
 * (migration 275) — the leading indicator the post-invoice vehicle-margin
 * report only confirms months later. Margin % here is the parts margin
 * over costed lines only; quotes with no costed lines show as "unknown",
 * never as 100%.
 */

interface Rollup { count: number; value: number; weightedMarginPct: number | null; belowFloor: number }
interface BelowFloorRow {
  id: string; number: string; customer: string; total: number;
  marginPct: number | null; floorPct: number | null; reason: string | null;
  frozenAt: string; senderName: string;
}
interface Report {
  range: { start: string; end: string };
  currentFloor: number;
  totals: Rollup & { unknownMargin: number; belowFloorValue: number };
  byRep: ({ senderId: string; repName: string } & Rollup)[];
  byCustomer: ({ customer: string } & Rollup)[];
  byMonth: { month: string; count: number; value: number; weightedMarginPct: number | null }[];
  distribution: Record<'below' | 'floor0_10' | 'floor10_20' | 'floor20p' | 'unknown', { count: number; value: number }>;
  belowFloor: BelowFloorRow[];
}

const toDateStr = (d: Date) => d.toISOString().split('T')[0];
const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const fmtPct = (n: number | null) => n == null ? '—' : `${n}%`;

const BUCKETS = [
  { key: 'below', label: 'Below floor', color: '#ef4444' },
  { key: 'floor0_10', label: 'Floor to +10', color: '#fbbf24' },
  { key: 'floor10_20', label: '+10 to +20', color: '#60a5fa' },
  { key: 'floor20p', label: '+20 and up', color: '#22c55e' },
  { key: 'unknown', label: 'Unknown margin', color: 'var(--text-muted)' },
] as const;

export default function QuotedMarginPage() {
  const router = useRouter();
  const { isAdmin, isSales, loading: authLoading } = useAuth();
  const [start, setStart] = useState(() => toDateStr(new Date(Date.now() - 90 * 86_400_000)));
  const [end, setEnd] = useState(() => toDateStr(new Date()));
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!authLoading && !isAdmin && !isSales) {
    router.push('/home');
    return null;
  }

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/quoted-margin?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setReport(data);
    } catch (e: any) {
      setError(e?.message || 'Report failed');
      setReport(null);
    }
    setRunning(false);
  };

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `quoted-margin-${report.range.start}-to-${report.range.end}.csv`,
      ['Estimate', 'Customer', 'Total', 'Parts Margin %', 'Floor %', 'Below Floor', 'Reason', 'Sent By', 'Frozen At'],
      report.belowFloor.map(r => [
        r.number, r.customer, r.total, r.marginPct ?? '', r.floorPct ?? '', 'yes',
        r.reason || '', r.senderName, r.frozenAt.slice(0, 10),
      ]),
    );
  };

  const tile = (label: string, value: string, sub: string, color: string) => (
    <div style={{ flex: '1 1 150px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
      <div style={{ fontSize: '20px', fontWeight: 900, color }}>{value}</div>
      <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{sub}</div>
    </div>
  );

  const cell: React.CSSProperties = { padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: '12.5px' };
  const th: React.CSSProperties = { padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'left' };
  const tableWrap: React.CSSProperties = { overflowX: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', marginBottom: '14px' };

  const rollupTable = (title: string, rows: ({ name: string } & Rollup)[]) => (
    <div style={tableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>{title}</th>
            <th style={{ ...th, textAlign: 'right' }}>Quotes</th>
            <th style={{ ...th, textAlign: 'right' }}>Quoted $</th>
            <th style={{ ...th, textAlign: 'right' }}>Parts margin (wtd)</th>
            <th style={{ ...th, textAlign: 'right' }}>Below floor</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name}>
              <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{r.name}</td>
              <td style={{ ...cell, textAlign: 'right' }}>{r.count}</td>
              <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.value)}</td>
              <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmtPct(r.weightedMarginPct)}</td>
              <td style={{ ...cell, textAlign: 'right', color: r.belowFloor > 0 ? '#ef4444' : 'var(--text-muted)', fontWeight: r.belowFloor > 0 ? 800 : 400 }}>{r.belowFloor || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const totalCount = report ? report.totals.count : 0;

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Quoted Margin</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        The margin we offered, frozen at each estimate send — by rep, customer, and month, with every below-floor send and its typed reason.
        Margin % is the parts margin over costed lines; quotes with no costed lines count as unknown, never 100%.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
        <input type="date" value={start} onChange={e => setStart(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
        <span style={{ color: 'var(--text-muted)' }}>to</span>
        <input type="date" value={end} onChange={e => setEnd(e.target.value)}
          style={{ padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' }} />
        <button onClick={run} disabled={running}
          style={{ padding: '9px 16px', borderRadius: '8px', border: 'none', background: '#3b82f6', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', opacity: running ? 0.6 : 1 }}>
          {running ? 'Running…' : 'Run report'}
        </button>
        {report && report.belowFloor.length > 0 && (
          <button onClick={exportCsv}
            style={{ padding: '9px 16px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
            Export below-floor CSV
          </button>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}

      {report && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {tile('Quotes frozen', String(report.totals.count), 'sends with a margin snapshot', 'var(--text-primary)')}
            {tile('Quoted value', fmtMoney(report.totals.value), 'grand totals at send', '#60a5fa')}
            {tile('Blended parts margin', fmtPct(report.totals.weightedMarginPct), 'value-weighted', '#22c55e')}
            {tile('Below floor', String(report.totals.belowFloor), `${fmtMoney(report.totals.belowFloorValue)} · floor now ${report.currentFloor}%`, report.totals.belowFloor > 0 ? '#ef4444' : 'var(--text-muted)')}
            {tile('Unknown margin', String(report.totals.unknownMargin), 'no costed lines', 'var(--text-muted)')}
          </div>

          {/* Distribution vs each row's own frozen floor */}
          {totalCount > 0 && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px', marginBottom: '14px' }}>
              <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' }}>Distribution vs the floor</div>
              <div style={{ display: 'flex', height: '14px', borderRadius: '7px', overflow: 'hidden', marginBottom: '8px' }}>
                {BUCKETS.map(b => {
                  const w = (report.distribution[b.key].count / totalCount) * 100;
                  return w > 0 ? <div key={b.key} style={{ width: `${w}%`, background: b.color }} title={`${b.label}: ${report.distribution[b.key].count}`} /> : null;
                })}
              </div>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontSize: '11px' }}>
                {BUCKETS.map(b => (
                  <span key={b.key} style={{ color: 'var(--text-secondary)' }}>
                    <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px', background: b.color, marginRight: '5px' }} />
                    {b.label}: <b>{report.distribution[b.key].count}</b> ({fmtMoney(report.distribution[b.key].value)})
                  </span>
                ))}
              </div>
            </div>
          )}

          {report.byMonth.length > 1 && (
            <div style={tableWrap}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Month</th>
                    <th style={{ ...th, textAlign: 'right' }}>Quotes</th>
                    <th style={{ ...th, textAlign: 'right' }}>Quoted $</th>
                    <th style={{ ...th, textAlign: 'right' }}>Parts margin (wtd)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byMonth.map(m => (
                    <tr key={m.month}>
                      <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{m.month}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{m.count}</td>
                      <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(m.value)}</td>
                      <td style={{ ...cell, textAlign: 'right', fontWeight: 700 }}>{fmtPct(m.weightedMarginPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {rollupTable('Rep', report.byRep.map(r => ({ ...r, name: r.repName })))}
          {rollupTable('Customer (top 20 by value)', report.byCustomer.map(c => ({ ...c, name: c.customer })))}

          <div style={{ fontSize: '13px', fontWeight: 800, margin: '4px 0 8px' }}>Below-floor sends</div>
          {report.belowFloor.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>None in this range — every send met the floor.</div>
          ) : (
            <div style={tableWrap}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={th}>Estimate</th>
                    <th style={th}>Customer</th>
                    <th style={{ ...th, textAlign: 'right' }}>Total</th>
                    <th style={{ ...th, textAlign: 'right' }}>Margin / floor</th>
                    <th style={th}>Reason</th>
                    <th style={th}>Who · when</th>
                  </tr>
                </thead>
                <tbody>
                  {report.belowFloor.map(r => (
                    <tr key={r.id} onClick={() => router.push(deepLinks.estimate(r.id))} style={{ cursor: 'pointer' }} title="Open this estimate">
                      <td style={{ ...cell, fontWeight: 700, color: '#60a5fa' }}>{r.number}</td>
                      <td style={{ ...cell, color: 'var(--text-secondary)' }}>{r.customer}</td>
                      <td style={{ ...cell, textAlign: 'right' }}>{fmtMoney(r.total)}</td>
                      <td style={{ ...cell, textAlign: 'right', color: '#ef4444', fontWeight: 800 }}>{fmtPct(r.marginPct)} / {fmtPct(r.floorPct)}</td>
                      <td style={{ ...cell, color: 'var(--text-muted)', maxWidth: '300px' }}>{r.reason || '—'}</td>
                      <td style={{ ...cell, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.senderName} · {r.frozenAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
            Snapshots exist from the day the freeze shipped — older sends have no frozen margin and don&apos;t appear here.
            A re-send overwrites the snapshot: the numbers always describe the version the customer last received.
          </div>
        </>
      )}
    </div>
  );
}
