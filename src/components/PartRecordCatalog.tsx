'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { storage } from '@/lib/storage';
import { toJpegIfHeic } from '@/lib/heic';
import { useImageDrop } from '@/lib/use-image-drop';
import type { LightboxPhoto } from '@/components/PhotoLightbox';

/**
 * The catalog half of a part record on the Parts page (Craig 2026-10-28:
 * one Parts list, the Visual Catalog tab retired): the photo, the
 * marketing description, vehicle fitment and the browse category — what
 * used to live only in the Visual Catalog's record.
 *
 * Photos: everyone sees them; tap one for full size. Admins and Part Admin
 * holders add or change one with the button (camera or file) or by dropping
 * or pasting a picture. There's deliberately no remove. Fits and category
 * stay admin-only, as they were in the Visual Catalog.
 */

export interface CatalogRecordPart {
  id: string;
  item_number: string;
  display_name: string | null;
  image_path: string | null;
  marketing_description: string | null;
  product_category_id?: string | null;
}

interface FitmentRow { id: string; platform_id: string; wheelbase_label: string | null; roof_label: string | null; source: string }
interface Platform { id: string; label: string; body_type: string; config: { wheelbases?: string[]; roofs?: string[] } | null }
interface Category { id: string; name: string }

export const partPhotoUrl = (path: string) => storage.from('photos').getPublicUrl(path).data.publicUrl;

