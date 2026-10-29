import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './fetch-all';

/**
 * Labor and freight check before an estimate goes out (Craig, 2026-10-29).
 * Every send (Send for approval, Email PDF, Email Pro Forma, and the
 * Estimates list's Select sends) stops on a pop-up that asks to look over
 * labor hours and freight, and lists what looks off on each estimate.
 * A fleet send checks every truck in the email: edits to one truck's
 * estimate don't carry over to the others.
 */

export interface SendCheckLine {
  item_number: string | null;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  /** NULL = the part had no labor set when added (migration 258). */
  labor_hours: number | null;
  is_custom: boolean | null;
}

export interface SendCheckEstimate {
  lines: SendCheckLine[];
  labor_hours_override: number | null;
  labor_total: number | null;
}

export interface SendCheckGroup {
  id: string;
  /** "EST-2621 (unit 5102)" */
  label: string;
  findings: string[];
}

/** Freight has no flag of its own on a line: other reports go by the item number, this reads the description too. */
export function isFreightLine(l: Pick<SendCheckLine, 'item_number' | 'description'>): boolean {
  return /freight|shipping/i.test(`${l.item_number || ''} ${l.description || ''}`);
}

/** What looks off on one estimate, in plain words. Empty when nothing does. */
export function sendCheckFindings(est: SendCheckEstimate): string[] {
  const out: string[] = [];
  // A typed labor override replaces the per-line hours, so unset lines don't matter then.
  if (est.labor_hours_override == null) {
    const unset = est.lines.filter(l => !l.is_custom && l.labor_hours == null);
    if (unset.length > 0) {
      const names = unset.map(l => (l.item_number || l.description || 'a part').trim());
      const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? ` and ${names.length - 4} more` : '');
      out.push(`${unset.length} line${unset.length === 1 ? ' has' : 's have'} labor not set: ${shown}`);
    }
  }
  if (!(Number(est.labor_total) > 0)) out.push('Labor total is $0');
  const freight = est.lines.filter(isFreightLine);
  if (freight.length === 0) out.push('No freight line on this estimate');
  else if (!freight.some(l => (Number(l.quantity) || 0) * (Number(l.unit_price) || 0) > 0)) out.push('Freight line is $0');
  return out;
}

export function sendCheckLabel(e: { estimate_number?: string | null; unit_number?: string | null }): string {
  const num = e.estimate_number || 'Estimate';
  return e.unit_number ? `${num} (unit ${e.unit_number})` : num;
}

/** Read the saved estimates and check each, in the order given. */
export async function loadSendChecks(supabase: SupabaseClient, ids: string[]): Promise<SendCheckGroup[]> {
  if (ids.length === 0) return [];
  const [{ data: ests, error }, { data: lines, error: lineError }] = await Promise.all([
    supabase
      .from('estimates')
      .select('id, estimate_number, unit_number, labor_hours_override, labor_total')
      .in('id', ids),
    fetchAllRows<SendCheckLine & { estimate_id: string }>((from, to) =>
      supabase
        .from('estimate_line_items')
        .select('estimate_id, item_number, description, quantity, unit_price, labor_hours, is_custom')
        .in('estimate_id', ids)
        .order('estimate_id')
        .order('id')
        .range(from, to),
    ),
  ]);
  if (error || lineError) throw new Error((error || lineError)!.message);
  const byId = new Map((ests || []).map((e: any) => [e.id, e]));
  return ids.flatMap(id => {
    const e: any = byId.get(id);
    if (!e) return [];
    return [{
      id,
      label: sendCheckLabel(e),
      findings: sendCheckFindings({
        lines: lines.filter(l => l.estimate_id === id),
        labor_hours_override: e.labor_hours_override,
        labor_total: e.labor_total,
      }),
    }];
  });
}
