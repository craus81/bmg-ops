'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

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
  const { user, isInstaller, isAdmin } = useAuth();
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

  useEffect(() => {
    if (!user) return;
    if (!isInstaller && !isAdmin) { router.push('/home'); return; }
    loadProfile();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user, isInstaller, isAdmin]);

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
    }
    setLoading(false);
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
          <input style={inputStyle} value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 555-5555" />
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
