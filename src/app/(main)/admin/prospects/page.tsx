'use client';

/**
 * The CRM index — a thin list over prospects & customers. Rows navigate to
 * the standalone Customer Record (/admin/prospects/<id>), which is the
 * primary surface for viewing AND editing a customer; nothing expands or
 * edits inline here anymore. What stays list-level: search/filters/sort,
 * the pipeline-stage filter the dashboard deep-links (?stage/?sort/?q),
 * prospect creation (+ business-card scan), XLSX export, the cross-company
 * contacts directory, and the NetSuite sync buttons.
 *
 * Legacy deep links (?id= / ?ns=) predate the record pages and are
 * forwarded there so old notification URLs and bookmarks keep working.
 */

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { DropZone } from '@/components/DropZone';
import { downloadXlsx } from '@/lib/xlsx-export';
import { fetchAllRows } from '@/lib/fetch-all';

interface Prospect {
  id: string;
  company_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  website: string | null;
  notes: string | null;
  source: string;
  status: string;
  location_count: number;
  lead_source: string | null;
  lead_source_other: string | null;
  multi_location: boolean;
  email_campaign: boolean;
  is_hot: boolean;
  netsuite_id: string | null;
  netsuite_url: string | null;
  converted_customer_id: string | null;
  created_by: string | null;
  created_at: string;
}

interface DirectoryContact {
  id: string;
  prospect_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_decision_maker: boolean;
  company_name?: string;
}

interface CustomerMetrics {
  total_spend: number;
  avg_order_value: number;
  ytd_spend: number;
  ytd_orders: number;
  last_year_spend: number;
  total_orders: number;
  last_order_date: string | null;
}

const OPP_STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STATUS_LABELS: Record<string, string> = { active: 'Prospects', nurturing: 'Nurturing', converted: 'Converted' };
const STATUS_COLORS: Record<string, string> = { active: '#4ade80', nurturing: '#60a5fa', converted: '#a78bfa' };

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: '12px',
  border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)',
};
const labelStyle: React.CSSProperties = {
  fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.5px', marginBottom: '3px',
};

