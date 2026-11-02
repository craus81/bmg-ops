'use client';

/**
 * Two-step sign-in screens (Books part 87, src/lib/two-step.ts, docs/books.md
 * "Two-step sign-in").
 *
 *   TwoStepScreen — what the app shows before anything else while a sign-in
 *                   still owes its code (AppShell, src/components/ClientProviders.tsx):
 *                   the code, or setting an authenticator app up first.
 *   TwoStepCard   — Settings → Two-step sign-in: set one up, or move it to a
 *                   new phone.
 *   TwoStepAdmin  — a super admin's row on the Users page: whether someone has
 *                   it, and Reset for a lost phone.
 *
 * Supabase Auth keeps the authenticator apps and checks the codes; FleetSuite
 * never sees a set-up key or code beyond passing it to Supabase from this page.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { cleanCode, keyInGroups, qrImageSrc, verifiedAuthenticators, type TwoStepNeed } from '@/lib/two-step';

const GREEN = '#22c55e';
const RED = '#ef4444';

/** What the authenticator apps show FleetSuite's codes under. */
const ISSUER = 'BMG FleetSuite';

const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Supabase's answer in plain words: a wrong code says so. */
function codeProblem(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  if (/invalid|expired/i.test(message)) return "That code didn't work. Enter the newest code your app shows, and check your phone's clock is set automatically.";
  return message || 'Something went wrong. Try again.';
}

const screenStyle: React.CSSProperties = {
  minHeight: 'calc(100vh / var(--ts))', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg)', padding: '20px',
};

const buttonStyle = (on: boolean): React.CSSProperties => ({
  width: '100%', padding: '12px', borderRadius: '10px', border: 'none', background: GREEN, color: '#fff',
  fontSize: '14px', fontWeight: 800, cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.5,
});

const quietButton: React.CSSProperties = {
  width: '100%', padding: '11px', borderRadius: '10px', background: 'transparent', color: 'var(--text-muted)',
  fontSize: '13px', fontWeight: 600, border: '1px solid var(--border)', cursor: 'pointer',
};

/** Six digits, typed or filled in by the phone, and a green button. */
function CodeForm({ label, busy, error, onCode }: { label: string; busy: boolean; error: string; onCode: (code: string) => void }) {
  const [typed, setTyped] = useState('');
  const code = cleanCode(typed);
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (code && !busy) onCode(code); }}
      style={{ display: 'grid', gap: '10px' }}
    >
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 9))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        aria-label="Six-digit code"
        placeholder="123456"
        style={{
          width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--input-bg)',
          color: 'var(--text-body)', fontSize: '16px', letterSpacing: '6px', textAlign: 'center', boxSizing: 'border-box',
        }}
      />
      {error && <div role="alert" style={{ color: RED, fontSize: '13px', fontWeight: 700 }}>{error}</div>}
      <button type="submit" disabled={!code || busy} style={buttonStyle(!!code && !busy)}>{busy ? 'Checking…' : label}</button>
    </form>
  );
}

interface Enrolled { id: string; qr: string; secret: string; uri: string }

/**
 * Setting an authenticator app up: a QR code to scan (or the key to type, or a
 * link that opens the app on this phone), then the first code it shows. With
 * `replacing`, the apps set up before go once the new one's code is taken.
 */
