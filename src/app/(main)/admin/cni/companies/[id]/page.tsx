'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { storage } from '@/lib/storage';
import NetsuiteVendorSearch, { type NsVendor } from '@/components/NetsuiteVendorSearch';

interface CniCompany {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  netsuite_vendor_id: string | null;
  primary_contact_profile_id: string | null;
  w9_file_path: string | null;
  insurance_cert_path: string | null;
  insurance_expiry: string | null;
  direct_deposit_file_path: string | null;
}

// Company-level compliance documents (per-person docs stay on cni_profiles).
// Files live in R2 under the cni-docs prefix; only the path is stored on the
// company row — no structured financial data in the app.
const COMPANY_DOCS = [
  { column: 'w9_file_path', label: 'W-9' },
  { column: 'insurance_cert_path', label: 'Insurance Certificate' },
  { column: 'direct_deposit_file_path', label: 'Direct Deposit Form' },
] as const;
type DocColumn = typeof COMPANY_DOCS[number]['column'];

// Storage paths embed the original filename after `<column>-<timestamp>-`.
const docFileName = (path: string) =>
  (path.split('/').pop() || path).replace(/^[a-z0-9_]+-\d+-/i, '');

// Membership lives on profiles.company_id (the shared companies table), so a
// member is keyed by their profile id (user_id). The per-person NetSuite
// vendor id still rides on cni_profiles.
interface Member {
  user_id: string;
  full_name: string;
  status: string;
  netsuite_vendor_id: string | null;
}

interface UnassignedProfile {
  user_id: string;
  full_name: string;
}

// The exact invoice documents this installer has sent us, recorded on the
// Scan Log → Vendor Invoices tab (file stored in R2, metadata + per-VIN
// lines in vendor_invoices).
interface CompanyVendorInvoice {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  vendor_name: string;
  total_amount: number | null;
  location_name: string | null;
  file_name: string | null;
  storage_path: string | null;
  created_at: string;
  lines: { id: string }[];
}

// Profiles that carry an installer role can belong to a CNI company.
const INSTALLER_FILTER = 'role.eq.installer,roles.cs.{installer}';

