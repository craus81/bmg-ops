'use client';

import { useState } from 'react';

interface Defaults {
  delivery_instructions: string | null;
  billing_contact_name: string | null;
  billing_contact_email: string | null;
  ap_email: string | null;
  internal_notes: string | null;
}

interface Props {
  initial: Defaults | null;
  customerName: string;
  saving: boolean;
  onSave: (d: Defaults) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Inline editor for customer operations defaults (T1.6). Used from the
 * estimates builder so sales can maintain customer-wide settings without
 * leaving the estimate flow — no separate customer detail page needed in v1.
 */
export default function CustomerDefaultsEditor({ initial, customerName, saving, onSave, onClose }: Props) {
  const [delivery, setDelivery] = useState(initial?.delivery_instructions || '');
  const [billingName, setBillingName] = useState(initial?.billing_contact_name || '');
  const [billingEmail, setBillingEmail] = useState(initial?.billing_contact_email || '');
  const [apEmail, setApEmail] = useState(initial?.ap_email || '');
  const [internalNotes, setInternalNotes] = useState(initial?.internal_notes || '');

  const save = async () => {
    await onSave({
      delivery_instructions: delivery || null,
      billing_contact_name: billingName || null,
      billing_contact_email: billingEmail || null,
      ap_email: apEmail || null,
      internal_notes: internalNotes || null,
    });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--card)', borderRadius: '14px',
          padding: '18px', maxWidth: '520px', width: '100%',
          maxHeight: '90vh', overflow: 'auto', border: '1px solid var(--border)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800 }}>Operations defaults</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{customerName} · applied to new estimates</div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '18px', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
        </div>

        <div style={{ display: 'grid', gap: '10px' }}>
          <label>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Default delivery instructions</div>
            <textarea
              value={delivery}
              onChange={e => setDelivery(e.target.value)}
              rows={3}
              style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
              placeholder="e.g. Dock 4, 7-10am, always ask for Manny"
            />
          </label>
          <label>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Billing contact name</div>
            <input
              value={billingName}
              onChange={e => setBillingName(e.target.value)}
              style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px' }}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <label>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Billing contact email</div>
              <input
                value={billingEmail}
                onChange={e => setBillingEmail(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px' }}
              />
            </label>
            <label>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>AP email</div>
              <input
                value={apEmail}
                onChange={e => setApEmail(e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px' }}
              />
            </label>
          </div>
          <label>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' }}>Internal notes</div>
            <textarea
              value={internalNotes}
              onChange={e => setInternalNotes(e.target.value)}
              rows={2}
              style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px', fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <button
            onClick={onClose}
            style={{ padding: '8px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--card)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
          >Cancel</button>
          <button
            onClick={save}
            disabled={saving}
            style={{ padding: '8px 14px', borderRadius: '10px', border: 'none', background: 'var(--accent, #2563eb)', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}
          >{saving ? 'Saving...' : 'Save defaults'}</button>
        </div>
      </div>
    </div>
  );
}
