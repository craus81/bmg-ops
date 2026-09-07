import type { SupabaseClient } from '@supabase/supabase-js';
import { createNote } from '@/lib/netsuite';

/**
 * CRM notes → NetSuite user notes (R3-16a's second half, owner decision
 * 2026-09-07). One idempotent drain shared by every path: promotion pushes
 * the record's backlog under the brand-new customer, the sync-notes route
 * drains a linked record on demand (the page calls it after each new
 * activity, and its Sync button retries failures), and the voice-note
 * route pushes right after filing its activity.
 *
 * What syncs: human-authored rows only — the composer's call/email/note/
 * meeting entries and voice notes. Rows the APP wrote (auto = true: logAuto
 * entries, email-send logs, quote responses) and the status_change/quote_*
 * types stay FleetSuite-only; they'd read as app noise on the NetSuite side.
 * Synced rows are stamped with the NetSuite note id so a re-drain never
 * duplicates ('created-id-unknown' sentinel keeps that guard armed when
 * NetSuite creates the note but returns no id — the never-stamp-falsy rule).
 */

const SYNCABLE_TYPES = ['call', 'email', 'note', 'meeting'];
const TYPE_LABELS: Record<string, string> = { call: 'Call', email: 'Email', note: 'Note', meeting: 'Meeting' };
/** NetSuite's note memo field caps at 4000 characters. */
const NOTE_CHAR_LIMIT = 3900;
/** Serial NetSuite creates cost ~0.5s each — cap one drain so a promotion
 *  can't blow its route budget on a huge backlog; `remaining` says how many
 *  are left for the next call. */
const MAX_PER_RUN = 50;

export interface NotesSyncResult {
  pushed: number;
  failed: number;
  /** Unsynced rows left beyond this run's cap — call again to continue. */
  remaining: number;
}

export async function pushProspectNotes(
  supabase: SupabaseClient,
  prospectId: string,
  netsuiteCustomerId: string,
): Promise<NotesSyncResult> {
  // auto=true is logAuto's marker; email-send logs are excluded by their
  // email_log_id instead (resend keeps its insert column-free so it can't
  // break during the post-268 schema-cache grace window), and the app-only
  // types never make SYNCABLE_TYPES.
  const { data, error } = await supabase
    .from('prospect_activities')
    .select('id, type, summary, details, created_by, created_at')
    .eq('prospect_id', prospectId)
    .eq('auto', false)
    .is('netsuite_note_id', null)
    .is('email_log_id', null)
    .in('type', SYNCABLE_TYPES)
    .order('created_at', { ascending: true })
    .order('id')
    .limit(MAX_PER_RUN + 200);
  if (error) {
    // Schema-cache grace (the #741 lesson): right after 268 deploys,
    // PostgREST may not know auto/netsuite_note_id yet — degrade to
    // "nothing to push" instead of failing the promotion that called us.
    console.warn('pushProspectNotes read failed (schema cache?):', error.message);
    return { pushed: 0, failed: 0, remaining: 0 };
  }
  const rows = data || [];
  if (rows.length === 0) return { pushed: 0, failed: 0, remaining: 0 };

  const authorIds = [...new Set(rows.map(r => r.created_by).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', authorIds);
    for (const p of profs || []) if (p.full_name) names.set(p.id, p.full_name);
  }

  let pushed = 0;
  let failed = 0;
  const batch = rows.slice(0, MAX_PER_RUN);
  // Oldest first, so the NetSuite notes list reads chronologically.
  for (const row of batch) {
    const label = TYPE_LABELS[row.type] || 'Note';
    const date = String(row.created_at || '').slice(0, 10);
    const author = row.created_by ? names.get(row.created_by) : null;
    const body = [
      String(row.summary || '').trim(),
      row.details ? String(row.details).trim() : '',
      `— ${author || 'FleetSuite'}${date ? ` · ${date}` : ''}`,
    ].filter(Boolean).join('\n\n').slice(0, NOTE_CHAR_LIMIT);

    const r = await createNote({
      entityId: String(netsuiteCustomerId),
      title: `${label}${date ? ` ${date}` : ''} (FleetSuite)`.slice(0, 99),
      note: body,
    });
    if (r.success) {
      const stampId = r.internalId || 'created-id-unknown';
      const { error: stampErr } = await supabase
        .from('prospect_activities')
        .update({ netsuite_note_id: stampId })
        .eq('id', row.id);
      if (stampErr) {
        console.error(
          `pushProspectNotes: stamp failed for activity ${row.id} (NetSuite note ${stampId} exists — duplicate risk on the next drain):`,
          stampErr.message,
        );
      }
      pushed++;
    } else {
      failed++;
      console.warn(`pushProspectNotes: note push failed for activity ${row.id}:`, r.error);
    }
  }
  return { pushed, failed, remaining: rows.length - batch.length };
}
