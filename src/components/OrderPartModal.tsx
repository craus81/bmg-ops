'use client';

/**
 * Order one part straight from its record in the Parts catalog (Craig,
 * 2026-10-09: "an add to purchase order button in the parts record").
 *
 * Anyone with parts ordering adds the part to the Purchasing queue: quantity,
 * an optional job, needed-by date and a note, through the same
 * /api/purchase-requests the readiness cards and buy list use. Admins also
 * get "Order now", which raises the same request and then opens the Create
 * PO review screen for just that request, so the NetSuite PO goes through
 * the one review path (vendor, price, plant, memo) the queue already uses.
 *
 * It never edits a PO already in NetSuite: a vendor that has the PO would
 * not see a line added after it was sent.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { theme } from '@/lib/theme';
import { createClient } from '@/lib/supabase-browser';
import { closeOnEscape } from '@/lib/modal-escape';
import { deepLinks } from '@/lib/deep-links';
import NetsuiteVendorSearch from '@/components/NetsuiteVendorSearch';
import CreatePoReviewModal, { type CreatePoResult } from '@/components/CreatePoReviewModal';

const qtyText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
// The queue's own item-number key (normalizeItemNumber in vendor-po-sync).
const itemKey = (s: string | null | undefined) => String(s || '').split(':').pop()!.trim().toUpperCase();

// Jobs still ahead of install: a part ordered for one of these is for that job.
const CLOSED_PROJECT_STATUSES = ['completed', 'cancelled', 'opportunity', 'estimate'];

export interface OrderablePart {
  item_number: string;
  /** NULL for a local-only part: it can be requested, not put on a PO. */
  netsuite_id: string | null;
  display_name: string | null;
  description: string | null;
  vendor: string | null;
  purchase_price: number | null;
  quantity_available: number | null;
}

interface ProjectOpt { id: string; label: string }

interface PendingRow {
  id: string;
  quantity: number;
  source_project_id: string | null;
  source_estimate_id: string | null;
}

interface RequestRow {
  id: string;
  item_number: string;
  netsuite_item_id: string | null;
  description: string | null;
  quantity: number;
  vendor_name: string | null;
  vendor_netsuite_id: string | null;
}

interface Props {
  part: OrderablePart;
  /** Admins get Order now (a NetSuite PO through the review screen). */
  canCreatePo: boolean;
  onClose: () => void;
}

type Step =
  | { kind: 'form' }
  | { kind: 'vendor'; request: RequestRow }
  | { kind: 'review'; request: RequestRow; vendor: { id: string; name: string } }
  | { kind: 'queued'; requestId: string; quantity: number }
  | { kind: 'ordered'; po: CreatePoResult };

