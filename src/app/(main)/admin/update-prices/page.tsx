'use client';

// Admin → Update Prices (migration 513, owner ask 2026-11-03). Two jobs:
//   * Upload prices: a spreadsheet (or pasted rows) of part numbers with a new
//     selling price, a new cost, or both. Preview what changes, then Save
//     updates FleetSuite and sends each part to NetSuite so the two match.
//     "Fill cost as price minus X%" fills a cost only where the file has none.
//   * Prices that don't match: parts whose NetSuite price isn't FleetSuite's
//     (nightly check, or Check now). Send FleetSuite's to NetSuite, or use
//     NetSuite's when someone changed it there on purpose.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  fillCostsFromDiscount, parsePastedPrices, parsePriceFile,
  type PriceUpdateResult, type PriceUpdateRow,
} from '@/lib/price-update-import';

type View = 'upload' | 'mismatch';
type Filter = 'change' | 'same' | 'not_found' | 'problems';

interface MismatchItem {
  partId: string;
  partNumber: string;
  displayName: string | null;
  fleetsuitePrice: number | null;
  netsuitePrice: number | null;
  reason: string | null;
  firstSeenAt: string;
}

const card: React.CSSProperties = {
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '14px',
};
const muted: React.CSSProperties = { fontSize: '12px', color: 'var(--text-muted)' };
const errorBox: React.CSSProperties = { ...card, borderColor: theme.errorBorder, background: theme.errorBg, color: theme.error, fontSize: '13px', fontWeight: 600 };
const doneBox: React.CSSProperties = { ...card, borderColor: theme.successBorder, background: theme.successBg, color: theme.success, fontSize: '13px', fontWeight: 600 };
const greenBtn = (on: boolean): React.CSSProperties => ({
  padding: '9px 16px', borderRadius: '10px', border: 'none', fontWeight: 800, fontSize: '13px',
  background: on ? theme.success : 'var(--border)', color: '#fff', cursor: on ? 'pointer' : 'default',
});
const plainBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)',
  color: 'var(--text-primary)', fontWeight: 700, fontSize: '12px', cursor: 'pointer',
};

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function post(url: string, body: unknown) {
  const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

export default function UpdatePricesPage() {
  const router = useRouter();
  const { isAdmin, loading: authLoading } = useAuth();
  const [view, setView] = useState<View>('upload');
  const [flashPart, setFlashPart] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !isAdmin) router.push('/home');
  }, [authLoading, isAdmin, router]);

  // Deep link: ?tab=mismatch&part=<id> (deepLinks.priceMismatches).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('tab') === 'mismatch') setView('mismatch');
    if (q.get('part')) setFlashPart(q.get('part'));
  }, []);

  if (authLoading || !isAdmin) return null;

  return (
    <div style={{ padding: '16px', maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div>
        <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>Update Prices</h1>
        <div style={muted}>Change selling prices and costs for many parts at once. FleetSuite saves them and sends them to NetSuite.</div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {([['upload', 'Upload prices'], ['mismatch', 'Prices that don’t match']] as [View, string][]).map(([k, label]) => (
          <button key={k} onClick={() => setView(k)} style={{
            padding: '7px 14px', borderRadius: '999px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
            border: `1px solid ${view === k ? theme.accent : 'var(--border)'}`,
            background: view === k ? theme.accent : 'var(--card)', color: view === k ? '#fff' : 'var(--text-secondary)',
          }}>{label}</button>
        ))}
      </div>
      {view === 'upload' ? <UploadPrices onShowMismatches={() => setView('mismatch')} /> : <Mismatches flashPart={flashPart} />}
    </div>
  );
}

function UploadPrices({ onShowMismatches }: { onShowMismatches: () => void }) {
  const [source, setSource] = useState('');
  const [rawRows, setRawRows] = useState<PriceUpdateRow[]>([]);
  const [discount, setDiscount] = useState('');
  const [results, setResults] = useState<PriceUpdateResult[] | null>(null);
  const [filter, setFilter] = useState<Filter>('change');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [problemsAfterSave, setProblemsAfterSave] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);

  const discountPct = discount.trim() === '' ? null : Number(discount);
  const rows = useMemo(() => fillCostsFromDiscount(rawRows, discountPct), [rawRows, discountPct]);
  const problems = rows.filter(r => r.problem);
  const good = rows.filter(r => !r.problem);
  const goodKey = good.map(r => `${r.partNumber}:${r.price}:${r.cost}`).join('|');

  // Preview again whenever the rows (or the discount fill) change.
  useEffect(() => {
    if (good.length === 0) { setResults(null); return; }
    let stale = false;
    setBusy('Checking the catalog…');
    post('/api/parts/update-prices', { apply: false, rows: good.map(r => ({ partNumber: r.partNumber, price: r.price, cost: r.cost })) })
      .then(json => {
        if (stale) return;
        setResults(json.results);
        setFilter(f => (f === 'problems' ? f : (json.results as PriceUpdateResult[]).some(r => r.status === 'change') ? 'change' : 'not_found'));
      })
      .catch(e => { if (!stale) setError(e?.message || 'Couldn’t check the catalog.'); })
      .finally(() => { if (!stale) setBusy(''); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goodKey]);

  const load = (out: { rows: PriceUpdateRow[]; error: string | null }, name: string) => {
    setError(''); setDone(''); setProblemsAfterSave([]); setResults(null);
    setSource(name);
    if (out.error) { setRawRows([]); setError(out.error); return; }
    if (out.rows.length === 0) { setRawRows([]); setError('No part numbers found under the header row.'); return; }
    setRawRows(out.rows);
    if (out.rows.every(r => r.problem)) setFilter('problems');
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy('Reading…');
    try {
      load(await parsePriceFile(file), file.name);
    } catch (e: any) {
      setError(e?.message || 'Couldn’t read that file.');
    } finally {
      setBusy('');
    }
  };

  const onPaste = useCallback((text: string) => {
    if (!text.trim()) return;
    load(parsePastedPrices(text), 'Pasted rows');
  }, []);

  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const text = e.clipboardData?.getData('text/plain') || '';
      if (text.includes('\n')) { e.preventDefault(); onPaste(text); }
    };
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [onPaste]);

  const toChange = (results || []).filter(r => r.status === 'change');

  const save = async () => {
    setError(''); setDone(''); setProblemsAfterSave([]);
    const byNumber = new Map(good.map(r => [r.partNumber, r]));
    const send = toChange.map(r => byNumber.get(r.partNumber)!).filter(Boolean);
    const saved = new Map<string, PriceUpdateResult>();
    const failures: string[] = [];
    try {
      for (let i = 0; i < send.length; i += 20) {
        setBusy(`Saving ${Math.min(i + 20, send.length)} of ${send.length}…`);
        const json = await post('/api/parts/update-prices', {
          apply: true,
          rows: send.slice(i, i + 20).map(r => ({ partNumber: r.partNumber, price: r.price, cost: r.cost })),
        });
        (json.results as PriceUpdateResult[]).forEach(r => { if (r.saved) saved.set(r.partNumber, r); });
        (json.failed || []).forEach((f: { partNumber: string; error: string }) => failures.push(`${f.partNumber}: ${f.error}`));
      }
    } catch (e: any) {
      failures.push(e?.message || 'Save stopped part way.');
    } finally {
      setBusy('');
    }
    const all = [...saved.values()];
    const sent = all.filter(r => r.saved?.netsuite === 'sent').length;
    const local = all.filter(r => r.saved?.netsuite === 'not_netsuite').length;
    const refused = all.filter(r => r.saved?.netsuite === 'failed');
    setDone(all.length
      ? `${plural(sent, 'part')} updated in FleetSuite and NetSuite.${local ? ` ${plural(local, 'part')} only in FleetSuite (not NetSuite items).` : ''}`
      : '');
    setProblemsAfterSave([
      ...refused.map(r => `${r.partNumber}: ${r.saved?.note || 'NetSuite didn’t take it.'}`),
      ...failures,
    ]);
    // Re-check so the preview shows the saved state.
    try {
      const after = await post('/api/parts/update-prices', { apply: false, rows: good.map(r => ({ partNumber: r.partNumber, price: r.price, cost: r.cost })) });
      setResults(after.results);
    } catch { /* the list just stays as it was */ }
  };

  const counts: Record<Filter, number> = {
    change: toChange.length,
    same: (results || []).filter(r => r.status === 'same').length,
    not_found: (results || []).filter(r => r.status === 'not_found').length,
    problems: problems.length,
  };
  const shown = filter === 'problems' ? [] : (results || []).filter(r => r.status === filter);

  return (
    <>
      <div
        style={{ ...card, borderStyle: 'dashed', borderWidth: '2px', borderColor: dragging ? theme.accent : 'var(--border)' }}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files?.[0]); }}
      >
        <div style={{ fontSize: '13px', marginBottom: '8px' }}>
          Columns: <b>Part Number</b> plus <b>Price</b>, <b>Cost</b>, or both, in any order (List Price works as the price).
          A blank cell keeps what the part has. Drag a file here, choose one, or copy rows in Excel and paste them on this page.
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{
            display: 'inline-block', padding: '10px 16px', borderRadius: '10px', background: theme.accent, color: '#fff',
            fontWeight: 700, fontSize: '14px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
            Choose spreadsheet
            <input type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" style={{ display: 'none' }} disabled={!!busy}
              onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {source && <span style={muted}>{source} · {plural(rows.length, 'row')}</span>}
          {busy && <span style={muted}>{busy}</span>}
        </div>
      </div>

      <div style={{ ...card, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '13px' }}>
        <label htmlFor="discount" style={{ fontWeight: 700 }}>Fill cost as price minus</label>
        <input id="discount" type="number" inputMode="decimal" min={0} max={99} step={0.5} value={discount}
          onChange={e => setDiscount(e.target.value)} placeholder="—"
          style={{ width: '72px', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)', fontSize: '14px' }} />
        <span>%</span>
        <span style={muted}>Optional. Only for parts your file gives no cost for. A cost in your file always wins.</span>
      </div>

      {error && <div style={errorBox}>{error}</div>}
      {done && <div style={doneBox}>{done}</div>}
      {problemsAfterSave.length > 0 && (
        <div style={errorBox}>
          {plural(problemsAfterSave.length, 'part')} didn’t fully save:
          <ul style={{ margin: '6px 0 0', paddingLeft: '18px', fontWeight: 400 }}>
            {problemsAfterSave.slice(0, 20).map(p => <li key={p}>{p}</li>)}
            {problemsAfterSave.length > 20 && <li>…and {problemsAfterSave.length - 20} more</li>}
          </ul>
          <button onClick={onShowMismatches} style={{ ...plainBtn, marginTop: '8px' }}>Open “Prices that don’t match”</button>
        </div>
      )}

      {(results || problems.length > 0) && (
        <>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {([
              ['change', 'Will change'],
              ['same', 'Same'],
              ['not_found', 'Not in FleetSuite'],
              ['problems', 'Problems'],
            ] as [Filter, string][]).filter(([k]) => k !== 'problems' || counts.problems > 0).map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} style={{
                padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${filter === k ? theme.accent : 'var(--border)'}`,
                background: filter === k ? theme.accent : 'var(--card)', color: filter === k ? '#fff' : 'var(--text-secondary)',
              }}>{label} · {counts[k]}</button>
            ))}
            <div style={{ flex: 1 }} />
            <button onClick={save} disabled={!!busy || counts.change === 0} style={greenBtn(!busy && counts.change > 0)}>
              {busy.startsWith('Saving') ? busy : `Save ${plural(counts.change, 'part')}`}
            </button>
          </div>

          {filter === 'not_found' && counts.not_found > 0 && (
            <div style={muted}>These part numbers aren’t in FleetSuite, so they’re skipped. Add the part first, or check for a typo.</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {filter === 'problems' && problems.map(r => (
              <div key={`${r.line}-${r.partNumber}`} style={{ ...card, padding: '10px 12px', fontSize: '13px' }}>
                <b>Row {r.line} · {r.partNumber}</b>
                <div style={{ color: theme.error }}>{r.problem}</div>
              </div>
            ))}
            {shown.slice(0, 300).map(r => {
              const fromDiscount = good.find(g => g.partNumber === r.partNumber)?.costFromDiscount;
              return (
                <div key={r.partNumber} style={{ ...card, padding: '10px 12px', fontSize: '13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                    <b style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{r.partNumber}</b>
                    <span style={muted}>{r.displayName || ''}{r.partIds.length > 1 ? ` · ${r.partIds.length} catalog rows` : ''}</span>
                  </div>
                  {r.status !== 'not_found' && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '4px 12px', marginTop: '4px' }}>
                      <Change label="Price" from={r.current?.price ?? null} to={r.next.price} />
                      <Change label={fromDiscount ? 'Cost (from %)' : 'Cost'} from={r.current?.cost ?? null} to={r.next.cost} />
                    </div>
                  )}
                  {r.status === 'not_found' && (
                    <div style={muted}>File price {fmtMoney(r.next.price)}{r.next.cost != null ? ` · cost ${fmtMoney(r.next.cost)}` : ''}</div>
                  )}
                </div>
              );
            })}
            {shown.length > 300 && <div style={muted}>…and {shown.length - 300} more</div>}
            {filter !== 'problems' && shown.length === 0 && <div style={muted}>Nothing here.</div>}
          </div>
        </>
      )}
    </>
  );
}

function Change({ label, from, to }: { label: string; from: number | null; to: number | null }) {
  const changed = Math.round((from ?? -1) * 100) !== Math.round((to ?? -1) * 100);
  const diff = from != null && to != null && from > 0 ? to - from : null;
  return (
    <div>
      <div style={muted}>{label}</div>
      <div>
        {changed && from != null && <span style={{ textDecoration: 'line-through', color: 'var(--text-muted)', marginRight: '6px' }}>{fmtMoney(from)}</span>}
        <span style={{ fontWeight: changed ? 700 : 400 }}>{fmtMoney(to)}</span>
        {changed && diff != null && (
          <span style={{ ...muted, marginLeft: '6px' }}>{diff > 0 ? '+' : ''}{((diff / from!) * 100).toFixed(1)}%</span>
        )}
      </div>
    </div>
  );
}

function Mismatches({ flashPart }: { flashPart: string | null }) {
  const [items, setItems] = useState<MismatchItem[] | null>(null);
  const [lastCheck, setLastCheck] = useState<{ at: string | null; result: any } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const take = (json: any) => {
    setItems(json.mismatches || []);
    setLastCheck(json.lastCheck || null);
    const failed = (json.failed || []) as { partNumber: string; error: string }[];
    if (failed.length) setError(failed.map(f => `${f.partNumber}: ${f.error}`).join(' · '));
  };

  useEffect(() => {
    apiFetch('/api/parts/price-mismatches')
      .then(async res => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        take(json);
      })
      .catch(e => setError(e?.message || 'Couldn’t load the list.'));
  }, []);

  useEffect(() => {
    if (!flashPart || !items) return;
    const el = document.getElementById(`mm-${flashPart}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [flashPart, items]);

  const act = async (action: 'send' | 'use', partIds: string[]) => {
    setError(''); setDone('');
    try {
      let last: any = null;
      for (let i = 0; i < partIds.length; i += 25) {
        setBusy(action === 'send' ? `Sending ${Math.min(i + 25, partIds.length)} of ${partIds.length}…` : 'Saving…');
        last = await post('/api/parts/price-mismatches', { action, partIds: partIds.slice(i, i + 25) });
      }
      if (last) take(last);
      if (!(last?.failed || []).length) setDone(action === 'send' ? `Sent to NetSuite.` : 'FleetSuite now uses NetSuite’s price.');
    } catch (e: any) {
      setError(e?.message || 'That didn’t work.');
    } finally {
      setBusy('');
    }
  };

  const checkNow = async () => {
    setError(''); setDone(''); setBusy('Checking every part against NetSuite…');
    try {
      take(await post('/api/parts/price-mismatches', { action: 'check' }));
      setDone('Checked just now.');
    } catch (e: any) {
      setError(e?.message || 'The check didn’t finish.');
    } finally {
      setBusy('');
    }
  };

  const result = lastCheck?.result || null;
  return (
    <>
      <div style={{ ...card, display: 'flex', gap: '10px', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ fontSize: '13px', maxWidth: '60ch' }}>
          FleetSuite checks every part’s price against NetSuite each night, and when you tap Check now. FleetSuite’s price is the one estimates and invoices use.
          <div style={muted}>
            {lastCheck?.at ? `Last checked ${new Date(lastCheck.at).toLocaleString()}` : 'Not checked yet'}
            {result && typeof result.checked === 'number' ? ` · ${result.checked} parts` : ''}
          </div>
        </div>
        <button onClick={checkNow} disabled={!!busy} style={{ ...plainBtn, padding: '9px 14px', fontSize: '13px' }}>Check now</button>
      </div>

      {busy && <div style={muted}>{busy}</div>}
      {error && <div style={errorBox}>{error}</div>}
      {done && <div style={doneBox}>{done}</div>}

      {items && items.length === 0 && <div style={muted}>Every part’s price matches NetSuite.</div>}
      {items && items.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <b style={{ fontSize: '14px' }}>{plural(items.length, 'part')} don’t match</b>
            <div style={{ flex: 1 }} />
            <button onClick={() => act('send', items.filter(i => (i.fleetsuitePrice ?? 0) > 0).map(i => i.partId))} disabled={!!busy} style={greenBtn(!busy)}>
              Send all {items.length} to NetSuite
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {items.map(m => (
              <div key={m.partId} id={`mm-${m.partId}`} style={{
                ...card, padding: '10px 12px', fontSize: '13px',
                ...(flashPart === m.partId ? { borderColor: theme.accent, boxShadow: `0 0 0 2px ${theme.accent}` } : {}),
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                  <b style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{m.partNumber}</b>
                  <span style={muted}>{m.displayName || ''}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '4px 12px', marginTop: '4px' }}>
                  <div><div style={muted}>FleetSuite</div><b>{fmtMoney(m.fleetsuitePrice)}</b></div>
                  <div><div style={muted}>NetSuite</div>{m.netsuitePrice == null ? 'No price' : fmtMoney(m.netsuitePrice)}</div>
                </div>
                {m.reason && <div style={{ color: theme.error, fontSize: '12px', marginTop: '4px' }}>{m.reason}</div>}
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                  <button onClick={() => act('send', [m.partId])} disabled={!!busy} style={plainBtn}>Send to NetSuite</button>
                  {m.netsuitePrice != null && m.netsuitePrice > 0 && (
                    <button onClick={() => act('use', [m.partId])} disabled={!!busy} style={plainBtn}>Use NetSuite’s {fmtMoney(m.netsuitePrice)}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
