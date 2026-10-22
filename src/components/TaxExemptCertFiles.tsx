'use client';

import { useState, useEffect } from 'react';
import { useDialog } from '@/components/DialogProvider';
import { uploadRecordFile } from '@/lib/record-file-upload';

interface CustomerFile {
  id: string;
  category: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  created_at: string;
}

const labelCss = { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' } as const;

/**
 * A customer's tax exemption certificates (E5). Private: they upload to and
 * download from the staff-gated /api/customers/files route (no public URL).
 * Used by the estimate's Edit defaults and the customer page's Sales tax card.
 */
export default function TaxExemptCertFiles({ customerId, onUploaded, onCount }: {
  customerId: string | null;
  /** Uploading a certificate implies the customer is exempt. */
  onUploaded?: () => void;
  onCount?: (n: number) => void;
}) {
  const dialog = useDialog();
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

  useEffect(() => { if (certs) onCount?.(certs.length); }, [certs, onCount]);

  const uploadCert = async (f: File) => {
    if (!customerId || uploading) return;
    setUploading(true);
    try {
      const rec = await uploadRecordFile('/api/customers/files', { customerId }, f, { category: 'tax_exempt_cert' });
      if (rec.error || !rec.file) throw new Error(rec.error || 'Upload failed');
      setCerts(prev => [rec.file, ...(prev || [])]);
      onUploaded?.();
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

  return (
    <div>
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
            {f.file_name}
          </a>
          <button onClick={() => deleteCert(f)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>Delete</button>
        </div>
      ))}
    </div>
  );
}