export default function OrderPartModal({ part, canCreatePo, onClose }: Props) {
  const supabase = createClient();
  const [qty, setQty] = useState('1');
  const [projectId, setProjectId] = useState('');
  const [neededBy, setNeededBy] = useState('');
  const [note, setNote] = useState('');
  const [projects, setProjects] = useState<ProjectOpt[]>([]);
  const [pending, setPending] = useState<PendingRow[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('upfit_projects')
        .select('id, project_name, netsuite_so_number, status')
        .not('status', 'in', `(${CLOSED_PROJECT_STATUSES.join(',')})`)
        .order('project_name')
        .order('id')
        .limit(500);
      if (cancelled) return;
      setProjects(((data || []) as any[]).map(p => ({
        id: p.id,
        label: `${p.project_name || 'Upfit project'}${p.netsuite_so_number ? ` · SO ${p.netsuite_so_number}` : ''}`,
      })));
    })();
    (async () => {
      try {
        const res = await fetch('/api/purchase-requests?status=pending');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        const rows = ((body.requests || []) as any[])
          .filter(r => itemKey(r.item_number) === itemKey(part.item_number));
        setPending(rows.map(r => ({
          id: r.id, quantity: Number(r.quantity) || 0,
          source_project_id: r.source_project_id || null,
          source_estimate_id: r.source_estimate_id || null,
        })));
      } catch {
        if (!cancelled) setPending([]);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part.item_number]);

  const quantity = (() => {
    const n = parseFloat(qty);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  // The queue keeps one pending row per part per job (or one for stock) and
  // a request SETS that row's quantity, so the amount typed here is added to
  // what is already waiting for the same job.
  const sameSource = (pending || []).find(r => projectId
    ? r.source_project_id === projectId
    : !r.source_project_id && !r.source_estimate_id);
  const totalPending = (pending || []).reduce((s, r) => s + r.quantity, 0);
  const onPo = !!part.netsuite_id;

  const raise = async (): Promise<string | null> => {
    const res = await fetch('/api/purchase-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{
          itemNumber: part.item_number,
          quantity: (sameSource?.quantity || 0) + quantity,
          netsuiteItemId: part.netsuite_id || undefined,
          description: (part.description || part.display_name || '').slice(0, 500) || undefined,
        }],
        projectId: projectId || undefined,
        neededBy: neededBy || undefined,
        note: note.trim() || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body?.error || `HTTP ${res.status}`);
    return (body.createdIds && body.createdIds[0]) || sameSource?.id || null;
  };

  const addToQueue = async () => {
    if (busy || quantity <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const id = await raise();
      if (!id) throw new Error('the request was not saved');
      setStep({ kind: 'queued', requestId: id, quantity: (sameSource?.quantity || 0) + quantity });
    } catch (e: any) {
      setError(`Couldn’t add it to Purchasing: ${e?.message || 'unknown error'}.`);
    } finally {
      setBusy(false);
    }
  };

  const orderNow = async () => {
    if (busy || quantity <= 0 || !onPo) return;
    setBusy(true);
    setError(null);
    try {
      const id = await raise();
      if (!id) throw new Error('the request was not saved');
      const res = await fetch(`/api/purchase-requests?id=${id}`);
      const body = await res.json().catch(() => ({}));
      const row = body.requests?.[0];
      if (!res.ok || !row) throw new Error(body?.error || 'the request could not be read back');
      const request: RequestRow = {
        id: row.id, item_number: row.item_number, netsuite_item_id: row.netsuite_item_id,
        description: row.description, quantity: Number(row.quantity) || quantity,
        vendor_name: row.vendor_name, vendor_netsuite_id: row.vendor_netsuite_id,
      };
      // The last NetSuite PO for this part names the vendor; otherwise pick one.
      if (request.vendor_netsuite_id) {
        setStep({ kind: 'review', request, vendor: { id: request.vendor_netsuite_id, name: request.vendor_name || part.vendor || 'Vendor' } });
      } else {
        setStep({ kind: 'vendor', request });
      }
    } catch (e: any) {
      setError(`Couldn’t start the order: ${e?.message || 'unknown error'}.`);
    } finally {
      setBusy(false);
    }
  };

  if (step.kind === 'review') {
    return (
      <CreatePoReviewModal
        vendor={step.vendor}
        rows={[{
          id: step.request.id, item_number: step.request.item_number,
          netsuite_item_id: step.request.netsuite_item_id, description: step.request.description,
          quantity: step.request.quantity,
          catalog_cost: part.purchase_price && part.purchase_price > 0 ? part.purchase_price : null,
          forLabel: projects.find(p => p.id === projectId)?.label || 'stock',
        }]}
        initiallySelected={new Set([step.request.id])}
        // Backing out leaves the request in the queue rather than losing it.
        onClose={() => setStep({ kind: 'queued', requestId: step.request.id, quantity: step.request.quantity })}
        onDone={po => setStep({ kind: 'ordered', po })}
      />
    );
  }

  const label: React.CSSProperties = { fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: theme.textMuted, marginBottom: '4px', display: 'block' };
  const input: React.CSSProperties = {
    width: '100%', padding: '7px 9px', fontSize: '16px', background: theme.inputBg,
    color: theme.textPrimary, border: `1px solid ${theme.border}`, borderRadius: '8px', boxSizing: 'border-box',
  };
  const secondaryBtn: React.CSSProperties = {
    padding: '8px 14px', borderRadius: '8px', background: 'transparent', border: `1px solid ${theme.border}`,
    color: theme.textSecondary, fontSize: '12px', fontWeight: 700, cursor: 'pointer',
  };

  return (
    <div
      ref={closeOnEscape(() => { if (!busy) onClose(); })}
      style={{
        position: 'fixed', inset: 0, background: 'var(--overlay)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 300, padding: '16px',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: theme.card, border: `1px solid ${theme.border}`, borderRadius: '14px',
          width: '100%', maxWidth: '460px', maxHeight: 'calc(88vh / var(--ts))',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ padding: '14px 16px', borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ fontSize: '15px', fontWeight: 800, color: theme.textPrimary }}>
            Order {part.item_number}
          </div>
          {(part.display_name || part.description) && (
            <div style={{ fontSize: '12px', color: theme.textMuted, marginTop: '3px' }}>
              {part.display_name || part.description}
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
          {step.kind === 'form' && (
            <>
              <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '12px', lineHeight: 1.5 }}>
                {part.quantity_available != null && <>Available now: <b>{qtyText(Number(part.quantity_available))}</b>. </>}
                {pending === null ? 'Checking Purchasing…'
                  : totalPending > 0 ? <>Already waiting in Purchasing: <b>{qtyText(totalPending)}</b>.</>
                    : 'Nothing waiting in Purchasing for this part.'}
                {part.vendor && <> Vendor: <b>{part.vendor}</b>.</>}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '10px', marginBottom: '10px' }}>
                <div>
                  <label style={label} htmlFor="order-part-qty">Quantity</label>
                  <input id="order-part-qty" type="number" min="0" step="1" value={qty} autoFocus
                    onChange={e => setQty(e.target.value)} style={input} disabled={busy} />
                </div>
                <div>
                  <label style={label} htmlFor="order-part-needed">Needed by (optional)</label>
                  <input id="order-part-needed" type="date" value={neededBy}
                    onChange={e => setNeededBy(e.target.value)} style={input} disabled={busy} />
                </div>
              </div>

              <div style={{ marginBottom: '10px' }}>
                <label style={label} htmlFor="order-part-job">For job (optional)</label>
                <select id="order-part-job" value={projectId} onChange={e => setProjectId(e.target.value)} style={input} disabled={busy}>
                  <option value="">Stock (no job)</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                {sameSource && (
                  <div style={{ fontSize: '11px', color: theme.textMuted, marginTop: '4px' }}>
                    {qtyText(sameSource.quantity)} already waiting for {projectId ? 'this job' : 'stock'}; this adds {qtyText(quantity)} for {qtyText(sameSource.quantity + quantity)} in all.
                  </div>
                )}
              </div>

              <div>
                <label style={label} htmlFor="order-part-note">Note (optional)</label>
                <textarea id="order-part-note" value={note} onChange={e => setNote(e.target.value)} rows={2}
                  placeholder="Anything purchasing should know" style={{ ...input, resize: 'vertical' }} disabled={busy} />
              </div>

              {canCreatePo && !onPo && (
                <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '10px' }}>
                  This part has no NetSuite item yet, so it can be requested but not put on a PO.
                </div>
              )}
            </>
          )}

          {step.kind === 'vendor' && (
            <>
              <div style={{ fontSize: '12px', color: theme.textSecondary, marginBottom: '10px', lineHeight: 1.5 }}>
                {qtyText(step.request.quantity)} × {part.item_number} is in the Purchasing queue. Which NetSuite vendor gets the PO?
              </div>
              <NetsuiteVendorSearch autoFocus initialQuery={part.vendor || ''}
                onSelect={v => setStep({ kind: 'review', request: step.request, vendor: { id: v.id, name: v.companyName || v.entityId } })} />
            </>
          )}

          {step.kind === 'queued' && (
            <div style={{ fontSize: '13px', color: theme.textPrimary, lineHeight: 1.6 }}>
              {qtyText(step.quantity)} × <b>{part.item_number}</b> is waiting in Purchasing.{' '}
              <Link href={deepLinks.purchaseRequests(step.requestId)} style={{ color: '#60a5fa', fontWeight: 700 }}>
                Open in Purchasing
              </Link>
            </div>
          )}

          {step.kind === 'ordered' && (
            <div style={{ fontSize: '13px', color: theme.textPrimary, lineHeight: 1.6 }}>
              PO <b>{step.po.number}</b> created in NetSuite for {part.item_number}.{' '}
              {step.po.url && (
                <a href={step.po.url} target="_blank" rel="noopener noreferrer" style={{ color: '#60a5fa', fontWeight: 700 }}>
                  Open in NetSuite ↗
                </a>
              )}
              {!step.po.stamped && (
                <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '6px' }}>
                  The PO was created, but the request wasn’t marked ordered. Check it in Purchasing.
                </div>
              )}
            </div>
          )}

          {error && <div style={{ fontSize: '12px', color: theme.error, marginTop: '10px' }}>{error}</div>}
        </div>

        <div style={{ padding: '12px 16px', borderTop: `1px solid ${theme.border}`, display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {step.kind === 'form' ? (
            <>
              <button onClick={onClose} disabled={busy} style={secondaryBtn}>Cancel</button>
              <button onClick={addToQueue} disabled={busy || quantity <= 0}
                title="Add it to the Purchasing queue for whoever places orders"
                style={{ ...secondaryBtn, color: theme.textPrimary, opacity: quantity <= 0 ? 0.5 : 1 }}>
                {busy ? 'Saving…' : '🛒 Add to Purchasing'}
              </button>
              {canCreatePo && (
                <button onClick={orderNow} disabled={busy || quantity <= 0 || !onPo}
                  title={onPo ? 'Add it to the queue and review a NetSuite PO for it now' : 'No NetSuite item yet'}
                  style={{
                    padding: '8px 14px', borderRadius: '8px', fontSize: '12px', fontWeight: 800,
                    background: 'rgba(74,222,128,0.12)', border: '1px solid rgba(74,222,128,0.4)', color: '#4ade80',
                    cursor: busy || quantity <= 0 || !onPo ? 'not-allowed' : 'pointer',
                    opacity: busy || quantity <= 0 || !onPo ? 0.5 : 1,
                  }}>
                  📦 Order now…
                </button>
              )}
            </>
          ) : step.kind === 'vendor' ? (
            <button onClick={() => setStep({ kind: 'queued', requestId: step.request.id, quantity: step.request.quantity })} style={secondaryBtn}>
              Leave it in the queue
            </button>
          ) : (
            <button onClick={onClose} style={secondaryBtn}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
