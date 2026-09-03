'use client';

/**
 * Super-admin view/edit of another user's settings, embedded in the admin
 * Users page's Edit User modal (field ask 2026-08-21: "I wanna be able to
 * change everyone's settings as a super admin... go in and look at their
 * settings"). Mirrors the user's own Settings page for everything stored
 * server-side — notification preferences and the email signature — via
 * /api/admin/user-settings (notification_preferences RLS is own-rows-only,
 * so the browser client can't reach another user's row directly).
 *
 * Device-bound settings (text size, push enrollment) live in each device's
 * browser and can't be viewed or changed from here — the panel says so.
 */

import { useState, useEffect } from 'react';
import PhoneInput from '@/components/PhoneInput';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_ORDER, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus } from '@/lib/types';

interface Prefs {
  notify_new_job: boolean;
  notify_status_change: boolean;
  notify_ready: boolean;
  notify_ready_for_install: boolean;
  notify_invoicing: boolean;
  notify_shipped: boolean;
  notify_new_po: boolean;
  notify_in_app: boolean;
  notify_email: boolean;
  notify_sms: boolean;
  sms_messages: boolean;
  email_messages: boolean;
  /** Opt-out (default true): email on every @mention. */
  email_mentions: boolean;
  sms_messages_mode: 'always' | 'unread_only';
  phone_number: string | null;
  custom_statuses: string[] | null;
}

const DEFAULT_PREFS: Prefs = {
  notify_new_job: true, notify_status_change: true, notify_ready: true,
  notify_ready_for_install: false, notify_invoicing: false, notify_shipped: true,
  notify_new_po: false, notify_in_app: true, notify_email: false, notify_sms: false,
  sms_messages: false, email_messages: false, email_mentions: true, sms_messages_mode: 'always',
  phone_number: null, custom_statuses: null,
};

// Same vocabulary as the user's own Settings page.
const ALERT_TOGGLES: [keyof Prefs, string][] = [
  ['notify_new_job', 'New Job Created'],
  ['notify_status_change', 'Status Changes'],
  ['notify_ready', 'Ready to Install'],
  ['notify_ready_for_install', 'Install-Ready Alerts (all vehicles)'],
  ['notify_shipped', 'Shipped'],
  ['notify_invoicing', 'Invoicing Alerts'],
  ['notify_new_po', 'New Purchase Orders'],
];
const DELIVERY_TOGGLES: [keyof Prefs, string][] = [
  ['notify_in_app', 'In-App Notifications'],
  ['notify_email', 'Email Notifications'],
  ['notify_sms', 'Text Message (SMS)'],
];
const MESSAGE_TOGGLES: [keyof Prefs, string][] = [
  ['sms_messages', 'Text me about direct messages'],
  ['email_messages', 'Email me about direct messages'],
  ['email_mentions', 'Email me when I\'m @mentioned (on by default)'],
];

