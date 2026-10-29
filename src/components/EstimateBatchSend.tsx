'use client';

import { useMemo, useRef, useState } from 'react';
import EmailComposeModal, { type EmailComposeFields } from '@/components/EmailComposeModal';
import { useDialog } from '@/components/DialogProvider';
import { holdAwareFetch } from '@/lib/hold-aware-fetch';
import { batchSendErrorText, canSendForApproval, groupByCustomer } from '@/lib/estimate-batch';

/**
 * Several estimates picked on the Estimates list, emailed one customer at a
 * time (Craig, 2026-10-28, thread "Bulk email estimates to customers").
 * Each customer gets ONE email through the standard compose screen
 * ("Customer 1 of 2"), so nothing goes out without the sender seeing it:
 *
 *  - approval: one approval email listing the customer's estimates with an
 *    approve-all page (POST /api/estimates/[first]/send-for-approval with
 *    alsoIds). Approved estimates and ones on a sales order are left out.
 *  - pdfs: one plain email with every PDF attached
 *    (POST /api/estimates/email-pdfs). Nothing is marked sent.
 *
 * Closing a compose screen without sending stops the rest; Skip moves on.
 */

export interface BatchSendEstimate {
  id: string;
  estimate_number: string;
  netsuite_estimate_number?: string | null;
  title: string | null;
  customer_id: string | null;
  prospect_id: string | null;
  customer_netsuite_id: string | null;
  customer_name: string | null;
  grand_total: number | null;
  unit_number: string | null;
  status: string;
  customer_approved?: boolean | null;
  netsuite_so_id?: string | null;
}

