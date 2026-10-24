'use client';

/**
 * Rack Kits: how many of each rack kit (Prime Design ErgoRack / AluRack,
 * migration 333) we can build from the components on the shelf.
 *
 * Per component: free = NetSuite available minus FleetSuite reservations
 * (same numbers as /admin/inventory), on order = open vendor PO lines not yet
 * received. A rack is limited by its scarcest component (kitBuildable).
 * Racks share parts, so every count reads "if you built only this rack".
 *
 * Each rack has a photo slot (Craig 2026-10-20) for the rack kit browser on
 * estimates; one photo can go on the silver and black versions together.
 *
 * Also lists the components not in the catalog yet — the items still to be
 * created in NetSuite before their racks can be stocked or priced.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase-browser';
import { useAuth, useRequireFeature } from '@/components/AuthProvider';
import { storage } from '@/lib/storage';
import { toJpegIfHeic } from '@/lib/heic';
import { useImageDrop } from '@/lib/use-image-drop';
import { rackBaseNumber } from '@/lib/rack-kit-facets';
import { partNumberIncludes } from '@/lib/loose-search';
import { kitBuildableFor, loadKits, loadKitStock, normItem, type KitBuildable, type KitWithMembers } from '@/lib/part-kits';

interface RackRow {
  kit: KitWithMembers;
  build: KitBuildable;
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function RackKitsPage() {
  useRequireFeature('parts_catalog');
  // Same rule as the parts catalog: prices for money roles and purchasers.
  const { canSeeMoney, hasFeature, isAdmin } = useAuth();
  const showPrice = canSeeMoney || hasFeature('parts_ordering');
  const canEditPhotos = isAdmin || hasFeature('parts_ordering');
  const supabase = createClient();
  const [rows, setRows] = useState<RackRow[]>([]);
  const [missingParts, setMissingParts] = useState<{ item_number: string; description: string | null; racks: number }[]>([]);
  // Prime Design merged into Ranger Design (Craig 2026-09-30): every rack
  // component is ordered from Ranger. The buy list, purchasing queue and PO
  // matching all take the vendor from the NetSuite item, so a component
  // still on Prime (or on no vendor) would be ordered from the wrong place.
  const [wrongVendor, setWrongVendor] = useState<{ item_number: string; vendor: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'buildable' | 'short'>('all');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const kits = (await loadKits(supabase)).filter(k => k.item_number);
      const stock = await loadKitStock(supabase, kits);

      const missing = new Map<string, { item_number: string; description: string | null; racks: number }>();
      const built: RackRow[] = kits.map(kit => {
        for (const m of kit.missing) {
          const key = normItem(m.item_number);
          const row = missing.get(key) || { item_number: m.item_number, description: m.description, racks: 0 };
          row.racks += 1;
          missing.set(key, row);
        }
        return { kit, build: kitBuildableFor(kit, stock) };
      });
      built.sort((a, b) => (b.build.now - a.build.now) || (b.build.withOnOrder - a.build.withOnOrder)
        || String(a.kit.item_number).localeCompare(String(b.kit.item_number)));
      setRows(built);
      const offVendor = new Map<string, { item_number: string; vendor: string | null }>();
      for (const k of kits) {
        for (const m of k.members) {
          if (!/ranger/i.test(m.part.vendor || '')) offVendor.set(normItem(m.part.item_number), { item_number: m.part.item_number, vendor: m.part.vendor || null });
        }
      }
      setWrongVendor([...offVendor.values()].sort((a, b) => a.item_number.localeCompare(b.item_number)));
      setMissingParts([...missing.values()].sort((a, b) => b.racks - a.racks || a.item_number.localeCompare(b.item_number)));
    } catch (e: any) {
      setError(e?.message || 'Could not load rack kits');
    }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { load(); }, [load]);

  // A new photo for one rack, and its silver/black twin when asked.
  const setKitPhoto = async (kit: KitWithMembers, picked: File, alsoTwin: boolean) => {
    const file = await toJpegIfHeic(picked);
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const path = `rack-kits/${kit.id}/photo-${Date.now()}.${ext}`;
    const { error: upErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
    if (upErr) throw new Error(`Photo upload failed: ${upErr.message}`);
    const base = rackBaseNumber(kit.item_number || '');
    const ids = alsoTwin
      ? rows.filter(r => rackBaseNumber(r.kit.item_number || '') === base).map(r => r.kit.id)
      : [kit.id];
    const { error: rowErr } = await supabase.from('part_kits')
      .update({ image_path: path, updated_at: new Date().toISOString() })
      .in('id', ids);
    if (rowErr) throw new Error(`Could not save the photo on the rack: ${rowErr.message}`);
    setRows(prev => prev.map(r => ids.includes(r.kit.id) ? { ...r, kit: { ...r.kit, image_path: path } } : r));
  };

  const q = normItem(search);
  const visible = useMemo(() => rows.filter(r => {
    if (filter === 'buildable' && r.build.now <= 0) return false;
    if (filter === 'short' && r.build.now > 0) return false;
    if (q && !partNumberIncludes(r.kit.item_number, q) && !normItem(r.kit.name).includes(q)
      && !r.build.components.some(c => partNumberIncludes(c.item_number, q))) return false;
    return true;
  }), [rows, filter, q]);

  const buildableCount = rows.filter(r => r.build.now > 0).length;

  return (
    <div style={{ padding: '16px', maxWidth: '1020px', margin: '0 auto' }}>
      <div style={{ marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Rack Kits</h1>
          <Link href="/admin/inventory" style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa' }}>← Inventory</Link>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          {loading ? 'Loading…' : `${rows.length} racks · ${buildableCount} buildable from stock now. Counts assume you build only that rack — racks share parts.`}
        </div>
      </div>

      {error && <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '12px', marginBottom: '12px' }}>{error}</div>}

      {missingParts.length > 0 && (
        <details style={{ marginBottom: '12px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '10px', padding: '8px 12px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>
            {missingParts.length} component{missingParts.length !== 1 ? 's' : ''} not in NetSuite yet — create {missingParts.length !== 1 ? 'them' : 'it'} as {missingParts.length !== 1 ? 'inventory items' : 'an inventory item'} so {missingParts.length !== 1 ? 'their' : 'its'} racks can be stocked and priced
          </summary>
          <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '4px 16px' }}>
            {missingParts.map(m => (
              <div key={m.item_number} style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{m.item_number}</span>
                {m.description ? ` ${m.description}` : ''}
                <span style={{ color: 'var(--text-muted)' }}> · in {m.racks} rack{m.racks !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {wrongVendor.length > 0 && (
        <details style={{ marginBottom: '12px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '10px', padding: '8px 12px' }}>
          <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: '#f59e0b' }}>
            {wrongVendor.length} component{wrongVendor.length !== 1 ? 's' : ''} not set to Ranger Design in NetSuite — reorders go to the item&apos;s vendor, so set {wrongVendor.length !== 1 ? 'them' : 'it'} to Ranger Design
          </summary>
          <div style={{ marginTop: '8px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '4px 16px' }}>
            {wrongVendor.map(w => (
              <div key={w.item_number} style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{w.item_number}</span>
                <span style={{ color: 'var(--text-muted)' }}> · vendor: {w.vendor || 'none'}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search rack or part #…"
          style={{ flex: 1, minWidth: '180px', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
        />
        {(['all', 'buildable', 'short'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '7px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: filter === f ? 'rgba(59,130,246,0.2)' : 'var(--card)',
            border: `1px solid ${filter === f ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
            color: filter === f ? '#60a5fa' : 'var(--text-muted)',
          }}>
            {f === 'all' ? 'All' : f === 'buildable' ? 'Buildable now' : 'Can’t build'}
          </button>
        ))}
      </div>

      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>No racks match.</div>
      )}

      {!loading && visible.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'left', background: 'var(--input-bg)' }}>
                  <th style={{ padding: '8px 10px', fontWeight: 700 }}>Rack</th>
                  {showPrice && <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }}>Price</th>}
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }} title="Buildable from free stock right now">Can build</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700, textAlign: 'right' }} title="Buildable once open vendor POs arrive">After POs</th>
                  <th style={{ padding: '8px 10px', fontWeight: 700 }}>Limited by</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(r => {
                  const id = r.kit.id;
                  const limit = r.build.components.find(c => c.item_number === r.build.bottleneck);
                  return (
                    <Fragment key={id}>
                      <tr onClick={() => setOpen(open === id ? null : id)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
                        <td style={{ padding: '7px 10px' }}>
                          <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{open === id ? '▾' : '▸'} {r.kit.item_number}</div>
                          <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>{r.kit.name}</div>
                        </td>
                        {showPrice && (
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            {money(r.kit.totalPrice)}
                            {r.kit.missing.length > 0 && <div style={{ fontSize: '9px', color: '#f59e0b' }}>incomplete</div>}
                          </td>
                        )}
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 800, fontSize: '13px', color: r.build.now > 0 ? '#22c55e' : 'var(--text-muted)' }}>{r.build.now}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: r.build.withOnOrder > r.build.now ? '#60a5fa' : 'var(--text-muted)' }}>{r.build.withOnOrder}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--text-secondary)' }}>
                          {limit && (
                            <>
                              <span style={{ fontWeight: 700 }}>{limit.item_number}</span>
                              {!limit.in_catalog
                                ? <span style={{ color: '#f59e0b' }}> · not in NetSuite</span>
                                : <span style={{ color: 'var(--text-muted)' }}> · {limit.free} free, {limit.per_kit} per rack</span>}
                            </>
                          )}
                        </td>
                      </tr>
                      {open === id && (
                        <tr>
                          <td colSpan={showPrice ? 5 : 4} style={{ padding: '0 10px 10px 28px' }}>
                            <RackPhotoSlot
                              kit={r.kit}
                              hasTwin={rows.some(o => o.kit.id !== id && rackBaseNumber(o.kit.item_number || '') === rackBaseNumber(r.kit.item_number || ''))}
                              canEdit={canEditPhotos}
                              onPhoto={(f, twin) => setKitPhoto(r.kit, f, twin)}
                            />
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                              <thead>
                                <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                                  <th style={{ padding: '4px 6px', fontWeight: 700 }}>Component</th>
                                  <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>Per rack</th>
                                  <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>Free</th>
                                  <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>On order</th>
                                  <th style={{ padding: '4px 6px', fontWeight: 700, textAlign: 'right' }}>Covers</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.build.components.map(c => {
                                  const member = r.kit.members.find(m => normItem(m.part.item_number) === c.item_number);
                                  const miss = r.kit.missing.find(m => normItem(m.item_number) === c.item_number);
                                  return (
                                    <tr key={c.item_number} style={{ borderTop: '1px solid var(--border)' }}>
                                      <td style={{ padding: '4px 6px' }}>
                                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{c.item_number}</span>
                                        <span style={{ color: 'var(--text-muted)' }}> {member?.part.display_name || member?.part.description || miss?.description || ''}</span>
                                        {!c.in_catalog && <span style={{ color: '#f59e0b', fontWeight: 700 }}> · not in NetSuite</span>}
                                      </td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right' }}>{c.per_kit}</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700 }}>{c.free}</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', color: c.on_order > 0 ? '#60a5fa' : 'var(--text-muted)' }}>{c.on_order}</td>
                                      <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700, color: c.item_number === r.build.bottleneck ? '#f87171' : 'var(--text-secondary)' }}>{c.covers}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RackPhotoSlot({ kit, hasTwin, canEdit, onPhoto }: {
  kit: KitWithMembers;
  hasTwin: boolean;
  canEdit: boolean;
  onPhoto: (file: File, alsoTwin: boolean) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [alsoTwin, setAlsoTwin] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const take = async (f: File) => {
    setBusy(true);
    setErr('');
    try { await onPhoto(f, hasTwin && alsoTwin); } catch (e: any) { setErr(e?.message || 'Photo upload failed'); }
    setBusy(false);
  };
  const { dragging, dropProps } = useImageDrop(f => { void take(f); }, { disabled: !canEdit || busy });
  const src = kit.image_path ? storage.from('photos').getPublicUrl(kit.image_path).data.publicUrl : null;
  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap', padding: '8px 0' }}>
      <div
        {...dropProps}
        onClick={() => canEdit && !busy && inputRef.current?.click()}
        style={{
          width: '160px', height: '110px', borderRadius: '10px', overflow: 'hidden', flexShrink: 0,
          border: `2px dashed ${dragging ? '#60a5fa' : 'var(--border)'}`, background: 'var(--input-bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          cursor: canEdit ? 'pointer' : 'default', fontSize: '10px', color: 'var(--text-muted)', padding: src ? 0 : '6px',
        }}
      >
        {busy ? 'Uploading…' : src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt={kit.item_number || kit.name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          : canEdit ? 'Drop a photo here, paste one, or click to choose' : 'No photo yet'}
      </div>
      {canEdit && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
          <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} style={{ padding: '6px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', alignSelf: 'flex-start' }}>
            {src ? 'Replace photo' : 'Add photo'}
          </button>
          {hasTwin && (
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={alsoTwin} onChange={e => setAlsoTwin(e.target.checked)} />
              Use it for the silver and black versions too
            </label>
          )}
          <span style={{ color: 'var(--text-muted)' }}>Shows on the rack kit cards when building an estimate.</span>
          {err && <span style={{ color: '#f87171', fontWeight: 700 }}>{err}</span>}
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*,.heic,.heif" style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void take(f); }} />
    </div>
  );
}
