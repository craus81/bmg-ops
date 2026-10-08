import type { SupabaseClient } from '@supabase/supabase-js';
import { suiteqlQuery } from '@/lib/netsuite';

/**
 * Fill in who created each mirrored NetSuite sales order and PO (migration
 * 348) for the "Created by" tag. Runs from the netsuite-sync cron as its
 * own step, separate from the SO/PO syncs, so a role that can't read
 * transaction.createdby costs this tag and nothing else.
 *
 * Each run takes a capped batch of rows that were never checked, asks
 * NetSuite for their Created By in one query per 100 ids, and stamps
 * creator_checked_at whether or not a name came back — a record is looked
 * up once, and the backlog drains a batch per run. When the query itself
 * fails, nothing is stamped, so the next run retries.
 */

const TABLES = [
  { key: 'salesOrders', table: 'netsuite_sales_orders' },
  { key: 'purchaseOrders', table: 'netsuite_vendor_pos' },
] as const;

export const CREATOR_BATCH = 400;
const IN_CHUNK = 100;

export function buildCreatorQuery(ids: string[]): string {
  const safe = ids.filter(id => /^\d+$/.test(id));
  return `SELECT t.id, BUILTIN.DF(t.createdby) AS created_by_name FROM transaction t WHERE t.id IN (${safe.join(', ')})`;
}

export interface CreatorSyncResult {
  checked: number;
  named: number;
  error?: string;
}

export async function syncNetsuiteCreators(
  service: SupabaseClient,
  opts?: { batch?: number },
): Promise<Record<string, CreatorSyncResult>> {
  const out: Record<string, CreatorSyncResult> = {};
  for (const { key, table } of TABLES) {
    const res: CreatorSyncResult = { checked: 0, named: 0 };
    out[key] = res;
    try {
      const { data: rows, error } = await service
        .from(table)
        .select('netsuite_id')
        .is('creator_checked_at', null)
        .order('netsuite_id', { ascending: false })
        .limit(opts?.batch ?? CREATOR_BATCH);
      if (error) throw new Error(error.message);
      const ids = (rows || []).map((r: { netsuite_id: string }) => String(r.netsuite_id)).filter(id => /^\d+$/.test(id));
      for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const chunk = ids.slice(i, i + IN_CHUNK);
        const result = await suiteqlQuery(buildCreatorQuery(chunk), IN_CHUNK, 0);
        const names = new Map<string, string>();
        for (const item of (result?.items || []) as Array<{ id: unknown; created_by_name?: unknown }>) {
          const name = typeof item.created_by_name === 'string' ? item.created_by_name.trim() : '';
          if (name) names.set(String(item.id), name);
        }
        const now = new Date().toISOString();
        // Named rows one by one (each has its own value); the rest in one
        // stamp so they aren't asked about again.
        for (const [nsId, name] of names) {
          const { error: upErr } = await service
            .from(table)
            .update({ created_by_name: name, creator_checked_at: now })
            .eq('netsuite_id', nsId);
          if (!upErr) res.named++;
        }
        const unnamed = chunk.filter(id => !names.has(id));
        if (unnamed.length > 0) {
          await service.from(table).update({ creator_checked_at: now }).in('netsuite_id', unnamed);
        }
        res.checked += chunk.length;
      }
    } catch (err: any) {
      res.error = String(err?.message || err).slice(0, 300);
    }
  }
  return out;
}
