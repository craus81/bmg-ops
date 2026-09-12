/**
 * Readable audit lines (R6-13) — "Dana changed status: quoted → approved"
 * instead of a JSON blob.
 *
 * The row-diff trigger (migration 195) writes
 * `{ changed: { field: { from, to } } }` on an update and
 * `{ deleted: <whole row> }` on a delete. Hand-written logAudit calls write
 * whatever their author chose, so the renderer handles the two known shapes
 * and falls back to the raw JSON for everything else — RATHER THAN guessing
 * at an unfamiliar blob and printing a confident sentence that misreads it.
 *
 * A field with no label in FIELD_LABELS renders its column name. That is
 * deliberately not hidden: an unlabelled change is still a change, and
 * dropping it would make the history quietly incomplete.
 */

export interface ReadableChange {
  field: string;
  label: string;
  from: string;
  to: string;
  /** True when the column had no human label — shown as-is, not dropped. */
  raw: boolean;
}

export interface ReadableEntry {
  kind: 'update' | 'delete' | 'action';
  /** One line per changed field for an update; a single line otherwise. */
  changes: ReadableChange[];
  /** For 'action' entries: the raw detail, since we cannot summarise it. */
  fallback: string | null;
  summary: string;
}

/** Human names for the columns that actually show up in these histories. */
export const FIELD_LABELS: Record<string, string> = {
  status: 'status',
  customer: 'customer',
  customer_name: 'customer',
  customer_id: 'customer link',
  customer_netsuite_id: 'NetSuite customer',
  title: 'title',
  notes: 'notes',
  internal_notes: 'internal notes',
  due_date: 'due date',
  scheduled_install_date: 'scheduled install date',
  promised_back_date: 'promised-back date',
  assigned_to: 'assignee',
  assigned_installer_id: 'assigned installer',
  grand_total: 'total',
  subtotal: 'subtotal',
  tax_amount: 'tax',
  labor_total: 'labor total',
  labor_hours: 'labor hours',
  labor_hours_override: 'labor hours override',
  labor_rate: 'labor rate',
  vehicle_count: 'vehicle count',
  quantity: 'quantity',
  unit_price: 'unit price',
  tracking_number: 'tracking number',
  carrier: 'carrier',
  vin: 'VIN',
  po_number: 'PO number',
  estimate_number: 'estimate number',
  job_number: 'job number',
  invoice_number: 'invoice number',
  netsuite_so_id: 'NetSuite sales order',
  netsuite_estimate_id: 'NetSuite estimate',
  customer_approved: 'customer approval',
  customer_approved_at: 'approved at',
  customer_rejected_at: 'rejected at',
  customer_rejection_reason: 'rejection reason',
  sent_for_approval_at: 'sent for approval',
  approval_token_expires_at: 'approval link expiry',
  budget: 'budget',
  install_date: 'install date',
  completed_at: 'completed at',
  qc_completed_at: 'QC completed at',
  archived_at: 'archived at',
  priority: 'priority',
  location: 'location',
  install_location: 'install location',
};

const MAX_VALUE_CHARS = 120;

/** How a stored value reads in a sentence. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '(empty)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return '(empty)';
    // An ISO instant reads better as a date; anything else stays verbatim.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
      const t = Date.parse(s);
      if (Number.isFinite(t)) {
        return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      }
    }
    return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
  }
  const json = JSON.stringify(v);
  return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : json;
}

export function labelFor(field: string): { label: string; raw: boolean } {
  const known = FIELD_LABELS[field];
  if (known) return { label: known, raw: false };
  // Fall back to the column name made readable, and mark it so the UI can
  // show it differently — an unlabelled field is still a real change.
  return { label: field.replace(/_/g, ' '), raw: true };
}

/**
 * Turn one audit row's action + detail into readable lines.
 *
 * `actor` is the name to put in front; pass null for a system change and
 * the summary says "System" rather than inventing a person.
 */
export function readableEntry(action: string, detail: unknown, actor: string | null): ReadableEntry {
  const who = actor || 'System';
  const d = (detail && typeof detail === 'object' ? detail : {}) as Record<string, any>;

  if (action === 'row_update' && d.changed && typeof d.changed === 'object') {
    const changes: ReadableChange[] = Object.entries(d.changed as Record<string, any>).map(([field, v]) => {
      const { label, raw } = labelFor(field);
      return {
        field,
        label,
        from: formatValue(v?.from),
        to: formatValue(v?.to),
        raw,
      };
    });
    const first = changes[0];
    const more = changes.length - 1;
    return {
      kind: 'update',
      changes,
      fallback: null,
      summary: changes.length === 0
        ? `${who} saved this record with no field changes recorded`
        : `${who} changed ${first.label}${more > 0 ? ` and ${more} other field${more === 1 ? '' : 's'}` : ''}`,
    };
  }

  if (action === 'row_delete') {
    return { kind: 'delete', changes: [], fallback: null, summary: `${who} deleted this record` };
  }

  // A hand-written logAudit action. Its detail can be any shape, so the
  // sentence names the action and the raw JSON stays available rather than
  // being paraphrased into something that might not be true.
  return {
    kind: 'action',
    changes: [],
    fallback: Object.keys(d).length > 0 ? JSON.stringify(d, null, 2) : null,
    summary: `${who} — ${action.replace(/_/g, ' ')}`,
  };
}
