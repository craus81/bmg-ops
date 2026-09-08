'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { useAuth } from '@/components/AuthProvider';
import PhoneInput from '@/components/PhoneInput';
import TextSizeToggle from '@/components/TextSizeToggle';
import { GRAPHICS_STATUS_LABELS, GRAPHICS_STATUS_ORDER, GRAPHICS_STATUS_COLORS } from '@/lib/types';
import type { GraphicsJobStatus, NotificationPreferences } from '@/lib/types';
import { isPushSupported, getPushPermission, getExistingSubscription, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { FALLBACK_SALES_TAX_RATE_PCT } from '@/lib/sales-tax';
import { apiFetch } from '@/lib/api-client';

export default function SettingsPage() {
  const router = useRouter();
  const { user, profile, isAdmin, hasRole } = useAuth();
  const supabase = createClient();

  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Change password state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState('');

  // Email signature state — appended by the server to every customer email
  // this user composes (estimates, invoices, wrap quotes, statements…).
  const [signature, setSignature] = useState('');
  const [sigLogo, setSigLogo] = useState(false);
  const [sigSaving, setSigSaving] = useState(false);
  const [sigSaved, setSigSaved] = useState(false);
  const [sigError, setSigError] = useState('');

  // Company sales tax rate — the ONE rate every estimate and wrap quote bills
  // at. Super admins only: it used to be a free-text box on every estimate.
  const isSuperAdmin = hasRole('super_admin');
  const [taxPct, setTaxPct] = useState<string>('');
  const [taxSaving, setTaxSaving] = useState(false);
  const [taxSaved, setTaxSaved] = useState(false);
  const [taxError, setTaxError] = useState('');

  // NetSuite labor item — the ONE item every pushed estimate and sales order
  // bills labor to. Unset means the server picks the best-matching LABOR item
  // in NetSuite; when nothing matches, labor never reaches NetSuite at all,
  // so this panel always states which of the two is happening.
  const [laborItem, setLaborItem] = useState<{
    configured_item_number: string | null;
    resolved: { id: string; itemNumber: string | null; source: string } | null;
    error?: string;
    candidates: { id: string; itemNumber: string }[];
  } | null>(null);
  const [laborInput, setLaborInput] = useState('');
  const [laborBusy, setLaborBusy] = useState(false);
  const [laborSaved, setLaborSaved] = useState(false);
  const [laborError, setLaborError] = useState('');

  // Push notification state
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState('');
  const [pushPermission, setPushPermission] = useState<string>('default');

  // Test-push state: human-readable diagnostic lines from /api/push/test
  const [testLoading, setTestLoading] = useState(false);
  const [testResults, setTestResults] = useState<{ ok: boolean; text: string }[] | null>(null);

  useEffect(() => {
    if (!user) return;
    loadPrefs();
    checkPushStatus();
    supabase.from('profiles').select('email_signature, email_signature_logo').eq('id', user.id).maybeSingle()
      .then(({ data }: { data: { email_signature: string | null; email_signature_logo: boolean | null } | null }) => {
        setSignature(data?.email_signature || '');
        setSigLogo(!!data?.email_signature_logo);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: load once on mount
  }, [user]);

  useEffect(() => {
    if (!isSuperAdmin) return;
    apiFetch('/api/admin/sales-tax')
      .then(r => r.json())
      .then(d => setTaxPct(String(d?.sales_tax_rate_pct ?? FALLBACK_SALES_TAX_RATE_PCT)))
      .catch(() => {});
  }, [isSuperAdmin]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once, when the Company section becomes visible
  useEffect(() => { if (isSuperAdmin) loadLaborItem(); }, [isSuperAdmin]);

  // Blended shop labor cost rate (R3-21, migration 269) — super-admin write,
  // same posture as the tax rate and labor item above.
  const [shopRate, setShopRate] = useState('');
  const [shopRateBusy, setShopRateBusy] = useState(false);
  const [shopRateSaved, setShopRateSaved] = useState(false);
  const [shopRateError, setShopRateError] = useState('');
  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      try {
        const res = await apiFetch('/api/admin/shop-labor-rate');
        const data = await res.json();
        if (res.ok) setShopRate(data.rate != null ? String(data.rate) : '');
      } catch { /* the card still renders; saving surfaces errors */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per admin session
  }, [isSuperAdmin]);

  const handleSaveShopRate = async () => {
    setShopRateBusy(true);
    setShopRateError('');
    try {
      const trimmed = shopRate.trim();
      const parsedRate = trimmed === '' ? null : parseFloat(trimmed);
      if (parsedRate != null && (!Number.isFinite(parsedRate) || parsedRate < 0)) {
        setShopRateError('Enter a dollar amount per hour, or leave blank to clear.');
        return;
      }
      const res = await apiFetch('/api/admin/shop-labor-rate', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate: parsedRate }),
      });
      const data = await res.json();
      if (!res.ok) { setShopRateError(data?.error || 'Could not save the rate.'); return; }
      setShopRate(data.rate != null ? String(data.rate) : '');
      setShopRateSaved(true);
      setTimeout(() => setShopRateSaved(false), 2500);
    } catch (e: any) {
      setShopRateError(e?.message || 'Could not save the rate.');
    } finally {
      setShopRateBusy(false);
    }
  };

  // Shop crew capacity (R5-16, migration 279) — crew × shift hours is the
  // week planner's daily denominator. Super-admin write, same posture as
  // the cost rate above.
  const [crewSize, setCrewSize] = useState('');
  const [shiftHours, setShiftHours] = useState('');
  const [capBusy, setCapBusy] = useState(false);
  const [capSaved, setCapSaved] = useState(false);
  const [capError, setCapError] = useState('');
  useEffect(() => {
    if (!isSuperAdmin) return;
    (async () => {
      try {
        const res = await apiFetch('/api/admin/shop-capacity');
        const data = await res.json();
        if (res.ok) {
          setCrewSize(data.crewSize != null ? String(data.crewSize) : '');
          setShiftHours(data.shiftHours != null ? String(data.shiftHours) : '');
        }
      } catch { /* the card still renders; saving surfaces errors */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per admin session
  }, [isSuperAdmin]);

  const handleSaveCapacity = async () => {
    setCapBusy(true);
    setCapError('');
    try {
      const crewTrim = crewSize.trim();
      const shiftTrim = shiftHours.trim();
      if ((crewTrim === '') !== (shiftTrim === '')) {
        setCapError('Set both crew size and shift hours, or clear both.');
        return;
      }
      const crew = crewTrim === '' ? null : parseInt(crewTrim, 10);
      const shift = shiftTrim === '' ? null : parseFloat(shiftTrim);
      if ((crew != null && (!Number.isFinite(crew) || crew < 0)) || (shift != null && (!Number.isFinite(shift) || shift < 0))) {
        setCapError('Enter whole people and hours per day, or leave both blank to clear.');
        return;
      }
      const res = await apiFetch('/api/admin/shop-capacity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewSize: crew, shiftHours: shift }),
      });
      const data = await res.json();
      if (!res.ok) { setCapError(data?.error || 'Could not save capacity.'); return; }
      setCrewSize(data.crewSize != null ? String(data.crewSize) : '');
      setShiftHours(data.shiftHours != null ? String(data.shiftHours) : '');
      setCapSaved(true);
      setTimeout(() => setCapSaved(false), 2500);
    } catch (e: any) {
      setCapError(e?.message || 'Could not save capacity.');
    } finally {
      setCapBusy(false);
    }
  };

  // Customer booking hours/slots (R5-17) — plain-admin ops config for the
  // public pickup/drop-off pages. Whole-object load/save via
  // /api/admin/booking-settings.
  const [bookingCfg, setBookingCfg] = useState<any | null>(null);
  const [bookingBusy, setBookingBusy] = useState(false);
  const [bookingSaved, setBookingSaved] = useState(false);
  const [bookingError, setBookingError] = useState('');
  const [blockDraft, setBlockDraft] = useState('');
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch('/api/admin/booking-settings')
      .then(r => r.json())
      .then(d => { if (d && !d.error) setBookingCfg(d); })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per admin session
  }, [isAdmin]);

  const handleSaveBooking = async () => {
    if (!bookingCfg) return;
    setBookingBusy(true);
    setBookingError('');
    try {
      const res = await apiFetch('/api/admin/booking-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bookingCfg),
      });
      const data = await res.json();
      if (!res.ok) { setBookingError(data?.error || 'Could not save booking settings.'); return; }
      setBookingCfg(data);
      setBookingSaved(true);
      setTimeout(() => setBookingSaved(false), 2500);
    } catch (e: any) {
      setBookingError(e?.message || 'Could not save booking settings.');
    } finally {
      setBookingBusy(false);
    }
  };

  const handleSaveTax = async () => {
    setTaxSaving(true);
    setTaxError('');
    try {
      const res = await apiFetch('/api/admin/sales-tax', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sales_tax_rate_pct: parseFloat(taxPct) }),
      });
      const data = await res.json();
      if (!res.ok) { setTaxError(data?.error || 'Could not save the sales tax rate.'); return; }
      // Show what actually landed, not what was typed.
      setTaxPct(String(data.sales_tax_rate_pct));
      setTaxSaved(true);
      setTimeout(() => setTaxSaved(false), 2500);
    } catch (e: any) {
      setTaxError(e?.message || 'Could not save the sales tax rate.');
    } finally {
      setTaxSaving(false);
    }
  };

  const loadLaborItem = async () => {
    setLaborBusy(true);
    setLaborError('');
    try {
      const res = await apiFetch('/api/admin/labor-item');
      const data = await res.json();
      if (!res.ok) { setLaborError(data?.error || 'Could not read the labor item.'); return; }
      setLaborItem(data);
      setLaborInput(data.configured_item_number || '');
    } catch (e: any) {
      setLaborError(e?.message || 'Could not read the labor item.');
    } finally {
      setLaborBusy(false);
    }
  };

  const handleSaveLaborItem = async () => {
    setLaborBusy(true);
    setLaborError('');
    try {
      const res = await apiFetch('/api/admin/labor-item', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_number: laborInput.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setLaborError(data?.error || 'Could not save the labor item.'); return; }
      setLaborSaved(true);
      setTimeout(() => setLaborSaved(false), 2500);
    } catch (e: any) {
      setLaborError(e?.message || 'Could not save the labor item.');
      return;
    } finally {
      setLaborBusy(false);
    }
    // Re-read so the panel shows what the push will actually use, not what
    // was typed.
    await loadLaborItem();
  };

  const handleSaveSignature = async () => {
    if (!user) return;
    setSigSaving(true);
    setSigError('');
    const { error } = await supabase
      .from('profiles')
      .update({ email_signature: signature.trim() || null, email_signature_logo: sigLogo })
      .eq('id', user.id);
    setSigSaving(false);
    if (error) { setSigError(error.message); return; }
    setSigSaved(true);
    setTimeout(() => setSigSaved(false), 2500);
  };

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

  const handleTestPush = async () => {
    setTestLoading(true);
    setTestResults(null);
    try {
      const res = await fetch('/api/push/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);

      const lines: { ok: boolean; text: string }[] = [];
      const n = data.native;
      if (n.missingEnv?.length) {
        lines.push({ ok: false, text: `iPhone/iPad app: server is missing ${n.missingEnv.join(', ')} — add them in Vercel and redeploy.` });
      } else if (n.tableError) {
        lines.push({ ok: false, text: `iPhone/iPad app: database says "${n.tableError}" — the native_push_tokens table is missing (run migration 127 in Supabase).` });
      } else if (n.devices === 0) {
        lines.push({ ok: false, text: 'iPhone/iPad app: no devices registered for your account. Open the app, allow notifications when asked, then try again. (If you already allowed them, force-quit and relaunch the app.)' });
      } else if (n.sent > 0) {
        lines.push({ ok: true, text: `iPhone/iPad app: sent to ${n.sent} of ${n.devices} device${n.devices === 1 ? '' : 's'} — check your device.` });
      } else {
        // Translate Apple's rejection reason into the actual fix
        const reason = (n.reasons || []).join(', ');
        let hint = '';
        if (/TopicDisallowed|MissingTopic|DeviceTokenNotForTopic/i.test(reason)) {
          hint = ' The push key is not allowed to send to this app — in the Apple Developer portal, make sure the App ID com.bmgfleet.fleetsuite has the Push Notifications capability enabled, and that the key is Team Scoped (All Topics) or includes this topic.';
        } else if (/InvalidProviderToken|ExpiredProviderToken/i.test(reason)) {
          hint = ' The Team ID / Key ID / private key do not match — re-check all three APNS values in Vercel and redeploy.';
        } else if (/PEM|DECODER|asn1|private key/i.test(reason)) {
          hint = ' APNS_PRIVATE_KEY is not pasted correctly — re-copy the entire .p8 file including the BEGIN/END lines.';
        }
        lines.push({ ok: false, text: `iPhone/iPad app: Apple rejected the push for all ${n.devices} device${n.devices === 1 ? '' : 's'}${reason ? ` — Apple said: ${reason}.` : '.'}${hint}${n.stale ? ` (${n.stale} stale token${n.stale === 1 ? '' : 's'} removed — relaunch the app to re-register.)` : ''}` });
      }

      const w = data.web;
      if (!w.configured) {
        lines.push({ ok: false, text: 'Browser push: VAPID keys are not configured on the server.' });
      } else if (w.tableError) {
        lines.push({ ok: false, text: `Browser push: database says "${w.tableError}".` });
      } else if (w.subscriptions === 0) {
        lines.push({ ok: false, text: 'Browser push: no browsers subscribed — use the Enable Push Notifications button above on each browser you want alerts in.' });
      } else if (w.sent > 0) {
        lines.push({ ok: true, text: `Browser push: sent to ${w.sent} of ${w.subscriptions} browser${w.subscriptions === 1 ? '' : 's'}.` });
      } else {
        lines.push({ ok: false, text: `Browser push: all ${w.subscriptions} subscription${w.subscriptions === 1 ? '' : 's'} failed — they may be expired; re-enable push on those browsers.` });
      }
      setTestResults(lines);
    } catch (e: any) {
      setTestResults([{ ok: false, text: e?.message || 'Test failed' }]);
    }
    setTestLoading(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) { setPwError('Password must be at least 6 characters'); return; }
    if (newPassword !== confirmPassword) { setPwError('Passwords do not match'); return; }
    setPwSaving(true);
    setPwError('');
    setPwSaved(false);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPwSaving(false);
    if (error) {
      setPwError(error.message);
      return;
    }
    setNewPassword('');
    setConfirmPassword('');
    setPwSaved(true);
    setTimeout(() => setPwSaved(false), 3000);
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
        notify_invoicing: false,
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
        email_mentions: true,
        notify_weekly_brief: true,
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
      notify_invoicing: prefs.notify_invoicing ?? false,
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
      email_mentions: prefs.email_mentions ?? true,
      notify_weekly_brief: prefs.notify_weekly_brief ?? true,
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
      <div style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px' }}>Settings</div>

      {/* Account Security */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Change Password</div>
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
          Set a new password for {profile?.email || 'your account'}. You&apos;ll use it next time you sign in.
        </div>

        <form onSubmit={handleChangePassword}>
          <div style={labelStyle}>New Password</div>
          <input
            type="password"
            style={{ ...inputStyle, marginBottom: '8px' }}
            placeholder="At least 6 characters"
            autoComplete="new-password"
            value={newPassword}
            onChange={e => { setNewPassword(e.target.value); setPwError(''); }}
          />

          <div style={labelStyle}>Confirm New Password</div>
          <input
            type="password"
            style={{ ...inputStyle, marginBottom: '8px' }}
            placeholder="Re-enter your new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={e => { setConfirmPassword(e.target.value); setPwError(''); }}
          />

          {pwError && (
            <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', marginBottom: '8px' }}>
              <div style={{ fontSize: '11px', color: '#ef4444' }}>{pwError}</div>
            </div>
          )}

          <button
            type="submit"
            disabled={pwSaving || !newPassword || !confirmPassword}
            style={{
              width: '100%', padding: '12px', borderRadius: '10px',
              background: pwSaved ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)',
              border: `1px solid ${pwSaved ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`,
              color: pwSaved ? '#22c55e' : '#3b82f6',
              fontSize: '13px', fontWeight: 700,
              cursor: pwSaving || !newPassword || !confirmPassword ? 'not-allowed' : 'pointer',
              opacity: pwSaving ? 0.5 : 1,
            }}
          >
            {pwSaving ? 'Updating...' : pwSaved ? 'Password Updated!' : 'Update Password'}
          </button>
        </form>
      </div>

      {/* Email signature — appended to every customer email this user
          composes (estimate approvals, invoices, wrap quotes, statements,
          proofs, install guides). Plain text; the compose preview shows it. */}
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Email Signature</div>
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
          Added to the bottom of every customer email you send from FleetSuite — estimates, invoices, quotes, statements. You&apos;ll see it in the email preview before sending. Leave blank for none.
        </div>
        <textarea
          value={signature}
          onChange={e => { setSignature(e.target.value); setSigError(''); }}
          rows={4}
          maxLength={1000}
          placeholder={'Your Name\nBMG Fleet Services\n(555) 555-0100'}
          style={{ ...inputStyle, resize: 'vertical', marginBottom: '8px', fontFamily: 'inherit' }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-body)', cursor: 'pointer', marginBottom: '8px', width: 'fit-content' }}>
          <input
            type="checkbox"
            checked={sigLogo}
            onChange={e => setSigLogo(e.target.checked)}
            style={{ accentColor: '#3b82f6' }}
          />
          Include the company logo under my signature
        </label>
        {sigError && (
          <div style={{ padding: '8px 10px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', color: '#ef4444' }}>{sigError}</div>
          </div>
        )}
        <button
          onClick={handleSaveSignature}
          disabled={sigSaving}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px',
            background: sigSaved ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)',
            border: `1px solid ${sigSaved ? 'rgba(34,197,94,0.3)' : 'rgba(59,130,246,0.3)'}`,
            color: sigSaved ? '#22c55e' : '#3b82f6',
            fontSize: '13px', fontWeight: 700,
            cursor: sigSaving ? 'not-allowed' : 'pointer',
            opacity: sigSaving ? 0.5 : 1,
          }}
        >
          {sigSaving ? 'Saving...' : sigSaved ? 'Signature Saved!' : 'Save Signature'}
        </button>
      </div>

      {/* Company — super admins only. The sales tax rate is company-wide and
          read-only everywhere else; this is the one place it can change. */}
      {isSuperAdmin && (
        <>
          <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '10px', marginTop: '20px' }}>Company</div>
          <div style={sectionStyle}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Sales Tax Rate</div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
              Applied to parts on every new estimate and wrap quote. Everyone else sees it read-only in the
              builders — this is the only place it can be changed. Estimates already saved keep the rate they
              were quoted at.
            </div>
            <div style={labelStyle}>Rate (%)</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="number"
                step={0.01}
                min={0}
                max={100}
                value={taxPct}
                onChange={e => setTaxPct(e.target.value)}
                style={{ ...inputStyle, width: '120px' }}
              />
              <button
                onClick={handleSaveTax}
                disabled={taxSaving || taxPct === ''}
                style={{
                  padding: '8px 16px', borderRadius: '8px', border: 'none',
                  background: taxSaved ? '#22c55e' : '#3b82f6', color: '#fff',
                  fontSize: '12px', fontWeight: 800,
                  cursor: taxSaving ? 'default' : 'pointer', opacity: taxSaving ? 0.5 : 1,
                }}
              >
                {taxSaving ? 'Saving...' : taxSaved ? 'Saved!' : 'Save Rate'}
              </button>
            </div>
            {taxError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{taxError}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>NetSuite Labor Item</div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
              Estimate labor (hours × the shop rate) pushes to NetSuite as one line on this item. Leave it
              blank and the server picks the best-matching active LABOR item; naming it here pins which GL
              account labor posts to. If NetSuite has no labor item at all, labor is left off every pushed
              estimate and sales order.
            </div>

            <div style={{ fontSize: '11px', marginBottom: '10px', color: 'var(--text-label)' }}>
              {laborBusy && !laborItem ? 'Checking NetSuite…' : laborItem?.resolved ? (
                <>Labor currently bills to{' '}
                  <b style={{ color: 'var(--text-body)' }}>{laborItem.resolved.itemNumber || `internal id ${laborItem.resolved.id}`}</b>
                  {laborItem.resolved.source === 'search' && ' — auto-picked, save it below to pin it'}
                  {laborItem.resolved.source === 'env' && ' — set by NETSUITE_LABOR_ITEM_ID'}
                  {laborItem.resolved.source === 'setting' && ' — pinned here'}.
                </>
              ) : laborItem ? (
                <b style={{ color: '#ef4444' }}>
                  ⚠ No labor item found in NetSuite — labor is NOT reaching NetSuite on any estimate or sales order.
                </b>
              ) : 'Not checked yet.'}
            </div>

            <div style={labelStyle}>NetSuite item name</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={laborInput}
                onChange={e => setLaborInput(e.target.value)}
                placeholder="Exact item name (blank = auto)"
                style={{ ...inputStyle, width: '240px' }}
              />
              <button
                onClick={handleSaveLaborItem}
                disabled={laborBusy}
                style={{
                  padding: '8px 16px', borderRadius: '8px', border: 'none',
                  background: laborSaved ? '#22c55e' : '#3b82f6', color: '#fff',
                  fontSize: '12px', fontWeight: 800,
                  cursor: laborBusy ? 'default' : 'pointer', opacity: laborBusy ? 0.5 : 1,
                }}
              >
                {laborBusy ? 'Working...' : laborSaved ? 'Saved!' : 'Save Item'}
              </button>
              <button
                onClick={loadLaborItem}
                disabled={laborBusy}
                style={{
                  padding: '8px 14px', borderRadius: '8px', border: '1px solid var(--border-color)',
                  background: 'transparent', color: 'var(--text-body)',
                  fontSize: '12px', fontWeight: 700, cursor: laborBusy ? 'default' : 'pointer',
                }}
              >
                Re-check
              </button>
            </div>
            {(laborItem?.candidates?.length || 0) > 1 && (
              <div style={{ fontSize: '10px', color: 'var(--text-label)', marginTop: '8px' }}>
                Other labor items in NetSuite: {laborItem!.candidates.slice(1, 6).map(c => c.itemNumber).join(', ')}
              </div>
            )}
            {laborError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{laborError}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Shop Labor Cost Rate</div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
              What an hour of shop floor time COSTS the company (blended, loaded — not the rate estimates
              sell labor at). The Vehicle Job Margin report multiplies pick-list timer hours by this number.
              Leave it blank and the report shows recorded hours but excludes labor from the margin math.
            </div>
            <div style={labelStyle}>$ per hour</div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="number"
                step={0.5}
                min={0}
                max={500}
                value={shopRate}
                onChange={e => setShopRate(e.target.value)}
                placeholder="e.g. 55"
                style={{ ...inputStyle, width: '120px' }}
              />
              <button
                onClick={handleSaveShopRate}
                disabled={shopRateBusy}
                style={{
                  padding: '8px 16px', borderRadius: '8px', border: 'none',
                  background: shopRateSaved ? '#22c55e' : '#3b82f6', color: '#fff',
                  fontSize: '12px', fontWeight: 800,
                  cursor: shopRateBusy ? 'default' : 'pointer', opacity: shopRateBusy ? 0.5 : 1,
                }}
              >
                {shopRateBusy ? 'Saving...' : shopRateSaved ? 'Saved!' : 'Save Rate'}
              </button>
            </div>
            {shopRateError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{shopRateError}</div>
            )}
          </div>

          <div style={sectionStyle}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Shop Crew Capacity</div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
              Installers on the floor on a normal day × hours each works. The Shop Week planner colors
              each day&apos;s load bar against crew × shift hours; one-off days (holiday, short crew) can be
              overridden per day from the planner API. Leave both blank and the planner shows demand
              hours without judging them.
            </div>
            <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div>
                <div style={labelStyle}>Crew size</div>
                <input
                  type="number"
                  step={1}
                  min={0}
                  max={200}
                  value={crewSize}
                  onChange={e => setCrewSize(e.target.value)}
                  placeholder="e.g. 5"
                  style={{ ...inputStyle, width: '100px' }}
                />
              </div>
              <div>
                <div style={labelStyle}>Shift hours / day</div>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={24}
                  value={shiftHours}
                  onChange={e => setShiftHours(e.target.value)}
                  placeholder="e.g. 8"
                  style={{ ...inputStyle, width: '100px' }}
                />
              </div>
              <button
                onClick={handleSaveCapacity}
                disabled={capBusy}
                style={{
                  padding: '8px 16px', borderRadius: '8px', border: 'none',
                  background: capSaved ? '#22c55e' : '#3b82f6', color: '#fff',
                  fontSize: '12px', fontWeight: 800,
                  cursor: capBusy ? 'default' : 'pointer', opacity: capBusy ? 0.5 : 1,
                }}
              >
                {capBusy ? 'Saving...' : capSaved ? 'Saved!' : 'Save Capacity'}
              </button>
              {crewSize.trim() !== '' && shiftHours.trim() !== '' && Number.isFinite(parseFloat(crewSize)) && Number.isFinite(parseFloat(shiftHours)) && (
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-label)', paddingBottom: '9px' }}>
                  = {Math.round(parseInt(crewSize, 10) * parseFloat(shiftHours) * 10) / 10}h/day
                </div>
              )}
            </div>
            {capError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{capError}</div>
            )}
          </div>
        </>
      )}

      {/* Customer booking (R5-17) — admin ops config for the public
          pickup/drop-off pages, not owner-only like the money settings. */}
      {isAdmin && bookingCfg && (
        <>
          <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '10px', marginTop: '20px' }}>Customer Booking</div>
          <div style={sectionStyle}>
            <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Pickup &amp; Drop-off Slots</div>
            <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
              The completion email and estimate-approval page link customers to a booking page.
              These hours define its open slots; block a date for holidays or short crews.
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', cursor: 'pointer' }}>
              <input type="checkbox" checked={bookingCfg.enabled !== false}
                onChange={e => setBookingCfg({ ...bookingCfg, enabled: e.target.checked })}
                style={{ width: '16px', height: '16px' }} />
              <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Online booking enabled</span>
            </label>
            <div style={labelStyle}>Booking days</div>
            <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', flexWrap: 'wrap' }}>
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => {
                const iso = i + 1;
                const on = (bookingCfg.businessDays || []).includes(iso);
                return (
                  <button key={d} onClick={() => setBookingCfg({
                    ...bookingCfg,
                    businessDays: on
                      ? (bookingCfg.businessDays || []).filter((n: number) => n !== iso)
                      : [...(bookingCfg.businessDays || []), iso].sort(),
                  })} style={{
                    padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700, cursor: 'pointer',
                    background: on ? 'rgba(59,130,246,0.12)' : 'transparent',
                    border: `1px solid ${on ? 'rgba(59,130,246,0.4)' : 'var(--border-color)'}`,
                    color: on ? '#60a5fa' : 'var(--text-label)',
                  }}>{d}</button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <div>
                <div style={labelStyle}>First slot (hour)</div>
                <input type="number" min={0} max={23} value={bookingCfg.startHour}
                  onChange={e => setBookingCfg({ ...bookingCfg, startHour: parseInt(e.target.value || '8', 10) })}
                  style={{ ...inputStyle, width: '80px' }} />
              </div>
              <div>
                <div style={labelStyle}>Last hour (exclusive)</div>
                <input type="number" min={1} max={24} value={bookingCfg.endHour}
                  onChange={e => setBookingCfg({ ...bookingCfg, endHour: parseInt(e.target.value || '16', 10) })}
                  style={{ ...inputStyle, width: '80px' }} />
              </div>
              <div>
                <div style={labelStyle}>Slot length</div>
                <select value={bookingCfg.slotMinutes}
                  onChange={e => setBookingCfg({ ...bookingCfg, slotMinutes: parseInt(e.target.value, 10) })}
                  style={{ ...inputStyle, width: '110px' }}>
                  <option value={30}>30 min</option>
                  <option value={60}>1 hour</option>
                  <option value={90}>90 min</option>
                  <option value={120}>2 hours</option>
                </select>
              </div>
              <div>
                <div style={labelStyle}>Max / day</div>
                <input type="number" min={1} max={50} value={bookingCfg.maxPerDay}
                  onChange={e => setBookingCfg({ ...bookingCfg, maxPerDay: parseInt(e.target.value || '6', 10) })}
                  style={{ ...inputStyle, width: '80px' }} />
              </div>
              <div>
                <div style={labelStyle}>Lead days</div>
                <input type="number" min={0} max={30} value={bookingCfg.leadDays}
                  onChange={e => setBookingCfg({ ...bookingCfg, leadDays: parseInt(e.target.value || '1', 10) })}
                  style={{ ...inputStyle, width: '80px' }} />
              </div>
              <div>
                <div style={labelStyle}>Horizon (days)</div>
                <input type="number" min={7} max={60} value={bookingCfg.horizonDays}
                  onChange={e => setBookingCfg({ ...bookingCfg, horizonDays: parseInt(e.target.value || '21', 10) })}
                  style={{ ...inputStyle, width: '80px' }} />
              </div>
            </div>
            <div style={labelStyle}>Blocked dates</div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' }}>
              {(bookingCfg.blockedDates || []).map((d: string) => (
                <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 700, padding: '3px 8px', borderRadius: '6px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}>
                  {d}
                  <button onClick={() => setBookingCfg({ ...bookingCfg, blockedDates: (bookingCfg.blockedDates || []).filter((x: string) => x !== d) })}
                    style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '11px', padding: 0, fontWeight: 700 }}>✕</button>
                </span>
              ))}
              <input type="date" value={blockDraft} onChange={e => setBlockDraft(e.target.value)} style={{ ...inputStyle, width: '150px' }} />
              <button
                onClick={() => {
                  if (blockDraft && !(bookingCfg.blockedDates || []).includes(blockDraft)) {
                    setBookingCfg({ ...bookingCfg, blockedDates: [...(bookingCfg.blockedDates || []), blockDraft].sort() });
                  }
                  setBlockDraft('');
                }}
                disabled={!blockDraft}
                style={{ padding: '8px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: 'var(--subtle-bg)', border: '1px solid var(--border-color)', color: 'var(--text-body)', cursor: blockDraft ? 'pointer' : 'default', opacity: blockDraft ? 1 : 0.5 }}
              >Block date</button>
            </div>
            <button
              onClick={handleSaveBooking}
              disabled={bookingBusy}
              style={{
                padding: '8px 16px', borderRadius: '8px', border: 'none',
                background: bookingSaved ? '#22c55e' : '#3b82f6', color: '#fff',
                fontSize: '12px', fontWeight: 800,
                cursor: bookingBusy ? 'default' : 'pointer', opacity: bookingBusy ? 0.5 : 1,
              }}
            >
              {bookingBusy ? 'Saving...' : bookingSaved ? 'Saved!' : 'Save Booking Settings'}
            </button>
            {bookingError && (
              <div style={{ fontSize: '11px', color: '#ef4444', marginTop: '6px' }}>{bookingError}</div>
            )}
          </div>
        </>
      )}

      {/* Display — customer-only accounts have no More page, so the text
          size control lives here too (same localStorage preference). */}
      <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '10px', marginTop: '20px' }}>Display</div>
      <div style={sectionStyle}>
        <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Text Size</div>
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px' }}>
          Makes everything on this device larger and easier to read.
        </div>
        <TextSizeToggle />
      </div>

      <div style={{ fontSize: '16px', fontWeight: 800, marginBottom: '10px', marginTop: '20px' }}>Notifications</div>

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

          {isAdmin && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={prefs.notify_invoicing ?? false}
                onChange={e => setPrefs({ ...prefs, notify_invoicing: e.target.checked })}
              />
              <div>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Invoicing Alerts</div>
                <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Get notified when a shipped job needs an invoice and when someone else creates one. Admins only.</div>
              </div>
            </label>
          )}

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
              <PhoneInput
                style={{ ...inputStyle, maxWidth: '200px' }}
                placeholder="(555) 123-4567"
                value={prefs.phone_number || ''}
                onChange={v => setPrefs({ ...prefs, phone_number: v })}
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

        {/* Test push — sends a real notification to every registered device
            and reports which link in the chain is broken when nothing lands. */}
        <button
          onClick={handleTestPush}
          disabled={testLoading}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', marginTop: '10px',
            background: 'rgba(238,49,32,0.08)', border: '1px solid rgba(238,49,32,0.25)',
            color: 'var(--orange)', fontSize: '13px', fontWeight: 700,
            cursor: testLoading ? 'not-allowed' : 'pointer', opacity: testLoading ? 0.5 : 1,
          }}
        >
          {testLoading ? 'Sending test...' : 'Send Test Push to My Devices'}
        </button>
        <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-label)' }}>
          Sends a test notification to your iPhone/iPad app and any subscribed browsers, and reports exactly what happened.
        </div>

        {testResults && (
          <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {testResults.map((r, i) => (
              <div key={i} style={{
                padding: '8px 10px', borderRadius: '8px',
                background: r.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
                border: `1px solid ${r.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
              }}>
                <div style={{ fontSize: '11px', color: r.ok ? '#22c55e' : '#ef4444', lineHeight: 1.45 }}>
                  {r.ok ? '✓' : '✕'} {r.text}
                </div>
              </div>
            ))}
          </div>
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

          {/* Email for @mentions — ON by default (opt-out): being pulled into
              a job by name has to reach people who aren't in the app. */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.email_mentions ?? true} onChange={e => setPrefs({ ...prefs, email_mentions: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Email me when I&apos;m mentioned</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>Any @mention in a note — jobs, estimates, POs, vehicles — also sends an email. On for everyone unless you turn it off.</div>
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

      {/* Owner's weekly brief — only super_admin/executive accounts are ever
          targeted by the Monday cron, so only they see the toggle. */}
      {(hasRole('super_admin') || hasRole('executive')) && (
        <div style={sectionStyle}>
          <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Owner&apos;s Weekly Brief</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
            <input type="checkbox" checked={prefs.notify_weekly_brief ?? true} onChange={e => setPrefs({ ...prefs, notify_weekly_brief: e.target.checked })} />
            <div>
              <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-body)' }}>Monday morning brief</div>
              <div style={{ fontSize: '10px', color: 'var(--text-label)' }}>One email each Monday with last week&apos;s revenue, quotes, shipments, promises kept, and overrides. On by default for owners and executives.</div>
            </div>
          </label>
        </div>
      )}

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
