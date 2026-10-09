'use client';

/**
 * Past Due — the A/R reminder page (migration 357, owner decisions
 * 2026-10-09).
 *
 * Every customer with past-due invoices, read live from NetSuite. The
 * weekday 7 AM digest (/api/cron/ar-past-due) links here. Whoever works A/R
 * ticks the customers to remind, checks or edits who it goes to, and sends
 * each one a past-due statement through the standard compose screen — one
 * customer at a time, previewed, nothing automatic (CLAUDE.md "No customer
 * email sends itself"). Customers with dozens of open invoices (Masterack)
 * get them as ONE combined PDF instead of the 10-file cap.
 *
 * ?customer=<NetSuite id> (deepLinks.pastDue) opens and flashes that row.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import EmailComposeModal, { parseEmailList, type EmailComposeFields } from '@/components/EmailComposeModal';
import { normalizeSteps } from '@/lib/ar-reminders';
import { theme } from '@/lib/theme';

interface PastDueInvoice {
  id: string;
  tranid: string;
  date: string | null;
  dueDate: string | null;
  po: string | null;
  unpaid: number;
  daysPastDue: number;
  step: number | null;
  alertedAt: string | null;
  nsUrl: string;
}

interface PastDueCustomer {
  key: string;
  entityId: string | null;
  customer: string;
  localCustomerId: string | null;
  prospectId: string | null;
  pastDue: number;
  openBalance: number;
  openCount: number;
  oldestDays: number;
  suggestedRecipients: string[];
  recipientsSource: 'billing' | 'profile' | 'main' | 'none';
  billingWorkflow: string | null;
  billingPortal: string | null;
  billingNotes: string | null;
  lastStatement: { at: string; recipients: string[]; status: string } | null;
  invoices: PastDueInvoice[];
}

type AttachMode = 'combined' | 'separate' | 'none';
type AttachScope = 'pastdue' | 'open';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtD = (iso: string | null) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
};
const daysAgo = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);

const AGE_FILTERS = [
  { min: 0, label: 'All' },
  { min: 15, label: '15+ days' },
  { min: 30, label: '30+ days' },
  { min: 60, label: '60+ days' },
];

const label: React.CSSProperties = { fontSize: '11px', fontWeight: 700, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.5px' };
const card: React.CSSProperties = { background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px' };
const btn: React.CSSProperties = { padding: '8px 14px', borderRadius: '10px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', border: `1px solid ${theme.border}`, background: theme.subtleBg, color: theme.textSecondary };

function stepColor(days: number): string {
  if (days >= 60) return theme.error;
  if (days >= 30) return theme.warning;
  return theme.textSecondary;
}

export default function PastDuePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAdmin, canSeeMoney, loading: authLoading } = useAuth();
  const dialog = useDialog();
  const supabase = useMemo(() => createClient(), []);

  useEffect(() => {
    if (authLoading) return;
    if (!canSeeMoney && !isAdmin) router.push('/home');
  }, [authLoading, canSeeMoney, isAdmin, router]);

  const [rows, setRows] = useState<PastDueCustomer[] | null>(null);
  const [steps, setSteps] = useState<number[]>([1, 15, 30, 60]);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [minDays, setMinDays] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [flashKey, setFlashKey] = useState<string | null>(null);
  // Recipients edited on the page, per customer key (comma-separated).
  const [toEdits, setToEdits] = useState<Record<string, string>>({});

  // Send queue: one compose screen per ticked customer, in order.
  const [queue, setQueue] = useState<string[]>([]);
  const [attachMode, setAttachMode] = useState<AttachMode>('combined');
  const [attachScope, setAttachScope] = useState<AttachScope>('pastdue');
  const [remember, setRemember] = useState(true);
  const [sentKeys, setSentKeys] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await apiFetch('/api/invoices/past-due');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setRows(data.customers || []);
      setSteps(normalizeSteps(data.settings?.stepDays));
    } catch (e: any) {
      setLoadError(e?.message || 'Could not load past-due invoices.');
      setRows([]);
    }
  }, []);

  useEffect(() => { if (!authLoading && (canSeeMoney || isAdmin)) void load(); }, [authLoading, canSeeMoney, isAdmin, load]);

  // Deep link: open and flash one customer's row.
  const linked = searchParams.get('customer');
  useEffect(() => {
    if (!rows || !linked) return;
    const row = rows.find(r => r.entityId === linked);
    if (!row) return;
    setExpanded(prev => new Set(prev).add(row.key));
    setFlashKey(row.key);
    setTimeout(() => document.getElementById(`pd-${row.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
    const t = setTimeout(() => setFlashKey(null), 2500);
    return () => clearTimeout(t);
  }, [rows, linked]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows || []).filter(r => r.oldestDays >= minDays && (!q || r.customer.toLowerCase().includes(q) || r.invoices.some(i => i.tranid.toLowerCase().includes(q) || (i.po || '').toLowerCase().includes(q))));
  }, [rows, search, minDays]);

  const totals = useMemo(() => ({
    amount: visible.reduce((s, r) => s + r.pastDue, 0),
    invoices: visible.reduce((s, r) => s + r.invoices.length, 0),
  }), [visible]);

  const recipientsFor = (r: PastDueCustomer) => toEdits[r.key] ?? r.suggestedRecipients.join(', ');

  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  };

  const sendable = (r: PastDueCustomer) => !!r.entityId;
  const allVisibleSelected = visible.length > 0 && visible.filter(sendable).every(r => selected.has(r.key));

  const startSend = async () => {
    const keys = visible.filter(r => selected.has(r.key) && sendable(r)).map(r => r.key);
    if (keys.length === 0) return;
    const portal = visible.filter(r => keys.includes(r.key) && r.billingWorkflow === 'po_portal');
    if (portal.length > 0) {
      const ok = await dialog.confirm(
        `${portal.map(p => p.customer).join(', ')} ${portal.length === 1 ? 'is' : 'are'} set to pay through ${portal.length === 1 ? 'its' : 'their'} own AP portal. Email a statement anyway?`,
        { confirmLabel: 'Include them' },
      );
      if (!ok) {
        const skip = new Set(portal.map(p => p.key));
        const rest = keys.filter(k => !skip.has(k));
        if (rest.length === 0) return;
        setQueue(rest);
        return;
      }
    }
    setQueue(keys);
  };

  const current = queue.length > 0 ? (rows || []).find(r => r.key === queue[0]) || null : null;
  const pastDueIds = current ? current.invoices.map(i => i.id) : [];
  const attachCount = current ? (attachScope === 'pastdue' ? current.invoices.length : current.openCount) : 0;

  // Default per customer: combined when there are more than a handful.
  useEffect(() => {
    if (!current) return;
    const n = attachScope === 'pastdue' ? current.invoices.length : current.openCount;
    setAttachMode(n > 3 ? 'combined' : 'separate');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the customer changes
  }, [current?.key]);

  const statementBody = (fields: EmailComposeFields, preview: boolean) => ({
    preview: preview || undefined,
    customerId: current!.entityId,
    recipients: fields.emails,
    customBody: fields.message || undefined,
    bccSelf: preview ? undefined : fields.bccSelf,
    cc: preview ? undefined : fields.cc,
    scope: 'open',
    reminder: true,
    attachInvoices: attachMode !== 'none',
    combineInvoices: attachMode === 'combined',
    invoiceIds: attachScope === 'pastdue' ? pastDueIds : undefined,
  });

  const fetchPreview = async (fields: EmailComposeFields) => {
    if (!current?.entityId) return { error: 'Not linked to a NetSuite customer' };
    try {
      const res = await apiFetch('/api/netsuite/email-statement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(statementBody(fields, true)),
      });
      const data = await res.json();
      if (res.ok && data.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: data.error || 'Unknown error' };
    } catch {
      return { error: 'Network error — please try again.' };
    }
  };

  // The compose screen closes itself after a send: move on to the next
  // customer. Closed WITHOUT sending: stop the batch (whoever is still
  // ticked can be sent with the button again).
  const justSent = useRef(false);
  const onComposeClose = () => {
    if (justSent.current) setQueue(q => q.slice(1));
    else setQueue([]);
    justSent.current = false;
  };

  const send = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    if (!current?.entityId) return { ok: false };
    try {
      const res = await apiFetch('/api/netsuite/email-statement', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(statementBody(fields, false)),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data?.error || `HTTP ${res.status}`);
      // Remember the addresses as this customer's billing emails.
      if (remember && current.prospectId && fields.emails.length > 0) {
        const { data: p } = await supabase.from('prospects').select('billing_emails').eq('id', current.prospectId).maybeSingle();
        const merged = [...new Set([...(((p as any)?.billing_emails as string[]) || []), ...fields.emails].map(e => e.toLowerCase()))];
        await supabase.from('prospects').update({ billing_emails: merged }).eq('id', current.prospectId);
      }
      const sentKey = current.key;
      setSentKeys(prev => new Set(prev).add(sentKey));
      setSelected(prev => { const n = new Set(prev); n.delete(sentKey); return n; });
      setRows(prev => (prev || []).map(r => r.key === sentKey ? { ...r, lastStatement: { at: new Date().toISOString(), recipients: data.sent || fields.emails, status: 'sent' } } : r));
      if (data.failedAttachments?.length) {
        await dialog.alert(`Sent to ${data.sent.join(', ')}, but these invoice PDFs couldn't be pulled from NetSuite: ${data.failedAttachments.join(', ')}.`);
      }
      justSent.current = true;
      return { ok: true };
    } catch (err: any) {
      await dialog.alert(`Could not send to ${current.customer}: ${err?.message || 'unknown error'}`);
      return { ok: false };
    }
  };

  if (authLoading) return null;

  return (
    <div style={{ maxWidth: '980px', margin: '0 auto', padding: '24px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, margin: '0 0 6px', color: theme.textPrimary }}>Past Due Invoices</h1>
          <div style={{ fontSize: '13px', color: theme.textMuted, maxWidth: '620px', lineHeight: 1.5 }}>
            Live from NetSuite. Tick the customers you want to remind, check who it goes to, and send each a past-due
            statement with the invoices attached. A reminder email goes out at 7 AM on weekdays when invoices
            reach {steps.join(', ')} days past due.
          </div>
        </div>
        {isAdmin && <SettingsButton supabase={supabase} onSaved={s => setSteps(s)} />}
      </div>

      <div style={{ ...card, padding: '12px 16px', marginBottom: '12px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customer, invoice # or PO #"
          style={{ flex: '1 1 220px', minWidth: 0, padding: '9px 12px', borderRadius: '10px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '14px' }}
        />
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {AGE_FILTERS.map(f => (
            <button key={f.min} onClick={() => setMinDays(f.min)}
              style={{ ...btn, padding: '7px 10px', fontSize: '12px', ...(minDays === f.min ? { background: theme.tabActiveBg, borderColor: theme.tabActiveBorder, color: theme.tabActiveColor } : {}) }}>
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: '13px', color: theme.textSecondary, fontWeight: 700 }}>
          {usd(totals.amount)} · {totals.invoices} invoice{totals.invoices === 1 ? '' : 's'} · {visible.length} customer{visible.length === 1 ? '' : 's'}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: theme.textSecondary, cursor: 'pointer' }}>
          <input type="checkbox" checked={allVisibleSelected}
            onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visible.filter(sendable).map(r => r.key)))} />
          Select all
        </label>
        <button
          onClick={startSend}
          disabled={selected.size === 0}
          style={{ ...btn, background: theme.accent, color: '#fff', border: 'none', opacity: selected.size === 0 ? 0.4 : 1 }}
        >
          ✉ Email {selected.size || ''} selected
        </button>
        <button onClick={() => { setRows(null); void load(); }} style={{ ...btn, padding: '7px 10px', fontSize: '12px' }}>Refresh</button>
      </div>

      {loadError && <div style={{ ...card, padding: '12px 16px', color: theme.error, marginBottom: '12px', fontSize: '13px' }}>{loadError}</div>}
      {rows === null && <div style={{ color: theme.textMuted, fontSize: '13px', padding: '20px 0' }}>Loading open invoices from NetSuite…</div>}
      {rows !== null && visible.length === 0 && !loadError && (
        <div style={{ ...card, padding: '24px', textAlign: 'center', color: theme.textMuted, fontSize: '13px' }}>Nothing past due{minDays ? ` ${minDays}+ days` : ''}.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(r => {
          const open = expanded.has(r.key);
          const portal = r.billingWorkflow === 'po_portal';
          return (
            <div key={r.key} id={`pd-${r.key}`} style={{ ...card, padding: '12px 14px', outline: flashKey === r.key ? `2px solid ${theme.accent}` : 'none', transition: 'outline 0.3s' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <input type="checkbox" style={{ marginTop: '4px' }} disabled={!sendable(r)}
                  checked={selected.has(r.key)} onChange={() => setSelected(s => toggle(s, r.key))}
                  title={sendable(r) ? 'Include in the next send' : 'Not linked to a NetSuite customer'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                    <button onClick={() => setExpanded(s => toggle(s, r.key))}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', color: theme.textPrimary, fontSize: '15px', fontWeight: 800 }}>
                      {open ? '▾' : '▸'} {r.customer}
                    </button>
                    <div style={{ fontSize: '14px', fontWeight: 800, color: stepColor(r.oldestDays) }}>{usd(r.pastDue)} past due</div>
                  </div>
                  <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '2px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    <span>{r.invoices.length} past due of {r.openCount} open ({usd(r.openBalance)})</span>
                    <span style={{ color: stepColor(r.oldestDays), fontWeight: 700 }}>oldest {r.oldestDays} days late</span>
                    <span>
                      {r.lastStatement
                        ? `Statement emailed ${daysAgo(r.lastStatement.at) === 0 ? 'today' : `${daysAgo(r.lastStatement.at)}d ago`}${['bounced', 'failed', 'complained'].includes(r.lastStatement.status) ? ` (${r.lastStatement.status})` : ''}`
                        : 'No statement emailed yet'}
                    </span>
                    {sentKeys.has(r.key) && <span style={{ color: theme.success, fontWeight: 700 }}>✓ Sent just now</span>}
                  </div>
                  {portal && (
                    <div style={{ fontSize: '12px', color: theme.warning, marginTop: '4px' }}>
                      Pays through its own AP portal{r.billingPortal ? ` (${r.billingPortal})` : ''}. Check the portal before emailing.
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
                    <span style={{ ...label, flexShrink: 0 }}>To</span>
                    <input
                      value={recipientsFor(r)}
                      onChange={e => setToEdits(prev => ({ ...prev, [r.key]: e.target.value }))}
                      placeholder="No email on file. Type one or more addresses"
                      style={{ flex: 1, minWidth: 0, padding: '6px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '13px' }}
                    />
                  </div>
                  {r.recipientsSource === 'main' && !toEdits[r.key] && (
                    <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '3px' }}>No billing email saved; this is the main company email.</div>
                  )}

                  {open && (
                    <div style={{ marginTop: '10px', overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '520px' }}>
                        <thead>
                          <tr style={{ color: theme.textMuted, textAlign: 'left' }}>
                            <th style={{ padding: '4px 6px' }}>Invoice</th>
                            <th style={{ padding: '4px 6px' }}>PO #</th>
                            <th style={{ padding: '4px 6px' }}>Date</th>
                            <th style={{ padding: '4px 6px' }}>Due</th>
                            <th style={{ padding: '4px 6px', textAlign: 'right' }}>Days late</th>
                            <th style={{ padding: '4px 6px', textAlign: 'right' }}>Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.invoices.map(i => (
                            <tr key={i.id} style={{ borderTop: `1px solid ${theme.border}`, color: theme.textPrimary }}>
                              <td style={{ padding: '5px 6px' }}>
                                <a href={i.nsUrl} target="_blank" rel="noreferrer" style={{ color: theme.textPrimary, fontWeight: 700 }}>{i.tranid}</a>
                              </td>
                              <td style={{ padding: '5px 6px' }}>{i.po || '—'}</td>
                              <td style={{ padding: '5px 6px' }}>{fmtD(i.date)}</td>
                              <td style={{ padding: '5px 6px' }}>{fmtD(i.dueDate)}</td>
                              <td style={{ padding: '5px 6px', textAlign: 'right', color: stepColor(i.daysPastDue), fontWeight: 700 }}>{i.daysPastDue}</td>
                              <td style={{ padding: '5px 6px', textAlign: 'right' }}>{usd(i.unpaid)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {r.billingNotes && <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '6px' }}>Billing notes: {r.billingNotes}</div>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {current && (
        <EmailComposeModal
          key={current.key}
          title={`Past due reminder — ${current.customer}${queue.length > 1 ? ` (${queue.length - 1} more after this; close to stop)` : ''}`}
          initialTo={parseEmailList(recipientsFor(current)).join(', ')}
          customerId={current.localCustomerId}
          sendLabel="Send Reminder"
          messagePlaceholder="Optional note. Leave blank for the standard friendly past-due wording."
          previewKey={`${attachMode}:${attachScope}`}
          intro={
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: theme.textSecondary }}>
              <div>
                <div style={{ ...label, fontSize: '10px', marginBottom: '4px' }}>Attach</div>
                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input type="radio" checked={attachScope === 'pastdue'} onChange={() => setAttachScope('pastdue')} />
                    Past-due invoices ({current.invoices.length})
                  </label>
                  <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <input type="radio" checked={attachScope === 'open'} onChange={() => setAttachScope('open')} />
                    All open invoices ({current.openCount})
                  </label>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <input type="radio" checked={attachMode === 'combined'} onChange={() => setAttachMode('combined')} />
                  One combined PDF
                </label>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <input type="radio" checked={attachMode === 'separate'} onChange={() => setAttachMode('separate')} />
                  Separate PDFs{attachCount > 10 ? ' (10 most overdue)' : ''}
                </label>
                <label style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <input type="radio" checked={attachMode === 'none'} onChange={() => setAttachMode('none')} />
                  Statement only
                </label>
              </div>
              <div style={{ fontSize: '11px', color: theme.textMuted }}>
                The statement PDF is always attached. {attachMode === 'combined' && attachCount > 20 ? 'Pulling this many invoices from NetSuite can take a minute.' : ''}
              </div>
              {current.prospectId && (
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                  Save these addresses as this customer&apos;s billing emails
                </label>
              )}
            </div>
          }
          fetchPreview={fetchPreview}
          onSend={send}
          onClose={onComposeClose}
        />
      )}
    </div>
  );
}

/** Admin settings: which days alert, and who gets the 7 AM email. */
function SettingsButton({ supabase, onSaved }: { supabase: ReturnType<typeof createClient>; onSaved: (steps: number[]) => void }) {
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [stepsText, setStepsText] = useState('1, 15, 30, 60');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [staff, setStaff] = useState<{ id: string; full_name: string | null; email: string | null }[]>([]);
  const [saving, setSaving] = useState(false);

  const openSettings = async () => {
    setOpen(true);
    const [{ data: s }, { data: people }] = await Promise.all([
      supabase.from('ar_reminder_settings').select('*').eq('id', 1).maybeSingle(),
      supabase.from('profiles').select('id, full_name, email, deactivated').eq('status', 'approved').order('full_name'),
    ]);
    if (s) {
      setEnabled((s as any).enabled !== false);
      setStepsText(normalizeSteps((s as any).step_days).join(', '));
      setPick(new Set(((s as any).recipient_ids as string[]) || []));
    }
    setStaff(((people || []) as any[]).filter(p => !p.deactivated));
  };

  const save = async () => {
    const steps = normalizeSteps(stepsText.split(/[,\s]+/));
    setSaving(true);
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('ar_reminder_settings').upsert({
      id: 1, enabled, step_days: steps, recipient_ids: [...pick],
      updated_at: new Date().toISOString(), updated_by: auth.user?.id || null,
    });
    setSaving(false);
    if (error) { await dialog.alert(`Could not save: ${error.message}`); return; }
    onSaved(steps);
    setOpen(false);
  };

  return (
    <>
      <button onClick={openSettings} style={btn}>⚙ Reminder settings</button>
      {open && (
        <div ref={closeOnEscape(() => setOpen(false))}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ width: '100%', maxWidth: '440px', maxHeight: 'calc(85vh / var(--ts))', display: 'flex', flexDirection: 'column', gap: '10px', background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '12px', padding: '16px' }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>Past-due reminder settings</div>
            <label style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px', color: theme.textSecondary }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Send the 7 AM weekday reminder
            </label>
            <div>
              <div style={{ ...label, marginBottom: '4px' }}>Remind at days past due</div>
              <input value={stepsText} onChange={e => setStepsText(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${theme.border}`, background: theme.inputBg, color: theme.textPrimary, fontSize: '14px' }} />
              <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '3px' }}>Each invoice alerts once at each of these.</div>
            </div>
            <div style={{ ...label }}>Who gets it</div>
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', minHeight: '120px' }}>
              {staff.map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '6px', fontSize: '13px', color: theme.textPrimary, cursor: 'pointer', background: pick.has(p.id) ? theme.subtleBg : 'transparent' }}>
                  <input type="checkbox" checked={pick.has(p.id)}
                    onChange={() => setPick(prev => { const n = new Set(prev); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} />
                  <span style={{ fontWeight: 700 }}>{p.full_name || p.email || 'Unnamed'}</span>
                  {p.full_name && p.email && <span style={{ color: theme.textMuted, fontSize: '11px' }}>{p.email}</span>}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button onClick={() => setOpen(false)} style={btn}>Cancel</button>
              <button onClick={save} disabled={saving} style={{ ...btn, background: theme.accent, color: '#fff', border: 'none' }}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
