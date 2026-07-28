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

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { openNetSuitePdf } from '@/lib/netsuite-pdf-client';

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

interface Contact { id: string; name: string; title: string | null; email: string | null; phone: string | null; is_decision_maker: boolean }
interface Opportunity { id: string; title: string; type: string; stage: string; value: number | null; expected_close_date: string | null; created_at: string }
interface Activity { id: string; type: string; summary: string; created_by: string | null; created_at: string; creator_name?: string | null }
interface Reminder { id: string; title: string; description: string | null; due_at: string }
interface Tag { id: string; tag: string }
interface CustDocument { id: string; number: string; date: string; status: string; type: 'invoice' | 'salesOrder' | 'estimate'; typeLabel: string }

const OPP_TYPES: Record<string, string> = { tech_install: 'Tech Install', graphics: 'Graphics', rebrand: 'Rebrand', fleet_wrap: 'Fleet Wrap', other: 'Other' };
const OPP_STAGES: Record<string, string> = { lead: 'Lead', quoted: 'Quoted', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };
const STAGE_COLORS: Record<string, string> = { lead: '#60a5fa', quoted: '#a78bfa', negotiating: '#fbbf24', won: '#4ade80', lost: '#f87171' };
const STATUS_LABELS: Record<string, string> = { active: 'Prospect', nurturing: 'Nurturing', converted: 'Customer' };
const STATUS_COLORS: Record<string, string> = { active: '#4ade80', nurturing: '#60a5fa', converted: '#a78bfa' };
const ACTIVITY_ICONS: Record<string, string> = { call: '\u{1F4DE}', email: '\u{1F4E7}', note: '\u{1F4DD}', meeting: '\u{1F91D}', quote_sent: '\u{1F4CB}', status_change: '\u{1F504}' };
const DOCS_PAGE_SIZE = 100;

const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
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
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

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

  useEffect(() => {
    if (authLoading) return;
    if (!hasFeature('prospects') && !isAdmin) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once when auth resolves
  }, [authLoading]);

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
        supabase.from('prospect_contacts').select('id, name, title, email, phone, is_decision_maker').eq('prospect_id', p.id).order('is_decision_maker', { ascending: false }),
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
    if (nsId) loadDocs(nsId, false);
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
        return { id: String(t.id), number: t.tranid || String(t.id), date: t.trandate || '', status: t.status || '', type: info.type, typeLabel: info.label };
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
  const filteredDocs = (docs || []).filter(d => docFilter === 'all' || d.type === docFilter);

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
            <div style={eyebrow}>Contacts {contacts.length > 0 && <span style={{ fontWeight: 600 }}>· {contacts.length}</span>}</div>
            {contacts.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{prospect ? 'No contacts yet.' : '—'}</div>}
            {contacts.map(c => (
              <div key={c.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {c.name}
                  {c.is_decision_maker && <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 6px', borderRadius: '4px', background: 'rgba(251,191,36,0.12)', color: '#f59e0b' }}>DM</span>}
                  {c.title && <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{c.title}</span>}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <div style={{ ...eyebrow, marginBottom: 0 }}>NetSuite documents {docs ? `· ${docs.length}${docsHasMore ? '+' : ''}` : ''}</div>
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
          {docsError && <div style={{ fontSize: '12px', color: 'var(--error)', padding: '8px 0' }}>{docsError}</div>}
          {!docs && !docsError && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading documents…</div>}
          {docs && filteredDocs.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '8px 0' }}>No documents.</div>}
          {filteredDocs.map(doc => (
            <div key={`${doc.type}-${doc.id}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 0', borderTop: '1px solid var(--border)', fontSize: '12.5px' }}>
              <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', flexShrink: 0, width: '76px', textAlign: 'center', background: 'var(--subtle-bg)', color: 'var(--text-muted)' }}>{doc.typeLabel}</span>
              <span style={{ fontWeight: 700, color: 'var(--text-primary)', flexShrink: 0 }}>{doc.number}</span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{fmtDate(doc.date)}</span>
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.status}</span>
              <button onClick={() => viewPdf(doc)} disabled={pdfBusy === doc.id} style={{ ...btnSm, padding: '4px 10px', opacity: pdfBusy === doc.id ? 0.6 : 1 }}>
                {pdfBusy === doc.id ? '…' : 'PDF'}
              </button>
            </div>
          ))}
          {docs && docsHasMore && docFilter === 'all' && (
            <button onClick={() => { const ns = prospect?.netsuite_id || customer?.netsuite_id; if (ns) loadDocs(ns, true); }} disabled={docsLoading} style={{ ...btnSm, marginTop: '10px' }}>
              {docsLoading ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      )}

      <style>{`@media (max-width:760px){ .rec-cols{ grid-template-columns:1fr !important; } }`}</style>
    </div>
  );
}
