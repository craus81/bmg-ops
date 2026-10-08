'use client';

import { useEffect, useRef, useState } from 'react';
import { storage } from '@/lib/storage';
import { toJpegIfHeic } from '@/lib/heic';
import { closeOnEscape } from '@/lib/modal-escape';
import { createClient } from '@/lib/supabase-browser';

export interface CreatedPart {
  id: string;
  /** NetSuite internal id — what estimate/PO lines need to reference the item. */
  netsuite_id: string | null;
  item_number: string;
  display_name: string | null;
  billable_customer: string | null;
  sales_price: number | null;
  catalog?: string | null;
}

const ITEM_TYPES: { value: string; label: string }[] = [
  { value: 'serviceSaleItem', label: 'Service — For Sale' },
  { value: 'serviceResaleItem', label: 'Service — For Resale' },
  { value: 'nonInventorySaleItem', label: 'Non-Inventory — For Sale' },
  { value: 'nonInventoryResaleItem', label: 'Non-Inventory — For Resale' },
  { value: 'inventoryItem', label: 'Inventory Item' },
];

interface Props {
  initialPartNumber: string;
  initialDisplayName?: string | null;
  initialDescription?: string | null;
  initialPrice?: number | null;
  billableCustomer?: string | null;
  /** 'graphics' (default) or 'upfit' — which local catalog the mirror lands in */
  catalog?: 'graphics' | 'upfit';
  /** Show a Catalog select (seeded from `catalog`) instead of pinning it —
   *  for callers with no inherent catalog, like the estimate builder. */
  chooseCatalog?: boolean;
  /**
   * Local netsuite_parts row this part already lives in (catalog flow). The
   * server links the new NetSuite record to that row instead of inserting a
   * second one.
   */
  existingPartId?: string | null;
  onCreated: (part: CreatedPart, info?: { priceWarning?: string }) => void;
  onClose: () => void;
}

