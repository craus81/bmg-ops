'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '@/components/AuthProvider';
import { CreateNetsuiteItemModal, type CreatedPart } from '@/components/CreateNetsuiteItemModal';
import { lookupPartFromCache, rememberPartInCache } from '@/lib/parts-cache';

export type { CreatedPart } from '@/components/CreateNetsuiteItemModal';

interface StartOptions {
  billableCustomer?: string | null;
  catalog?: 'graphics' | 'upfit';
  /** Called with the new (or linked) catalog part once the form is dismissed. */
  onAdded: (part: CreatedPart) => void;
  /** Called if the form is closed without adding the part. */
  onCancel?: () => void;
}

/**
 * One "add a part that isn't in the catalog" flow for every part-number box.
 * The form lives here, outside whatever dropdown opened it, so a dropdown
 * closing on blur doesn't take the form with it: render `modal` once at the
 * page/component level and call `start()` from an {@link AddToCatalogRow}.
 *
 * Admin-only: the part is created in NetSuite (BMG Fleet Installations
 * subsidiary) by /api/netsuite/create-item, which requires the admin role.
 */
export function useAddToCatalog(): {
  canAdd: boolean;
  start: (partNumber: string, opts: StartOptions) => void;
  modal: ReactNode;
} {
  const { isAdmin } = useAuth();
  const [ctx, setCtx] = useState<(StartOptions & { partNumber: string }) | null>(null);

  const start = useCallback((partNumber: string, opts: StartOptions) => {
    const pn = partNumber.trim();
    if (!pn) return;
    setCtx({ ...opts, partNumber: pn });
  }, []);

  // Portaled to <body> so a transformed or scrolling parent (popouts,
  // side panels) can't clip or offset the fixed-position form.
  const modal = ctx && typeof document !== 'undefined' ? createPortal(
    <CreateNetsuiteItemModal
      initialPartNumber={ctx.partNumber}
      billableCustomer={ctx.billableCustomer || null}
      catalog={ctx.catalog || 'graphics'}
      chooseCatalog
      onClose={() => { const cancel = ctx.onCancel; setCtx(null); cancel?.(); }}
      onCreated={part => {
        const done = ctx.onAdded;
        setCtx(null);
        done(part);
      }}
    />,
    document.body,
  ) : null;

  return { canAdd: isAdmin, start, modal };
}

/**
 * True when `typed` is worth offering as a new catalog part: at least two
 * characters and not already an exact (case-insensitive) item number among
 * the matches the box is showing.
 */
export function offerAddToCatalog(typed: string, matchItemNumbers: string[]): boolean {
  const q = typed.trim().toUpperCase();
  if (q.length < 2) return false;
  return !matchItemNumbers.some(n => (n || '').trim().toUpperCase() === q);
}

/** The last row of a part dropdown: `＋ Add "X" to catalog`. */
export function AddToCatalogRow({
  partNumber,
  onClick,
  fontSize = '12px',
}: {
  partNumber: string;
  onClick: () => void;
  fontSize?: string;
}) {
  return (
    <button
      type="button"
      // mousedown, not click: fires before the input's blur closes the list.
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      style={{
        display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', border: 'none',
        background: 'rgba(34,197,94,0.08)', color: '#22c55e', cursor: 'pointer', fontSize, fontWeight: 700,
      }}
    >
      ＋ Add &ldquo;{partNumber.trim()}&rdquo; to catalog
    </button>
  );
}

/**
 * For free-text part boxes with no dropdown (graphics job part chips): once
 * the catalog has loaded, shows a small "＋ Add to catalog" button next to a
 * part number the catalog doesn't have. Admins only; renders nothing
 * otherwise.
 */
export function NotInCatalogAdd({
  partNumber,
  billableCustomer,
  onAdded,
}: {
  partNumber: string;
  billableCustomer?: string | null;
  onAdded?: (part: CreatedPart) => void;
}) {
  const addToCatalog = useAddToCatalog();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!addToCatalog.canAdd) return;
    let cancelled = false;
    lookupPartFromCache(partNumber).then(p => { if (!cancelled) setMissing(!p); });
    return () => { cancelled = true; };
  }, [partNumber, addToCatalog.canAdd]);

  if (!addToCatalog.canAdd || !missing) return null;
  return (
    <>
      <button
        type="button"
        title={`${partNumber} is not in the catalog`}
        onClick={() => addToCatalog.start(partNumber, {
          billableCustomer,
          onAdded: part => {
            rememberPartInCache({
              id: part.id,
              item_number: part.item_number,
              display_name: part.display_name,
              description: null,
              billable_customer: part.billable_customer,
            });
            setMissing(false);
            onAdded?.(part);
          },
        })}
        style={{ border: 'none', background: 'transparent', color: '#22c55e', cursor: 'pointer', fontSize: '10px', fontWeight: 700, padding: 0, marginLeft: '2px', whiteSpace: 'nowrap' }}
      >＋ Add to catalog</button>
      {addToCatalog.modal}
    </>
  );
}
