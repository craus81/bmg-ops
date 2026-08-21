'use client';

/**
 * Sent Emails — the staff-visible record of every email sent from
 * FleetSuite, with live delivery status.
 *
 * The send layer logs every outbound email to email_log and the Resend
 * webhook keeps each row's delivery state current, but until now the only
 * UI over that table was Admin → System Health (admins only). Staff who
 * sent an estimate or invoice had no way to answer "did that actually go
 * out?" beyond the per-estimate banner. This page is that answer: your own
 * sends by default, everyone's on a toggle (it's all business
 * correspondence — useful when covering for a teammate), problems-only
 * filter, and an Open button that deep-links the record each email is
 * about (context_url, built from src/lib/deep-links.ts by the sender).
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';

interface EmailRow {
  id: string;
  kind: string;
  recipients: string[];
  subject: string | null;
  sent_by: string | null;
  context_url: string | null;
  delivery_status: string;
  delivery_detail: string | null;
  delivery_updated_at: string | null;
  created_at: string;
}

const KIND_LABELS: Record<string, string> = {
  customer_email: 'Customer email',
  estimate_approval: 'Estimate approval',
  invoice: 'Invoice',
  statement: 'Statement',
  wrap_quote: 'Wrap quote',
  proof_approval: 'Proof approval',
  install_guide: 'Install guide',
  customer_thread: 'Customer message',
  customer_notify: 'Customer notification',
  customer_digest: 'Weekly digest',
  pickup_notice: 'Pickup notice',
  staff_notification: 'Staff notification',
  invite: 'Invite',
  other: 'Other',
};

const kindLabel = (kind: string) =>
  KIND_LABELS[kind] || kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// Same vocabulary as the Resend webhook writes (migration 206).
const STATUS_STYLE: Record<string, { label: string; color: string; bg: string }> = {
  sent: { label: 'Sent', color: 'var(--text-muted)', bg: 'var(--subtle-bg)' },
  delivered: { label: '✓ Delivered', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' },
  delivery_delayed: { label: 'Delayed — retrying', color: '#f59e0b', bg: 'rgba(251,191,36,0.1)' },
  bounced: { label: '⚠ Bounced', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  complained: { label: '⚠ Marked spam', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  failed: { label: '⚠ Failed', color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
};

const PROBLEM_STATUSES = ['bounced', 'complained', 'failed'];

export default function SentEmailsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [rows, setRows] = useState<EmailRow[]>([]);
  const [senderNames, setSenderNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [problemsOnly, setProblemsOnly] = useState(false);

  useEffect(() => {
    if (authLoading || !user) return;
    (async () => {
      setLoading(true);
      let query = supabase
        .from('email_log')
        .select('id, kind, recipients, subject, sent_by, context_url, delivery_status, delivery_detail, delivery_updated_at, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      // "Mine" = emails this user composed. Automated sends (crons,
      // digests) have no sent_by and only show under All.
      if (scope === 'mine') query = query.eq('sent_by', user.id);
      const { data } = await query;
      const list = (data || []) as EmailRow[];
      setRows(list);
      const senderIds = [...new Set(list.map(r => r.sent_by).filter(Boolean))] as string[];
      if (senderIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles').select('id, full_name').in('id', senderIds);
        setSenderNames(Object.fromEntries((profs || []).map((p: any) => [p.id, p.full_name || ''])));
      }
      setLoading(false);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, [authLoading, user, scope]);

  const visible = problemsOnly ? rows.filter(r => PROBLEM_STATUSES.includes(r.delivery_status)) : rows;

  const fmtWhen = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  };

  const pill = (on: boolean, color: string): React.CSSProperties => ({
    padding: '5px 12px', borderRadius: '999px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
    background: on ? `rgba(${color},0.12)` : 'var(--subtle-bg)',
    border: `1px solid ${on ? `rgba(${color},0.4)` : 'var(--border)'}`,
    color: on ? `rgb(${color})` : 'var(--text-muted)',
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text-primary)' }}>Sent Emails</div>
        <div style={{ flex: 1 }} />
        <button onClick={() => setScope(s => (s === 'mine' ? 'all' : 'mine'))} style={pill(scope === 'all', '96,165,250')}>
          {scope === 'all' ? '✓ All staff' : 'All staff'}
        </button>
        <button onClick={() => setProblemsOnly(v => !v)} style={pill(problemsOnly, '239,68,68')}>
          {problemsOnly ? '✓ Problems only' : 'Problems only'}
        </button>
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Every email {scope === 'mine' ? 'you’ve sent' : 'sent'} from FleetSuite, newest first, with live delivery status.
        &ldquo;Delivered&rdquo; means the receiving mail server accepted it. Tip: tick &ldquo;Bcc me a copy&rdquo; when composing to also keep a copy in your own inbox.
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {problemsOnly ? 'No bounced or failed emails — everything went through.' :
            scope === 'mine' ? 'No emails sent from your account yet. They’ll appear here the moment you send one.' : 'No emails logged yet.'}
        </div>
      ) : (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="responsive-table">
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '680px' }}>
              <thead><tr>
                {['When', 'Type', 'To', 'Subject', ...(scope === 'all' ? ['Sent by'] : []), 'Status', ''].map((h, i) => (
                  <th key={i} style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '10px 12px', borderBottom: '1px solid var(--border-strong)', textAlign: 'left' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {visible.map(r => {
                  const st = STATUS_STYLE[r.delivery_status] || STATUS_STYLE.sent;
                  const td: React.CSSProperties = { padding: '9px 12px', borderBottom: '1px solid var(--border)', fontSize: '12px', verticalAlign: 'top' };
                  return (
                    <tr key={r.id}>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtWhen(r.created_at)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontWeight: 600 }}>{kindLabel(r.kind)}</td>
                      <td style={{ ...td, color: 'var(--text-secondary)', maxWidth: '220px', overflowWrap: 'anywhere' }}>{(r.recipients || []).join(', ') || '—'}</td>
                      <td style={{ ...td, color: 'var(--text-primary)', maxWidth: '280px', overflowWrap: 'anywhere' }}>{r.subject || '—'}</td>
                      {scope === 'all' && (
                        <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{r.sent_by ? (senderNames[r.sent_by] || '…') : 'Automatic'}</td>
                      )}
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <span title={r.delivery_detail || undefined} style={{ fontSize: '10px', fontWeight: 700, padding: '3px 8px', borderRadius: '5px', color: st.color, background: st.bg }}>{st.label}</span>
                      </td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        {r.context_url && (
                          <button onClick={() => router.push(r.context_url!)} title="Open the record this email is about" style={{
                            padding: '4px 10px', borderRadius: '6px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                            background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)', color: '#60a5fa',
                          }}>Open</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
