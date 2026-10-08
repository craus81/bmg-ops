'use client';

/**
 * "Link pricing request" on the PO page (migration 352). When a customer PO
 * carries 02 / 06 numbers that aren't NetSuite items yet, this offers the
 * pricing request they came from (best company-name match first). Linking
 * creates both NetSuite items at the quoted prices through the same
 * /api/netsuite/create-item route the catalog uses (it upgrades the local
 * row PO import made), points the PO lines at them, and marks the request
 * On PO. Renders nothing when the PO has no new 02 / 06 numbers and no
 * linked request. Admin only, like the PO page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { deepLinks } from '@/lib/deep-links';
import { useDialog } from '@/components/DialogProvider';
import { STAGE_META, rankRequestsForPair, type NewPartPair, type PoLineForLink, type PricingRequest, type PricingRequestStage } from '@/lib/pricing-request';

type Candidate = PricingRequest & { stage: PricingRequestStage; quoted: { part: number; install: number } };

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const btnSm: React.CSSProperties = { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' };
const inputSm: React.CSSProperties = { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '16px', boxSizing: 'border-box' };

export default function PoPricingRequestLink({ poId, onLinked }: { poId: string; onLinked?: () => void }) {
  const dialog = useDialog();
  const [pairs, setPairs] = useState<NewPartPair[]>([]);
  const [linked, setLinked] = useState<Candidate[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [open, setOpen] = useState<NewPartPair | null>(null);
  const [pickId, setPickId] = useState('');
  const [partPrice, setPartPrice] = useState('');
  const [installPrice, setInstallPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/pricing-requests/link-po?poId=${encodeURIComponent(poId)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      setPairs(json.pairs || []);
      setLinked(json.linked || []);
      setCandidates(json.candidates || []);
    } catch { /* the card just stays hidden */ }
  }, [poId]);

  useEffect(() => { void load(); }, [load]);

  const ranked = useMemo(() => (open ? rankRequestsForPair(candidates, open) : []), [open, candidates]);
  const picked = ranked.find(c => c.id === pickId) || null;

  const choose = (c: Candidate | null) => {
    setPickId(c?.id || '');
    setPartPrice(c && c.quoted.part > 0 ? String(c.quoted.part) : '');
    setInstallPrice(c && c.quoted.install > 0 ? String(c.quoted.install) : '');
  };

  const openFor = (pair: NewPartPair) => {
    setOpen(pair);
    const best = rankRequestsForPair(candidates, pair)[0] || null;
    choose(best);
  };

  if (pairs.length === 0 && linked.length === 0) return null;

  const priceOf = (s: string) => {
    const v = Number(s);
    return s.trim() !== '' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  };

  // Create (or find) the NetSuite item for one PO line, at the quoted price.
  const ensureItem = async (line: PoLineForLink, recordType: string, price: number | null, company: string) => {
    const res = await apiFetch('/api/netsuite/create-item', {
      method: 'POST',
      body: JSON.stringify({
        partNumber: line.part_number,
        recordType,
        displayName: line.description || line.part_number,
        description: line.description || null,
        salesPrice: price,
        catalog: 'graphics',
        billableCustomer: company,
        existingPartId: line.part_id || null,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.success) throw new Error(`${line.part_number}: ${json.error || 'NetSuite would not create the item'}`);
    const notes: string[] = [];
    if (json.alreadyExists) notes.push(`${line.part_number} was already in NetSuite, so its price there was left as it is.`);
    if (json.priceWarning) notes.push(json.priceWarning);
    if (json.mirrorWarning) notes.push(json.mirrorWarning);
    return { partId: (json.part?.id as string | undefined) || line.part_id || null, notes };
  };

  const link = async () => {
    if (!open || !picked) return;
    const pp = priceOf(partPrice);
    const ip = priceOf(installPrice);
    if (open.partLine && pp == null) { await dialog.alert('Enter the graphic (02) price.'); return; }
    if (open.installLine && ip == null) { await dialog.alert('Enter the install (06) price.'); return; }
    const numbers = [open.partLine?.part_number, open.installLine?.part_number].filter(Boolean).join(' and ');
    const ok = await dialog.confirm(
      `Add ${numbers} to NetSuite and the catalog at these prices, and link this PO to ${picked.request_number} (${picked.company_name})?`,
      { title: 'Link pricing request', confirmLabel: 'Link & add to NetSuite' },
    );
    if (!ok) return;

    setSaving(true);
    const notes: string[] = [];
    try {
      let partId: string | null = null;
      let installPartId: string | null = null;
      if (open.partLine) {
        const r = await ensureItem(open.partLine, 'nonInventorySaleItem', pp, picked.company_name);
        partId = r.partId; notes.push(...r.notes);
      }
      if (open.installLine) {
        const r = await ensureItem(open.installLine, 'serviceSaleItem', ip, picked.company_name);
        installPartId = r.partId; notes.push(...r.notes);
      }
      const res = await apiFetch('/api/pricing-requests/link-po', {
        method: 'POST',
        body: JSON.stringify({
          requestId: picked.id, poId,
          partLineId: open.partLine?.id || null, installLineId: open.installLine?.id || null,
          partId, installPartId, partPrice: pp, installPrice: ip,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not link the request');
      setOpen(null);
      await load();
      onLinked?.();
      if (notes.length > 0) await dialog.alert(`Linked. Note:\n\n${notes.join('\n')}`);
    } catch (err: any) {
      await dialog.alert(`${err?.message || 'Could not link the request'}${notes.length ? `\n\n${notes.join('\n')}` : ''}`);
    }
    setSaving(false);
  };

  // A PO price that differs from what we quoted is worth a second look.
  const mismatch = (line: PoLineForLink | null, quoted: string) => {
    const q = priceOf(quoted);
    if (!line || q == null || line.unit_price == null) return null;
    return Math.abs(Number(line.unit_price) - q) >= 0.01 ? `PO says ${fmtMoney(line.unit_price)}` : null;
  };

  return (
    <div style={{ background: 'var(--card)', border: '1px solid rgba(34,211,238,0.3)', borderRadius: '14px', padding: '14px 16px', marginBottom: '12px' }}>
      <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: '#22d3ee', marginBottom: '8px' }}>Pricing requests</div>

      {linked.map(r => (
        <div key={r.id} style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
          ✓ <a href={deepLinks.pricingRequest(r.id)} style={{ color: '#60a5fa', fontWeight: 700 }}>{r.request_number}</a> ({r.company_name})
          {[r.part_number, r.install_part_number].filter(Boolean).length > 0 && `: ${[r.part_number, r.install_part_number].filter(Boolean).join(' / ')}`}
        </div>
      ))}

      {pairs.map(pair => (
        <div key={pair.suffix} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '6px' }}>
          <div style={{ flex: 1, minWidth: '200px', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            New numbers, not in NetSuite yet: <b>{[pair.partLine?.part_number, pair.installLine?.part_number].filter(Boolean).join(' / ')}</b>
            {(pair.partLine?.description || pair.installLine?.description) && (
              <span style={{ color: 'var(--text-muted)' }}> · {pair.partLine?.description || pair.installLine?.description}</span>
            )}
          </div>
          <button style={{ ...btnSm, color: '#22d3ee' }} onClick={() => openFor(pair)} disabled={candidates.length === 0}
            title={candidates.length === 0 ? 'No open pricing requests to link' : undefined}>
            {candidates.length === 0 ? 'No open requests' : 'Link pricing request'}
          </button>
        </div>
      ))}

      {open && (
        <div style={{ marginTop: '12px', padding: '12px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', display: 'grid', gap: '10px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Request</div>
            <select value={pickId} onChange={e => choose(ranked.find(c => c.id === e.target.value) || null)} style={inputSm}>
              <option value="">Pick a request…</option>
              {ranked.map(c => (
                <option key={c.id} value={c.id}>
                  {c.company_name} · {c.request_number} · {STAGE_META[c.stage].label}{c.quoted.part || c.quoted.install ? ` · ${fmtMoney(c.quoted.part)} / ${fmtMoney(c.quoted.install)}` : ''}
                </option>
              ))}
            </select>
            {picked && picked.stage !== 'approved' && (
              <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: '4px' }}>This request isn't marked approved yet ({STAGE_META[picked.stage].label}).</div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
            {open.partLine && (
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>{open.partLine.part_number} graphic price</div>
                <input inputMode="decimal" value={partPrice} onChange={e => setPartPrice(e.target.value)} style={inputSm} />
                {mismatch(open.partLine, partPrice) && <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: '3px' }}>{mismatch(open.partLine, partPrice)}</div>}
              </div>
            )}
            {open.installLine && (
              <div>
                <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>{open.installLine.part_number} install price</div>
                <input inputMode="decimal" value={installPrice} onChange={e => setInstallPrice(e.target.value)} style={inputSm} />
                {mismatch(open.installLine, installPrice) && <div style={{ fontSize: '11px', color: '#fbbf24', marginTop: '3px' }}>{mismatch(open.installLine, installPrice)}</div>}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button style={btnSm} onClick={() => setOpen(null)} disabled={saving}>Cancel</button>
            <button style={{ ...btnSm, background: '#0891b2', border: 'none', color: '#fff', opacity: saving || !picked ? 0.6 : 1 }} onClick={link} disabled={saving || !picked}>
              {saving ? 'Linking…' : 'Link & add to NetSuite'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