export function CreateNetsuiteItemModal({
  initialPartNumber,
  initialDisplayName,
  initialDescription,
  initialPrice,
  billableCustomer,
  catalog = 'graphics',
  chooseCatalog,
  existingPartId,
  onCreated,
  onClose,
}: Props) {
  const [partNumber, setPartNumber] = useState(initialPartNumber);
  const [cat, setCat] = useState<'graphics' | 'upfit'>(catalog);
  const [displayName, setDisplayName] = useState(initialDisplayName || initialDescription || initialPartNumber);
  const [description, setDescription] = useState(initialDescription || '');
  const [price, setPrice] = useState(initialPrice != null ? String(initialPrice) : '');
  const [recordType, setRecordType] = useState(ITEM_TYPES[0].value);
  const [cost, setCost] = useState('');
  // Preferred vendor, picked from the NetSuite vendor master (synced nightly
  // into netsuite_vendors) so it carries NetSuite's internal id.
  const [vendor, setVendor] = useState<{ id: string; name: string } | null>(null);
  const [vendorQuery, setVendorQuery] = useState('');
  const [vendorResults, setVendorResults] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    const q = vendorQuery.trim();
    if (vendor || q.length < 2) { setVendorResults([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const like = `%${q.replace(/[%_,()]/g, ' ')}%`;
      const { data } = await createClient()
        .from('netsuite_vendors')
        .select('netsuite_id, company_name, entity_id')
        .eq('is_inactive', false)
        .or(`company_name.ilike.${like},entity_id.ilike.${like}`)
        .order('company_name')
        .limit(10);
      if (!cancelled) {
        setVendorResults((data || []).map((v: { netsuite_id: string; company_name: string | null; entity_id: string | null }) => ({ id: v.netsuite_id, name: v.company_name || v.entity_id || v.netsuite_id })));
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [vendorQuery, vendor]);
  const purchasable = /Resale|^inventory/.test(recordType);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Success state — shown in-modal so there's explicit confirmation before the
  // modal closes. onCreated fires when the user dismisses this screen.
  const [done, setDone] = useState<{
    part: CreatedPart;
    info?: { priceWarning?: string };
    alreadyExists?: boolean;
    netsuiteUrl?: string;
    mirrorWarning?: string;
    photoWarning?: string;
  } | null>(null);
  // Optional product photo, saved onto the catalog part once it exists —
  // same storage path and endpoint as Parts catalog → Add photo.
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!photo) { setPhotoPreview(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const savePhoto = async (partId: string, picked: File): Promise<string | undefined> => {
    try {
      const file = await toJpegIfHeic(picked);
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `parts/${partId}/manual-${Date.now()}.${ext}`;
      const { error: upErr } = await storage.from('photos').upload(path, file, { contentType: file.type });
      if (upErr) return `Part created, but the picture didn't upload: ${upErr.message}. Add it from Parts → the part → Add photo.`;
      const res = await fetch('/api/parts/categorize', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partId, imagePath: path }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return `Part created, but the picture didn't save: ${d.error || res.status}. Add it from Parts → the part → Add photo.`;
      }
    } catch (e: any) {
      return `Part created, but the picture didn't upload: ${e?.message || 'unknown error'}. Add it from Parts → the part → Add photo.`;
    }
    return undefined;
  };

  const finish = () => {
    if (done) onCreated(done.part, done.info);
  };

  const submit = async () => {
    if (submitting || !partNumber.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/netsuite/create-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partNumber: partNumber.trim(),
          recordType,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
          salesPrice: price.trim() ? Number(price) : null,
          purchasePrice: cost.trim() ? Number(cost) : null,
          vendorId: vendor?.id || null,
          vendorName: vendor?.name || null,
          catalog: cat,
          billableCustomer: billableCustomer || null,
          existingPartId: existingPartId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.error || `Failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const info = data.priceWarning ? { priceWarning: data.priceWarning as string } : undefined;
      // Created in NetSuite but local mirror failed — still let the caller
      // proceed. Either way the NetSuite internal id and chosen catalog ride
      // along (spread order: the server's part row wins where it has them).
      const part: CreatedPart = data.part
        ? { netsuite_id: data.internalId || null, catalog: cat, ...data.part }
        : {
            id: data.internalId || partNumber.trim(),
            netsuite_id: data.internalId || null,
            item_number: partNumber.trim(),
            display_name: displayName.trim() || null,
            billable_customer: billableCustomer || null,
            sales_price: price.trim() ? Number(price) : null,
            catalog: cat,
          };
      if (data.mirrorWarning) console.warn(data.mirrorWarning);
      // The picture needs the local catalog row; without it (mirror failed)
      // there is nothing to attach it to.
      let photoWarning: string | undefined;
      if (photo) {
        photoWarning = data.part?.id
          ? await savePhoto(data.part.id, photo)
          : "Part created, but the picture wasn't saved because the FleetSuite catalog entry is missing.";
      }
      setDone({
        part,
        info,
        alreadyExists: !!data.alreadyExists,
        netsuiteUrl: data.netsuiteUrl,
        mirrorWarning: data.mirrorWarning,
        photoWarning,
      });
      setSubmitting(false);
    } catch (e: any) {
      setError(e?.message || 'Network error');
      setSubmitting(false);
    }
  };

  const labelStyle = { fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' as const, marginBottom: '4px', display: 'block' };
  const inputStyle = { width: '100%', padding: '9px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px' };

  if (done) {
    return (
      <div ref={closeOnEscape(finish)} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 1000, padding: '20px', overflowY: 'auto',
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          background: 'var(--card)', borderRadius: '14px', maxWidth: '460px', width: '100%',
          border: '1px solid rgba(34,197,94,0.4)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
        }}>
          <div style={{ padding: '20px 18px 14px', textAlign: 'center' }}>
            <div style={{ fontSize: '30px', lineHeight: 1, color: '#22c55e', fontWeight: 800 }}>✓</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: '#22c55e', marginTop: '8px' }}>
              {done.alreadyExists ? 'Already in NetSuite' : 'Part Created in NetSuite'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-body)', marginTop: '6px' }}>
              {done.alreadyExists
                ? <><b>{done.part.item_number}</b> already existed in NetSuite — FleetSuite linked it to the catalog, so it won&apos;t be flagged again.</>
                : <><b>{done.part.item_number}</b> was created in NetSuite and added to the FleetSuite catalog.</>}
            </div>
            {done.netsuiteUrl && (
              <a href={done.netsuiteUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: '10px', fontSize: '12px', fontWeight: 700, color: '#60a5fa', textDecoration: 'none' }}>
                View in NetSuite ↗
              </a>
            )}
            {done.info?.priceWarning && (
              <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '8px 10px', textAlign: 'left', whiteSpace: 'pre-wrap' }}>
                {done.info.priceWarning}
              </div>
            )}
            {done.photoWarning && (
              <div style={{ marginTop: '8px', fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '8px 10px', textAlign: 'left' }}>
                {done.photoWarning}
              </div>
            )}
            {done.mirrorWarning && (
              <div style={{ marginTop: '8px', fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '8px 10px', textAlign: 'left' }}>
                {done.mirrorWarning}
              </div>
            )}
          </div>
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
            <button
              onClick={finish}
              style={{ width: '100%', padding: '11px', borderRadius: '10px', border: 'none', background: 'rgba(34,197,94,0.9)', color: '#fff', fontWeight: 800, fontSize: '13px', cursor: 'pointer' }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={closeOnEscape(onClose)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1000, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '460px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Create Part in NetSuite</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>This item isn&apos;t in NetSuite yet. Review and create it.</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label style={labelStyle}>Part Number</label>
            <input value={partNumber} onChange={e => setPartNumber(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Item Type</label>
            <select value={recordType} onChange={e => setRecordType(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
              {ITEM_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          {chooseCatalog && (
            <div>
              <label style={labelStyle}>Catalog</label>
              <select value={cat} onChange={e => setCat(e.target.value as 'graphics' | 'upfit')} style={{ ...inputStyle, cursor: 'pointer' }}>
                <option value="upfit">Upfit</option>
                <option value="graphics">Graphics</option>
              </select>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Which Visual Catalog tab the part files under in FleetSuite.
              </div>
            </div>
          )}
          <div>
            <label style={labelStyle}>Display Name (shows as Description on estimates)</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Long Description (parts record only)</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div>
            <label style={labelStyle}>Sales Price</label>
            <input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00" style={inputStyle} />
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <div style={{ flex: '0 0 35%' }}>
              <label style={labelStyle}>Cost</label>
              <input value={cost} onChange={e => setCost(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00" style={inputStyle} />
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <label style={labelStyle}>Vendor</label>
              {vendor ? (
                <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{vendor.name}</span>
                  <button type="button" onClick={() => { setVendor(null); setVendorQuery(''); }} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '14px', padding: 0 }}>✕</button>
                </div>
              ) : (
                <input value={vendorQuery} onChange={e => setVendorQuery(e.target.value)} placeholder="Search NetSuite vendors" style={inputStyle} />
              )}
              {!vendor && vendorResults.length > 0 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 5, marginTop: '2px', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)', maxHeight: '220px', overflowY: 'auto' }}>
                  {vendorResults.map(v => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => { setVendor(v); setVendorResults([]); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: '13px', cursor: 'pointer' }}
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {!purchasable && (cost.trim() || vendor) && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '-6px' }}>
              &quot;For Sale&quot; items have no cost or vendor in NetSuite, so these are saved in FleetSuite only. Pick a &quot;For Resale&quot; or Inventory type to send them to NetSuite.
            </div>
          )}
          <div>
            <label style={labelStyle}>Picture (optional)</label>
            <input
              ref={photoInput}
              type="file"
              accept="image/*,.heic,.heif"
              style={{ display: 'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) setPhoto(f); e.target.value = ''; }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {photoPreview && (
                <img src={photoPreview} alt="" style={{ width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', border: '1px solid var(--border)' }} />
              )}
              <button
                type="button"
                onClick={() => photoInput.current?.click()}
                disabled={submitting}
                style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--subtle-bg)', color: 'var(--text-body)', fontWeight: 700, fontSize: '12px', cursor: 'pointer' }}
              >
                {photo ? 'Change picture' : 'Take photo / choose file'}
              </button>
              {photo && !submitting && (
                <button type="button" onClick={() => setPhoto(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer' }}>
                  Remove
                </button>
              )}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Shows on estimates, the customer approval page and the Parts catalog.
            </div>
          </div>

          {error && (
            <div style={{ fontSize: '12px', color: '#f87171', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px' }}>
          <button
            onClick={submit}
            disabled={submitting || !partNumber.trim()}
            style={{
              flex: 1, padding: '11px', borderRadius: '10px', border: 'none',
              background: submitting || !partNumber.trim() ? 'var(--subtle-bg)' : 'rgba(34,197,94,0.9)',
              color: submitting || !partNumber.trim() ? 'var(--text-muted)' : '#fff',
              fontWeight: 800, fontSize: '13px', cursor: submitting || !partNumber.trim() ? 'default' : 'pointer',
            }}
          >
            {submitting ? 'Creating in NetSuite… (can take up to a minute)' : 'Create in NetSuite'}
          </button>
          <button onClick={onClose} style={{ flex: 1, padding: '11px', borderRadius: '10px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-body)', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