function SetUpAuthenticator({ replacing = false, onDone }: { replacing?: boolean; onDone: () => Promise<void> | void }) {
  const supabase = createClient();
  const [enrolled, setEnrolled] = useState<Enrolled | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        // One started before and never finished goes first: Supabase keeps it until it's taken away.
        const { data: list, error: listError } = await supabase.auth.mfa.listFactors();
        if (listError) throw listError;
        for (const f of (list?.all ?? []).filter((x: { status: string }) => x.status === 'unverified')) {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp', issuer: ISSUER, friendlyName: `FleetSuite ${new Date().toISOString().slice(0, 19)}`,
        });
        if (enrollError) throw enrollError;
        setEnrolled({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
      } catch (e) {
        setError(codeProblem(e));
      }
    })();
  }, [supabase]);

  const finish = async (code: string) => {
    if (!enrolled) return;
    setBusy(true);
    setError('');
    try {
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrolled.id, code });
      if (verifyError) throw verifyError;
      if (replacing) {
        const { data } = await supabase.auth.mfa.listFactors();
        for (const f of verifiedAuthenticators<{ id: string; factor_type: string; status: string }>(data?.all).filter((x) => x.id !== enrolled.id)) {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }
      // Tells the super admins (and Craig) someone set it up; its answer changes nothing here.
      await apiFetch('/api/auth/two-step', { method: 'POST', body: JSON.stringify({ action: 'set_up' }) }).catch(() => null);
      await onDone();
    } catch (e) {
      setError(codeProblem(e));
    }
    setBusy(false);
  };

  const copyKey = async () => {
    if (!enrolled) return;
    try {
      await navigator.clipboard.writeText(enrolled.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the key is on screen to type */ }
  };

  if (!enrolled) {
    return error
      ? <div role="alert" style={{ color: RED, fontSize: '13px', fontWeight: 700 }}>{error}</div>
      : <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Getting a code ready…</div>;
  }
  return (
    <div style={{ display: 'grid', gap: '12px', textAlign: 'left' }}>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        <b>1.</b> In an authenticator app on your phone (the iPhone&apos;s Passwords app, Google or Microsoft Authenticator, or 1Password), add an account by scanning this.
      </div>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL Supabase makes for this set-up only */}
        <img src={qrImageSrc(enrolled.qr)} alt="QR code to scan with your authenticator app" width={176} height={176}
          style={{ background: '#fff', padding: '8px', borderRadius: '10px' }} />
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
        On this phone? <a href={enrolled.uri} style={{ color: 'var(--accent)', fontWeight: 700 }}>Add it to your authenticator app</a>, or type this key:
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <code style={{ flex: 1, fontSize: '13px', padding: '8px 10px', borderRadius: '8px', background: 'var(--subtle-bg)', border: '1px solid var(--border)', wordBreak: 'break-all' }}>
          {keyInGroups(enrolled.secret)}
        </code>
        <button type="button" onClick={copyKey} style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}><b>2.</b> Enter the six-digit code the app shows for {ISSUER}.</div>
      <CodeForm label="Save and carry on" busy={busy} error={error} onCode={finish} />
    </div>
  );
}

/**
 * The screen a sign-in sees, before anything else, while it still owes its
 * two-step code: the code, or setting an authenticator app up first.
 */
export function TwoStepScreen({ need }: { need: TwoStepNeed }) {
  const { signOut, recheckTwoStep } = useAuth();
  const supabase = createClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const verify = async (code: string) => {
    setBusy(true);
    setError('');
    try {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const apps = data?.totp ?? [];
      let last: unknown = null;
      for (const app of apps) {
        const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({ factorId: app.id, code });
        if (!verifyError) { last = null; break; }
        last = verifyError;
      }
      if (last) throw last;
      // Reset meanwhile, or the code taken: either way, ask again what's still owed.
      await recheckTwoStep();
    } catch (e) {
      setError(codeProblem(e));
    }
    setBusy(false);
  };

  return (
    <div style={screenStyle}>
      <div style={{ width: '100%', maxWidth: '360px', display: 'grid', gap: '14px', textAlign: 'center' }}>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>
          {need === 'setup' ? 'Set up two-step sign-in' : 'Two-step sign-in'}
        </div>
        {need === 'setup' ? (
          <>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Your role works with BMG&apos;s money, so FleetSuite asks for a code from an authenticator app each time you sign in.
            </div>
            <SetUpAuthenticator onDone={recheckTwoStep} />
          </>
        ) : (
          <>
            <div style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Enter the six-digit code from the authenticator app on your phone.
            </div>
            <CodeForm label="Carry on" busy={busy} error={error} onCode={verify} />
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.45 }}>
              Lost your phone? Ask a super admin to reset your two-step sign-in.
            </div>
          </>
        )}
        <button type="button" onClick={signOut} style={quietButton}>Sign Out</button>
      </div>
    </div>
  );
}

interface MyTwoStep { hasAuthenticator: boolean; setUpAt: string | null; moneyRole: boolean; switchOn: boolean }

