'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { theme } from '@/lib/theme';
import NetSuitePdf from '@/components/NetSuitePdf';
import { DropZone } from '@/components/DropZone';
import DropboxProofSearch from '@/components/DropboxProofSearch';
import { exportProspectPDF } from '@/lib/prospect-pdf';
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

interface Contact {
  id: string;
  prospect_id: string;
  name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_decision_maker: boolean;
  notes: string | null;
}

interface Opportunity {
  id: string;
  prospect_id: string;
  title: string;
  type: string;
  stage: string;
  value: number | null;
  notes: string | null;
  expected_close_date: string | null;
  created_at: string;
}

interface Activity {
  id: string;
  prospect_id: string;
  type: string;
  summary: string;
  details: string | null;
  contact_id: string | null;
  created_by: string | null;
  created_at: string;
  creator_name?: string;
}

interface Tag {
  id: string;
  prospect_id: string;
  tag: string;
  auto_generated: boolean;
}

const LEAD_SOURCES = ['Cold Call', 'Lead', 'Maryland Heights Chamber of Commerce', 'Little Black Book', 'Other'];
const OPP_TYPES: Record<string, string> = { tech_install: 'Tech Install', graphics: 'Graphics', rebrand: 'Rebrand', fleet_wrap: 'Fleet Wrap', other: 'Other' };
const OPP_STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STAGE_COLORS: Record<string, string> = { lead: '#60a5fa', quoted: '#a78bfa', negotiating: '#fbbf24', won: '#4ade80', lost: '#f87171' };
const STATUS_LABELS: Record<string, string> = { active: 'Prospects', nurturing: 'Nurturing', converted: 'Converted' };
const STATUS_COLORS: Record<string, string> = { active: '#4ade80', nurturing: '#60a5fa', converted: '#a78bfa' };
const ACTIVITY_ICONS: Record<string, string> = { call: '\u{1F4DE}', email: '\u{1F4E7}', note: '\u{1F4DD}', meeting: '\u{1F91D}', quote_sent: '\u{1F4CB}', status_change: '\u{1F504}' };

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
  const { user, isAdmin, isSales, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [crmTab, setCrmTab] = useState<'prospects' | 'contacts'>('prospects');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

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

  // Detail data (loaded on expand)
  const [contacts, setContacts] = useState<Record<string, Contact[]>>({});
  const [allContacts, setAllContacts] = useState<(Contact & { company_name?: string; prospect_id: string })[]>([]);
  const [contactsLoaded, setContactsLoaded] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [syncingContacts, setSyncingContacts] = useState(false);
  const [opportunities, setOpportunities] = useState<Record<string, Opportunity[]>>({});
  const [activities, setActivities] = useState<Record<string, Activity[]>>({});
  interface Reminder { id: string; title: string; description: string | null; due_at: string; completed_at: string | null; }
  const [reminders, setReminders] = useState<Record<string, Reminder[]>>({});
  const [tags, setTags] = useState<Record<string, Tag[]>>({});

  // Forms
  const [showCreate, setShowCreate] = useState(false);
  const [editingProspectId, setEditingProspectId] = useState<string | null>(null);
  const [form, setForm] = useState({ company_name: '', contact_name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1 });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Customer metrics (from customers table, keyed by netsuite_id)
  const [customerMetrics, setCustomerMetrics] = useState<Record<string, { total_spend: number; avg_order_value: number; ytd_spend: number; ytd_orders: number; last_year_spend: number; total_orders: number; last_order_date: string | null }>>({});
  // Invoices per prospect (keyed by prospect id)
  interface CustDocument { id: string; number: string; date: string; status: string; type: 'invoice' | 'salesOrder' | 'estimate'; typeLabel: string; }
  const [documents, setDocuments] = useState<Record<string, CustDocument[]>>({});
  const [loadingDocs, setLoadingDocs] = useState<string | null>(null);
  const [docsExpanded, setDocsExpanded] = useState<Set<string>>(new Set());
  const [docsShowAll, setDocsShowAll] = useState<Set<string>>(new Set());
  const [docsError, setDocsError] = useState<Record<string, string>>({});
  const [docsHasMore, setDocsHasMore] = useState<Record<string, boolean>>({});
  // Per-prospect type filter for the NetSuite Documents list. 'all' shows
  // everything; otherwise narrows to a single document type.
  type DocTypeFilter = 'all' | 'invoice' | 'salesOrder' | 'estimate';
  const [docTypeFilter, setDocTypeFilter] = useState<Record<string, DocTypeFilter>>({});

  // Inline forms
  const [showContactForm, setShowContactForm] = useState<string | null>(null);
  const [contactForm, setContactForm] = useState({ name: '', title: '', email: '', phone: '', is_decision_maker: false });
  const [showOppForm, setShowOppForm] = useState<string | null>(null);
  const [oppForm, setOppForm] = useState({ title: '', type: 'tech_install', value: '', expected_close_date: '' });
  const [activityInput, setActivityInput] = useState<Record<string, string>>({});
  const [activityType, setActivityType] = useState<Record<string, string>>({});
  const [tagInput, setTagInput] = useState('');

  // Voice notes
  const [recording, setRecording] = useState<string | null>(null); // prospect id being recorded
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceResult, setVoiceResult] = useState<{ summary: string; reminders: number } | null>(null);
  const recognitionRef = useRef<any>(null);

  const startVoiceNote = async (prospectId: string) => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { await dialog.alert('Speech recognition not supported in this browser. Try Chrome.'); return; }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setActivityInput(prev => ({ ...prev, [prospectId]: transcript }));
    };

    recognition.onerror = () => { setRecording(null); };
    recognition.onend = () => { if (recording === prospectId) setRecording(null); };

    recognition.start();
    recognitionRef.current = recognition;
    setRecording(prospectId);
    setVoiceResult(null);
  };

  const stopVoiceNote = async (prospectId: string) => {
    if (recognitionRef.current) { recognitionRef.current.stop(); recognitionRef.current = null; }
    setRecording(null);

    const text = (activityInput[prospectId] || '').trim();
    if (!text) return;

    setVoiceProcessing(true);
    try {
      const res = await fetch('/api/prospects/voice-note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId, noteText: text, userId: user?.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setVoiceResult({ summary: data.summary, reminders: data.reminders || 0 });
        setActivityInput(prev => ({ ...prev, [prospectId]: '' }));
        loadDetail(prospectId);
      }
    } catch {}
    setVoiceProcessing(false);
  };

  // Profiles for activity display
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Card scan
  const [scanning, setScanning] = useState(false);
  const cardInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!hasFeature('prospects') && !isAdmin) { router.push('/home'); return; }
    loadProspects();
    loadProfiles();
    loadOpenQuoteCustomers();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [authLoading]);

  // Preload customer names with at least one open quote so the
  // "open quote" filter doesn't need to round-trip per prospect.
  const loadOpenQuoteCustomers = async () => {
    const { data } = await supabase
      .from('wrap_quotes')
      .select('customer')
      .in('status', ['draft', 'sent']);
    const names = new Set<string>();
    for (const row of data || []) {
      const name = (row as any).customer?.name;
      if (name) names.add(String(name).toLowerCase());
    }
    setOpenQuoteCustomers(names);
  };

  // Deep link from notifications/search/dashboard: ?id=<prospect uuid> or
  // ?ns=<NetSuite customer id> (dashboard Top customers). Reset any filter
  // that could hide the record, expand it, and scroll it into view — without
  // the scroll a deep link into a long A-Z list looks like it just opened
  // the CRM.
  useEffect(() => {
    if (loading) return;
    const prospectId = searchParams.get('id');
    const nsId = searchParams.get('ns');
    const target = prospectId
      ? prospects.find(p => p.id === prospectId)
      : nsId ? prospects.find(p => p.netsuite_id === nsId) : undefined;
    if (!target) return;
    setStatusFilter('all');
    setTagFilter('');
    setOwnerFilter('all');
    setSpendTierFilter('all');
    setOpenQuoteFilter(false);
    setStageFilter('');
    setSearch('');
    if (expandedId !== target.id) toggleExpand(target.id);
    setTimeout(() => {
      document.getElementById(`prospect-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [loading, searchParams]);

  // Dashboard Sales-band deep links: ?stage= filters to prospects with an
  // opportunity in that pipeline stage, ?sort= pre-sorts the list (e.g.
  // ytd_spend for Top customers), ?q= prefills search — the fallback when
  // ?ns= doesn't match a CRM record (customer synced but not in the CRM).
  useEffect(() => {
    if (loading) return;
    const sort = searchParams.get('sort');
    if (sort && ['company', 'total_spend', 'ytd_spend', 'last_order'].includes(sort)) setSortBy(sort as SortBy);
    const stage = searchParams.get('stage');
    if (stage && (stage === 'open' || stage in OPP_STAGES)) setStageFilter(stage);
    const q = searchParams.get('q');
    const nsId = searchParams.get('ns');
    if (q && !(nsId && prospects.some(p => p.netsuite_id === nsId))) setSearch(q);
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

  // Load metrics once prospects are loaded
  useEffect(() => {
    if (prospects.length === 0) return;
    const converted = prospects.filter(p => p.netsuite_id);
    if (converted.length === 0) return;
    const loadAllMetrics = async () => {
      const { data } = await supabase.from('customers').select('netsuite_id, total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date');
      if (!data) return;
      const nsMap: Record<string, any> = {};
      data.forEach((c: any) => { if (c.netsuite_id) nsMap[c.netsuite_id] = c; });
      const metricsMap: Record<string, any> = {};
      converted.forEach(p => { if (nsMap[p.netsuite_id!]) metricsMap[p.id] = nsMap[p.netsuite_id!]; });
      setCustomerMetrics(metricsMap);
    };
    loadAllMetrics();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [prospects]);

  const loadProspects = async () => {
    // Supabase defaults to 1000 rows — paginate to get all
    let all: Prospect[] = [];
    let page = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const from = page * pageSize;
      const { data } = await supabase.from('prospects').select('*').order('company_name').range(from, from + pageSize - 1);
      const batch = (data || []) as Prospect[];
      all = [...all, ...batch];
      hasMore = batch.length === pageSize;
      page++;
    }
    setProspects(all);
    setLoading(false);
  };

  const loadAllContacts = async () => {
    if (contactsLoaded) return;
    try {
      let all: any[] = [];
      let page = 0;
      let hasMore = true;
      while (hasMore) {
        const from = page * 1000;
        const { data, error } = await supabase.from('prospect_contacts').select('*, prospects(company_name)').order('name').range(from, from + 999);
        if (error) { console.error('Contact load error:', error.message); break; }
        const batch = (data || []).map((c: any) => ({ ...c, company_name: c.prospects?.company_name }));
        all = [...all, ...batch];
        hasMore = (data || []).length === 1000;
        page++;
      }
      setAllContacts(all);
    } catch (err: any) {
      console.error('loadAllContacts error:', err.message);
    }
    setContactsLoaded(true);
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name');
    if (data) {
      const map: Record<string, string> = {};
      data.forEach((p: any) => { map[p.id] = p.full_name; });
      setProfiles(map);
    }
  };

  // Load spend metrics for converted customers
  const loadMetrics = async (nsId: string, prospectId: string) => {
    if (customerMetrics[prospectId]) return;
    const { data } = await supabase.from('customers').select('total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date').eq('netsuite_id', nsId).maybeSingle();
    if (data) setCustomerMetrics(prev => ({ ...prev, [prospectId]: data }));
  };

  // Paginated fetch from /api/netsuite/customer-invoices. First call
  // (no append) replaces the list; subsequent "Load more" calls append.
  // Per-prospect hasMore state lets the UI show/hide the load-more
  // button without re-checking the server until clicked.
  const DOCS_PAGE_SIZE = 100;
  const loadDocuments = async (nsId: string, prospectId: string, opts: { append?: boolean } = {}) => {
    if (loadingDocs === prospectId) return;
    if (!opts.append && documents[prospectId]) return;
    setLoadingDocs(prospectId);
    setDocsError(prev => { const n = { ...prev }; delete n[prospectId]; return n; });
    try {
      const offset = opts.append ? (documents[prospectId]?.length || 0) : 0;
      const res = await fetch(`/api/netsuite/customer-invoices?customerId=${nsId}&limit=${DOCS_PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const docs: CustDocument[] = (data.transactions || []).map((t: any) => {
        const typeMap: Record<string, { type: CustDocument['type']; label: string }> = {
          CustInvc: { type: 'invoice', label: 'Invoice' },
          SalesOrd: { type: 'salesOrder', label: 'Sales Order' },
          Estimate: { type: 'estimate', label: 'Estimate' },
        };
        const info = typeMap[t.type] || { type: 'invoice' as const, label: t.type };
        return { id: String(t.id), number: t.tranid || t.id, date: t.trandate || '', status: t.status || '', type: info.type, typeLabel: info.label };
      });
      setDocuments(prev => ({
        ...prev,
        [prospectId]: opts.append ? [...(prev[prospectId] || []), ...docs] : docs,
      }));
      setDocsHasMore(prev => ({ ...prev, [prospectId]: !!data.hasMore }));
    } catch (err: any) {
      console.error('[prospects] loadDocuments failed:', err);
      setDocsError(prev => ({ ...prev, [prospectId]: err?.message || 'Failed to load NetSuite documents' }));
    }
    setLoadingDocs(null);
  };

  const fmtK = (n: number) => n >= 1000 ? '$' + (n / 1000).toFixed(1) + 'k' : '$' + n.toFixed(0);


  const loadDetail = async (prospectId: string) => {
    const [cRes, oRes, aRes, tRes, rRes] = await Promise.all([
      supabase.from('prospect_contacts').select('*').eq('prospect_id', prospectId).order('is_decision_maker', { ascending: false }),
      supabase.from('prospect_opportunities').select('*').eq('prospect_id', prospectId).order('created_at', { ascending: false }),
      supabase.from('prospect_activities').select('*').eq('prospect_id', prospectId).order('created_at', { ascending: false }).limit(50),
      supabase.from('prospect_tags').select('*').eq('prospect_id', prospectId),
      supabase.from('prospect_reminders').select('*').eq('prospect_id', prospectId).is('completed_at', null).order('due_at'),
    ]);
    setContacts(prev => ({ ...prev, [prospectId]: (cRes.data || []) as Contact[] }));
    setOpportunities(prev => ({ ...prev, [prospectId]: (oRes.data || []) as Opportunity[] }));
    setActivities(prev => ({ ...prev, [prospectId]: (aRes.data || []).map((a: any) => ({ ...a, creator_name: profiles[a.created_by] || null })) as Activity[] }));
    setTags(prev => ({ ...prev, [prospectId]: (tRes.data || []) as Tag[] }));
    setReminders(prev => ({ ...prev, [prospectId]: (rRes.data || []) as Reminder[] }));
  };

  const toggleExpand = (id: string) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    loadDetail(id);
    // Load metrics + invoices for converted customers, and auto-expand
    // the Documents section so the NetSuite history is visible without
    // a second click. Users were missing it entirely when it stayed
    // collapsed behind a small chevron.
    const p = prospects.find(pr => pr.id === id);
    if (p?.netsuite_id) {
      loadMetrics(p.netsuite_id, id);
      loadDocuments(p.netsuite_id, id);
      setDocsExpanded(prev => { const n = new Set(prev); n.add(id); return n; });
    }
  };

  // Create prospect
  const startEdit = (p: Prospect) => {
    setForm({ company_name: p.company_name, contact_name: p.contact_name || '', email: p.email || '', phone: p.phone || '', address: p.address || '', city: p.city || '', state: p.state || '', zip: p.zip || '', website: p.website || '', notes: p.notes || '', location_count: p.location_count || 1 });
    setEditingProspectId(p.id);
    setShowCreate(true);
  };

  const saveProspect = async () => {
    if (!form.company_name.trim()) return;
    setSaving(true);
    if (editingProspectId) {
      // Update
      const { error } = await supabase.from('prospects').update({ ...form, location_count: form.location_count || 1 }).eq('id', editingProspectId);
      if (!error) {
        setProspects(prev => prev.map(p => p.id === editingProspectId ? { ...p, ...form } as Prospect : p));
        setShowCreate(false);
        setEditingProspectId(null);
        setForm({ company_name: '', contact_name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1 });
      }
    } else {
      // Create
      const { data, error } = await supabase.from('prospects').insert({ ...form, location_count: form.location_count || 1, created_by: user?.id }).select().single();
      if (!error && data) {
        setProspects(prev => [data as Prospect, ...prev]);
        setShowCreate(false);
        setForm({ company_name: '', contact_name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1 });
        if (form.location_count > 1) {
          await supabase.from('prospect_tags').insert({ prospect_id: data.id, tag: 'multilocation', auto_generated: true });
        }
      }
    }
    setSaving(false);
  };

  // Scan business card
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

  // Add contact
  const addContact = async (prospectId: string) => {
    if (!contactForm.name.trim()) return;
    const { data } = await supabase.from('prospect_contacts').insert({ prospect_id: prospectId, ...contactForm }).select().single();
    if (data) {
      setContacts(prev => ({ ...prev, [prospectId]: [data as Contact, ...(prev[prospectId] || [])] }));
      setContactForm({ name: '', title: '', email: '', phone: '', is_decision_maker: false });
      setShowContactForm(null);
      logActivity(prospectId, 'note', `Added contact: ${contactForm.name}${contactForm.is_decision_maker ? ' (decision maker)' : ''}`);
    }
  };

  // Add opportunity
  const addOpportunity = async (prospectId: string) => {
    if (!oppForm.title.trim()) return;
    const { data } = await supabase.from('prospect_opportunities').insert({
      prospect_id: prospectId,
      title: oppForm.title,
      type: oppForm.type,
      stage: 'lead',
      value: oppForm.value ? parseFloat(oppForm.value) : null,
      expected_close_date: oppForm.expected_close_date || null,
      created_by: user?.id,
    }).select().single();
    if (data) {
      setOpportunities(prev => ({ ...prev, [prospectId]: [data as Opportunity, ...(prev[prospectId] || [])] }));
      setOppForm({ title: '', type: 'tech_install', value: '', expected_close_date: '' });
      setShowOppForm(null);
      logActivity(prospectId, 'note', `Created opportunity: ${oppForm.title} (${OPP_TYPES[oppForm.type]})`);
    }
  };

  // Update opportunity stage
  const updateOppStage = async (opp: Opportunity, newStage: string) => {
    await supabase.from('prospect_opportunities').update({ stage: newStage, ...(newStage === 'won' || newStage === 'lost' ? { closed_at: new Date().toISOString() } : {}) }).eq('id', opp.id);
    setOpportunities(prev => ({
      ...prev,
      [opp.prospect_id]: (prev[opp.prospect_id] || []).map(o => o.id === opp.id ? { ...o, stage: newStage } : o),
    }));
    logActivity(opp.prospect_id, 'status_change', `${opp.title}: ${OPP_STAGES[opp.stage]} → ${OPP_STAGES[newStage]}`);
  };

  // Log activity
  const logActivity = async (prospectId: string, type: string, summary: string) => {
    const { data } = await supabase.from('prospect_activities').insert({
      prospect_id: prospectId,
      type,
      summary,
      created_by: user?.id,
    }).select().single();
    if (data) {
      setActivities(prev => ({
        ...prev,
        [prospectId]: [{ ...data, creator_name: profiles[user?.id || ''] || null } as Activity, ...(prev[prospectId] || [])],
      }));
    }
  };

  // Quick activity log
  const submitActivity = async (prospectId: string) => {
    const text = (activityInput[prospectId] || '').trim();
    if (!text) return;
    const type = activityType[prospectId] || 'note';
    await logActivity(prospectId, type, text);
    setActivityInput(prev => ({ ...prev, [prospectId]: '' }));
  };

  // Add tag
  const addTag = async (prospectId: string) => {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    const { data } = await supabase.from('prospect_tags').insert({ prospect_id: prospectId, tag: t }).select().single();
    if (data) {
      setTags(prev => ({ ...prev, [prospectId]: [...(prev[prospectId] || []), data as Tag] }));
      setTagInput('');
    }
  };

  const removeTag = async (tag: Tag) => {
    await supabase.from('prospect_tags').delete().eq('id', tag.id);
    setTags(prev => ({ ...prev, [tag.prospect_id]: (prev[tag.prospect_id] || []).filter(t => t.id !== tag.id) }));
  };

  // Update prospect status
  const updateStatus = async (prospect: Prospect, newStatus: string) => {
    await supabase.from('prospects').update({ status: newStatus }).eq('id', prospect.id);
    setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, status: newStatus } : p));
    logActivity(prospect.id, 'status_change', `Status: ${STATUS_LABELS[prospect.status]} → ${STATUS_LABELS[newStatus]}`);
  };

  // Convert to customer (push to NetSuite + preserve data)
  const convertToCustomer = async (prospect: Prospect) => {
    if (prospect.netsuite_id) { await dialog.alert('Already pushed to NetSuite'); return; }
    if (!(await dialog.confirm(`Convert "${prospect.company_name}" to a customer in NetSuite? All prospect data will be preserved.`, { confirmLabel: 'Convert' }))) return;
    try {
      const res = await fetch('/api/prospects/push-to-netsuite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId: prospect.id, type: 'customer', userId: user?.id }),
      });
      const data = await res.json();
      if (data.success) {
        await supabase.from('prospects').update({ status: 'converted', converted_customer_id: data.customerId }).eq('id', prospect.id);
        setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, status: 'converted', netsuite_id: data.customerId, netsuite_url: data.netsuiteUrl, converted_customer_id: data.customerId } : p));
        logActivity(prospect.id, 'status_change', `Converted to NetSuite customer #${data.entityId}`);
      } else {
        await dialog.alert('Failed: ' + (data.error || 'Unknown error'));
      }
    } catch (e) {
      await dialog.alert('Network error');
    }
  };

  // Delete prospect
  const deleteProspect = async (id: string) => {
    if (!(await dialog.confirm('Delete this prospect and all associated data?', { destructive: true, confirmLabel: 'Delete' }))) return;
    await supabase.from('prospects').delete().eq('id', id);
    setProspects(prev => prev.filter(p => p.id !== id));
    setExpandedId(null);
  };

  // All unique tags for filter
  const allTags = [...new Set(Object.values(tags).flat().map((t: Tag) => t.tag))].sort();

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
    if (tagFilter && !(tags[p.id] || []).some(t => t.tag === tagFilter)) return false;
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
          <button onClick={() => { if (showCreate) { setShowCreate(false); setEditingProspectId(null); setForm({ company_name: '', contact_name: '', email: '', phone: '', address: '', city: '', state: '', zip: '', website: '', notes: '', location_count: 1 }); } else { setShowCreate(true); setEditingProspectId(null); } }} style={{
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
          <button onClick={saveProspect} disabled={saving || !form.company_name.trim()} style={{
            width: '100%', padding: '12px', borderRadius: '10px', fontSize: '13px', fontWeight: 700,
            background: form.company_name.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none', cursor: 'pointer',
            opacity: saving ? 0.5 : 1,
          }}>{saving ? 'Saving...' : editingProspectId ? 'Save Changes' : 'Create Prospect'}</button>
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
            const filtered = q ? allContacts.filter(c => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q) || c.phone?.toLowerCase().includes(q) || c.company_name?.toLowerCase().includes(q) || c.title?.toLowerCase().includes(q)) : allContacts;
            return filtered.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>No contacts found</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {filtered.map(c => (
                  <div key={c.id} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '10px', padding: '10px 12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-body)' }}>{c.name}</div>
                        <div style={{ fontSize: '12px', color: '#60a5fa', fontWeight: 600 }}>{c.company_name || 'Unknown company'}</div>
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

      {/* Prospect List */}
      {sorted.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{search ? 'No matching prospects' : 'No prospects match the current filters'}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {sorted.map(prospect => {
            const isExpanded = expandedId === prospect.id;
            const pContacts = contacts[prospect.id] || [];
            const pOpps = opportunities[prospect.id] || [];
            const pActivities = activities[prospect.id] || [];
            const pTags = tags[prospect.id] || [];
            const statusColor = STATUS_COLORS[prospect.status] || '#6b7280';

            return (
              <div key={prospect.id} id={`prospect-${prospect.id}`} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', overflow: 'hidden' }}>
                {/* Header */}
                <div onClick={() => toggleExpand(prospect.id)} style={{ padding: '12px 14px', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                      <div style={{ marginTop: '2px' }}>{isExpanded ? '▲' : '▼'}</div>
                    </div>
                  </div>
                </div>

                {/* Expanded Detail */}
                {isExpanded && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px' }}>

                    {/* Status Actions */}
                    <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
                      {['active', 'nurturing', 'converted'].filter(s => s !== prospect.status).map(s => (
                        <button key={s} onClick={() => updateStatus(prospect, s)} style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: `${STATUS_COLORS[s]}12`, border: `1px solid ${STATUS_COLORS[s]}33`, color: STATUS_COLORS[s], cursor: 'pointer',
                        }}>{STATUS_LABELS[s]}</button>
                      ))}
                      {prospect.status !== 'converted' && (
                        <button onClick={() => convertToCustomer(prospect)} style={{
                          padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa', cursor: 'pointer',
                        }}>Convert to Customer</button>
                      )}
                    </div>

                    {/* Tags */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={labelStyle}>Tags</div>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
                        {pTags.map(t => (
                          <span key={t.id} onClick={() => removeTag(t)} style={{
                            padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
                            background: t.auto_generated ? 'rgba(251,191,36,0.1)' : 'rgba(59,130,246,0.1)',
                            border: `1px solid ${t.auto_generated ? 'rgba(251,191,36,0.25)' : 'rgba(59,130,246,0.25)'}`,
                            color: t.auto_generated ? '#fbbf24' : '#60a5fa', cursor: 'pointer',
                          }}>{t.tag} ✕</span>
                        ))}
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <input value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTag(prospect.id); }} placeholder="Add tag..." style={{ ...inputStyle, width: '100px', padding: '3px 8px', fontSize: '10px' }} />
                        </div>
                      </div>
                    </div>

                    {/* Spend Metrics (converted customers only) */}
                    {prospect.netsuite_id && customerMetrics[prospect.id] && (() => {
                      const m = customerMetrics[prospect.id];
                      return (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px', marginBottom: '12px' }}>
                          <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)' }}>
                            <div style={{ fontSize: '15px', fontWeight: 800, color: '#4ade80' }}>{fmtK(m.ytd_spend)}</div>
                            <div style={{ fontSize: '8px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>YTD{m.ytd_orders > 0 ? ` · ${m.ytd_orders}` : ''}</div>
                          </div>
                          <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', background: 'rgba(251,191,36,0.08)' }}>
                            <div style={{ fontSize: '15px', fontWeight: 800, color: '#fbbf24' }}>{fmtK(m.last_year_spend)}</div>
                            <div style={{ fontSize: '8px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Last Year</div>
                          </div>
                          <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', background: 'rgba(59,130,246,0.08)' }}>
                            <div style={{ fontSize: '15px', fontWeight: 800, color: '#60a5fa' }}>{fmtK(m.total_spend)}</div>
                            <div style={{ fontSize: '8px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>All-Time · {m.total_orders}</div>
                          </div>
                          <div style={{ textAlign: 'center', padding: '8px 4px', borderRadius: '8px', background: 'rgba(168,85,247,0.08)' }}>
                            <div style={{ fontSize: '15px', fontWeight: 800, color: '#a855f7' }}>{fmtK(m.avg_order_value)}</div>
                            <div style={{ fontSize: '8px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Avg Order</div>
                          </div>
                        </div>
                      );
                    })()}

                    {/* NetSuite Documents — invoices, sales orders, estimates */}
                    {prospect.netsuite_id ? (
                      <div style={{ marginBottom: '12px' }}>
                        <div onClick={() => setDocsExpanded(prev => { const n = new Set(prev); if (n.has(prospect.id)) n.delete(prospect.id); else n.add(prospect.id); return n; })}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', marginBottom: docsExpanded.has(prospect.id) ? '6px' : 0 }}>
                          <div style={labelStyle}>
                            <span style={{ marginRight: '4px', fontSize: '8px', transition: 'transform 0.15s', display: 'inline-block', transform: docsExpanded.has(prospect.id) ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
                            NetSuite Documents (invoices, SOs, estimates)
                            {loadingDocs === prospect.id ? (
                              <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontWeight: 500 }}>loading…</span>
                            ) : (
                              <span style={{ marginLeft: '6px', color: 'var(--text-muted)', fontWeight: 500 }}>· {(documents[prospect.id] || []).length}</span>
                            )}
                          </div>
                        </div>
                        {docsExpanded.has(prospect.id) && (
                          <div>
                            {loadingDocs === prospect.id ? (
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading NetSuite documents…</div>
                            ) : docsError[prospect.id] ? (
                              <div style={{
                                padding: '8px 10px', borderRadius: '6px', marginBottom: '6px',
                                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                                color: '#ef4444', fontSize: '11px', display: 'flex',
                                justifyContent: 'space-between', alignItems: 'center', gap: '8px',
                              }}>
                                <span>NetSuite error: {docsError[prospect.id]}</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setDocuments(prev => { const n = { ...prev }; delete n[prospect.id]; return n; }); if (prospect.netsuite_id) loadDocuments(prospect.netsuite_id, prospect.id); }}
                                  style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700, background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', cursor: 'pointer' }}
                                >Retry</button>
                              </div>
                            ) : (documents[prospect.id] || []).length === 0 ? (
                              <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 10px', borderRadius: '6px', background: 'var(--subtle-bg)' }}>
                                No documents found for this customer in NetSuite.
                              </div>
                            ) : (() => {
                              const allDocs = documents[prospect.id] || [];
                              const active: DocTypeFilter = docTypeFilter[prospect.id] || 'all';
                              const counts = {
                                all: allDocs.length,
                                invoice: allDocs.filter(d => d.type === 'invoice').length,
                                salesOrder: allDocs.filter(d => d.type === 'salesOrder').length,
                                estimate: allDocs.filter(d => d.type === 'estimate').length,
                              };
                              const filtered = active === 'all' ? allDocs : allDocs.filter(d => d.type === active);
                              const showAll = docsShowAll.has(prospect.id);
                              const visible = showAll ? filtered : filtered.slice(0, 5);
                              const TYPE_DOC_COLORS: Record<string, string> = { invoice: '#34d399', salesOrder: '#60a5fa', estimate: '#fbbf24' };
                              const pills: { key: DocTypeFilter; label: string; count: number; color: string }[] = [
                                { key: 'all', label: 'All', count: counts.all, color: '#a78bfa' },
                                { key: 'invoice', label: 'Invoices', count: counts.invoice, color: TYPE_DOC_COLORS.invoice },
                                { key: 'salesOrder', label: 'Sales Orders', count: counts.salesOrder, color: TYPE_DOC_COLORS.salesOrder },
                                { key: 'estimate', label: 'Estimates', count: counts.estimate, color: TYPE_DOC_COLORS.estimate },
                              ];
                              return (
                                <div>
                                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
                                    {pills.map(p => {
                                      const isActive = active === p.key;
                                      return (
                                        <button
                                          key={p.key}
                                          onClick={() => {
                                            setDocTypeFilter(prev => ({ ...prev, [prospect.id]: p.key }));
                                            setDocsShowAll(prev => { const n = new Set(prev); n.delete(prospect.id); return n; });
                                          }}
                                          style={{
                                            padding: '4px 10px', borderRadius: '999px', fontSize: '10px', fontWeight: 700,
                                            cursor: 'pointer',
                                            background: isActive ? `${p.color}22` : 'var(--subtle-bg)',
                                            border: `1px solid ${isActive ? p.color : 'var(--border)'}`,
                                            color: isActive ? p.color : 'var(--text-muted)',
                                          }}
                                        >{p.label} · {p.count}</button>
                                      );
                                    })}
                                  </div>
                                  {filtered.length === 0 ? (
                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 10px', borderRadius: '6px', background: 'var(--subtle-bg)' }}>
                                      No {active === 'all' ? 'documents' : pills.find(p => p.key === active)?.label.toLowerCase()} for this customer.
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                      {visible.map(doc => (
                                        <div key={`${doc.type}-${doc.id}`} style={{ padding: '6px 8px', borderRadius: '6px', background: 'var(--subtle-bg)' }}>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                              <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: `${TYPE_DOC_COLORS[doc.type] || '#6b7280'}18`, color: TYPE_DOC_COLORS[doc.type] || '#6b7280' }}>{doc.typeLabel}</span>
                                              <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)' }}>#{doc.number}</span>
                                            </div>
                                            <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{doc.date}{doc.status ? ` · ${doc.status}` : ''}</span>
                                          </div>
                                          <NetSuitePdf type={doc.type === 'invoice' ? 'invoice' : 'salesOrder'} recordId={doc.id} recordNumber={doc.number} />
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {filtered.length > 5 && !showAll && (
                                    <button onClick={() => setDocsShowAll(prev => { const n = new Set(prev); n.add(prospect.id); return n; })} style={{ width: '100%', padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, marginTop: '4px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: '#60a5fa', cursor: 'pointer' }}>
                                      Show All ({filtered.length})
                                    </button>
                                  )}
                                  {docsHasMore[prospect.id] && (
                                    <button
                                      onClick={() => prospect.netsuite_id && loadDocuments(prospect.netsuite_id, prospect.id, { append: true })}
                                      disabled={loadingDocs === prospect.id}
                                      style={{ width: '100%', padding: '6px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, marginTop: '4px', background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', color: '#60a5fa', cursor: loadingDocs === prospect.id ? 'default' : 'pointer', opacity: loadingDocs === prospect.id ? 0.5 : 1 }}
                                    >
                                      {loadingDocs === prospect.id ? 'Loading more…' : `Load older history (page ${Math.ceil((allDocs.length / 100)) + 1})`}
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div style={{ marginBottom: '12px', padding: '8px 10px', borderRadius: '6px', background: 'var(--subtle-bg)', border: '1px solid var(--border)' }}>
                        <div style={labelStyle}>NetSuite Documents</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          This prospect isn&apos;t linked to a NetSuite customer record yet. Once it&apos;s converted, NetSuite invoices, sales orders, and estimates will appear here.
                        </div>
                      </div>
                    )}

                    {/* Dropbox proof search — pre-fills with the company
                        name so users can find prior artwork without
                        manually navigating the Dropbox folder tree. */}
                    <div style={{ marginBottom: '12px' }}>
                      <DropboxProofSearch defaultQuery={prospect.company_name || ''} />
                    </div>

                    {/* Quick toggles & details */}
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
                      <button onClick={async () => { await supabase.from('prospects').update({ is_hot: !prospect.is_hot }).eq('id', prospect.id); setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, is_hot: !p.is_hot } : p)); }} style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                        background: prospect.is_hot ? 'rgba(239,68,68,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.is_hot ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`, color: prospect.is_hot ? '#ef4444' : 'var(--text-muted)',
                      }}>{prospect.is_hot ? '🔥 Hot' : 'Mark Hot'}</button>
                      <button onClick={async () => { await supabase.from('prospects').update({ email_campaign: !prospect.email_campaign }).eq('id', prospect.id); setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, email_campaign: !p.email_campaign } : p)); }} style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                        background: prospect.email_campaign ? 'rgba(59,130,246,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.email_campaign ? 'rgba(59,130,246,0.25)' : 'var(--border)'}`, color: prospect.email_campaign ? '#60a5fa' : 'var(--text-muted)',
                      }}>{prospect.email_campaign ? '✓ Email Campaign' : 'Email Campaign'}</button>
                      <button onClick={async () => { await supabase.from('prospects').update({ multi_location: !prospect.multi_location }).eq('id', prospect.id); setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, multi_location: !p.multi_location } : p)); }} style={{
                        padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                        background: prospect.multi_location ? 'rgba(251,191,36,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.multi_location ? 'rgba(251,191,36,0.25)' : 'var(--border)'}`, color: prospect.multi_location ? '#f59e0b' : 'var(--text-muted)',
                      }}>{prospect.multi_location ? '✓ Multi-Location' : 'Multi-Location'}</button>
                      <button
                        onClick={() => window.open(`/admin/prospects/${prospect.id}`, '_blank')}
                        title="Open the standalone customer record page in a new tab"
                        style={{
                          padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                          background: 'rgba(74,222,128,0.1)', border: '1px solid rgba(74,222,128,0.25)', color: '#4ade80',
                          marginLeft: 'auto',
                        }}
                      >Open Record ↗</button>
                      <button
                        onClick={() => exportProspectPDF({
                          prospect,
                          statusLabel: STATUS_LABELS[prospect.status] || prospect.status || '',
                          ownerName: profiles[prospect.created_by || ''] || null,
                          metrics: customerMetrics[prospect.id] || null,
                          contacts: contacts[prospect.id] || [],
                          opportunities: opportunities[prospect.id] || [],
                          activities: activities[prospect.id] || [],
                          tags: tags[prospect.id] || [],
                          documents: documents[prospect.id] || [],
                        })}
                        title="Download a printable PDF summary of this prospect"
                        style={{
                          padding: '5px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                          background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa',
                        }}
                      >Export PDF</button>
                    </div>

                    {/* Lead source & details */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
                      <div>
                        <div style={labelStyle}>Lead Source</div>
                        <select value={prospect.lead_source || ''} onChange={async (e) => {
                          const val = e.target.value;
                          await supabase.from('prospects').update({ lead_source: val || null }).eq('id', prospect.id);
                          setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, lead_source: val || null } : p));
                        }} style={{ ...inputStyle, padding: '6px 8px' }}>
                          <option value="">— Select —</option>
                          {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        {prospect.lead_source === 'Other' && (
                          <input placeholder="Specify source..." value={prospect.lead_source_other || ''} onChange={async (e) => {
                            const val = e.target.value;
                            await supabase.from('prospects').update({ lead_source_other: val }).eq('id', prospect.id);
                            setProspects(prev => prev.map(p => p.id === prospect.id ? { ...p, lead_source_other: val } : p));
                          }} style={{ ...inputStyle, padding: '4px 8px', marginTop: '4px', fontSize: '11px' }} />
                        )}
                      </div>
                      <div>
                        <div style={labelStyle}>Location</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-body)' }}>
                          {[prospect.address, prospect.city, prospect.state, prospect.zip].filter(Boolean).join(', ') || '—'}
                        </div>
                      </div>
                      {prospect.phone && <div><div style={labelStyle}>Phone</div><div style={{ fontSize: '12px', color: 'var(--text-body)' }}>{prospect.phone}</div></div>}
                      {prospect.email && <div><div style={labelStyle}>Email</div><div style={{ fontSize: '12px', color: 'var(--text-body)' }}>{prospect.email}</div></div>}
                    </div>

                    {/* Contacts */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <div style={labelStyle}>Contacts ({pContacts.length})</div>
                        <button onClick={() => setShowContactForm(showContactForm === prospect.id ? null : prospect.id)} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer' }}>
                          {showContactForm === prospect.id ? 'Cancel' : '+ Add'}
                        </button>
                      </div>
                      {showContactForm === prospect.id && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px', padding: '8px', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                          <input style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Name *" value={contactForm.name} onChange={e => setContactForm({ ...contactForm, name: e.target.value })} />
                          <input style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Title" value={contactForm.title} onChange={e => setContactForm({ ...contactForm, title: e.target.value })} />
                          <input style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Email" value={contactForm.email} onChange={e => setContactForm({ ...contactForm, email: e.target.value })} />
                          <input style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Phone" value={contactForm.phone} onChange={e => setContactForm({ ...contactForm, phone: e.target.value })} />
                          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
                            <input type="checkbox" checked={contactForm.is_decision_maker} onChange={e => setContactForm({ ...contactForm, is_decision_maker: e.target.checked })} />
                            Key decision maker
                          </label>
                          <button onClick={() => addContact(prospect.id)} disabled={!contactForm.name.trim()} style={{ gridColumn: '1 / -1', padding: '6px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', opacity: contactForm.name.trim() ? 1 : 0.5 }}>Add Contact</button>
                        </div>
                      )}
                      {pContacts.map(c => (
                        <div key={c.id} style={{ padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', marginBottom: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{c.name}</span>
                              {c.is_decision_maker && <span style={{ fontSize: '8px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px', background: 'rgba(251,191,36,0.1)', color: '#fbbf24' }}>DM</span>}
                            </div>
                            {c.title && !['Customer Center', 'Customer'].includes(c.title) && (
                              <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600 }}>{c.title}</span>
                            )}
                          </div>
                          {(c.email || c.phone) && (
                            <div style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
                              {c.email && <a href={`mailto:${c.email}`} style={{ color: '#60a5fa', textDecoration: 'none' }}>{c.email}</a>}
                              {c.phone && <a href={`tel:${c.phone}`} style={{ color: '#22c55e', textDecoration: 'none', whiteSpace: 'nowrap' }}>{c.phone}</a>}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Opportunities */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <div style={labelStyle}>Opportunities ({pOpps.length})</div>
                        <button onClick={() => setShowOppForm(showOppForm === prospect.id ? null : prospect.id)} style={{ fontSize: '10px', fontWeight: 700, color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer' }}>
                          {showOppForm === prospect.id ? 'Cancel' : '+ Add'}
                        </button>
                      </div>
                      {showOppForm === prospect.id && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px', padding: '8px', background: 'var(--subtle-bg)', borderRadius: '8px' }}>
                          <input style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Opportunity title *" value={oppForm.title} onChange={e => setOppForm({ ...oppForm, title: e.target.value })} />
                          <select style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} value={oppForm.type} onChange={e => setOppForm({ ...oppForm, type: e.target.value })}>
                            {Object.entries(OPP_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                          </select>
                          <input type="number" style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} placeholder="Est. value $" value={oppForm.value} onChange={e => setOppForm({ ...oppForm, value: e.target.value })} />
                          <input type="date" style={{ ...inputStyle, padding: '6px 8px', fontSize: '11px' }} value={oppForm.expected_close_date} onChange={e => setOppForm({ ...oppForm, expected_close_date: e.target.value })} />
                          <button onClick={() => addOpportunity(prospect.id)} disabled={!oppForm.title.trim()} style={{ gridColumn: '1 / -1', padding: '6px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, background: '#22c55e', color: '#fff', border: 'none', cursor: 'pointer', opacity: oppForm.title.trim() ? 1 : 0.5 }}>Add Opportunity</button>
                        </div>
                      )}
                      {pOpps.map(opp => (
                        <div key={opp.id} style={{ padding: '8px', borderRadius: '8px', background: 'var(--subtle-bg)', marginBottom: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                            <div>
                              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{opp.title}</span>
                              <span style={{ fontSize: '9px', fontWeight: 700, marginLeft: '6px', padding: '2px 6px', borderRadius: '4px', background: `${STAGE_COLORS[opp.stage]}18`, color: STAGE_COLORS[opp.stage] }}>{OPP_STAGES[opp.stage]}</span>
                            </div>
                            {opp.value && <span style={{ fontSize: '12px', fontWeight: 700, color: '#4ade80' }}>${opp.value.toLocaleString()}</span>}
                          </div>
                          <div style={{ display: 'flex', gap: '3px', fontSize: '9px' }}>
                            {Object.entries(OPP_STAGES).map(([k, v]) => (
                              <button key={k} onClick={() => updateOppStage(opp, k)} disabled={opp.stage === k} style={{
                                padding: '2px 6px', borderRadius: '4px', fontWeight: 700,
                                background: opp.stage === k ? `${STAGE_COLORS[k]}33` : 'transparent',
                                border: `1px solid ${opp.stage === k ? STAGE_COLORS[k] : 'var(--border)'}`,
                                color: opp.stage === k ? STAGE_COLORS[k] : 'var(--text-muted)', cursor: opp.stage === k ? 'default' : 'pointer',
                              }}>{v}</button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Reminders */}
                    {(reminders[prospect.id] || []).length > 0 && (
                      <div style={{ marginBottom: '12px' }}>
                        <div style={labelStyle}>Upcoming Reminders</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          {(reminders[prospect.id] || []).map(r => {
                            const isDue = new Date(r.due_at) <= new Date();
                            return (
                              <div key={r.id} style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '6px 8px', borderRadius: '6px',
                                background: isDue ? 'rgba(239,68,68,0.06)' : 'var(--subtle-bg)',
                                border: `1px solid ${isDue ? 'rgba(239,68,68,0.2)' : 'var(--border)'}`,
                              }}>
                                <div>
                                  <div style={{ fontSize: '11px', fontWeight: 700, color: isDue ? '#ef4444' : 'var(--text-primary)' }}>{r.title}</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>{new Date(r.due_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                                </div>
                                <button onClick={async () => {
                                  await supabase.from('prospect_reminders').update({ completed_at: new Date().toISOString() }).eq('id', r.id);
                                  setReminders(prev => ({ ...prev, [prospect.id]: (prev[prospect.id] || []).filter(rem => rem.id !== r.id) }));
                                }} style={{ padding: '3px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer' }}>Done</button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Activity Log */}
                    <div style={{ marginBottom: '12px' }}>
                      <div style={labelStyle}>Activity</div>
                      <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                        <select value={activityType[prospect.id] || 'note'} onChange={e => setActivityType(prev => ({ ...prev, [prospect.id]: e.target.value }))} style={{ ...inputStyle, width: '90px', padding: '6px 8px', fontSize: '11px' }}>
                          <option value="note">Note</option>
                          <option value="call">Call</option>
                          <option value="email">Email</option>
                          <option value="meeting">Meeting</option>
                        </select>
                        <input
                          value={activityInput[prospect.id] || ''} onChange={e => setActivityInput(prev => ({ ...prev, [prospect.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') submitActivity(prospect.id); }}
                          placeholder="Log activity..."
                          style={{ ...inputStyle, flex: 1, padding: '6px 8px', fontSize: '11px' }}
                        />
                        <button onClick={() => submitActivity(prospect.id)} disabled={!(activityInput[prospect.id] || '').trim()} style={{
                          padding: '6px 12px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                          background: (activityInput[prospect.id] || '').trim() ? 'rgba(59,130,246,0.15)' : 'var(--subtle-bg)',
                          border: `1px solid ${(activityInput[prospect.id] || '').trim() ? 'rgba(59,130,246,0.3)' : 'var(--border)'}`,
                          color: (activityInput[prospect.id] || '').trim() ? '#60a5fa' : 'var(--text-muted)', cursor: 'pointer',
                        }}>Post</button>
                        {recording === prospect.id ? (
                          <button onClick={() => stopVoiceNote(prospect.id)} style={{
                            padding: '6px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 700,
                            background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                            color: '#ef4444', cursor: 'pointer', animation: 'pulse 1.5s infinite',
                          }}>&#9632; Stop</button>
                        ) : (
                          <button onClick={() => startVoiceNote(prospect.id)} disabled={voiceProcessing} style={{
                            padding: '6px 10px', borderRadius: '6px', fontSize: '12px',
                            background: 'rgba(167,139,250,0.1)', border: '1px solid rgba(167,139,250,0.25)',
                            color: '#a78bfa', cursor: 'pointer',
                          }} title="Voice note">&#127908;</button>
                        )}
                      </div>
                      {voiceProcessing && recording === null && (
                        <div style={{ fontSize: '10px', color: '#a78bfa', fontWeight: 600, marginBottom: '4px' }}>AI is parsing your note and creating reminders...</div>
                      )}
                      {voiceResult && (
                        <div style={{ padding: '6px 10px', borderRadius: '6px', marginBottom: '4px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', fontSize: '10px', color: '#22c55e', fontWeight: 600 }}>
                          Saved: {voiceResult.summary.slice(0, 80)}{voiceResult.summary.length > 80 ? '...' : ''}{voiceResult.reminders > 0 ? ` · ${voiceResult.reminders} reminder${voiceResult.reminders !== 1 ? 's' : ''} created` : ''}
                        </div>
                      )}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '200px', overflowY: 'auto' }}>
                        {pActivities.map(a => (
                          <div key={a.id} style={{ display: 'flex', gap: '6px', padding: '4px 6px', borderRadius: '6px', fontSize: '10px', color: 'var(--text-label)' }}>
                            <span>{ACTIVITY_ICONS[a.type] || ''}</span>
                            <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{new Date(a.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                            <span style={{ color: 'var(--text-body)', flex: 1 }}>{a.summary}</span>
                            {a.creator_name && <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>— {a.creator_name}</span>}
                          </div>
                        ))}
                        {pActivities.length === 0 && <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>No activity yet</div>}
                      </div>
                    </div>

                    {/* Info & Actions */}
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <button onClick={() => startEdit(prospect)} style={{
                        flex: 1, padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', color: '#60a5fa', cursor: 'pointer',
                      }}>Edit</button>
                      {prospect.netsuite_url && (
                        <a href={prospect.netsuite_url} target="_blank" rel="noopener noreferrer" style={{
                          flex: 1, padding: '8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, textAlign: 'center', textDecoration: 'none',
                          background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', color: '#a78bfa',
                        }}>View in NetSuite</a>
                      )}
                      <button onClick={() => deleteProspect(prospect.id)} style={{
                        padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                        background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171', cursor: 'pointer',
                      }}>Delete</button>
                    </div>
                  </div>
                )}
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
