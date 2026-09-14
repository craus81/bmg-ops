import type { SupabaseClient } from '@supabase/supabase-js';
import { sanitizeQboPayload } from '@/lib/quickbooks/sanitize';

/**
 * How rows reach the ledger tables — source-agnostic, so the QuickBooks
 * importer (PR2) and the NetSuite mirror (PR3) write through exactly one
 * implementation.
 *
 * Three rules are enforced HERE rather than by convention, because each one
 * has a failure mode that is silent at the call site:
 *
 *  1. `last_synced_at` is stamped on EVERY write. PostgREST's upsert is
 *     `INSERT … ON CONFLICT DO UPDATE SET <only the columns sent>`, so a
 *     column the mapper omits keeps its stored value on the update path. The
 *     column's `DEFAULT now()` fires on INSERT only — omit the stamp and
 *     `last_synced_at` freezes at first import, and every "when did we last
 *     see this row" answer becomes false.
 *  2. `first_seen_at` is NEVER sent. Same mechanism, opposite direction: a
 *     mapper that helpfully set it would rewrite the row's arrival date on
 *     every re-import.
 *  3. `source = 'fleetsuite'` is refused. Those rows are the app's own
 *     documents; nothing in an importer may create or overwrite one.
 */

export type LedgerSource = 'quickbooks' | 'netsuite' | 'fleetsuite';

/**
 * The tables whose `external_id` is `'<Type>/<id>'`. `ledger_report_snapshots`
 * is deliberately absent — its key is `':'`-joined
 * (`'AgedReceivables:none:2024-01-31:2024-01-31:Total'`) and it upserts
 * directly (§2.7), so it never meets the slash guard below.
 */
export const SLASH_KEYED_TABLES = [
  'ledger_accounts',
  'ledger_entities',
  'ledger_customers',
  'ledger_documents',
  'ledger_invoices',
  'ledger_bills',
  'ledger_payments',
  'ledger_journal_entries',
] as const;

export type SlashKeyedTable = (typeof SLASH_KEYED_TABLES)[number];

export const LEDGER_READ_ONLY = 'LEDGER_READ_ONLY';

/** Statement size: comfortably under PostgREST's payload limits. */
const UPSERT_CHUNK = 200;
/** `.in()` list length — a longer list makes an unwieldy URL. */
const IN_CHUNK = 100;
/** Plain insert batch. */
const INSERT_CHUNK = 500;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export interface UpsertResult {
  /** external_id → the row's uuid, for children and cross-links. */
  ids: Map<string, string>;
  errors: { external_id: string; message: string }[];
}

export async function upsertRows(
  service: SupabaseClient,
  table: SlashKeyedTable,
  rows: Record<string, unknown>[],
  opts: { onConflict: 'source,external_id'; chunk?: number },
): Promise<UpsertResult> {
  const ids = new Map<string, string>();
  const errors: { external_id: string; message: string }[] = [];
  if (rows.length === 0) return { ids, errors };

  const syncedAt = new Date().toISOString();
  const prepared: Record<string, unknown>[] = rows.map(r => {
    const external_id = String(r.external_id ?? '');
    if (r.source === 'fleetsuite') {
      throw new Error(`${LEDGER_READ_ONLY}: ${table} rows with source 'fleetsuite' are written by the app, not an importer`);
    }
    if (!external_id.includes('/')) {
      throw new Error(`${table}.external_id must be '<Type>/<id>' — got ${JSON.stringify(external_id)}`);
    }
    // first_seen_at is stripped rather than trusted: a mapper that sends it
    // would silently reset the row's arrival date on every re-import.
    const rest: Record<string, unknown> = { ...r };
    delete rest.first_seen_at;
    return { ...rest, last_synced_at: syncedAt };
  });

  for (const batch of chunk(prepared, opts.chunk ?? UPSERT_CHUNK)) {
    const { data, error } = await service
      .from(table)
      .upsert(batch, { onConflict: opts.onConflict })
      .select('id, external_id');
    if (!error && data) {
      for (const row of data) ids.set(String(row.external_id), String(row.id));
      continue;
    }
    // Bulk failure → one row at a time, so a single bad record cannot sink a
    // whole page (the sales-order sync's rule: no bare `continue`, count what
    // still fails).
    for (const row of batch) {
      const { data: one, error: rowError } = await service
        .from(table)
        .upsert(row, { onConflict: opts.onConflict })
        .select('id, external_id')
        .maybeSingle();
      if (rowError || !one) {
        errors.push({
          external_id: String(row.external_id),
          message: rowError?.message || error?.message || 'no row returned',
        });
        continue;
      }
      ids.set(String(one.external_id), String(one.id));
    }
  }

  return { ids, errors };
}

/**
 * Replace a parent's children wholesale: delete then insert.
 *
 * Lines have no stable source-side identity beyond their position, so
 * merging them would leave orphans behind whenever a document is edited in
 * QuickBooks and comes back with fewer lines. The parent's
 * `lines_synced_at` / `applications_synced_at` stamp goes on only AFTER the
 * children land (`stampSynced`), so a chunk killed between the two leaves
 * the parent marked pending and the repair phase picks it up.
 */
