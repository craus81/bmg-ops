'use client';

import { useState } from 'react';
import TaxExemptCertFiles from '@/components/TaxExemptCertFiles';
import { createClient } from '@/lib/supabase-browser';
import MentionTextArea, { reportMentions } from '@/components/MentionTextArea';
import { deepLinks } from '@/lib/deep-links';
import { closeOnEscape } from '@/lib/modal-escape';

interface Defaults {
  delivery_instructions: string | null;
  billing_contact_name: string | null;
  billing_contact_email: string | null;
  ap_email: string | null;
  internal_notes: string | null;
  tax_exempt: boolean;
  tax_exempt_cert_number: string | null;
  tax_exempt_expires_at: string | null;
}

interface Props {
  initial: Defaults | null;
  customerId: string | null;
  customerName: string;
  saving: boolean;
  onSave: (d: Defaults) => Promise<void> | void;
  onClose: () => void;
}

const labelCss = { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } as const;
const inputCss = { width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--background,#fff)', fontSize: '13px' } as const;

/**
 * Inline editor for customer operations defaults (T1.6) + tax exemption (E5).
 * Used from the estimates builder so sales can maintain customer-wide
 * settings — including the resale/exemption certificate — without leaving the
 * estimate flow. Certificates are private: they upload to and download from
 * the staff-gated /api/customers/files route (no public URL).
 */
export default function CustomerDefaultsEditor({ initial, customerId, customerName, saving, onSave, onClose }: Props) {
  const [delivery, setDelivery] = useState(initial?.delivery_instructions || '');
  const [billingName, setBillingName] = useState(initial?.billing_contact_name || '');
  const [billingEmail, setBillingEmail] = useState(initial?.billing_contact_email || '');
  const [apEmail, setApEmail] = useState(initial?.ap_email || '');
  const [internalNotes, setInternalNotes] = useState(initial?.internal_notes || '');
  const [taxExempt, setTaxExempt] = useState(!!initial?.tax_exempt);
  const [certNumber, setCertNumber] = useState(initial?.tax_exempt_cert_number || '');
  const [certExpiry, setCertExpiry] = useState(initial?.tax_exempt_expires_at || '');

  const save = async () => {
    const previousNotes = initial?.internal_notes || '';
    await onSave({
      delivery_instructions: delivery || null,
      billing_contact_name: billingName || null,
      billing_contact_email: billingEmail || null,
      ap_email: apEmail || null,
      internal_notes: internalNotes || null,
      tax_exempt: taxExempt,
      tax_exempt_cert_number: certNumber.trim() || null,
      tax_exempt_expires_at: certExpiry || null,
    });
    // onSave doesn't report success (the host alerts on failure), so read
    // the row back and only send @mentions once the note is really stored.
    if (customerId && internalNotes.includes('@') && internalNotes !== previousNotes) {
      const { data } = await createClient()
        .from('customers')
        .select('internal_notes, netsuite_id')
        .eq('id', customerId)
        .maybeSingle();
      if (data && (data.internal_notes || '') === internalNotes) {
        reportMentions({
          text: internalNotes,
          previousText: previousNotes,
          sourceType: 'customer_note',
          sourceId: customerId,
          contextLabel: `Customer notes — ${customerName}`,
          // The customer record shows internal notes for every customer;
          // the at-risk report only lists at-risk ones.
          contextUrl: data.netsuite_id
            ? deepLinks.customerByNetsuiteId(data.netsuite_id)
            : deepLinks.atRiskCustomer(customerId),
        });
      }
    }
  };

  return (
    <div
      ref={closeOnEscape(onClose)}
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
          maxHeight: 'calc(90vh / var(--ts))', overflow: 'auto', border: '1px solid var(--border)',
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
            <div style={labelCss}>Default delivery instructions</div>
            <textarea
              value={delivery}
              onChange={e => setDelivery(e.target.value)}
              rows={3}
              style={{ ...inputCss, fontFamily: 'inherit', resize: 'vertical' }}
              placeholder="e.g. Dock 4, 7-10am, always ask for Manny"
            />
          </label>
          <label>
            <div style={labelCss}>Billing contact name</div>
            <input value={billingName} onChange={e => setBillingName(e.target.value)} style={inputCss} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <label>
              <div style={labelCss}>Billing contact email</div>
              <input value={billingEmail} onChange={e => setBillingEmail(e.target.value)} style={inputCss} />
            </label>
            <label>
              <div style={labelCss}>AP email</div>
              <input value={apEmail} onChange={e => setApEmail(e.target.value)} style={inputCss} />
            </label>
          </div>
          <div>
            <div style={labelCss}>Internal notes</div>
            <MentionTextArea
              value={internalNotes}
              onChange={setInternalNotes}
              placeholder="Staff-only — @ tags a teammate"
              rows={2}
              style={{ ...inputCss, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </div>

          {/* ── Tax exemption (E5) ── */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: '2px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input type="checkbox" checked={taxExempt} onChange={e => setTaxExempt(e.target.checked)} />
              <span style={{ fontSize: '13px', fontWeight: 700 }}>Customer is tax-exempt</span>
            </label>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', margin: '2px 0 8px 24px' }}>
              Prefills the tax-exempt flag on new estimates for this customer.
            </div>
            {taxExempt && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginLeft: '24px' }}>
                <label>
                  <div style={labelCss}>Certificate number</div>
                  <input value={certNumber} onChange={e => setCertNumber(e.target.value)} placeholder="e.g. 12-3456789" style={inputCss} />
                </label>
                <label>
                  <div style={labelCss}>Expires</div>
                  <input type="date" value={certExpiry || ''} onChange={e => setCertExpiry(e.target.value)} style={inputCss} />
                </label>
              </div>
            )}

            {/* Certificate files — private (stream via the staff-gated route). */}
            <div style={{ marginLeft: '24px', marginTop: '10px' }}>
              <TaxExemptCertFiles customerId={customerId} onUploaded={() => setTaxExempt(true)} />
            </div>
          </div>
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
