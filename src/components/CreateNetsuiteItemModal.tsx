'use client';

import { useState } from 'react';

export interface CreatedPart {
  id: string;
  item_number: string;
  display_name: string | null;
  billable_customer: string | null;
  sales_price: number | null;
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
  existingPartId,
  onCreated,
  onClose,
}: Props) {
  const [partNumber, setPartNumber] = useState(initialPartNumber);
  const [displayName, setDisplayName] = useState(initialDisplayName || initialDescription || initialPartNumber);
  const [description, setDescription] = useState(initialDescription || '');
  const [price, setPrice] = useState(initialPrice != null ? String(initialPrice) : '');
  const [recordType, setRecordType] = useState(ITEM_TYPES[0].value);
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
  } | null>(null);

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
          catalog,
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
      // Created in NetSuite but local mirror failed — still let the caller proceed
      const part: CreatedPart = data.part || {
        id: data.internalId || partNumber.trim(),
        item_number: partNumber.trim(),
        display_name: displayName.trim() || null,
        billable_customer: billableCustomer || null,
        sales_price: price.trim() ? Number(price) : null,
      };
      if (data.mirrorWarning) console.warn(data.mirrorWarning);
      setDone({
        part,
        info,
        alreadyExists: !!data.alreadyExists,
        netsuiteUrl: data.netsuiteUrl,
        mirrorWarning: data.mirrorWarning,
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
      <div onClick={finish} style={{
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
              <div style={{ marginTop: '12px', fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: '8px', padding: '8px 10px', textAlign: 'left' }}>
                {done.info.priceWarning}
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
    <div onClick={onClose} style={{
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
          <div>
            <label style={labelStyle}>Display Name</label>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: 'vertical' }} />
          </div>
          <div>
            <label style={labelStyle}>Sales Price</label>
            <input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" placeholder="0.00" style={inputStyle} />
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
