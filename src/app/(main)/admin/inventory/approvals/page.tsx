'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { useDialog } from '@/components/DialogProvider';
import { apiFetch } from '@/lib/api-client';
import { theme } from '@/lib/theme';
import {
  STATUS_TEXT, describeAsk, needsSettling, type AdjustmentAsk, type AskStatus,
} from '@/lib/inventory-adjust-approvals';

/**
 * Adjustments to approve (Books part 63, migration 494,
 * src/lib/inventory-adjust-approvals.ts, docs/books.md "Adjustments approved
 * before they're posted"), linked from the Inventory page: once approving
 * adjustments is switched on in Books → Switches, each adjustment made with
 * Adjust waits here. A super admin who didn't ask approves it, and FleetSuite
 * posts it in NetSuite as the change worked out when it was asked, or turns
 * it down saying why; whoever asked can withdraw it while it waits. One
 * NetSuite didn't say about is settled here by hand. Admins open it, as
 * Adjust. Nobody is alerted (Craig, 2026-10-30: no alerts for adjustments).
 */

type Loaded = { on: boolean | null; superAdmin: boolean; me: string; open: AdjustmentAsk[]; decided: AdjustmentAsk[] };

const GREEN = '#22c55e';

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const CHIP: Record<AskStatus, { bg: string; color: string }> = {
  waiting: { bg: theme.warningBg, color: theme.warning },
  sending: { bg: 'var(--subtle-bg)', color: theme.textSecondary },
  unsure: { bg: theme.errorBg, color: theme.error },
  made: { bg: theme.successBg, color: theme.success },
  turned_down: { bg: 'var(--subtle-bg)', color: theme.textSecondary },
  withdrawn: { bg: 'var(--subtle-bg)', color: theme.textMuted },
};

const button = (primary: boolean, busy: boolean): React.CSSProperties => ({
  padding: '8px 12px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: busy ? 'wait' : 'pointer',
  border: `1px solid ${primary ? GREEN : 'var(--border)'}`, background: primary ? GREEN : 'var(--card)', color: primary ? '#fff' : 'var(--text-primary)',
});

