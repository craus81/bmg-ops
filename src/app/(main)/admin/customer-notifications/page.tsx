'use client';

/**
 * Customer Notifications — per-customer subscriptions to automatic emails.
 *
 * Since migration 171 every automatic customer-facing send is opt-IN:
 * nothing emails a customer on status changes or crons unless they're
 * subscribed here. "Status emails" covers vehicle complete/shipped,
 * graphics shipped, and automatic proof reminders; "Weekly digest" is the
 * Monday summary. On-demand sends (staff clicks Send and confirms the
 * address) are unaffected by these switches.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { theme } from '@/lib/theme';

interface CustomerRow {
  id: string;
  company_name: string;
  email: string | null;
  notify_status_emails: boolean | null;
  weekly_digest: boolean | null;
}

export default function CustomerNotificationsPage() {
  const router = useRouter();
  const { isAdmin, hasFeature, loading: authLoading } = useAuth();
  const supabase = createClient();

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [subscribedOnly, setSubscribedOnly] = useState(false);

  useEffect(() => {
    if (authLoading) return; // role flags aren't resolved until auth finishes loading
    if (!isAdmin && !hasFeature('customers')) { router.push('/home'); return; }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once after auth resolves
  }, [authLoading, isAdmin]);

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('customers')
      .select('id, company_name, email, notify_status_emails, weekly_digest')
      .order('company_name');
    setRows((data as CustomerRow[]) || []);
    setLoading(false);
  };

  const setFlag = async (row: CustomerRow, flag: 'notify_status_emails' | 'weekly_digest', value: boolean) => {
    setSavingId(row.id);
    const { error } = await supabase.from('customers').update({ [flag]: value }).eq('id', row.id);
    if (!error) {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, [flag]: value } : r));
    }
    setSavingId(null);
  };

  const visible = rows.filter(r => {
    if (subscribedOnly && r.notify_status_emails !== true && r.weekly_digest !== true) return false;
    const s = search.trim().toLowerCase();
    if (!s) return true;
    return r.company_name?.toLowerCase().includes(s) || (r.email || '').toLowerCase().includes(s);
  });

  const toggle = (row: CustomerRow, flag: 'notify_status_emails' | 'weekly_digest') => {
    const on = row[flag] === true;
    return (
      <button
        onClick={() => setFlag(row, flag, !on)}
        disabled={savingId === row.id}
        title={on ? 'Subscribed — click to unsubscribe' : 'Not subscribed — click to subscribe'}
        style={{
          padding: '3px 10px', borderRadius: '10px', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
          background: on ? 'rgba(34,197,94,0.15)' : 'var(--subtle-bg)',
          border: `1px solid ${on ? 'rgba(34,197,94,0.45)' : 'var(--border)'}`,
          color: on ? '#22c55e' : 'var(--text-muted)',
        }}
      >
        {on ? 'On' : 'Off'}
      </button>
    );
  };

  if (authLoading || loading) {
    return <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>;
  }

  const subscribedCount = rows.filter(r => r.notify_status_emails === true || r.weekly_digest === true).length;

  return (
    <div style={{ maxWidth: '760px' }}>
      <div style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '2px' }}>Customer Notifications</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '14px' }}>
        Automatic emails are off for everyone unless subscribed here. <b>Status emails</b> = vehicle ready/shipped,
        graphics shipped, and automatic proof reminders. <b>Weekly digest</b> = Monday summary. On-demand sends
        (you click Send and confirm the address) always work regardless.
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search customers…"
          style={{ flex: 1, minWidth: '200px', padding: '8px 12px', borderRadius: '8px', fontSize: '12px', border: `1px solid ${theme.border}`, background: 'var(--input-bg)', color: 'var(--text-body)' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={subscribedOnly} onChange={e => setSubscribedOnly(e.target.checked)} />
          Subscribed only ({subscribedCount})
        </label>
      </div>

      {visible.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: '13px', fontWeight: 600 }}>
          {rows.length === 0 ? 'No customers synced yet.' : 'No customers match.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '0 12px', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
            <div style={{ flex: 1 }}>Customer</div>
            <div style={{ width: '90px', textAlign: 'center' }}>Status emails</div>
            <div style={{ width: '90px', textAlign: 'center' }}>Weekly digest</div>
          </div>
          {visible.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderRadius: '8px',
              background: 'var(--card)', border: `1px solid ${theme.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.company_name}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email || 'no email on file'}</div>
              </div>
              <div style={{ width: '90px', textAlign: 'center' }}>{toggle(r, 'notify_status_emails')}</div>
              <div style={{ width: '90px', textAlign: 'center' }}>{toggle(r, 'weekly_digest')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
