/**
 * Scan lifecycle derivation — the single definition of how a scan_logs row's
 * stamps map to a display state. Invoiced wins over archived (invoicing
 * stamps archived_at too), then archived, exported, and the PO-derived
 * pending states. Client-safe (pure).
 */

export type ScanLifecycleState = 'invoiced' | 'archived' | 'exported' | 'ready' | 'waiting';

export interface ScanLifecycleFields {
  part_number: string | null;
  po_id: string | null;
  exported_at: string | null;
  archived_at: string | null;
  billable_customer?: string | null;
  invoice_number?: string | null;
  date_invoiced?: string | null;
  is_paid?: boolean | null;
}

/**
 * requiresPo decides Ready vs Waiting for an unmatched scan. It receives the
 * billable customer too, because invoice-first customers (billable_customers
 * .requires_po = FALSE, e.g. Reading Truck) never wait for a PO regardless
 * of the part's requires_po_match — see src/lib/billable-customers.ts.
 */
export function scanLifecycle(
  s: ScanLifecycleFields,
  requiresPo: (partNumber: string | null, billableCustomer?: string | null) => boolean,
): { state: ScanLifecycleState; label: string } {
  if (s.invoice_number || s.date_invoiced) {
    const inv = s.invoice_number ? ` #${s.invoice_number}` : '';
    return { state: 'invoiced', label: s.is_paid ? `Invoiced${inv} · Paid` : `Invoiced${inv}` };
  }
  if (s.archived_at) return { state: 'archived', label: 'Archived' };
  if (s.exported_at) return { state: 'exported', label: 'Exported' };
  if (s.po_id || !requiresPo(s.part_number, s.billable_customer)) return { state: 'ready', label: 'Ready to Export' };
  return { state: 'waiting', label: 'Waiting for PO' };
}
