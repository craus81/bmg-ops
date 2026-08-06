'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PhoneInput from '@/components/PhoneInput';
import { storage } from '@/lib/storage';

// Compliance docs are saved through /api/cni/my-docs so the server can
// notify admins the moment the full set is on file.
const DOC_TYPES = [
  { column: 'w9_file_path', label: 'W-9', hint: 'Signed IRS form W-9' },
  { column: 'insurance_cert_path', label: 'Insurance Certificate', hint: 'Certificate of insurance (COI)' },
  { column: 'direct_deposit_file_path', label: 'Direct Deposit Form', hint: 'Authorization form or voided check' },
] as const;
type DocColumn = typeof DOC_TYPES[number]['column'];

// Storage paths look like `<userId>/<column>-<uuid>-<original name>`.
const docFileName = (path: string) =>
  (path.split('/').pop() || path).replace(/^[a-z0-9_]+-[0-9a-f-]{36}-/i, '');

const SERVICE_TYPE_OPTIONS = [
  { id: 'graphics_install', label: 'Graphics Installation' },
  { id: 'tech_install', label: 'Technology Installation' },
  { id: 'upfitting', label: 'Upfitting (Future)' },
  { id: 'removal_rebrand', label: 'Removal / Rebrand' },
];

const EQUIPMENT_OPTIONS = [
  { id: 'indoor', label: 'Indoor Install Capability' },
  { id: 'outdoor', label: 'Outdoor Only' },
  { id: 'lift_bucket', label: 'Lift / Bucket Truck Access' },
  { id: 'shop', label: 'Shop' },
  { id: 'mobile', label: 'Mobile' },
];

