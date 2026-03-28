'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface InstallerOption {
  id: string;
  full_name: string;
  company_name: string | null;
  service_area: any;
  availability_status: string;
}

export default function CreateCniJobPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [installers, setInstallers] = useState<InstallerOption[]>([]);

  // Job form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [budget, setBudget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [estimatedHours, setEstimatedHours] = useState('');

  // Location
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [siteContactName, setSiteContactName] = useState('');
  const [siteContactPhone, setSiteContactPhone] = useState('');
  const [siteContactEmail, setSiteContactEmail] = useState('');

  // VINs
  const [isMultiUnit, setIsMultiUnit] = useState(false);
  const [vins, setVins] = useState<{ vin: string; year: string; make: string; model: string }[]>([
    { vin: '', year: '', make: '', model: '' },
  ]);

  // Materials
  const [requiresShipment, setRequiresShipment] = useState(false);
  const [shipStreet, setShipStreet] = useState('');
  const [shipCity, setShipCity] = useState('');
  const [shipState, setShipState] = useState('');
  const [shipZip, setShipZip] = useState('');

  // Assignment
  const [assignInstaller, setAssignInstaller] = useState(false);
  const [selectedInstallerId, setSelectedInstallerId] = useState('');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadInstallers();
  }, [isAdmin]);

  const loadInstallers = async () => {
    const { data } = await supabase
      .from('cni_profiles')
      .select('user_id, company_name, service_area, availability_status')
      .not('risk_tags', 'cs', '{do_not_assign}');
    if (data) {
      const userIds = data.map((p: any) => p.user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', userIds);
      const nameMap: Record<string, string> = {};
      if (profiles) profiles.forEach((p: any) => { nameMap[p.id] = p.full_name; });
      setInstallers(data.map((p: any) => ({
        id: p.user_id,
        full_name: nameMap[p.user_id] || 'Unknown',
        company_name: p.company_name,
        service_area: p.service_area,
        availability_status: p.availability_status,
      })));
    }
  };

  const addVin = () => {
    setVins([...vins, { vin: '', year: '', make: '', model: '' }]);
  };

  const removeVin = (idx: number) => {
    if (vins.length <= 1) return;
    setVins(vins.filter((_, i) => i !== idx));
  };

  const updateVin = (idx: number, field: string, value: string) => {
    const updated = [...vins];
    (updated[idx] as any)[field] = value;
    setVins(updated);
  };

  const handleSubmit = async () => {
    if (!title.trim()) { setError('Job title is required'); return; }
    if (!user) return;

    setSaving(true);
    setError('');

    try {
      const validVins = vins.filter(v => v.vin.trim());

      // Create job
      const { data: job, error: jobError } = await supabase
        .from('cni_jobs')
        .insert({
          title: title.trim(),
          description: description.trim() || null,
          scope: scope.trim() || null,
          customer_name: customerName.trim() || null,
          budget: budget ? parseFloat(budget) : null,
          deadline: deadline || null,
          estimated_hours: estimatedHours ? parseFloat(estimatedHours) : null,
          address: { street, city, state, zip },
          site_contact_name: siteContactName.trim() || null,
          site_contact_phone: siteContactPhone.trim() || null,
          site_contact_email: siteContactEmail.trim() || null,
          is_multi_unit: validVins.length > 1,
          vin_count: validVins.length || 1,
          requires_shipment: requiresShipment,
          shipping_address: requiresShipment ? { street: shipStreet, city: shipCity, state: shipState, zip: shipZip } : null,
          assigned_installer_id: assignInstaller && selectedInstallerId ? selectedInstallerId : null,
          assigned_at: assignInstaller && selectedInstallerId ? new Date().toISOString() : null,
          status: assignInstaller && selectedInstallerId ? 'assigned_awaiting_scheduling' : 'awaiting_assignment',
          created_by: user.id,
        })
        .select()
        .single();

      if (jobError) throw jobError;

      // Create VIN records
      if (validVins.length > 0 && job) {
        const vinRecords = validVins.map((v, i) => ({
          job_id: job.id,
          vin: v.vin.trim().toUpperCase(),
          vehicle_year: v.year.trim() || null,
          vehicle_make: v.make.trim() || null,
          vehicle_model: v.model.trim() || null,
          sort_order: i,
        }));
        const { error: vinError } = await supabase
          .from('cni_job_vins')
          .insert(vinRecords);
        if (vinError) console.error('VIN insert error:', vinError);
      }

      router.push(`/admin/cni/jobs/${job.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create job');
      setSaving(false);
    }
  };

  if (!isAdmin) return null;

  const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 700, color: 'var(--text-label)',
    marginBottom: '6px', display: 'block',
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '12px 14px', borderRadius: '10px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '14px',
  };
  const sectionStyle: React.CSSProperties = {
    padding: '16px', borderRadius: '14px', marginBottom: '14px',
    background: 'var(--card)', border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-sm)',
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)',
    marginBottom: '14px',
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button onClick={() => router.back()} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            New CNI Job
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Create a graphics installation job</div>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '12px 16px', borderRadius: '10px', marginBottom: '14px',
          background: 'var(--error-bg)', border: '1px solid var(--error-border)',
          color: 'var(--error)', fontSize: '13px', fontWeight: 600,
        }}>
          {error}
        </div>
      )}

      {/* Job Details */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Job Details</div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Title *</label>
          <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Masterack Fleet Wrap — Kansas City" />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Customer</label>
          <input style={inputStyle} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="e.g. Masterack" />
        </div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Scope / Description</label>
          <textarea style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }} value={scope} onChange={e => setScope(e.target.value)} placeholder="What needs to be installed..." />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>Budget ($)</label>
            <input style={inputStyle} type="number" value={budget} onChange={e => setBudget(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label style={labelStyle}>Estimated Hours</label>
            <input style={inputStyle} type="number" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} placeholder="0" />
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Deadline</label>
          <input style={inputStyle} type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
        </div>
      </div>

      {/* Install Location */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Install Location</div>
        <div style={{ marginBottom: '12px' }}>
          <label style={labelStyle}>Street Address</label>
          <input style={inputStyle} value={street} onChange={e => setStreet(e.target.value)} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>City</label>
            <input style={inputStyle} value={city} onChange={e => setCity(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>State</label>
            <input style={inputStyle} value={state} onChange={e => setState(e.target.value)} maxLength={2} />
          </div>
          <div>
            <label style={labelStyle}>ZIP</label>
            <input style={inputStyle} value={zip} onChange={e => setZip(e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Site Contact</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <input style={inputStyle} value={siteContactName} onChange={e => setSiteContactName(e.target.value)} placeholder="Name" />
            <input style={inputStyle} value={siteContactPhone} onChange={e => setSiteContactPhone(e.target.value)} placeholder="Phone" />
          </div>
          <input style={{ ...inputStyle, marginTop: '10px' }} value={siteContactEmail} onChange={e => setSiteContactEmail(e.target.value)} placeholder="Email" />
        </div>
      </div>

      {/* VINs */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div style={sectionTitle}>VINs</div>
          <button onClick={addVin} style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
            background: 'var(--subtle-bg)', color: 'var(--text-secondary)', border: '1px solid var(--border)',
          }}>
            + Add VIN
          </button>
        </div>
        {vins.map((v, i) => (
          <div key={i} style={{
            padding: '12px', borderRadius: '10px', marginBottom: '8px',
            background: 'var(--input-bg)', border: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)' }}>VIN #{i + 1}</span>
              {vins.length > 1 && (
                <button onClick={() => removeVin(i)} style={{ fontSize: '11px', color: 'var(--error)', fontWeight: 600 }}>Remove</button>
              )}
            </div>
            <input
              style={{ ...inputStyle, marginBottom: '8px', fontFamily: 'monospace', textTransform: 'uppercase' }}
              value={v.vin} onChange={e => updateVin(i, 'vin', e.target.value)}
              placeholder="VIN" maxLength={17}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <input style={inputStyle} value={v.year} onChange={e => updateVin(i, 'year', e.target.value)} placeholder="Year" />
              <input style={inputStyle} value={v.make} onChange={e => updateVin(i, 'make', e.target.value)} placeholder="Make" />
              <input style={inputStyle} value={v.model} onChange={e => updateVin(i, 'model', e.target.value)} placeholder="Model" />
            </div>
          </div>
        ))}
      </div>

      {/* Materials */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Materials</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
          <input
            type="checkbox" checked={requiresShipment}
            onChange={e => setRequiresShipment(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>This job requires material shipment</span>
        </label>
        {requiresShipment && (
          <div style={{ marginTop: '14px' }}>
            <label style={labelStyle}>Shipping Address</label>
            <input style={{ ...inputStyle, marginBottom: '8px' }} value={shipStreet} onChange={e => setShipStreet(e.target.value)} placeholder="Street" />
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px' }}>
              <input style={inputStyle} value={shipCity} onChange={e => setShipCity(e.target.value)} placeholder="City" />
              <input style={inputStyle} value={shipState} onChange={e => setShipState(e.target.value)} placeholder="State" maxLength={2} />
              <input style={inputStyle} value={shipZip} onChange={e => setShipZip(e.target.value)} placeholder="ZIP" />
            </div>
          </div>
        )}
      </div>

      {/* Assign Installer */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Assign Installer</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginBottom: '12px' }}>
          <input
            type="checkbox" checked={assignInstaller}
            onChange={e => setAssignInstaller(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>Assign an installer now</span>
        </label>
        {assignInstaller && (
          <div>
            {installers.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '12px', textAlign: 'center' }}>
                No CNI installers registered yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {installers.map(inst => (
                  <button
                    key={inst.id}
                    onClick={() => setSelectedInstallerId(inst.id === selectedInstallerId ? '' : inst.id)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: '10px', textAlign: 'left', width: '100%',
                      background: inst.id === selectedInstallerId ? 'var(--success-bg)' : 'var(--input-bg)',
                      border: inst.id === selectedInstallerId ? '1px solid var(--success-border)' : '1px solid var(--border)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{inst.full_name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {inst.company_name || 'Independent'} • {inst.availability_status}
                      </div>
                    </div>
                    {inst.id === selectedInstallerId && (
                      <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: '14px' }}>✓</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Submit */}
      <button
        onClick={handleSubmit}
        disabled={saving || !title.trim()}
        style={{
          width: '100%', padding: '16px', borderRadius: '12px',
          background: saving || !title.trim() ? 'var(--text-muted)' : 'var(--orange)',
          color: '#fff', fontSize: '15px', fontWeight: 700, border: 'none',
          marginBottom: '100px',
        }}
      >
        {saving ? 'Creating Job...' : 'Create CNI Job'}
      </button>
    </div>
  );
}
