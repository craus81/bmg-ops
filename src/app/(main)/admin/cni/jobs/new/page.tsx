'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PartPicker, { type PickedPart } from '@/components/PartPicker';
import { loadCompaniesWithCounts, type CompanyOption } from '@/lib/cni-companies';
import { uploadJobFiles } from '@/lib/job-files';
import { isVerizonRfidPart } from '@/lib/rfid';

export default function CreateCniJobPage() {
  const router = useRouter();
  const { isAdmin, user } = useAuth();
  const supabase = createClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [companies, setCompanies] = useState<CompanyOption[]>([]);

  // Job form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [budget, setBudget] = useState('');
  const [payPerVehicle, setPayPerVehicle] = useState('');
  const [payoutMode, setPayoutMode] = useState<'company' | 'individual'>('company');
  const [deadline, setDeadline] = useState('');
  const [estimatedHours, setEstimatedHours] = useState('');

  // Part (drives scan_logs logging + Verizon RFID device capture on completion)
  const [part, setPart] = useState<PickedPart | null>(null);

  // Files describing the job (proofs / photos / docs) — uploaded after the
  // job is created so they can live under its id.
  const [jobFiles, setJobFiles] = useState<File[]>([]);

  // Require per-vehicle device capture (serial / IMEI / CCID).
  const [deviceCapture, setDeviceCapture] = useState(false);

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

  // Assignment — company-based: any installer at the company can work the job.
  const [assignCompany, setAssignCompany] = useState(false);
  const [selectedCompanyId, setSelectedCompanyId] = useState('');

  useEffect(() => {
    if (!isAdmin) { router.push('/home'); return; }
    loadCompanies();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [isAdmin]);

  const loadCompanies = async () => {
    setCompanies(await loadCompaniesWithCounts(supabase));
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
    if (!part?.part_number) { setError('A part number is required — every CNI job is tracked by its part'); return; }
    if (!user) return;

    setSaving(true);
    setError('');

    try {
      const validVins = vins.filter(v => v.vin.trim());

      // Per-vehicle pay drives the crew splits; default to budget ÷ VINs.
      const rate = payPerVehicle
        ? parseFloat(payPerVehicle)
        : budget && validVins.length > 0
          ? Math.round((parseFloat(budget) / validVins.length) * 100) / 100
          : null;

      // Create job
      const { data: job, error: jobError } = await supabase
        .from('cni_jobs')
        .insert({
          title: title.trim(),
          description: description.trim() || null,
          scope: scope.trim() || null,
          customer_name: customerName.trim() || null,
          part_number: part?.part_number || null,
          part_description: part?.part_description || null,
          billable_customer: part?.billable_customer || null,
          device_capture: deviceCapture || isVerizonRfidPart(part?.part_number),
          budget: budget ? parseFloat(budget) : null,
          pay_per_vehicle: rate,
          payout_mode: payoutMode,
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
          assigned_company_id: assignCompany && selectedCompanyId ? selectedCompanyId : null,
          assigned_at: assignCompany && selectedCompanyId ? new Date().toISOString() : null,
          status: assignCompany && selectedCompanyId ? 'assigned_awaiting_scheduling' : 'awaiting_assignment',
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

      // Upload attachments under the new job's id, then save the list.
      if (jobFiles.length > 0 && job) {
        const { uploaded } = await uploadJobFiles(job.id, jobFiles);
        if (uploaded.length > 0) {
          await supabase.from('cni_jobs').update({ attachments: uploaded }).eq('id', job.id);
        }
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
          <label style={labelStyle}>Pay per Vehicle ($)</label>
          <input style={inputStyle} type="number" value={payPerVehicle} onChange={e => setPayPerVehicle(e.target.value)} placeholder="Defaults to budget ÷ VIN count" />
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Each completed vehicle splits this across whoever&apos;s tagged on the crew shift.
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Payout Mode</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {([
              { mode: 'company' as const, label: 'Company', sub: 'one invoice + bill to the company' },
              { mode: 'individual' as const, label: 'Individual', sub: 'a NetSuite bill per employee, from their credits' },
            ]).map(opt => (
              <button
                key={opt.mode}
                onClick={() => setPayoutMode(opt.mode)}
                style={{
                  flex: 1, padding: '10px 12px', borderRadius: '10px', textAlign: 'left',
                  background: payoutMode === opt.mode ? 'var(--success-bg)' : 'var(--input-bg)',
                  border: payoutMode === opt.mode ? '1px solid var(--success-border)' : '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {payoutMode === opt.mode ? '✓ ' : ''}{opt.label}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{opt.sub}</div>
              </button>
            ))}
          </div>
        </div>
        <div style={{ marginTop: '12px' }}>
          <label style={labelStyle}>Deadline</label>
          <input style={inputStyle} type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
        </div>
      </div>

      {/* Part */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Part *</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Required — every CNI job is tracked by its part number, which drives scan logging, billing, pay rate, and device capture. The Verizon RFID part (06CS901033) prompts the installer to scan SN / IMEI / CCID.
        </div>
        <PartPicker value={part} onChange={setPart} inputStyle={inputStyle} />
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginTop: '14px' }}>
          <input
            type="checkbox"
            checked={deviceCapture || isVerizonRfidPart(part?.part_number)}
            disabled={isVerizonRfidPart(part?.part_number)}
            onChange={e => setDeviceCapture(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
            Require device capture — installer scans serial #, IMEI, and CCID per vehicle
            {isVerizonRfidPart(part?.part_number) && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (always on for the Verizon RFID part)</span>}
          </span>
        </label>
      </div>

      {/* Files & Proofs */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Files &amp; Proofs</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Attach proofs, photos, or any documents that describe the job. The assigned company&apos;s installers can download these.
        </div>
        <input
          type="file"
          multiple
          onChange={e => setJobFiles(prev => [...prev, ...Array.from(e.target.files || [])])}
          style={{ fontSize: '13px', color: 'var(--text-body)' }}
        />
        {jobFiles.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
            {jobFiles.map((f, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                padding: '8px 12px', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-all' }}>{f.name}</span>
                <button
                  onClick={() => setJobFiles(prev => prev.filter((_, j) => j !== i))}
                  style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, color: 'var(--error)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  Remove
                </button>
              </div>
            ))}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Uploads after the job is created.
            </div>
          </div>
        )}
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

      {/* Assign Company */}
      <div style={sectionStyle}>
        <div style={sectionTitle}>Assign Installation Company</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginBottom: '12px' }}>
          <input
            type="checkbox" checked={assignCompany}
            onChange={e => setAssignCompany(e.target.checked)}
            style={{ width: '18px', height: '18px', accentColor: 'var(--orange)' }}
          />
          <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>Assign a company now</span>
        </label>
        {assignCompany && (
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
              Every installer at the company can see the job, propose the schedule, and scan — whoever&apos;s working tags the crew per shift.
            </div>
            {companies.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '12px', textAlign: 'center' }}>
                No CNI companies yet — they&apos;re created automatically when installers register, or at /admin/cni/companies
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {companies.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedCompanyId(c.id === selectedCompanyId ? '' : c.id)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '12px 14px', borderRadius: '10px', textAlign: 'left', width: '100%',
                      background: c.id === selectedCompanyId ? 'var(--success-bg)' : 'var(--input-bg)',
                      border: c.id === selectedCompanyId ? '1px solid var(--success-border)' : '1px solid var(--border)',
                    }}
                  >
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {c.memberCount} installer{c.memberCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    {c.id === selectedCompanyId && (
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
        disabled={saving || !title.trim() || !part?.part_number}
        style={{
          width: '100%', padding: '16px', borderRadius: '12px',
          background: saving || !title.trim() || !part?.part_number ? 'var(--text-muted)' : 'var(--orange)',
          color: '#fff', fontSize: '15px', fontWeight: 700, border: 'none',
          marginBottom: '100px',
        }}
      >
        {saving ? 'Creating Job...' : !part?.part_number ? 'Select a Part to Continue' : 'Create CNI Job'}
      </button>
    </div>
  );
}