export default function ProspectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, profile, isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [crmTab, setCrmTab] = useState<'prospects' | 'contacts'>('prospects');
  const [tagFilter, setTagFilter] = useState<string>('');

  // Sort + extended filters (Ashley's request: spend, recent activity,
  // owner, open quote, spend tier).
  type SortBy = 'company' | 'total_spend' | 'ytd_spend' | 'last_order';
  type SpendTier = 'all' | '10k' | '50k' | '100k';
  const [sortBy, setSortBy] = useState<SortBy>('company');
  const [ownerFilter, setOwnerFilter] = useState<string>('all'); // 'all' or user_id
  const [spendTierFilter, setSpendTierFilter] = useState<SpendTier>('all');
  const [openQuoteFilter, setOpenQuoteFilter] = useState<boolean>(false);
  const [openQuoteCustomers, setOpenQuoteCustomers] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  // Pipeline-stage filter, deep-linked from the dashboard's Sales band
  // (?stage=lead|quoted|negotiating|won|lost, or 'open' = any unclosed
  // stage). '' = off. Opportunity stages load lazily on first activation.
  const [stageFilter, setStageFilter] = useState<string>('');
  const [oppStagesByProspect, setOppStagesByProspect] = useState<Record<string, Set<string>> | null>(null);

  // Tags for the tag filter — loaded globally, so the dropdown sees every
  // tag (it used to only see tags of cards expanded this session).
  const [tagsByProspect, setTagsByProspect] = useState<Record<string, string[]>>({});

  // Contacts directory tab
  const [allContacts, setAllContacts] = useState<DirectoryContact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [syncingContacts, setSyncingContacts] = useState(false);

  // Create form (creation only — editing lives on the record page)
  const emptyForm = { company_name: '', contact_name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1 };
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Customer spend metrics (customers table), keyed by prospect id
  const [customerMetrics, setCustomerMetrics] = useState<Record<string, CustomerMetrics>>({});

  // Profiles for the owner filter + export
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Card scan
  const [scanning, setScanning] = useState(false);
  const cardInputRef = useRef<HTMLInputElement>(null);

  const crmLoadStarted = useRef(false);
  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    // Cold-boot deep links: wait for the profile row before judging roles,
    // or a legitimate user gets bounced to /home while roles are in flight.
    if (user && !profile) return;
    if (!hasFeature('prospects') && !isAdmin) { router.push('/home'); return; }
    if (crmLoadStarted.current) return;
    crmLoadStarted.current = true;
    loadProspects();
    loadProfiles();
    loadOpenQuoteCustomers();
    loadTags();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when auth + profile resolve
  }, [authLoading, user, profile]);

  // Legacy deep links (?id=<prospect uuid>, ?ns=<NetSuite id>) used to
  // expand a card in this list — forward them to the record page instead.
  useEffect(() => {
    if (loading) return;
    const prospectId = searchParams.get('id');
    const nsId = searchParams.get('ns');
    if (prospectId) { router.replace(`/admin/prospects/${prospectId}`); return; }
    if (nsId) {
      const match = prospects.find(p => p.netsuite_id === nsId);
      router.replace(`/admin/prospects/${match ? match.id : `ns-${nsId}`}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: forward once after load
  }, [loading, searchParams]);

  // Dashboard Sales-band deep links: ?stage= filters to prospects with an
  // opportunity in that pipeline stage, ?sort= pre-sorts the list (e.g.
  // ytd_spend for Top customers), ?q= prefills search — the fallback for
  // customer links that only know a company name.
  useEffect(() => {
    if (loading) return;
    const sort = searchParams.get('sort');
    if (sort && ['company', 'total_spend', 'ytd_spend', 'last_order'].includes(sort)) setSortBy(sort as SortBy);
    const stage = searchParams.get('stage');
    if (stage && (stage === 'open' || stage in OPP_STAGES)) setStageFilter(stage);
    const q = searchParams.get('q');
    if (q && !searchParams.get('id') && !searchParams.get('ns')) setSearch(q);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: apply once after load
  }, [loading, searchParams]);

  // Opportunity stages for the pipeline filter — one paginated read of
  // prospect_opportunities, loaded the first time the filter activates.
  useEffect(() => {
    if (!stageFilter || oppStagesByProspect) return;
    (async () => {
      const { data: rows, error } = await fetchAllRows<{ prospect_id: string; stage: string }>((from, to) =>
        supabase.from('prospect_opportunities').select('prospect_id, stage').order('id').range(from, to));
      if (error) {
        // Filtering against a partial read would hide real deals — drop the filter.
        setStageFilter('');
        return;
      }
      const map: Record<string, Set<string>> = {};
      for (const r of rows) (map[r.prospect_id] = map[r.prospect_id] || new Set()).add(r.stage);
      setOppStagesByProspect(map);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when the filter first activates
  }, [stageFilter, oppStagesByProspect]);

  // Spend metrics for converted customers, one paginated bulk read.
  useEffect(() => {
    if (prospects.length === 0) return;
    const converted = prospects.filter(p => p.netsuite_id);
    if (converted.length === 0) return;
    (async () => {
      const { data: rows } = await fetchAllRows<CustomerMetrics & { netsuite_id: string | null }>((from, to) =>
        supabase.from('customers')
          .select('netsuite_id, total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date')
          .order('netsuite_id').range(from, to));
      const nsMap: Record<string, CustomerMetrics> = {};
      for (const c of rows || []) { if (c.netsuite_id) nsMap[c.netsuite_id] = c; }
      const metricsMap: Record<string, CustomerMetrics> = {};
      converted.forEach(p => { if (nsMap[p.netsuite_id!]) metricsMap[p.id] = nsMap[p.netsuite_id!]; });
      setCustomerMetrics(metricsMap);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once per prospects load
  }, [prospects]);

  const loadProspects = async () => {
    const { data: rows, error } = await fetchAllRows<Prospect>((from, to) =>
      supabase.from('prospects').select('*').order('company_name').order('id').range(from, to));
    if (error) console.error('[prospects] load failed:', error);
    setProspects(rows || []);
    setLoading(false);
  };

  const loadProfiles = async () => {
    const { data: rows } = await fetchAllRows<{ id: string; full_name: string }>((from, to) =>
      supabase.from('profiles').select('id, full_name').order('id').range(from, to));
    const map: Record<string, string> = {};
    for (const p of rows || []) map[p.id] = p.full_name;
    setProfiles(map);
  };

  // Preload customer names with at least one open quote so the
  // "open quote" filter doesn't need to round-trip per prospect.
  const loadOpenQuoteCustomers = async () => {
    const { data: rows } = await fetchAllRows<{ customer: { name?: string } | null }>((from, to) =>
      supabase.from('wrap_quotes').select('customer').in('status', ['draft', 'sent']).order('id').range(from, to));
    const names = new Set<string>();
    for (const row of rows || []) {
      const name = row.customer?.name;
      if (name) names.add(String(name).toLowerCase());
    }
    setOpenQuoteCustomers(names);
  };

  const loadTags = async () => {
    const { data: rows } = await fetchAllRows<{ prospect_id: string; tag: string }>((from, to) =>
      supabase.from('prospect_tags').select('prospect_id, tag').order('id').range(from, to));
    const map: Record<string, string[]> = {};
    for (const t of rows || []) (map[t.prospect_id] = map[t.prospect_id] || []).push(t.tag);
    setTagsByProspect(map);
  };

  const loadAllContacts = async () => {
    if (contactsLoaded) return;
    const { data: rows, error } = await fetchAllRows<any>((from, to) =>
      supabase.from('prospect_contacts').select('*, prospects(company_name)').order('name').order('id').range(from, to));
    if (error) console.error('Contact load error:', error);
    setAllContacts((rows || []).map((c: any) => ({ ...c, company_name: c.prospects?.company_name })));
    setContactsLoaded(true);
  };

  // Create a prospect, then land on its record page — the record is where
  // everything else (contacts, deals, activity) gets added.
  const createProspect = async () => {
    if (!form.company_name.trim() || saving) return;
    setSaving(true);
    const { data, error } = await supabase.from('prospects')
      .insert({ ...form, company_name: form.company_name.trim(), location_count: form.location_count || 1, created_by: user?.id })
      .select().single();
    if (error || !data) {
      setSaving(false);
      await dialog.alert(`Could not create the prospect: ${error?.message || 'unknown error'}`);
      return;
    }
    if (form.location_count > 1) {
      await supabase.from('prospect_tags').insert({ prospect_id: data.id, tag: 'multilocation', auto_generated: true });
    }
    router.push(`/admin/prospects/${data.id}`);
  };

  // Scan business card → OCR prefills the create form
  const handleScanCard = async (file: File) => {
    setScanning(true);
    const canvas = document.createElement('canvas');
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.src = url;
    await new Promise(r => { img.onload = r; });
    const maxDim = 1536;
    const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

    try {
      const res = await fetch('/api/prospects/scan-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });
      const data = await res.json();
      if (data.company_name || data.contact_name) {
        setForm(prev => ({
          ...prev,
          company_name: data.company_name || prev.company_name,
          contact_name: data.contact_name || prev.contact_name,
          email: data.email || prev.email,
          phone: data.phone || prev.phone,
          address: data.address || prev.address,
          city: data.city || prev.city,
          state: data.state || prev.state,
          zip: data.zip || prev.zip,
          website: data.website || prev.website,
        }));
        setShowCreate(true);
      }
    } catch (e) {
      console.error('Card scan failed:', e);
    }
    setScanning(false);
  };

  const fmtK = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toFixed(0);

  // All unique tags for the filter dropdown
  const allTags = [...new Set(Object.values(tagsByProspect).flat())].sort();

  // Distinct prospect owners (created_by) for the owner filter dropdown.
  const ownerOptions = (() => {
    const ids = new Set<string>();
    for (const p of prospects) if (p.created_by) ids.add(p.created_by);
    return Array.from(ids).map(id => ({ id, name: profiles[id] || id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  })();

  // Filter
  const filtered = prospects.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (stageFilter && oppStagesByProspect) {
      const want = stageFilter === 'open' ? ['lead', 'quoted', 'negotiating'] : [stageFilter];
      const stages = oppStagesByProspect[p.id];
      if (!stages || !want.some(w => stages.has(w))) return false;
    }
    if (tagFilter && !(tagsByProspect[p.id] || []).includes(tagFilter)) return false;
    if (ownerFilter !== 'all' && p.created_by !== ownerFilter) return false;
    if (openQuoteFilter && !openQuoteCustomers.has((p.company_name || '').toLowerCase())) return false;
    if (spendTierFilter !== 'all') {
      const ytd = customerMetrics[p.id]?.ytd_spend || 0;
      const threshold = spendTierFilter === '10k' ? 10000 : spendTierFilter === '50k' ? 50000 : 100000;
      if (ytd < threshold) return false;
    }
    if (search) {
      const s = search.toLowerCase();
      return p.company_name.toLowerCase().includes(s) || (p.contact_name || '').toLowerCase().includes(s) || (p.email || '').toLowerCase().includes(s) || (p.notes || '').toLowerCase().includes(s);
    }
    return true;
  });

  // Sort. Numeric sorts put 0/missing at the bottom by descending revenue;
  // company name is the default A-Z behavior.
  const sorted = [...filtered].sort((a, b) => {
    const ma = customerMetrics[a.id];
    const mb = customerMetrics[b.id];
    switch (sortBy) {
      case 'total_spend':
        return (mb?.total_spend || 0) - (ma?.total_spend || 0);
      case 'ytd_spend':
        return (mb?.ytd_spend || 0) - (ma?.ytd_spend || 0);
      case 'last_order': {
        const ad = ma?.last_order_date ? new Date(ma.last_order_date).getTime() : 0;
        const bd = mb?.last_order_date ? new Date(mb.last_order_date).getTime() : 0;
        return bd - ad;
      }
      case 'company':
      default:
        return a.company_name.localeCompare(b.company_name);
    }
  });

  const exportToExcel = async () => {
    setExporting(true);
    try {
      const rows = sorted.map(p => {
        const m = customerMetrics[p.id];
        return {
          Company: p.company_name,
          Status: STATUS_LABELS[p.status] || p.status || '',
          Owner: profiles[p.created_by || ''] || '',
          'Contact Name': p.contact_name || '',
          Email: p.email || '',
          Phone: p.phone || '',
          Address: p.address || '',
          City: p.city || '',
          State: p.state || '',
          Zip: p.zip || '',
          'Total Orders': m?.total_orders ?? '',
          'Total Spend': m?.total_spend ?? '',
          'YTD Orders': m?.ytd_orders ?? '',
          'YTD Spend': m?.ytd_spend ?? '',
          'Last Year Spend': m?.last_year_spend ?? '',
          'Last Order Date': m?.last_order_date || '',
          'NetSuite ID': p.netsuite_id || '',
          'Has Open Quote': openQuoteCustomers.has((p.company_name || '').toLowerCase()) ? 'Y' : '',
        };
      });
      const today = new Date().toISOString().split('T')[0];
      await downloadXlsx(rows, { sheetName: 'CRM', filename: `crm-export-${today}.xlsx` });
    } catch (err: any) {
      console.error('[crm export] failed:', err);
      await dialog.alert(`Export failed: ${err?.message || err}`);
    }
    setExporting(false);
  };

  if (loading) return <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading...</div>;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>CRM</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{prospects.length} total · {prospects.filter(p => p.status === 'active').length} active · {prospects.filter(p => p.status === 'converted').length} customers</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button onClick={async () => {
            setSyncing(true);
            try {
              const res = await fetch('/api/netsuite/customers');
              const data = await res.json();
              await dialog.alert(`Customers: ${data.synced || 0}\nCRM: ${data.prospectsSynced || 0}\nContacts: ${data.contactsSynced || 0} synced, ${data.contactsSkipped || 0} skipped, ${data.contactErrors || 0} errors${data.restApiError ? '\nREST API error (HTTP ' + data.restApiError.status + '): ' + data.restApiError.body : ''}${data.firstContactError ? '\nContact error: ' + data.firstContactError : ''}${data.firstProspectError ? '\nCRM error: ' + data.firstProspectError : ''}`);
              loadProspects();
            } catch { await dialog.alert('Sync failed'); }
            setSyncing(false);
          }} disabled={syncing} style={{
            padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', cursor: 'pointer',
            opacity: syncing ? 0.5 : 1,
          }}>{syncing ? 'Syncing...' : 'Sync NetSuite'}</button>
          <DropZone accept="image/*" multiple={false} disabled={scanning} onFiles={files => handleScanCard(files[0])}>
          <input ref={cardInputRef} type="file" accept="image/*" capture="environment" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleScanCard(f); e.target.value = ''; }} style={{ display: 'none' }} />
          <button onClick={() => cardInputRef.current?.click()} disabled={scanning} style={{
            padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)', color: '#a78bfa', cursor: 'pointer',
          }}>{scanning ? 'Scanning...' : 'Scan Card'}</button>
          </DropZone>
          <button onClick={() => { if (showCreate) { setShowCreate(false); setForm(emptyForm); } else { setShowCreate(true); } }} style={{
            padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'var(--tab-active-bg)', border: '1px solid var(--tab-active-border)', color: 'var(--tab-active-color)', cursor: 'pointer',
          }}>{showCreate ? 'Cancel' : '+ New'}</button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Company Name *</div><input style={inputStyle} value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} /></div>
            <div><div style={labelStyle}>Contact Name</div><input style={inputStyle} value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} /></div>
            <div><div style={labelStyle}>Email</div><input type="email" style={inputStyle} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
            <div><div style={labelStyle}>Phone</div><input style={inputStyle} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></div>
            <div><div style={labelStyle}>Website</div><input style={inputStyle} value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Address</div><input style={inputStyle} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
            <div><div style={labelStyle}>City</div><input style={inputStyle} value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <div><div style={labelStyle}>State</div><input style={inputStyle} value={form.state} onChange={e => setForm({ ...form, state: e.target.value })} /></div>
              <div><div style={labelStyle}>Zip</div><input style={inputStyle} value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value })} /></div>
            </div>
            <div><div style={labelStyle}># of Locations</div><input type="number" min="1" style={inputStyle} value={form.location_count} onChange={e => setForm({ ...form, location_count: parseInt(e.target.value) || 1 })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Notes</div><textarea style={{ ...inputStyle, minHeight: '50px', resize: 'vertical' }} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <button onClick={createProspect} disabled={saving || !form.company_name.trim()} style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: form.company_name.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none', cursor: 'pointer',
            opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Creating...' : 'Create Prospect'}</button>
        </div>
      )}

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '12px', borderBottom: '2px solid var(--border)' }}>
        {(['prospects', 'contacts'] as const).map(tab => (
          <button key={tab} onClick={() => { setCrmTab(tab); if (tab === 'contacts') loadAllContacts(); }} style={{
            padding: '8px 16px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: 'none', border: 'none', borderBottom: crmTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
            color: crmTab === tab ? '#3b82f6' : 'var(--text-muted)', marginBottom: '-2px',
          }}>{tab === 'prospects' ? `Prospects (${prospects.length})` : `Contacts${contactsLoaded ? ` (${allContacts.length})` : ''}`}</button>
        ))}
      </div>

      {crmTab === 'contacts' ? (
        <>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
            <input
              value={contactSearch} onChange={e => setContactSearch(e.target.value)}
              placeholder="Search contacts..."
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={async () => {
              setSyncingContacts(true);
              try {
                const res = await fetch('/api/netsuite/contacts/sync', { method: 'POST' });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  await dialog.alert(`Sync failed (HTTP ${res.status}): ${data.error || 'Unknown'}`);
                } else {
                  await dialog.alert(`Contacts synced: ${data.contactsSynced || 0}\nPhones: ${data.phonesFound || 0}\nProcessed: ${data.customersProcessed || 0} this run\nPreviously done: ${data.alreadyDone || 0}\nRemaining: ${data.remaining || 0} of ${data.totalCustomers || '?'}${data.timedOut ? '\n\nTap Sync again to continue' : ''}`);
                  setContactsLoaded(false);
                  loadAllContacts();
                }
              } catch (err: any) { await dialog.alert('Sync failed: ' + (err.message || 'Network error')); }
              setSyncingContacts(false);
            }} disabled={syncingContacts} style={{
              padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#22c55e', cursor: 'pointer',
              opacity: syncingContacts ? 0.5 : 1, whiteSpace: 'nowrap',
            }}>{syncingContacts ? 'Syncing...' : 'Sync Contacts'}</button>
          </div>
          {!contactsLoaded ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>Loading contacts...</div>
          ) : (() => {
            const q = contactSearch.toLowerCase();
            const matches = q ? allContacts.filter(c => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.phone?.toLowerCase().includes(q) || c.company_name?.toLowerCase().includes(q) || c.title?.toLowerCase().includes(q)) : allContacts;
            return matches.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>No contacts found</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {matches.map(c => (
                  <div key={c.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)' }}>{c.name}</div>
                        <button onClick={() => router.push(`/admin/prospects/${c.prospect_id}`)} title="Open the customer record"
                          style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
                          {c.company_name || 'Unknown company'}
                        </button>
                      </div>
                      {c.title && !['Customer Center', 'Customer'].includes(c.title) && (
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textAlign: 'right', flexShrink: 0, maxWidth: '40%' }}>{c.title}</span>
                      )}
                    </div>
                    {(c.phone || c.email) && (
                      <div style={{ display: 'flex', gap: '16px', marginTop: '4px', fontSize: '12px' }}>
                        {c.phone && <a href={`tel:${c.phone}`} style={{ color: '#22c55e', textDecoration: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}>{c.phone}</a>}
                        {c.email && <a href={`mailto:${c.email}`} style={{ color: '#60a5fa', textDecoration: 'none' }}>{c.email}</a>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
        </>
      ) : (
      <>
      {/* Search & Filters */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search prospects & customers..."
        style={{ ...inputStyle, marginBottom: '8px' }}
      />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px', flexWrap: 'wrap' }}>
        {['all', 'active', 'nurturing', 'converted'].map(s => (
          <button key={s} onClick={() => setStatusFilter(s)} style={{
            padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: statusFilter === s ? 'var(--tab-active-bg)' : 'transparent',
            border: statusFilter === s ? '1px solid var(--tab-active-border)' : '1px solid var(--border)',
            color: statusFilter === s ? 'var(--tab-active-color)' : 'var(--text-muted)', cursor: 'pointer',
          }}>{s === 'all' ? 'All' : STATUS_LABELS[s]}</button>
        ))}
        {allTags.length > 0 && (
          <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{ padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            <option value="">All Tags</option>
            {allTags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {stageFilter && (
          <button onClick={() => setStageFilter('')} title="Clear the pipeline-stage filter" style={{
            padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.4)', color: '#60a5fa', cursor: 'pointer',
          }}>
            Pipeline: {stageFilter === 'open' ? 'Open deals' : OPP_STAGES[stageFilter] || stageFilter}{!oppStagesByProspect ? ' …' : ''} ✕
          </button>
        )}
      </div>

      {/* Extended filters + sort */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Sort:</span>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as SortBy)} style={{ padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          <option value="company">Company (A-Z)</option>
          <option value="total_spend">Total Spend ↓</option>
          <option value="ytd_spend">YTD Spend ↓</option>
          <option value="last_order">Last Order ↓</option>
        </select>
        <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginLeft: '4px' }}>Owner:</span>
        <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} style={{ padding: '5px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
          <option value="all">All Owners</option>
          {ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <span style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginLeft: '4px' }}>YTD spend:</span>
        {([
          { key: 'all', label: 'Any' },
          { key: '10k', label: '≥ $10k' },
          { key: '50k', label: '≥ $50k' },
          { key: '100k', label: '≥ $100k' },
        ] as { key: SpendTier; label: string }[]).map(t => (
          <button key={t.key} onClick={() => setSpendTierFilter(t.key)} style={{
            padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
            background: spendTierFilter === t.key ? 'rgba(34,197,94,0.12)' : 'var(--subtle-bg)',
            border: `1px solid ${spendTierFilter === t.key ? 'rgba(34,197,94,0.4)' : 'var(--border)'}`,
            color: spendTierFilter === t.key ? '#22c55e' : 'var(--text-muted)',
          }}>{t.label}</button>
        ))}
        <button onClick={() => setOpenQuoteFilter(v => !v)} style={{
          padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', marginLeft: '4px',
          background: openQuoteFilter ? 'rgba(251,191,36,0.12)' : 'var(--subtle-bg)',
          border: `1px solid ${openQuoteFilter ? 'rgba(251,191,36,0.4)' : 'var(--border)'}`,
          color: openQuoteFilter ? '#f59e0b' : 'var(--text-muted)',
        }}>{openQuoteFilter ? '✓ Open Quote' : 'Open Quote'}</button>
      </div>

      {/* Result count + export */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {sorted.length} of {prospects.length} {prospects.length === 1 ? 'record' : 'records'}
        </div>
        <button
          onClick={exportToExcel}
          disabled={exporting || sorted.length === 0}
          style={{
            padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
            background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa',
            opacity: exporting || sorted.length === 0 ? 0.5 : 1,
          }}
        >{exporting ? 'Exporting…' : 'Export to Excel'}</button>
      </div>

      {/* Prospect list — every row opens the customer record */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{search ? 'No matching prospects' : 'No prospects match the current filters'}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sorted.map(prospect => {
            const statusColor = STATUS_COLORS[prospect.status] || '#6b7280';
            return (
              <div key={prospect.id} id={`prospect-${prospect.id}`}
                onClick={() => router.push(`/admin/prospects/${prospect.id}`)}
                style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '12px 14px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: '14px', color: 'var(--text-primary)' }}>{prospect.company_name}</span>
                      <span style={{ fontSize: '9px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: `${statusColor}18`, color: statusColor }}>{STATUS_LABELS[prospect.status]}</span>
                      {prospect.is_hot && <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>HOT</span>}
                      {prospect.email_campaign && <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: 'rgba(59,130,246,0.1)', color: '#60a5fa' }}>EMAIL</span>}
                      {prospect.multi_location && <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: 'rgba(251,191,36,0.1)', color: '#f59e0b' }}>MULTI-LOC</span>}
                      {prospect.netsuite_id && <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}>NS</span>}
                    </div>
                    {prospect.contact_name && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{prospect.contact_name}{prospect.email ? ` · ${prospect.email}` : ''}</div>}
                    {prospect.notes && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{prospect.notes}</div>}
                  </div>
                  <div style={{ flexShrink: 0, textAlign: 'right' }}>
                    {customerMetrics[prospect.id]?.ytd_spend ? (
                      <div style={{ fontSize: '13px', fontWeight: 800, color: '#4ade80' }}>{fmtK(customerMetrics[prospect.id].ytd_spend)}</div>
                    ) : null}
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(prospect.created_at).toLocaleDateString()}</div>
                    <div style={{ marginTop: '2px', color: 'var(--text-muted)', fontWeight: 700 }}>›</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </>
      )}
    </div>
  );
}