export default function AdjustmentsToApprovePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dialog = useDialog();
  const { isAdmin, loading: authLoading } = useAuth();
  const flashId = (searchParams.get('id') || '').trim();

  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/inventory/adjust/approvals');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
      setData(json);
      setLoadError('');
    } catch (e: any) {
      setLoadError(e?.message || "Couldn't load the adjustments asked for.");
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAdmin) { router.push('/home'); return; }
    load();
  }, [authLoading, isAdmin, router, load]);

  useEffect(() => {
    if (!flashId || !data) return;
    document.getElementById(`ask-${flashId}`)?.scrollIntoView({ block: 'center' });
  }, [flashId, data]);

  const act = async (ask: AdjustmentAsk, body: Record<string, unknown>, said: (json: any) => string) => {
    setBusy(ask.id);
    setError('');
    setDone('');
    try {
      const res = await apiFetch('/api/inventory/adjust/approvals', { method: 'POST', body: JSON.stringify({ id: ask.id, ...body }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error || `Request failed (${res.status})`);
      else setDone(said(json));
    } catch {
      setError("Couldn't reach FleetSuite. Check your connection, then look here again before trying once more.");
    }
    setBusy(null);
    await load();
  };

  const approve = async (ask: AdjustmentAsk) => {
    const ok = await dialog.confirm(
      `Approve ${ask.itemNumber}? ${describeAsk(ask)}. FleetSuite posts it in NetSuite now as an Inventory Adjustment at O'Fallon, account 52000 Inventory Adjustment.`,
      { confirmLabel: 'Approve and post', title: 'Approve the adjustment' },
    );
    if (!ok) return;
    await act(ask, { action: 'approve' }, (json) => `Posted ${json.adjustmentNumber || 'the adjustment'} in NetSuite. ${ask.itemNumber} now shows ${json.onHand} on hand at O'Fallon.${json.warning ? ` ${json.warning}` : ''}`);
  };

  const turnDown = async (ask: AdjustmentAsk) => {
    const why = await dialog.prompt('Why is it turned down? Whoever asked sees this.', '', {
      confirmLabel: 'Turn down', title: 'Turn down the adjustment', placeholder: 'e.g. Count the shelf again first', multiline: true,
    });
    if (!why?.trim()) return;
    await act(ask, { action: 'turn_down', why: why.trim() }, () => 'Turned down. Nothing went to NetSuite, and whoever asked sees why.');
  };

  const withdraw = async (ask: AdjustmentAsk) => {
    const ok = await dialog.confirm(`Withdraw the adjustment of ${ask.itemNumber}? Nothing goes to NetSuite.`, { confirmLabel: 'Withdraw it', title: 'Withdraw the adjustment', destructive: true });
    if (!ok) return;
    await act(ask, { action: 'withdraw' }, () => 'Withdrawn. Nothing went to NetSuite.');
  };

  const settleMade = async (ask: AdjustmentAsk) => {
    const number = await dialog.prompt(`NetSuite has the adjustment of ${ask.itemNumber}? Its number, if you have it.`, '', {
      confirmLabel: "It's in NetSuite", title: "It's in NetSuite", placeholder: 'e.g. INVADJ1042 (optional)',
    });
    if (number === null) return;
    await act(ask, { action: 'settle', made: true, number: number.trim() }, () => "Kept as made in NetSuite.");
  };

  const settleNotMade = async (ask: AdjustmentAsk) => {
    const ok = await dialog.confirm(
      `NetSuite doesn't have the adjustment of ${ask.itemNumber}? It goes back to wait for approval, and can be approved again.`,
      { confirmLabel: "It isn't in NetSuite", title: "It isn't in NetSuite" },
    );
    if (!ok) return;
    await act(ask, { action: 'settle', made: false }, () => "Back to wait for approval.");
  };

  if (authLoading || !isAdmin) return null;
  const superAdmin = !!data?.superAdmin;

  return (
    <div style={{ padding: '16px', maxWidth: '760px', margin: '0 auto' }}>
      <div style={{ marginBottom: '14px' }}>
        <Link href="/admin/inventory" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>← Inventory</Link>
        <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>Adjustments to approve</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', maxWidth: '640px' }}>
          Once Approving adjustments is switched on in Books → Switches, each adjustment made with Adjust waits here. A super admin who
          didn&apos;t ask approves it, and it&apos;s posted in NetSuite as the change worked out when it was asked, or turns it down saying why.
        </div>
        {data && data.on === false && (
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', marginTop: '6px' }}>
            Approving adjustments is switched off, so Adjust posts to NetSuite at once. Any asked for while it was on are still here to decide.
          </div>
        )}
        {data && data.on === null && (
          <div style={{ fontSize: '12px', fontWeight: 700, color: theme.error, marginTop: '6px' }}>
            Couldn&apos;t tell whether approving adjustments is switched on, so Adjust makes none until it can.
          </div>
        )}
      </div>

      {loadError && <div style={{ color: theme.error, fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{loadError}</div>}
      {error && <div style={{ color: theme.error, fontSize: '13px', fontWeight: 700, background: theme.errorBg, padding: '8px 10px', borderRadius: '8px', marginBottom: '10px' }}>{error}</div>}
      {done && <div style={{ color: theme.success, fontSize: '13px', fontWeight: 700, background: theme.successBg, padding: '8px 10px', borderRadius: '8px', marginBottom: '10px' }}>{done}</div>}
      {!data && !loadError && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</div>}

      {data && (
        <>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-secondary)', margin: '4px 0 8px' }}>Not decided yet · {data.open.length}</div>
          {data.open.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px' }}>Nothing is waiting.</div>}
          <div style={{ display: 'grid', gap: '10px', marginBottom: '20px' }}>
            {data.open.map((ask) => {
              const mine = ask.askedBy === data.me;
              const settle = needsSettling(ask);
              return (
                <div key={ask.id} id={`ask-${ask.id}`}
                  style={{ background: 'var(--card)', border: `1px solid ${ask.id === flashId ? '#60a5fa' : 'var(--border)'}`, borderRadius: '12px', padding: '14px', display: 'grid', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      {ask.itemNumber}{ask.displayName ? <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}> · {ask.displayName}</span> : null}
                    </div>
                    <span style={{ fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', background: CHIP[ask.status].bg, color: CHIP[ask.status].color }}>
                      {STATUS_TEXT[ask.status]}
                    </span>
                  </div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{describeAsk(ask)}</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{ask.reason}{ask.note ? ` · ${ask.note}` : ''}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    Asked by {mine ? 'you' : ask.askedByName || 'someone'}, {when(ask.askedAt)}
                    {ask.sentAt && ask.status !== 'waiting' ? ` · approved by ${ask.sentByName || 'a super admin'}, ${when(ask.sentAt)}` : ''}
                  </div>
                  {ask.error && ask.status === 'waiting' && (
                    <div style={{ fontSize: '12px', fontWeight: 700, color: theme.error }}>Last time: {ask.error}</div>
                  )}
                  {settle && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {ask.status === 'unsure' && ask.error ? <span style={{ color: theme.error, fontWeight: 700 }}>{ask.error} </span> : null}
                      FleetSuite can&apos;t tell whether NetSuite posted it. Look for it in NetSuite&apos;s inventory adjustments for {ask.itemNumber}, then say which.
                    </div>
                  )}
                  {ask.status === 'sending' && !settle && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Being posted to NetSuite now.</div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
                    {ask.status === 'waiting' && superAdmin && !mine && (
                      <>
                        <button onClick={() => approve(ask)} disabled={busy !== null} style={button(true, busy === ask.id)}>
                          {busy === ask.id ? 'Working…' : 'Approve and post to NetSuite'}
                        </button>
                        <button onClick={() => turnDown(ask)} disabled={busy !== null} style={button(false, busy === ask.id)}>Turn down</button>
                      </>
                    )}
                    {ask.status === 'waiting' && mine && (
                      <button onClick={() => withdraw(ask)} disabled={busy !== null} style={button(false, busy === ask.id)}>
                        {busy === ask.id ? 'Withdrawing…' : 'Withdraw it'}
                      </button>
                    )}
                    {settle && superAdmin && (
                      <>
                        <button onClick={() => settleMade(ask)} disabled={busy !== null} style={button(false, busy === ask.id)}>It&apos;s in NetSuite</button>
                        <button onClick={() => settleNotMade(ask)} disabled={busy !== null} style={button(false, busy === ask.id)}>It isn&apos;t in NetSuite</button>
                      </>
                    )}
                  </div>
                  {ask.status === 'waiting' && (mine || !superAdmin) && (
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {mine ? 'You asked, so a super admin who didn\'t ask approves it.' : 'A super admin who didn\'t ask approves it.'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {data.decided.length > 0 && (
            <>
              <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-secondary)', margin: '4px 0 8px' }}>Decided lately</div>
              <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '12px', padding: '6px 12px' }}>
                {data.decided.map((ask, i) => (
                  <div key={ask.id} id={`ask-${ask.id}`}
                    style={{ padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', display: 'grid', gap: '2px', outline: ask.id === flashId ? '2px solid #60a5fa' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '13px', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{ask.itemNumber} · {describeAsk(ask)}</span>
                      <span style={{ fontSize: '11px', fontWeight: 800, color: CHIP[ask.status].color }}>
                        {STATUS_TEXT[ask.status]}{ask.netsuiteNumber ? ` · ${ask.netsuiteNumber}` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                      {ask.reason} · asked by {ask.askedBy === data.me ? 'you' : ask.askedByName || 'someone'}
                      {ask.decidedAt ? ` · ${ask.status === 'withdrawn' ? 'withdrawn' : ask.status === 'made' ? 'approved' : 'turned down'} by ${ask.decidedByName || 'someone'}, ${when(ask.decidedAt)}` : ''}
                    </div>
                    {ask.why && <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Why: {ask.why}</div>}
                    {ask.warning && <div style={{ fontSize: '12px', color: theme.error, fontWeight: 700 }}>{ask.warning}</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