export default function PartRecordCatalog({ part, canEditPhoto, isAdmin, onPhotoSaved, onCategorySaved, onZoom }: {
  part: CatalogRecordPart;
  canEditPhoto: boolean;
  isAdmin: boolean;
  onPhotoSaved: (path: string) => void;
  onCategorySaved: (categoryId: string | null) => void;
  onZoom: (photo: LightboxPhoto) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const [fitment, setFitment] = useState<FitmentRow[] | null>(null);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [fitPlatformId, setFitPlatformId] = useState('');
  const [fitWheelbase, setFitWheelbase] = useState('');
  const [fitRoof, setFitRoof] = useState('');
  const [fitBusy, setFitBusy] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      supabase.from('part_fitment').select('id, platform_id, wheelbase_label, roof_label, source').eq('part_id', part.id),
      supabase.from('vehicle_platforms').select('id, label, body_type, config').eq('active', true).order('sort_order'),
      supabase.from('product_categories').select('id, name').eq('active', true).order('sort_order').order('name'),
    ]).then(([fit, plats, cats]) => {
      if (cancelled) return;
      setFitment((fit.data as FitmentRow[] | null) || []);
      setPlatforms((plats.data as Platform[] | null) || []);
      setCategories((cats.data as Category[] | null) || []);
    });
    return () => { cancelled = true; };
  }, [part.id]);

  const uploadPhoto = async (picked: File) => {
    setUploading(true);
    setPhotoError('');
    try {
      const file = await toJpegIfHeic(picked);
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `parts/${part.id}/manual-${Date.now()}.${ext}`;
      const { error } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (error) throw new Error(error.message || 'Upload failed');
      const res = await fetch(`/api/parts/${part.id}/photo`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imagePath: path }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error(d?.error || `Save failed (${res.status})`);
      onPhotoSaved(path);
    } catch (e: any) {
      setPhotoError(`Photo not saved: ${e?.message || 'something went wrong'}`);
    } finally {
      setUploading(false);
    }
  };

  const { dragging, dropProps } = useImageDrop(f => { void uploadPhoto(f); }, { disabled: !canEditPhoto || uploading });

  const addFitment = async () => {
    if (!fitPlatformId) return;
    setFitBusy(true);
    try {
      const supabase = createClient();
      const { data: u } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('part_fitment')
        .insert({
          part_id: part.id, platform_id: fitPlatformId,
          wheelbase_label: fitWheelbase || null, roof_label: fitRoof || null,
          source: 'manual', created_by: u?.user?.id || null,
        })
        .select('id, platform_id, wheelbase_label, roof_label, source')
        .single();
      // A unique-index conflict means the tag already exists — nothing to add.
      if (!error && data) setFitment(prev => [...(prev || []), data as FitmentRow]);
    } finally {
      setFitBusy(false);
      setFitWheelbase('');
      setFitRoof('');
    }
  };

  const removeFitment = async (rowId: string) => {
    const { error } = await createClient().from('part_fitment').delete().eq('id', rowId);
    if (!error) setFitment(prev => (prev || []).filter(r => r.id !== rowId));
  };

  const setCategory = async (categoryId: string | null) => {
    setCategoryBusy(true);
    try {
      const res = await fetch('/api/parts/categorize', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partId: part.id, productCategoryId: categoryId }),
      });
      if (res.ok) onCategorySaved(categoryId);
    } finally {
      setCategoryBusy(false);
    }
  };

  const label: CSSProperties = { fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '4px' };
  const chip: CSSProperties = { fontSize: '11px', fontWeight: 600, padding: '3px 9px', borderRadius: '999px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' };
  const sel: CSSProperties = { padding: '6px 8px', borderRadius: '7px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '11px' };
  const fitCfg = platforms.find(p => p.id === fitPlatformId)?.config;
  const categoryName = categories.find(c => c.id === part.product_category_id)?.name;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ width: '200px', maxWidth: '100%', flexShrink: 0 }}>
          <div
            {...(canEditPhoto ? dropProps : {})}
            style={{
              aspectRatio: '4/3', background: '#fff', border: '1px solid var(--border)', borderRadius: '8px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative',
              outline: dragging ? '2px dashed #60a5fa' : 'none', outlineOffset: '-2px',
            }}
          >
            {dragging && (
              <div style={{ position: 'absolute', inset: 0, zIndex: 1, background: 'rgba(96,165,250,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 800, color: '#2563eb', pointerEvents: 'none' }}>
                Drop to {part.image_path ? 'replace' : 'add'} the photo
              </div>
            )}
            {uploading && !dragging && (
              <div style={{ position: 'absolute', top: '6px', left: '6px', padding: '3px 8px', borderRadius: '6px', background: 'var(--card)', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>Uploading…</div>
            )}
            {part.image_path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={partPhotoUrl(part.image_path)}
                alt={part.display_name || part.item_number}
                onClick={() => onZoom({
                  id: part.id,
                  url: partPhotoUrl(part.image_path!),
                  title: part.item_number,
                  subtitle: part.display_name && part.display_name !== part.item_number ? part.display_name : null,
                })}
                title="Tap to see the full size picture"
                style={{ width: '100%', height: '100%', objectFit: 'contain', cursor: 'zoom-in' }}
              />
            ) : (
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#6b7684' }}>No photo</span>
            )}
            {canEditPhoto && (
              <button
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                style={{ position: 'absolute', bottom: '6px', right: '6px', padding: '5px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', color: 'var(--text-primary)' }}
              >{part.image_path ? 'Change photo' : 'Add photo'}</button>
            )}
          </div>
          {canEditPhoto && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>
              On a computer you can also drag a picture onto the box or paste one.
            </div>
          )}
          {photoError && <div style={{ fontSize: '11px', color: 'var(--error)', marginTop: '4px' }}>{photoError}</div>}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void uploadPhoto(f); }}
          />
        </div>
        <div style={{ flex: 1, minWidth: '180px' }}>
          <div style={label}>Marketing Description</div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {part.marketing_description || '—'}
          </div>
        </div>
      </div>

      {/* Fits — vehicle fitment tags; they drive Browse Catalog's vehicle
          narrowing, so pruning a wrong auto-tag here fixes it everywhere. */}
      <div>
        <div style={label}>Fits</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {(fitment || []).map(f => {
            const plat = platforms.find(p => p.id === f.platform_id);
            return (
              <span key={f.id} style={chip}>
                <span>
                  {plat?.label || 'Unknown vehicle'}
                  {f.roof_label ? ` · ${f.roof_label} roof` : ''}
                  {f.wheelbase_label ? ` · ${/^\d/.test(f.wheelbase_label) ? `${f.wheelbase_label}"` : f.wheelbase_label}` : ''}
                </span>
                {isAdmin && (
                  <button onClick={() => removeFitment(f.id)} title="Remove this fitment tag" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '11px', padding: 0, lineHeight: 1 }}>✕</button>
                )}
              </span>
            );
          })}
          {fitment !== null && fitment.length === 0 && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No vehicle tags</span>
          )}
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={fitPlatformId} onChange={e => { setFitPlatformId(e.target.value); setFitWheelbase(''); setFitRoof(''); }} style={{ ...sel, minWidth: '160px' }}>
              <option value="">+ Add vehicle…</option>
              <optgroup label="Vans">{platforms.filter(p => p.body_type === 'van').map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
              <optgroup label="Trucks">{platforms.filter(p => p.body_type === 'truck').map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
            </select>
            {fitPlatformId && (fitCfg?.roofs?.length || 0) > 0 && (
              <select value={fitRoof} onChange={e => setFitRoof(e.target.value)} style={sel}>
                <option value="">any roof</option>
                {fitCfg!.roofs!.map(r => <option key={r} value={r}>{r} roof</option>)}
              </select>
            )}
            {fitPlatformId && (fitCfg?.wheelbases?.length || 0) > 0 && (
              <select value={fitWheelbase} onChange={e => setFitWheelbase(e.target.value)} style={sel}>
                <option value="">any wheelbase</option>
                {fitCfg!.wheelbases!.map(w => <option key={w} value={w}>{/^\d/.test(w) ? `${w}" WB` : w}</option>)}
              </select>
            )}
            {fitPlatformId && (
              <button onClick={addFitment} disabled={fitBusy} style={{ padding: '6px 14px', borderRadius: '7px', border: 'none', background: 'var(--accent)', color: '#fff', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}>
                {fitBusy ? 'Adding…' : 'Add'}
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        <div style={label}>Category</div>
        {isAdmin ? (
          <select value={part.product_category_id || ''} disabled={categoryBusy} onChange={e => setCategory(e.target.value || null)} style={{ ...sel, minWidth: '160px' }}>
            <option value="">No category</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        ) : (
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{categoryName || 'No category'}</div>
        )}
      </div>
    </div>
  );
}
