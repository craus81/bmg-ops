'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { downloadCsv } from '@/lib/csv';

interface JobRow {
  id: string;
  jobNumber: string | null;
  title: string;
  status: string;
  category: string | null;
  createdAt: string;
  invoicedAt: string | null;
  invoiceNumber: string | null;
  revenue: number | null;
  materialCost: number;
  materialSqft: number;
  materialEntries: number;
  margin: number | null;
}

interface MaterialRow { name: string; category: string; sqft: number; cost: number; entries: number }

interface Report {
  range: { start: string; end: string };
  totals: { jobs: number; jobsWithMaterials: number; jobsInvoiced: number; revenue: number; materialCost: number; materialSqft: number; margin: number };
  perMaterial: MaterialRow[];
  jobs: JobRow[];
}

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export default function GraphicsCostsPage() {
  const router = useRouter();
  const { isAdmin, isSales, isGraphicsProduction, loading: authLoading } = useAuth();

  const [start, setStart] = useState(() => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyLogged, setOnlyLogged] = useState(true);

  const run = useCallback(async (s: string, e: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/graphics-costs?start=${s}&end=${e}`);
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
    if (!isAdmin && !isSales && !isGraphicsProduction) { router.push('/home'); return; }
    run(start, end);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after auth resolves
  }, [authLoading, isAdmin, isSales, isGraphicsProduction, router]);

  const visibleJobs = (report?.jobs || []).filter(j => !onlyLogged || j.materialEntries > 0 || j.revenue != null);

  const exportCsv = () => {
    if (!report) return;
    downloadCsv(
      `graphics-costs-${report.range.start}-to-${report.range.end}.csv`,
      ['Job #', 'Title', 'Status', 'Created', 'Invoice #', 'Revenue', 'Material ft²', 'Material Cost', 'Margin'],
      visibleJobs.map(j => [
        j.jobNumber, j.title, j.status, j.createdAt?.slice(0, 10), j.invoiceNumber,
        j.revenue != null ? Math.round(j.revenue) : '', Math.round(j.materialSqft), j.materialCost.toFixed(2),
        j.margin != null ? Math.round(j.margin) : '',
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
        <div style={{ fontSize: '20px', fontWeight: 800 }}>Graphics Costs — Revenue vs Material</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Invoiced revenue minus logged vinyl/laminate cost per graphics job. Material gets logged from the job card — the app prompts when a job moves past printing.
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
        {report && (
          <button onClick={exportCsv} style={{ padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', cursor: 'pointer' }}>
            Export CSV
          </button>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyLogged} onChange={e => setOnlyLogged(e.target.checked)} style={{ width: '15px', height: '15px' }} />
          Only jobs with materials or an invoice
        </label>
      </div>

      {error && <div style={{ padding: '12px', borderRadius: '10px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: '12px', marginBottom: '14px' }}>{error}</div>}

      {t && !loading && !error && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {[
            { label: 'Invoiced revenue', value: fmtMoney(t.revenue), sub: `${t.jobsInvoiced} jobs`, color: '#22c55e' },
            { label: 'Material cost', value: fmtMoney(t.materialCost), sub: `${t.materialSqft.toFixed(0)} ft² across ${t.jobsWithMaterials} jobs`, color: '#f472b6' },
            { label: 'Margin (rev − material)', value: fmtMoney(t.margin), sub: t.revenue > 0 ? `${Math.round((t.margin / t.revenue) * 100)}% of revenue` : '—', color: '#60a5fa' },
            { label: 'Jobs in range', value: String(t.jobs), sub: `${t.jobsWithMaterials} with materials logged`, color: 'var(--text-muted)' },
          ].map(tile => (
            <div key={tile.label} style={{ padding: '12px', borderRadius: '10px', background: 'var(--card)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{tile.label}</div>
              <div style={{ fontSize: '18px', fontWeight: 800, color: tile.color, marginTop: '2px' }}>{tile.value}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{tile.sub}</div>
            </div>
          ))}
        </div>
      )}

      {report && !loading && report.perMaterial.length > 0 && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '6px' }}>
            Material usage (buying signal)
          </div>
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  <th style={{ ...cell, textAlign: 'left' }}>Material</th>
                  <th style={{ ...cell, textAlign: 'left' }}>Type</th>
                  <th style={{ ...cell, textAlign: 'right' }}>ft² Used</th>
                  <th style={{ ...cell, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...cell, textAlign: 'right' }}>Entries</th>
                </tr>
              </thead>
              <tbody>
                {report.perMaterial.map(m => (
                  <tr key={m.name}>
                    <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>{m.name}</td>
                    <td style={{ ...cell, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '10px' }}>{m.category}</td>
                    <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{m.sqft.toFixed(0)}</td>
                    <td style={{ ...cell, textAlign: 'right', fontWeight: 700, color: '#f472b6' }}>{fmtMoney(m.cost)}</td>
                    <td style={{ ...cell, textAlign: 'right', color: 'var(--text-muted)' }}>{m.entries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && visibleJobs.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ fontSize: '10px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                <th style={{ ...cell, textAlign: 'left' }}>Job</th>
                <th style={{ ...cell, textAlign: 'left' }}>Status</th>
                <th style={{ ...cell, textAlign: 'right' }}>Revenue</th>
                <th style={{ ...cell, textAlign: 'right' }}>Material ft²</th>
                <th style={{ ...cell, textAlign: 'right' }}>Material $</th>
                <th style={{ ...cell, textAlign: 'right' }}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {visibleJobs.map(j => (
                <tr key={j.id}>
                  <td style={{ ...cell, fontWeight: 700, color: 'var(--text-primary)' }}>
                    {j.jobNumber || '—'}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: '6px', fontSize: '10px' }}>{j.title}</span>
                  </td>
                  <td style={{ ...cell, color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase' }}>{j.status}</td>
                  <td style={{ ...cell, textAlign: 'right', color: j.revenue != null ? '#22c55e' : 'var(--text-muted)' }}>{j.revenue != null ? fmtMoney(j.revenue) : 'not invoiced'}</td>
                  <td style={{ ...cell, textAlign: 'right', color: 'var(--text-secondary)' }}>{j.materialSqft > 0 ? j.materialSqft.toFixed(0) : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right', color: '#f472b6' }}>{j.materialEntries > 0 ? fmtMoney(j.materialCost) : '—'}</td>
                  <td style={{ ...cell, textAlign: 'right', fontWeight: 700, color: j.margin == null ? 'var(--text-muted)' : j.margin < 0 ? '#ef4444' : '#60a5fa' }}>
                    {j.margin != null ? fmtMoney(j.margin) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
