'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';

interface EditableInvoice {
  id: string;
  vendor_name: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_amount: number | null;
  location_id?: string | null;
  location_name: string | null;
  notes: string | null;
  company: { id: string; name: string; netsuite_vendor_id: string | null } | null;
}

interface Company { id: string; name: string; netsuite_vendor_id: string | null }
interface WorkLocation { id: string; name: string }

interface Props {
  invoice: EditableInvoice;
  onClose: () => void;
  onSaved: () => void;
}

const label = { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.5px' };
const field = { width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '13px', fontFamily: 'inherit' };

export default function EditVendorInvoiceModal({ invoice, onClose, onSaved }: Props) {
  const supabase = createClient();

  const [companies, setCompanies] = useState<Company[]>([]);
  const [locations, setLocations] = useState<WorkLocation[]>([]);
  const [companyId, setCompanyId] = useState<string>(invoice.company?.id || '');
  const [vendorName, setVendorName] = useState(invoice.vendor_name);
  const [invoiceNumber, setInvoiceNumber] = useState(invoice.invoice_number || '');
  const [invoiceDate, setInvoiceDate] = useState(invoice.invoice_date || '');
  const [dueDate, setDueDate] = useState(invoice.due_date || '');
  const [totalAmount, setTotalAmount] = useState(invoice.total_amount != null ? String(invoice.total_amount) : '');
  const [locationId, setLocationId] = useState<string>(invoice.location_id || '');
  const [notes, setNotes] = useState(invoice.notes || '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRefData = useCallback(async () => {
    const [{ data: comps }, { data: locs }] = await Promise.all([
      supabase.from('companies').select('id, name, netsuite_vendor_id').order('name'),
      supabase.from('work_locations').select('id, name').eq('is_active', true).order('name'),
    ]);
    setCompanies((comps || []) as Company[]);
    setLocations((locs || []) as WorkLocation[]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => { loadRefData(); }, [loadRefData]);

  const pickCompany = (id: string) => {
    setCompanyId(id);
    // Auto-fill the free-text vendor name from the chosen company when the
    // current name is blank or still matches the previously linked company —
    // don't clobber a name the user deliberately set.
    const chosen = companies.find(c => c.id === id);
    if (chosen && (!vendorName.trim() || vendorName === invoice.company?.name)) {
      setVendorName(chosen.name);
    }
  };

  const selectedCompany = companies.find(c => c.id === companyId) || (companyId ? null : undefined);
  // Warn when the save wouldn't clear the "not linked" flag.
  const willBeUnlinked = !companyId || (selectedCompany != null && !selectedCompany.netsuite_vendor_id);

  const save = async () => {
    if (!vendorName.trim()) { setError('Vendor name is required'); return; }
    const amt = totalAmount.trim() === '' ? null : Number(totalAmount);
    if (amt != null && (!isFinite(amt) || amt < 0)) { setError('Total must be a non-negative number'); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/vendor-invoices', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: invoice.id,
          companyId: companyId || null,
          vendorName: vendorName.trim(),
          invoiceNumber: invoiceNumber.trim() || null,
          invoiceDate: invoiceDate || null,
          dueDate: dueDate || null,
          totalAmount: amt,
          locationId: locationId || null,
          notes: notes.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setError(data.error || 'Save failed');
      } else {
        onSaved();
      }
    } catch (e: any) {
      setError(e?.message || 'Network error');
    }
    setSaving(false);
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      zIndex: 1500, padding: '20px', overflowY: 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'var(--card)', borderRadius: '14px', maxWidth: '540px', width: '100%',
        border: '1px solid var(--border)', boxShadow: '0 16px 60px rgba(0,0,0,0.3)', margin: 'auto 0',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>Edit invoice</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {invoice.vendor_name}{invoice.invoice_number ? ` · #${invoice.invoice_number}` : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px 8px' }}>✕</button>
        </div>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Vendor link — the reason this modal exists */}
          <label>
            <div style={label}>NetSuite vendor (company)</div>
            <select value={companyId} onChange={e => pickCompany(e.target.value)} style={field}>
              <option value="">— Not linked to a company —</option>
              {companies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.netsuite_vendor_id ? ` · NetSuite #${c.netsuite_vendor_id}` : ' · no NetSuite vendor'}
                </option>
              ))}
            </select>
            <div style={{ fontSize: '11px', marginTop: '4px', color: willBeUnlinked ? '#fbbf24' : '#22c55e' }}>
              {willBeUnlinked
                ? '⚠ This company has no NetSuite vendor yet — billing will still be blocked. Set its vendor ID on the company page.'
                : '✓ Linked — the NetSuite bill can be created from this invoice.'}
            </div>
          </label>

          <label>
            <div style={label}>Vendor name (as shown on the invoice)</div>
            <input type="text" value={vendorName} onChange={e => setVendorName(e.target.value)} style={field} />
          </label>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: '140px' }}>
              <div style={label}>Invoice #</div>
              <input type="text" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} style={field} />
            </label>
            <label style={{ flex: 1, minWidth: '120px' }}>
              <div style={label}>Total amount</div>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={totalAmount} onChange={e => setTotalAmount(e.target.value)} style={field} />
            </label>
          </div>

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: '140px' }}>
              <div style={label}>Invoice date</div>
              <input type="date" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} style={field} />
            </label>
            <label style={{ flex: 1, minWidth: '140px' }}>
              <div style={label}>Due date</div>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} style={field} />
            </label>
          </div>

          <label>
            <div style={label}>Location</div>
            <select value={locationId} onChange={e => setLocationId(e.target.value)} style={field}>
              <option value="">— No location —</option>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>

          <label>
            <div style={label}>Notes</div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} style={{ ...field, resize: 'vertical' }} />
          </label>

          {error && (
            <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, #ef4444 8%, var(--card))', border: '1px solid #ef4444', fontSize: '12px', color: '#ef4444' }}>{error}</div>
          )}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: '10px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>Cancel</button>
          <button onClick={save} disabled={saving} style={{ padding: '10px 18px', borderRadius: '10px', border: 'none', background: '#22c55e', color: '#fff', fontSize: '14px', fontWeight: 800, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