export async function replaceChildren(
  service: SupabaseClient,
  table: string,
  parentCol: 'document_id' | 'entry_id' | 'payment_id',
  byParent: Map<string, Record<string, unknown>[]>,
): Promise<{ inserted: number; errors: string[] }> {
  const errors: string[] = [];
  let inserted = 0;
  const parents = [...byParent.keys()];
  if (parents.length === 0) return { inserted, errors };

  for (const batch of chunk(parents, IN_CHUNK)) {
    const { error } = await service.from(table).delete().in(parentCol, batch);
    if (error) errors.push(`${table} delete: ${error.message}`);
  }

  const allRows = parents.flatMap(p => byParent.get(p) || []);
  for (const batch of chunk(allRows, INSERT_CHUNK)) {
    const { error } = await service.from(table).insert(batch);
    if (error) errors.push(`${table} insert: ${error.message}`);
    else inserted += batch.length;
  }

  return { inserted, errors };
}

/** Stamp parents as having their children in place. Call AFTER they land. */
export async function stampSynced(
  service: SupabaseClient,
  table: string,
  col: 'lines_synced_at' | 'applications_synced_at',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const at = new Date().toISOString();
  for (const batch of chunk(ids, IN_CHUNK)) {
    const { error } = await service.from(table).update({ [col]: at }).in('id', batch);
    if (error) console.error(`[ledger] ${table}.${col} stamp failed:`, error.message);
  }
}

export interface EventRow {
  phase: string | null;
  entityType: string;
  externalId: string | null;
  outcome: 'error' | 'skipped' | 'dropped_field' | 'voided' | 'deleted' | 'unsupported' | 'unmatched' | 'ambiguous';
  message?: string;
  raw?: unknown;
}

/**
 * Append per-row exceptions from one run, capped.
 *
 * `ledger_import_events` is SELECT-able by every finance/admin/super_admin/
 * executive reader, so `raw` may hold ONLY sanitizer OUTPUT, ids, or dropped
 * key NAMES — never a pre-sanitize payload. Callers are supposed to obey
 * that; this function re-runs `sanitizeQboPayload` over whatever it is
 * handed anyway, so a caller that forgets still cannot store a card or bank
 * field in a reader-visible table.
 *
 * The cap (5,000 per run) exists because a systematically broken import
 * would otherwise write one row per record and turn a failed run into a
 * second incident.
 */
export async function appendEvents(
  service: SupabaseClient,
  runId: string,
  events: EventRow[],
  cap: { seen: number; max: 5000 },
): Promise<number> {
  if (events.length === 0) return 0;
  const room = Math.max(0, cap.max - cap.seen);
  if (room === 0) return 0;
  const take = events.slice(0, room);

  const rows = take.map(e => ({
    run_id: runId,
    source: 'quickbooks',
    phase: e.phase,
    entity_type: e.entityType,
    external_id: e.externalId,
    outcome: e.outcome,
    message: e.message ? String(e.message).slice(0, 2000) : null,
    raw: e.raw === undefined ? null : (sanitizeQboPayload(e.entityType, e.raw).clean as any),
  }));

  for (const batch of chunk(rows, INSERT_CHUNK)) {
    const { error } = await service.from('ledger_import_events').insert(batch);
    if (error) console.error('[ledger] import event insert failed:', error.message);
  }
  cap.seen += take.length;
  return take.length;
}

/**
 * The ONE cursor idiom for a `sync_state` pointer that is NOT a heartbeat.
 *
 * A plain upsert: no `last_synced_at` (that column is a data watermark, and
 * a mid-run page cursor is not one) and emphatically not `recordHeartbeat`,
 * which would append a `cron_runs` row per page and turn one run into
 * hundreds in the flight recorder.
 */
export async function writeSyncStateCursor(
  service: SupabaseClient,
  syncType: string,
  lastResult: Record<string, unknown>,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await service.from('sync_state').upsert(
    { sync_type: syncType, last_result: { ...lastResult, updatedAt: now }, updated_at: now },
    { onConflict: 'sync_type' },
  );
  if (error) console.error(`[ledger] ${syncType} cursor write failed:`, error.message);
}

export interface ImportPointer {
  runId: string;
  /**
   * `dry_run` is absent from this union ON PURPOSE — a dry run writes no
   * pointer at all (owner requirement 7: nothing is written until the report
   * has been read), and the type is what enforces it.
   */
  mode: 'import' | 'cdc';
  phase: string | null;
  entity?: string | null;
  processed?: number;
  expected?: number | null;
  status: string;
  partial: boolean;
  startPosition?: number;
}

/**
 * The `sync_state` MIRROR of `ledger_import_runs.cursor`.
 *
 * The run row is authoritative; this exists so System Health and a driver
 * script can see progress without reading a ledger table. Written in the
 * same step as the authoritative cursor, before every network fetch.
 */
export async function writeImportPointer(service: SupabaseClient, pointer: ImportPointer): Promise<void> {
  await writeSyncStateCursor(service, 'ledger_qbo_import', {
    ...pointer,
    resume: {
      runId: pointer.runId,
      phase: pointer.phase,
      entity: pointer.entity ?? null,
      startPosition: pointer.startPosition ?? null,
    },
  });
}
