import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getProfileRoles } from '@/lib/api-auth';
import { isAdminRole } from '@/lib/features';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  isOnHold, holdReason, holdTransitions, HOLD_ACTION_LABEL, HOLD_OVERRIDE_HEADER,
  type CustomerHoldRow, type HoldAction, type HoldBlockedBody, type HoldChange,
} from '@/lib/customer-hold';

export type { HoldChange } from '@/lib/customer-hold';
export { holdChangeLines } from '@/lib/customer-hold';

/**
 * Server side of the customer hold (migration 366): look a customer's hold
 * up, decide who may change or override it, and gate the routes that send
 * an estimate or quote or create a sales order.
 */

export async function arContactIds(service: SupabaseClient): Promise<string[]> {
  const { data } = await service.from('ar_reminder_settings').select('recipient_ids').eq('id', 1).maybeSingle();
  return ((data as any)?.recipient_ids as string[]) || [];
}

/** Admins and the A/R contacts (Past Due → Reminder settings) manage holds and override them. */
export async function canManageHolds(service: SupabaseClient, auth: { user: any; profile?: any }): Promise<boolean> {
  if (isAdminRole(getProfileRoles(auth.profile))) return true;
  const id = auth.user?.id;
  return !!id && (await arContactIds(service)).includes(id);
}

/** A customer's hold row, by NetSuite id or (resolved through customers) local id. */
export async function loadHold(
  service: SupabaseClient,
  target: { netsuiteId?: string | null; customerId?: string | null },
): Promise<CustomerHoldRow | null> {
  let nsId = target.netsuiteId ? String(target.netsuiteId) : null;
  if (!nsId && target.customerId) {
    const { data } = await service.from('customers').select('netsuite_id').eq('id', target.customerId).maybeSingle();
    nsId = (data as any)?.netsuite_id ? String((data as any).netsuite_id) : null;
  }
  if (!nsId) return null;
  const { data } = await service.from('customer_holds').select('*').eq('netsuite_customer_id', nsId).maybeSingle();
  return (data as CustomerHoldRow) || null;
}

/**
 * The customer's sales rep: the account owner on the customer record, else
 * whoever created their most recent estimate.
 */
