'use client';

/**
 * Parts Mail — everything the email→ETA pipeline saw and what it did with
 * it. Review-queue rows (parts emails with no PO match) get resolved here:
 * type the PO number to link + apply, or dismiss. Admins also edit the
 * watched-mailbox list and can trigger a scan on demand.
 */

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';

interface MailRow {
  id: string;
  mailbox: string;
  from_address: string | null;
  subject: string | null;
  received_at: string | null;
  classification: 'applied' | 'linked' | 'review' | 'ignored' | 'error';
  vendor_name: string | null;
  po_number: string | null;
  ship_date: string | null;
  eta_date: string | null;
  tracking_number: string | null;
  carrier: string | null;
  summary: string | null;
  error: string | null;
  created_at: string;
}

const CLASS_STYLES: Record<MailRow['classification'], { label: string; color: string }> = {
  applied: { label: 'Applied', color: '#22c55e' },
  linked: { label: 'Linked', color: '#60a5fa' },
  review: { label: 'Needs Review', color: '#fbbf24' },
  ignored: { label: 'Ignored', color: '#94a3b8' },
  error: { label: 'Error', color: '#ef4444' },
};

const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '—';

export default function PartsMailPage() {
  const supabase = createClient();
  const { isAdmin } = useAuth();
  const dialog = useDialog();

  const [rows, setRows] = useState<MailRow[]>([]);
  const [filter, setFilter] = useState<'all' | MailRow['classification']>('all');
  const [loading, setLoading] = useState(true);
  const [linkInputs, setLinkInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Settings (admin)
  const [mailboxText, setMailboxText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('vendor_shipment_emails')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150);
    setRows((data as MailRow[]) || []);
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supabase client is a stable singleton
  }, []);

  useEffect(() => {
    load();
    (async () => {
      const { data } = await supabase.from('parts_email_settings').select('enabled, mailboxes').eq('id', 1).maybeSingle();
      if (data) {
        setEnabled(data.enabled);
        setMailboxText((data.mailboxes || []).join('\n'));
      }
      setSettingsLoaded(true);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, [load]);

  const resolve = async (row: MailRow, poNumber: string | null) => {
    setBusy(row.id);
    const res = await fetch('/api/parts-mail/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId: row.id, poNumber }),
    });
    const data = await res.json();
    if (!res.ok) {
      await dialog.alert(data.error || 'Failed');
    } else {
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, classification: data.classification, po_number: poNumber || r.po_number } : r));
    }
    setBusy(null);
  };

  const scanNow = async () => {
    setScanning(true);
    const res = await fetch('/api/cron/parts-email-scan');
    const data = await res.json().catch(() => ({}));
    setScanning(false);
    if (!res.ok) {
      await dialog.alert(data.error || 'Scan failed');
    } else if (data.skipped) {
      await dialog.alert(`Scan skipped: ${data.skipped}`);
    } else {
      await dialog.alert(`Scanned ${data.mailboxes} mailboxes · ${data.processed} new emails · ${data.applied} ETAs applied · ${data.review} for review${data.errors ? ` · ${data.errors} errors` : ''}`);
      load();
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    const mailboxes = mailboxText.split(/[\n,;]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@'));
    await supabase.from('parts_email_settings').update({
      enabled,
      mailboxes,
      updated_at: new Date().toISOString(),
    }).eq('id', 1);
    setMailboxText(mailboxes.join('\n'));
    setSavingSettings(false);
  };

  const visible = filter === 'all' ? rows : rows.filter(r => r.classification === filter);
  const reviewCount = rows.filter(r => r.classification === 'review').length;

  const card: React.CSSProperties = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '14px', padding: '14px', marginBottom: '14px' };
  const inputStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' };

  return (
    <div style={{ padding: '16px', maxWidth: '860px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>Parts Mail</h1>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Vendor order confirmations → parts ETAs{reviewCount > 0 ? ` · ${reviewCount} need review` : ''}
          </div>
        </div>
        {isAdmin && (
          <button onClick={scanNow} disabled={scanning} style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: scanning ? 0.6 : 1 }}>
            {scanning ? 'Scanning…' : 'Scan Now'}
          </button>
        )}
      </div>

      {/* Admin settings */}
      {isAdmin && settingsLoaded && (
        <div style={card}>
          <div style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>Watched Mailboxes</div>
          <textarea
            value={mailboxText}
            onChange={e => setMailboxText(e.target.value)}
            rows={4}
            placeholder={'one@bmgfleet.com\ntwo@bmgfleet.com'}
            style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
              Scanning enabled
            </label>
            <button onClick={saveSettings} disabled={savingSettings} style={{ padding: '7px 14px', borderRadius: '8px', background: '#3b82f6', border: 'none', color: '#fff', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: savingSettings ? 0.6 : 1 }}>
              {savingSettings ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {/* Filter chips */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
        {(['all', 'review', 'applied', 'linked', 'ignored', 'error'] as const).map(f => {
          const count = f === 'all' ? rows.length : rows.filter(r => r.classification === f).length;
          const active = filter === f;
          const color = f === 'all' ? '#60a5fa' : CLASS_STYLES[f].color;
          return (
            <button key={f} onClick={() => setFilter(f)} style={{
              padding: '5px 11px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
              background: active ? `${color}25` : 'var(--card)',
              border: `1px solid ${active ? color : 'var(--border)'}`,
              color: active ? color : 'var(--text-muted)',
            }}>
              {f === 'all' ? 'All' : CLASS_STYLES[f].label} ({count})
            </button>
          );
        })}
      </div>

      {loading && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>Loading…</div>}
      {!loading && visible.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px', padding: '30px 0' }}>
          Nothing here yet — the scan runs hourly{isAdmin ? ', or hit Scan Now' : ''}.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {visible.map(r => {
          const cls = CLASS_STYLES[r.classification];
          return (
            <div key={r.id} style={{ ...card, marginBottom: 0, padding: '11px 13px', borderColor: r.classification === 'review' ? 'rgba(251,191,36,0.4)' : 'var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.subject || '(no subject)'}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {[r.from_address, r.mailbox && `→ ${r.mailbox}`, r.received_at && fmt(r.received_at)].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <span style={{ fontSize: '9px', fontWeight: 800, padding: '2px 8px', borderRadius: '6px', background: `${cls.color}20`, color: cls.color, whiteSpace: 'nowrap', flexShrink: 0 }}>{cls.label}</span>
              </div>
              {r.summary && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '5px' }}>{r.summary}</div>}
              {r.error && <div style={{ fontSize: '10px', color: '#ef4444', marginTop: '4px' }}>{r.error}</div>}
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '5px', fontSize: '10px', color: 'var(--text-muted)' }}>
                {r.vendor_name && <span>Vendor: <b style={{ color: 'var(--text-secondary)' }}>{r.vendor_name}</b></span>}
                {r.po_number && <span>PO: <b style={{ color: 'var(--text-secondary)' }}>{r.po_number}</b></span>}
                {r.eta_date && <span>ETA: <b style={{ color: '#60a5fa' }}>{fmt(r.eta_date)}</b></span>}
                {r.ship_date && <span>Shipped: <b style={{ color: 'var(--text-secondary)' }}>{fmt(r.ship_date)}</b></span>}
                {r.tracking_number && <span>Tracking: <b style={{ color: 'var(--text-secondary)' }}>{r.tracking_number}</b>{r.carrier ? ` (${r.carrier})` : ''}</span>}
              </div>
              {r.classification === 'review' && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                  <input
                    style={{ ...inputStyle, flex: 1, minWidth: '140px' }}
                    placeholder="PO number to link (e.g. PO1234)"
                    value={linkInputs[r.id] || ''}
                    onChange={e => setLinkInputs(prev => ({ ...prev, [r.id]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && (linkInputs[r.id] || '').trim() && resolve(r, linkInputs[r.id].trim())}
                  />
                  <button
                    onClick={() => resolve(r, (linkInputs[r.id] || '').trim() || null)}
                    disabled={busy === r.id || !(linkInputs[r.id] || '').trim()}
                    style={{ padding: '7px 12px', borderRadius: '8px', background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.4)', color: '#22c55e', fontSize: '11px', fontWeight: 700, cursor: 'pointer', opacity: busy === r.id || !(linkInputs[r.id] || '').trim() ? 0.5 : 1 }}
                  >
                    Link &amp; Apply
                  </button>
                  <button
                    onClick={() => resolve(r, null)}
                    disabled={busy === r.id}
                    style={{ padding: '7px 12px', borderRadius: '8px', background: 'none', border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
