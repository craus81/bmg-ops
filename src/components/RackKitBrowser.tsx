'use client';

import { useEffect, useMemo, useState } from 'react';
import { storage } from '@/lib/storage';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import PhotoLightbox, { type LightboxPhoto } from '@/components/PhotoLightbox';
import { kitBuildableFor, loadKits, loadKitStock, type KitStock, type KitWithMembers } from '@/lib/part-kits';
import { rackBaseNumber, rackFacets, rackMatchesSearch, type RackFacets } from '@/lib/rack-kit-facets';

/**
 * Browse every rack kit (Craig 2026-10-20): one list with a search box and
 * filters for vehicle, AluRack / ErgoRack, silver / black and rack style.
 * Each card shows the kit's photo (or its silver/black twin's, or a
 * component's), price, how many can be built from stock, and the parts
 * inside, with Add rack.
 *
 * Two homes: the estimate builder's "Rack kits" button (RackKitBrowserModal)
 * and the Rack kits view of the Parts Catalog browser.
 */

const PAGE = 24;
const imageUrl = (path: string) => storage.from('photos').getPublicUrl(path).data.publicUrl;
const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Row {
  kit: KitWithMembers;
  facets: RackFacets;
  photo: string | null;
}

export default function RackKitBrowser({ onAdd, addLabel = 'Add rack', showPrice }: {
  onAdd?: (kit: KitWithMembers) => void;
  addLabel?: string;
  showPrice: boolean;
}) {
  const [kits, setKits] = useState<KitWithMembers[] | null>(null);
  const [stock, setStock] = useState<Map<string, KitStock> | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [line, setLine] = useState('');
  const [finish, setFinish] = useState('');
  const [style, setStyle] = useState('');
  const [inStockOnly, setInStockOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  // Tap a rack picture to see it big; swipe moves through the kits shown.
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);
  const [openParts, setOpenParts] = useState<Record<string, boolean>>({});
  const [added, setAdded] = useState<Record<string, number>>({});

  useEffect(() => {
    const supabase = createClient();
    let live = true;
    loadKits(supabase)
      .then(async ks => {
        const racks = ks.filter(k => k.item_number);
        if (!live) return;
        setKits(racks);
        // Stock is a nice-to-have on the card: the list still works without it.
        try {
          const s = await loadKitStock(supabase, racks);
          if (live) setStock(s);
        } catch { /* leave stock unknown */ }
      })
      .catch(e => { if (live) setError(e?.message || 'Could not load rack kits'); });
    return () => { live = false; };
  }, []);

  const rows: Row[] = useMemo(() => {
    if (!kits) return [];
    const ownPhoto = new Map<string, string>();
    for (const k of kits) if (k.image_path) ownPhoto.set(rackBaseNumber(k.item_number || ''), k.image_path);
    return kits.map(kit => ({
      kit,
      facets: rackFacets(kit),
      photo: kit.image_path
        || ownPhoto.get(rackBaseNumber(kit.item_number || ''))
        || kit.members.find(m => m.part.image_path)?.part.image_path
        || null,
    })).sort((a, b) => String(a.kit.item_number).localeCompare(String(b.kit.item_number)));
  }, [kits]);

  const buildable = useMemo(() => {
    const m = new Map<string, number>();
    if (stock) for (const r of rows) m.set(r.kit.id, kitBuildableFor(r.kit, stock).now);
    return m;
  }, [rows, stock]);

  const vehicles = useMemo(() => [...new Set(rows.map(r => r.facets.vehicle))].sort(), [rows]);
  const styles = useMemo(() => [...new Set(rows.map(r => r.facets.style))].sort(), [rows]);

  const visible = rows.filter(r =>
    (!vehicle || r.facets.vehicle === vehicle)
    && (!line || r.facets.line === line)
    && (!finish || r.facets.finish === finish)
    && (!style || r.facets.style === style)
    && (!inStockOnly || (buildable.get(r.kit.id) || 0) > 0)
    && rackMatchesSearch(r.kit, r.facets, search));
  const zoomPhotos: LightboxPhoto[] = visible.slice(0, limit).filter(r => r.photo).map(r => ({
    id: r.kit.id,
    url: imageUrl(r.photo!),
    title: r.kit.item_number || r.kit.name,
    subtitle: r.kit.item_number ? r.kit.name : null,
  }));
  const openPhoto = (kitId: string) => {
    const i = zoomPhotos.findIndex(p => p.id === kitId);
    if (i >= 0) setZoomIdx(i);
  };

  // Any filter change starts the list from the top again.
  useEffect(() => { setLimit(PAGE); }, [search, vehicle, line, finish, style, inStockOnly]);

  const label: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' };
  const sel: React.CSSProperties = { width: '100%', padding: '7px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600 };
  const chip = (on: boolean): React.CSSProperties => ({
    padding: '5px 11px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
    background: on ? 'rgba(59,130,246,0.2)' : 'var(--card)',
    border: `1px solid ${on ? 'rgba(59,130,246,0.5)' : 'var(--border)'}`,
    color: on ? '#60a5fa' : 'var(--text-secondary)',
  });
  const chips = (value: string, set: (v: string) => void, opts: string[]) => (
    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
      {['', ...opts].map(o => (
        <button key={o || 'all'} type="button" aria-pressed={value === o} onClick={() => set(o)} style={chip(value === o)}>{o || 'All'}</button>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: 0 }}>
      <input
        type="search"
        aria-label="Search rack kits"
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="Search rack #, vehicle or words (e.g. transit high roof, AR19)…"
        style={{ width: '100%', padding: '9px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px' }}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
        <div>
          <div style={label}>Vehicle</div>
          <select aria-label="Vehicle" value={vehicle} onChange={e => setVehicle(e.target.value)} style={sel}>
            <option value="">All vehicles</option>
            {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div><div style={label}>Line</div>{chips(line, setLine, ['AluRack', 'ErgoRack'])}</div>
        <div><div style={label}>Finish</div>{chips(finish, setFinish, ['Silver', 'Black'])}</div>
        <div>
          <div style={label}>Style</div>
          <select aria-label="Style" value={style} onChange={e => setStyle(e.target.value)} style={sel}>
            <option value="">All styles</option>
            {styles.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        {stock && (
          <button type="button" aria-pressed={inStockOnly} onClick={() => setInStockOnly(v => !v)} style={chip(inStockOnly)}>Buildable from stock only</button>
        )}
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {kits === null && !error ? 'Loading rack kits…' : `${visible.length} of ${rows.length} rack kits`}
        </span>
      </div>

      {error && <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(248,113,113,0.1)', color: '#f87171', fontSize: '12px' }}>{error}</div>}
      {kits !== null && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>No rack kits match. Clear a filter or the search.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '12px' }}>
        {visible.slice(0, limit).map(({ kit, facets, photo }) => {
          const n = buildable.get(kit.id);
          const partsOpen = !!openParts[kit.id];
          const partCount = kit.members.length + kit.missing.length;
          return (
            <div key={kit.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <div style={{ height: '120px', background: 'var(--subtle-bg, rgba(128,128,128,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl(photo)}
                    alt={kit.item_number || kit.name}
                    loading="lazy"
                    onClick={() => openPhoto(kit.id)}
                    title="Tap to enlarge the picture"
                    style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'zoom-in' }}
                  />
                ) : (
                  <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', opacity: 0.7 }}>No photo yet</span>
                )}
              </div>
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{kit.item_number}</div>
                <div title={kit.name} style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: '2.7em' }}>{kit.name}</div>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {[facets.vehicle, facets.line, facets.finish, facets.style !== 'Fixed' ? facets.style : null].filter(Boolean).map(t => (
                    <span key={t as string} style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--subtle-bg, rgba(128,128,128,0.12))', color: 'var(--text-secondary)' }}>{t}</span>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginTop: 'auto' }}>
                  {showPrice ? (
                    <span style={{ fontWeight: 800, color: '#22c55e' }}>
                      {money(kit.totalPrice)}
                      {kit.missing.length > 0 && <span style={{ fontSize: '9px', color: '#f59e0b', fontWeight: 700 }}> incomplete</span>}
                    </span>
                  ) : <span />}
                  {n !== undefined && (
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '4px', background: n > 0 ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)', color: n > 0 ? '#22c55e' : '#f59e0b' }}>
                      {n > 0 ? `Can build ${n}` : 'Needs ordering'}
                    </span>
                  )}
                </div>
              </div>
              {partsOpen && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px' }}>
                  {kit.members.map((m, i) => (
                    <div key={`${m.part.id}-${i}`} style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{m.quantity}× {m.part.item_number}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{m.part.display_name || m.part.description || ''}</span>
                    </div>
                  ))}
                  {kit.missing.map(m => (
                    <div key={`miss-${m.item_number}`} style={{ display: 'flex', gap: '6px' }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{m.quantity}× {m.item_number}</span>
                      <span style={{ color: '#f59e0b' }}>not in NetSuite yet</span>
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '6px', padding: '0 12px 12px' }}>
                <button type="button" onClick={() => setOpenParts(p => ({ ...p, [kit.id]: !p[kit.id] }))}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                  {partsOpen ? 'Hide parts' : `Parts (${partCount})`}
                </button>
                {onAdd && (
                  <button type="button" onClick={() => { onAdd(kit); setAdded(a => ({ ...a, [kit.id]: (a[kit.id] || 0) + 1 })); }}
                    style={{ flex: 1, padding: '6px 8px', borderRadius: '8px', border: 'none', background: added[kit.id] ? 'rgba(34,197,94,0.15)' : 'var(--accent, #2563eb)', color: added[kit.id] ? '#22c55e' : '#fff', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}>
                    {added[kit.id] ? `✓ Added ×${added[kit.id]}` : addLabel}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {visible.length > limit && (
        <div style={{ textAlign: 'center' }}>
          <button type="button" onClick={() => setLimit(l => l + PAGE)} style={{ padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
            Show more ({visible.length - limit} left)
          </button>
        </div>
      )}
      <PhotoLightbox
        photos={zoomPhotos}
        index={zoomIdx}
        onClose={() => setZoomIdx(null)}
        onIndex={setZoomIdx}
        printHeading="Rack kits"
      />
    </div>
  );
}

/** The estimate builder's Rack kits window. */
export function RackKitBrowserModal({ open, onClose, onAdd, showPrice }: {
  open: boolean;
  onClose: () => void;
  onAdd: (kit: KitWithMembers) => void;
  showPrice: boolean;
}) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} ref={closeOnEscape(onClose)}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg, var(--card))', borderRadius: '16px', width: '100%', maxWidth: '1100px', height: 'calc(88vh / var(--ts))', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: '16px', fontWeight: 800 }}>Rack kits</div>
          <span style={{ flex: 1 }} />
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 16px' }}>
          <RackKitBrowser onAdd={onAdd} showPrice={showPrice} />
        </div>
      </div>
    </div>
  );
}