export async function salesRepFor(service: SupabaseClient, netsuiteId: string, customerId: string | null): Promise<string | null> {
  if (customerId) {
    const { data } = await service.from('customers').select('account_owner_id').eq('id', customerId).maybeSingle();
    if ((data as any)?.account_owner_id) return (data as any).account_owner_id;
  }
  const { data: est } = await service
    .from('estimates').select('created_by')
    .eq('customer_netsuite_id', netsuiteId)
    .not('created_by', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (est as any)?.created_by || null;
}

/** Rep + A/R contacts, approved accounts only, deduped. */
export async function holdAudience(service: SupabaseClient, netsuiteId: string, customerId: string | null): Promise<string[]> {
  const ids = new Set(await arContactIds(service));
  const rep = await salesRepFor(service, netsuiteId, customerId);
  if (rep) ids.add(rep);
  if (ids.size === 0) return [];
  const { data } = await service.from('profiles').select('id').in('id', [...ids]).eq('status', 'approved');
  return (data || []).map((p: any) => p.id);
}

/**
 * Gate one action on the customer's hold. Returns null when the action may
 * go ahead (not on hold, or a permitted override with a reason, which is
 * logged and reported to the A/R contacts); otherwise the 409 to return.
 * The override reason rides in the x-hold-override-reason header so every
 * gated route accepts it without touching its own body schema.
 */
export async function enforceCustomerHold(
  req: NextRequest,
  service: SupabaseClient,
  auth: { user: any; profile?: any },
  target: { netsuiteId?: string | null; customerId?: string | null; customerName?: string | null; action: HoldAction; recordId?: string | null },
): Promise<NextResponse | null> {
  const hold = await loadHold(service, target);
  if (!hold || !isOnHold(hold)) return null;

  const customer = hold.customer_name || target.customerName || 'This customer';
  const canOverride = await canManageHolds(service, auth);
  let reason = '';
  try { reason = decodeURIComponent(req.headers.get(HOLD_OVERRIDE_HEADER) || '').trim().slice(0, 500); } catch { /* malformed: no reason */ }

  if (reason && canOverride) {
    await service.from('customer_hold_overrides').insert({
      netsuite_customer_id: hold.netsuite_customer_id,
      customer_name: customer,
      action: target.action,
      record_id: target.recordId || null,
      reason,
      user_id: auth.user?.id || null,
    });
    const ar = (await arContactIds(service)).filter(id => id !== auth.user?.id);
    if (ar.length > 0) {
      const { data: me } = await service.from('profiles').select('full_name').eq('id', auth.user?.id).maybeSingle();
      const who = (me as any)?.full_name || auth.user?.email || 'Someone';
      await notifyMany(ar, {
        type: 'customer_hold_override',
        title: `⚠️ ${customer} is on hold: ${who} ${HOLD_ACTION_LABEL[target.action]} anyway`,
        body: `Reason: ${reason}\n${holdReason(hold)}.`,
        url: deepLinks.pastDue(hold.netsuite_customer_id),
        channels: ['in_app', 'push'],
      });
    }
    return null;
  }

  const body: HoldBlockedBody = {
    error: `${customer} is on hold for past-due invoices (${holdReason(hold)}). ${canOverride ? 'Give a reason to go ahead anyway.' : 'An admin or A/R has to override it.'}`,
    customerOnHold: true,
    customer,
    reason: holdReason(hold),
    canOverride,
  };
  return NextResponse.json(body, { status: 409 });
}


/**
 * The 7 AM sweep's half of the hold: set auto_hold on every customer with an
 * invoice `holdDays`+ past due, clear it on the rest, and report who went on
 * or came off hold (customers a person held or released by hand change
 * nothing visible, so they report nothing).
 */
export async function sweepCustomerHolds(
  service: SupabaseClient,
  invoices: { entityId: string | null; customer: string; daysPastDue: number; unpaid: number }[],
  holdDays: number,
): Promise<{ placed: HoldChange[]; lifted: HoldChange[]; onHold: number }> {
  // Worst invoice per customer.
  const worst = new Map<string, { customer: string; oldestDays: number; pastDue: number }>();
  for (const inv of invoices) {
    if (!inv.entityId || inv.unpaid <= 0.005 || inv.daysPastDue <= 0) continue;
    const cur = worst.get(inv.entityId) || { customer: inv.customer, oldestDays: 0, pastDue: 0 };
    cur.oldestDays = Math.max(cur.oldestDays, inv.daysPastDue);
    cur.pastDue += inv.unpaid;
    worst.set(inv.entityId, cur);
  }
  const shouldHold = new Map([...worst].filter(([, w]) => w.oldestDays >= holdDays));

  const { data: existing, error } = await fetchAllRows<CustomerHoldRow>((from, to) => service
    .from('customer_holds').select('*').order('netsuite_customer_id').range(from, to));
  if (error) throw new Error(`reading customer_holds: ${error.message}`);
  const before = new Map(((existing || []) as CustomerHoldRow[]).map(r => [r.netsuite_customer_id, r]));

  // Local customer ids for newly held customers (badges on screens that only know customers.id).
  const needIds = [...shouldHold.keys()].filter(id => !before.get(id)?.customer_id);
  const localId = new Map<string, string>();
  for (let i = 0; i < needIds.length; i += 200) {
    const { data } = await service.from('customers').select('id, netsuite_id').in('netsuite_id', needIds.slice(i, i + 200));
    for (const c of (data || []) as any[]) localId.set(String(c.netsuite_id), c.id);
  }

  const now = new Date().toISOString();
  const writes: Record<string, any>[] = [];
  for (const [id, w] of shouldHold) {
    const prev = before.get(id);
    writes.push({
      netsuite_customer_id: id,
      customer_id: prev?.customer_id || localId.get(id) || null,
      customer_name: w.customer,
      auto_hold: true,
      auto_since: prev?.auto_hold ? prev.auto_since : now,
      oldest_days: w.oldestDays,
      past_due_amount: Math.round(w.pastDue * 100) / 100,
      manual: prev?.manual ?? null,
      manual_note: prev?.manual_note ?? null,
      manual_by: prev?.manual_by ?? null,
      manual_at: prev?.manual_at ?? null,
      updated_at: now,
    });
  }
  for (const [id, prev] of before) {
    if (shouldHold.has(id)) continue;
    const w = worst.get(id);
    if (!prev.auto_hold && prev.oldest_days === (w?.oldestDays ?? null)) continue;
    writes.push({
      ...prev,
      auto_hold: false,
      auto_since: null,
      oldest_days: w?.oldestDays ?? null,
      past_due_amount: w ? Math.round(w.pastDue * 100) / 100 : null,
      updated_at: now,
    });
  }
  for (let i = 0; i < writes.length; i += 500) {
    const { error: wErr } = await service.from('customer_holds').upsert(writes.slice(i, i + 500), { onConflict: 'netsuite_customer_id' });
    if (wErr) throw new Error(`writing customer_holds: ${wErr.message}`);
  }

  const { placed, lifted } = holdTransitions(before, new Map([...before.keys(), ...shouldHold.keys()].map(id => [id, { auto_hold: shouldHold.has(id) }])));
  const change = (id: string): HoldChange => {
    const w = worst.get(id);
    const prev = before.get(id);
    return {
      netsuiteId: id,
      customerId: prev?.customer_id || localId.get(id) || null,
      customer: w?.customer || prev?.customer_name || `Customer #${id}`,
      oldestDays: w?.oldestDays ?? 0,
      pastDue: w?.pastDue ?? 0,
    };
  };
  const onHold = [...new Set([...before.keys(), ...shouldHold.keys()])].filter(id => {
    const prev = before.get(id);
    return isOnHold({ auto_hold: shouldHold.has(id), manual: prev?.manual ?? null });
  }).length;
  return { placed: placed.map(change), lifted: lifted.map(change), onHold };
}
