'use client';

/**
 * The Customer Record — one customer on its own page, and the primary
 * surface for working a customer: identity, NetSuite spend metrics,
 * contacts, deals, reminders, activity, files, and ONE Transactions ledger
 * (NetSuite documents + FleetSuite quotes/estimates + payments and credits,
 * with both PDFs on every row). Everything is editable here — field edits,
 * tags, deals, reminders, voice notes, delete — so nothing requires a
 * round-trip to the CRM list (which is just the index/pipeline view).
 *
 * Prospects and customers are unified, with a lead tier (owner decision
 * 2026-08-30): a record with no netsuite_id IS a lead. Creating a record
 * normally creates the NetSuite customer too (2026-09-02 — the create
 * form's ticked-by-default box), so a lead here is one that was created
 * with that box unticked, or whose NetSuite create failed. Promotion
 * happens here (the "Promote to NetSuite Customer" button) or
 * automatically the first time an estimate for the lead is pushed to
 * NetSuite / converted to an SO.
 *
 * Routes:
 *   /admin/prospects/<uuid>       — CRM prospect id
 *   /admin/prospects/ns-<id>      — NetSuite customer internal id (dashboard
 *                                   links, which only know the NetSuite id).
 *                                   Falls back to the synced customers row
 *                                   when the customer isn't in the CRM;
 *                                   "+ Add to CRM" creates the missing row.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import JSZip from 'jszip';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';
import DropboxProofSearch from '@/components/DropboxProofSearch';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import PhoneInput from '@/components/PhoneInput';
import { exportProspectPDF } from '@/lib/prospect-pdf';
import { deepLinks } from '@/lib/deep-links';
import { LEAD_SOURCES, OPP_TYPES } from '@/lib/lead-sources';
import { SortableTh, useTableSort } from '@/components/ui/SortableTh';
import { usd2 } from '@/lib/financials-print';
import { exportStatementPDF } from '@/lib/statement-pdf';
import { fetchCompanyLetterhead, type CompanyLetterhead } from '@/lib/company-profile';
import { AGE_META } from '@/components/FinancialsDrilldown';
import type { OpenArInvoice, AgingBucketKey, StatementInvoice, StatementScope } from '@/lib/financials-data';
import { fetchAllRows } from '@/lib/fetch-all';
import { samePerson } from '@/lib/primary-contact';
import NumberInput from '@/components/NumberInput';

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
  status: string;
  location_count: number;
  lead_source: string | null;
  lead_source_other: string | null;
  is_hot: boolean;
  multi_location: boolean;
  email_campaign: boolean;
  netsuite_id: string | null;
  netsuite_url: string | null;
  converted_customer_id: string | null;
  created_by: string | null;
  created_at: string;
  billing_emails: string[] | null;
}

interface CustomerRow {
  id: string;
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
  // K1–K3 (Aug 6 plan): parent linkage, sales rep, billing workflow.
  netsuite_parent_id: string | null;
  parent_customer_id: string | null;
  parent_source: string | null;
  account_owner_id: string | null;
  billing_workflow: string | null;
  billing_portal: string | null;
  billing_notes: string | null;
  internal_notes: string | null;
}

interface ParentRef { id: string; netsuite_id: string | null; company_name: string | null; source: 'manual' | 'netsuite' }
interface ChildAccount { id: string; netsuite_id: string | null; company_name: string | null; ytd_spend: number | null; total_spend: number | null }
interface ExtContact { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_primary: boolean }
interface CustTagRow { tag_id: string; label: string; kind: string }
interface VocabRow { id: string; label: string; kind: string }

const BILLING_WORKFLOWS: Record<string, string> = {
  po_portal: 'Customer portal — submit there, don’t email',
  email_ap: 'Email invoices to AP',
  no_po_direct: 'Direct invoice — no PO required',
};

interface Contact { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_decision_maker: boolean; netsuite_contact_id: string | null }
interface Opportunity { id: string; title: string; type: string; stage: string; value: number | null; expected_close_date: string | null; created_at: string }
interface Activity { id: string; type: string; summary: string; created_by: string | null; created_at: string; creator_name?: string | null; email_log_id?: string | null }
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

/**
 * One line of the customer's Transactions ledger — the merge of everything
 * that used to live in three separate boxes (NetSuite documents, quotes &
 * estimates, payments & credits).
 *
 * A quote built in FleetSuite and pushed to NetSuite is ONE transaction, so
 * it renders as one row: the NetSuite document carries the money and the
 * status, and `origin` carries the FleetSuite record it came from. That's
 * what lets the number open the exact estimate/quote/job that produced it
 * (never the list page it lives on), and what lets a row offer BOTH PDFs —
 * NetSuite's document of record and the FleetSuite copy.
 */
type TxnKind = 'invoice' | 'salesOrder' | 'estimate' | 'quote' | 'payment' | 'credit';

interface TxnOrigin {
  /** Which FleetSuite tool built it — decides the label and the PDF route. */
  kind: 'estimate' | 'wrapQuote' | 'graphicsJob';
  id: string;
  number: string;
  /** Deep link to that exact record. */
  url: string;
  /** Server-rendered FleetSuite PDF, when the record has one (a graphics
   *  job doesn't — its invoice document only ever existed in NetSuite). */
  pdfUrl: string | null;
}

interface Txn {
  key: string;
  kind: TxnKind;
  typeLabel: string;
  number: string;
  date: string | null; // ISO
  dueDate: string | null; // ISO
  status: string;
  statusNorm: CustDocument['statusNorm'];
  daysPastDue: number;
  total: number;
  /** NetSuite internal id, when NetSuite holds this transaction. */
  nsId: string | null;
  /** Set only for the three types NetSuite will render a PDF for. */
  nsPdfType: CustDocument['type'] | null;
  origin: TxnOrigin | null;
}

const TXN_FILTERS = [
  ['all', 'All'],
  ['invoice', 'Invoices'],
  ['salesOrder', 'Sales Orders'],
  ['quote', 'Quotes & Estimates'],
  ['payment', 'Payments & Credits'],
] as const;
type TxnFilter = typeof TXN_FILTERS[number][0];

const TXN_FILTER_KINDS: Record<Exclude<TxnFilter, 'all'>, TxnKind[]> = {
  invoice: ['invoice'],
  salesOrder: ['salesOrder'],
  quote: ['estimate', 'quote'],
  payment: ['payment', 'credit'],
};

const TXN_BADGE: Record<TxnKind, { bg: string; color: string }> = {
  invoice: { bg: 'var(--subtle-bg)', color: 'var(--text-muted)' },
  salesOrder: { bg: 'var(--subtle-bg)', color: 'var(--text-muted)' },
  estimate: { bg: 'var(--subtle-bg)', color: 'var(--text-muted)' },
  quote: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa' },
  payment: { bg: 'var(--success-bg)', color: 'var(--success)' },
  credit: { bg: 'rgba(167,139,250,0.12)', color: '#a78bfa' },
};

const ORIGIN_LABEL: Record<TxnOrigin['kind'], string> = {
  estimate: 'estimate', wrapQuote: 'wrap quote', graphicsJob: 'graphics job',
};

// Column getters for the sortable transactions table (ISO dates compare
// correctly as strings; nulls sort last via useTableSort).
const TXN_SORT_COLS = {
  type: (t: Txn) => t.typeLabel,
  number: (t: Txn) => t.number,
  date: (t: Txn) => t.date,
  due: (t: Txn) => t.dueDate,
  status: (t: Txn) => STATUS_RANK[t.statusNorm],
  amount: (t: Txn) => t.total,
  source: (t: Txn) => (t.origin ? 0 : 1),
};

