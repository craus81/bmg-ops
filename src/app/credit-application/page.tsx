'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const TERMS_OPTIONS = [
  { value: 'net_15', label: 'Net 15' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_45', label: 'Net 45' },
  { value: 'net_60', label: 'Net 60' },
];

const BUSINESS_TYPES = ['LLC', 'Corporation', 'S-Corp', 'Partnership', 'Sole Proprietor', 'Non-Profit', 'Government', 'Other'];

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '14px',
  border: '1px solid #d1d5db', background: '#fff', color: '#1a2b36',
};
const labelStyle: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: '#374c5a', marginBottom: '4px', display: 'block',
};

export default function CreditApplicationPage() {
  const [form, setForm] = useState({
    company_name: '', dba_name: '', business_type: '', tax_id: '', years_in_business: '',
    contact_name: '', contact_title: '', contact_email: '', contact_phone: '',
    address: '', city: '', state: '', zip: '',
    ap_contact_name: '', ap_contact_email: '', ap_contact_phone: '',
    requested_terms: 'net_30', estimated_monthly_volume: '',
    trade_ref_1_company: '', trade_ref_1_contact: '', trade_ref_1_phone: '',
    trade_ref_2_company: '', trade_ref_2_contact: '', trade_ref_2_phone: '',
    trade_ref_3_company: '', trade_ref_3_contact: '', trade_ref_3_phone: '',
    bank_name: '', bank_contact: '', bank_phone: '', bank_account_type: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const u = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.company_name.trim() || !form.contact_name.trim() || !form.contact_email.trim()) {
      setError('Company name, contact name, and email are required.');
      return;
    }
    setSubmitting(true);
    setError('');

    const { error: dbError } = await supabase.from('credit_applications').insert({
      ...form,
      years_in_business: form.years_in_business ? parseInt(form.years_in_business) : null,
      estimated_monthly_volume: form.estimated_monthly_volume ? parseFloat(form.estimated_monthly_volume) : null,
    });

    if (dbError) {
      setError('Failed to submit. Please try again.');
      setSubmitting(false);
      return;
    }

    setSubmitted(true);
    setSubmitting(false);
  };

  if (submitted) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f5f7', padding: '20px' }}>
        <div style={{ background: '#fff', borderRadius: '16px', padding: '40px', maxWidth: '500px', textAlign: 'center', boxShadow: '0 4px 20px rgba(0,0,0,0.08)' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#10003;</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#1a2b36', marginBottom: '8px' }}>Application Submitted</div>
          <div style={{ fontSize: '14px', color: '#5a6e7c', lineHeight: 1.6 }}>
            Thank you for your credit application. Our team will review your information and contact you within 2-3 business days.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f4f5f7', padding: '20px' }}>
      <form onSubmit={handleSubmit} style={{ maxWidth: '680px', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ fontSize: '26px', fontWeight: 800, color: '#1a2b36' }}>Credit Application</div>
          <div style={{ fontSize: '14px', color: '#5a6e7c', marginTop: '4px' }}>BMG Fleet — Net Payment Terms</div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: '8px', background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: '13px', fontWeight: 600, marginBottom: '16px' }}>
            {error}
          </div>
        )}

        {/* Company Information */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Company Information</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Legal Company Name *</label><input required style={inputStyle} value={form.company_name} onChange={e => u('company_name', e.target.value)} /></div>
            <div><label style={labelStyle}>DBA / Trade Name</label><input style={inputStyle} value={form.dba_name} onChange={e => u('dba_name', e.target.value)} /></div>
            <div><label style={labelStyle}>Business Type</label>
              <select style={inputStyle} value={form.business_type} onChange={e => u('business_type', e.target.value)}>
                <option value="">Select...</option>
                {BUSINESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Tax ID / EIN</label><input style={inputStyle} value={form.tax_id} onChange={e => u('tax_id', e.target.value)} /></div>
            <div><label style={labelStyle}>Years in Business</label><input type="number" min="0" style={inputStyle} value={form.years_in_business} onChange={e => u('years_in_business', e.target.value)} /></div>
          </div>
        </div>

        {/* Contact Info */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Primary Contact</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={labelStyle}>Name *</label><input required style={inputStyle} value={form.contact_name} onChange={e => u('contact_name', e.target.value)} /></div>
            <div><label style={labelStyle}>Title</label><input style={inputStyle} value={form.contact_title} onChange={e => u('contact_title', e.target.value)} /></div>
            <div><label style={labelStyle}>Email *</label><input required type="email" style={inputStyle} value={form.contact_email} onChange={e => u('contact_email', e.target.value)} /></div>
            <div><label style={labelStyle}>Phone</label><input style={inputStyle} value={form.contact_phone} onChange={e => u('contact_phone', e.target.value)} /></div>
          </div>
        </div>

        {/* Address */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Business Address</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Street Address</label><input style={inputStyle} value={form.address} onChange={e => u('address', e.target.value)} /></div>
            <div><label style={labelStyle}>City</label><input style={inputStyle} value={form.city} onChange={e => u('city', e.target.value)} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <div><label style={labelStyle}>State</label><input style={inputStyle} value={form.state} onChange={e => u('state', e.target.value)} /></div>
              <div><label style={labelStyle}>Zip</label><input style={inputStyle} value={form.zip} onChange={e => u('zip', e.target.value)} /></div>
            </div>
          </div>
        </div>

        {/* AP Contact */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Accounts Payable Contact</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={labelStyle}>Name</label><input style={inputStyle} value={form.ap_contact_name} onChange={e => u('ap_contact_name', e.target.value)} /></div>
            <div><label style={labelStyle}>Email</label><input type="email" style={inputStyle} value={form.ap_contact_email} onChange={e => u('ap_contact_email', e.target.value)} /></div>
            <div><label style={labelStyle}>Phone</label><input style={inputStyle} value={form.ap_contact_phone} onChange={e => u('ap_contact_phone', e.target.value)} /></div>
          </div>
        </div>

        {/* Credit Terms */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Credit Terms Requested</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={labelStyle}>Payment Terms</label>
              <select style={inputStyle} value={form.requested_terms} onChange={e => u('requested_terms', e.target.value)}>
                {TERMS_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div><label style={labelStyle}>Est. Monthly Volume ($)</label><input type="number" min="0" step="100" style={inputStyle} value={form.estimated_monthly_volume} onChange={e => u('estimated_monthly_volume', e.target.value)} /></div>
          </div>
        </div>

        {/* Trade References */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Trade References (3 required)</div>
          {[1, 2, 3].map(n => (
            <div key={n} style={{ marginBottom: n < 3 ? '12px' : 0, paddingBottom: n < 3 ? '12px' : 0, borderBottom: n < 3 ? '1px solid #e5e7eb' : 'none' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#5a6e7c', marginBottom: '6px' }}>Reference {n}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
                <input style={inputStyle} placeholder="Company" value={(form as any)[`trade_ref_${n}_company`]} onChange={e => u(`trade_ref_${n}_company`, e.target.value)} />
                <input style={inputStyle} placeholder="Contact Name" value={(form as any)[`trade_ref_${n}_contact`]} onChange={e => u(`trade_ref_${n}_contact`, e.target.value)} />
                <input style={inputStyle} placeholder="Phone" value={(form as any)[`trade_ref_${n}_phone`]} onChange={e => u(`trade_ref_${n}_phone`, e.target.value)} />
              </div>
            </div>
          ))}
        </div>

        {/* Bank Reference */}
        <div style={{ background: '#fff', borderRadius: '14px', padding: '20px', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: '#1a2b36', marginBottom: '14px' }}>Bank Reference</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div><label style={labelStyle}>Bank Name</label><input style={inputStyle} value={form.bank_name} onChange={e => u('bank_name', e.target.value)} /></div>
            <div><label style={labelStyle}>Contact</label><input style={inputStyle} value={form.bank_contact} onChange={e => u('bank_contact', e.target.value)} /></div>
            <div><label style={labelStyle}>Phone</label><input style={inputStyle} value={form.bank_phone} onChange={e => u('bank_phone', e.target.value)} /></div>
            <div><label style={labelStyle}>Account Type</label>
              <select style={inputStyle} value={form.bank_account_type} onChange={e => u('bank_account_type', e.target.value)}>
                <option value="">Select...</option>
                <option value="checking">Checking</option>
                <option value="savings">Savings</option>
                <option value="line_of_credit">Line of Credit</option>
              </select>
            </div>
          </div>
        </div>

        <button type="submit" disabled={submitting} style={{
          width: '100%', padding: '16px', borderRadius: '12px', fontSize: '16px', fontWeight: 800,
          background: '#1e4a5e', color: '#fff', border: 'none', cursor: 'pointer',
          opacity: submitting ? 0.6 : 1,
        }}>
          {submitting ? 'Submitting...' : 'Submit Application'}
        </button>

        <div style={{ textAlign: 'center', fontSize: '11px', color: '#9ca3af', marginTop: '12px', lineHeight: 1.5 }}>
          By submitting this application, you authorize BMG Fleet to verify the information provided and check trade and bank references.
        </div>
      </form>
    </div>
  );
}
