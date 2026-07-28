'use client';

/**
 * The standalone Customer Record — one customer/prospect on its own page,
 * deep-linkable from the dashboard's Top customers (opens in a new tab)
 * and from the CRM list's "Open Record" button. Shows everything the CRM's
 * expanded card knows — identity, NetSuite spend metrics, contacts, deals,
 * reminders, activity, and NetSuite documents with PDFs — without landing
 * in the full A-Z list and scrolling. Editing stays on the CRM list page
 * ("Open in CRM").
 *
 * Routes:
 *   /admin/prospects/<uuid>       — CRM prospect id
 *   /admin/prospects/ns-<id>      — NetSuite customer internal id (dashboard
 *                                   links, which only know the NetSuite id).
 *                                   Falls back to the synced customers row
 *                                   when the customer isn't in the CRM.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import { SortableTh, useTableSort } from '@/components/ui/SortableTh';
import { usd2 } from '@/lib/financials-print';
import { exportStatementPDF } from '@/lib/statement-pdf';
import { fetchCompanyLetterhead, type CompanyLetterhead } from '@/lib/company-profile';
import { AGE_META } from '@/components/FinancialsDrilldown';
import type { OpenArInvoice, AgingBucketKey, StatementInvoice, StatementScope } from '@/lib/financials-data';

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
  status: string;
  location_count: number;
  lead_source: string | null;
  lead_source_other: string | null;
  is_hot: boolean;
  netsuite_id: string | null;
  netsuite_url: string | null;
  created_by: string | null;
  billing_emails: string[] | null;
}

interface CustomerRow {
  netsuite_id: string;
  netsuite_url: string | null;
  company_name: string | null;
  entity_id: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  total_spend: number | null;
  avg_order_value: number | null;
  ytd_spend: number | null;
  ytd_orders: number | null;
  last_year_spend: number | null;
  total_orders: number | null;
  last_order_date: string | null;
}

interface Contact { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_decision_maker: boolean; netsuite_contact_id: string | null }
interface Opportunity { id: string; title: string; type: string; stage: string; value: number | null; expected_close_date: string | null; created_at: string }
interface Activity { id: string; type: string; summary: string; created_by: string | null; created_at: string; creator_name?: string | null }
interface Reminder { id: string; title: string; description: string | null; due_at: string }
interface Tag { id: string; tag: string }
interface CustDocument {
  id: string;
  number: string;
  date: string | null; // ISO
  dueDate: string | null; // ISO
  status: string; // display string from NetSuite
  statusNorm: 'open' | 'pastdue' | 'paid' | 'other';
  daysPastDue: number;
  total: number;
  type: 'invoice' | 'salesOrder' | 'estimate';
  typeLabel: string;
}

/** Normalize NetSuite dates ('YYYY-MM-DD' or 'M/D/YYYY') to ISO, else null. */
const toIso = (d: unknown): string | null => {
  if (!d) return null;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const docDaysPastDue = (dueIso: string | null): number => {
  if (!dueIso) return 0;
  const t = Date.parse(dueIso);
  if (Number.isNaN(t)) return 0;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.floor((todayUtc - t) / 86_400_000));
};

const STATUS_RANK: Record<CustDocument['statusNorm'], number> = { pastdue: 0, open: 1, paid: 2, other: 3 };

// Column getters for the sortable documents table (ISO dates compare correctly
// as strings; nulls sort last via useTableSort).
const DOC_SORT_COLS = {
  type: (d: CustDocument) => d.typeLabel,
  number: (d: CustDocument) => d.number,
  date: (d: CustDocument) => d.date,
  due: (d: CustDocument) => d.dueDate,
  status: (d: CustDocument) => STATUS_RANK[d.statusNorm],
  amount: (d: CustDocument) => d.total,
};

const OPP_TYPES: Record<string, string> = { tech_install: 'Tech Install', graphics: 'Graphics', rebrand: 'Rebrand', fleet_wrap: 'Fleet Wrap', other: 'Other' };
const OPP_STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STAGE_COLORS: Record<string, string> = { lead: '#60a5fa', quoted: '#a78bfa', negotiating: '#fbbf24', won: '#4ade80', lost: '#f87171' };
const STATUS_LABELS: Record<string, string> = { active: 'Prospect', nurturing: 'Nurturing', converted: 'Customer' };
const STATUS_COLORS: Record<string, string> = { active: '#4ade80', nurturing: '#60a5fa', converted: '#a78bfa' };
const ACTIVITY_ICONS: Record<string, string> = { call: '\u{1F4DE}', email: '\u{1F4E7}', note: '\u{1F4DD}', meeting: '\u{1F91D}', quote_sent: '\u{1F4CB}', status_change: '\u{1F504}' };
const DOCS_PAGE_SIZE = 100;

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const fmtK = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : fmtMoney(n));
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthShort = (ym: string) => MONTH_NAMES[Number(ym.slice(5, 7)) - 1] || ym;
const monthLabel = (ym: string) => `${monthShort(ym)} ${ym.slice(0, 4)}`;
const fmtDate = (d: string | null) => {
  if (!d) return '—';
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
  return String(d);
};
const timeAgo = (d: string) => {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days < 60 ? `${days}d ago` : fmtDate(d.slice(0, 10));
};

const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px 16px' };
const eyebrow: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: '8px' };
const btnSm: React.CSSProperties = { padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-secondary)', whiteSpace: 'nowrap', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '5px' };
const infoRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' };
const docTh: React.CSSProperties = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '7px 8px', borderBottom: '1px solid var(--border)' };
const cInput: React.CSSProperties = { width: '100%', padding: '7px 9px', borderRadius: '7px', fontSize: '11.5px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' };
const docTd: React.CSSProperties = { fontSize: '12.5px', color: 'var(--text-secondary)', padding: '7px 8px', borderBottom: '1px solid var(--border)', verticalAlign: 'middle' };

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={card}>
      <div style={{ ...eyebrow, marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{sub}</div>}
    </div>
  );
}

