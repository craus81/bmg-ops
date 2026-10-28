'use client';

/**
 * The approved estimate's customer-update card (migration 449, Craig
 * 2026-10-28): send the "We got your approval" email (one tap, the standard
 * compose screen, never automatic), copy the customer's live Order status
 * link, and Mark all parts in by hand. Shows where the customer's page
 * stands so the rep sees what the customer sees.
 */

import { useCallback, useEffect, useState } from 'react';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { useDialog } from '@/components/DialogProvider';
import type { OrderStageView } from '@/lib/order-status';

interface StaffOrderStatus {
  approved: boolean;
  url?: string;
  approvedBy?: string | null;
  confirmation?: { at: string; by: string | null } | null;
  partsAllIn?: { at: string; by: string | null } | null;
  current?: string;
  currentLabel?: string;
  stages?: OrderStageView[];
}

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '9px 12px', borderRadius: '10px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  background: primary ? '#2563eb' : 'var(--bg)',
  color: primary ? '#fff' : 'var(--text-body)',
  border: primary ? '1px solid #2563eb' : '1px solid var(--border)',
});

export default function EstimateOrderStatusCard({ estimateId, customerId, prospectId }: {
  estimateId: string;
  customerId?: string | null;
  prospectId?: string | null;
}) {
  const dialog = useDialog();
  const [data, setData] = useState<StaffOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/estimates/${estimateId}/order-status`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load the order status.'); return; }
      setError(null);
      setData(json);
    } catch {
      setError('Network error loading the order status.');
    }
  }, [estimateId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '8px' }}>{error}</div>;
  if (!data?.approved || !data.url) return null;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(data.url!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      await dialog.alert(`Copy this link:\n${data.url}`);
    }
  };

  const markParts = async (done: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/estimates/${estimateId}/order-status/parts-in`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) setError(json.error || 'Could not save.');
      else await load();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const post = (fields: EmailComposeFields, preview: boolean) => fetch(`/api/estimates/${estimateId}/order-status/confirmation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      preview: preview || undefined,
      emails: fields.emails,
      ...(preview ? {} : { bccSelf: fields.bccSelf, cc: fields.cc }),
      message: fields.message || undefined,
    }),
  });

  const fetchPreview = async (fields: EmailComposeFields) => {
    try {
      const res = await post(fields, true);
      const json = await res.json();
      if (res.ok && json.preview) return { preview: { to: json.to ?? null, subject: json.subject, html: json.html } };
      return { error: json.error || 'Unknown error' };
    } catch {
      return { error: 'Network error. Try again.' };
    }
  };

  const send = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    try {
      const res = await post(fields, false);
      const json = await res.json();
      if (!res.ok) {
        await dialog.alert('Send failed: ' + (json.error || 'Unknown error'));
        return { ok: false };
      }
      const em = json.dispatch?.email;
      await dialog.alert(`Approval confirmation sent to ${em?.target || 'the customer'}${em?.bcc ? ` (bcc ${em.bcc})` : ''}.`);
      await load();
      return { ok: true };
    } catch {
      await dialog.alert('Network error. Try again.');
      return { ok: false };
    }
  };

  const partsStage = data.stages?.find(s => s.key === 'parts_ordered');

  return (
    <div style={{
      padding: '10px 12px', borderRadius: '10px', marginBottom: '8px',
      background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.25)',
      display: 'flex', flexDirection: 'column', gap: '8px',
    }}>
      <div style={{ fontSize: '12px', color: 'var(--text-body)' }}>
        <b>Customer&apos;s order page:</b> {data.currentLabel}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {data.confirmation
            ? `Approval confirmation sent ${fmt(data.confirmation.at)}${data.confirmation.by ? ` by ${data.confirmation.by}` : ''}`
            : 'Approval confirmation not sent yet'}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button type="button" style={btn(!data.confirmation)} onClick={() => setCompose(true)}>
          ✉ {data.confirmation ? 'Send approval confirmation again' : 'Send approval confirmation'}
        </button>
        <button type="button" style={btn(false)} onClick={copyLink}>{copied ? '✓ Link copied' : 'Copy order status link'}</button>
        <a href={data.url} target="_blank" rel="noreferrer" style={{ ...btn(false), textDecoration: 'none' }}>Open customer page</a>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '8px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {data.partsAllIn
            ? `All parts in, marked ${fmt(data.partsAllIn.at)}${data.partsAllIn.by ? ` by ${data.partsAllIn.by}` : ''}`
            : `Parts: ${partsStage?.state === 'todo' ? (partsStage.detail || 'not ordered yet') : (partsStage?.detail || 'ordered')}`}
        </div>
        {data.partsAllIn ? (
          <button type="button" disabled={busy} style={btn(false)} onClick={() => markParts(false)}>Undo all parts in</button>
        ) : (
          <button type="button" disabled={busy} style={btn(true)} onClick={() => markParts(true)}>✓ Mark all parts in</button>
        )}
      </div>
      {compose && (
        <EmailComposeModal
          title="Send Approval Confirmation"
          customerId={customerId}
          offerNewContacts={{ customerId, prospectId }}
          initialTo={data.approvedBy && data.approvedBy.includes('@') ? data.approvedBy : undefined}
          stateKey={`estimate-approval-confirmation:${estimateId}`}
          sendLabel="Send"
          messagePlaceholder="Optional note to the customer, added above the confirmation…"
          intro={(
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Tells the customer we got their approval and gives them a <b>Track your order</b> link that updates on its own.
              The approved estimate PDF is attached.
            </div>
          )}
          fetchPreview={fetchPreview}
          onSend={send}
          onClose={() => setCompose(false)}
        />
      )}
    </div>
  );
}
