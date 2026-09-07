'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';

/**
 * Per-vehicle job margin (R3-19): each invoiced vehicle end to end —
 * invoice revenue vs the parts bought for its project and the installer's
 * bill for its VIN. Labor lights up when R3-21 lands.
 */

interface VehicleRow {
  checkinId: string;
  vin: string | null;
  label: string;
  customer: string | null;
  soNumber: string | null;
  invoiceNumbers: string[];
  dateInvoiced: string | null;
  revenue: number;
  partsPo: number;
  partsPoNumbers: string[];
  partsStock: number;
  partsUnpriced: number;
  installer: number;
  labor: number | null;
  margin: number;
}
interface Report {
  range: { start: string; end: string };
  vehicles: VehicleRow[];
  totals: { vehicles: number; revenue: number; parts: number; installer: number; margin: number };
  meta: { netsuiteError?: string; netsuiteCapped?: { lookedUp: number; of: number }; laborNote?: string };
}

const toDateStr = (d: Date) => d.toISOString().split('T')[0];
const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function VehicleMarginPage() {
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
      const res = await fetch(`/api/reports/vehicle-margin?start=${start}&end=${end}`);
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
      `vehicle-margin-${report.range.start}-to-${report.range.end}.csv`,
      ['Vehicle', 'VIN', 'Customer', 'SO', 'Invoices', 'Invoiced', 'Revenue', 'Parts (PO)', 'POs', 'Parts (stock est.)', 'Installer', 'Margin'],
      report.vehicles.map(v => [
        v.label, v.vin || '', v.customer || '', v.soNumber || '', v.invoiceNumbers.join(' '),
        v.dateInvoiced || '', v.revenue, v.partsPo, v.partsPoNumbers.join(' '), v.partsStock, v.installer, v.margin,
      ]),
    );
  };

  const tile = (label: string, value: string, color: string) => (
    <div style={{ flex: '1 1 150px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 14px' }}>
      <div style={{ fontSize: '20px', fontWeight: 900, color }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: '1100px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '4px' }}>Vehicle Job Margin</h1>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Each invoiced vehicle end to end: invoice revenue vs parts bought for its project and the installer&apos;s bill for its VIN.
        Shop labor isn&apos;t captured per vehicle yet — margin excludes it.
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
        {report && (
          <button onClick={exportCsv}
            style={{ padding: '9px 16px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
            Export CSV
          </button>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}

      {report && (
        <>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' }}>
            {tile('Vehicles', String(report.totals.vehicles), 'var(--text-primary)')}
            {tile('Revenue', fmtMoney(report.totals.revenue), '#22c55e')}
            {tile('Parts', fmtMoney(report.totals.parts), '#f59e0b')}
            {tile('Installer', fmtMoney(report.totals.installer), '#8b5cf6')}
            {tile('Margin', fmtMoney(report.totals.margin), report.totals.margin >= 0 ? '#22c55e' : '#ef4444')}
          </div>

          {(report.meta.netsuiteError || report.meta.netsuiteCapped) && (
            <div style={{ fontSize: '12px', color: '#f59e0b', marginBottom: '10px' }}>
              {report.meta.netsuiteError
                ? `NetSuite revenue lookup failed (${report.meta.netsuiteError}) — revenue shows 0 for affected vehicles.`
                : `Revenue looked up for the first ${report.meta.netsuiteCapped!.lookedUp} of ${report.meta.netsuiteCapped!.of} invoices — narrow the date range for full coverage.`}
            </div>
          )}

          <div style={{ overflowX: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>
                  {['Vehicle', 'Customer', 'Invoices', 'Invoiced', 'Revenue', 'Parts (PO)', 'Parts (stock est.)', 'Installer', 'Labor', 'Margin'].map(h => (
                    <th key={h} style={{ padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.vehicles.map(v => (
                  <tr key={v.checkinId} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ fontWeight: 700 }}>{v.label}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace' }}>{v.vin || ''}{v.soNumber ? ` · SO ${v.soNumber}` : ''}</div>
                    </td>
                    <td style={{ padding: '8px 12px' }}>{v.customer || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{v.invoiceNumbers.join(', ') || '—'}</td>
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{v.dateInvoiced || '—'}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{fmtMoney(v.revenue)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} title={v.partsPoNumbers.length ? `POs: ${v.partsPoNumbers.join(', ')}` : undefined}>
                      {fmtMoney(v.partsPo)}{v.partsPoNumbers.length > 0 ? ` (${v.partsPoNumbers.length})` : ''}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }} title={v.partsUnpriced > 0 ? `${v.partsUnpriced} allocated part(s) have no synced cost` : undefined}>
                      {fmtMoney(v.partsStock)}{v.partsUnpriced > 0 ? ' *' : ''}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmtMoney(v.installer)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>—</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: v.margin >= 0 ? '#22c55e' : '#ef4444' }}>{fmtMoney(v.margin)}</td>
                  </tr>
                ))}
                {report.vehicles.length === 0 && (
                  <tr><td colSpan={10} style={{ padding: '14px', color: 'var(--text-muted)', textAlign: 'center' }}>No vehicles were invoiced in this range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            * some allocated parts have no synced cost and aren&apos;t priced into the stock estimate. Labor lands when per-vehicle labor capture ships.
          </div>
        </>
      )}
    </div>
  );
}