export default function CniCompanyDetailPage() {
  const router = useRouter();
  const dialog = useDialog();
  const params = useParams();
  const companyId = params.id as string;
  const { isAdmin, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState<CniCompany | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedProfile[]>([]);
  const [metrics, setMetrics] = useState({ total: 0, active: 0, completed: 0, onTime: 0 });
  const [invoices, setInvoices] = useState<CompanyVendorInvoice[]>([]);

  // Editable fields
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  // Mailing address (companies.address JSONB: {street, city, state, zip})
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [addrState, setAddrState] = useState('');
  const [zip, setZip] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [showVendorSearch, setShowVendorSearch] = useState(false);
  const [pickedVendor, setPickedVendor] = useState<NsVendor | null>(null);
  const [primaryContact, setPrimaryContact] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ success: boolean; message: string } | null>(null);

  // Members
  const [addSelect, setAddSelect] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  // Compliance documents
  const [docBusy, setDocBusy] = useState<DocColumn | null>(null);
  const [docMsg, setDocMsg] = useState<{ success: boolean; message: string } | null>(null);
  const [confirmDocRemove, setConfirmDocRemove] = useState<DocColumn | null>(null);
  const [insuranceExpiry, setInsuranceExpiry] = useState('');
  // Per-person NetSuite vendor IDs are edited in one place — the Vendor IDs
  // page — so they're shown here read-only (no second editor that drifts).

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin) { router.push('/home'); return; }
    loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading, isAdmin, companyId]);

  const loadData = async () => {
    const { data: companyData } = await supabase
      .from('companies')
      .select('id, name, phone, email, address, netsuite_vendor_id, primary_contact_profile_id, w9_file_path, insurance_cert_path, insurance_expiry, direct_deposit_file_path')
      .eq('id', companyId)
      .single();

    if (companyData) {
      setCompany(companyData);
      setName(companyData.name || '');
      setPhone(companyData.phone || '');
      setEmail(companyData.email || '');
      const addr = (companyData as any).address || {};
      setStreet(addr.street || '');
      setCity(addr.city || '');
      setAddrState(addr.state || '');
      setZip(addr.zip || '');
      setVendorId(companyData.netsuite_vendor_id || '');
      setPrimaryContact(companyData.primary_contact_profile_id || '');
      setInsuranceExpiry(companyData.insurance_expiry || '');
    }

    // Members = installer profiles assigned to this company (profiles.company_id).
    const { data: memberProfiles } = await supabase
      .from('profiles')
      .select('id, full_name, status')
      .eq('company_id', companyId)
      .or(INSTALLER_FILTER)
      .order('full_name');

    // Their per-person NetSuite vendor ids — read through the admin API
    // (service role) so they aren't hidden by cni_profiles RLS for multi-role
    // admins (same reason the save goes through the API).
    const vendorMap: Record<string, string | null> = {};
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`/api/cni/installers?companyId=${companyId}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        (data.installers || []).forEach((i: any) => { vendorMap[i.user_id] = i.netsuite_vendor_id; });
      }
    } catch {
      // leave vendorMap empty on failure; inputs just show blank
    }
    setMembers((memberProfiles || []).map((p: any) => ({
      user_id: p.id,
      full_name: p.full_name || 'Unknown',
      status: p.status || 'unknown',
      netsuite_vendor_id: vendorMap[p.id] ?? null,
    })));

    // Installers with no company yet (candidates to add)
    const { data: freeProfiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .is('company_id', null)
      .or(INSTALLER_FILTER)
      .order('full_name');
    setUnassigned((freeProfiles || []).map((p: any) => ({
      user_id: p.id,
      full_name: p.full_name || 'Unknown',
    })));

    // Vendor invoices on file for this installer — linked by company, plus
    // records that only carried the name (recorded before linking).
    if (companyData) {
      const invoiceCols = 'id, invoice_number, invoice_date, vendor_name, total_amount, location_name, file_name, storage_path, created_at, lines:vendor_invoice_lines(id)';
      const escapedName = (companyData.name || '').replace(/[\\%_]/g, (ch: string) => `\\${ch}`);
      const [linked, byName] = await Promise.all([
        supabase.from('vendor_invoices')
          .select(invoiceCols)
          .eq('company_id', companyId)
          .order('created_at', { ascending: false })
          .limit(50),
        escapedName
          ? supabase.from('vendor_invoices')
              .select(invoiceCols)
              .is('company_id', null)
              .ilike('vendor_name', escapedName)
              .order('created_at', { ascending: false })
              .limit(50)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const seen = new Set<string>();
      const merged = ([...(linked.data || []), ...(byName.data || [])] as any[])
        .filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)))
        .sort((a, b) => (b.invoice_date || b.created_at.slice(0, 10)).localeCompare(a.invoice_date || a.created_at.slice(0, 10)));
      setInvoices(merged as CompanyVendorInvoice[]);
    }

    // Job metric rollups for this company
    const { data: companyJobs } = await supabase
      .from('cni_jobs')
      .select('status, completed_at, deadline')
      .eq('assigned_company_id', companyId);
    const jobs = companyJobs || [];
    setMetrics({
      total: jobs.length,
      active: jobs.filter((j: any) => j.status !== 'awaiting_assignment' && j.status !== 'approved_closed').length,
      completed: jobs.filter((j: any) => j.status === 'approved_closed').length,
      onTime: jobs.filter((j: any) =>
        j.status === 'approved_closed' && j.completed_at && j.deadline &&
        new Date(j.completed_at) <= new Date(j.deadline)
      ).length,
    });

    setLoading(false);
  };

  // Explicit re-sync: overwrite email/phone/address with the NetSuite
  // vendor's current values (the add-time import only fills blanks).
  const refreshFromNetsuite = async () => {
    if (refreshing) return;
    if (!(await dialog.confirm('Pull the current email, phone & mailing address from NetSuite? This overwrites those fields on this company.', { confirmLabel: 'Refresh' }))) return;
    setRefreshing(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/cni/refresh-vendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveMsg({ success: false, message: data.error || 'Refresh failed' });
      } else {
        const gotAddress = data.address && Object.values(data.address).some(Boolean);
        const addressNote = gotAddress
          ? ''
          : ` — no address found in NetSuite${data.addressLookup?.errors?.length ? ` (${data.addressLookup.errors.join('; ')})` : ''}`;
        setSaveMsg({ success: true, message: `Refreshed from NetSuite vendor ${data.vendorName || ''}${addressNote}`.trim() });
        await loadData();
      }
    } catch (e: any) {
      setSaveMsg({ success: false, message: e.message || 'Refresh failed' });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveMsg({ success: false, message: 'Company name is required' });
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    const { error } = await supabase
      .from('companies')
      .update({
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: { street: street.trim(), city: city.trim(), state: addrState.trim(), zip: zip.trim() },
        netsuite_vendor_id: vendorId.trim() || null,
        primary_contact_profile_id: primaryContact || null,
      })
      .eq('id', companyId);
    setSaving(false);
    if (error) {
      setSaveMsg({ success: false, message: 'Failed to save: ' + error.message });
    } else {
      setSaveMsg({ success: true, message: 'Company details saved' });
      loadData();
    }
  };

  // Membership is profiles.company_id — the same field set on /admin/users,
  // so changes here and there stay in sync.
  const handleAddMember = async (userId: string) => {
    if (!userId) return;
    setMemberBusy(true);
    const { error } = await supabase
      .from('profiles')
      .update({ company_id: companyId })
      .eq('id', userId);
    setMemberBusy(false);
    setAddSelect('');
    if (!error) loadData();
  };

  const handleRemoveMember = async (userId: string) => {
    setMemberBusy(true);
    const { error } = await supabase
      .from('profiles')
      .update({ company_id: null })
      .eq('id', userId);
    setMemberBusy(false);
    setConfirmRemove(null);
    if (!error) {
      // Clear primary contact if it pointed at the removed member
      if (company?.primary_contact_profile_id === userId) {
        await supabase
          .from('companies')
          .update({ primary_contact_profile_id: null })
          .eq('id', companyId);
        setPrimaryContact('');
      }
      loadData();
    }
  };

  const handleDocUpload = async (column: DocColumn, label: string, file: File) => {
    setDocBusy(column);
    setDocMsg(null);
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    const path = `${companyId}/${column}-${Date.now()}-${safeName}`;
    const { error: upErr } = await storage.from('cni-docs').upload(path, file, {
      contentType: file.type || 'application/octet-stream',
    });
    if (upErr) {
      setDocBusy(null);
      setDocMsg({ success: false, message: `Upload failed: ${upErr.message}` });
      return;
    }
    const oldPath = company?.[column] || null;
    const { error: saveErr } = await supabase
      .from('companies')
      .update({ [column]: path })
      .eq('id', companyId);
    setDocBusy(null);
    if (saveErr) {
      setDocMsg({ success: false, message: `Uploaded but failed to save: ${saveErr.message}` });
      return;
    }
    // Replaced file is no longer referenced — clean it up best-effort.
    if (oldPath) storage.from('cni-docs').remove([oldPath]);
    setDocMsg({ success: true, message: `${label} uploaded` });
    loadData();
  };

  const handleDocRemove = async (column: DocColumn, label: string) => {
    const oldPath = company?.[column];
    if (!oldPath) return;
    setDocBusy(column);
    setDocMsg(null);
    setConfirmDocRemove(null);
    const { error } = await supabase
      .from('companies')
      .update(column === 'insurance_cert_path' ? { [column]: null, insurance_expiry: null } : { [column]: null })
      .eq('id', companyId);
    setDocBusy(null);
    if (error) {
      setDocMsg({ success: false, message: `Failed to remove: ${error.message}` });
      return;
    }
    storage.from('cni-docs').remove([oldPath]);
    if (column === 'insurance_cert_path') setInsuranceExpiry('');
    setDocMsg({ success: true, message: `${label} removed` });
    loadData();
  };

  const handleInsuranceExpiry = async (value: string) => {
    setInsuranceExpiry(value);
    const { error } = await supabase
      .from('companies')
      .update({ insurance_expiry: value || null })
      .eq('id', companyId);
    if (error) setDocMsg({ success: false, message: `Failed to save expiry: ${error.message}` });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '14px',
    border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)',
  };
  const labelStyle: React.CSSProperties = {
    fontSize: '12px', fontWeight: 700, color: 'var(--text-label)', marginBottom: '4px', display: 'block',
  };

  if (loading) {
    return <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  if (!company) {
    return (
      <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
        Company not found.{' '}
        <button onClick={() => router.push('/admin/cni/companies')} style={{ color: 'var(--orange)', fontWeight: 700 }}>
          Back to companies
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
        <button onClick={() => router.push('/admin/cni/companies')} style={{ fontSize: '20px', color: 'var(--text-muted)' }}>←</button>
        <div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>
            {company.name}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {members.length} member{members.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Metrics card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Metrics
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px' }}>
          {([
            { label: 'Jobs', value: metrics.total, color: 'var(--text-primary)' },
            { label: 'Active', value: metrics.active, color: 'var(--orange)' },
            { label: 'Completed', value: metrics.completed, color: 'var(--success)' },
            { label: 'On-Time', value: metrics.onTime, color: 'var(--success)' },
          ]).map(stat => (
            <div key={stat.label} style={{
              padding: '10px 8px', borderRadius: '10px', textAlign: 'center',
              background: 'var(--subtle-bg)', border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '18px', fontWeight: 800, color: stat.color }}>{stat.value}</div>
              <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{stat.label}</div>
            </div>
          ))}
        </div>
        {metrics.completed > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            {metrics.onTime} of {metrics.completed} completed job{metrics.completed !== 1 ? 's' : ''} finished on or before the deadline.
          </div>
        )}
      </div>

      {/* Company details card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Company Details
        </div>

        {saveMsg && (
          <div style={{
            padding: '10px 14px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: 600,
            background: saveMsg.success ? 'var(--success-bg)' : 'var(--error-bg)',
            border: `1px solid ${saveMsg.success ? 'var(--success-border)' : 'var(--error-border)'}`,
            color: saveMsg.success ? 'var(--success)' : 'var(--error)',
          }}>
            {saveMsg.message}
          </div>
        )}

        <div style={{ marginBottom: '10px' }}>
          <label style={labelStyle}>Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
          <div>
            <label style={labelStyle}>Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 123-4567" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="office@company.com" style={inputStyle} />
          </div>
        </div>
        <div style={{ marginBottom: '10px' }}>
          <label style={labelStyle}>Mailing Address</label>
          <input value={street} onChange={e => setStreet(e.target.value)} placeholder="Street" style={{ ...inputStyle, marginBottom: '6px' }} />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px' }}>
            <input value={city} onChange={e => setCity(e.target.value)} placeholder="City" style={inputStyle} />
            <input value={addrState} onChange={e => setAddrState(e.target.value)} placeholder="State" style={inputStyle} />
            <input value={zip} onChange={e => setZip(e.target.value)} placeholder="ZIP" style={inputStyle} />
          </div>
        </div>
        <div style={{ marginBottom: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label style={labelStyle}>NetSuite Vendor ID</label>
            <span style={{ display: 'flex', gap: '12px' }}>
              {company?.netsuite_vendor_id && (
                <button
                  onClick={refreshFromNetsuite}
                  disabled={refreshing}
                  title="Re-pull email, phone & mailing address from the NetSuite vendor record (overwrites the fields here)"
                  style={{ fontSize: '11px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {refreshing ? 'Refreshing…' : '↻ Refresh from NetSuite'}
                </button>
              )}
              <button
                onClick={() => { setShowVendorSearch(s => !s); setPickedVendor(null); }}
                style={{ fontSize: '11px', fontWeight: 700, color: 'var(--orange)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                {showVendorSearch ? 'Close search' : '🔍 Search NetSuite'}
              </button>
            </span>
          </div>
          <input
            value={vendorId} onChange={e => { setVendorId(e.target.value); setPickedVendor(null); }}
            placeholder="Company-level vendor (lump-sum payouts)"
            style={inputStyle}
          />
          {pickedVendor && (
            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--success)', marginTop: '4px' }}>
              Selected: {pickedVendor.companyName || pickedVendor.entityId} (#{pickedVendor.id}) — hit Save Changes to link.
            </div>
          )}
          {showVendorSearch && (
            <div style={{ marginTop: '8px' }}>
              <NetsuiteVendorSearch
                onSelect={v => {
                  setVendorId(v.id);
                  setPickedVendor(v);
                  setShowVendorSearch(false);
                  // Prefill blank contact fields from the NetSuite record —
                  // never clobber values already on the company.
                  if (v.email && !email.trim()) setEmail(v.email);
                  if (v.phone && !phone.trim()) setPhone(v.phone);
                  if (v.address && !street.trim() && !city.trim()) {
                    setStreet(v.address.street);
                    setCity(v.address.city);
                    setAddrState(v.address.state);
                    setZip(v.address.zip);
                  }
                }}
                autoFocus
              />
            </div>
          )}
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={labelStyle}>Primary Contact</label>
          <select value={primaryContact} onChange={e => setPrimaryContact(e.target.value)} style={inputStyle}>
            <option value="">— None —</option>
            {members.map(m => (
              <option key={m.user_id} value={m.user_id}>{m.full_name}</option>
            ))}
          </select>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Notify-only — the primary contact has no special workflow powers.
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: saving ? 'var(--text-muted)' : 'var(--orange)', color: '#fff', border: 'none',
            cursor: saving ? 'default' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Compliance documents card — W9 / insurance / direct deposit on file */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Compliance Documents
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
          {COMPANY_DOCS.map(doc => {
            const path = company[doc.column];
            const busy = docBusy === doc.column;
            const isInsurance = doc.column === 'insurance_cert_path';
            const expired = isInsurance && insuranceExpiry && insuranceExpiry < new Date().toISOString().slice(0, 10);
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
                      {expired && (
                        <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'var(--error-bg)', color: 'var(--error)' }}>
                          EXPIRED
                        </span>
                      )}
                    </div>
                    {path && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {docFileName(path)}
                      </div>
                    )}
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
                    {path && (confirmDocRemove === doc.column ? (
                      <>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remove?</span>
                        <button
                          onClick={() => handleDocRemove(doc.column, doc.label)}
                          disabled={busy}
                          style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer' }}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmDocRemove(null)}
                          style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'var(--card)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer' }}
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => setConfirmDocRemove(doc.column)}
                        style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: 'var(--card)', color: 'var(--error)', border: '1px solid var(--error-border)', cursor: 'pointer' }}
                      >
                        Remove
                      </button>
                    ))}
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
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
          Direct deposit is kept as an uploaded document (authorization form or voided check) — bank details are never stored in FleetSuite. Per-person docs for CNI members live on their installer profile.
        </div>
      </div>

      {/* Members card */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Members
        </div>

        {members.length === 0 ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            No members yet — add installers below.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
            {members.map(m => (
              <div
                key={m.user_id}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', borderRadius: '10px',
                  background: 'var(--subtle-bg)', border: '1px solid var(--border)',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                      {m.full_name}
                    </span>
                    <span style={{
                      fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', textTransform: 'capitalize',
                      background: m.status === 'approved' ? 'var(--success-bg)' : 'var(--warning-bg)',
                      color: m.status === 'approved' ? 'var(--success)' : 'var(--warning)',
                    }}>
                      {m.status}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>NetSuite vendor:</span>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: m.netsuite_vendor_id ? 'var(--text-body)' : 'var(--text-muted)' }}>
                      {m.netsuite_vendor_id || 'not set'}
                    </span>
                  </div>
                </div>
                {confirmRemove === m.user_id ? (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>Remove?</span>
                    <button
                      onClick={() => handleRemoveMember(m.user_id)}
                      disabled={memberBusy}
                      style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'var(--error)', color: '#fff', border: 'none', cursor: 'pointer',
                      }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={() => setConfirmRemove(null)}
                      style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                        background: 'var(--card)', color: 'var(--text-muted)', border: '1px solid var(--border)', cursor: 'pointer',
                      }}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmRemove(m.user_id)}
                    style={{
                      padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                      background: 'var(--card)', color: 'var(--error)', border: '1px solid var(--error-border)', cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add member */}
        <label style={labelStyle}>Add Member</label>
        {unassigned.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            No unassigned installers available.
          </div>
        ) : (
          <select
            value={addSelect}
            disabled={memberBusy}
            onChange={e => { setAddSelect(e.target.value); handleAddMember(e.target.value); }}
            style={inputStyle}
          >
            <option value="">Select an installer to add…</option>
            {unassigned.map(p => (
              <option key={p.user_id} value={p.user_id}>{p.full_name}</option>
            ))}
          </select>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          Only installers without a company are listed. NetSuite vendor IDs are managed on the{' '}
          <button
            onClick={() => router.push('/admin/cni/vendor-ids')}
            style={{ color: 'var(--orange)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px' }}
          >
            Vendor IDs
          </button>{' '}
          page.
        </div>
      </div>

      {/* Vendor invoices on file — the exact documents this installer sent us */}
      <div style={{
        padding: '16px', borderRadius: '14px', marginBottom: '14px',
        background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
      }}>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '12px' }}>
          Vendor Invoices on File ({invoices.length})
        </div>
        {invoices.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            None recorded yet. Invoices uploaded on Scan Log → Vendor Invoices are kept here automatically.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {invoices.map(inv => (
              <div key={inv.id} style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '10px 12px', borderRadius: '10px',
                background: 'var(--subtle-bg)', border: '1px solid var(--border)',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {inv.invoice_number ? `Invoice #${inv.invoice_number}` : 'Invoice (no number)'}
                    {inv.total_amount != null && <span style={{ color: '#f472b6', marginLeft: '8px' }}>${Number(inv.total_amount).toFixed(2)}</span>}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {inv.invoice_date || inv.created_at.slice(0, 10)} · {inv.lines.length} VIN{inv.lines.length !== 1 ? 's' : ''}
                    {inv.location_name ? ` · ${inv.location_name}` : ''}
                    {inv.file_name ? ` · ${inv.file_name}` : ''}
                  </div>
                </div>
                {inv.storage_path ? (
                  <a
                    href={storage.from('invoices').getPublicUrl(inv.storage_path).data.publicUrl}
                    target="_blank" rel="noreferrer"
                    style={{ padding: '6px 10px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa', textDecoration: 'none', flexShrink: 0, whiteSpace: 'nowrap' }}
                  >
                    📄 View File
                  </a>
                ) : (
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>no file attached</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px' }}>
          Recorded from{' '}
          <button
            onClick={() => router.push('/admin/scans?tab=vendor')}
            style={{ color: 'var(--orange)', fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px' }}
          >
            Scan Log → Vendor Invoices
          </button>
          . The original uploaded document stays attached to each record.
        </div>
      </div>

      <div style={{ height: '80px' }} />
    </div>
  );
}
