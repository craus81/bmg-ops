'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';

interface ReportLine {
  invoiceId: string;
  invoiceNumber: string | null;
  date: string;
  vendor: string;
  location: string;
  vin: string;
  partNumber: string | null;
  paid: number | null;
  invoiced: number | null;
  invoicedSource: 'po_price' | 'catalog_price' | null;
}

interface Rollup { key: string; vins: number; paid: number; invoiced: number; unpriced: number; margin: number }

interface ReportData {
  range: { start: string; end: string };
  lines: ReportLine[];
  perVendor: Rollup[];
  perLocation: Rollup[];
  perPart: Rollup[];
  totals: { vins: number; paid: number; invoiced: number; margin: number; unpriced: number };
}

const toDateStr = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function InstallerCostsReportPage() {
  const router = useRouter();
  const { user, isAdmin, isSales } = useAuth();

  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 89); return toDateStr(d); });
  const [end, setEnd] = useState(() => toDateStr(new Date()));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<ReportData | null>(null);

  useEffect(() => {
    if (!user) return;
    if (!isAdmin && !isSales) router.push('/home');
  }, [user, isAdmin, isSales, router]);

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/reports/installer-costs?start=${start}&end=${end}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const exportCsv = () => {
    if (!data) return;
    const headers = ['Date', 'Installer', 'Invoice #', 'Location', 'VIN', 'Part', 'Paid', 'Est. Invoiced', 'Est. Margin', 'Revenue Source'];
    const rows = data.lines.map(l => [
      l.date, l.vendor, l.invoiceNumber || '', l.location, l.vin, l.partNumber || '',
      l.paid != null ? l.paid.toFixed(2) : '', l.invoiced != null ? l.invoiced.toFixed(2) : '',
      l.paid != null && l.invoiced != null ? (l.invoiced - l.paid).toFixed(2) : '',
      l.invoicedSource === 'po_price' ? 'PO unit price' : l.invoicedSource === 'catalog_price' ? 'Catalog price' : '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `installer-costs-${start}-to-${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const rollupTable = (title: string, rows: Rollup[]) => (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', flex: 1, minWidth: '280px' }}>
      <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>{title}</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr>
              {['', 'VINs', 'Paid', 'Est. Invoiced', 'Est. Margin'].map(h => (
                <th key={h} style={{ textAlign: h ? 'right' : 'left', padding: '4px 6px', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td style={{ padding: '4px 6px', fontWeight: 700, color: 'var(--text-primary)' }}>{r.key}{r.unpriced > 0 ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> ({r.unpriced} unpriced)</span> : ''}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-secondary)' }}>{r.vins}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', color: '#f472b6', fontWeight: 700 }}>{fmtMoney(r.paid)}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtMoney(r.invoiced)}</td>
                <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700, color: r.margin >= 0 ? '#22c55e' : '#ef4444' }}>{fmtMoney(r.margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Installer Cost vs Invoiced</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          What we paid CNI installers per VIN (from recorded vendor invoices) against what we invoice the customer. Revenue is an estimate — the PO line&apos;s unit price when the scan is PO-matched, otherwise the part&apos;s catalog sales price.
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', marginBottom: '14px', display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>From</div>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
        </div>
        <div>
          <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '3px' }}>To</div>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={{ padding: '8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px' }} />
        </div>
        <button onClick={run} disabled={loading} style={{ padding: '9px 18px', borderRadius: '8px', fontSize: '12px', fontWeight: 800, background: '#f472b6', color: '#fff', border: 'none', cursor: 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? 'Running…' : 'Run report'}
        </button>
        {data && data.lines.length > 0 && (
          <button onClick={exportCsv} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>
            ⬇ Export CSV ({data.lines.length})
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', fontWeight: 600 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Summary */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
            {[
              { label: 'VINs', value: String(data.totals.vins), color: 'var(--text-primary)' },
              { label: 'Paid to Installers', value: fmtMoney(data.totals.paid), color: '#f472b6' },
              { label: 'Est. Invoiced', value: fmtMoney(data.totals.invoiced), color: '#60a5fa' },
              { label: 'Est. Margin', value: fmtMoney(data.totals.margin), color: data.totals.margin >= 0 ? '#22c55e' : '#ef4444' },
            ].map(s => (
              <div key={s.label} style={{ flex: 1, minWidth: '130px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: '18px', fontWeight: 800, color: s.color }}>{s.value}</div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginTop: '2px' }}>{s.label}</div>
              </div>
            ))}
          </div>
          {data.totals.unpriced > 0 && (
            <div style={{ padding: '8px 12px', borderRadius: '8px', marginBottom: '12px', background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)', color: '#fbbf24', fontSize: '11px', fontWeight: 600 }}>
              {data.totals.unpriced} VIN{data.totals.unpriced !== 1 ? 's have' : ' has'} no per-VIN price on the vendor invoice — they count toward VINs but not toward Paid.
            </div>
          )}

          {/* Rollups */}
          <div style={{ display: 'flex', gap: '10px', marginBottom: '14px', flexWrap: 'wrap' }}>
            {rollupTable('By Location', data.perLocation)}
            {rollupTable('By Installer', data.perVendor)}
          </div>
          <div style={{ marginBottom: '14px' }}>
            {rollupTable('By Part Number', data.perPart)}
          </div>

          {/* Detail lines */}
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '8px' }}>Detail ({data.lines.length} lines)</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr>
                    {['Date', 'Installer', 'Inv #', 'Location', 'VIN', 'Part', 'Paid', 'Est. Invoiced'].map(h => (
                      <th key={h} style={{ textAlign: ['Paid', 'Est. Invoiced'].includes(h) ? 'right' : 'left', padding: '4px 6px', fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l, i) => (
                    <tr key={i} style={{ background: i % 2 ? 'var(--subtle-bg)' : 'transparent' }}>
                      <td style={{ padding: '4px 6px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{l.date}</td>
                      <td style={{ padding: '4px 6px', fontWeight: 700, color: 'var(--text-primary)' }}>{l.vendor}</td>
                      <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{l.invoiceNumber || '—'}</td>
                      <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{l.location}</td>
                      <td style={{ padding: '4px 6px', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{l.vin}</td>
                      <td style={{ padding: '4px 6px', color: 'var(--text-secondary)' }}>{l.partNumber || '—'}</td>
                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700, color: '#f472b6' }}>{l.paid != null ? fmtMoney(l.paid) : '—'}</td>
                      <td title={l.invoicedSource === 'po_price' ? 'PO unit price' : l.invoicedSource === 'catalog_price' ? 'Catalog sales price' : ''} style={{ padding: '4px 6px', textAlign: 'right', color: 'var(--text-secondary)' }}>
                        {l.invoiced != null ? fmtMoney(l.invoiced) : '—'}
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
