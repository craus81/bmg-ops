'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { storage } from '@/lib/storage';

/**
 * The Ranger-Design-style catalog browser (roadmap N4-A): a faceted,
 * visual view over netsuite_parts — category and vendor rails, product
 * cards with photos, and a per-part record modal (photo, marketing
 * description, pricing). Admins stock the shelf from right here: assign a
 * category, upload a photo, add categories to the vocabulary.
 *
 * ONE component, two homes (Craig 2026-08-11: "parts catalog and browse
 * catalog should be the same thing"):
 *   - variant="modal": the estimate builder's Browse Catalog overlay,
 *     with onAdd wired to add parts to the estimate
 *   - variant="inline": the /parts page's Visual Catalog view (no onAdd)
 * Server-paginated — the catalog is unbounded.
 */

export interface BrowsePart {
  id: string;
  netsuite_id: string | null;
  item_number: string;
  display_name: string | null;
  description: string | null;
  marketing_description: string | null;
  catalog: string;
  item_type: string | null;
  vendor: string | null;
  sales_price: number | null;
  purchase_price: number | null;
  avg_install_cost: number | null;
  labor_hours: number | null;
  quantity_available: number | null;
  product_category_id: string | null;
  image_path: string | null;
}

interface Category { id: string; name: string; sort_order: number }