export default function AdminUserSettings({ userId, userName }: { userId: string; userName: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hadPrefsRow, setHadPrefsRow] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [signature, setSignature] = useState('');
  const [sigLogo, setSigLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const res = await fetch(`/api/admin/user-settings?userId=${encodeURIComponent(userId)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(data.error || 'Failed to load settings'); return; }
        setSignature(data.profile?.email_signature || '');
        setSigLogo(!!data.profile?.email_signature_logo);
        setHadPrefsRow(!!data.prefs);
        setPrefs({ ...DEFAULT_PREFS, ...(data.prefs || {}) });
      } catch {
        if (!cancelled) setError('Network error loading settings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, userId]);

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const res = await fetch('/api/admin/user-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          email_signature: signature.trim() || null,
          email_signature_logo: sigLogo,
          prefs: {
            notify_new_job: prefs.notify_new_job,
            notify_status_change: prefs.notify_status_change,
            notify_ready: prefs.notify_ready,
            notify_ready_for_install: prefs.notify_ready_for_install,
            notify_invoicing: prefs.notify_invoicing,
            notify_shipped: prefs.notify_shipped,
            notify_new_po: prefs.notify_new_po,
            notify_in_app: prefs.notify_in_app,
            notify_email: prefs.notify_email,
            notify_sms: prefs.notify_sms,
            sms_messages: prefs.sms_messages,
            email_messages: prefs.email_messages,
            email_mentions: prefs.email_mentions ?? true,
            sms_messages_mode: prefs.sms_messages_mode,
            phone_number: prefs.phone_number,
            custom_statuses: prefs.custom_statuses,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Save failed'); return; }
      setHadPrefsRow(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Network error saving settings');
    } finally {
      setSaving(false);
    }
  };

  const toggleCustomStatus = (s: GraphicsJobStatus) => {
    setPrefs(prev => {
      const current = prev.custom_statuses || [];
      const updated = current.includes(s) ? current.filter(x => x !== s) : [...current, s];
      return { ...prev, custom_statuses: updated.length > 0 ? updated : null };
    });
  };

  const toggleRow = ([key, label]: [keyof Prefs, string]) => (
    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: 'var(--text-body)' }}>
      <input
        type="checkbox"
        checked={!!prefs[key]}
        onChange={e => setPrefs(prev => ({ ...prev, [key]: e.target.checked }))}
      />
      {label}
    </label>
  );

  const groupLabel: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', margin: '8px 0 4px',
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: '8px 12px', borderRadius: '10px', fontSize: '12px', fontWeight: 700,
          background: 'rgba(244,114,182,0.08)', border: '1px solid rgba(244,114,182,0.3)',
          color: '#f472b6', cursor: 'pointer', textAlign: 'left',
        }}
      >
        ⚙ View &amp; edit {userName}&apos;s settings (super admin)
      </button>
    );
  }

  return (
    <div style={{ padding: '10px', borderRadius: '10px', background: 'var(--subtle-bg)', border: '1px solid rgba(244,114,182,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <div style={{ fontSize: '12px', fontWeight: 800, color: '#f472b6' }}>{userName}&apos;s settings</div>
        <button type="button" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '13px', cursor: 'pointer' }}>Hide</button>
      </div>

      {loading ? (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading…</div>
      ) : (
        <>
          {!hadPrefsRow && (
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>
              This user hasn&apos;t saved notification preferences yet — these are the defaults; saving writes them to their account.
            </div>
          )}

          <div style={groupLabel}>Graphics Job Alerts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {ALERT_TOGGLES.map(toggleRow)}
          </div>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '6px' }}>
            {GRAPHICS_STATUS_ORDER.filter(s => s !== 'cancelled' && s !== 'flagged').map(s => {
              const isSelected = prefs.custom_statuses?.includes(s);
              return (
                <button key={s} type="button" onClick={() => toggleCustomStatus(s)} style={{
                  padding: '3px 7px', borderRadius: '5px', fontSize: '9px', fontWeight: 700,
                  background: isSelected ? `${GRAPHICS_STATUS_COLORS[s]}22` : 'var(--input-bg)',
                  border: `1px solid ${isSelected ? GRAPHICS_STATUS_COLORS[s] : 'var(--border)'}`,
                  color: isSelected ? GRAPHICS_STATUS_COLORS[s] : 'var(--text-label)',
                  cursor: 'pointer',
                }}>{GRAPHICS_STATUS_LABELS[s]}</button>
              );
            })}
          </div>

          <div style={groupLabel}>Delivery Methods</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {DELIVERY_TOGGLES.map(toggleRow)}
          </div>

          <div style={groupLabel}>Direct Messages</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
            {MESSAGE_TOGGLES.map(toggleRow)}
            {prefs.sms_messages && (
              <select
                value={prefs.sms_messages_mode}
                onChange={e => setPrefs(prev => ({ ...prev, sms_messages_mode: e.target.value as Prefs['sms_messages_mode'] }))}
                style={{ padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
              >
                <option value="always">Text for every message</option>
                <option value="unread_only">Only when unread</option>
              </select>
            )}
          </div>

          <div style={groupLabel}>SMS Phone Number</div>
          <PhoneInput
            value={prefs.phone_number || ''}
            onChange={(v: string) => setPrefs(prev => ({ ...prev, phone_number: v || null }))}
            style={{ width: '100%', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px' }}
          />

          <div style={groupLabel}>Email Signature</div>
          <textarea
            value={signature}
            onChange={e => setSignature(e.target.value)}
            placeholder="No signature set"
            style={{ width: '100%', minHeight: '56px', padding: '6px 8px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-body)', fontSize: '11px', resize: 'vertical', fontFamily: 'inherit' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: 'var(--text-body)', marginTop: '4px' }}>
            <input type="checkbox" checked={sigLogo} onChange={e => setSigLogo(e.target.checked)} />
            Include the BMG logo under the signature
          </label>

          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '8px' }}>
            Text size and push-notification enrollment are per-device (stored in each browser) and can&apos;t be changed from here.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px' }}>
            <button type="button" onClick={save} disabled={saving} style={{
              padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
              background: '#f472b6', color: '#fff', border: 'none', cursor: 'pointer',
              opacity: saving ? 0.6 : 1,
            }}>{saving ? 'Saving…' : 'Save Their Settings'}</button>
            {saved && <span style={{ fontSize: '11px', fontWeight: 700, color: '#22c55e' }}>✓ Saved</span>}
          </div>
          {error && <div style={{ fontSize: '11px', color: 'var(--error, #ef4444)', marginTop: '6px' }}>{error}</div>}
        </>
      )}
    </div>
  );
}