/** Settings → Two-step sign-in. Shown to the money roles, admins, and anyone who has it set up. */
export function TwoStepCard({ sectionStyle }: { sectionStyle: React.CSSProperties }) {
  const { isActualAdmin, recheckTwoStep } = useAuth();
  const [mine, setMine] = useState<MyTwoStep | null>(null);
  const [error, setError] = useState('');
  const [setting, setSetting] = useState(false);
  const [done, setDone] = useState('');
  const card = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/two-step');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setMine(json);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Opened from a link to Settings → Two-step sign-in.
  useEffect(() => {
    if (mine && typeof window !== 'undefined' && window.location.hash === '#two-step') card.current?.scrollIntoView({ block: 'start' });
  }, [mine]);

  if (!mine && !error) return null;
  if (mine && !mine.hasAuthenticator && !mine.moneyRole && !isActualAdmin) return null;

  const finished = async () => {
    setSetting(false);
    setDone(mine?.hasAuthenticator ? 'Moved to your new phone.' : 'Two-step sign-in is on.');
    await load();
    await recheckTwoStep();
  };

  return (
    <div id="two-step" ref={card} style={sectionStyle}>
      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-body)', marginBottom: '4px' }}>Two-step sign-in</div>
      {error && <div role="alert" style={{ color: RED, fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{error}</div>}
      {mine && (
        <div style={{ fontSize: '11px', color: 'var(--text-label)', marginBottom: '10px', lineHeight: 1.45 }}>
          {mine.hasAuthenticator
            ? `On${mine.setUpAt ? ` since ${when(mine.setUpAt)}` : ''}: FleetSuite asks for a code from your authenticator app each time you sign in on a device.`
            : mine.moneyRole && mine.switchOn
              ? 'Your role needs a code from an authenticator app each time you sign in.'
              : `Off. Set it up and FleetSuite asks for a code from an authenticator app on your phone each time you sign in${mine.moneyRole ? '; your role will need it once it switches on for money roles' : ''}.`}
        </div>
      )}
      {done && <div style={{ color: GREEN, fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>{done}</div>}
      {mine && (setting ? (
        <div style={{ display: 'grid', gap: '10px' }}>
          <SetUpAuthenticator replacing={mine.hasAuthenticator} onDone={finished} />
          <button type="button" onClick={() => setSetting(false)} style={quietButton}>
            {mine.hasAuthenticator ? 'Keep my phone as it is' : 'Not now'}
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => { setDone(''); setSetting(true); }} style={mine.hasAuthenticator ? quietButton : buttonStyle(true)}>
          {mine.hasAuthenticator ? 'Move to a new phone' : 'Set up two-step sign-in'}
        </button>
      ))}
      {mine?.hasAuthenticator && !setting && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>Lost your phone? A super admin resets it on the Users page.</div>
      )}
    </div>
  );
}

/** A super admin's row for someone's two-step sign-in, on the Users page. */
export function TwoStepAdmin({ userId, userName }: { userId: string; userName: string }) {
  const { user, signOut } = useAuth();
  const dialog = useDialog();
  const [theirs, setTheirs] = useState<{ hasAuthenticator: boolean; setUpAt: string | null } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const me = user?.id === userId;

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/admin/two-step?${new URLSearchParams({ userId })}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setTheirs(json);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);
  useEffect(() => { setTheirs(null); setDone(''); load(); }, [load]);

  const reset = async () => {
    const ok = await dialog.confirm(
      me
        ? 'Reset your own two-step sign-in? Your authenticator app stops working for FleetSuite and you are signed out everywhere, this device too. Sign in with your password and set it up again.'
        : `Reset ${userName}'s two-step sign-in? Their authenticator app stops working for FleetSuite and they are signed out everywhere. They sign in with their password and set it up again. The other super admins hear about it.`,
      { confirmLabel: 'Reset', title: 'Two-step sign-in', destructive: true },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/admin/two-step', { method: 'POST', body: JSON.stringify({ userId }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      if (me) { await signOut(); return; }
      setDone(`Reset. ${userName} was signed out everywhere.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div style={{ marginTop: '14px', padding: '12px', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--subtle-bg)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 800 }}>Two-step sign-in</div>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            {theirs ? (theirs.hasAuthenticator ? `On${theirs.setUpAt ? ` since ${when(theirs.setUpAt)}` : ''}` : 'Not set up') : error ? '' : 'Loading…'}
          </div>
        </div>
        {theirs?.hasAuthenticator && (
          <button type="button" onClick={reset} disabled={busy} style={{
            padding: '7px 12px', borderRadius: '8px', border: `1px solid ${RED}`, background: 'transparent', color: RED,
            fontSize: '12px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
          }}>{busy ? 'Resetting…' : 'Reset'}</button>
        )}
      </div>
      {error && <div role="alert" style={{ color: RED, fontSize: '12px', fontWeight: 700, marginTop: '6px' }}>{error}</div>}
      {done && <div style={{ color: GREEN, fontSize: '12px', fontWeight: 700, marginTop: '6px' }}>{done}</div>}
    </div>
  );
}