const money = (n: any) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function EstimateBatchSend({
  mode,
  estimates,
  onFinished,
}: {
  mode: 'approval' | 'pdfs';
  estimates: BatchSendEstimate[];
  /** Every customer done, skipped or the sender stopped: what went out. */
  onFinished: (summary: { sent: string[]; skipped: string[] }) => void;
}) {
  const dialog = useDialog();
  const groups = useMemo(
    () => groupByCustomer(mode === 'approval' ? estimates.filter(canSendForApproval) : estimates),
    [mode, estimates],
  );
  const [index, setIndex] = useState(0);
  const sentRef = useRef(false);
  const results = useRef<{ sent: string[]; skipped: string[] }>({ sent: [], skipped: [] });

  const group = groups[index];
  if (!group) return null;
  const first = group[0];
  const others = group.slice(1);
  const customer = first.customer_name || 'No customer';
  const total = group.reduce((sum, e) => sum + (Number(e.grand_total) || 0), 0);
  const label = (e: BatchSendEstimate) => `#${e.netsuite_estimate_number || e.estimate_number}`;
  const line = `${customer}: ${group.length} estimate${group.length === 1 ? '' : 's'}`;

  const next = (sent: boolean) => {
    (sent ? results.current.sent : results.current.skipped).push(line);
    sentRef.current = false;
    if (index + 1 < groups.length) setIndex(index + 1);
    else onFinished(results.current);
  };

  const fetchPreview = async (fields: EmailComposeFields) => {
    try {
      const res = mode === 'approval'
        ? await fetch(`/api/estimates/${first.id}/send-for-approval`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview: true, emails: fields.emails, message: fields.message || undefined, alsoIds: others.map(e => e.id) }),
        })
        : await fetch('/api/estimates/email-pdfs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preview: true, estimateIds: group.map(e => e.id), emails: fields.emails, message: fields.message || undefined }),
        });
      const text = await res.text();
      const data = (() => { try { return JSON.parse(text); } catch { return null; } })();
      if (res.ok && data?.preview) return { preview: { to: data.to ?? null, subject: data.subject, html: data.html } };
      return { error: batchSendErrorText(res.status, text) };
    } catch {
      return { error: 'Network error. Try again.' };
    }
  };

  const send = async (fields: EmailComposeFields): Promise<{ ok: boolean }> => {
    const common = { emails: fields.emails, bccSelf: fields.bccSelf, cc: fields.cc, message: fields.message || undefined };
    let data: any;
    // Failures in red, with the server's own words (or what cut it off).
    const fail = async (res: Response) => {
      await dialog.alert('Send failed: ' + batchSendErrorText(res.status, await res.text().catch(() => '')), { error: true });
      return { ok: false };
    };
    try {
      if (mode === 'pdfs') {
        const res = await fetch('/api/estimates/email-pdfs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...common, estimateIds: group.map(e => e.id) }),
        });
        if (!res.ok) return fail(res);
        data = await res.json().catch(() => ({}));
      } else {
        // Below the margin floor: one 409 with the numbers, then a typed
        // reason retries (recorded, owner notified). A customer on hold asks
        // for its override reason once (holdAwareFetch).
        let floorReason: string | undefined;
        const holdCtx: { reason?: string } = {};
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await holdAwareFetch(dialog, `/api/estimates/${first.id}/send-for-approval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...common, alsoIds: others.map(e => e.id), ...(floorReason ? { floorReason } : {}) }),
          }, fetch, holdCtx);
          if (!res) return { ok: false };
          if (!res.ok && !(res.status === 409 && attempt === 0)) return fail(res);
          data = await res.clone().json().catch(() => ({}));
          if (res.ok) break;
          if (res.status === 409 && data.belowFloor && attempt === 0) {
            const reason = await dialog.prompt(
              `${data.error}\n\nType the reason to send anyway. It goes on the estimate and the owner is notified.`,
              '',
              { title: 'Below margin floor', confirmLabel: 'Send anyway', placeholder: 'Reason (required)' },
            );
            if (reason === null || !reason.trim()) return { ok: false };
            floorReason = reason.trim();
            continue;
          }
          return fail(res);
        }
        if (!data || data.error) { await dialog.alert('Send failed: ' + (data?.error || 'the server gave no answer. Check whether the email arrived before sending again.'), { error: true }); return { ok: false }; }
        if (data.dispatch?.email && !data.dispatch.email.ok) {
          await dialog.alert(`The email to ${customer} did not go out: ${data.dispatch.email.error || 'the email service refused it'}. The estimates are marked sent, so use Send for Approval on one of them to try again.`, { error: true });
        }
      }
    } catch {
      await dialog.alert('The connection dropped before the server answered. Check whether the email arrived before sending again.', { error: true });
      return { ok: false };
    }
    sentRef.current = true;
    return { ok: true };
  };

  const intro = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{
        padding: '10px', borderRadius: '8px',
        background: mode === 'approval' ? 'rgba(52,211,153,0.08)' : 'rgba(96,165,250,0.08)',
        border: `1px solid ${mode === 'approval' ? 'rgba(52,211,153,0.35)' : 'rgba(96,165,250,0.3)'}`,
        fontSize: '12px', color: 'var(--text-body)', lineHeight: 1.5,
      }}>
        {groups.length > 1 && (
          <div style={{ fontSize: '10px', fontWeight: 800, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px' }}>
            Customer {index + 1} of {groups.length}
          </div>
        )}
        <b>{customer} · {group.length} estimate{group.length === 1 ? '' : 's'} · {money(total)}</b>
        <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>
          {group.map(e => `${label(e)}${e.unit_number ? ` (unit ${e.unit_number})` : ''}`).join(', ')}.
          {' '}{mode === 'approval'
            ? (group.length > 1
              ? 'All in one email. The customer can approve them all at once or one at a time, and each estimate keeps its own approval.'
              : 'Its normal approval email.')
            : `One email with ${group.length === 1 ? 'the PDF' : `all ${group.length} PDFs`} attached. No approval buttons, and nothing is marked sent.`}
        </span>
      </div>
      {groups.length > 1 && (
        <button
          onClick={() => next(false)}
          style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: 'var(--text-muted)', fontSize: '11px', textDecoration: 'underline', cursor: 'pointer' }}
        >
          Skip {customer}{index + 1 < groups.length ? ' and go to the next customer' : ''}
        </button>
      )}
    </div>
  );

  return (
    <EmailComposeModal
      key={`${mode}:${index}`}
      title={mode === 'approval' ? 'Review Approval Email Before Sending' : 'Email Estimate PDFs'}
      customerId={first.customer_id}
      offerNewContacts={{ customerId: first.customer_id, prospectId: first.prospect_id }}
      stateKey={`estimate-batch:${mode}:${group.map(e => e.id).join(',')}`}
      sendLabel={`${mode === 'approval' ? 'Send for Approval' : 'Send'}${index + 1 < groups.length ? ' · next customer' : ''}`}
      messagePlaceholder={mode === 'approval' ? 'Optional note to the customer, added above the estimates…' : 'Optional note to the customer…'}
      intro={intro}
      previewKey={`${mode}:${index}`}
      fetchPreview={fetchPreview}
      onSend={send}
      onClose={() => {
        if (sentRef.current) { next(true); return; }
        // Closed without sending: stop here, the rest are not sent.
        for (const g of groups.slice(index)) results.current.skipped.push(`${g[0].customer_name || 'No customer'}: ${g.length} estimate${g.length === 1 ? '' : 's'}`);
        onFinished(results.current);
      }}
    />
  );
}
