'use client';

// Admin → Vendor Costs (migration 353, owner ask 2026-10-08). Upload the
// spreadsheet of outsourced part numbers (part number, vendor cost, target
// margin, vendor) and load it onto the parts catalog. FleetSuite only: the
// numbers never go to NetSuite and sales prices stay whatever was quoted;
// the part page shows the margin as a reference next to the price.
// Re-upload whenever costs change; a blank cell keeps what the part has.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import { parseVendorCostFile, type VendorCostResult, type VendorCostRow } from '@/lib/vendor-cost-import';
import { marginPct, priceForMargin } from '@/lib/pricing-request';

type Tab = 'update' | 'same' | 'not_found' | 'problems';

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px',
};
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

export default function VendorCostsPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<VendorCostRow[]>([]);
  const [results, setResults] = useState<VendorCostResult[] | null>(null);
  const [tab, setTab] = useState<Tab>('update');
  const [busy, setBusy] = useState<'' | 'reading' | 'checking' | 'saving'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!authLoading && !isAdmin) router.push('/home');
  }, [authLoading, isAdmin, router]);

  const problems = useMemo(() => parsed.filter(r => r.problem), [parsed]);
  const good = useMemo(() => parsed.filter(r => !r.problem), [parsed]);

  const send = async (apply: boolean, rows: VendorCostRow[] = good) => {
    const res = await apiFetch('/api/parts/vendor-costs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apply,
        rows: rows.map(r => ({ partNumber: r.partNumber, vendor: r.vendor, vendorCost: r.vendorCost, marginPct: r.marginPct })),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    return json;
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(''); setDone(''); setResults(null); setParsed([]);
    setFileName(file.name);
    setBusy('reading');
    try {
      const out = await parseVendorCostFile(file);
      if (out.error) { setError(out.error); return; }
      setParsed(out.rows);
      if (out.rows.every(r => r.problem)) {
        setTab('problems');
        if (out.rows.length === 0) setError('No part numbers found under the header row.');
        return;
      }
      setBusy('checking');
      const json = await send(false, out.rows.filter(r => !r.problem));
      setResults(json.results);
      setTab((json.results as VendorCostResult[]).some(r => r.status === 'update') ? 'update' : 'not_found');
    } catch (e: any) {
      setError(e?.message || 'Couldn’t read that file.');
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    setBusy('saving'); setError('');
    try {
      const json = await send(true);
      setResults(json.results);
      const failed = (json.failed || []) as { partNumber: string; error: string }[];
      setDone(failed.length
        ? `Saved ${json.updated} part${json.updated === 1 ? '' : 's'}. ${failed.length} failed: ${failed.slice(0, 5).map(f => f.partNumber).join(', ')}${failed.length > 5 ? '…' : ''}`
        : `Saved vendor costs on ${json.updated} part${json.updated === 1 ? '' : 's'}.`);
      // Re-check so the list shows the saved state.
      const after = await send(false);
      setResults(after.results);
      setTab('update');
    } catch (e: any) {
      setError(e?.message || 'Save failed.');
    } finally {
      setBusy('');
    }
  };

  const counts = {
    update: results?.filter(r => r.status === 'update').length || 0,
    same: results?.filter(r => r.status === 'same').length || 0,
    not_found: results?.filter(r => r.status === 'not_found').length || 0,
    problems: problems.length,
  };
  const shown = tab === 'problems' ? [] : (results || []).filter(r => r.status === tab);

  if (authLoading || !isAdmin) return null;

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Vendor Costs</h1>
        <div style={muted}>
          Upload a spreadsheet of outsourced part numbers to load each part’s vendor cost and target margin. These stay in
          FleetSuite (not NetSuite) and don’t change any sales price.
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: '13px', marginBottom: '8px' }}>
          Columns: <b>Part Number</b>, <b>Vendor Cost</b>, <b>Margin</b> (35%, 35 or 0.35 all mean 35%), and optionally <b>Vendor</b>.
          Any order, extra columns are ignored. A blank cell keeps what the part already has.
        </div>
        <label style={{
          display: 'inline-block', padding: '10px 16px', borderRadius: '10px', background: theme.accent, color: '#fff',
          fontWeight: 700, fontSize: '14px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
        }}>
          {busy === 'reading' ? 'Reading…' : busy === 'checking' ? 'Checking the catalog…' : 'Choose spreadsheet'}
          <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" style={{ display: 'none' }} disabled={!!busy}
            onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {fileName && <span style={{ ...muted, marginLeft: '10px' }}>{fileName} · {parsed.length} row{parsed.length === 1 ? '' : 's'}</span>}
      </div>

      {error && <div style={{ ...card, borderColor: theme.errorBorder, background: theme.errorBg, color: theme.error, fontSize: '13px' }}>{error}</div>}
      {done && <div style={{ ...card, borderColor: theme.successBorder, background: theme.successBg, color: theme.success, fontSize: '13px' }}>{done}</div>}

      {(results || problems.length > 0) && (
        <>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {([
              ['update', 'Will update'],
              ['same', 'No change'],
              ['not_found', 'Not in catalog'],
              ['problems', 'Problems'],
            ] as [Tab, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} style={{
                padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${tab === k ? theme.accent : 'var(--border)'}`,
                background: tab === k ? theme.accent : 'var(--card)', color: tab === k ? '#fff' : 'var(--text-secondary)',
              }}>{label} · {counts[k]}</button>
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={save} disabled={!!busy || counts.update === 0} style={{
              padding: '8px 16px', borderRadius: '10px', border: 'none', fontWeight: 800, fontSize: '13px',
              background: counts.update ? theme.accent : 'var(--border)', color: '#fff',
              cursor: busy || !counts.update ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            }}>
              {busy === 'saving' ? 'Saving…' : `Save ${counts.update} part${counts.update === 1 ? '' : 's'}`}
            </button>
          </div>

          {tab === 'not_found' && counts.not_found > 0 && (
            <div style={muted}>These part numbers aren’t in the catalog, so they’ll be skipped. Check for typos or a missing 02/06 prefix.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {tab === 'problems' && problems.map(r => (
              <div key={`${r.line}-${r.partNumber}`} style={{ ...card, padding: '10px 12px', fontSize: '13px' }}>
                <b>Row {r.line} · {r.partNumber}</b>
                <div style={{ color: theme.warning }}>{r.problem}</div>
              </div>
            ))}
            {shown.map(r => {
              const targetPrice = priceForMargin(r.next.vendorCost, r.next.marginPct);
              const earns = marginPct(r.salesPrice, r.next.vendorCost);
              return (
                <div key={r.partNumber} style={{ ...card, padding: '10px 12px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                    <b>{r.partNumber}</b>
                    <span style={muted}>{r.displayName || ''}{r.partIds.length > 1 ? ` · ${r.partIds.length} catalog rows` : ''}</span>
                  </div>
                  {r.status !== 'not_found' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '4px 12px', marginTop: '4px' }}>
                      <Change label="Vendor cost" from={fmtMoney(r.current?.vendorCost)} to={fmtMoney(r.next.vendorCost)} />
                      <Change label="Target margin" from={fmtPct(r.current?.marginPct)} to={fmtPct(r.next.marginPct)} />
                      <Change label="Vendor" from={r.current?.vendor || '—'} to={r.next.vendor || '—'} />
                      <div>
                        <div style={muted}>Sales price</div>
                        <div>
                          {fmtMoney(r.salesPrice)}
                          {earns != null && <span style={{ ...muted, marginLeft: '6px' }}>earns {earns}%</span>}
                          {targetPrice != null && <span style={{ ...muted, marginLeft: '6px' }}>· target {fmtMoney(targetPrice)}</span>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {tab !== 'problems' && shown.length === 0 && <div style={muted}>Nothing here.</div>}
          </div>
        </>
      )}
    </div>
  );
}

function Change({ label, from, to }: { label: string; from: string; to: string }) {
  const changed = from !== to;
  return (
    <div>
      <div style={muted}>{label}</div>
      <div>
        {changed && from !== '—' && <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: '6px' }}>{from}</span>}
        <span style={{ fontWeight: changed ? 700 : 400 }}>{to}</span>
      </div>
    </div>
  );
}
