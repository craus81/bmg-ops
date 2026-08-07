'use client';

import { useState, useEffect } from 'react';
import { useDialog } from '@/components/DialogProvider';

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

interface CustomerFile {
  id: string;
  category: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
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
  const dialog = useDialog();
  const [delivery, setDelivery] = useState(initial?.delivery_instructions || '');
  const [billingName, setBillingName] = useState(initial?.billing_contact_name || '');
  const [billingEmail, setBillingEmail] = useState(initial?.billing_contact_email || '');
  const [apEmail, setApEmail] = useState(initial?.ap_email || '');
  const [internalNotes, setInternalNotes] = useState(initial?.internal_notes || '');
  const [taxExempt, setTaxExempt] = useState(!!initial?.tax_exempt);
  const [certNumber, setCertNumber] = useState(initial?.tax_exempt_cert_number || '');
  const [certExpiry, setCertExpiry] = useState(initial?.tax_exempt_expires_at || '');

  const [certs, setCerts] = useState<CustomerFile[] | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!customerId) { setCerts([]); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/customers/files?customerId=${customerId}&category=tax_exempt_cert`);
        const body = await res.json();
        if (live) setCerts(res.ok && body.success ? (body.files || []) : []);
      } catch {
        if (live) setCerts([]);
      }
    })();
    return () => { live = false; };
  }, [customerId]);

  const uploadCert = async (f: File) => {
    if (!customerId || uploading) return;
    setUploading(true);
    try {
      const type = f.type || 'application/octet-stream';
      const post = (payload: any) => fetch('/api/customers/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      const presign = await post({ action: 'presign', customerId, fileName: f.name, contentType: type, size: f.size });
      if (!presign.success) throw new Error(presign.error || 'Could not start the upload');
      const put = await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: f });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      const rec = await post({ action: 'record', customerId, path: presign.path, fileName: f.name, contentType: type, size: f.size, category: 'tax_exempt_cert' });
      if (!rec.success) throw new Error(rec.error || 'Failed to save the file record');
      setCerts(prev => [rec.file, ...(prev || [])]);
      if (!taxExempt) setTaxExempt(true); // uploading a cert implies exemption
    } catch (err: any) {
      await dialog.alert(`Could not upload ${f.name}: ${err?.message || 'unknown error'}`);
    }
    setUploading(false);
  };

  const deleteCert = async (file: CustomerFile) => {
    if (!(await dialog.confirm(`Delete ${file.file_name}?`, { destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      const res = await fetch(`/api/customers/files?id=${file.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setCerts(prev => (prev || []).filter(x => x.id !== file.id));
    } catch (err: any) {
      await dialog.alert(`Could not delete the file: ${err?.message || 'unknown error'}`);
    }
  };

  const save = async () => {
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
          <label>
            <div style={labelCss}>Internal notes</div>
            <textarea
              value={internalNotes}
              onChange={e => setInternalNotes(e.target.value)}
              rows={2}
              style={{ ...inputCss, fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>

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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={labelCss}>Certificate on file {certs && certs.length > 0 && <span style={{ fontWeight: 600 }}>· {certs.length}</span>}</div>
                <label style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent,#2563eb)', cursor: customerId ? 'pointer' : 'not-allowed', opacity: customerId ? 1 : 0.5 }}>
                  {uploading ? 'Uploading…' : '+ Upload'}
                  <input type="file" hidden disabled={!customerId || uploading}
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadCert(f); e.target.value = ''; }} />
                </label>
              </div>
              {!customerId && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Save the customer first to attach a certificate.</div>}
              {customerId && certs === null && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</div>}
              {customerId && certs && certs.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No certificate uploaded yet.</div>}
              {(certs || []).map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 0' }}>
                  <a href={`/api/customers/files?download=${f.id}`} target="_blank" rel="noreferrer"
                    style={{ fontSize: '12px', color: 'var(--accent,#2563eb)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    📎 {f.file_name}
                  </a>
                  <button onClick={() => deleteCert(f)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>Delete</button>
                </div>
              ))}
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