export default function InstallerProfilePage() {
  const router = useRouter();
  const { user, isInstaller, isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasProfile, setHasProfile] = useState(false);

  // Profile fields
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [phone, setPhone] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [coverageRadius, setCoverageRadius] = useState('');
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [equipmentCapabilities, setEquipmentCapabilities] = useState<string[]>([]);
  const [availabilityStatus, setAvailabilityStatus] = useState('available');
  const [availabilityNotes, setAvailabilityNotes] = useState('');

  // Compliance documents
  const [docPaths, setDocPaths] = useState<Record<DocColumn, string | null>>({
    w9_file_path: null, insurance_cert_path: null, direct_deposit_file_path: null,
  });
  const [insuranceExpiry, setInsuranceExpiry] = useState('');
  const [docBusy, setDocBusy] = useState<DocColumn | null>(null);
  const [docMsg, setDocMsg] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, user, isInstaller, isAdmin]);

  const loadProfile = async () => {
    if (!user) return;
    const { data } = await supabase
      .from('cni_profiles')
      .select('*')
      .eq('user_id', user.id)
      .single();

    if (data) {
      setHasProfile(true);
      setCompanyName(data.company_name || '');
      setContactName(data.primary_contact_name || '');
      setPhone(data.phone || '');
      const addr = data.business_address || {};
      setStreet(addr.street || '');
      setCity(addr.city || '');
      setState(addr.state || '');
      setZip(addr.zip || '');
      setCoverageRadius(data.coverage_radius_miles?.toString() || '');
      setServiceTypes(data.service_types || []);
      setEquipmentCapabilities(data.equipment_capabilities || []);
      setAvailabilityStatus(data.availability_status || 'available');
      setAvailabilityNotes(data.availability_notes || '');
      setDocPaths({
        w9_file_path: data.w9_file_path || null,
        insurance_cert_path: data.insurance_cert_path || null,
        direct_deposit_file_path: data.direct_deposit_file_path || null,
      });
      setInsuranceExpiry(data.insurance_expiry || '');
    }
    setLoading(false);
  };

  const handleDocUpload = async (column: DocColumn, label: string, file: File) => {
    if (!user) return;
    setDocBusy(column);
    setDocMsg(null);
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    const path = `${user.id}/${column}-${crypto.randomUUID()}-${safeName}`;
    const { error: upErr } = await storage.from('cni-docs').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
    });
    if (upErr) {
      setDocBusy(null);
      setDocMsg({ success: false, message: `Upload failed: ${upErr.message}` });
      return;
    }
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/cni/my-docs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          column,
          path,
          ...(column === 'insurance_cert_path' && insuranceExpiry ? { insuranceExpiry } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDocMsg({ success: false, message: `Failed to save ${label}: ${data.error || 'unknown error'}` });
      } else {
        setDocPaths(prev => ({ ...prev, [column]: path }));
        setDocMsg({
          success: true,
          message: data.complete
            ? `${label} uploaded — all compliance documents are now on file. BMG has been notified. ✓`
            : `${label} uploaded`,
        });
      }
    } catch (err: any) {
      setDocMsg({ success: false, message: `Failed to save ${label}: ${err.message}` });
    }
    setDocBusy(null);
  };

  // Expiry typed after the cert is already on file — save it directly
  // (RLS allows updating your own cni_profiles row).
  const handleInsuranceExpiry = async (value: string) => {
    setInsuranceExpiry(value);
    if (!user || !hasProfile) return;
    await supabase
      .from('cni_profiles')
      .update({ insurance_expiry: value || null })
      .eq('user_id', user.id);
  };

  const toggleItem = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter(i => i !== item) : [...list, item]);
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setSaved(false);

    const profileData = {
      user_id: user.id,
      company_name: companyName.trim() || null,
      primary_contact_name: contactName.trim() || null,
      phone: phone.trim() || null,
      business_address: { street, city, state, zip },
      coverage_radius_miles: coverageRadius ? parseInt(coverageRadius) : null,
      service_types: serviceTypes,
      equipment_capabilities: equipmentCapabilities,
      availability_status: availabilityStatus,
      availability_notes: availabilityNotes.trim() || null,
      profile_complete: !!(companyName && contactName && phone && city && serviceTypes.length > 0),
      updated_at: new Date().toISOString(),
    };

    if (hasProfile) {
      await supabase.from('cni_profiles').update(profileData).eq('user_id', user.id);
    } else {
      await supabase.from('cni_profiles').insert(profileData);
      setHasProfile(true);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading profile...</div>;
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '6px', display: 'block',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '14px',
  };
  const sectionStyle: React.CSSProperties = {
    padding: '16px', borderRadius: '14px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button onClick={() => router.back()} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            My CNI Profile
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Certified Network Installer</div>
        </div>
      </div>

      {saved && (
        <div style={{
          padding: '12px 16px', borderRadius: '10px', marginBottom: '14px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
          color: 'var(--success)', fontSize: '13px', fontWeight: 600,
        }}>
          ✓ Profile saved successfully
        </div>
      )}

      {/* Basic Info */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
          Basic Information
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Company Name</label>
          <input style={inputStyle} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Your company name" />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Primary Contact Name</label>
          <input style={inputStyle} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Full name" />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Phone</label>
          <PhoneInput style={inputStyle} value={phone} onChange={v => setPhone(v)} placeholder="(555) 555-5555" />
        </div>
        <label style={labelStyle}>Business Address</label>
        <input style={{ ...inputStyle, marginBottom: '8px' }} value={street} onChange={e => setStreet(e.target.value)} placeholder="Street" />
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px' }}>
          <input style={inputStyle} value={city} onChange={e => setCity(e.target.value)} placeholder="City" />
          <input style={inputStyle} value={state} onChange={e => setState(e.target.value)} placeholder="State" maxLength={2} />
          <input style={inputStyle} value={zip} onChange={e => setZip(e.target.value)} placeholder="ZIP" />
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Coverage Radius (miles)</label>
          <input style={inputStyle} type="number" value={coverageRadius} onChange={e => setCoverageRadius(e.target.value)} placeholder="e.g. 100" />
        </div>
      </div>

      {/* Capabilities */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
          Capabilities & Services
        </div>
        <label style={labelStyle}>Service Types</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
          {SERVICE_TYPE_OPTIONS.map(opt => (
            <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={serviceTypes.includes(opt.id)}
                onChange={() => toggleItem(serviceTypes, setServiceTypes, opt.id)}
                style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{opt.label}</span>
            </label>
          ))}
        </div>
        <label style={labelStyle}>Equipment Capabilities</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {EQUIPMENT_OPTIONS.map(opt => (
            <label key={opt.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={equipmentCapabilities.includes(opt.id)}
                onChange={() => toggleItem(equipmentCapabilities, setEquipmentCapabilities, opt.id)}
                style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Availability */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '14px' }}>
          Availability
        </div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          {(['available', 'limited', 'unavailable'] as const).map(s => (
            <button
              key={s}
              onClick={() => setAvailabilityStatus(s)}
              style={{
                flex: 1, padding: '10px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                textTransform: 'capitalize',
                background: availabilityStatus === s
                  ? s === 'available' ? 'var(--success-bg)' : s === 'limited' ? 'var(--warning-bg)' : 'var(--error-bg)'
                  : 'var(--input-bg)',
                border: availabilityStatus === s
                  ? `1px solid ${s === 'available' ? 'var(--success-border)' : s === 'limited' ? 'var(--warning-border)' : 'var(--error-border)'}`
                  : '1px solid var(--border)',
                color: availabilityStatus === s
                  ? s === 'available' ? 'var(--success)' : s === 'limited' ? 'var(--warning)' : 'var(--error)'
                  : 'var(--text-muted)',
              }}
            >
              {s}
            </button>
          ))}
        </div>
        <label style={labelStyle}>Notes</label>
        <textarea
          style={{ ...inputStyle, minHeight: '60px', resize: 'vertical' }}
          value={availabilityNotes}
          onChange={e => setAvailabilityNotes(e.target.value)}
          placeholder='e.g. "Booked next 2 weeks", "Only evenings"'
        />
      </div>

      {/* Compliance documents */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
            Compliance Documents
          </div>
          {DOC_TYPES.every(d => docPaths[d.column]) && (
            <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--success-bg)', color: 'var(--success)' }}>
              ALL ON FILE ✓
            </span>
          )}
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px', lineHeight: 1.5 }}>
          Required before payouts can be processed. Direct deposit is an uploaded document (authorization form or voided check) — bank details are never typed into the app.
        </div>

        {docMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
            background: docMsg.success ? 'var(--success-bg)' : 'var(--error-bg)',
            border: `1px solid ${docMsg.success ? 'var(--success-border)' : 'var(--error-border)'}`,
            color: docMsg.success ? 'var(--success)' : 'var(--error)',
          }}>
            {docMsg.message}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {DOC_TYPES.map(doc => {
            const path = docPaths[doc.column];
            const busy = docBusy === doc.column;
            const isInsurance = doc.column === 'insurance_cert_path';
            return (
              <div key={doc.column} style={{
                padding: '10px 12px', borderRadius: '10px',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{doc.label}</span>
                      <span style={{
                        fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                        background: path ? 'var(--success-bg)' : 'var(--error-bg)',
                        color: path ? 'var(--success)' : 'var(--error)',
                      }}>
                        {path ? 'ON FILE' : 'MISSING'}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {path ? docFileName(path) : doc.hint}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                    {path && (
                      <a
                        href={storage.from('cni-docs').getPublicUrl(path).data.publicUrl}
                        target="_blank" rel="noreferrer"
                        style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', textDecoration: 'none', whiteSpace: 'nowrap' }}
                      >
                        📄 View
                      </a>
                    )}
                    <label style={{
                      padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      background: busy ? 'var(--text-muted)' : 'var(--orange)', color: '#fff',
                      cursor: busy ? 'default' : 'pointer', whiteSpace: 'nowrap',
                    }}>
                      {busy ? 'Uploading…' : path ? 'Replace' : 'Upload'}
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.heic"
                        disabled={busy}
                        style={{ display: 'none' }}
                        onChange={e => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) handleDocUpload(doc.column, doc.label, file);
                        }}
                      />
                    </label>
                  </div>
                </div>
                {isInsurance && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', whiteSpace: 'nowrap' }}>Expires</span>
                    <input
                      type="date"
                      value={insuranceExpiry}
                      onChange={e => handleInsuranceExpiry(e.target.value)}
                      style={{ ...inputStyle, width: 'auto', padding: '6px 10px', fontSize: '12px' }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%', padding: '16px', borderRadius: '12px',
          background: saving ? 'var(--text-muted)' : 'var(--orange)',
          color: '#fff', fontSize: '15px', fontWeight: 700, border: 'none',
          marginBottom: '100px',
        }}
      >
        {saving ? 'Saving...' : 'Save Profile'}
      </button>
    </div>
  );
}
