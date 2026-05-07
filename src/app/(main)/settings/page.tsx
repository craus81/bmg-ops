'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_ORDER, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus, NotificationPreferences } from '@/lib/types';
import { isPushSupported, getPushPermission, getExistingSubscription, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';

export default function SettingsPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Push notification state
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushPermission, setPushPermission] = useState<string>('default');

  useEffect(() => {
    if (!user) return;
    loadPrefs();
    checkPushStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user]);

  const checkPushStatus = async () => {
    const supported = isPushSupported();
    setPushSupported(supported);
    if (supported) {
      setPushPermission(getPushPermission() as string);
      const sub = await getExistingSubscription();
      setPushEnabled(!!sub);
    }
  };

  const handlePushToggle = async () => {
    setPushLoading(true);
    setPushError('');

    if (pushEnabled) {
      const result = await unsubscribeFromPush();
      if (result.ok) {
        setPushEnabled(false);
      } else {
        setPushError(result.error || 'Failed to unsubscribe');
      }
    } else {
      const result = await subscribeToPush();
      if (result.ok) {
        setPushEnabled(true);
        setPushPermission('granted');
      } else {
        setPushError(result.error || 'Failed to subscribe');
      }
    }

    setPushLoading(false);
  };

  const loadPrefs = async () => {
    const { data } = await supabase
      .from('notification_preferences')
      .select('*')
      .eq('user_id', user!.id)
      .maybeSingle();

    if (data) {
      setPrefs(data as NotificationPreferences);
    } else {
      // Create defaults
      setPrefs({
        id: '',
        user_id: user!.id,
        notify_new_job: true,
        notify_status_change: true,
        notify_ready: true,
        notify_ready_for_install: false,
        notify_shipped: true,
        notify_new_po: false,
        notify_in_app: true,
        notify_email: false,
        notify_sms: false,
        phone_number: null,
        custom_statuses: null,
        sms_messages: false,
        sms_messages_mode: 'always' as const,
        email_messages: false,
      });
    }
    setLoading(false);
  };

  const savePrefs = async () => {
    if (!prefs || !user) return;
    setSaving(true);
    setSaved(false);

    const payload = {
      user_id: user.id,
      notify_new_job: prefs.notify_new_job,
      notify_status_change: prefs.notify_status_change,
      notify_ready: prefs.notify_ready,
      notify_ready_for_install: prefs.notify_ready_for_install ?? false,
      notify_shipped: prefs.notify_shipped,
      notify_new_po: prefs.notify_new_po,
      notify_in_app: prefs.notify_in_app,
      notify_email: prefs.notify_email,
      notify_sms: prefs.notify_sms,
      phone_number: prefs.phone_number,
      custom_statuses: prefs.custom_statuses,
      sms_messages: prefs.sms_messages,
      sms_messages_mode: prefs.sms_messages_mode,
      email_messages: prefs.email_messages,
      updated_at: new Date().toISOString(),
    };

    if (prefs.id) {
      await supabase.from('notification_preferences').update(payload).eq('id', prefs.id);
    } else {
      const { data } = await supabase.from('notification_preferences').insert(payload).select().single();
      if (data) setPrefs(data as NotificationPreferences);
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const toggleCustomStatus = (status: GraphicsJobStatus) => {
    if (!prefs) return;
    const current = prefs.custom_statuses || [];
    const updated = current.includes(status)
      ? current.filter(s => s !== status)
      : [...current, status];
    setPrefs({ ...prefs, custom_statuses: updated.length > 0 ? updated : null });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px',
    border: '1px solid var(--border)', background: 'var(--input-bg)',
    color: 'var(--text-body)', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: 'var(--text-label)',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  const sectionStyle: React.CSSProperties = {
    padding: '14px', borderRadius: '12px', background: 'var(--subtle-bg)',
    border: '1px solid var(--border)', marginBottom: '10px',
  };

  if (loading || !prefs) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-label)', fontSize: '13px' }}>
        Loading settings...
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Notification Settings</div>

      {/* Graphics Job Notifications */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '10px' }}>Graphics Job Alerts</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_new_job} onChange={e => setPrefs({ ...prefs, notify_new_job: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>New Job Created</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when a new graphics job is created or flagged from a PO</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_status_change} onChange={e => setPrefs({ ...prefs, notify_status_change: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Status Changes</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when any job status changes</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_ready} onChange={e => setPrefs({ ...prefs, notify_ready: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Ready to Install</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when a job is marked ready to install</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={prefs.notify_ready_for_install ?? false}
              onChange={e => setPrefs({ ...prefs, notify_ready_for_install: e.target.checked })}
            />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Install-Ready Alerts (all vehicles)</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Notify me when any vehicle becomes ready to install, even if not assigned to me. Assigned installers and admins always get these.</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_shipped} onChange={e => setPrefs({ ...prefs, notify_shipped: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Shipped</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when a job is shipped with tracking info</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_new_po} onChange={e => setPrefs({ ...prefs, notify_new_po: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>New Purchase Orders</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when new POs are found in Gmail and queued for review</div>
            </div>
          </label>
        </div>

        {/* Custom status alerts */}
        <div style={{ marginTop: '12px' }}>
          <div style={labelStyle}>Additional Status Alerts (optional)</div>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
            {GRAPHICS_STATUS_ORDER.filter(s => s !== 'cancelled' && s !== 'flagged').map(s => {
              const isSelected = prefs.custom_statuses?.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleCustomStatus(s)}
                  style={{
                    padding: '4px 8px', borderRadius: '5px', fontSize: '10px', fontWeight: 700,
                    background: isSelected ? `${GRAPHICS_STATUS_COLORS[s]}22` : 'var(--input-bg)',
                    border: `1px solid ${isSelected ? GRAPHICS_STATUS_COLORS[s] : 'var(--border)'}`,
                    color: isSelected ? GRAPHICS_STATUS_COLORS[s] : 'var(--text-label)',
                    cursor: 'pointer',
                  }}
                >
                  {GRAPHICS_STATUS_LABELS[s]}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Delivery Methods */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '10px' }}>Delivery Methods</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_in_app} onChange={e => setPrefs({ ...prefs, notify_in_app: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>In-App Notifications</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Show alerts in the notification bell</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_email} onChange={e => setPrefs({ ...prefs, notify_email: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Email Notifications</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Send alerts to {profile?.email || 'your email'}</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_sms} onChange={e => setPrefs({ ...prefs, notify_sms: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Text Message (SMS)</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Send text alerts to your phone</div>
            </div>
          </label>

          {prefs.notify_sms && (
            <div style={{ marginLeft: '30px' }}>
              <div style={labelStyle}>Phone Number</div>
              <input
                style={{ ...inputStyle, maxWidth: '200px' }}
                placeholder="(555) 123-4567"
                value={prefs.phone_number || ''}
                onChange={e => setPrefs({ ...prefs, phone_number: e.target.value })}
              />
            </div>
          )}
        </div>
      </div>

      {/* Browser Push Notifications */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Browser Push Notifications</div>
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
          Receive notifications even when the app is in the background. Works on Safari (Mac), Chrome, Firefox, and Edge.
        </div>

        {!pushSupported ? (
          <div style={{ padding: '10px 12px', borderRadius: '8px', background: 'rgba(107,114,128,0.08)', border: '1px solid rgba(107,114,128,0.2)' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-label)' }}>
              Push notifications are not supported in this browser. Try using Safari, Chrome, or Firefox.
            </div>
          </div>
        ) : (
          <>
            <button
              onClick={handlePushToggle}
              disabled={pushLoading || pushPermission === 'denied'}
              style={{
                width: '100%', padding: '12px', borderRadius: '10px',
                background: pushEnabled ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)',
                border: `1px solid ${pushEnabled ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`,
                color: pushEnabled ? '#22c55e' : '#3b82f6',
                fontSize: '13px', fontWeight: 700, cursor: pushLoading || pushPermission === 'denied' ? 'not-allowed' : 'pointer',
                opacity: pushLoading ? 0.5 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              }}
            >
              {pushLoading ? 'Working...' : pushEnabled ? 'Push Notifications Enabled — Tap to Disable' : 'Enable Push Notifications'}
            </button>

            {pushPermission === 'denied' && (
              <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <div style={{ fontSize: '11px', fontWeight: 700, color: '#ef4444' }}>Permission Denied</div>
                <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>
                  Notifications are blocked for this site. To fix this, open your browser settings and allow notifications for this site, then refresh the page.
                </div>
              </div>
            )}

            {pushError && pushPermission !== 'denied' && (
              <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                <div style={{ fontSize: '11px', color: '#ef4444' }}>{pushError}</div>
              </div>
            )}

            {pushEnabled && (
              <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-label)' }}>
                This device will receive push notifications for the alert types you have enabled above.
              </div>
            )}
          </>
        )}
      </div>

      {/* Chat Message Delivery */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Chat Message Delivery</div>
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
          Choose how you receive in-app chat messages when you're away
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* SMS for messages */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.sms_messages} onChange={e => setPrefs({ ...prefs, sms_messages: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>SMS Text Messages</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Receive chat messages as texts. Reply via SMS and it appears in the app.</div>
            </div>
          </label>

          {/* Email for messages */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.email_messages} onChange={e => setPrefs({ ...prefs, email_messages: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Email Notifications</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get an email when someone sends you a chat message.</div>
            </div>
          </label>

          {/* SMS mode selector */}
          {prefs.sms_messages && (
            <div style={{ marginLeft: '30px' }}>
              <div style={labelStyle}>When to send SMS</div>
              <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                <button
                  onClick={() => setPrefs({ ...prefs, sms_messages_mode: 'always' })}
                  style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: prefs.sms_messages_mode === 'always' ? 'rgba(59,130,246,0.15)' : 'var(--input-bg)',
                    border: `1px solid ${prefs.sms_messages_mode === 'always' ? '#3b82f6' : 'var(--border)'}`,
                    color: prefs.sms_messages_mode === 'always' ? '#60a5fa' : 'var(--text-label)',
                    cursor: 'pointer',
                  }}
                >
                  Every message
                </button>
                <button
                  onClick={() => setPrefs({ ...prefs, sms_messages_mode: 'unread_only' })}
                  style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: prefs.sms_messages_mode === 'unread_only' ? 'rgba(59,130,246,0.15)' : 'var(--input-bg)',
                    border: `1px solid ${prefs.sms_messages_mode === 'unread_only' ? '#3b82f6' : 'var(--border)'}`,
                    color: prefs.sms_messages_mode === 'unread_only' ? '#60a5fa' : 'var(--text-label)',
                    cursor: 'pointer',
                  }}
                >
                  Only if unread
                </button>
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '4px' }}>
                {prefs.sms_messages_mode === 'always'
                  ? 'Every message you receive will also be sent as a text.'
                  : 'Only sends a text if you haven\'t read the message in the app.'}
              </div>
            </div>
          )}

          {/* Phone number warning */}
          {prefs.sms_messages && !prefs.phone_number && (
            <div style={{ marginLeft: '30px', padding: '8px 10px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#ef4444' }}>Phone number required</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '2px' }}>Enter your phone number in the Delivery Methods section above to enable SMS.</div>
            </div>
          )}
        </div>
      </div>

      {/* Save button */}
      <button
        onClick={savePrefs}
        disabled={saving}
        style={{
          width: '100%', padding: '14px', borderRadius: '12px',
          background: saved ? '#22c55e' : '#3b82f6',
          color: '#fff', fontWeight: 800, fontSize: '14px', border: 'none',
          cursor: 'pointer', opacity: saving ? 0.5 : 1,
          transition: 'background 0.3s',
        }}
      >
        {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Preferences'}
      </button>

      <button
        onClick={() => router.push('/more')}
        style={{
          width: '100%', padding: '10px', borderRadius: '10px', marginTop: '8px',
          border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--text-body)', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        }}
      >
        ← Back
      </button>
    </div>
  );
}
