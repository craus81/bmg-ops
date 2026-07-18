import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuditEntry {
  actorId: string | null;
  table: string;
  /** uuid or business key (e.g. part number for pay rates); null for bulk actions. */
  recordId: string | null;
  action: string;
  detail?: Record<string, unknown>;
}

/**
 * Record who changed what on money-touching mutations. Fire-and-forget by
 * contract: an audit failure logs to console but never blocks or fails the
 * mutation it describes.
 */
export async function logAudit(
  service: SupabaseClient,
  entries: AuditEntry | AuditEntry[],
): Promise<void> {
  const rows = (Array.isArray(entries) ? entries : [entries]).map(e => ({
    actor_id: e.actorId,
    table_name: e.table,
    record_id: e.recordId,
    action: e.action,
    detail: e.detail ?? null,
  }));
  try {
    const { error } = await service.from('audit_log').insert(rows);
    if (error) console.error('audit_log insert failed:', error.message);
  } catch (e: any) {
    console.error('audit_log insert failed:', e?.message || e);
  }
}
