'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { DropZone } from '@/components/DropZone';
import PartPicker, { type PickedPart } from '@/components/PartPicker';
import PhoneInput from '@/components/PhoneInput';
import { loadCompaniesWithCounts, type CompanyOption } from '@/lib/cni-companies';
import { loadBillableCustomers, type BillableCustomer } from '@/lib/billable-customers';
import { uploadJobFiles } from '@/lib/job-files';
import { isVerizonRfidPart } from '@/lib/rfid';

export default function CreateCniJobPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, user, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [companies, setCompanies] = useState<CompanyOption[]>([]);

  // Bridge: created from a graphics job or a fleet check-in (?fromGraphics= /
  // ?fromCheckin=). The source is stamped on the job (find-or-create: the DB's
  // partial unique index guarantees one CNI job per source), and any vehicles
  // already tied to the source seed cni_job_vins as pending rows.
  const [source, setSource] = useState<{ type: 'graphics_job' | 'fleet_checkin'; id: string; label: string } | null>(null);
  const [sourceVins, setSourceVins] = useState<Array<{
    vin: string; vehicle_year: string | null; vehicle_make: string | null;
    vehicle_model: string | null; checkin_id: string | null;
  }>>([]);

  // Job form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('');
  // Customer picker: the same billable_customers list the scan flow offers,
  // because Reading Truck vs Masterack can't be told apart by location or
  // part anymore. The choice lands on cni_jobs.billable_customer, which
  // /api/cni/complete-vin stamps on every scan the installers log.
  const [billableCustomers, setBillableCustomers] = useState<BillableCustomer[]>([]);
  const [customerChoice, setCustomerChoice] = useState(''); // '' | canonical name | '__other__'
  const [customerName, setCustomerName] = useState(''); // free text for "Other…"
  const [budget, setBudget] = useState('');
  const [payPerVehicle, setPayPerVehicle] = useState('');
  // Optional expected vehicle count — counts down as VINs are scanned so the
  // installer sees what's left. Blank = open-ended. Not a completion gate.
  const [targetQuantity, setTargetQuantity] = useState('');
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
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('cni_admin')) { router.push('/home'); return; }
    loadCompanies();
    const customersPromise = loadBillableCustomers(supabase);
    customersPromise.then(setBillableCustomers);
    prefillFromSource(customersPromise);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin]);

  const loadCompanies = async () => {
    setCompanies(await loadCompaniesWithCounts(supabase));
  };

  // Map a customer name onto the picker: canonical entry when it matches the
  // billable_customers list (by name or label), free-text "Other…" otherwise.
  const pickCustomer = (name: string | null, customers: BillableCustomer[]) => {
    if (!name) return;
    const hit = customers.find(c =>
      c.name.toLowerCase() === name.toLowerCase() || c.label.toLowerCase() === name.toLowerCase());
    if (hit) { setCustomerChoice(hit.name); }
    else { setCustomerChoice('__other__'); setCustomerName(name); }
  };

  // Optional default part from the source's part number (first comma token) —
  // going through netsuite_parts re-arms the Verizon device-capture detection.
  const prefillPart = async (partNumber: string | null) => {
    const first = (partNumber || '').split(',')[0].trim();
    if (!first) return;
    const { data: p } = await supabase
      .from('netsuite_parts')
      .select('item_number, display_name, description, billable_customer')
      .ilike('item_number', first)
      .limit(1)
      .maybeSingle();
    if (p) {
      setPart({
        part_number: p.item_number,
        part_description: p.display_name || p.description || null,
        billable_customer: p.billable_customer || null,
      });
    }
  };

  const prefillFromSource = async (customersPromise: Promise<BillableCustomer[]>) => {
    const fromGraphics = searchParams.get('fromGraphics');
    const fromCheckin = searchParams.get('fromCheckin');
    if (!fromGraphics && !fromCheckin) return;
    const customers = await customersPromise;

    if (fromGraphics) {
      // Find-or-create: one CNI job per graphics job.
      const { data: existing } = await supabase
        .from('cni_jobs').select('id').eq('source_graphics_job_id', fromGraphics).maybeSingle();
      if (existing) { router.replace(`/admin/cni/jobs/${existing.id}`); return; }

      const { data: gj } = await supabase
        .from('graphics_jobs')
        .select('id, job_number, title, customer, part_number, quantity, content, notes, po_number, due_date, scheduled_install_date, ship_to')
        .eq('id', fromGraphics)
        .maybeSingle();
      if (!gj) return;

      setTitle(gj.title || '');
      pickCustomer(gj.customer, customers);
      const scopeParts = [gj.content, gj.notes, gj.po_number ? `Customer PO #${gj.po_number}` : null];
      setTargetQuantity(gj.quantity ? String(gj.quantity) : '');
      setDeadline(
        gj.scheduled_install_date && gj.scheduled_install_date !== 'N/A'
          ? gj.scheduled_install_date
          : (gj.due_date || ''));
      await prefillPart(gj.part_number);

      // ship_to is free text — best-effort parse into the shipping address
      // (outsourced installs ship the printed graphics to the site). On
      // parse failure the text lands verbatim in scope so nothing is lost.
      if (gj.ship_to) {
        const linesArr = String(gj.ship_to).split('\n').map((l: string) => l.trim()).filter(Boolean);
        const m = linesArr.length > 1
          ? linesArr[linesArr.length - 1].match(/^(.+?),\s*([A-Za-z]{2})\.?,?\s+(\d{5})(-\d{4})?$/)
          : null;
        if (m) {
          const streetLines = linesArr.slice(0, -1).join(', ');
          setStreet(streetLines); setCity(m[1]); setState(m[2].toUpperCase()); setZip(m[3]);
          setRequiresShipment(true);
          setShipStreet(streetLines); setShipCity(m[1]); setShipState(m[2].toUpperCase()); setShipZip(m[3]);
        } else {
          scopeParts.push(`Ship to:\n${gj.ship_to}`);
        }
      }
      setScope(scopeParts.filter(Boolean).join('\n\n'));

      // Vehicles already matched to this graphics job seed the VIN list.
      const { data: checkins } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model')
        .eq('matched_graphics_job_id', gj.id)
        .is('archived_at', null);
      type CheckinRow = { id: string; vin: string | null; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null };
      setSourceVins(((checkins || []) as CheckinRow[]).filter(c => c.vin).map(c => ({
        vin: c.vin as string, vehicle_year: c.vehicle_year, vehicle_make: c.vehicle_make,
        vehicle_model: c.vehicle_model, checkin_id: c.id,
      })));
      setSource({ type: 'graphics_job', id: gj.id, label: `graphics job ${gj.job_number || gj.title || ''}`.trim() });
      return;
    }

    if (fromCheckin) {
      const { data: existing } = await supabase
        .from('cni_jobs').select('id').eq('source_checkin_id', fromCheckin).maybeSingle();
      if (existing) { router.replace(`/admin/cni/jobs/${existing.id}`); return; }

      const { data: fc } = await supabase
        .from('fleet_checkins')
        .select('id, vin, vehicle_year, vehicle_make, vehicle_model, customer_name, notes, promised_back_date, scheduled_upfit_date, install_instructions, on_site_contact_name, on_site_contact_phone')
        .eq('id', fromCheckin)
        .maybeSingle();
      if (!fc) return;

      const vehicleLabel = [fc.vehicle_year, fc.vehicle_make, fc.vehicle_model].filter(Boolean).join(' ') || fc.vin;
      setTitle(`${fc.customer_name || 'Install'} — ${vehicleLabel}`);
      pickCustomer(fc.customer_name, customers);
      setScope([fc.install_instructions, fc.notes].filter(Boolean).join('\n\n'));
      setDeadline(fc.promised_back_date || fc.scheduled_upfit_date || '');
      setTargetQuantity('1');
      if (fc.on_site_contact_name) setSiteContactName(fc.on_site_contact_name);
      if (fc.on_site_contact_phone) setSiteContactPhone(fc.on_site_contact_phone);
      if (fc.vin) {
        setSourceVins([{
          vin: fc.vin, vehicle_year: fc.vehicle_year, vehicle_make: fc.vehicle_make,
          vehicle_model: fc.vehicle_model, checkin_id: fc.id,
        }]);
      }
      setSource({ type: 'fleet_checkin', id: fc.id, label: `check-in VIN ${fc.vin || '?'}` });
    }
  };

  const handleSubmit = async () => {
    if (!title.trim()) { setError('Job title is required'); return; }
    // Part is an optional default now — the installer picks the part when they
    // start scanning, and completed VINs still reach the Scan Log without one.
    if (!user) return;

    setSaving(true);
    setError('');

    try {
      // Per-vehicle pay drives the crew splits. Vehicles are scanned in the
      // field, not pre-loaded, so the rate is set explicitly here.
      const rate = payPerVehicle ? parseFloat(payPerVehicle) : null;

      // The admin's explicit customer choice wins; a typed "Other" name is
      // next; the default part's tag only backstops jobs with no choice.
      const picked = billableCustomers.find(c => c.name === customerChoice) || null;
      const typedCustomer = customerChoice === '__other__' ? customerName.trim() : '';

      // Create job. Assignment happens AFTER the insert via the
      // assign-company route so the cni_assigned notification fires for
      // creation-time assignment too (it never did when the company was
      // stamped directly on the insert).
      const { data: job, error: jobError } = await supabase
        .from('cni_jobs')
        .insert({
          title: title.trim(),
          description: description.trim() || null,
          scope: scope.trim() || null,
          customer_name: picked?.label || typedCustomer || null,
          part_number: part?.part_number || null,
          part_description: part?.part_description || null,
          billable_customer: picked?.name || typedCustomer || part?.billable_customer || null,
          device_capture: deviceCapture || isVerizonRfidPart(part?.part_number),
          budget: budget ? parseFloat(budget) : null,
          target_quantity: targetQuantity ? parseInt(targetQuantity) : null,
          pay_per_vehicle: rate,
          payout_mode: payoutMode,
          deadline: deadline || null,
          estimated_hours: estimatedHours ? parseFloat(estimatedHours) : null,
          address: { street, city, state, zip },
          site_contact_name: siteContactName.trim() || null,
          site_contact_phone: siteContactPhone.trim() || null,
          site_contact_email: siteContactEmail.trim() || null,
          requires_shipment: requiresShipment,
          shipping_address: requiresShipment ? { street: shipStreet, city: shipCity, state: shipState, zip: shipZip } : null,
          status: 'awaiting_assignment',
          source_graphics_job_id: source?.type === 'graphics_job' ? source.id : null,
          source_checkin_id: source?.type === 'fleet_checkin' ? source.id : null,
          created_by: user.id,
        })
        .select()
        .single();

      if (jobError) {
        // Unique-index race on the source link: someone else bridged this
        // source first — go to their job instead of erroring.
        if ((jobError as { code?: string }).code === '23505' && source) {
          const col = source.type === 'graphics_job' ? 'source_graphics_job_id' : 'source_checkin_id';
          const { data: winner } = await supabase
            .from('cni_jobs').select('id').eq(col, source.id).maybeSingle();
          if (winner) { router.replace(`/admin/cni/jobs/${winner.id}`); return; }
        }
        throw jobError;
      }

      // Seed the source's vehicles as pending VIN rows — they ride the
      // existing machinery untouched (installer completes them, photos and
      // credits attach per VIN). Non-fatal: vehicles can be added on the job
      // page if this insert fails.
      if (sourceVins.length > 0 && job) {
        await supabase.from('cni_job_vins').insert(sourceVins.map((v, i) => ({
          job_id: job.id,
          vin: v.vin.toUpperCase(),
          vehicle_year: v.vehicle_year,
          vehicle_make: v.vehicle_make,
          vehicle_model: v.vehicle_model,
          status: 'pending',
          sort_order: i,
          checkin_id: v.checkin_id,
        })));
      }

      // Upload attachments under the new job's id, then save the list.
      if (jobFiles.length > 0 && job) {
        const { uploaded } = await uploadJobFiles(job.id, jobFiles);
        if (uploaded.length > 0) {
          await supabase.from('cni_jobs').update({ attachments: uploaded }).eq('id', job.id);
        }
      }

      // Assign through the route so installers get the cni_assigned
      // notification. Non-fatal: on failure the job page opens unassigned
      // with the assign UI front and center.
      if (assignCompany && selectedCompanyId && job) {
        const { data: { session } } = await supabase.auth.getSession();
        await fetch('/api/cni/assign-company', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ jobId: job.id, companyId: selectedCompanyId }),
        }).catch(() => {});
      }

      router.push(`/admin/cni/jobs/${job.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create job');
      setSaving(false);
    }
  };

  // Render guard matches the effect's gate — cni_admin, not raw admin, so a
  // delegated coordinator sees the form instead of a blank page.
  if (authLoading || !hasFeature('cni_admin')) return null;

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

      {source && (
        <div style={{
          padding: '10px 14px', borderRadius: '10px', marginBottom: '14px',
          background: 'var(--success-bg)', border: '1px solid var(--success-border)',
          color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
        }}>
          Prefilled from {source.label}
          {sourceVins.length > 0 && ` — ${sourceVins.length} vehicle${sourceVins.length === 1 ? '' : 's'} will be added to the job`}
          . Review and adjust anything below before creating.
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
          <select
            style={inputStyle}
            value={customerChoice}
            onChange={e => setCustomerChoice(e.target.value)}
          >
            <option value="">— Select customer —</option>
            {billableCustomers.map(c => (
              <option key={c.name} value={c.name}>{c.label}</option>
            ))}
            <option value="__other__">Other…</option>
          </select>
          {customerChoice === '__other__' && (
            <input
              style={{ ...inputStyle, marginTop: '8px' }}
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              placeholder="Customer name"
              autoFocus
            />
          )}
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Who gets invoiced — stamped on every VIN the installers scan.
          </div>
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
          <div>
            <label style={labelStyle}>Target Vehicles</label>
            <input style={inputStyle} type="number" value={targetQuantity} onChange={e => setTargetQuantity(e.target.value)} placeholder="Optional — counts down as scanned" />
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
        <div style={sectionTitle}>Part (optional default)</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          Optional — sets the default part for this job&apos;s scans. The installer can pick the part when they start work, and completed VINs still reach the Scan Log without one (flagged &ldquo;needs part&rdquo;). The Verizon RFID part (06CS901033) prompts the installer to scan SN / IMEI / CCID.
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
      <DropZone
        onFiles={files => setJobFiles(prev => [...prev, ...files])}
        multiple
        style={sectionStyle}
      >
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
      </DropZone>

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
            <PhoneInput style={inputStyle} value={siteContactPhone} onChange={v => setSiteContactPhone(v)} placeholder="Phone" />
          </div>
          <input style={{ ...inputStyle, marginTop: '10px' }} value={siteContactEmail} onChange={e => setSiteContactEmail(e.target.value)} placeholder="Email" />
        </div>
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
