'use client';

/**
 * A vendor PO that doesn't start from sales-order demand (Craig,
 * 2026-10-20): stock orders, or parts for a job before they show up as
 * short. Pick the vendor and plant, add parts, optionally tie it to a job,
 * and create it in NetSuite.
 *
 * It goes through the same two calls as everything else, so a PO made here
 * behaves like one made from the queue (On order, readiness, Undo): the
 * parts are raised as fresh purchase requests, then create-po orders exactly
 * those. If NetSuite refuses, the requests stay in the queue to retry.
 *
 * A part whose catalog vendor or last PO was someone else gets a yellow
 * note: that's the mix-up that started this.
 */

import { useEffect, useRef, useState } from 'react';
import { theme } from '@/lib/theme';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import { deepLinks } from '@/lib/deep-links';
import { cleanPartQuery, partSearchFilter } from '@/lib/part-suggest';
import { cleanPoSuffix, customerAbbrev } from '@/lib/po-number';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';

const LOCATIONS = ["O'Fallon", 'Wentzville', 'Kansas City', 'Social Circle'] as const;
type LocationName = typeof LOCATIONS[number];

// Jobs still ahead of install (same list as OrderPartModal).
const CLOSED_PROJECT_STATUSES = ['completed', 'cancelled', 'opportunity', 'estimate'];

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface PartHit {
  item_number: string;
  netsuite_id: string | null;
  display_name: string | null;
  description: string | null;
  vendor: string | null;
  purchase_price: number | null;
}

interface Line {
  key: number;
  part: PartHit;
  qty: string;
  price: string;
  /** Who the part usually comes from: the catalog, else its last PO. */
  usualVendor: string | null;
}

interface ProjectOpt { id: string; label: string; customer: string | null }

/** Loose vendor match: "Ranger Design" ≈ "RANGER DESIGN INC". */
export function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  const first = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/)[0] || '';
  const x = first(String(a || ''));
  const y = first(String(b || ''));
  return !x || !y || x === y || x.startsWith(y) || y.startsWith(x);
}

interface Done { number: string; url: string | null; netsuiteId: string | null; suffixError: string | null }