const OPP_STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STAGE_COLORS: Record<string, string> = { lead: '#60a5fa', quoted: '#a78bfa', negotiating: '#fbbf24', won: '#4ade80', lost: '#f87171' };
// status_change stays in the icon map so historical feed entries still render.
const DOCS_PAGE_SIZE = 100;
const ACTS_PAGE_SIZE = 30;

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

  // K1–K3 customer-model surfaces (Aug 6 plan) — all keyed on customers.id,
  // so they only exist when the NetSuite mirror row does.
  const [parentRef, setParentRef] = useState<ParentRef | null>(null);
  const [children, setChildren] = useState<ChildAccount[]>([]);
  const [childContacts, setChildContacts] = useState<Record<string, { name: string; title: string | null; phone: string | null; email: string | null }[]>>({});
  const [extContacts, setExtContacts] = useState<ExtContact[]>([]);
  const [custTags, setCustTags] = useState<CustTagRow[]>([]);
  const [vocab, setVocab] = useState<VocabRow[]>([]);
  const [salesReps, setSalesReps] = useState<{ id: string; full_name: string }[]>([]);
  // Assign-parent dialog
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState('');
  const [parentResults, setParentResults] = useState<{ id: string; company_name: string | null; netsuite_id: string | null }[]>([]);
  const [parentChoice, setParentChoice] = useState<{ id: string; company_name: string | null; netsuite_id: string | null } | null>(null);
  const [parentNote, setParentNote] = useState('');
  const [parentSaving, setParentSaving] = useState(false);
  // Billing card edit state
  const [billForm, setBillForm] = useState({ workflow: '', portal: '', notes: '' });
  const [billDirty, setBillDirty] = useState(false);
  const [billSaving, setBillSaving] = useState(false);

  const [docs, setDocs] = useState<CustDocument[] | null>(null);
  const [docsHasMore, setDocsHasMore] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [docFilter, setDocFilter] = useState<TxnFilter>('all');
  const [docStatus, setDocStatus] = useState<'all' | 'open' | 'pastdue' | 'paid'>('all');
  const [docSearch, setDocSearch] = useState('');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  // Bulk PDF download — pick specific documents (e.g. the invoices a
  // customer asked for copies of) and pull them down as one ZIP.
  const [selectedDocKeys, setSelectedDocKeys] = useState<Set<string>>(new Set());
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

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

  // FleetSuite-side transactions for this customer. The NetSuite ids are
  // what tie a FleetSuite record to the NetSuite document it became, so the
  // Transactions list can show ONE row per transaction instead of the same
  // quote twice (see txns).
  interface WrapQuoteRow { id: string; quote_number: string; vehicle_description: string | null; project_type: string | null; total: number | null; status: string; sent_at: string | null; created_at: string; netsuite_estimate_id: string | null }
  interface EstimateRow { id: string; estimate_number: string; title: string | null; status: string; grand_total: number | null; created_at: string; netsuite_estimate_id: string | null; netsuite_so_id: string | null }
  interface GraphicsJobRow { id: string; job_number: string | null; title: string | null; netsuite_invoice_id: string | null }
  const [wrapQuotes, setWrapQuotes] = useState<WrapQuoteRow[] | null>(null);
  const [estimatesList, setEstimatesList] = useState<EstimateRow[] | null>(null);
  const [graphicsJobs, setGraphicsJobs] = useState<GraphicsJobRow[] | null>(null);

  // Contact add/edit — saved through /api/prospects/contacts, which also
  // pushes the change to NetSuite when the record is linked.
  const emptyContactForm = { name: '', title: '', email: '', phone: '', is_decision_maker: false };
  const [cFormOpen, setCFormOpen] = useState(false);
  const [cEditId, setCEditId] = useState<string | null>(null);
  const [cForm, setCForm] = useState(emptyContactForm);
  const [cSyncNs, setCSyncNs] = useState(true);
  const [cSaving, setCSaving] = useState(false);
  // "Primary contact" is deliberately NOT part of cForm: it isn't a
  // prospect_contacts column, it's a promotion on external_contacts that
  // runs after the save.
  const [cPrimary, setCPrimary] = useState(false);

  const openContactForm = (c?: Contact) => {
    setCEditId(c?.id || null);
    setCForm(c ? { name: c.name, title: c.title || '', email: c.email || '', phone: c.phone || '', is_decision_maker: c.is_decision_maker } : emptyContactForm);
    setCSyncNs(true);
    setCPrimary(!!c && isPrimaryContact(c));
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
    // Captured before the save: an edit that changes the email/phone would
    // otherwise stop matching the external contact this person already is.
    const editing = cEditId ? contacts.find(c => c.id === cEditId) : null;
    const boundExtId = editing && isPrimaryContact(editing) ? primaryExtContact?.id || null : null;
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
      const wasCreate = !cEditId;
      setCEditId(null);
      setCForm(emptyContactForm);
      if (wasCreate) logAuto('note', `Added contact: ${saved.name}${saved.is_decision_maker ? ' (decision maker)' : ''}`);
      // Ticked → promote (passing the row this person already is, so an
      // edited email still syncs onto it rather than forking a second one).
      // Unticked on the current primary → stand them down.
      if (customer) {
        if (cPrimary) await makeContactPrimary(saved, boundExtId);
        else if (boundExtId) await clearPrimaryContact(boundExtId);
      }
      if (body.netsuite?.error) {
        await dialog.alert(`Contact saved, but the NetSuite update failed:\n\n${body.netsuite.error}`);
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

  // Auto-logged touches (status flips, deal changes, contact adds) — the
  // same prospect_activities insert, threaded into the feed silently.
  const logAuto = async (type: string, summary: string) => {
    if (!prospect) return;
    const { data } = await supabase.from('prospect_activities').insert({
      prospect_id: prospect.id, type, summary, created_by: user?.id,
    }).select().single();
    if (data) setActivities(prev => [{ ...(data as Activity), creator_name: profile?.full_name || null }, ...prev]);
  };

  // ── Record editing (ported from the CRM list card — the record page is
  // the primary edit surface now, the list is just the index) ──────────────
  const emptyEditForm = { company_name: '', contact_name: '', email: '', phone: '', website: '', address: '', city: '', state: '', zip: '', notes: '', location_count: 1, lead_source: '', lead_source_other: '', record_type: 'customer' };
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);

  const openEdit = () => {
    if (!prospect) return;
    setEditForm({
      company_name: prospect.company_name || '', contact_name: prospect.contact_name || '',
      email: prospect.email || '', phone: prospect.phone || '', website: prospect.website || '',
      address: prospect.address || '', city: prospect.city || '', state: prospect.state || '', zip: prospect.zip || '',
      notes: prospect.notes || '', location_count: prospect.location_count || 1,
      lead_source: prospect.lead_source || '', lead_source_other: prospect.lead_source_other || '',
      record_type: prospect.record_type || 'customer',
    });
    setEditOpen(true);
  };

  const saveEdit = async () => {
    if (!prospect || !editForm.company_name.trim() || editSaving) return;
    setEditSaving(true);
    const patch = {
      company_name: editForm.company_name.trim(), contact_name: editForm.contact_name || null,
      email: editForm.email || null, phone: editForm.phone || null, website: editForm.website || null,
      address: editForm.address || null, city: editForm.city || null, state: editForm.state || null, zip: editForm.zip || null,
      notes: editForm.notes || null, location_count: editForm.location_count || 1,
      lead_source: editForm.lead_source || null,
      lead_source_other: editForm.lead_source === 'Other' ? editForm.lead_source_other || null : null,
      record_type: editForm.record_type || 'customer',
    };
    const { error } = await supabase.from('prospects').update(patch).eq('id', prospect.id);
    setEditSaving(false);
    if (error) { await dialog.alert(`Could not save: ${error.message}`); return; }
    setProspect(prev => (prev ? { ...prev, ...patch } : prev));
    setEditOpen(false);
  };

  const deleteRecord = async () => {
    if (!prospect || editSaving) return;
    // Deletion propagates (owner decision 2026-08-30): a linked record's
    // NetSuite customer is deleted too — or deactivated when NetSuite
    // refuses (existing transactions) — so the next sync can't resurrect
    // it. Routed through the API so the propagation can't be skipped.
    const ok = await dialog.confirm(
      prospect.netsuite_id
        ? `Delete ${prospect.company_name} and all associated contacts, deals, reminders, and activity?\n\nThis also deletes the linked NetSuite customer (or marks it inactive if NetSuite refuses because it has transactions). Admins only.`
        : `Delete ${prospect.company_name} and all associated contacts, deals, reminders, and activity?`,
      { destructive: true, confirmLabel: 'Delete', title: 'Delete record' },
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/prospects?id=${prospect.id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      if (body.netsuite === 'deactivated') {
        await dialog.alert('Deleted here. NetSuite refused a hard delete (the customer has transactions), so it was marked inactive there instead.');
      }
    } catch (e: any) {
      await dialog.alert(`Could not delete: ${e?.message || 'unknown error'}`);
      return;
    }
    router.push('/admin/prospects');
  };

  const toggleFlag = async (field: 'is_hot' | 'email_campaign' | 'multi_location') => {
    if (!prospect) return;
    const next = !prospect[field];
    const { error } = await supabase.from('prospects').update({ [field]: next }).eq('id', prospect.id);
    if (error) { await dialog.alert(`Could not update: ${error.message}`); return; }
    setProspect(prev => (prev ? { ...prev, [field]: next } : prev));
    // Campaign membership is consent-adjacent — keep a who/when trail on the
    // activity feed (the other flags are cosmetic and stay unlogged).
    if (field === 'email_campaign') {
      logAuto('note', next ? 'Added to the email-campaign list' : 'Removed from the email-campaign list');
    }
  };

  // Promote a lead. Customers are normally created in NetSuite the moment
  // they're entered (the CRM create form's "Create the customer in NetSuite
  // now", ticked by default), so a record reaches this button in one of two
  // ways: someone unticked that box, or NetSuite refused at create time.
  // Either way the CRM row already exists — this only fills in the missing
  // NetSuite half.
  const [converting, setConverting] = useState(false);
  const addToNetSuite = async () => {
    if (!prospect || converting) return;
    if (prospect.netsuite_id) { await dialog.alert('Already in NetSuite.'); return; }
    if (!(await dialog.confirm(`Promote "${prospect.company_name}" to a NetSuite customer? This creates the NetSuite record — until now the lead has lived only in FleetSuite.`, { confirmLabel: 'Promote' }))) return;
    setConverting(true);
    try {
      const res = await fetch('/api/prospects/push-to-netsuite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId: prospect.id, type: 'customer', userId: user?.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data?.error || `HTTP ${res.status}`);
      logAuto('status_change', `Added to NetSuite as customer #${data.entityId}`);
      setProspect(prev => (prev ? { ...prev, status: 'converted', netsuite_id: data.customerId, netsuite_url: data.netsuiteUrl, converted_customer_id: data.customerId } : prev));
      // The record is linked now — the NetSuite panels can load.
      const nsId = String(data.customerId);
      loadDocs(nsId, false); loadStatement(nsId); loadPayments(nsId); loadNsProfile(nsId);
    } catch (err: any) {
      await dialog.alert(`NetSuite create failed: ${err?.message || 'unknown error'}`);
    }
    setConverting(false);
  };

  // Creates the missing CRM row for a NetSuite-synced customer, so
  // "Not in CRM" records stop being read-only dead ends.
  const [addingToCrm, setAddingToCrm] = useState(false);
  const addToCrm = async () => {
    if (!customer || prospect || addingToCrm) return;
    setAddingToCrm(true);
    const { data, error } = await supabase.from('prospects').insert({
      company_name: customer.company_name || customer.entity_id || 'Unknown',
      email: customer.email, phone: customer.phone, address: customer.address,
      status: 'converted', netsuite_id: customer.netsuite_id, netsuite_url: customer.netsuite_url,
      created_by: user?.id,
    }).select().single();
    setAddingToCrm(false);
    if (error || !data) { await dialog.alert(`Could not create the record: ${error?.message || 'unknown error'}`); return; }
    setProspect(data as Prospect);
    loadFiles(data.id);
  };

  // No free-form add path any more: tags come from the controlled
  // Industry/Partner vocabulary in the header. removeTag stays so the
  // legacy prospect_tags (incl. auto-generated ones) can still be cleared.
  const removeTag = async (tag: Tag) => {
    const { error } = await supabase.from('prospect_tags').delete().eq('id', tag.id);
    if (error) { await dialog.alert(`Could not remove the tag: ${error.message}`); return; }
    setTags(prev => prev.filter(t => t.id !== tag.id));
  };

  // ── K1–K3: customer-model data (parent, sub-accounts, primary contact,
  // industry tags, sales rep, billing) — fired from load() when the
  // customers row exists. Each block is independent and fails soft. ────────
  const loadCustomerExtras = (cust: CustomerRow) => {
    setBillForm({ workflow: cust.billing_workflow || '', portal: cust.billing_portal || '', notes: cust.billing_notes || '' });

    // Effective parent: the manual link wins; otherwise NetSuite's hierarchy.
    (async () => {
      if (cust.parent_customer_id) {
        const { data } = await supabase.from('customers').select('id, netsuite_id, company_name').eq('id', cust.parent_customer_id).maybeSingle();
        if (data) { setParentRef({ ...(data as any), source: 'manual' }); return; }
      }
      if (cust.netsuite_parent_id) {
        const { data } = await supabase.from('customers').select('id, netsuite_id, company_name').eq('netsuite_id', cust.netsuite_parent_id).maybeSingle();
        if (data) setParentRef({ ...(data as any), source: 'netsuite' });
      }
    })();

    // Sub-accounts: manual children + NetSuite-hierarchy children, then each
    // child's CRM contacts ("Jerry Kelly under all relevant parents").
    (async () => {
      const { data: kids } = await fetchAllRows<ChildAccount>((from, to) =>
        supabase.from('customers')
          .select('id, netsuite_id, company_name, ytd_spend, total_spend')
          .or(`parent_customer_id.eq.${cust.id},netsuite_parent_id.eq.${cust.netsuite_id}`)
          .order('netsuite_id').range(from, to));
      const list = (kids || []).filter(k => k.id !== cust.id);
      setChildren(list);
      const nsIds = list.map(k => k.netsuite_id).filter(Boolean) as string[];
      if (nsIds.length === 0) return;
      const { data: pros } = await supabase.from('prospects').select('id, netsuite_id').in('netsuite_id', nsIds);
      const childByNs: Record<string, string> = {};
      for (const k of list) if (k.netsuite_id) childByNs[k.netsuite_id] = k.id;
      const prospectToChild: Record<string, string> = {};
      for (const pr of (pros || []) as { id: string; netsuite_id: string | null }[]) {
        if (pr.netsuite_id && childByNs[pr.netsuite_id]) prospectToChild[pr.id] = childByNs[pr.netsuite_id];
      }
      const pids = Object.keys(prospectToChild);
      if (pids.length === 0) return;
      const { data: cons } = await supabase.from('prospect_contacts')
        .select('prospect_id, name, title, email, phone').in('prospect_id', pids).order('name');
      const grouped: Record<string, { name: string; title: string | null; phone: string | null; email: string | null }[]> = {};
      for (const c of (cons || []) as any[]) {
        const childId = prospectToChild[c.prospect_id];
        if (!childId) continue;
        (grouped[childId] ||= []).push({ name: c.name, title: c.title, phone: c.phone, email: c.email });
      }
      setChildContacts(grouped);
    })();

    // Primary contact (external_contacts drives estimate approvals, pickup
    // notices, and SMS matching — surfacing it here is K2).
    reloadExtContacts(cust.id);

    // Industry/partner tags + the controlled vocabulary.
    (async () => {
      const [tRes, vRes] = await Promise.all([
        supabase.from('customer_tags').select('tag_id, customer_tag_vocabulary(label, kind)').eq('customer_id', cust.id),
        supabase.from('customer_tag_vocabulary').select('id, label, kind').eq('active', true).order('kind').order('label'),
      ]);
      setCustTags(((tRes.data || []) as any[]).map(r => ({
        tag_id: r.tag_id,
        label: r.customer_tag_vocabulary?.label || '?',
        kind: r.customer_tag_vocabulary?.kind || 'industry',
      })));
      setVocab((vRes.data || []) as VocabRow[]);
    })();

    // Sales-rep picker options — same population as the at-risk report.
    (async () => {
      const { data } = await supabase.from('profiles')
        .select('id, full_name, role, roles').eq('status', 'approved').order('full_name');
      setSalesReps(((data || []) as any[])
        .filter(p => {
          const roleList: string[] = p.roles?.length ? p.roles : [p.role];
          return roleList.includes('admin') || roleList.includes('super_admin') || roleList.includes('sales');
        })
        .map(p => ({ id: p.id, full_name: p.full_name || 'Unknown' })));
    })();
  };

  const searchParents = async (term: string) => {
    setParentSearch(term);
    setParentChoice(null);
    if (term.trim().length < 2) { setParentResults([]); return; }
    const { data } = await supabase.from('customers')
      .select('id, company_name, netsuite_id')
      .ilike('company_name', `%${term.trim()}%`)
      .neq('id', customer?.id || '')
      .order('company_name').limit(12);
    setParentResults((data || []) as any[]);
  };

  // Assign/clear the manual parent link. A note is required — the meeting was
  // explicit that account moves need an explanation on the record. It lands in
  // the activity feed (or internal_notes when there's no CRM row to log to).
  const saveParent = async (clear: boolean) => {
    if (!customer || parentSaving) return;
    const choice = clear ? null : parentChoice;
    if (!clear && !choice) return;
    const note = parentNote.trim();
    if (!note) { await dialog.alert('Add a note explaining the change — account moves need a paper trail.'); return; }
    setParentSaving(true);
    const patch = { parent_customer_id: choice?.id ?? null, parent_source: choice ? 'manual' : null };
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id);
    if (error) { setParentSaving(false); await dialog.alert(`Could not save: ${error.message}`); return; }
    const summary = choice
      ? `Parent account set to ${choice.company_name || choice.netsuite_id || 'unknown'} — ${note}`
      : 'Parent account cleared — ' + note;
    if (prospect) {
      await logAuto('status_change', summary);
    } else {
      const stamp = new Date().toISOString().slice(0, 10);
      const merged = `${customer.internal_notes ? customer.internal_notes + '\n' : ''}[${stamp}] ${summary}`;
      await supabase.from('customers').update({ internal_notes: merged }).eq('id', customer.id);
      setCustomer(prev => (prev ? { ...prev, internal_notes: merged } : prev));
    }
    setCustomer(prev => (prev ? { ...prev, ...patch } : prev));
    if (choice) {
      setParentRef({ id: choice.id, netsuite_id: choice.netsuite_id, company_name: choice.company_name, source: 'manual' });
    } else if (customer.netsuite_parent_id) {
      // Manual link cleared — fall back to the NetSuite hierarchy if present.
      const { data } = await supabase.from('customers').select('id, netsuite_id, company_name').eq('netsuite_id', customer.netsuite_parent_id).maybeSingle();
      setParentRef(data ? { ...(data as any), source: 'netsuite' } : null);
    } else {
      setParentRef(null);
    }
    setParentPickerOpen(false); setParentChoice(null); setParentNote(''); setParentSearch(''); setParentResults([]);
    setParentSaving(false);
  };

  // Promote an EXTERNAL contact (one with no CRM twin — typically created by
  // an inbound text) straight from the notifications box.
  const setPrimaryContact = async (contactId: string) => {
    if (!customer || !contactId) return;
    try {
      const res = await fetch(`/api/external-contacts/${contactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_primary: true, customerId: customer.id }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `HTTP ${res.status}`);
      }
      setExtContacts(prev => prev.map(c => ({ ...c, is_primary: c.id === contactId })));
    } catch (err: any) {
      await dialog.alert(`Could not set the primary contact: ${err?.message || 'unknown error'}`);
    }
  };

  // Promote a CRM contact — the star on each Contacts row. The flag lives on
  // external_contacts (what every notification path reads), so the server
  // matches this person onto the customer's existing external contact or
  // creates one; see src/lib/primary-contact.ts.
  const [primaryBusy, setPrimaryBusy] = useState<string | null>(null);
  const makeContactPrimary = async (c: Contact, externalContactId?: string | null) => {
    setPrimaryBusy(c.id);
    try {
      const res = await fetch('/api/prospects/contacts/primary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: c.id, ...(externalContactId ? { externalContactId } : {}) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`);
      if (customer) await reloadExtContacts(customer.id);
    } catch (err: any) {
      await dialog.alert(`Could not set the primary contact: ${err?.message || 'unknown error'}`);
    }
    setPrimaryBusy(null);
  };

  // Stand the current primary down — the customer then falls back to the
  // account's own email/phone (customer-notify recreates a contact from it).
  const clearPrimaryContact = async (externalContactId: string) => {
    try {
      const res = await fetch(`/api/external-contacts/${externalContactId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_primary: false }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b?.error || `HTTP ${res.status}`);
      }
      if (customer) await reloadExtContacts(customer.id);
    } catch (err: any) {
      await dialog.alert(`Could not clear the primary contact: ${err?.message || 'unknown error'}`);
    }
  };

  const reloadExtContacts = async (customerId: string) => {
    const { data } = await supabase.from('external_contacts')
      .select('id, name, title, email, phone, is_primary')
      .eq('customer_id', customerId)
      .order('is_primary', { ascending: false }).order('name');
    setExtContacts((data || []) as ExtContact[]);
  };

  const addCustTag = async (tagId: string) => {
    if (!customer || !tagId) return;
    const v = vocab.find(x => x.id === tagId);
    const { error } = await supabase.from('customer_tags').insert({ customer_id: customer.id, tag_id: tagId, created_by: user?.id });
    if (error) { await dialog.alert(`Could not add the tag: ${error.message}`); return; }
    if (v) setCustTags(prev => [...prev, { tag_id: v.id, label: v.label, kind: v.kind }]);
  };

  const removeCustTag = async (tagId: string) => {
    if (!customer) return;
    const { error } = await supabase.from('customer_tags').delete().eq('customer_id', customer.id).eq('tag_id', tagId);
    if (error) { await dialog.alert(`Could not remove the tag: ${error.message}`); return; }
    setCustTags(prev => prev.filter(t => t.tag_id !== tagId));
  };

  // Grow the controlled vocabulary in place (admin-only affordance) and apply
  // the new value to this customer in one motion.
  const addVocabValue = async (kind: 'industry' | 'partner') => {
    if (!customer) return;
    const label = (await dialog.prompt(`New ${kind} tag value:`))?.trim();
    if (!label) return;
    const { data, error } = await supabase.from('customer_tag_vocabulary').insert({ label, kind }).select('id, label, kind').single();
    if (error || !data) { await dialog.alert(`Could not add the value: ${error?.message || 'unknown error'}`); return; }
    const row = data as VocabRow;
    setVocab(prev => [...prev, row].sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label)));
    const { error: tagErr } = await supabase.from('customer_tags').insert({ customer_id: customer.id, tag_id: row.id, created_by: user?.id });
    if (!tagErr) setCustTags(prev => [...prev, { tag_id: row.id, label: row.label, kind: row.kind }]);
  };

  const setSalesRep = async (ownerId: string) => {
    if (!customer) return;
    const { error } = await supabase.from('customers').update({ account_owner_id: ownerId || null }).eq('id', customer.id);
    if (error) { await dialog.alert(`Could not set the sales rep: ${error.message}`); return; }
    setCustomer(prev => (prev ? { ...prev, account_owner_id: ownerId || null } : prev));
  };

  const saveBilling = async () => {
    if (!customer || billSaving) return;
    if (billForm.workflow === 'po_portal' && !billForm.portal.trim()) {
      await dialog.alert('Name the portal (e.g. Masterack, Bogle) so everyone knows where invoices go.');
      return;
    }
    setBillSaving(true);
    const patch = {
      billing_workflow: billForm.workflow || null,
      billing_portal: billForm.portal.trim() || null,
      billing_notes: billForm.notes.trim() || null,
    };
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id);
    setBillSaving(false);
    if (error) { await dialog.alert(`Could not save billing: ${error.message}`); return; }
    setCustomer(prev => (prev ? { ...prev, ...patch } : prev));
    setBillDirty(false);
  };

  const emptyOppForm = { title: '', type: 'tech_install', value: '', expected_close_date: '' };
  const [oppFormOpen, setOppFormOpen] = useState(false);
  const [oppForm, setOppForm] = useState(emptyOppForm);
  const [oppSaving, setOppSaving] = useState(false);

  const addOpportunity = async () => {
    if (!prospect || !oppForm.title.trim() || oppSaving) return;
    setOppSaving(true);
    const { data, error } = await supabase.from('prospect_opportunities').insert({
      prospect_id: prospect.id, title: oppForm.title.trim(), type: oppForm.type, stage: 'lead',
      value: oppForm.value ? parseFloat(oppForm.value) : null,
      expected_close_date: oppForm.expected_close_date || null,
      created_by: user?.id,
    }).select().single();
    setOppSaving(false);
    if (error || !data) { await dialog.alert(`Could not add the deal: ${error?.message || 'unknown error'}`); return; }
    setOpportunities(prev => [data as Opportunity, ...prev]);
    logAuto('note', `Created opportunity: ${oppForm.title.trim()} (${OPP_TYPES[oppForm.type] || oppForm.type})`);
    setOppForm(emptyOppForm);
    setOppFormOpen(false);
  };

  const setOppStage = async (opp: Opportunity, newStage: string) => {
    if (opp.stage === newStage) return;
    const { error } = await supabase.from('prospect_opportunities')
      .update({ stage: newStage, ...(newStage === 'won' || newStage === 'lost' ? { closed_at: new Date().toISOString() } : {}) })
      .eq('id', opp.id);
    if (error) { await dialog.alert(`Could not update the deal: ${error.message}`); return; }
    setOpportunities(prev => prev.map(o => (o.id === opp.id ? { ...o, stage: newStage } : o)));
    logAuto('status_change', `${opp.title}: ${OPP_STAGES[opp.stage] || opp.stage} → ${OPP_STAGES[newStage] || newStage}`);
  };

  const completeReminder = async (r: Reminder) => {
    const { error } = await supabase.from('prospect_reminders').update({ completed_at: new Date().toISOString() }).eq('id', r.id);
    if (error) { await dialog.alert(`Could not complete the reminder: ${error.message}`); return; }
    setReminders(prev => prev.filter(x => x.id !== r.id));
  };

  // Manual reminder ("call them next Wednesday") — same prospect_reminders
  // table the voice-note flow writes, so it shows here and on the Schedule
  // page's calendar (Sales type) without any extra plumbing.
  const [remFormOpen, setRemFormOpen] = useState(false);
  const [remForm, setRemForm] = useState({ title: '', date: '', time: '' });
  const [remSaving, setRemSaving] = useState(false);

  const addReminder = async () => {
    if (!prospect || !remForm.title.trim() || !remForm.date || remSaving) return;
    setRemSaving(true);
    // No time picked → 9:00 AM local, matching the voice-note default.
    const dueAt = new Date(`${remForm.date}T${remForm.time || '09:00'}`);
    const { data, error } = await supabase.from('prospect_reminders').insert({
      prospect_id: prospect.id,
      title: remForm.title.trim(),
      due_at: dueAt.toISOString(),
      created_by: user?.id,
    }).select('id, title, description, due_at').single();
    setRemSaving(false);
    if (error || !data) { await dialog.alert(`Could not set the reminder: ${error?.message || 'unknown error'}`); return; }
    setReminders(prev => [...prev, data as Reminder].sort((a, b) => a.due_at.localeCompare(b.due_at)));
    logAuto('note', `Reminder set: ${remForm.title.trim()} — due ${dueAt.toLocaleDateString()}`);
    setRemForm({ title: '', date: '', time: '' });
    setRemFormOpen(false);
  };

  // Older history pages on demand — the CRM list capped at 50 and this page
  // at 20, leaving anything older invisible everywhere. Not anymore.
  const [actsHasMore, setActsHasMore] = useState(false);
  const [actsLoadingMore, setActsLoadingMore] = useState(false);
  const loadMoreActivities = async () => {
    if (!prospect || actsLoadingMore) return;
    setActsLoadingMore(true);
    const from = activities.length;
    const { data } = await supabase.from('prospect_activities')
      .select('id, type, summary, created_by, created_at, email_log_id')
      .eq('prospect_id', prospect.id)
      .order('created_at', { ascending: false }).order('id')
      .range(from, from + ACTS_PAGE_SIZE - 1);
    const page = (data || []) as Activity[];
    const creatorIds = [...new Set(page.map(a => a.created_by).filter(Boolean))] as string[];
    const names: Record<string, string> = {};
    if (creatorIds.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', creatorIds);
      for (const pr of profs || []) names[pr.id] = pr.full_name;
    }
    setActivities(prev => [...prev, ...page.map(a => ({ ...a, creator_name: a.created_by ? names[a.created_by] || null : null }))]);
    setActsHasMore(page.length === ACTS_PAGE_SIZE);
    setActsLoadingMore(false);
  };

  // Re-pull activities + reminders after the voice-note API writes them
  // server-side (it parses the transcript into both).
  const refreshFeed = async (pid: string) => {
    const [aRes, rRes] = await Promise.all([
      supabase.from('prospect_activities').select('id, type, summary, created_by, created_at, email_log_id').eq('prospect_id', pid).order('created_at', { ascending: false }).order('id').limit(20),
      supabase.from('prospect_reminders').select('id, title, description, due_at').eq('prospect_id', pid).is('completed_at', null).order('due_at'),
    ]);
    const acts = (aRes.data || []) as Activity[];
    const creatorIds = [...new Set(acts.map(a => a.created_by).filter(Boolean))] as string[];
    const names: Record<string, string> = {};
    if (creatorIds.length > 0) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', creatorIds);
      for (const pr of profs || []) names[pr.id] = pr.full_name;
    }
    setActivities(acts.map(a => ({ ...a, creator_name: a.created_by ? names[a.created_by] || null : null })));
    setActsHasMore(acts.length === 20);
    setReminders((rRes.data || []) as Reminder[]);
  };

  // Voice note → /api/prospects/voice-note, which parses the transcript
  // into activities AND reminders (the app's only reminder-creation flow).
  const [recording, setRecording] = useState(false);
  const [voiceProcessing, setVoiceProcessing] = useState(false);
  const [voiceResult, setVoiceResult] = useState<{ summary: string; reminders: number } | null>(null);
  const recognitionRef = useRef<any>(null);

  const startVoiceNote = async () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) { await dialog.alert('Speech recognition not supported in this browser. Try Chrome.'); return; }
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setActText(transcript);
    };
    recognition.onerror = () => setRecording(false);
    recognition.onend = () => setRecording(false);
    recognition.start();
    recognitionRef.current = recognition;
    setRecording(true);
    setVoiceResult(null);
  };

  const stopVoiceNote = async () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setRecording(false);
    const text = actText.trim();
    if (!text || !prospect) return;
    setVoiceProcessing(true);
    try {
      const res = await fetch('/api/prospects/voice-note', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospectId: prospect.id, noteText: text, userId: user?.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setVoiceResult({ summary: data.summary, reminders: data.reminders || 0 });
      setActText('');
      refreshFeed(prospect.id);
    } catch (err: any) {
      await dialog.alert(`Could not process the voice note: ${err?.message || 'unknown error'}`);
    }
    setVoiceProcessing(false);
  };

  const exportPdf = () => {
    if (!prospect) return;
    exportProspectPDF({
      prospect,
      ownerName: null,
      metrics: customer ? {
        total_spend: customer.total_spend ?? undefined, total_orders: customer.total_orders ?? undefined,
        ytd_spend: customer.ytd_spend ?? undefined, ytd_orders: customer.ytd_orders ?? undefined,
        last_year_spend: customer.last_year_spend ?? undefined, last_order_date: customer.last_order_date,
        avg_order_value: customer.avg_order_value ?? undefined,
      } : null,
      contacts,
      opportunities,
      activities: activities.map(a => ({ ...a, creator_name: a.creator_name ?? undefined })),
      tags,
      documents: (docs || []).map(d => ({ number: d.number, date: d.date || '', typeLabel: d.typeLabel, status: d.status })),
    });
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
        .select('id, netsuite_id, netsuite_url, company_name, entity_id, email, phone, address, total_spend, avg_order_value, ytd_spend, ytd_orders, last_year_spend, total_orders, last_order_date, netsuite_parent_id, parent_customer_id, parent_source, account_owner_id, billing_workflow, billing_portal, billing_notes, internal_notes')
        .eq('netsuite_id', nsId).maybeSingle();
      cust = data as CustomerRow | null;
    }

    if (!p && !cust) { setNotFound(true); setLoading(false); return; }
    setProspect(p);
    setCustomer(cust);
    if (cust) loadCustomerExtras(cust);

    if (p) {
      const [cRes, oRes, aRes, tRes, rRes] = await Promise.all([
        supabase.from('prospect_contacts').select('id, name, title, email, phone, is_decision_maker, netsuite_contact_id').eq('prospect_id', p.id).order('is_decision_maker', { ascending: false }),
        supabase.from('prospect_opportunities').select('id, title, type, stage, value, expected_close_date, created_at').eq('prospect_id', p.id).order('created_at', { ascending: false }),
        supabase.from('prospect_activities').select('id, type, summary, created_by, created_at, email_log_id').eq('prospect_id', p.id).order('created_at', { ascending: false }).order('id').limit(20),
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
      setActsHasMore(acts.length === 20);
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

  // Statement email goes through the standard compose screen (editable
  // recipients prefilled from billing emails, bcc-me, personal note, live
  // preview of the exact statement email).
  const emailStatement = () => {
    const nsId = prospect?.netsuite_id || customer?.netsuite_id;
    if (!nsId || emailingSt) return;
    setStEmailOpen(true);
  };

  const fetchStatementPreview = async (fields: EmailComposeFields) => {
    const nsId = prospect?.netsuite_id || customer?.netsuite_id;
    if (!nsId) return { error: 'Not linked to a NetSuite customer' };
    try {
      const res = await fetch('/api/netsuite/email-statement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preview: true,
          customerId: nsId,
          recipients: fields.emails,
          customBody: fields.message || undefined,
          scope: stScope,
          from: stFrom || undefined,
          to: stTo || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok && data.preview) {
        setStPdfName((Array.isArray(data.attachments) && data.attachments[0]) || null);
        return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      }
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  const sendStatementEmail = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    const nsId = prospect?.netsuite_id || customer?.netsuite_id;
    if (!nsId) return { ok: false };
    setEmailingSt(true);
    try {
      const res = await fetch('/api/netsuite/email-statement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerId: nsId,
          recipients: fields.emails,
          customBody: fields.message || undefined,
          bccSelf: fields.bccSelf,
          scope: stScope,
          from: stFrom || undefined,
          to: stTo || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
      await dialog.alert(`Statement sent to ${body.sent.join(', ')} with the statement PDF${body.statementPdf ? ` (${body.statementPdf})` : ''} and ${body.attached} invoice PDF${body.attached === 1 ? '' : 's'} attached.${body.failedAttachments?.length ? `\n\nPDFs unavailable for: ${body.failedAttachments.join(', ')}` : ''}`);
      setStModalOpen(false);
      setEmailingSt(false);
      return { ok: true };
    } catch (err: any) {
      await dialog.alert(`Could not send the statement: ${err?.message || 'unknown error'}`);
      setEmailingSt(false);
      return { ok: false };
    }
  };

  const loadNsProfile = async (nsId: string) => {
    try {
      const res = await fetch(`/api/netsuite/customer-profile?customerId=${nsId}`);
      const body = await res.json();
      if (res.ok && body.success) setNsProfile(body);
    } catch { /* header facts are optional — the page stands without them */ }
  };

  // Every status counts here, not just draft/sent: Transactions is a ledger
  // of what this customer was quoted, so an accepted or rejected quote is
  // exactly as much a transaction as an open one.
  const WRAP_QUOTE_COLS = 'id, quote_number, vehicle_description, project_type, total, status, sent_at, created_at, netsuite_estimate_id';
  const ESTIMATE_COLS = 'id, estimate_number, title, status, grand_total, created_at, netsuite_estimate_id, netsuite_so_id';
  const TXN_PAGE_SIZE = 50;

  const loadQuotesAndEstimates = async (companyName: string | null, nsId: string | null) => {
    if (companyName) {
      const { data } = await supabase.from('wrap_quotes')
        .select(WRAP_QUOTE_COLS)
        .is('archived_at', null)
        .ilike('customer->>name', companyName)
        .order('created_at', { ascending: false }).limit(TXN_PAGE_SIZE);
      setWrapQuotes((data || []) as unknown as WrapQuoteRow[]);
    } else {
      setWrapQuotes([]);
    }
    // Estimates match precisely by NetSuite id, with a name fallback for
    // records created before the customer was linked. Two queries — .or()
    // can't safely carry free-text company names (commas break its syntax).
    const found = new Map<string, EstimateRow>();
    if (nsId) {
      const { data } = await supabase.from('estimates')
        .select(ESTIMATE_COLS)
        .eq('customer_netsuite_id', nsId)
        .order('created_at', { ascending: false }).limit(TXN_PAGE_SIZE);
      for (const e of (data || []) as unknown as EstimateRow[]) found.set(e.id, e);
    }
    if (companyName) {
      const { data } = await supabase.from('estimates')
        .select(ESTIMATE_COLS)
        .ilike('customer_name', companyName)
        .order('created_at', { ascending: false }).limit(TXN_PAGE_SIZE);
      for (const e of (data || []) as unknown as EstimateRow[]) found.set(e.id, e);
    }
    setEstimatesList([...found.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, TXN_PAGE_SIZE));

    // Graphics jobs that produced a NetSuite invoice — the FleetSuite record
    // behind an invoice row, so its number opens the job instead of dead-ending.
    if (nsId) {
      const { data } = await supabase.from('graphics_jobs')
        .select('id, job_number, title, netsuite_invoice_id')
        .eq('customer_netsuite_id', nsId)
        .not('netsuite_invoice_id', 'is', null)
        .order('created_at', { ascending: false }).limit(TXN_PAGE_SIZE);
      setGraphicsJobs((data || []) as GraphicsJobRow[]);
    } else {
      setGraphicsJobs([]);
    }
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

  // NetSuite's own PDF for a transaction (the document of record).
  const viewPdf = async (t: Txn) => {
    if (!t.nsId || !t.nsPdfType) return;
    setPdfBusy(t.key);
    const res = await openNetSuitePdf(t.nsPdfType, t.nsId);
    setPdfBusy(null);
    if (!res.ok) await dialog.alert(res.error || 'Could not open the PDF');
  };

  // Only NetSuite documents have a PDF to zip — quotes that never left
  // FleetSuite, and payments/credits, are skipped by the bulk download.
  const zippableTxns = (list: Txn[]) => list.filter(t => t.nsId && t.nsPdfType);
  const toggleDocSelected = (t: Txn) => {
    setSelectedDocKeys(prev => {
      const next = new Set(prev);
      if (next.has(t.key)) next.delete(t.key); else next.add(t.key);
      return next;
    });
  };
  const toggleAllDocsSelected = () => {
    const zippable = zippableTxns(sortedTxns);
    setSelectedDocKeys(prev =>
      zippable.length > 0 && zippable.every(t => prev.has(t.key))
        ? new Set()
        : new Set(zippable.map(t => t.key))
    );
  };
  // Fetch each selected document's PDF individually (capped concurrency) and
  // zip them client-side — mirrors src/app/(main)/invoices/bulk-download's
  // downloadZip(), which exists specifically because one server request
  // fetching+zipping every PDF hit Vercel's 60s limit around ~50 documents.
  const downloadSelectedPdfs = async () => {
    const items = zippableTxns(txns).filter(t => selectedDocKeys.has(t.key));
    if (items.length === 0) return;
    setBulkDownloading(true);
    setBulkError(null);
    try {
      const zip = new JSZip();
      const queue = [...items];
      const failed: string[] = [];
      let done = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (;;) {
          const doc = queue.shift();
          if (!doc) return;
          try {
            const res = await fetch(`/api/netsuite/pdf?type=${doc.nsPdfType}&id=${encodeURIComponent(doc.nsId!)}`);
            const data = await res.json();
            if (!data.success || !data.pdfBase64) throw new Error(data.error || 'PDF fetch failed');
            const prefix = doc.nsPdfType === 'invoice' ? 'INV' : doc.nsPdfType === 'salesOrder' ? 'SO' : 'EST';
            zip.file(`${prefix}-${doc.number}.pdf`, Uint8Array.from(atob(data.pdfBase64), ch => ch.charCodeAt(0)));
          } catch {
            failed.push(doc.number);
          }
          done++;
          setBulkProgress(`Fetching PDFs ${done}/${items.length}…`);
        }
      }));

      if (failed.length === items.length) {
        setBulkError('Every PDF fetch failed — check that NetSuite is reachable and try again.');
        return;
      }

      setBulkProgress('Zipping…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const custName = (prospect?.company_name || customer?.company_name || 'customer').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${custName}-documents.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (failed.length > 0) {
        setBulkError(`Downloaded ${items.length - failed.length} of ${items.length} — failed: ${failed.join(', ')}. Retry to fetch just the rest.`);
      } else {
        setSelectedDocKeys(new Set());
      }
    } catch (e: any) {
      setBulkError(e.message || 'Download failed');
    } finally {
      setBulkDownloading(false);
      setBulkProgress(null);
    }
  };

  // Company letterhead for statement documents — fetched on load so the
  // PDF/print click stays synchronous (popup blockers).
  const [letterhead, setLetterhead] = useState<CompanyLetterhead | null>(null);
  useEffect(() => { fetchCompanyLetterhead().then(setLetterhead); }, []);

  // ── Statement options (scope + date range → PDF / print / email) ────────
  const [stModalOpen, setStModalOpen] = useState(false);

  // ── General "email this customer" compose ──
  // The Email button and contact-row addresses used to be bare mailto:
  // links: the device's mail app composed from whichever account it
  // considered default (iCloud vs BMG on Apple devices) and FleetSuite
  // never saw the send. Now they open the standard compose screen —
  // server-side send from the company address, Reply-To the sender's BMG
  // login, logged to email_log, and recorded on this page's activity feed.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeSubjectKey, setComposeSubjectKey] = useState(0);
  // Credit-app invite rides the same compose flow: the flag makes the
  // server append its templated "Complete your credit application" CTA and
  // log the send as credit_app_invite (audit Stage 1 — staff previously
  // had no way to send the form's URL from inside the app).
  const [composeCreditApp, setComposeCreditApp] = useState(false);
  const openCompose = (to: string, creditApp = false) => {
    setComposeTo(to); setComposeSubject(''); setComposeCreditApp(creditApp);
    setComposeSubjectKey(k => k + 1); setComposeOpen(true);
  };

  // ?compose=1&to=… — the Contacts directory's email addresses land here
  // with the compose pre-opened (they were mailto: links before).
  const searchParams = useSearchParams();
  const composeParamHandled = useRef(false);
  useEffect(() => {
    if (composeParamHandled.current) return;
    if (searchParams.get('compose') !== '1') return;
    composeParamHandled.current = true;
    openCompose(searchParams.get('to') || '');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on arrival
  }, [searchParams]);

  const composeRequest = async (fields: EmailComposeFields, preview: boolean) => {
    const res = await fetch('/api/prospects/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prospectId: prospect?.id || null,
        customerId: customer?.id || null,
        netsuiteCustomerId: prospect?.netsuite_id || customer?.netsuite_id || null,
        emails: fields.emails,
        bccSelf: fields.bccSelf,
        subject: composeSubject,
        message: fields.message,
        includeCreditAppLink: composeCreditApp,
        preview,
      }),
    });
    return { res, data: await res.json() };
  };
  const fetchComposePreview = async (fields: EmailComposeFields) => {
    const { res, data } = await composeRequest(fields, true);
    return res.ok ? { preview: data } : { error: data.error || 'Preview failed' };
  };
  const sendCompose = async (fields: EmailComposeFields) => {
    const { res, data } = await composeRequest(fields, false);
    if (!res.ok || !data.success) { await dialog.alert(data.error || 'Email send failed'); return { ok: false }; }
    await dialog.alert(`Email sent to ${(data.to || []).join(', ')}${data.bcc?.length ? ` (bcc ${data.bcc.join(', ')})` : ''}.`);
    if (prospect) refreshFeed(prospect.id);
    return { ok: true };
  };

  // Viewer for a sent email off the activity feed (email_log.body_html).
  const [viewEmail, setViewEmail] = useState<{ subject: string | null; recipients: string[]; body_html: string | null; delivery_status: string; created_at: string } | null>(null);
  const openEmailView = async (emailLogId: string) => {
    const { data } = await supabase
      .from('email_log')
      .select('subject, recipients, body_html, delivery_status, created_at')
      .eq('id', emailLogId)
      .maybeSingle();
    if (data) setViewEmail(data as any);
    else await dialog.alert('Could not load this email.');
  };
  const [stScope, setStScope] = useState<StatementScope>('open');
  const [stFrom, setStFrom] = useState('');
  const [stTo, setStTo] = useState('');
  const [stWorking, setStWorking] = useState(false);
  // Standard compose screen for the statement email
  const [stEmailOpen, setStEmailOpen] = useState(false);
  // The statement send auto-attaches the statement PDF; the preview names it.
  const [stPdfName, setStPdfName] = useState<string | null>(null);

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

  // ── The Transactions ledger ────────────────────────────────────────────
  // FleetSuite records keyed by the NetSuite document they became, so the
  // NetSuite row can claim its origin (and the FleetSuite row can then drop
  // out instead of duplicating it).
  const originByNsDoc = useMemo(() => {
    const m = new Map<string, TxnOrigin>();
    for (const e of estimatesList || []) {
      const origin: TxnOrigin = {
        kind: 'estimate', id: e.id, number: e.estimate_number,
        url: deepLinks.estimate(e.id), pdfUrl: deepLinks.estimatePdf(e.id),
      };
      if (e.netsuite_estimate_id) m.set(`estimate-${e.netsuite_estimate_id}`, origin);
      if (e.netsuite_so_id) m.set(`salesOrder-${e.netsuite_so_id}`, origin);
    }
    for (const q of wrapQuotes || []) {
      if (!q.netsuite_estimate_id) continue;
      m.set(`estimate-${q.netsuite_estimate_id}`, {
        kind: 'wrapQuote', id: q.id, number: q.quote_number,
        url: deepLinks.wrapQuote(q.id), pdfUrl: deepLinks.wrapQuotePdf(q.id),
      });
    }
    for (const g of graphicsJobs || []) {
      if (!g.netsuite_invoice_id) continue;
      m.set(`invoice-${g.netsuite_invoice_id}`, {
        kind: 'graphicsJob', id: g.id, number: g.job_number || g.title || 'Graphics job',
        url: deepLinks.graphicsJob(g.id), pdfUrl: null,
      });
    }
    return m;
  }, [estimatesList, wrapQuotes, graphicsJobs]);

  const txns = useMemo<Txn[]>(() => {
    const rows: Txn[] = [];
    // NetSuite documents — the money and the status of record.
    const claimed = new Set<string>();
    for (const d of docs || []) {
      const originKey = `${d.type}-${d.id}`;
      const origin = originByNsDoc.get(originKey) || null;
      if (origin) claimed.add(`${origin.kind}-${origin.id}`);
      rows.push({
        key: `ns-${originKey}`,
        kind: d.type, typeLabel: d.typeLabel, number: d.number,
        date: d.date, dueDate: d.dueDate, status: d.status, statusNorm: d.statusNorm,
        daysPastDue: d.daysPastDue, total: d.total,
        nsId: d.id, nsPdfType: d.type, origin,
      });
    }
    // FleetSuite quotes that no loaded NetSuite document accounts for —
    // never pushed, or pushed into history this page hasn't paged in yet.
    for (const e of estimatesList || []) {
      if (claimed.has(`estimate-${e.id}`)) continue;
      rows.push({
        key: `fs-estimate-${e.id}`,
        kind: 'estimate', typeLabel: 'Estimate', number: e.estimate_number,
        date: e.created_at.slice(0, 10), dueDate: null,
        status: e.status.charAt(0).toUpperCase() + e.status.slice(1),
        statusNorm: 'other', daysPastDue: 0, total: e.grand_total || 0,
        nsId: null, nsPdfType: null,
        origin: {
          kind: 'estimate', id: e.id, number: e.estimate_number,
          url: deepLinks.estimate(e.id), pdfUrl: deepLinks.estimatePdf(e.id),
        },
      });
    }
    for (const q of wrapQuotes || []) {
      if (claimed.has(`wrapQuote-${q.id}`)) continue;
      rows.push({
        key: `fs-wrap-${q.id}`,
        kind: 'quote', typeLabel: 'Wrap Quote', number: q.quote_number,
        date: q.created_at.slice(0, 10), dueDate: null,
        status: q.status.charAt(0).toUpperCase() + q.status.slice(1),
        statusNorm: 'other', daysPastDue: 0, total: q.total || 0,
        nsId: null, nsPdfType: null,
        origin: {
          kind: 'wrapQuote', id: q.id, number: q.quote_number,
          url: deepLinks.wrapQuote(q.id), pdfUrl: deepLinks.wrapQuotePdf(q.id),
        },
      });
    }
    // Payments received + credit memos. NetSuite's PDF RESTlet only renders
    // invoices/SOs/estimates, so these carry no PDF button.
    for (const p of payments || []) {
      rows.push({
        key: `pay-${p.type}-${p.id}`,
        kind: p.type, typeLabel: p.type === 'credit' ? 'Credit' : 'Payment',
        number: p.tranid, date: p.date, dueDate: null,
        status: p.memo || '', statusNorm: 'other', daysPastDue: 0, total: p.amount,
        nsId: p.id, nsPdfType: null, origin: null,
      });
    }
    return rows;
  }, [docs, payments, estimatesList, wrapQuotes, originByNsDoc]);

  // Transactions: filter chips + search narrow the loaded set; headers sort it.
  const filteredTxns = useMemo(() => {
    let list = txns;
    if (docFilter !== 'all') {
      const kinds = TXN_FILTER_KINDS[docFilter];
      list = list.filter(t => kinds.includes(t.kind));
    }
    // "Open" is the superset, not a sibling of "Past due": a past-due invoice
    // is still open (NetSuite keeps it status 'A'), so the Open chip shows the
    // whole unpaid set and the Past due chip narrows it to the late ones. The
    // row badge still distinguishes them.
    if (docStatus === 'open') list = list.filter(t => t.statusNorm === 'open' || t.statusNorm === 'pastdue');
    else if (docStatus !== 'all') list = list.filter(t => t.statusNorm === docStatus);
    const q = docSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(t =>
        t.number.toLowerCase().includes(q)
        || t.status.toLowerCase().includes(q)
        || (t.origin?.number || '').toLowerCase().includes(q));
    }
    return list;
  }, [txns, docFilter, docStatus, docSearch]);
  const { sorted: sortedTxns, sort: docSort, toggle: toggleDocSort } = useTableSort(filteredTxns, TXN_SORT_COLS, { key: 'date', dir: 'desc' });
  const zippableShown = zippableTxns(sortedTxns);
  const selectedShown = zippableShown.filter(t => selectedDocKeys.has(t.key)).length;
  const allDocsSelected = zippableShown.length > 0 && selectedShown === zippableShown.length;
  const openBalance = stInvoices ? stInvoices.reduce((s, i) => s + i.unpaid, 0) : null;

  // Which CRM contact currently wears the star: the primary lives on
  // external_contacts, so a CRM row is primary when it IS that person
  // (samePerson — the same matcher the promote endpoint uses).
  const primaryExtContact = extContacts.find(c => c.is_primary) || null;
  const isPrimaryContact = (c: Contact) => !!primaryExtContact && samePerson(primaryExtContact, c);
  // External contacts with no CRM twin — typically auto-created from an
  // inbound text. The star can't reach them, so the notifications box keeps
  // its own picker for exactly these.
  const extContactsWithoutCrmRow = extContacts.filter(e => !contacts.some(c => samePerson(e, c)));

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
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>No customer record or synced NetSuite customer matches this link.</div>
        <button onClick={() => router.push('/admin/prospects')} style={{ ...btnSm, marginTop: '14px' }}>‹ Back to Customers</button>
      </div>
    );
  }

  const name = prospect?.company_name || customer?.company_name || 'Unknown';
  const isVendor = prospect?.record_type === 'vendor';
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
        <button onClick={() => router.push('/admin/prospects')} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', padding: 0, marginBottom: '8px' }}>‹ Customers</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.5px', color: 'var(--text-primary)' }}>{name}</div>
          {prospect ? (
            isVendor ? (
              <span title="Supplier/partner contact — FleetSuite only, never created in NetSuite as a customer" style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'rgba(167,139,250,0.12)', color: '#a78bfa' }}>Vendor</span>
            ) : !prospect.netsuite_id && (
              <span title="A lead lives in FleetSuite only — promote it below, or it promotes itself when its first estimate is pushed to NetSuite" style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'rgba(96,165,250,0.12)', color: '#60a5fa' }}>Lead</span>
            )
          ) : (
            <span style={{ fontSize: '10px', fontWeight: 800, padding: '3px 9px', borderRadius: '999px', background: 'var(--warning-bg)', color: 'var(--warning)' }}>Not tracked</span>
          )}
          {/* Segmentation tags live here, by the name — ONE control, the
              industry vocabulary (customer_tags). The free-form chip input
              that used to sit here is gone: free text defeats segmentation
              (migration 187's own rationale for the vocabulary), and having
              both on this screen meant two places to tag the same customer.

              Industry only for now. The 'partner' kind still exists in the
              vocabulary and any partner tags already applied still show and
              can be removed — the picker just doesn't offer them, so
              bringing partner back is re-adding its optgroup, not a
              migration.

              Existing prospect_tags likewise show and can still be removed,
              they just can't be added any more: some are auto-generated
              ('multilocation' on a multi-location create) and the Customers
              list still filters on them, so hiding them would strand a
              filter with no visible cause. */}
          {custTags.map(t => (
            <button key={t.tag_id} onClick={() => removeCustTag(t.tag_id)} title={`${t.kind} tag — click to remove`}
              style={{
                fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px', cursor: 'pointer',
                background: t.kind === 'partner' ? 'rgba(167,139,250,0.1)' : 'rgba(96,165,250,0.1)',
                border: `1px solid ${t.kind === 'partner' ? 'rgba(167,139,250,0.3)' : 'rgba(96,165,250,0.3)'}`,
                color: t.kind === 'partner' ? '#a78bfa' : '#60a5fa',
              }}>
              {t.label} ✕
            </button>
          ))}
          {tags.map(t => prospect ? (
            <button key={t.id} onClick={() => removeTag(t)} title="Older free-form tag — click to remove (new tags come from the + tag list)" style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', cursor: 'pointer' }}>{t.tag} ✕</button>
          ) : (
            <span key={t.id} style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '999px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>{t.tag}</span>
          ))}
          {customer ? (
            <select value="" onChange={e => {
              const v = e.target.value;
              if (v === '__new_industry') addVocabValue('industry');
              else if (v) addCustTag(v);
            }} style={{ ...cInput, width: 'auto', padding: '3px 6px', fontSize: '10.5px' }}>
              <option value="">+ industry</option>
              {vocab.filter(v => v.kind === 'industry' && !custTags.some(t => t.tag_id === v.id)).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
              {isAdmin && <option value="__new_industry">+ New industry value…</option>}
            </select>
          ) : prospect && !isVendor ? (
            /* Tags hang off the customer record, which only exists once
               this prospect is in NetSuite — say so rather than leaving a
               blank where the control used to be. Vendors never become
               NetSuite customers, so they get no note. */
            <span title="Industry tags attach to the NetSuite customer record" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
              Tagging available once it&apos;s in NetSuite
            </span>
          ) : null}
        </div>
        {(prospect?.contact_name || customer?.entity_id) && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            {prospect?.contact_name}{prospect?.contact_name && customer?.entity_id ? ' · ' : ''}{customer?.entity_id ? `NetSuite ${customer.entity_id}` : ''}
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' }}>
          {phone && <a href={`tel:${phone}`} style={btnSm}>{phone}</a>}
          {email && (
            <button onClick={() => openCompose(email)}
              title="Email this record from FleetSuite — sends from the company address with replies to your inbox, and lands on the activity history"
              style={btnSm}>Email</button>
          )}
          {!isVendor && (
            <button onClick={() => openCompose(email || '', true)}
              title="Email the net-terms credit application form — the message gets a Complete-your-credit-application button linking to the public form"
              style={btnSm}>Credit App</button>
          )}
          {prospect && <button onClick={openEdit} title="Edit company details, lead source, and notes" style={btnSm}>✎ Edit</button>}
          {prospect && !prospect.netsuite_id && !isVendor && (
            <button onClick={addToNetSuite} disabled={converting} title="Promote this lead: create the NetSuite customer and link it (also happens automatically when the lead's first estimate is pushed)" style={{ ...btnSm, opacity: converting ? 0.6 : 1 }}>
              {converting ? 'Promoting…' : 'Promote to NetSuite Customer'}
            </button>
          )}
          {!prospect && customer && (
            <button onClick={addToCrm} disabled={addingToCrm} title="Create a record for this NetSuite customer so contacts, deals, and activity can be tracked here" style={btnSm}>
              {addingToCrm ? 'Adding…' : '+ Add Record'}
            </button>
          )}
          {(customer || (prospect && !prospect.netsuite_id)) && !isVendor && (
            <button onClick={() => router.push(customer ? deepLinks.newEstimate(customer.id) : deepLinks.newEstimate(null, prospect!.id))}
              title="Start a new estimate with this customer pre-selected"
              style={btnSm}>
              + New Estimate
            </button>
          )}
          {(prospect?.netsuite_id || customer) && !stError && (
            <button onClick={() => setStModalOpen(true)}
              title="Open, print, or email a statement — choose open items or all invoices, with an optional date range"
              style={{ ...btnSm, color: 'var(--text-primary)' }}>
              Statement
            </button>
          )}
          {nsUrl && <a href={nsUrl} target="_blank" rel="noopener noreferrer" style={btnSm}>NetSuite ↗</a>}
        </div>
        {prospect && (
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' }}>
            <button onClick={() => toggleFlag('is_hot')} style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: prospect.is_hot ? 'rgba(239,68,68,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.is_hot ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`, color: prospect.is_hot ? '#ef4444' : 'var(--text-muted)',
            }}>{prospect.is_hot ? 'Hot' : 'Mark Hot'}</button>
            <button onClick={() => toggleFlag('email_campaign')}
              title="Adds this customer to the email-campaign distribution list — see it on the Customers page via Filter → Email Campaign (it's in the Excel export too)"
              style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: prospect.email_campaign ? 'rgba(59,130,246,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.email_campaign ? 'rgba(59,130,246,0.25)' : 'var(--border)'}`, color: prospect.email_campaign ? '#60a5fa' : 'var(--text-muted)',
            }}>{prospect.email_campaign ? '✓ Email Campaign' : 'Email Campaign'}</button>
            <button onClick={() => toggleFlag('multi_location')} style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: prospect.multi_location ? 'rgba(251,191,36,0.1)' : 'var(--subtle-bg)', border: `1px solid ${prospect.multi_location ? 'rgba(251,191,36,0.25)' : 'var(--border)'}`, color: prospect.multi_location ? '#f59e0b' : 'var(--text-muted)',
            }}>{prospect.multi_location ? '✓ Multi-Location' : 'Multi-Location'}</button>
            <span style={{ flex: 1 }} />
            <button onClick={exportPdf} title="Download a printable PDF summary of this record" style={{
              padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
              background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#60a5fa',
            }}>Export PDF</button>
          </div>
        )}
      </div>

      {/* Spend KPIs (NetSuite) — a vendor has no spend history by design,
          so it gets neither the KPIs nor the "not linked yet" nudge. */}
      {m ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px' }}>
          <Kpi label="YTD spend" value={fmtMoney(m.ytd_spend || 0)} sub={`${m.ytd_orders || 0} orders this year`} />
          <Kpi label="Total spend" value={fmtMoney(m.total_spend || 0)} sub={`${m.total_orders || 0} orders all time`} />
          <Kpi label="Avg order" value={fmtMoney(m.avg_order_value || 0)} sub={m.last_year_spend ? `${fmtMoney(m.last_year_spend)} last year` : undefined} />
          <Kpi label="Last order" value={fmtDate(m.last_order_date)} />
        </div>
      ) : !isVendor && (
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
            {customer && (
              <div style={{ ...infoRow, alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Parent account</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {parentRef ? (
                    <>
                      <a href={`/admin/prospects/ns-${parentRef.netsuite_id}`} style={{ color: '#60a5fa', fontWeight: 700, textDecoration: 'none', fontSize: '12.5px' }}>
                        {parentRef.company_name || parentRef.netsuite_id}
                      </a>
                      <span title={parentRef.source === 'manual' ? 'Assigned here (survives NetSuite resync)' : 'From the NetSuite customer hierarchy'}
                        style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                        {parentRef.source === 'manual' ? 'manual' : 'NetSuite'}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>None</span>
                  )}
                  <button onClick={() => setParentPickerOpen(true)} title="Assign to a parent account / leasing company"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '0 2px' }}>✎</button>
                </span>
              </div>
            )}
            {customer && (
              <div style={{ ...infoRow, alignItems: 'center' }}>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>Sales rep</span>
                <select value={customer.account_owner_id || ''} onChange={e => setSalesRep(e.target.value)}
                  style={{ ...cInput, width: 'auto', maxWidth: '58%', padding: '4px 8px', fontSize: '11.5px' }}>
                  <option value="">Unassigned</option>
                  {salesReps.map(r => <option key={r.id} value={r.id}>{r.full_name}</option>)}
                </select>
              </div>
            )}
            {prospect?.notes && (
              <div style={{ marginTop: '10px', padding: '10px 12px', borderRadius: '9px', background: 'var(--subtle-bg)', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{prospect.notes}</div>
            )}
            {!email && !phone && !address && !prospect?.notes && !customer && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing on file.</div>}
          </div>

          {/* Billing (K3) — how invoices reach this customer. Read by the
              Email Invoices modal on every invoice surface. */}
          {customer && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ ...eyebrow, marginBottom: 0 }}>Billing</div>
                {billDirty && (
                  <button onClick={saveBilling} disabled={billSaving}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#22c55e', padding: 0, opacity: billSaving ? 0.6 : 1 }}>
                    {billSaving ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                <select value={billForm.workflow} onChange={e => { setBillForm(f => ({ ...f, workflow: e.target.value })); setBillDirty(true); }} style={cInput}>
                  <option value="">Workflow not set</option>
                  {Object.entries(BILLING_WORKFLOWS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                {billForm.workflow === 'po_portal' && (
                  <input style={cInput} placeholder="Portal name (e.g. Masterack, Bogle) *" value={billForm.portal}
                    onChange={e => { setBillForm(f => ({ ...f, portal: e.target.value })); setBillDirty(true); }} />
                )}
                <textarea style={{ ...cInput, resize: 'vertical', fontFamily: 'inherit' }} rows={2}
                  placeholder="Billing notes — portal URL, required fields, cadence…"
                  value={billForm.notes} onChange={e => { setBillForm(f => ({ ...f, notes: e.target.value })); setBillDirty(true); }} />
                {billForm.workflow === 'po_portal' && (
                  <div style={{ fontSize: '10.5px', color: '#fbbf24' }}>
                    Invoice emails for this customer will warn staff to submit in the portal instead.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Sub-accounts (K1) — children by manual link or NetSuite hierarchy,
              with consolidated spend and each child's contacts. */}
          {customer && children.length > 0 && (
            <div style={card}>
              <div style={eyebrow}>Sub-accounts · {children.length}</div>
              {(() => {
                const kidYtd = children.reduce((s, k) => s + (k.ytd_spend || 0), 0);
                const kidTotal = children.reduce((s, k) => s + (k.total_spend || 0), 0);
                return (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                    Combined incl. this account:{' '}
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney((m?.ytd_spend || 0) + kidYtd)}</strong> YTD ·{' '}
                    <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtMoney((m?.total_spend || 0) + kidTotal)}</strong> all time
                  </div>
                );
              })()}
              {children.map(k => (
                <div key={k.id} style={{ padding: '7px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '12.5px', alignItems: 'baseline' }}>
                    <a href={`/admin/prospects/ns-${k.netsuite_id}`} style={{ color: '#60a5fa', fontWeight: 700, textDecoration: 'none' }}>
                      {k.company_name || k.netsuite_id}
                    </a>
                    <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {fmtMoney(k.ytd_spend || 0)} YTD · {fmtMoney(k.total_spend || 0)} total
                    </span>
                  </div>
                  {(childContacts[k.id] || []).length > 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {(childContacts[k.id] || []).map(c => `${c.name}${c.phone ? ` (${c.phone})` : c.email ? ` (${c.email})` : ''}`).join(' · ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ ...eyebrow, marginBottom: 0 }}>Contacts {contacts.length > 0 && <span style={{ fontWeight: 600 }}>· {contacts.length}</span>}</div>
              {prospect && (
                <button onClick={() => (cFormOpen && !cEditId ? setCFormOpen(false) : openContactForm())} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: 0 }}>
                  {cFormOpen && !cEditId ? 'Cancel' : '+ Add'}
                </button>
              )}
            </div>
            {customer && (
              <div style={{ margin: '8px 0 2px', padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', fontSize: '12px' }}>
                <div style={{ fontSize: '9.5px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', marginBottom: '3px' }}>Primary contact — notifications</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  {primaryExtContact ? (
                    <span style={{ fontWeight: 700, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                      ★ {primaryExtContact.name}{primaryExtContact.phone ? ` · ${primaryExtContact.phone}` : ''}{primaryExtContact.email ? ` · ${primaryExtContact.email}` : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>
                      No primary set — star a contact below{contacts.length === 0 ? ' (add one first)' : ''}.
                    </span>
                  )}
                  {/* Only external contacts the star can't reach (no CRM row —
                      usually created by an inbound text) need this picker. */}
                  {extContactsWithoutCrmRow.filter(c => !c.is_primary).length > 0 && (
                    <select value="" onChange={e => setPrimaryContact(e.target.value)}
                      title="Contacts we've texted or emailed that aren't in the CRM list below"
                      style={{ ...cInput, width: 'auto', padding: '3px 6px', fontSize: '10.5px' }}>
                      <option value="">from messages…</option>
                      {extContactsWithoutCrmRow.filter(c => !c.is_primary).map(c => <option key={c.id} value={c.id}>{c.name || c.phone || c.email}</option>)}
                    </select>
                  )}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '3px' }}>Estimate approvals, pickup notices, and SMS threads go to this contact.</div>
              </div>
            )}
            {cFormOpen && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', margin: '10px 0 4px', padding: '10px', background: 'var(--subtle-bg)', borderRadius: '9px' }}>
                <input style={cInput} placeholder="Name (First Last) *" value={cForm.name} onChange={e => setCForm({ ...cForm, name: e.target.value })} />
                <input style={cInput} placeholder="Title" value={cForm.title} onChange={e => setCForm({ ...cForm, title: e.target.value })} />
                <input style={cInput} type="email" placeholder="Email" value={cForm.email} onChange={e => setCForm({ ...cForm, email: e.target.value })} />
                <PhoneInput style={cInput} placeholder="Phone" value={cForm.phone} onChange={v => setCForm({ ...cForm, phone: v })} />
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', gridColumn: '1 / -1' }}>
                  <input type="checkbox" checked={cForm.is_decision_maker} onChange={e => setCForm({ ...cForm, is_decision_maker: e.target.checked })} />
                  Key decision maker
                </label>
                <label
                  title={customer
                    ? 'Estimate approvals, pickup notices and SMS threads go to the primary contact. Only one contact can hold it.'
                    : 'Promote this record to a NetSuite customer first — the primary contact is stored against the customer.'}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: customer ? 'var(--text-secondary)' : 'var(--text-muted)', gridColumn: '1 / -1' }}>
                  <input type="checkbox" disabled={!customer} checked={cPrimary} onChange={e => setCPrimary(e.target.checked)} />
                  Primary contact — notifications go here
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
                    {isPrimaryContact(c) && <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#f59e0b', marginLeft: '6px' }}>★ PRIMARY</span>}
                    {c.is_decision_maker && <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#f59e0b', marginLeft: '6px' }}>DM</span>}
                    {c.title && <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginLeft: '6px' }}>{c.title}</span>}
                  </span>
                  {prospect && !isPrimaryContact(c) && (
                    <button
                      onClick={() => { if (!primaryBusy) makeContactPrimary(c); }}
                      disabled={!!primaryBusy}
                      title={customer
                        ? `Make ${c.name} the primary contact — estimate approvals, pickup notices and SMS threads go to this person`
                        : 'Promote this record to a NetSuite customer first — the primary contact is stored against the customer'}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px', flexShrink: 0, opacity: primaryBusy === c.id ? 0.5 : 1 }}
                    >☆</button>
                  )}
                  {prospect && (
                    <button onClick={() => openContactForm(c)} title={`Edit ${c.name}${c.netsuite_contact_id ? ' (linked to NetSuite)' : ''}`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px', padding: '2px 4px', flexShrink: 0 }}>✎</button>
                  )}
                </div>
                {(c.phone || c.email) && (
                  <div style={{ display: 'flex', gap: '14px', marginTop: '3px', fontSize: '12px' }}>
                    {c.phone && <a href={`tel:${c.phone}`} style={{ color: '#22c55e', textDecoration: 'none', fontWeight: 600 }}>{c.phone}</a>}
                    {c.email && (
                      <button onClick={() => openCompose(c.email!)} title="Email this contact from FleetSuite"
                        style={{ color: '#60a5fa', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'inherit', textAlign: 'left' }}>
                        {c.email}
                      </button>
                    )}
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
          <div style={card}>
            <div style={eyebrow}>Prior artwork — Dropbox</div>
            <DropboxProofSearch defaultQuery={name} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <div style={{ ...eyebrow, marginBottom: 0 }}>Deals {openDeals.length > 0 && <span style={{ fontWeight: 600 }}>· {openDeals.length} open</span>}</div>
              {prospect && (
                <button onClick={() => setOppFormOpen(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: 0 }}>
                  {oppFormOpen ? 'Cancel' : '+ Add'}
                </button>
              )}
            </div>
            {oppFormOpen && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', margin: '10px 0 4px', padding: '10px', background: 'var(--subtle-bg)', borderRadius: '9px' }}>
                <input style={{ ...cInput, gridColumn: '1 / -1' }} placeholder="Deal title *" value={oppForm.title} onChange={e => setOppForm({ ...oppForm, title: e.target.value })} />
                <select style={cInput} value={oppForm.type} onChange={e => setOppForm({ ...oppForm, type: e.target.value })}>
                  {Object.entries(OPP_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input type="number" style={cInput} placeholder="Est. value $" value={oppForm.value} onChange={e => setOppForm({ ...oppForm, value: e.target.value })} />
                <input type="date" style={cInput} value={oppForm.expected_close_date} onChange={e => setOppForm({ ...oppForm, expected_close_date: e.target.value })} title="Expected close date" />
                <button onClick={addOpportunity} disabled={oppSaving || !oppForm.title.trim()} style={{
                  padding: '8px', borderRadius: '7px', fontSize: '11.5px', fontWeight: 700,
                  background: oppForm.title.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none',
                  cursor: oppForm.title.trim() ? 'pointer' : 'default', opacity: oppSaving ? 0.6 : 1,
                }}>{oppSaving ? 'Adding…' : 'Add deal'}</button>
              </div>
            )}
            {opportunities.length === 0 && !oppFormOpen && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>{prospect ? 'No deals yet.' : '—'}</div>}
            {[...openDeals, ...closedDeals].map(o => (
              <div key={o.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: '12.5px', fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {o.title}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · {OPP_TYPES[o.type] || o.type}</span>
                  </span>
                  {!prospect && (
                    <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '999px', flexShrink: 0, background: `${STAGE_COLORS[o.stage] || '#60a5fa'}1f`, color: STAGE_COLORS[o.stage] || '#60a5fa' }}>{OPP_STAGES[o.stage] || o.stage}</span>
                  )}
                  <span style={{ fontSize: '12.5px', fontWeight: 800, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{o.value ? fmtMoney(o.value) : '—'}</span>
                </div>
                {prospect && (
                  <div style={{ display: 'flex', gap: '3px', marginTop: '5px', flexWrap: 'wrap' }}>
                    {Object.entries(OPP_STAGES).map(([k, v]) => (
                      <button key={k} onClick={() => setOppStage(o, k)} disabled={o.stage === k} style={{
                        padding: '2px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 700,
                        background: o.stage === k ? `${STAGE_COLORS[k]}33` : 'transparent',
                        border: `1px solid ${o.stage === k ? STAGE_COLORS[k] : 'var(--border)'}`,
                        color: o.stage === k ? STAGE_COLORS[k] : 'var(--text-muted)', cursor: o.stage === k ? 'default' : 'pointer',
                      }}>{v}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {(prospect || reminders.length > 0) && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: reminders.length > 0 || remFormOpen ? '6px' : 0 }}>
                <div style={{ ...eyebrow, marginBottom: 0 }}>Reminders{reminders.length > 0 ? ` · ${reminders.length}` : ''}</div>
                <span style={{ flex: 1 }} />
                {prospect && (
                  <button onClick={() => setRemFormOpen(v => !v)} title="Set a follow-up reminder — it shows here and on the Schedule calendar" style={{
                    padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                    background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.25)', color: '#f59e0b',
                  }}>{remFormOpen ? 'Cancel' : '+ Reminder'}</button>
                )}
              </div>
              {remFormOpen && (
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <input
                    value={remForm.title} onChange={e => setRemForm({ ...remForm, title: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') addReminder(); }}
                    placeholder="Call about the upfit quote…" autoFocus
                    style={{ flex: '1 1 180px', minWidth: 0, padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                  />
                  <input type="date" value={remForm.date} onChange={e => setRemForm({ ...remForm, date: e.target.value })}
                    style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <input type="time" value={remForm.time} onChange={e => setRemForm({ ...remForm, time: e.target.value })} title="Optional — defaults to 9:00 AM"
                    style={{ padding: '8px 10px', borderRadius: '8px', fontSize: '12px', background: 'var(--input-bg)', border: '1px solid var(--border)', color: 'var(--text-primary)' }} />
                  <button onClick={addReminder} disabled={remSaving || !remForm.title.trim() || !remForm.date} style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: remForm.title.trim() && remForm.date ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none',
                    cursor: remForm.title.trim() && remForm.date ? 'pointer' : 'default', opacity: remSaving ? 0.6 : 1,
                  }}>{remSaving ? 'Saving…' : 'Set reminder'}</button>
                </div>
              )}
              {reminders.length === 0 && !remFormOpen && (
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '6px' }}>No reminders — set one to follow up (it also shows on the Schedule calendar).</div>
              )}
              {reminders.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
                  <span style={{ fontWeight: 700, flexShrink: 0, color: new Date(r.due_at) < new Date() ? 'var(--error)' : 'var(--text-primary)' }}>{fmtDate(r.due_at.slice(0, 10))}</span>
                  <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)' }}>{r.title}</span>
                  {prospect && (
                    <button onClick={() => completeReminder(r)} title="Mark this reminder done" style={{
                      padding: '3px 10px', borderRadius: '5px', fontSize: '10px', fontWeight: 700, flexShrink: 0,
                      background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', cursor: 'pointer',
                    }}>Done</button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={card}>
            <div style={eyebrow}>Recent activity</div>
            {prospect && (
              <div style={{ marginBottom: '10px' }}>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '6px' }}>
                  {([['call', 'Call'], ['email', 'Email'], ['note', 'Note'], ['meeting', 'Meeting']] as const).map(([k, label]) => (
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
                  {recording ? (
                    <button onClick={stopVoiceNote} title="Stop recording and save" style={{
                      padding: '8px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', cursor: 'pointer',
                    }}>■ Stop</button>
                  ) : (
                    <button onClick={startVoiceNote} disabled={voiceProcessing} title="Voice note — AI files it as activity and creates any reminders you mention" style={{
                      padding: '8px 12px', borderRadius: '8px', fontSize: '12px',
                      background: 'var(--subtle-bg)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)',
                      cursor: 'pointer', opacity: voiceProcessing ? 0.6 : 1,
                    }}>Voice note</button>
                  )}
                </div>
                {voiceProcessing && (
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 600, marginTop: '5px' }}>AI is parsing your note and creating reminders…</div>
                )}
                {voiceResult && (
                  <div style={{ padding: '6px 10px', borderRadius: '6px', marginTop: '5px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', fontSize: '10.5px', color: '#22c55e', fontWeight: 600 }}>
                    Saved: {voiceResult.summary.slice(0, 80)}{voiceResult.summary.length > 80 ? '…' : ''}{voiceResult.reminders > 0 ? ` · ${voiceResult.reminders} reminder${voiceResult.reminders !== 1 ? 's' : ''} created` : ''}
                  </div>
                )}
              </div>
            )}
            {activities.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{prospect ? 'No activity logged yet.' : '—'}</div>}
            {activities.map(a => (
              <div key={a.id} style={{ display: 'flex', gap: '8px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
                <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)' }}>
                  {a.summary}
                  {a.email_log_id && (
                    <button onClick={() => openEmailView(a.email_log_id!)}
                      title="View the email that was sent"
                      style={{ marginLeft: '6px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px', fontWeight: 700, color: '#60a5fa' }}>
                      View email
                    </button>
                  )}
                </span>
                <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontSize: '11px', textAlign: 'right' }}>
                  {a.creator_name ? `${a.creator_name} · ` : ''}{timeAgo(a.created_at)}
                </span>
              </div>
            ))}
            {prospect && actsHasMore && (
              <button onClick={loadMoreActivities} disabled={actsLoadingMore} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px', fontWeight: 700, color: '#60a5fa', padding: '8px 0 0', opacity: actsLoadingMore ? 0.6 : 1 }}>
                {actsLoadingMore ? 'Loading…' : 'Show older activity ↓'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Transactions — ONE ledger for this customer: NetSuite documents,
          FleetSuite quotes & estimates, and payments & credits. A quote
          built here and pushed to NetSuite is a single row (the NetSuite
          document, tagged with the FleetSuite record it came from), whose
          number opens that exact record and which offers both PDFs. */}
      {(prospect?.netsuite_id || customer || txns.length > 0) && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
            <div style={{ ...eyebrow, marginBottom: 0 }}>Transactions {txns.length > 0 ? `· ${txns.length}${docsHasMore ? '+' : ''}` : ''}</div>
            {openBalance !== null && stInvoices && stInvoices.length > 0 && (
              <span style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                · open balance <strong style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{usd2(openBalance)}</strong> ({stInvoices.length} invoice{stInvoices.length === 1 ? '' : 's'})
              </span>
            )}
            <span style={{ flex: 1 }} />
            {TXN_FILTERS.map(([f, label]) => (
              <button key={f} onClick={() => setDocFilter(f)} style={{
                padding: '4px 10px', borderRadius: '999px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                background: docFilter === f ? 'var(--tab-active-bg)' : 'transparent',
                border: `1px solid ${docFilter === f ? 'var(--tab-active-border)' : 'var(--border)'}`,
                color: docFilter === f ? 'var(--text-primary)' : 'var(--text-muted)',
              }}>{label}</button>
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
          {paymentsNote && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5, padding: '2px 0 6px' }}>
              {/restlet/i.test(paymentsNote)
                ? <><span style={{ color: 'var(--warning)', fontWeight: 700 }}>Payments &amp; credits need the updated NetSuite RESTlet.</span> {paymentsNote}</>
                : `Payments & credits unavailable — ${paymentsNote}`}
            </div>
          )}
          {!docs && !docsError && (prospect?.netsuite_id || customer) && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading transactions…</div>}
          {(docs || txns.length > 0) && sortedTxns.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No transactions match.</div>}
          {sortedTxns.length > 0 && (
            <>
              {zippableShown.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' }}>
                  <button onClick={toggleAllDocsSelected} title="Select every NetSuite document shown — quotes that never left FleetSuite and payments have no NetSuite PDF to zip" style={{ ...btnSm, padding: '4px 10px' }}>
                    {allDocsSelected ? 'Deselect all' : 'Select all'} ({selectedShown}/{zippableShown.length})
                  </button>
                  {selectedDocKeys.size > 0 && (
                    <button onClick={downloadSelectedPdfs} disabled={bulkDownloading} style={{ ...btnSm, padding: '4px 10px', background: 'var(--success)', color: '#fff', border: 'none', opacity: bulkDownloading ? 0.6 : 1 }}>
                      {bulkDownloading ? (bulkProgress || 'Preparing…') : `Download ${selectedDocKeys.size} PDF${selectedDocKeys.size === 1 ? '' : 's'} as ZIP`}
                    </button>
                  )}
                  {bulkError && <span style={{ fontSize: '11px', color: 'var(--error)' }}>{bulkError}</span>}
                </div>
              )}
              <div className="responsive-table">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={docTh}>
                        <input type="checkbox" checked={allDocsSelected} onChange={toggleAllDocsSelected} disabled={zippableShown.length === 0} style={{ cursor: zippableShown.length === 0 ? 'default' : 'pointer' }} />
                      </th>
                      <SortableTh label="Type" sortKey="type" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                      <SortableTh label="Number" sortKey="number" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                      <SortableTh label="Source" sortKey="source" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                      <SortableTh label="Date" sortKey="date" sort={docSort} onToggle={toggleDocSort} defaultDir="desc" style={docTh} />
                      <SortableTh label="Due" sortKey="due" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                      <SortableTh label="Status" sortKey="status" sort={docSort} onToggle={toggleDocSort} style={docTh} />
                      <SortableTh label="Amount" sortKey="amount" sort={docSort} onToggle={toggleDocSort} defaultDir="desc" align="right" style={docTh} />
                      <th style={docTh} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTxns.map(t => (
                      <tr key={t.key}>
                        <td style={docTd}>
                          {t.nsId && t.nsPdfType
                            ? <input type="checkbox" checked={selectedDocKeys.has(t.key)} onChange={() => toggleDocSelected(t)} style={{ cursor: 'pointer' }} />
                            : null}
                        </td>
                        <td style={docTd}>
                          <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', display: 'inline-block', minWidth: '76px', textAlign: 'center', background: TXN_BADGE[t.kind].bg, color: TXN_BADGE[t.kind].color }}>{t.typeLabel}</span>
                        </td>
                        <td style={{ ...docTd, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{t.number}</td>
                        <td style={{ ...docTd, whiteSpace: 'nowrap' }}>
                          {/* Built in FleetSuite? The link opens THAT record —
                              the estimate, wrap quote or graphics job — not the
                              list page it lives on. */}
                          {t.origin ? (
                            <button
                              onClick={() => router.push(t.origin!.url)}
                              title={`Open ${ORIGIN_LABEL[t.origin.kind]} ${t.origin.number} in FleetSuite`}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11.5px', fontWeight: 700, color: '#60a5fa' }}
                            >
                              {t.origin.number} ›
                            </button>
                          ) : (
                            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>NetSuite</span>
                          )}
                        </td>
                        <td style={{ ...docTd, whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                        <td style={{ ...docTd, whiteSpace: 'nowrap' }}>{fmtDate(t.dueDate)}</td>
                        <td style={docTd}>
                          {t.statusNorm === 'pastdue' ? (
                            <span style={{ fontSize: '10.5px', fontWeight: 800, color: 'var(--error)', whiteSpace: 'nowrap' }}>{t.daysPastDue}d past due</span>
                          ) : t.statusNorm === 'open' ? (
                            <span style={{ fontSize: '10.5px', fontWeight: 800, color: '#60a5fa' }}>Open</span>
                          ) : t.statusNorm === 'paid' ? (
                            <span style={{ fontSize: '10.5px', fontWeight: 800, color: 'var(--success)' }}>Paid</span>
                          ) : (
                            <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{t.status || '—'}</span>
                          )}
                        </td>
                        <td style={{ ...docTd, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usd2(t.total)}</td>
                        <td style={{ ...docTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', gap: '6px', justifyContent: 'flex-end' }}>
                            {t.nsId && t.nsPdfType && (
                              <button onClick={() => viewPdf(t)} disabled={pdfBusy === t.key} title="Open NetSuite's PDF — the document of record" style={{ ...btnSm, padding: '4px 10px', opacity: pdfBusy === t.key ? 0.6 : 1 }}>
                                {pdfBusy === t.key ? '…' : 'NetSuite PDF'}
                              </button>
                            )}
                            {t.origin?.pdfUrl && (
                              <a
                                href={deepLinks.pdfViewer(t.origin.pdfUrl, {
                                  name: `${t.origin.number}.pdf`,
                                  back: deepLinks.prospect(String(params?.id || '')),
                                  backLabel: 'Back to customer',
                                })}
                                target="_blank" rel="noopener noreferrer"
                                title={`Open the FleetSuite ${ORIGIN_LABEL[t.origin.kind]} PDF`}
                                style={{ ...btnSm, padding: '4px 10px' }}
                              >
                                FleetSuite PDF
                              </a>
                            )}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {docs && docsHasMore && (
            <button onClick={() => { const ns = prospect?.netsuite_id || customer?.netsuite_id; if (ns) loadDocs(ns, true); }} disabled={docsLoading} style={{ ...btnSm, marginTop: '10px' }}>
              {docsLoading ? 'Loading…' : 'Load more history'}
            </button>
          )}
        </div>
      )}

      {/* Edit record */}
      {editOpen && prospect && (
        <div onClick={() => !editSaving && setEditOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit record"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', width: 'min(560px, 100%)', maxHeight: 'calc(90vh / var(--ts))', overflowY: 'auto' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>Edit record</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              <input style={{ ...cInput, gridColumn: '1 / -1' }} placeholder="Company name *" value={editForm.company_name} onChange={e => setEditForm({ ...editForm, company_name: e.target.value })} />
              <input style={cInput} placeholder="Contact name" value={editForm.contact_name} onChange={e => setEditForm({ ...editForm, contact_name: e.target.value })} />
              <PhoneInput style={cInput} placeholder="Phone" value={editForm.phone} onChange={v => setEditForm({ ...editForm, phone: v })} />
              <input style={cInput} type="email" placeholder="Email" value={editForm.email} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
              <input style={cInput} placeholder="Website" value={editForm.website} onChange={e => setEditForm({ ...editForm, website: e.target.value })} />
              <input style={{ ...cInput, gridColumn: '1 / -1' }} placeholder="Street address" value={editForm.address} onChange={e => setEditForm({ ...editForm, address: e.target.value })} />
              <input style={cInput} placeholder="City" value={editForm.city} onChange={e => setEditForm({ ...editForm, city: e.target.value })} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <input style={cInput} placeholder="State" value={editForm.state} onChange={e => setEditForm({ ...editForm, state: e.target.value })} />
                <input style={cInput} placeholder="Zip" value={editForm.zip} onChange={e => setEditForm({ ...editForm, zip: e.target.value })} />
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Lead source</div>
                <select style={cInput} value={editForm.lead_source} onChange={e => setEditForm({ ...editForm, lead_source: e.target.value })}>
                  <option value="">— Select —</option>
                  {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                {editForm.lead_source === 'Other' && (
                  <input style={{ ...cInput, marginTop: '4px' }} placeholder="Specify source…" value={editForm.lead_source_other} onChange={e => setEditForm({ ...editForm, lead_source_other: e.target.value })} />
                )}
              </div>
              <div>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Locations</div>
                <NumberInput style={cInput} min={1} value={editForm.location_count} onChange={e => setEditForm({ ...editForm, location_count: parseInt(e.target.value) || 1 })} />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px' }}>Record type</div>
                <select style={cInput} value={editForm.record_type} onChange={e => setEditForm({ ...editForm, record_type: e.target.value })}>
                  <option value="customer">Customer</option>
                  <option value="vendor">Vendor — supplier/partner contact, FleetSuite only</option>
                </select>
                {editForm.record_type === 'vendor' && prospect.netsuite_id && (
                  <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '4px' }}>
                    Already created in NetSuite as a customer — this only reclassifies the record in FleetSuite; the NetSuite customer stays until removed there.
                  </div>
                )}
              </div>
              <textarea style={{ ...cInput, gridColumn: '1 / -1', resize: 'vertical' }} rows={3} placeholder="Notes" value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '14px' }}>
              <button onClick={deleteRecord} disabled={editSaving} title="Delete this record and everything attached to it" style={{
                padding: '9px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: 'var(--error-bg)', border: '1px solid var(--error-border)', color: 'var(--error)', cursor: 'pointer',
              }}>Delete</button>
              <span style={{ flex: 1 }} />
              <button onClick={() => setEditOpen(false)} disabled={editSaving} style={{ ...btnSm, padding: '9px 14px', fontSize: '12px' }}>Cancel</button>
              <button onClick={saveEdit} disabled={editSaving || !editForm.company_name.trim()} style={{
                padding: '9px 18px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                background: editForm.company_name.trim() ? '#22c55e' : 'var(--border)', color: '#fff', border: 'none',
                cursor: editForm.company_name.trim() ? 'pointer' : 'default', opacity: editSaving ? 0.6 : 1,
              }}>{editSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
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
              <button onClick={() => generateStatement('print')} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>Print</button>
              <button onClick={emailStatement} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>
                {emailingSt ? 'Sending…' : 'Email…'}
              </button>
              <button onClick={() => setStModalOpen(false)} disabled={stWorking || emailingSt} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Statement email — standard compose screen. Recipients prefill from
          saved billing emails; the invoice-PDF attachments are chosen by the
          statement scope above, not per-file. */}
      {stEmailOpen && (
        <EmailComposeModal
          title={`Email Statement — ${prospect?.company_name || customer?.company_name || ''}`}
          sendLabel="Send Statement"
          messagePlaceholder="Optional note — shown above the statement table…"
          intro={stPdfName ? (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              📎 <b style={{ color: 'var(--text-secondary)' }}>{stPdfName}</b> is attached automatically — a PDF copy of the statement the customer can save or forward, ahead of the open invoices&apos; PDFs.
            </div>
          ) : undefined}
          initialTo={(prospect?.billing_emails?.length ? prospect.billing_emails.join(', ') : '') || prospect?.email || customer?.email || ''}
          fetchPreview={fetchStatementPreview}
          onSend={sendStatementEmail}
          onClose={() => setStEmailOpen(false)}
        />
      )}

      {/* General email — the standard compose screen behind the Email
          button and contact addresses (formerly mailto: links). */}
      {composeOpen && (
        <EmailComposeModal
          title={composeCreditApp
            ? `Send credit application — ${prospect?.company_name || customer?.company_name || ''}`
            : `Email — ${prospect?.company_name || customer?.company_name || ''}`}
          sendLabel={composeCreditApp ? 'Send Credit Application' : 'Send Email'}
          initialTo={composeTo}
          messagePlaceholder={composeCreditApp
            ? 'Optional note — the email carries the credit-application button either way…'
            : 'Write your message…'}
          intro={
            <div>
              <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px' }}>Subject</div>
              <input
                value={composeSubject}
                onChange={e => setComposeSubject(e.target.value)}
                onBlur={() => setComposeSubjectKey(k => k + 1)}
                placeholder="e.g. Follow-up on your fleet graphics"
                style={{ width: '100%', padding: '8px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-body)', fontSize: '12px', boxSizing: 'border-box' }}
              />
            </div>
          }
          previewKey={composeSubjectKey}
          fetchPreview={fetchComposePreview}
          onSend={sendCompose}
          onClose={() => setComposeOpen(false)}
        />
      )}

      {/* Sent-email viewer — opens off the activity feed's "View email". */}
      {viewEmail && (
        <div onClick={() => setViewEmail(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Sent email"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '16px', width: 'min(720px, 100%)', maxHeight: 'calc(100vh / var(--ts) - 40px)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{viewEmail.subject || '(no subject)'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  To {(viewEmail.recipients || []).join(', ')} · {new Date(viewEmail.created_at).toLocaleString()} · {viewEmail.delivery_status.replace(/_/g, ' ')}
                </div>
              </div>
              <button onClick={() => setViewEmail(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '16px', cursor: 'pointer', padding: 0 }}>✕</button>
            </div>
            {viewEmail.body_html ? (
              <iframe srcDoc={viewEmail.body_html} title="Sent email" sandbox="" style={{ width: '100%', flex: 1, minHeight: '360px', border: '1px solid var(--border)', borderRadius: '8px', background: '#f3f4f6' }} />
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '16px 0' }}>
                The email content wasn&apos;t stored for this send (older emails predate content capture — the log has recipients, subject, and delivery status).
              </div>
            )}
          </div>
        </div>
      )}

      {/* Assign parent / leasing company (K1) — the manual link that wins
          over the NetSuite hierarchy and survives resync. Note required. */}
      {parentPickerOpen && customer && (
        <div onClick={() => !parentSaving && setParentPickerOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Assign parent account"
            style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px', width: 'min(440px, 100%)' }}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>Assign parent / leasing company</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '10px' }}>
              Links this account under a parent (e.g. a leasing company). The manual link wins over NetSuite’s hierarchy and survives resync.
            </div>
            <input autoFocus placeholder="Search customers…" value={parentSearch} onChange={e => searchParents(e.target.value)} style={{ ...cInput, marginBottom: '6px' }} />
            {parentChoice ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
                <span style={{ flex: 1 }}>{parentChoice.company_name || parentChoice.netsuite_id}</span>
                <button onClick={() => setParentChoice(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '12px' }}>✕</button>
              </div>
            ) : parentResults.length > 0 && (
              <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '6px', border: '1px solid var(--border)', borderRadius: '8px' }}>
                {parentResults.map(r => (
                  <button key={r.id} onClick={() => setParentChoice(r)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {r.company_name || r.netsuite_id}
                  </button>
                ))}
              </div>
            )}
            <textarea rows={2} placeholder="Why is this account moving? (required — logged on the record) *"
              value={parentNote} onChange={e => setParentNote(e.target.value)}
              style={{ ...cInput, resize: 'vertical', fontFamily: 'inherit', marginBottom: '10px' }} />
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <button onClick={() => saveParent(false)} disabled={parentSaving || !parentChoice || !parentNote.trim()} style={{
                flex: 1, padding: '9px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap',
                background: parentChoice && parentNote.trim() ? '#22c55e' : 'var(--border)', border: 'none', color: '#fff',
                cursor: parentChoice && parentNote.trim() ? 'pointer' : 'default', opacity: parentSaving ? 0.6 : 1,
              }}>{parentSaving ? 'Saving…' : 'Assign parent'}</button>
              {customer.parent_customer_id && (
                <button onClick={() => saveParent(true)} disabled={parentSaving || !parentNote.trim()}
                  title="Remove the manual parent link (falls back to NetSuite's hierarchy if it has one)"
                  style={{ ...btnSm, padding: '9px 12px', fontSize: '12px', color: 'var(--error)', opacity: parentNote.trim() ? 1 : 0.5 }}>
                  Clear parent
                </button>
              )}
              <button onClick={() => setParentPickerOpen(false)} disabled={parentSaving} style={{ ...btnSm, padding: '9px 12px', fontSize: '12px' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <style>{`@media (max-width:760px){ .rec-cols{ grid-template-columns:1fr !important; } }`}</style>
    </div>
  );
}