const money = (v: number | null | undefined) =>
  v || v === 0 ? `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—';

export default function PartCatalogBrowser({ open, onClose, onAdd, isAdmin, variant = 'modal' }: {
  open: boolean;
  onClose?: () => void;
  /** When set (estimate builder), cards and the record modal get an Add button. */
  onAdd?: (part: BrowsePart) => void;
  isAdmin: boolean;
  /** 'modal' floats over the page; 'inline' renders the same browser as a
   *  page section (the /parts Visual Catalog view). */
  variant?: 'modal' | 'inline';
}) {
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [vendor, setVendor] = useState('');
  const [catalog, setCatalog] = useState('');
  const [sort, setSort] = useState<'name' | 'price_asc' | 'price_desc'>('name');
  const [parts, setParts] = useState<BrowsePart[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [vendors, setVendors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Record<string, number>>({});
  const [newCategory, setNewCategory] = useState('');
  const [busyPart, setBusyPart] = useState<string | null>(null);
  // The part whose record modal is open (click a card to view it).
  const [detail, setDetail] = useState<BrowsePart | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoTargetRef = useRef<string | null>(null);

  const buildUrl = useCallback((p: number) => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (categoryId === '__none__') params.set('uncategorized', '1');
    else if (categoryId) params.set('categoryId', categoryId);
    if (vendor) params.set('vendor', vendor);
    if (catalog) params.set('catalog', catalog);
    if (sort !== 'name') params.set('sort', sort);
    if (p > 0) params.set('page', String(p));
    return `/api/parts/browse?${params.toString()}`;
  }, [q, categoryId, vendor, catalog, sort]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(buildUrl(0));
        const d = await res.json();
        if (res.ok) {
          setParts(d.parts || []);
          setTotal(d.total || 0);
          setPage(0);
          if (d.categories) setCategories(d.categories);
          if (d.vendors) setVendors(d.vendors);
        }
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [open, buildUrl]);

  const loadMore = async () => {
    const res = await fetch(buildUrl(page + 1));
    const d = await res.json();
    if (res.ok) {
      setParts(prev => [...prev, ...(d.parts || [])]);
      setPage(page + 1);
    }
  };

  const imageUrl = (path: string) => storage.from('photos').getPublicUrl(path).data.publicUrl;

  const setPartCategory = async (partId: string, id: string | null) => {
    setBusyPart(partId);
    try {
      const res = await fetch('/api/parts/categorize', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partId, productCategoryId: id }),
      });
      if (res.ok) {
        setParts(prev => prev.map(p => p.id === partId ? { ...p, product_category_id: id } : p));
        setDetail(d => d && d.id === partId ? { ...d, product_category_id: id } : d);
      }
    } finally {
      setBusyPart(null);
    }
  };

  const uploadPhoto = async (partId: string, file: File) => {
    setBusyPart(partId);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `parts/${partId}/manual-${Date.now()}.${ext}`;
      const { error } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (error) return;
      const res = await fetch('/api/parts/categorize', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partId, imagePath: path }),
      });
      if (res.ok) {
        setParts(prev => prev.map(p => p.id === partId ? { ...p, image_path: path } : p));
        setDetail(d => d && d.id === partId ? { ...d, image_path: path } : d);
      }
    } finally {
      setBusyPart(null);
    }
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    const res = await fetch('/api/parts/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const d = await res.json();
    if (res.ok && d.category) {
      setCategories(prev => [...prev, d.category]);
      setNewCategory('');
    }
  };

  const addPart = (p: BrowsePart) => {
    if (!onAdd) return;
    onAdd(p);
    setAdded(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }));
  };

  if (!open) return null;

  const selStyle: React.CSSProperties = { width: '100%', padding: '7px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600 };
  const chip: React.CSSProperties = { fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '5px', background: 'var(--subtle-bg, rgba(128,128,128,0.12))', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' };
  const detailCategoryName = detail?.product_category_id
    ? categories.find(c => c.id === detail.product_category_id)?.name || null
    : null;

  const body = (
    <>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: '16px', fontWeight: 800 }}>Parts Catalog</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{loading ? 'Loading…' : `${total.toLocaleString()} part${total === 1 ? '' : 's'}`}</div>
        <span style={{ flex: 1 }} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search part #, name, description…"
          style={{ width: '300px', maxWidth: '45vw', padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '13px' }}
        />
        {variant === 'modal' && onClose && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Facet rail */}
        <div style={{ width: '210px', flexShrink: 0, borderRight: '1px solid var(--border)', padding: '12px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Category</div>
            <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={selStyle}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="__none__">— Uncategorized —</option>
            </select>
            {isAdmin && (
              <div style={{ display: 'flex', gap: '4px', marginTop: '6px' }}>
                <input value={newCategory} onChange={e => setNewCategory(e.target.value)} placeholder="New category" style={{ ...selStyle, fontWeight: 400 }} onKeyDown={e => { if (e.key === 'Enter') addCategory(); }} />
                <button onClick={addCategory} style={{ padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '12px', fontWeight: 800, cursor: 'pointer', color: 'var(--text-primary)' }}>+</button>
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Vendor</div>
            <select value={vendor} onChange={e => setVendor(e.target.value)} style={selStyle}>
              <option value="">All vendors</option>
              {vendors.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Catalog</div>
            <select value={catalog} onChange={e => setCatalog(e.target.value)} style={selStyle}>
              <option value="">Upfit + Graphics</option>
              <option value="upfit">Upfit</option>
              <option value="graphics">Graphics</option>
            </select>
          </div>
          <div>
            <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-muted)', marginBottom: '4px' }}>Sort</div>
            <select value={sort} onChange={e => setSort(e.target.value as typeof sort)} style={selStyle}>
              <option value="name">Part number</option>
              <option value="price_asc">Price: low → high</option>
              <option value="price_desc">Price: high → low</option>
            </select>
          </div>
          {isAdmin && (
            <a
              href="/admin/import-vendor-assets"
              style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent, #2563eb)', textDecoration: 'none', marginTop: 'auto' }}
            >
              ⬇ Import photos &amp; descriptions from a vendor site…
            </a>
          )}
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px' }}>
          {!loading && parts.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>No parts match these filters.</div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px' }}>
            {parts.map(p => (
              <div key={p.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div
                  onClick={() => setDetail(p)}
                  title="View part record"
                  style={{ aspectRatio: '4/3', background: 'var(--subtle-bg, rgba(128,128,128,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', cursor: 'pointer' }}
                >
                  {p.image_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl(p.image_path)} alt={p.display_name || p.item_number} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span style={{ fontSize: '28px', opacity: 0.35 }}>🧰</span>
                  )}
                  {isAdmin && (
                    <button
                      onClick={e => { e.stopPropagation(); photoTargetRef.current = p.id; photoInputRef.current?.click(); }}
                      disabled={busyPart === p.id}
                      title="Upload product photo"
                      style={{ position: 'absolute', bottom: '6px', right: '6px', padding: '3px 7px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', cursor: 'pointer' }}
                    >📷</button>
                  )}
                </div>
                <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                  <div onClick={() => setDetail(p)} title="View part record" style={{ cursor: 'pointer' }}>
                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                      {p.display_name || p.item_number}
                    </div>
                    <div style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                      {p.item_number}{p.vendor ? ` · ${p.vendor}` : ''}
                    </div>
                    {(p.marketing_description || p.description) && (
                      <div style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {p.marketing_description || p.description}
                      </div>
                    )}
                  </div>
                  <span style={{ flex: 1 }} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {p.sales_price ? money(p.sales_price) : '—'}
                    </span>
                    {(p.labor_hours || 0) > 0 && <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{p.labor_hours}h labor</span>}
                    <span style={{ flex: 1 }} />
                    {onAdd ? (
                      <button
                        onClick={() => addPart(p)}
                        style={{ padding: '5px 12px', borderRadius: '8px', border: 'none', background: added[p.id] ? 'rgba(34,197,94,0.15)' : 'var(--accent, #2563eb)', color: added[p.id] ? '#22c55e' : '#fff', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}
                      >
                        {added[p.id] ? `✓ ×${added[p.id]}` : '+ Add'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setDetail(p)}
                        style={{ padding: '5px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}
                      >
                        View
                      </button>
                    )}
                  </div>
                  {isAdmin && (
                    <select
                      value={p.product_category_id || ''}
                      disabled={busyPart === p.id}
                      onChange={e => setPartCategory(p.id, e.target.value || null)}
                      style={{ ...selStyle, fontSize: '10px', padding: '4px 6px', marginTop: '2px' }}
                      title="Set browse category"
                    >
                      <option value="">No category</option>
                      {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
              </div>
            ))}
          </div>
          {parts.length < total && (
            <div style={{ textAlign: 'center', padding: '14px' }}>
              <button onClick={loadMore} style={{ padding: '8px 18px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                Load more ({parts.length} of {total.toLocaleString()})
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Shared hidden input for photo uploads (cards + record modal) */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={async e => {
          const f = e.target.files?.[0];
          e.target.value = '';
          const target = photoTargetRef.current;
          if (f && target) await uploadPhoto(target, f);
        }}
      />

      {/* Part record modal — click a card to get here. The imported photo
          and marketing description live on this record; "Open full record"
          jumps to the ops list row (sync, files, labor, price edits). */}
      {detail && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={() => setDetail(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg, var(--card))', borderRadius: '16px', border: '1px solid var(--border)', width: '100%', maxWidth: '720px', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--bg, var(--card))', zIndex: 1, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'monospace', fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{detail.item_number}</span>
              {detail.vendor && <span style={chip}>{detail.vendor}</span>}
              <span style={chip}>{detail.catalog}</span>
              {detailCategoryName && <span style={chip}>{detailCategoryName}</span>}
              <span style={{ flex: 1 }} />
              <button onClick={() => setDetail(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ aspectRatio: '16/9', background: 'var(--subtle-bg, rgba(128,128,128,0.08))', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' }}>
                {detail.image_path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={imageUrl(detail.image_path)} alt={detail.display_name || detail.item_number} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                ) : (
                  <span style={{ fontSize: '42px', opacity: 0.35 }}>🧰</span>
                )}
                {isAdmin && (
                  <button
                    onClick={() => { photoTargetRef.current = detail.id; photoInputRef.current?.click(); }}
                    disabled={busyPart === detail.id}
                    style={{ position: 'absolute', bottom: '8px', right: '8px', padding: '5px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', color: 'var(--text-primary)' }}
                  >📷 {detail.image_path ? 'Change photo' : 'Add photo'}</button>
                )}
              </div>

              <div style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1.3 }}>
                {detail.display_name || detail.item_number}
              </div>

              {detail.marketing_description && (
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                  {detail.marketing_description}
                </div>
              )}
              {detail.description && detail.description !== detail.marketing_description && (
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', marginBottom: '2px' }}>NetSuite description</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{detail.description}</div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '10px' }}>
                <RecordFact label="Sales Price" value={money(detail.sales_price)} strong />
                <RecordFact label="Labor" value={(detail.labor_hours || 0) > 0 ? `${detail.labor_hours}h` : '—'} />
                <RecordFact label="Qty Available" value={detail.quantity_available != null ? String(detail.quantity_available) : '—'} />
                {isAdmin && <RecordFact label="Purchase Price" value={money(detail.purchase_price)} />}
                {isAdmin && detail.avg_install_cost != null && <RecordFact label="Avg Installer Cost" value={money(detail.avg_install_cost)} />}
              </div>

              {isAdmin && (
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', marginBottom: '4px' }}>Browse category</div>
                  <select
                    value={detail.product_category_id || ''}
                    disabled={busyPart === detail.id}
                    onChange={e => setPartCategory(detail.id, e.target.value || null)}
                    style={selStyle}
                  >
                    <option value="">No category</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                {onAdd && (
                  <button
                    onClick={() => addPart(detail)}
                    style={{ padding: '9px 18px', borderRadius: '9px', border: 'none', background: added[detail.id] ? 'rgba(34,197,94,0.15)' : 'var(--accent, #2563eb)', color: added[detail.id] ? '#22c55e' : '#fff', fontSize: '12px', fontWeight: 800, cursor: 'pointer' }}
                  >
                    {added[detail.id] ? `✓ Added ×${added[detail.id]}` : '+ Add to estimate'}
                  </button>
                )}
                {isAdmin && (
                  <a
                    href={`/parts?catalog=${detail.catalog}&q=${encodeURIComponent(detail.item_number)}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent, #2563eb)', textDecoration: 'none' }}
                  >
                    Open full record (sync, files, price edits) ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (variant === 'inline') {
    return (
      <div style={{ background: 'var(--bg, var(--card))', border: '1px solid var(--border)', borderRadius: '16px', height: 'calc(100vh - 230px)', minHeight: '480px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {body}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg, var(--card))', borderRadius: '16px', width: '100%', maxWidth: '1100px', height: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
        {body}
      </div>
    </div>
  );
}

function RecordFact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '9px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</div>
      <div style={{ fontSize: strong ? '15px' : '13px', fontWeight: 800, color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
