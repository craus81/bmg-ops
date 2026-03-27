'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_ORDER, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus, NotificationPreferences } from '@/lib/types';

export default function SettingsPage() {
  const router = useRouter();
  const { user, profile } = useAuth();
  const supabase = createClient();

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!user) return;
    loadPrefs();
  }, [user]);

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
        notify_shipped: true,
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
      notify_shipped: prefs.notify_shipped,
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
    border: '1px solid #2a3a4d', background: '#0f1720',
    color: '#f5f8fc', fontSize: '12px',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '9px', fontWeight: 700, color: '#e8f0f8',
    textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '3px',
  };

  const sectionStyle: React.CSSProperties = {
    padding: '14px', borderRadius: '12px', background: '#141e2b',
    border: '1px solid #1e2d3d', marginBottom: '10px',
  };

  if (loading || !prefs) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0', color: '#e8f0f8', fontSize: '13px' }}>
        Loading settings...
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Notification Settings</div>

      {/* Graphics Job Notifications */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: '#f5f8fc', marginBottom: '10px' }}>Graphics Job Alerts</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_new_job} onChange={e => setPrefs({ ...prefs, notify_new_job: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>New Job Created</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Get notified when a new graphics job is created or flagged from a PO</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_status_change} onChange={e => setPrefs({ ...prefs, notify_status_change: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Status Changes</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Get notified when any job status changes</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_ready} onChange={e => setPrefs({ ...prefs, notify_ready: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Ready to Install</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Get notified when a job is marked ready to install</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_shipped} onChange={e => setPrefs({ ...prefs, notify_shipped: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Shipped</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Get notified when a job is shipped with tracking info</div>
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
                    background: isSelected ? `${GRAPHICS_STATUS_COLORS[s]}22` : '#0f1720',
                    border: `1px solid ${isSelected ? GRAPHICS_STATUS_COLORS[s] : '#1e2d3d'}`,
                    color: isSelected ? GRAPHICS_STATUS_COLORS[s] : '#e8f0f8',
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
        <div style={{ fontSize: '14px', fontWeight: 800, color: '#f5f8fc', marginBottom: '10px' }}>Delivery Methods</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_in_app} onChange={e => setPrefs({ ...prefs, notify_in_app: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>In-App Notifications</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Show alerts in the notification bell</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_email} onChange={e => setPrefs({ ...prefs, notify_email: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Email Notifications</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Send alerts to {profile?.email || 'your email'}</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_sms} onChange={e => setPrefs({ ...prefs, notify_sms: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Text Message (SMS)</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Send text alerts to your phone</div>
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

      {/* Chat Message Delivery */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: '#f5f8fc', marginBottom: '4px' }}>Chat Message Delivery</div>
        <div style={{ fontSize: '11px', color: '#e8f0f8', marginBottom: '10px' }}>
          Choose how you receive in-app chat messages when you're away
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* SMS for messages */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.sms_messages} onChange={e => setPrefs({ ...prefs, sms_messages: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>SMS Text Messages</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Receive chat messages as texts. Reply via SMS and it appears in the app.</div>
            </div>
          </label>

          {/* Email for messages */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.email_messages} onChange={e => setPrefs({ ...prefs, email_messages: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: '#f5f8fc' }}>Email Notifications</div>
              <div style={{ fontSize: '10px', color: '#e8f0f8' }}>Get an email when someone sends you a chat message.</div>
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
                    background: prefs.sms_messages_mode === 'always' ? 'rgba(59,130,246,0.15)' : '#0f1720',
                    border: `1px solid ${prefs.sms_messages_mode === 'always' ? '#3b82f6' : '#1e2d3d'}`,
                    color: prefs.sms_messages_mode === 'always' ? '#60a5fa' : '#e8f0f8',
                    cursor: 'pointer',
                  }}
                >
                  Every message
                </button>
                <button
                  onClick={() => setPrefs({ ...prefs, sms_messages_mode: 'unread_only' })}
                  style={{
                    padding: '6px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
                    background: prefs.sms_messages_mode === 'unread_only' ? 'rgba(59,130,246,0.15)' : '#0f1720',
                    border: `1px solid ${prefs.sms_messages_mode === 'unread_only' ? '#3b82f6' : '#1e2d3d'}`,
                    color: prefs.sms_messages_mode === 'unread_only' ? '#60a5fa' : '#e8f0f8',
                    cursor: 'pointer',
                  }}
                >
                  Only if unread
                </button>
              </div>
              <div style={{ fontSize: '10px', color: '#e8f0f8', marginTop: '4px' }}>
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
              <div style={{ fontSize: '10px', color: '#e8f0f8', marginTop: '2px' }}>Enter your phone number in the Delivery Methods section above to enable SMS.</div>
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
          border: '1px solid #1e2d3d', background: 'transparent',
          color: '#dce6f0', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
        }}
      >
        ← Back
      </button>
    </div>
  );
}