export default function NewVendorPoModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const supabase = createClient();
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const [location, setLocation] = useState<LocationName>("O'Fallon");
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [projectId, setProjectId] = useState('');
  const [suffix, setSuffix] = useState('');
  const suffixTouched = useRef(false);
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const nextKey = useRef(1);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<PartHit[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('upfit_projects')
        .select('id, project_name, netsuite_so_number, customer_name, status')
        .not('status', 'in', `(${CLOSED_PROJECT_STATUSES.join(',')})`)
        .order('project_name')
        .order('id')
        .limit(500);
      if (cancelled) return;
      setProjects(((data || []) as any[]).map(p => ({
        id: p.id,
        label: `${p.project_name || 'Upfit project'}${p.netsuite_so_number ? ` · SO ${p.netsuite_so_number}` : ''}`,
        customer: p.customer_name || null,
      })));
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one load per open
  }, []);

  // Part search, debounced.
  useEffect(() => {
    const cleaned = cleanPartQuery(search);
    const mySeq = ++seq.current;
    if (!cleaned) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('netsuite_parts')
        .select('item_number, netsuite_id, display_name, description, vendor, purchase_price')
        .eq('is_active', true)
        .or(partSearchFilter(cleaned))
        .order('item_number')
        .limit(25);
      if (mySeq !== seq.current) return;
      const byItem = new Map<string, PartHit>();
      for (const p of (data || []) as PartHit[]) {
        const k = p.item_number.toUpperCase();
        const prev = byItem.get(k);
        if (!prev || (!prev.netsuite_id && p.netsuite_id)) byItem.set(k, p);
      }
      setHits([...byItem.values()].slice(0, 10));
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is stable
  }, [search]);

  const pickProject = (id: string) => {
    setProjectId(id);
    if (!suffixTouched.current) setSuffix(customerAbbrev(projects.find(p => p.id === id)?.customer));
  };

  const addPart = async (part: PartHit) => {
    setSearch('');
    setHits([]);
    const key = nextKey.current++;
    setLines(prev => [...prev, {
      key, part, qty: '1',
      price: part.purchase_price && part.purchase_price > 0 ? String(part.purchase_price) : '',
      usualVendor: part.vendor || null,
    }]);
    if (part.vendor) return;
    // No catalog vendor: who did we last buy it from?
    const { data } = await supabase
      .from('netsuite_vendor_po_lines')
      .select('po:netsuite_vendor_pos!inner(vendor_name, trandate)')
      .eq('item_number', part.item_number.toUpperCase())
      .order('id', { ascending: false })
      .limit(50);
    const latest = ((data || []) as any[])
      .map(r => r.po)
      .filter(p => p?.vendor_name)
      .sort((a, b) => String(b.trandate || '').localeCompare(String(a.trandate || '')))[0];
    if (latest) setLines(prev => prev.map(l => (l.key === key ? { ...l, usualVendor: latest.vendor_name } : l)));
  };

  const qtyOf = (l: Line) => { const n = parseFloat(l.qty); return Number.isFinite(n) && n > 0 ? n : 0; };
  const priceOf = (l: Line) => { const n = parseFloat(l.price); return Number.isFinite(n) && n > 0 ? n : null; };
  const total = lines.reduce((s, l) => s + qtyOf(l) * (priceOf(l) || 0), 0);
  const noId = lines.filter(l => !l.part.netsuite_id);
  const badQty = lines.some(l => qtyOf(l) <= 0);
  const missing = !vendor ? 'Pick the vendor.' : lines.length === 0 ? 'Add at least one part.'
    : noId.length > 0 ? `${noId.map(l => l.part.item_number).join(', ')} ${noId.length === 1 ? 'isn’t' : 'aren’t'} in NetSuite yet, so ${noId.length === 1 ? 'it' : 'they'} can’t go on a PO. Remove ${noId.length === 1 ? 'it' : 'them'}.`
    : badQty ? 'Every part needs a quantity above 0.' : null;

  const submit = async () => {
    if (busy || missing || !vendor) return;
    setBusy(true);
    setError(null);
    try {
      const reqRes = await fetch('/api/purchase-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: lines.map(l => ({
            itemNumber: l.part.item_number, quantity: qtyOf(l),
            netsuiteItemId: l.part.netsuite_id, description: l.part.display_name || l.part.description || null,
          })),
          projectId: projectId || null,
          note: 'New vendor PO',
          fresh: true,
        }),
      });
      const reqBody = await reqRes.json().catch(() => ({}));
      const ids: string[] = reqBody.createdIds || [];
      if (!reqRes.ok || !reqBody.success || ids.length !== lines.length) {
        throw new Error(reqBody.error || 'the parts could not be logged');
      }
      const poRes = await fetch('/api/purchase-requests/create-po', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestIds: ids,
          vendorNetsuiteId: vendor.id,
          vendorName: vendor.name,
          memo: memo.trim() || null,
          locationName: location,
          lines: lines.map((l, i) => ({ requestId: ids[i], quantity: qtyOf(l), rate: priceOf(l) })),
          poSuffix: cleanPoSuffix(suffix) || null,
        }),
      });
      const po = await poRes.json().catch(() => ({}));
      if (!poRes.ok || !po.success) {
        onCreated();
        setError(`NetSuite didn’t create the PO: ${po.error || `HTTP ${poRes.status}`}. The parts are in the Request queue, so you can try again from there.`);
        setBusy(false);
        return;
      }
      setDone({
        number: po.poNumber || (po.poId ? `#${po.poId}` : '(number pending)'),
        url: po.netsuiteUrl || null,
        netsuiteId: po.poId ? String(po.poId) : null,
        suffixError: po.suffixError || null,
      });
      onCreated();
    } catch (e: any) {
      setError(`Couldn’t create the PO: ${e?.message || 'unknown error'}. Nothing was ordered.`);
    }
    setBusy(false);
  };

  const field = {
    padding: '6px 8px', fontSize: '16px', borderRadius: '7px',
    background: theme.inputBg, color: theme.textPrimary, border: `1px solid ${theme.border}`,
  };
  const label = { fontSize: '11px', fontWeight: 700, color: theme.textSecondary, marginBottom: '4px' } as const;

  return (
    <div
      ref={closeOnEscape(() => { if (!busy) onClose(); })}
      style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: '16px' }}
    >
      <div onClick={e => e.stopPropagation()} style={{
        background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
        width: '100%', maxWidth: '720px', maxHeight: 'calc(88vh / var(--ts))',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>New vendor PO</div>
          <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
            For stock or anything not on a sales order yet. It goes into NetSuite as Pending Receipt.
          </div>
        </div>

        {done ? (
          <div style={{ padding: '18px 16px', fontSize: '13px', color: theme.textPrimary, lineHeight: 1.6 }}>
            PO <b>{done.number}</b> created in NetSuite{vendor ? ` for ${vendor.name}` : ''}.{' '}
            {done.url && <a href={done.url} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontWeight: 700 }}>Open in NetSuite ↗</a>}
            {done.netsuiteId && (
              <a href={deepLinks.pdfViewer(deepLinks.netsuitePdf('purchaseOrder', done.netsuiteId, deepLinks.poPdfFileName(done.number, done.netsuiteId)), { name: deepLinks.poPdfFileName(done.number, done.netsuiteId) })}
                target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontWeight: 700, marginLeft: '10px' }}>
                PO PDF ↗
              </a>
            )}
            {done.suffixError && <div style={{ marginTop: '8px', color: '#f59e0b', fontWeight: 700 }}>{done.suffixError}</div>}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
              <button type="button" onClick={onClose}
                style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: 'var(--card)', color: theme.textPrimary, border: `1px solid ${theme.border}`, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          </div>
        ) : (<>
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <div style={label}>Vendor</div>
              {vendor ? (
                <div style={{ fontSize: '13px', color: theme.textPrimary }}>
                  <b>{vendor.name}</b> <span style={{ color: theme.textMuted }}>#{vendor.id}</span>
                  <button type="button" onClick={() => setVendor(null)} disabled={busy}
                    style={{ marginLeft: '8px', background: 'none', border: 'none', padding: 0, color: '#60a5fa', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                    change
                  </button>
                </div>
              ) : (
                <NetsuiteVendorSearch autoFocus onSelect={v => setVendor({ id: v.id, name: v.companyName || v.entityId })} />
              )}
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', flex: '1 1 140px' }}>
                <span style={label}>Ship to</span>
                <select value={location} disabled={busy} onChange={e => setLocation(e.target.value as LocationName)} style={field}>
                  {LOCATIONS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', flex: '2 1 220px', minWidth: 0 }}>
                <span style={label}>Job (optional)</span>
                <select value={projectId} disabled={busy} onChange={e => pickProject(e.target.value)} style={{ ...field, minWidth: 0 }}>
                  <option value="">Stock, no job</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', flex: '1 1 140px' }}>
                <span style={label}>PO # ending</span>
                <input id="new-po-suffix" value={suffix} disabled={busy} maxLength={20} placeholder="ACME"
                  onChange={e => { suffixTouched.current = true; setSuffix(e.target.value.toUpperCase()); }}
                  style={{ ...field, textTransform: 'uppercase' }} />
                <span style={{ fontSize: '10.5px', color: theme.textMuted, marginTop: '3px' }}>
                  {cleanPoSuffix(suffix) ? `PO###-${cleanPoSuffix(suffix)}` : 'NetSuite’s number as is'}
                </span>
              </label>
            </div>

            <div>
              <div style={label}>Parts</div>
              {lines.map(l => {
                const otherVendor = vendor && l.usualVendor && !sameVendor(l.usualVendor, vendor.name);
                return (
                  <div key={l.key} style={{ display: 'flex', gap: '9px', alignItems: 'center', padding: '7px 8px', borderRadius: '8px', marginBottom: '4px', background: 'var(--subtle-bg)', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 700, color: theme.textPrimary }}>{l.part.item_number}</div>
                      {(l.part.display_name || l.part.description) && (
                        <div style={{ fontSize: '11px', color: theme.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.part.display_name || l.part.description}</div>
                      )}
                      {otherVendor && (
                        <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 700 }}>Usually from {l.usualVendor}. Check this is the right vendor.</div>
                      )}
                      {!l.part.netsuite_id && (
                        <div style={{ fontSize: '11px', color: '#f87171', fontWeight: 700 }}>Not in NetSuite yet, so it can’t go on a PO.</div>
                      )}
                    </div>
                    <input type="number" min="0" step="any" aria-label={`Quantity of ${l.part.item_number}`} disabled={busy}
                      value={l.qty} onChange={e => setLines(prev => prev.map(x => (x.key === l.key ? { ...x, qty: e.target.value } : x)))}
                      style={{ ...field, width: '72px', textAlign: 'right', fontWeight: 700 }} />
                    <input type="number" min="0" step="any" aria-label={`Unit price of ${l.part.item_number}`} placeholder="NetSuite" disabled={busy}
                      value={l.price} onChange={e => setLines(prev => prev.map(x => (x.key === l.key ? { ...x, price: e.target.value } : x)))}
                      style={{ ...field, width: '92px', textAlign: 'right', fontWeight: 700 }} />
                    <button type="button" onClick={() => setLines(prev => prev.filter(x => x.key !== l.key))} disabled={busy}
                      aria-label={`Remove ${l.part.item_number}`}
                      style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '14px', cursor: 'pointer', padding: '2px 4px' }}>✕</button>
                  </div>
                );
              })}
              <input id="new-po-part-search" value={search} onChange={e => setSearch(e.target.value)} disabled={busy}
                placeholder={lines.length ? '+ Add another part…' : 'Type a part number or name…'}
                style={{ ...field, width: '100%', boxSizing: 'border-box', marginTop: '4px' }} />
              {searching && <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '4px' }}>Searching…</div>}
              {hits.length > 0 && (
                <div style={{ border: `1px solid ${theme.border}`, borderRadius: '8px', marginTop: '4px', overflow: 'hidden' }}>
                  {hits.map(h => (
                    <button key={h.item_number} type="button" onClick={() => addPart(h)}
                      style={{ display: 'flex', width: '100%', gap: '8px', alignItems: 'baseline', padding: '7px 10px', background: 'var(--card)', border: 'none', borderTop: `1px solid ${theme.border}`, cursor: 'pointer', textAlign: 'left', color: theme.textPrimary }}>
                      <span style={{ fontSize: '12px', fontWeight: 700 }}>{h.item_number}</span>
                      <span style={{ fontSize: '11px', color: theme.textMuted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.display_name || h.description || ''}</span>
                      {h.purchase_price ? <span style={{ fontSize: '11px', color: theme.textSecondary }}>{money(Number(h.purchase_price))}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <textarea value={memo} onChange={e => { if (!busy) setMemo(e.target.value.slice(0, 500)); }}
              placeholder="Memo (optional)" rows={2}
              style={{ ...field, width: '100%', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>

          <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}` }}>
            {error && <div style={{ fontSize: '12px', fontWeight: 700, color: '#f87171', marginBottom: '8px' }}>{error}</div>}
            {!error && missing && lines.length > 0 && <div style={{ fontSize: '12px', color: '#f59e0b', fontWeight: 700, marginBottom: '8px' }}>{missing}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ fontSize: '12px', color: theme.textSecondary }}>
                {lines.length} part{lines.length !== 1 ? 's' : ''} · <b style={{ color: theme.textPrimary }}>{money(total)}</b>
              </div>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                <button type="button" onClick={onClose} disabled={busy}
                  style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, background: 'var(--card)', color: theme.textPrimary, border: `1px solid ${theme.border}`, cursor: busy ? 'default' : 'pointer' }}>
                  Cancel
                </button>
                <button type="button" onClick={submit} disabled={busy || !!missing} title={missing || undefined}
                  style={{ padding: '8px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 800, background: '#16a34a', color: '#fff', border: 'none', cursor: busy ? 'wait' : 'pointer', opacity: missing ? 0.5 : 1 }}>
                  {busy ? 'Creating PO…' : 'Create PO in NetSuite'}
                </button>
              </div>
            </div>
          </div>
        </>)}
      </div>
    </div>
  );
}