export default function CustomerRecordPage() {
  const router = useRouter();
  const params = useParams();
  const { user, profile, isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();
  const dialog = useDialog();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [prospect, setProspect] = useState<Prospect | null>(null);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [docs, setDocs] = useState<CustDocument[] | null>(null);
  const [docsHasMore, setDocsHasMore] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState<'all' | 'invoice' | 'salesOrder' | 'estimate'>('all');
  const [docStatus, setDocStatus] = useState<'all' | 'open' | 'pastdue' | 'paid'>('all');
  const [docSearch, setDocSearch] = useState('');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  // Statement data — this customer's open invoices with true open balances,
  // prefetched so the print click stays synchronous (popup blockers).
  const [stInvoices, setStInvoices] = useState<OpenArInvoice[] | null>(null);
  const [stError, setStError] = useState<string | null>(null);

  // Payments received + credit memos (financials RESTlet — the SuiteQL role
  // can't see CustPymt). success:false carries the redeploy/config hint.
  interface PaymentRow { id: string; tranid: string; date: string | null; type: 'payment' | 'credit'; amount: number; memo: string | null }
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);
  const [paymentsNote, setPaymentsNote] = useState<string | null>(null);

  // Terms / credit limit / 12-month invoiced series (NetSuite).
  interface ProfileData { terms: string | null; creditLimit: number | null; nsBalance: number | null; months: { month: string; total: number }[] }
  const [nsProfile, setNsProfile] = useState<ProfileData | null>(null);

  // Files attached to the record (R2 via /api/prospects/files).
  interface ProspectFile { id: string; file_name: string; content_type: string | null; size_bytes: number | null; public_url: string; created_at: string }
  const [files, setFiles] = useState<ProspectFile[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [emailingSt, setEmailingSt] = useState(false);

  // FleetSuite-side quotes & estimates for this customer.
  interface WrapQuoteRow { id: string; quote_number: string; vehicle_description: string | null; project_type: string | null; total: number | null; status: string; sent_at: string | null; created_at: string }
  interface EstimateRow { id: string; estimate_number: string; title: string | null; status: string; grand_total: number | null; created_at: string }
  const [wrapQuotes, setWrapQuotes] = useState<WrapQuoteRow[] | null>(null);
  const [estimatesList, setEstimatesList] = useState<EstimateRow[] | null>(null);

  // Contact add/edit — saved through /api/prospects/contacts, which also
  // pushes the change to NetSuite when the record is linked.
  const emptyContactForm = { name: '', title: '', email: '', phone: '', is_decision_maker: false };
  const [cFormOpen, setCFormOpen] = useState(false);
  const [cEditId, setCEditId] = useState<string | null>(null);
  const [cForm, setCForm] = useState(emptyContactForm);
  const [cSyncNs, setCSyncNs] = useState(true);
  const [cSaving, setCSaving] = useState(false);

  const openContactForm = (c?: Contact) => {
    setCEditId(c?.id || null);
    setCForm(c ? { name: c.name, title: c.title || '', email: c.email || '', phone: c.phone || '', is_decision_maker: c.is_decision_maker } : emptyContactForm);
    setCSyncNs(true);
    setCFormOpen(true);
  };

  const removeContact = async () => {
    if (!cEditId || cSaving) return;
    const target = contacts.find(c => c.id === cEditId);
    if (!target) return;
    const linked = !!target.netsuite_contact_id;
    const ok = await dialog.confirm(
      linked
        ? `Delete ${target.name}? This also deletes the contact in NetSuite — otherwise the next contact sync would bring it back.`
        : `Delete ${target.name}?`,
      { destructive: true, confirmLabel: 'Delete', title: 'Delete contact' },
    );
    if (!ok) return;
    setCSaving(true);
    try {
      const res = await fetch(`/api/prospects/contacts?id=${cEditId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setContacts(prev => prev.filter(c => c.id !== cEditId));
      setCFormOpen(false);
      setCEditId(null);
      setCForm(emptyContactForm);
    } catch (err: any) {
      await dialog.alert(`Could not delete the contact: ${err?.message || 'unknown error'}`);
    }
    setCSaving(false);
  };

  const saveContact = async () => {
    if (!prospect || !cForm.name.trim() || cSaving) return;
    setCSaving(true);
    try {
      const res = await fetch('/api/prospects/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId: prospect.id, contactId: cEditId || undefined, syncNetsuite: cSyncNs, ...cForm }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      const saved: Contact = body.contact;
      setContacts(prev => {
        const idx = prev.findIndex(c => c.id === saved.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
        return [saved, ...prev];
      });
      setCFormOpen(false);
      setCEditId(null);
      setCForm(emptyContactForm);
      if (body.netsuite?.error) {
        await dialog.alert(`Contact saved in the CRM, but the NetSuite update failed:\n\n${body.netsuite.error}`);
      }
    } catch (err: any) {
      await dialog.alert(`Could not save the contact: ${err?.message || 'unknown error'}`);
    }
    setCSaving(false);
  };

  // Quick activity log — same prospect_activities insert the CRM card does,
  // so touches logged here show up identically in the CRM list.
  const [actType, setActType] = useState<'call' | 'email' | 'note' | 'meeting'>('call');
  const [actText, setActText] = useState('');
  const [actSaving, setActSaving] = useState(false);

  const logActivity = async () => {
    const text = actText.trim();
    if (!text || !prospect || actSaving) return;
    setActSaving(true);
    const { data, error } = await supabase.from('prospect_activities').insert({
      prospect_id: prospect.id,
      type: actType,
      summary: text,
      created_by: user?.id,
    }).select().single();
    setActSaving(false);
    if (error || !data) {
      await dialog.alert(`Could not log the activity: ${error?.message || 'unknown error'}`);
      return;
    }
    setActivities(prev => [{ ...(data as Activity), creator_name: profile?.full_name || null }, ...prev]);
    setActText('');
  };

  const loadStarted = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    // Cold boot in a fresh tab: auth can briefly report "done" with a user
    // but no profile row (roles) yet — redirecting then bounces a legitimate
    // admin to /home. Wait for the profile; this effect re-runs when it lands.
    if (user && !profile) return;
    if (!hasFeature('prospects') && !isAdmin) { router.push('/home'); return; }
    if (loadStarted.current) return;
    loadStarted.current = true;
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when auth + profile resolve
  }, [authLoading, user, profile]);

  const load = async () => {
    const raw = String(params?.id || '');
    const nsMatch = raw.match(/^ns-(\d{1,15})$/);

    let p: Prospect | null = null;
    if (nsMatch) {
      const { data } = await supabase.from('prospects').select('*').eq('netsuite_id', nsMatch[1]).maybeSingle();
      p = data as Prospect | null;
    } else if (raw) {
      const { data } = await supabase.from('prospects').select('*').eq('id', raw).maybeSingle();
      p = data as Prospect | null;
    }

    const nsId = p?.netsuite_id || (nsMatch ? nsMatch[1] : null);
    let cust: CustomerRow | null = null;
    if (nsId) {
      const { data } = await supabase.from('customers')
        .select('netsuite_id, netsuite_url, company_name, entity_id, email, phone, address, total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date')
        .eq('netsuite_id', nsId).maybeSingle();
      cust = data as CustomerRow | null;
    }

    if (!p && !cust) { setNotFound(true); setLoading(false); return; }
    setProspect(p);
    setCustomer(cust);

    if (p) {
      const [cRes, oRes, aRes, tRes, rRes] = await Promise.all([
        supabase.from('prospect_contacts').select('id, name, title, email, phone, is_decision_maker, netsuite_contact_id').eq('prospect_id', p.id).order('is_decision_maker', { ascending: false }),
        supabase.from('prospect_opportunities').select('id, title, type, stage, value, expected_close_date, created_at').eq('prospect_id', p.id).order('created_at', { ascending: false }),
        supabase.from('prospect_activities').select('id, type, summary, created_by, created_at').eq('prospect_id', p.id).order('created_at', { ascending: false }).limit(20),
        supabase.from('prospect_tags').select('id, tag').eq('prospect_id', p.id),
        supabase.from('prospect_reminders').select('id, title, description, due_at').eq('prospect_id', p.id).is('completed_at', null).order('due_at'),
      ]);
      const acts = (aRes.data || []) as Activity[];
      const creatorIds = [...new Set(acts.map(a => a.created_by).filter(Boolean))] as string[];
      let names: Record<string, string> = {};
      if (creatorIds.length > 0) {
        const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', creatorIds);
        for (const pr of profs || []) names[pr.id] = pr.full_name;
      }
      setContacts((cRes.data || []) as Contact[]);
      setOpportunities((oRes.data || []) as Opportunity[]);
      setActivities(acts.map(a => ({ ...a, creator_name: a.created_by ? names[a.created_by] || null : null })));
      setTags((tRes.data || []) as Tag[]);
      setReminders((rRes.data || []) as Reminder[]);
    }

    setLoading(false);
    if (nsId) {
      loadDocs(nsId, false);
      loadStatement(nsId);
      loadPayments(nsId);
      loadNsProfile(nsId);
    }
    loadQuotesAndEstimates(p?.company_name || cust?.company_name || null, nsId);
    if (p) loadFiles(p.id);
  };

  const loadFiles = async (pid: string) => {
    try {
      const res = await fetch(`/api/prospects/files?prospectId=${pid}`);
      const body = await res.json();
      if (res.ok && body.success) setFiles(body.files || []);
    } catch { /* files card degrades to its loading state */ }
  };

  const uploadFile = async (f: File) => {
    if (!prospect || uploading) return;
    setUploading(true);
    try {
      const type = f.type || 'application/octet-stream';
      const post = (payload: any) => fetch('/api/prospects/files', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      const presign = await post({ action: 'presign', prospectId: prospect.id, fileName: f.name, contentType: type, size: f.size });
      if (!presign.success) throw new Error(presign.error || 'Could not start the upload');
      const put = await fetch(presign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': type }, body: f });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      const rec = await post({ action: 'record', prospectId: prospect.id, path: presign.path, fileName: f.name, contentType: type, size: f.size });
      if (!rec.success) throw new Error(rec.error || 'Failed to save the file record');
      setFiles(prev => [rec.file, ...(prev || [])]);
    } catch (err: any) {
      await dialog.alert(`Could not upload ${f.name}: ${err?.message || 'unknown error'}`);
    }
    setUploading(false);
  };

  const deleteFile = async (file: ProspectFile) => {
    if (!(await dialog.confirm(`Delete ${file.file_name}?`, { destructive: true, confirmLabel: 'Delete' }))) return;
    try {
      const res = await fetch(`/api/prospects/files?id=${file.id}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      setFiles(prev => (prev || []).filter(x => x.id !== file.id));
    } catch (err: any) {
      await dialog.alert(`Could not delete the file: ${err?.message || 'unknown error'}`);
    }
  };

  const emailStatement = async () => {
    const nsId = prospect?.netsuite_id || customer?.netsuite_id;
    if (!nsId || emailingSt) return;
    const prefill = (prospect?.billing_emails?.length ? prospect.billing_emails.join(', ') : '') || prospect?.email || customer?.email || '';
    const input = await dialog.prompt('Email this statement to (comma-separated):', prefill, { title: 'Email statement', confirmLabel: 'Send' });
    if (input === null) return;
    const recipients = input.split(',').map(s => s.trim()).filter(Boolean);
    if (recipients.length === 0) return;
    setEmailingSt(true);
    try {
      const res = await fetch('/api/netsuite/email-statement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId: nsId, recipients, scope: stScope, from: stFrom || undefined, to: stTo || undefined }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await dialog.alert(`Statement sent to ${body.sent.join(', ')} with ${body.attached} invoice PDF${body.attached === 1 ? '' : 's'} attached.${body.failedAttachments?.length ? `\n\nPDFs unavailable for: ${body.failedAttachments.join(', ')}` : ''}`);
      setStModalOpen(false);
    } catch (err: any) {
      await dialog.alert(`Could not send the statement: ${err?.message || 'unknown error'}`);
    }
    setEmailingSt(false);
  };

  const loadNsProfile = async (nsId: string) => {
    try {
      const res = await fetch(`/api/netsuite/customer-profile?customerId=${nsId}`);
      const body = await res.json();
      if (res.ok && body.success) setNsProfile(body);
    } catch { /* header facts are optional — the page stands without them */ }
  };

  const loadQuotesAndEstimates = async (companyName: string | null, nsId: string | null) => {
    if (companyName) {
      const { data } = await supabase.from('wrap_quotes')
        .select('id, quote_number, vehicle_description, project_type, total, status, sent_at, created_at')
        .is('archived_at', null).in('status', ['draft', 'sent'])
        .ilike('customer->>name', companyName)
        .order('created_at', { ascending: false }).limit(10);
      setWrapQuotes((data || []) as WrapQuoteRow[]);
    } else {
      setWrapQuotes([]);
    }
    // Estimates match precisely by NetSuite id, with a name fallback for
    // records created before the customer was linked. Two queries — .or()
    // can't safely carry free-text company names (commas break its syntax).
    const found = new Map<string, EstimateRow>();
    if (nsId) {
      const { data } = await supabase.from('estimates')
        .select('id, estimate_number, title, status, grand_total, created_at')
        .eq('customer_netsuite_id', nsId)
        .order('created_at', { ascending: false }).limit(6);
      for (const e of (data || []) as EstimateRow[]) found.set(e.id, e);
    }
    if (companyName) {
      const { data } = await supabase.from('estimates')
        .select('id, estimate_number, title, status, grand_total, created_at')
        .ilike('customer_name', companyName)
        .order('created_at', { ascending: false }).limit(6);
      for (const e of (data || []) as EstimateRow[]) found.set(e.id, e);
    }
    setEstimatesList([...found.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6));
  };

  const loadPayments = async (nsId: string) => {
    try {
      const res = await fetch(`/api/netsuite/customer-payments?customerId=${nsId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      if (!body.success) { setPaymentsNote(body.error || 'Payment history unavailable'); return; }
      setPayments(body.transactions || []);
    } catch (err: any) {
      setPaymentsNote(err?.message || 'Payment history unavailable');
    }
  };

  const loadStatement = async (nsId: string) => {
    try {
      const res = await fetch(`/api/netsuite/customer-statement?customerId=${nsId}`);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || 'Failed to load open invoices');
      setStInvoices(body.invoices || []);
    } catch (err: any) {
      setStError(err?.message || 'Failed to load open invoices');
    }
  };

  // Same endpoint + paging the CRM card uses for its Documents section.
  const loadDocs = async (nsId: string, append: boolean) => {
    if (docsLoading) return;
    setDocsLoading(true);
    setDocsError(null);
    try {
      const offset = append ? (docs?.length || 0) : 0;
      const res = await fetch(`/api/netsuite/customer-invoices?customerId=${nsId}&limit=${DOCS_PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const typeMap: Record<string, { type: CustDocument['type']; label: string }> = {
        CustInvc: { type: 'invoice', label: 'Invoice' },
        SalesOrd: { type: 'salesOrder', label: 'Sales Order' },
        Estimate: { type: 'estimate', label: 'Estimate' },
      };
      const page: CustDocument[] = (data.transactions || []).map((t: any) => {
        const info = typeMap[t.type] || { type: 'invoice' as const, label: t.type };
        const dueDate = toIso(t.duedate);
        const status = t.status || '';
        const days = docDaysPastDue(dueDate);
        const statusNorm: CustDocument['statusNorm'] =
          info.type !== 'invoice' ? 'other'
          : /paid/i.test(status) ? 'paid'
          : /open/i.test(status) ? (days > 0 ? 'pastdue' : 'open')
          : 'other';
        return {
          id: String(t.id),
          number: t.tranid || String(t.id),
          date: toIso(t.trandate),
          dueDate,
          status,
          statusNorm,
          daysPastDue: statusNorm === 'pastdue' ? days : 0,
          total: Number(t.total) || 0,
          type: info.type,
          typeLabel: info.label,
        };
      });
      setDocs(prev => (append ? [...(prev || []), ...page] : page));
      setDocsHasMore(!!data.hasMore);
    } catch (err: any) {
      setDocsError(err?.message || 'Failed to load NetSuite documents');
    }
    setDocsLoading(false);
  };

  const viewPdf = async (doc: CustDocument) => {
    setPdfBusy(doc.id);
    const res = await openNetSuitePdf(doc.type, doc.id);
    setPdfBusy(null);
    if (!res.ok) await dialog.alert(res.error || 'Could not open the PDF');
  };

  // Company letterhead for statement documents — fetched on load so the
  // PDF/print click stays synchronous (popup blockers).
  const [letterhead, setLetterhead] = useState<CompanyLetterhead | null>(null);
  useEffect(() => { fetchCompanyLetterhead().then(setLetterhead); }, []);

  // ── Statement options (scope + date range → PDF / print / email) ────────
  const [stModalOpen, setStModalOpen] = useState(false);
  const [stScope, setStScope] = useState<StatementScope>('open');
  const [stFrom, setStFrom] = useState('');
  const [stTo, setStTo] = useState('');
  const [stWorking, setStWorking] = useState(false);

  const fetchStatementData = async (): Promise<StatementInvoice[]> => {
    const nsId = prospect?.netsuite_id || customer?.netsuite_id;
    if (!nsId) throw new Error('Not linked to a NetSuite customer');
    // Default options match the prefetched open-item data — using it keeps
    // the window.open inside the click gesture (popup blockers).
    if (stScope === 'open' && !stFrom && !stTo && stInvoices) {
      return stInvoices.map(i => ({ ...i, status: 'open' as const }));
    }
    const qs = new URLSearchParams({ customerId: nsId, scope: stScope });
    if (stFrom) qs.set('from', stFrom);
    if (stTo) qs.set('to', stTo);
    const res = await fetch(`/api/netsuite/customer-statement?${qs.toString()}`);
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
    return body.invoices || [];
  };

  const generateStatement = async (kind: 'pdf' | 'print') => {
    if (stWorking) return;
    setStWorking(true);
    try {
      const invoices = await fetchStatementData();
      if (invoices.length === 0) {
        await dialog.alert(stScope === 'open' ? 'No open invoices — nothing to put on a statement.' : 'No invoices in that date range.');
      } else {
        exportStatementPDF({
          customer: prospect?.company_name || customer?.company_name || 'Unknown',
          invoices,
          scope: stScope,
          from: stFrom || null,
          to: stTo || null,
          letterhead,
        }, { print: kind === 'print' });
        setStModalOpen(false);
      }
    } catch (err: any) {
      await dialog.alert(`Could not build the statement: ${err?.message || 'unknown error'}`);
    }
    setStWorking(false);
  };

  // Documents: filter chips + search narrow the loaded set; headers sort it.
  const filteredDocs = useMemo(() => {
    let list = docs || [];
    if (docFilter !== 'all') list = list.filter(d => d.type === docFilter);
    if (docStatus !== 'all') list = list.filter(d => d.statusNorm === docStatus);
    const q = docSearch.trim().toLowerCase();
    if (q) list = list.filter(d => d.number.toLowerCase().includes(q) || d.status.toLowerCase().includes(q));
    return list;
  }, [docs, docFilter, docStatus, docSearch]);
  const { sorted: sortedDocs, sort: docSort, toggle: toggleDocSort } = useTableSort(filteredDocs, DOC_SORT_COLS, { key: 'date', dir: 'desc' });
  const openBalance = stInvoices ? stInvoices.reduce((s, i) => s + i.unpaid, 0) : null;

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '60px 0' }}>
        <div style={{ width: '32px', height: '32px', border: '3px solid var(--border)', borderTopColor: 'var(--navy)', borderRadius: '50%', margin: '0 auto', animation: 'spin 1s linear infinite' }} />
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>Loading customer record…</div>
      </div>
    );
  }

  if (notFound) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: '40px 16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-secondary)' }}>Customer not found</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>No CRM record or synced NetSuite customer matches this link.</div>
        <button onClick={() => router.push('/admin/prospects')} style={{ ...btnSm, marginTop: '14px' }}>‹ Back to CRM</button>
      </div>
    );
  }

  const name = prospect?.company_name || customer?.company_name || 'Unknown';
  const email = prospect?.email || customer?.email || null;
  const phone = prospect?.phone || customer?.phone || null;
  const address = prospect
    ? [prospect.address, [prospect.city, prospect.state].filter(Boolean).join(', '), prospect.zip].filter(Boolean).join(' · ')
    : customer?.address || null;
  const nsUrl = prospect?.netsuite_url || customer?.netsuite_url || null;
  const m = customer;
  const openDeals = opportunities.filter(o => !['won', 'lost'].includes(o.stage));
  const closedDeals = opportunities.filter(o => ['won', 'lost'].includes(o.stage));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>

      {/* Header */}
      <div style={card}>
        <button onClick={() => router.push('/admin/prospects')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: 0, marginBottom: '8px' }}>‹ CRM</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>{name}</div>
          {prospect ? (
            <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: `${STATUS_COLORS[prospect.status] || '#60a5fa'}1f`, color: STATUS_COLORS[prospect.status] || '#60a5fa' }}>
              {STATUS_LABELS[prospect.status] || prospect.status}
            </span>
          ) : (
            <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'var(--warning-bg)', color: 'var(--warning)' }}>Not in CRM</span>
          )}
          {prospect?.is_hot && <span style={{ fontSize: '11px' }}>🔥</span>}
          {tags.map(t => (
            <span key={t.id} style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{t.tag}</span>
          ))}
        </div>
        {(prospect?.contact_name || customer?.entity_id) && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {prospect?.contact_name}{prospect?.contact_name && customer?.entity_id ? ' · ' : ''}{customer?.entity_id ? `NetSuite ${customer.entity_id}` : ''}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          {phone && <a href={`tel:${phone}`} style={{ ...btnSm, color: '#22c55e' }}>📞 {phone}</a>}
          {email && <a href={`mailto:${email}`} style={{ ...btnSm, color: '#60a5fa' }}>✉️ Email</a>}
          {prospect && (
            <button onClick={() => router.push(`/admin/prospects?id=${prospect.id}`)} title="Open this record in the CRM list to edit it" style={btnSm}>
              Edit in CRM
            </button>
          )}
          {!prospect && (
            <button onClick={() => router.push(`/admin/prospects?q=${encodeURIComponent(name)}`)} title="This customer is synced from NetSuite but has no CRM record yet" style={btnSm}>
              Find in CRM
            </button>
          )}
          {(prospect?.netsuite_id || customer) && !stError && (
            <button onClick={() => setStModalOpen(true)}
              title="Open, print, or email a statement — choose open items or all invoices, with an optional date range"
              style={{ ...btnSm, color: 'var(--text-primary)' }}>
              📄 Statement
            </button>
          )}
          {nsUrl && <a href={nsUrl} target="_blank" rel="noopener noreferrer" style={btnSm}>NetSuite ↗</a>}
        </div>
      </div>

      {/* Spend KPIs (NetSuite) */}
      {m ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
          <Kpi label="YTD spend" value={fmtMoney(m.ytd_spend || 0)} sub={`${m.ytd_orders || 0} orders this year`} />
          <Kpi label="Total spend" value={fmtMoney(m.total_spend || 0)} sub={`${m.total_orders || 0} orders all time`} />
          <Kpi label="Avg order" value={fmtMoney(m.avg_order_value || 0)} sub={m.last_year_spend ? `${fmtMoney(m.last_year_spend)} last year` : undefined} />
          <Kpi label="Last order" value={fmtDate(m.last_order_date)} />
        </div>
      ) : (
        <div style={{ ...card, fontSize: '12px', color: 'var(--text-muted)' }}>
          No NetSuite spend history — {prospect ? 'this record isn’t linked to a NetSuite customer yet.' : 'customer not synced.'}
        </div>
      )}

      {/* A/R aging + credit terms */}
      {stInvoices && stInvoices.length > 0 && (() => {
        const buckets: Record<AgingBucketKey, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
        for (const i of stInvoices) buckets[i.bucket as AgingBucketKey] += i.unpaid;
        const total = stInvoices.reduce((s, i) => s + i.unpaid, 0);
        const limit = nsProfile?.creditLimit || null;
        const used = limit && limit > 0 ? total / limit : null;
        return (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ ...eyebrow, marginBottom: 0 }}>Accounts receivable — aging</div>
              <span style={{ flex: 1 }} />
              {nsProfile?.terms && <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>Terms <strong style={{ color: 'var(--text-primary)' }}>{nsProfile.terms}</strong></span>}
              {limit && (
                <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  Credit limit <strong style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(limit)}</strong>
                  {used !== null && (
                    <strong style={{ marginLeft: '5px', color: used > 1 ? 'var(--error)' : used > 0.8 ? 'var(--warning)' : 'var(--success)' }}>
                      {Math.round(used * 100)}% used
                    </strong>
                  )}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '2px', height: '18px', borderRadius: '6px', overflow: 'hidden', margin: '10px 0 10px' }}>
              {AGE_META.filter(b => buckets[b.key] > 0.005).map(b => (
                <div key={b.key} title={`${b.label} · ${usd2(buckets[b.key])}`} style={{ flex: buckets[b.key], minWidth: '4px', background: b.color }} />
              ))}
            </div>
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
              {AGE_META.map(b => (
                <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: buckets[b.key] > 0.005 ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: b.color, opacity: buckets[b.key] > 0.005 ? 1 : 0.35 }} />
                  {b.shortLabel}
                  <strong style={{ fontVariantNumeric: 'tabular-nums', color: buckets[b.key] > 0.005 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{usd2(buckets[b.key])}</strong>
                </span>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Invoiced — last 12 months */}
      {nsProfile && nsProfile.months.some(mm => mm.total > 0) && (() => {
        const months = nsProfile.months;
        const peak = Math.max(...months.map(mm => mm.total));
        const peakIdx = months.findIndex(mm => mm.total === peak);
        const yearTotal = months.reduce((s, mm) => s + mm.total, 0);
        return (
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <div style={{ ...eyebrow, marginBottom: 0 }}>Invoiced — last 12 months</div>
              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(yearTotal)} total</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '88px', marginTop: '10px' }}>
              {months.map((mm, i) => (
                <div key={mm.month} title={`${monthLabel(mm.month)} · ${usd2(mm.total)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', minWidth: 0 }}>
                  {i === peakIdx && peak > 0 && (
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-secondary)', textAlign: 'center', marginBottom: '2px', whiteSpace: 'nowrap' }}>{fmtK(peak)}</div>
                  )}
                  <div style={{ height: `${mm.total > 0 ? Math.max(3, Math.round((mm.total / peak) * 66)) : 1}px`, background: mm.total > 0 ? '#60a5fa' : 'var(--progress-track)', borderRadius: '3px 3px 0 0' }} />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '3px', marginTop: '4px' }}>
              {months.map(mm => (
                <div key={mm.month} style={{ flex: 1, textAlign: 'center', fontSize: '8.5px', fontWeight: 700, color: 'var(--text-muted)', overflow: 'hidden' }}>{monthShort(mm.month)}</div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Two-column detail */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '14px' }} className="rec-cols">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={card}>
            <div style={eyebrow}>Company info</div>
            {[
              { l: 'Email', v: email },
              { l: 'Phone', v: phone },
              { l: 'Address', v: address },
              { l: 'Website', v: prospect?.website || null },
              { l: 'Lead source', v: prospect ? (prospect.lead_source === 'Other' ? prospect.lead_source_other || 'Other' : prospect.lead_source) : null },
              { l: 'Locations', v: prospect && prospect.location_count > 1 ? String(prospect.location_count) : null },
            ].filter(r => r.v).map(r => (
              <div key={r.l} style={infoRow}>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{r.l}</span>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere' }}>{r.v}</span>
              </div>
            ))}
            {prospect?.notes && (
              <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: '9px', background: 'var(--subtle-bg)', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{prospect.notes}</div>
            )}
            {!email && !phone && !address && !prospect?.notes && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing on file.</div>}
          </div>

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ ...eyebrow, marginBottom: 0 }}>Contacts {contacts.length > 0 && <span style={{ fontWeight: 600 }}>· {contacts.length}</span>}</div>
              {prospect && (
                <button onClick={() => (cFormOpen && !cEditId ? setCFormOpen(false) : openContactForm())} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: 0 }}>
                  {cFormOpen && !cEditId ? 'Cancel' : '+ Add'}
                </button>
              )}
            </div>
            {cFormOpen && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', margin: '10px 0 4px', padding: '10px', background: 'var(--subtle-bg)', borderRadius: '9px' }}>
                <input style={cInput} placeholder="Name (First Last) *" value={cForm.name} onChange={e => setCForm({ ...cForm, name: e.target.value })} />
                <input style={cInput} placeholder="Title" value={cForm.title} onChange={e => setCForm({ ...cForm, title: e.target.value })} />
                <input style={cInput} type="email" placeholder="Email" value={cForm.email} onChange={e => setCForm({ ...cForm, email: e.target.value })} />
                <input style={cInput} placeholder="Phone" value={cForm.phone} onChange={e => setCForm({ ...cForm, phone: e.target.value })} />
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
                  <input type="checkbox" checked={cForm.is_decision_maker} onChange={e => setCForm({ ...cForm, is_decision_maker: e.target.checked })} />
                  Key decision maker
                </label>
                {prospect?.netsuite_id && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
                    <input type="checkbox" checked={cSyncNs} onChange={e => setCSyncNs(e.target.checked)} />
                    Also {cEditId ? 'update' : 'create'} the contact in NetSuite
                  </label>
                )}
                <div style={{ display: 'flex', gap: '6px', gridColumn: '1 / -1' }}>
                  <button onClick={saveContact} disabled={cSaving || !cForm.name.trim()} style={{
                    flex: 1, padding: '8px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 700,
                    background: cForm.name.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none',
                    cursor: cForm.name.trim() ? 'pointer' : 'default', opacity: cSaving ? 0.6 : 1,
                  }}>{cSaving ? 'Saving…' : cEditId ? 'Save changes' : 'Add contact'}</button>
                  {cEditId && (
                    <button onClick={removeContact} disabled={cSaving} title="Delete this contact" style={{
                      padding: '8px 14px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 700,
                      background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)',
                      cursor: 'pointer', opacity: cSaving ? 0.6 : 1,
                    }}>Delete</button>
                  )}
                  {cEditId && (
                    <button onClick={() => { setCFormOpen(false); setCEditId(null); }} style={{ ...btnSm, padding: '8px 14px' }}>Cancel</button>
                  )}
                </div>
              </div>
            )}
            {contacts.length === 0 && !cFormOpen && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>{prospect ? 'No contacts yet.' : '—'}</div>}
            {contacts.map(c => (
              <div key={c.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', marginTop: contacts.indexOf(c) === 0 ? '8px' : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {c.name}
                    {c.is_decision_maker && <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#f59e0b', marginLeft: '6px' }}>DM</span>}
                    {c.title && <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '6px' }}>{c.title}</span>}
                  </span>
                  {prospect && (
                    <button onClick={() => openContactForm(c)} title={`Edit ${c.name}${c.netsuite_contact_id ? ' (linked to NetSuite)' : ''}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px', flexShrink: 0 }}>✎</button>
                  )}
                </div>
                {(c.phone || c.email) && (
                  <div style={{ display: 'flex', gap: '14px', marginTop: '3px', fontSize: '12px' }}>
                    {c.phone && <a href={`tel:${c.phone}`} style={{ color: '#22c55e', textDecoration: 'none', fontWeight: 600 }}>{c.phone}</a>}
                    {c.email && <a href={`mailto:${c.email}`} style={{ color: '#60a5fa', textDecoration: 'none' }}>{c.email}</a>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {prospect && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ ...eyebrow, marginBottom: 0 }}>Files {files && files.length > 0 && <span style={{ fontWeight: 600 }}>· {files.length}</span>}</div>
                <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: 0, opacity: uploading ? 0.6 : 1 }}>
                  {uploading ? 'Uploading…' : '+ Upload'}
                </button>
                <input ref={fileInputRef} type="file" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }} />
              </div>
              {files === null && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>Loading files…</div>}
              {files && files.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>No files yet — quotes, signed approvals, COIs…</div>}
              {(files || []).map(f => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px', marginTop: '4px' }}>
                  <a href={f.public_url} target="_blank" rel="noopener noreferrer" style={{ flex: 1, minWidth: 0, fontWeight: 600, color: '#60a5fa', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.file_name}
                  </a>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px', flexShrink: 0 }}>
                    {f.size_bytes ? (f.size_bytes >= 1048576 ? `${(f.size_bytes / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size_bytes / 1024))}KB`) : ''} · {fmtDate(f.created_at.slice(0, 10))}
                  </span>
                  <button onClick={() => deleteFile(f)} title="Delete file" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px', flexShrink: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={card}>
            <div style={eyebrow}>Deals {openDeals.length > 0 && <span style={{ fontWeight: 600 }}>· {openDeals.length} open</span>}</div>
            {opportunities.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{prospect ? 'No deals yet.' : '—'}</div>}
            {[...openDeals, ...closedDeals].map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.title}
                  <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · {OPP_TYPES[o.type] || o.type}</span>
                </span>
                <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '999px', flexShrink: 0, background: `${STAGE_COLORS[o.stage] || '#60a5fa'}1f`, color: STAGE_COLORS[o.stage] || '#60a5fa' }}>{OPP_STAGES[o.stage] || o.stage}</span>
                <span style={{ fontSize: '12.5px', fontWeight: 800, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{o.value ? fmtMoney(o.value) : '—'}</span>
              </div>
            ))}
          </div>

          {((wrapQuotes?.length || 0) > 0 || (estimatesList?.length || 0) > 0) && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ ...eyebrow, marginBottom: 0 }}>Quotes &amp; estimates</div>
                <span style={{ display: 'flex', gap: '10px' }}>
                  {(wrapQuotes?.length || 0) > 0 && <button onClick={() => router.push('/admin/wrap-quote')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '10.5px', fontWeight: 700, color: '#60a5fa', padding: 0 }}>Wrap quotes ›</button>}
                  {(estimatesList?.length || 0) > 0 && <button onClick={() => router.push('/estimates')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '10.5px', fontWeight: 700, color: '#60a5fa', padding: 0 }}>Estimates ›</button>}
                </span>
              </div>
              {(wrapQuotes || []).map(q => (
                <div key={q.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px', marginTop: '4px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', flexShrink: 0, width: '48px', textAlign: 'center', background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>QUOTE</span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{q.quote_number}</span>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.vehicle_description || q.project_type || ''}</span>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: q.status === 'sent' ? '#60a5fa' : 'var(--text-muted)', flexShrink: 0 }}>{q.status === 'sent' ? 'Sent' : 'Draft'}</span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{q.total ? usd2(q.total) : '—'}</span>
                </div>
              ))}
              {(estimatesList || []).map(e => (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px', marginTop: '4px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', flexShrink: 0, width: '48px', textAlign: 'center', background: 'var(--subtle-bg)', color: 'var(--text-muted)' }}>EST</span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{e.estimate_number}</span>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.title || ''}</span>
                  <span style={{ fontSize: '10px', fontWeight: 700, flexShrink: 0, color: e.status === 'accepted' ? 'var(--success)' : e.status === 'rejected' ? 'var(--error)' : e.status === 'sent' ? '#60a5fa' : e.status === 'pushed' ? '#a78bfa' : 'var(--text-muted)' }}>
                    {e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                  </span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{e.grand_total ? usd2(e.grand_total) : '—'}</span>
                </div>
              ))}
            </div>
          )}

          {(prospect?.netsuite_id || customer) && (
            <div style={card}>
              <div style={eyebrow}>Payments &amp; credits</div>
              {paymentsNote && (
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {/restlet/i.test(paymentsNote)
                    ? <><span style={{ color: 'var(--warning)', fontWeight: 700 }}>Needs the updated NetSuite RESTlet.</span> {paymentsNote}</>
                    : paymentsNote}
                </div>
              )}
              {!payments && !paymentsNote && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading payment history…</div>}
              {payments && payments.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No payments or credits on file.</div>}
              {(payments || []).map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
                  <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', flexShrink: 0, width: '58px', textAlign: 'center', background: p.type === 'credit' ? 'rgba(167,139,250,0.12)' : 'var(--success-bg)', color: p.type === 'credit' ? '#a78bfa' : 'var(--success)' }}>
                    {p.type === 'credit' ? 'CREDIT' : 'PAYMENT'}
                  </span>
                  <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{p.tranid}</span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{fmtDate(p.date)}</span>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.memo || ''}</span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{usd2(p.amount)}</span>
                </div>
              ))}
            </div>
          )}

          {reminders.length > 0 && (
            <div style={card}>
              <div style={eyebrow}>Reminders · {reminders.length}</div>
              {reminders.map(r => (
                <div key={r.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
                  <span style={{ fontWeight: 700, color: new Date(r.due_at) < new Date() ? 'var(--error)' : 'var(--text-primary)' }}>{fmtDate(r.due_at.slice(0, 10))}</span>
                  <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>{r.title}</span>
                </div>
              ))}
            </div>
          )}

          <div style={card}>
            <div style={eyebrow}>Recent activity</div>
            {prospect && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                  {([['call', '📞 Call'], ['email', '✉️ Email'], ['note', '📝 Note'], ['meeting', '🤝 Meeting']] as const).map(([k, label]) => (
                    <button key={k} onClick={() => setActType(k)} style={{
                      padding: '4px 10px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                      background: actType === k ? 'var(--tab-active-bg)' : 'transparent',
                      border: `1px solid ${actType === k ? 'var(--tab-active-border)' : 'var(--border)'}`,
                      color: actType === k ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}>{label}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    value={actText}
                    onChange={e => setActText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); logActivity(); } }}
                    placeholder={actType === 'call' ? 'What was said on the call…' : actType === 'email' ? 'What the email covered…' : actType === 'meeting' ? 'What the meeting covered…' : 'Add a note…'}
                    style={{ flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  />
                  <button onClick={logActivity} disabled={actSaving || !actText.trim()} style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap',
                    background: actText.trim() ? 'var(--tab-active-bg)' : 'var(--subtle-bg)',
                    border: '1px solid var(--border)', color: actText.trim() ? 'var(--text-primary)' : 'var(--text-muted)',
                    cursor: actText.trim() ? 'pointer' : 'default', opacity: actSaving ? 0.6 : 1,
                  }}>{actSaving ? 'Logging…' : 'Log'}</button>
                </div>
              </div>
            )}
            {activities.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{prospect ? 'No activity logged yet.' : '—'}</div>}
            {activities.map(a => (
              <div key={a.id} style={{ display: 'flex', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                <span style={{ flexShrink: 0 }}>{ACTIVITY_ICONS[a.type] || '📝'}</span>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)' }}>{a.summary}</span>
                <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontSize: '11px', textAlign: 'right' }}>
                  {a.creator_name ? `${a.creator_name} · ` : ''}{timeAgo(a.created_at)}
                </span>
              </div>
            ))}
            {prospect && activities.length > 0 && (
              <button onClick={() => router.push(`/admin/prospects?id=${prospect.id}`)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: '8px 0 0' }}>
                Full history &amp; log activity in CRM →
              </button>
            )}
          </div>
        </div>
      </div>

      {/* NetSuite documents */}
      {(prospect?.netsuite_id || customer) && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ ...eyebrow, marginBottom: 0 }}>NetSuite documents {docs ? `· ${docs.length}${docsHasMore ? '+' : ''}` : ''}</div>
            {openBalance !== null && stInvoices && stInvoices.length > 0 && (
              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                · open balance <strong style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{usd2(openBalance)}</strong> ({stInvoices.length} invoice{stInvoices.length === 1 ? '' : 's'})
              </span>
            )}
            <span style={{ flex: 1 }} />
            {(['all', 'invoice', 'salesOrder', 'estimate'] as const).map(f => (
              <button key={f} onClick={() => setDocFilter(f)} style={{
                padding: '4px 10px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: docFilter === f ? 'var(--tab-active-bg)' : 'transparent',
                border: `1px solid ${docFilter === f ? 'var(--tab-active-border)' : 'var(--border)'}`,
                color: docFilter === f ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{f === 'all' ? 'All' : f === 'invoice' ? 'Invoices' : f === 'salesOrder' ? 'Sales Orders' : 'Estimates'}</button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
            {([['all', 'Any status', 'var(--text-muted)'], ['open', 'Open', '#60a5fa'], ['pastdue', 'Past due', 'var(--error)'], ['paid', 'Paid', 'var(--success)']] as const).map(([k, label, color]) => (
              <button key={k} onClick={() => setDocStatus(k)} style={{
                padding: '4px 10px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: docStatus === k ? 'var(--tab-active-bg)' : 'transparent',
                border: `1px solid ${docStatus === k ? color : 'var(--border)'}`,
                color: docStatus === k ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{label}</button>
            ))}
            <input
              value={docSearch}
              onChange={e => setDocSearch(e.target.value)}
              placeholder="Search number…"
              style={{ flex: '1 1 140px', minWidth: '120px', padding: '6px 10px', borderRadius: '8px', fontSize: '11.5px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
            />
          </div>
          {docsError && <div style={{ fontSize: '12px', color: 'var(--error)', padding: '8px 0' }}>{docsError}</div>}
          {!docs && !docsError && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading documents…</div>}
          {docs && sortedDocs.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No documents match.</div>}
          {sortedDocs.length > 0 && (
            <div className="responsive-table">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortableTh label="Type" sortKey="type" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                    <SortableTh label="Number" sortKey="number" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                    <SortableTh label="Date" sortKey="date" sort={docSort} onToggle={toggleDocSort} defaultDir="desc" style={docTh} />
                    <SortableTh label="Due" sortKey="due" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                    <SortableTh label="Status" sortKey="status" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                    <SortableTh label="Amount" sortKey="amount" sort={docSort} onToggle={toggleDocSort} defaultDir="desc" align="right" style={docTh} />
                    <th style={docTh} />
                  </tr>
                </thead>
                <tbody>
                  {sortedDocs.map(doc => (
                    <tr key={`${doc.type}-${doc.id}`}>
                      <td style={docTd}>
                        <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', display: 'inline-block', minWidth: '76px', textAlign: 'center', background: 'var(--subtle-bg)', color: 'var(--text-muted)' }}>{doc.typeLabel}</span>
                      </td>
                      <td style={{ ...docTd, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{doc.number}</td>
                      <td style={{ ...docTd, whiteSpace: 'nowrap' }}>{fmtDate(doc.date)}</td>
                      <td style={{ ...docTd, whiteSpace: 'nowrap' }}>{fmtDate(doc.dueDate)}</td>
                      <td style={docTd}>
                        {doc.statusNorm === 'pastdue' ? (
                          <span style={{ fontSize: '10.5px', fontWeight: 800, color: 'var(--error)', whiteSpace: 'nowrap' }}>{doc.daysPastDue}d past due</span>
                        ) : doc.statusNorm === 'open' ? (
                          <span style={{ fontSize: '10.5px', fontWeight: 800, color: '#60a5fa' }}>Open</span>
                        ) : doc.statusNorm === 'paid' ? (
                          <span style={{ fontSize: '10.5px', fontWeight: 800, color: 'var(--success)' }}>Paid</span>
                        ) : (
                          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{doc.status || '—'}</span>
                        )}
                      </td>
                      <td style={{ ...docTd, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usd2(doc.total)}</td>
                      <td style={{ ...docTd, textAlign: 'right' }}>
                        <button onClick={() => viewPdf(doc)} disabled={pdfBusy === doc.id} style={{ ...btnSm, padding: '4px 10px', opacity: pdfBusy === doc.id ? 0.6 : 1 }}>
                          {pdfBusy === doc.id ? '…' : 'PDF'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {docs && docsHasMore && (
            <button onClick={() => { const ns = prospect?.netsuite_id || customer?.netsuite_id; if (ns) loadDocs(ns, true); }} disabled={docsLoading} style={{ ...btnSm, marginTop: '10px' }}>
              {docsLoading ? 'Loading…' : 'Load more history'}
            </button>
          )}
        </div>
      )}

      {/* Statement options */}
      {stModalOpen && (
        <div onClick={() => !stWorking && !emailingSt && setStModalOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Statement options"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', width: 'min(440px, 100%)' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>Statement</div>
            <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>Include</div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              {([['open', 'Open invoices only'], ['all', 'All invoices']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setStScope(k)} style={{
                  flex: 1, padding: '7px 10px', borderRadius: '8px', fontSize: '11.5px', fontWeight: 700, cursor: 'pointer',
                  background: stScope === k ? 'var(--tab-active-bg)' : 'transparent',
                  border: `1px solid ${stScope === k ? 'var(--tab-active-border)' : 'var(--border)'}`,
                  color: stScope === k ? 'var(--text-primary)' : 'var(--text-muted)',
                }}>{label}</button>
              ))}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
              {stScope === 'open'
                ? 'The classic remittance statement — everything the customer currently owes.'
                : 'Activity statement — every invoice in the range, paid ones shown with a $0 balance.'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>From (optional)</div>
                <input type="date" value={stFrom} onChange={e => setStFrom(e.target.value)} style={cInput} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>To (optional)</div>
                <input type="date" value={stTo} onChange={e => setStTo(e.target.value)} style={cInput} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => generateStatement('pdf')} disabled={stWorking || emailingSt} style={{
                flex: 1, padding: '9px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap',
                background: 'var(--tab-active-bg)', border: '1px solid var(--tab-active-border)', color: 'var(--text-primary)',
                cursor: 'pointer', opacity: stWorking ? 0.6 : 1,
              }}>{stWorking ? 'Building…' : 'Open PDF'}</button>
              <button onClick={() => generateStatement('print')} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>🖨 Print</button>
              <button onClick={emailStatement} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>
                {emailingSt ? 'Sending…' : '✉️ Email…'}
              </button>
              <button onClick={() => setStModalOpen(false)} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <style>{`@media (max-width:760px){ .rec-cols{ grid-template-columns:1fr !important; } }`}</style>
    </div>
  );
}
