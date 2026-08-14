'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import PhoneInput from '@/components/PhoneInput';

const SERVICE_TYPE_OPTIONS = [
  { id: 'graphics_install', label: 'Graphics Installation' },
  { id: 'tech_install', label: 'Technology Installation' },
  { id: 'upfitting', label: 'Upfitting' },
  { id: 'removal_rebrand', label: 'Removal / Rebrand' },
];

const EQUIPMENT_OPTIONS = [
  { id: 'indoor', label: 'Indoor Install Capability' },
  { id: 'outdoor', label: 'Outdoor Only' },
  { id: 'lift_bucket', label: 'Lift / Bucket Truck Access' },
  { id: 'shop', label: 'Shop' },
  { id: 'mobile', label: 'Mobile' },
];

export default function CniOnboardingPage() {
  const router = useRouter();
  const supabase = createClient();
  const [step, setStep] = useState(0); // 0=loading, 1=profile, 2=done
  const [userId, setUserId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

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

  useEffect(() => {
    checkAuth();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, []);

  const checkAuth = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user) {
      // Not logged in — redirect to login
      router.replace('/login');
      return;
    }
    setUserId(session.user.id);

    // Load any existing CNI profile data (stub created by invite)
    const { data: cniProfile } = await supabase
      .from('cni_profiles')
      .select('*')
      .eq('user_id', session.user.id)
      .single();

    if (cniProfile) {
      if (cniProfile.profile_complete) {
        // Already completed — go to installer home
        router.replace('/installer');
        return;
      }
      setPhone(cniProfile.phone || '');
      setContactName(cniProfile.primary_contact_name || '');
      const addr = cniProfile.business_address || {};
      setStreet(addr.street || '');
      setCity(addr.city || '');
      setState(addr.state || '');
      setZip(addr.zip || '');
      setCoverageRadius(cniProfile.coverage_radius_miles?.toString() || '');
      setServiceTypes(cniProfile.service_types || []);
      setEquipmentCapabilities(cniProfile.equipment_capabilities || []);
    }

    // Pre-fill contact name, and show the company the invite linked —
    // membership is profiles.company_id (set at invite), read-only here.
    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, company_id')
      .eq('id', session.user.id)
      .single();
    if (profile && !cniProfile?.primary_contact_name) {
      setContactName(profile.full_name || '');
    }
    if (profile?.company_id) {
      const { data: company } = await supabase
        .from('companies').select('name').eq('id', profile.company_id).maybeSingle();
      setCompanyName(company?.name || '');
    }

    setStep(1);
  };

  const toggleItem = (list: string[], setList: (v: string[]) => void, item: string) => {
    setList(list.includes(item) ? list.filter(i => i !== item) : [...list, item]);
  };

  const handleSubmit = async () => {
    if (!userId) return;
    if (!contactName.trim() || !phone.trim() || !city.trim()) {
      setError('Please fill in all required fields (contact name, phone, city)');
      return;
    }
    if (serviceTypes.length === 0) {
      setError('Please select at least one service type');
      return;
    }

    setSaving(true);
    setError('');

    const { error: dbError } = await supabase.from('cni_profiles').upsert({
      user_id: userId,
      primary_contact_name: contactName.trim(),
      phone: phone.trim(),
      business_address: { street: street.trim(), city: city.trim(), state: state.trim(), zip: zip.trim() },
      coverage_radius_miles: coverageRadius ? parseInt(coverageRadius) : null,
      service_types: serviceTypes,
      equipment_capabilities: equipmentCapabilities,
      availability_status: 'available',
      profile_complete: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    setSaving(false);

    if (dbError) {
      setError('Failed to save profile. Please try again.');
      return;
    }

    setStep(2);
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 700, color: '#e8f0f8', marginBottom: '6px', display: 'block',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: '10px',
    border: '1px solid rgba(255,255,255,0.08)', background: '#111a24',
    color: '#f5f8fc', fontSize: '14px',
  };

  // Loading state
  if (step === 0) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: '36px', height: '36px', border: '3px solid rgba(255,255,255,0.1)',
          borderTopColor: '#1e4a5e', borderRadius: '50%',
          animation: 'spin 1s linear infinite',
        }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Done state
  if (step === 2) {
    return (
      <div style={{
        minHeight: '100vh', background: 'var(--bg)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '20px',
      }}>
        <div style={{
          maxWidth: '440px', width: '100%', textAlign: 'center',
          background: '#161f2b', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '20px', padding: '40px 24px',
        }}>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#f5f8fc', marginBottom: '8px' }}>
            You&apos;re All Set!
          </div>
          <div style={{ fontSize: '14px', color: '#8899aa', lineHeight: 1.6, marginBottom: '24px' }}>
            Your CNI profile is complete. You&apos;ll start receiving job invitations based on your services and coverage area.
          </div>
          <button
            onClick={() => router.push('/installer')}
            style={{
              width: '100%', padding: '14px', borderRadius: '12px', fontSize: '15px', fontWeight: 700,
              background: '#ee3120', color: '#fff', border: 'none', cursor: 'pointer',
            }}
          >
            Go to My Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Profile form
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg)', padding: '20px',
      display: 'flex', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: '480px', width: '100%' }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '28px', paddingTop: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: '#ee3120', letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '6px' }}>BMG Fleet</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#f5f8fc', letterSpacing: '-0.5px' }}>
            Complete Your CNI Profile
          </div>
          <div style={{ fontSize: '13px', color: '#8899aa', marginTop: '6px' }}>
            Fill out your information to start receiving jobs
          </div>
        </div>

        {/* Progress indicator */}
        <div style={{ display: 'flex', gap: '4px', marginBottom: '24px' }}>
          {['Business Info', 'Services', 'Location'].map((label, i) => (
            <div key={label} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: '3px', borderRadius: '2px', marginBottom: '6px',
                background: '#ee3120', opacity: 1,
              }} />
              <div style={{ fontSize: '10px', fontWeight: 600, color: '#8899aa' }}>{label}</div>
            </div>
          ))}
        </div>

        {error && (
          <div style={{
            padding: '12px 16px', borderRadius: '10px', marginBottom: '16px',
            background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
            color: '#f87171', fontSize: '13px', fontWeight: 600,
          }}>
            {error}
          </div>
        )}

        {/* Business Info */}
        <div style={{
          padding: '18px', borderRadius: '14px', marginBottom: '14px',
          background: '#161f2b', border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#f5f8fc', marginBottom: '16px' }}>
            Business Information
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Company</label>
            <div style={{ ...inputStyle, background: 'transparent', opacity: 0.85 }}>
              {companyName || 'Set by BMG when you were invited'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Wrong company? Let your BMG contact know — membership is managed on BMG&apos;s side.
            </div>
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Primary Contact *</label>
            <input style={inputStyle} value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Full name" />
          </div>
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Phone *</label>
            <PhoneInput style={inputStyle} value={phone} onChange={v => setPhone(v)} placeholder="(555) 123-4567" />
          </div>
        </div>

        {/* Services */}
        <div style={{
          padding: '18px', borderRadius: '14px', marginBottom: '14px',
          background: '#161f2b', border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#f5f8fc', marginBottom: '16px' }}>
            Services Offered *
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' }}>
            {SERVICE_TYPE_OPTIONS.map(opt => {
              const active = serviceTypes.includes(opt.id);
              return (
                <button key={opt.id} onClick={() => toggleItem(serviceTypes, setServiceTypes, opt.id)} style={{
                  padding: '10px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                  background: active ? 'rgba(238,49,32,0.12)' : '#111a24',
                  border: `1px solid ${active ? '#ee3120' : 'rgba(255,255,255,0.08)'}`,
                  color: active ? '#ee3120' : '#8899aa', cursor: 'pointer',
                }}>
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: '14px', fontWeight: 700, color: '#f5f8fc', marginBottom: '12px' }}>
            Equipment &amp; Capabilities
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {EQUIPMENT_OPTIONS.map(opt => {
              const active = equipmentCapabilities.includes(opt.id);
              return (
                <button key={opt.id} onClick={() => toggleItem(equipmentCapabilities, setEquipmentCapabilities, opt.id)} style={{
                  padding: '10px 16px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
                  background: active ? 'rgba(42,97,120,0.15)' : '#111a24',
                  border: `1px solid ${active ? '#2a6178' : 'rgba(255,255,255,0.08)'}`,
                  color: active ? '#5cb8d4' : '#8899aa', cursor: 'pointer',
                }}>
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Location */}
        <div style={{
          padding: '18px', borderRadius: '14px', marginBottom: '20px',
          background: '#161f2b', border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ fontSize: '14px', fontWeight: 700, color: '#f5f8fc', marginBottom: '16px' }}>
            Location &amp; Coverage
          </div>

          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Street Address</label>
            <input style={inputStyle} value={street} onChange={e => setStreet(e.target.value)} placeholder="123 Main St" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>City *</label>
              <input style={inputStyle} value={city} onChange={e => setCity(e.target.value)} placeholder="City" />
            </div>
            <div>
              <label style={labelStyle}>State</label>
              <input style={inputStyle} value={state} onChange={e => setState(e.target.value)} placeholder="ST" maxLength={2} />
            </div>
            <div>
              <label style={labelStyle}>Zip</label>
              <input style={inputStyle} value={zip} onChange={e => setZip(e.target.value)} placeholder="12345" />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Coverage Radius (miles)</label>
            <input style={inputStyle} type="number" value={coverageRadius} onChange={e => setCoverageRadius(e.target.value)} placeholder="50" />
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={saving}
          style={{
            width: '100%', padding: '16px', borderRadius: '12px', fontSize: '15px', fontWeight: 700,
            background: saving ? '#666' : '#ee3120', color: '#fff', border: 'none',
            cursor: saving ? 'default' : 'pointer', marginBottom: '16px',
          }}
        >
          {saving ? 'Saving...' : 'Complete Profile'}
        </button>

        <div style={{ textAlign: 'center', fontSize: '12px', color: '#556677', paddingBottom: '40px' }}>
          You can update this information anytime from your installer dashboard.
        </div>
      </div>
    </div>
  );
}
