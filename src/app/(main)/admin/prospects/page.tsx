'use client';

/**
 * The CRM index — a thin list over customers. Rows navigate to the
 * standalone Customer Record (/admin/prospects/<id>), which is the
 * primary surface for viewing AND editing a customer; nothing expands or
 * edits inline here anymore. What stays list-level: search/filters/sort,
 * the pipeline-stage filter the dashboard deep-links (?stage/?sort/?q),
 * customer creation (+ business-card scan), XLSX export, the cross-company
 * contacts directory, and the NetSuite sync buttons.
 *
 * Prospects and customers are unified: creating a record (typed or scanned
 * off a business card) immediately creates it in NetSuite as a customer —
 * there is no separate "prospect" stage or convert step. The one exception
 * is vendor records (record_type 'vendor'): supplier/partner reps captured
 * for their contact info live under the Vendors tab and are never pushed to
 * NetSuite as customers. The legacy
 * prospects.status column persists in the DB but is no longer surfaced;
 * the distinction that matters is the lead tier (owner decision
 * 2026-08-30): a record with no netsuite_id is a LEAD — creating it no
 * longer creates a NetSuite customer. It's promoted from its record page,
 * or automatically when its first estimate is pushed to NetSuite.
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
import PhoneInput from '@/components/PhoneInput';
import { downloadXlsx } from '@/lib/xlsx-export';
import { deepLinks } from '@/lib/deep-links';
import { fetchAllRows } from '@/lib/fetch-all';
import { SortableTh, useTableSort, type SortState } from '@/components/ui/SortableTh';
import NumberInput from '@/components/NumberInput';
import { LEAD_SOURCES, OPP_TYPES } from '@/lib/lead-sources';
import FilterButton, { FilterLabel } from '@/components/ui/FilterButton';

interface Prospect {
  id: string;
  company_name: string;
  record_type: string;
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
  const [crmTab, setCrmTab] = useState<'prospects' | 'vendors' | 'contacts'>('prospects');
  const [tagFilter, setTagFilter] = useState<string>('');

  // Extended filters (Ashley's request: spend, recent activity, owner, open
  // quote, spend tier) — they live in the Filter popover; sorting is the
  // table headers' job.
  type SpendTier = 'all' | '10k' | '50k' | '100k';
  const [ownerFilter, setOwnerFilter] = useState<string>('all'); // 'all' or user_id
  const [spendTierFilter, setSpendTierFilter] = useState<SpendTier>('all');
  const [openQuoteFilter, setOpenQuoteFilter] = useState<boolean>(false);
  const [emailCampaignFilter, setEmailCampaignFilter] = useState<boolean>(false);
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

  // Industry/partner tags (K2 — customer_tags behind the controlled
  // vocabulary, keyed on customers.id and joined back to prospects via
  // netsuite_id in the metrics loader).
  const [industryFilter, setIndustryFilter] = useState<string>('');
  const [custTagsByProspect, setCustTagsByProspect] = useState<Record<string, string[]>>({});

  // Contacts directory tab
  const [allContacts, setAllContacts] = useState<DirectoryContact[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [syncingContacts, setSyncingContacts] = useState(false);

  // Create form (creation only — editing lives on the record page).
  // record_type 'vendor' = supplier/partner rep: same record, no NetSuite push.
  const emptyForm = { company_name: '', contact_name: '', title: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1, record_type: 'customer', lead_source: '' };
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  // "What do they want" — one deal per checked type at create time, so a
  // combined upfit+graphics inquiry is two deals, not a free-text note that
  // gets re-typed into the estimate later. UI-only state: `form` spreads
  // straight into the prospects insert, so this must not live there.
  const [interestedIn, setInterestedIn] = useState<string[]>([]);
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
      const { data: rows } = await fetchAllRows<CustomerMetrics & { id: string; netsuite_id: string | null }>((from, to) =>
        supabase.from('customers')
          .select('id, netsuite_id, total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date')
          .order('netsuite_id').range(from, to));
      const nsMap: Record<string, CustomerMetrics> = {};
      const idToNs: Record<string, string> = {};
      for (const c of rows || []) {
        if (c.netsuite_id) { nsMap[c.netsuite_id] = c; idToNs[c.id] = c.netsuite_id; }
      }
      const metricsMap: Record<string, CustomerMetrics> = {};
      const prospectByNs: Record<string, string> = {};
      converted.forEach(p => {
        if (nsMap[p.netsuite_id!]) metricsMap[p.id] = nsMap[p.netsuite_id!];
        prospectByNs[p.netsuite_id!] = p.id;
      });
      setCustomerMetrics(metricsMap);

      // Industry/partner tags ride the same read: customers.id → netsuite_id
      // → prospect id, labels from the vocabulary join.
      const { data: tagRows } = await fetchAllRows<{ customer_id: string; customer_tag_vocabulary: { label: string } | null }>((from, to) =>
        supabase.from('customer_tags')
          .select('customer_id, customer_tag_vocabulary(label)')
          .order('customer_id').order('tag_id').range(from, to));
      const map: Record<string, string[]> = {};
      for (const t of (tagRows || []) as any[]) {
        const ns = idToNs[t.customer_id];
        const pid = ns ? prospectByNs[ns] : null;
        const label = t.customer_tag_vocabulary?.label;
        if (pid && label) (map[pid] = map[pid] || []).push(label);
      }
      setCustTagsByProspect(map);
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

  // Create a customer, then land on its record page — the record is where
  // everything else (contacts, deals, activity) gets added. Creation is one
  // step: the record is pushed to NetSuite as a customer immediately (no
  // separate prospect stage / convert step). If the NetSuite create fails,
  // the local record still exists and the record page offers a retry.
  // Vendor records skip the NetSuite push entirely — they're FleetSuite-only.
  // `startEstimate` (Valarie's new-client-to-quote flow) lands in the
  // estimate builder with the new customer pre-selected instead — falling
  // back to the record page when the NetSuite create failed (an estimate
  // can't link a customer that doesn't exist yet).
  const createCustomer = async (startEstimate = false) => {
    if (!form.company_name.trim() || saving) return;
    setSaving(true);
    const isVendor = form.record_type === 'vendor';
    const name = form.company_name.trim();

    // Duplicate guard, now the shared SERVER-side check (audit Stage 1):
    // the old guard matched exact name against the in-memory list plus one
    // ilike on customers — phone and email were never checked, and records
    // loaded after page mount were invisible. The server sees everything:
    // name + email + phone digits across the CRM and the NetSuite mirror.
    // Best-effort here (the create routes run the same checker again), so
    // a pre-flight hiccup can't block creation outright.
    let dupes: { source: string; id: string; company_name: string | null; netsuite_id: string | null; matchedOn: string[] }[] = [];
    try {
      const res = await fetch('/api/prospects/check-duplicate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: name, email: form.email || null, phone: form.phone || null, recordType: form.record_type }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) dupes = body.matches || [];
    } catch { /* pre-flight only */ }

    const dupeUrl = (m: typeof dupes[number]) =>
      m.source === 'prospects' ? `/admin/prospects/${m.id}` : m.netsuite_id ? `/admin/prospects/ns-${m.netsuite_id}` : null;
    const nameMatch = dupes.find(m => m.matchedOn.includes('name')) || null;
    if (nameMatch) {
      // Same-name: block, as before — a re-create splits spend history,
      // statements, and estimate search.
      setSaving(false);
      const url = dupeUrl(nameMatch);
      const open = await dialog.confirm(
        `"${nameMatch.company_name || name}" already exists${nameMatch.source === 'customers' ? ' in NetSuite' : ''}.${isVendor ? '' : ' Creating it again would make a duplicate NetSuite customer that splits spend history and statements.'}\n\nOpen the existing record instead? If this really is a different company, go back and adjust the name (e.g. add the city).`,
        { confirmLabel: 'Open Existing', cancelLabel: 'Go Back' },
      );
      if (open && url) router.push(url);
      return;
    }
    if (dupes.length > 0) {
      // Same phone/email under a different name — a softer signal (shared
      // AP lines, franchises). Surface it, let the human decide.
      const top = dupes[0];
      const what = top.matchedOn.map(f => f === 'email' ? 'email' : 'phone number').join(' and ');
      const anyway = await dialog.confirm(
        `"${top.company_name || 'An existing record'}" already has this ${what}. If it's the same company, open it from the list instead of creating a duplicate.\n\nCreate "${name}" anyway?`,
        { confirmLabel: 'Create Anyway', cancelLabel: 'Go Back' },
      );
      if (!anyway) { setSaving(false); return; }
    }

    const { data, error } = await supabase.from('prospects')
      .insert({ ...form, company_name: name, lead_source: form.lead_source || null, location_count: form.location_count || 1, created_by: user?.id })
      .select().single();
    if (error || !data) {
      setSaving(false);
      await dialog.alert(`Could not create the ${isVendor ? 'vendor' : 'customer'}: ${error?.message || 'unknown error'}`);
      return;
    }
    if (form.location_count > 1) {
      await supabase.from('prospect_tags').insert({ prospect_id: data.id, tag: 'multilocation', auto_generated: true });
    }
    // One deal per checked interest — the pipeline starts at intake instead
    // of being reconstructed later from the notes. Best-effort: the record
    // exists and deals can be added on its page.
    if (!isVendor && interestedIn.length > 0) {
      await supabase.from('prospect_opportunities').insert(
        interestedIn.map(t => ({
          prospect_id: data.id,
          title: `${OPP_TYPES[t] || t} — ${name}`,
          type: t,
          stage: 'lead',
          created_by: user?.id,
        })),
      );
    }
    // Lead tier (owner decision 2026-08-30): creating a record no longer
    // creates a NetSuite customer. The record IS the lead (netsuite_id
    // null); it's promoted from its record page, or automatically the first
    // time an estimate for it is pushed to NetSuite / converted to an SO.
    // The contact person (typed or scanned off a card) becomes a real
    // contact row on the record — and a NetSuite contact when linked — not
    // just the header contact field. Best-effort: the record is already
    // created, and contacts can be added on the record page.
    if (form.contact_name.trim()) {
      await fetch('/api/prospects/contacts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prospectId: data.id, name: form.contact_name.trim(),
          title: form.title || undefined, email: form.email || undefined, phone: form.phone || undefined,
        }),
      }).catch(() => {});
    }
    if (startEstimate && !isVendor) {
      router.push(deepLinks.newEstimate(null, data.id));
      return;
    }
    router.push(`/admin/prospects/${data.id}`);
  };

  // Scan business card → OCR prefills the create form
  const handleScanCard = async (file: File) => {
    setScanning(true);
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not read that image — try a JPG or PNG photo'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      const maxDim = 1536;
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];

      const res = await fetch('/api/prospects/scan-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      // The API wraps the extracted fields as { success, data: {...} }
      const card = json.data || {};
      if (Object.values(card).some(v => v)) {
        setForm(prev => ({
          ...prev,
          company_name: card.company_name || prev.company_name,
          contact_name: card.contact_name || prev.contact_name,
          title: card.title || prev.title,
          email: card.email || prev.email,
          phone: card.phone || prev.phone,
          address: card.address || prev.address,
          city: card.city || prev.city,
          state: card.state || prev.state,
          zip: card.zip || prev.zip,
          website: card.website || prev.website,
        }));
        setShowCreate(true);
      } else {
        await dialog.alert('Could not read any contact info off that card — try a closer, sharper photo.');
      }
    } catch (e: any) {
      console.error('Card scan failed:', e);
      await dialog.alert(`Card scan failed: ${e?.message || 'Unknown error'}`);
    }
    URL.revokeObjectURL(url);
    setScanning(false);
  };

  const fmtK = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toFixed(0);

  // All unique tags for the filter dropdown
  const allTags = [...new Set(Object.values(tagsByProspect).flat())].sort();
  const allIndustryTags = [...new Set(Object.values(custTagsByProspect).flat())].sort();

  // Distinct prospect owners (created_by) for the owner filter dropdown.
  const ownerOptions = (() => {
    const ids = new Set<string>();
    for (const p of prospects) if (p.created_by) ids.add(p.created_by);
    return Array.from(ids).map(id => ({ id, name: profiles[id] || id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  })();

  const vendorCount = prospects.filter(p => p.record_type === 'vendor').length;
  const customerCount = prospects.length - vendorCount;

  // Filter — the Customers and Vendors tabs share the table; each shows only
  // its own record type.
  const filtered = prospects.filter(p => {
    if ((p.record_type === 'vendor') !== (crmTab === 'vendors')) return false;
    if (stageFilter && oppStagesByProspect) {
      const want = stageFilter === 'open' ? ['lead', 'quoted', 'negotiating'] : [stageFilter];
      const stages = oppStagesByProspect[p.id];
      if (!stages || !want.some(w => stages.has(w))) return false;
    }
    if (tagFilter && !(tagsByProspect[p.id] || []).includes(tagFilter)) return false;
    if (industryFilter && !(custTagsByProspect[p.id] || []).includes(industryFilter)) return false;
    if (ownerFilter !== 'all' && p.created_by !== ownerFilter) return false;
    if (openQuoteFilter && !openQuoteCustomers.has((p.company_name || '').toLowerCase())) return false;
    if (emailCampaignFilter && !p.email_campaign) return false;
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

  // Sort — click-to-sort table headers (SortableTh). Missing metrics sort
  // last in either direction, so customers without NetSuite history don't
  // float above real revenue.
  const { sorted, sort, toggle, set: setSort } = useTableSort(filtered, {
    company: p => p.company_name,
    contact: p => p.contact_name?.toLowerCase() || null,
    ytd: p => customerMetrics[p.id]?.ytd_spend || null,
    total: p => customerMetrics[p.id]?.total_spend || null,
    last: p => customerMetrics[p.id]?.last_order_date || null,
    added: p => p.created_at,
  }, { key: 'company', dir: 'asc' });

  // Dashboard deep links (?sort=ytd_spend for Top customers, etc.) map onto
  // the header-sort state so the ▲/▼ indicators agree with the link.
  useEffect(() => {
    if (loading) return;
    const map: Record<string, SortState> = {
      company: { key: 'company', dir: 'asc' },
      total_spend: { key: 'total', dir: 'desc' },
      ytd_spend: { key: 'ytd', dir: 'desc' },
      last_order: { key: 'last', dir: 'desc' },
      added: { key: 'added', dir: 'desc' },
    };
    const sortParam = searchParams.get('sort');
    if (sortParam && map[sortParam]) setSort(map[sortParam]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: apply once after load
  }, [loading, searchParams]);

  const exportToExcel = async () => {
    setExporting(true);
    try {
      const rows = sorted.map(p => {
        const m = customerMetrics[p.id];
        return {
          Company: p.company_name,
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
          'Email Campaign': p.email_campaign ? 'Y' : '',
        };
      });
      const today = new Date().toISOString().split('T')[0];
      await downloadXlsx(rows, { sheetName: 'Customers', filename: `customers-export-${today}.xlsx` });
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
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Customers</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{customerCount} total · {prospects.filter(p => p.netsuite_id).length} in NetSuite{vendorCount > 0 ? ` · ${vendorCount} vendor${vendorCount === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button onClick={async () => {
            setSyncing(true);
            try {
              const res = await fetch('/api/netsuite/customers');
              const data = await res.json();
              await dialog.alert(`Customers: ${data.synced || 0}\nProspects: ${data.prospectsSynced || 0}\nContacts: ${data.contactsSynced || 0} synced, ${data.contactsSkipped || 0} skipped, ${data.contactErrors || 0} errors${data.restApiError ? '\nREST API error (HTTP ' + data.restApiError.status + '): ' + data.restApiError.body : ''}${data.firstContactError ? '\nContact error: ' + data.firstContactError : ''}${data.firstProspectError ? '\nProspect error: ' + data.firstProspectError : ''}`);
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
          <button onClick={() => {
            if (showCreate) { setShowCreate(false); setForm(emptyForm); setInterestedIn([]); return; }
            // Open matching the active tab — on Vendors, the form starts as a
            // vendor (it used to open as Customer there, hiding the vendor
            // path behind the small type pills).
            setForm(f => ({ ...f, record_type: crmTab === 'vendors' ? 'vendor' : 'customer' }));
            setShowCreate(true);
          }} style={{
            padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
            background: 'var(--tab-active-bg)', border: '1px solid var(--tab-active-border)', color: 'var(--tab-active-color)', cursor: 'pointer',
          }}>{showCreate ? 'Cancel' : crmTab === 'vendors' ? '+ New Vendor' : '+ New Customer'}</button>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
              {([['customer', 'Customer'], ['vendor', 'Vendor']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setForm({ ...form, record_type: k })} style={{
                  padding: '5px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                  background: form.record_type === k ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                  border: `1px solid ${form.record_type === k ? 'var(--tab-active-border)' : 'var(--border)'}`,
                  color: form.record_type === k ? 'var(--text-primary)' : 'var(--text-muted)',
                }}>{label}</button>
              ))}
              {form.record_type === 'vendor' && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Supplier/partner contact — stays in FleetSuite, never created in NetSuite as a customer.</span>
              )}
            </div>
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Company Name *</div><input style={inputStyle} value={form.company_name} onChange={e => setForm({ ...form, company_name: e.target.value })} /></div>
            <div><div style={labelStyle}>Contact Name</div><input style={inputStyle} value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} /></div>
            <div><div style={labelStyle}>Contact Title</div><input style={inputStyle} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div><div style={labelStyle}>Email</div><input type="email" style={inputStyle} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
            <div><div style={labelStyle}>Phone</div><PhoneInput style={inputStyle} value={form.phone} onChange={v => setForm({ ...form, phone: v })} /></div>
            <div><div style={labelStyle}>Website</div><input style={inputStyle} value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></div>
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Address</div><input style={inputStyle} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
            <div><div style={labelStyle}>City</div><input style={inputStyle} value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              <div><div style={labelStyle}>State</div><input style={inputStyle} value={form.state} onChange={e => setForm({ ...form, state: e.target.value })} /></div>
              <div><div style={labelStyle}>Zip</div><input style={inputStyle} value={form.zip} onChange={e => setForm({ ...form, zip: e.target.value })} /></div>
            </div>
            <div><div style={labelStyle}># of Locations</div><NumberInput min="1" style={inputStyle} value={form.location_count} onChange={e => setForm({ ...form, location_count: parseInt(e.target.value) || 1 })} /></div>
            {form.record_type !== 'vendor' && (
              <div>
                <div style={labelStyle}>How did they find us?</div>
                <select style={inputStyle} value={form.lead_source} onChange={e => setForm({ ...form, lead_source: e.target.value })}>
                  <option value="">Lead source…</option>
                  {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            {form.record_type !== 'vendor' && (
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={labelStyle}>Interested in — starts a deal per selection</div>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {Object.entries(OPP_TYPES).map(([k, label]) => {
                    const on = interestedIn.includes(k);
                    return (
                      <button key={k} type="button" onClick={() => setInterestedIn(prev => on ? prev.filter(t => t !== k) : [...prev, k])} style={{
                        padding: '5px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                        background: on ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                        border: `1px solid ${on ? 'var(--tab-active-border)' : 'var(--border)'}`,
                        color: on ? 'var(--text-primary)' : 'var(--text-muted)',
                      }}>{label}</button>
                    );
                  })}
                </div>
              </div>
            )}
            <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Notes</div><textarea style={{ ...inputStyle, minHeight: '50px', resize: 'vertical' }} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => createCustomer()} disabled={saving || !form.company_name.trim()} style={{
              flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
              background: form.company_name.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none', cursor: 'pointer',
              opacity: saving ? 0.5 : 1,
            }}>{saving ? 'Creating...' : form.record_type === 'vendor' ? 'Create Vendor' : 'Create Customer'}</button>
            {form.record_type !== 'vendor' && (
              <button onClick={() => createCustomer(true)} disabled={saving || !form.company_name.trim()}
                title="Create the customer, then jump straight into a new estimate with them pre-selected"
                style={{
                  flex: 1, padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
                  background: form.company_name.trim() ? 'rgba(96,165,250,0.12)' : 'var(--border)',
                  border: `1px solid ${form.company_name.trim() ? 'rgba(96,165,250,0.4)' : 'var(--border)'}`,
                  color: form.company_name.trim() ? '#60a5fa' : '#fff', cursor: 'pointer',
                  opacity: saving ? 0.5 : 1,
                }}>{saving ? 'Creating...' : 'Create + Start Estimate'}</button>
            )}
          </div>
        </div>
      )}

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '12px', borderBottom: '2px solid var(--border)' }}>
        {(['prospects', 'vendors', 'contacts'] as const).map(tab => (
          <button key={tab} onClick={() => { setCrmTab(tab); if (tab === 'contacts') loadAllContacts(); }} style={{
            padding: '8px 16px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
            background: 'none', border: 'none', borderBottom: crmTab === tab ? '2px solid #3b82f6' : '2px solid transparent',
            color: crmTab === tab ? '#3b82f6' : 'var(--text-muted)', marginBottom: '-2px',
          }}>{tab === 'prospects' ? `Customers (${customerCount})` : tab === 'vendors' ? `Vendors (${vendorCount})` : `Contacts${contactsLoaded ? ` (${allContacts.length})` : ''}`}</button>
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
                        {c.email && (
                          <button
                            onClick={() => router.push(`/admin/prospects/${c.prospect_id}?compose=1&to=${encodeURIComponent(c.email!)}`)}
                            title="Email this contact from FleetSuite — opens the compose screen on their customer record"
                            style={{ color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'inherit', textAlign: 'left' }}>
                            {c.email}
                          </button>
                        )}
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
        placeholder={crmTab === 'vendors' ? 'Search vendors...' : 'Search customers...'}
        style={{ ...inputStyle, marginBottom: '8px' }}
      />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        {stageFilter && (
          <button onClick={() => setStageFilter('')} title="Clear the pipeline-stage filter" style={{
            padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
            background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.4)', color: '#60a5fa', cursor: 'pointer',
          }}>
            Pipeline: {stageFilter === 'open' ? 'Open deals' : OPP_STAGES[stageFilter] || stageFilter}{!oppStagesByProspect ? ' …' : ''} ✕
          </button>
        )}
        <div style={{ flex: 1 }} />
        <FilterButton
          activeCount={(ownerFilter !== 'all' ? 1 : 0) + (tagFilter ? 1 : 0) + (industryFilter ? 1 : 0) + (spendTierFilter !== 'all' ? 1 : 0) + (openQuoteFilter ? 1 : 0) + (emailCampaignFilter ? 1 : 0)}
          onClear={() => { setOwnerFilter('all'); setTagFilter(''); setIndustryFilter(''); setSpendTierFilter('all'); setOpenQuoteFilter(false); setEmailCampaignFilter(false); }}
        >
          <FilterLabel>Owner</FilterLabel>
          <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
            <option value="all">All Owners</option>
            {ownerOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {allTags.length > 0 && (
            <>
              <FilterLabel>Tag</FilterLabel>
              <select value={tagFilter} onChange={e => setTagFilter(e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                <option value="">All Tags</option>
                {allTags.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
          {allIndustryTags.length > 0 && (
            <>
              <FilterLabel>Industry / Partner</FilterLabel>
              <select value={industryFilter} onChange={e => setIndustryFilter(e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                <option value="">All Industries</option>
                {allIndustryTags.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
          <FilterLabel>YTD spend</FilterLabel>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
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
          </div>
          <FilterLabel>Other</FilterLabel>
          <button onClick={() => setOpenQuoteFilter(v => !v)} style={{
            padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
            background: openQuoteFilter ? 'rgba(251,191,36,0.12)' : 'var(--subtle-bg)',
            border: `1px solid ${openQuoteFilter ? 'rgba(251,191,36,0.4)' : 'var(--border)'}`,
            color: openQuoteFilter ? '#f59e0b' : 'var(--text-muted)',
          }}>{openQuoteFilter ? '✓ Open Quote' : 'Open Quote'}</button>
          <button onClick={() => setEmailCampaignFilter(v => !v)} title="Only customers marked for the email campaign — this is the campaign distribution list" style={{
            padding: '4px 9px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
            background: emailCampaignFilter ? 'rgba(96,165,250,0.12)' : 'var(--subtle-bg)',
            border: `1px solid ${emailCampaignFilter ? 'rgba(96,165,250,0.4)' : 'var(--border)'}`,
            color: emailCampaignFilter ? '#60a5fa' : 'var(--text-muted)',
          }}>{emailCampaignFilter ? '✓ Email Campaign' : 'Email Campaign'}</button>
        </FilterButton>
      </div>

      {/* Result count + export */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
          {sorted.length} of {crmTab === 'vendors' ? vendorCount : customerCount} {(crmTab === 'vendors' ? vendorCount : customerCount) === 1 ? 'record' : 'records'}
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

      {/* Customer/vendor table — every row opens the record */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>
            {crmTab === 'vendors'
              ? (search ? 'No matching vendors' : vendorCount === 0 ? 'No vendors yet — use + New (or Scan Card) and pick Vendor to capture a supplier contact' : 'No vendors match the current filters')
              : (search ? 'No matching customers' : 'No customers match the current filters')}
          </div>
        </div>
      ) : (() => {
        const thStyle: React.CSSProperties = {
          fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px',
          color: 'var(--text-muted)', padding: '10px 12px', borderBottom: '1px solid var(--border-strong)',
        };
        const tdStyle: React.CSSProperties = {
          padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: '12.5px', whiteSpace: 'nowrap',
        };
        const numStyle: React.CSSProperties = { ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
        const badge = (label: string, color: string, bg: string) => (
          <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: bg, color, marginLeft: '5px', verticalAlign: '1px' }}>{label}</span>
        );
        // Vendors have no NetSuite spend — their tab drops the money columns.
        const vendorsTab = crmTab === 'vendors';
        return (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
            <div className="responsive-table">
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: vendorsTab ? '480px' : '760px' }}>
                <thead><tr>
                  <SortableTh label="Company" sortKey="company" sort={sort} onToggle={toggle} style={thStyle} />
                  <SortableTh label="Contact" sortKey="contact" sort={sort} onToggle={toggle} style={thStyle} />
                  {!vendorsTab && <SortableTh label="YTD Spend" sortKey="ytd" sort={sort} onToggle={toggle} defaultDir="desc" align="right" style={thStyle} />}
                  {!vendorsTab && <SortableTh label="Total Spend" sortKey="total" sort={sort} onToggle={toggle} defaultDir="desc" align="right" style={thStyle} />}
                  {!vendorsTab && <SortableTh label="Last Order" sortKey="last" sort={sort} onToggle={toggle} defaultDir="desc" style={thStyle} />}
                  <SortableTh label="Added" sortKey="added" sort={sort} onToggle={toggle} defaultDir="desc" style={thStyle} />
                </tr></thead>
                <tbody>
                  {sorted.map(prospect => {
                    const m = customerMetrics[prospect.id];
                    return (
                      <tr key={prospect.id} id={`prospect-${prospect.id}`} className="table-row-link"
                        onClick={() => router.push(`/admin/prospects/${prospect.id}`)}
                        title={prospect.notes || undefined}>
                        <td style={tdStyle}>
                          <span style={{ fontWeight: 800, color: '#60a5fa' }}>{prospect.company_name}</span>
                          {prospect.is_hot && badge('HOT', '#ef4444', 'rgba(239,68,68,0.1)')}
                          {prospect.email_campaign && badge('EMAIL', '#60a5fa', 'rgba(59,130,246,0.1)')}
                          {prospect.multi_location && badge('MULTI-LOC', '#f59e0b', 'rgba(251,191,36,0.1)')}
                          {prospect.netsuite_id
                            ? badge('NS', '#a78bfa', 'rgba(167,139,250,0.1)')
                            : prospect.record_type !== 'vendor' && badge('LEAD', '#60a5fa', 'rgba(96,165,250,0.1)')}
                        </td>
                        <td style={tdStyle}>
                          {prospect.contact_name ? (
                            <>
                              <span style={{ color: 'var(--text-secondary)' }}>{prospect.contact_name}</span>
                              {prospect.email && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{prospect.email}</div>}
                            </>
                          ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                        </td>
                        {!vendorsTab && (
                          <td style={numStyle}>
                            {m?.ytd_spend ? <span style={{ fontWeight: 700, color: '#4ade80' }}>{fmtK(m.ytd_spend)}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                        )}
                        {!vendorsTab && (
                          <td style={numStyle}>
                            {m?.total_spend ? <span style={{ color: 'var(--text-secondary)' }}>{fmtK(m.total_spend)}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                        )}
                        {!vendorsTab && (
                          <td style={tdStyle}>
                            {m?.last_order_date ? new Date(m.last_order_date).toLocaleDateString() : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                          </td>
                        )}
                        <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{new Date(prospect.created_at).toLocaleDateString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}
      </>
      )}
    </div>
  );
}
