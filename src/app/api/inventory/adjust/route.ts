import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase-service';
import { requireAdmin } from '@/lib/api-auth';
import { logAudit } from '@/lib/audit';
import { ADJUST_REASONS, adjustInventory, adjustLocationId, liveLocationStock } from '@/lib/inventory-adjust';
import { readSwitch } from '@/lib/books/switches';
import {
  ASK_COLUMNS, NOTE_MAX, OPEN_STATUSES, askFromRow, askPayload, openText, workOutAsk, type AdjustmentAsk,
} from '@/lib/inventory-adjust-approvals';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/inventory/adjust?netsuiteId=123
 *   NetSuite's live O'Fallon on hand / available for the Adjust pop-up, the
 *   part's recent adjustments, whether adjustments wait for approval, and the
 *   part's last few asked for.
 *
 * POST /api/inventory/adjust { netsuiteId, mode: 'delta'|'count', qty, reason, note, askId? }
 *   Posts a NetSuite Inventory Adjustment (src/lib/inventory-adjust.ts). Once
 *   approving adjustments is switched on (Books → Switches, Books part 63,
 *   src/lib/inventory-adjust-approvals.ts), it's asked for instead, under
 *   askId, and a super admin who didn't ask approves it on Adjustments to
 *   approve (/api/inventory/adjust/approvals). Either way nothing's posted
 *   for a part with one waiting, and a switch or list that can't be read
 *   stops it.
 *
 * Admins only (Craig 2026-10-30: admins plus Jessie, who is an admin).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const netsuiteId = req.nextUrl.searchParams.get('netsuiteId') || '';
  if (!/^\d+$/.test(netsuiteId)) return NextResponse.json({ error: 'netsuiteId required' }, { status: 400 });

  const service = createServiceClient();
  const { data: history } = await service
    .from('inventory_adjustments')
    .select('id, change, reason, note, netsuite_adjustment_number, created_by_name, created_at')
    .eq('netsuite_item_id', netsuiteId)
    .order('created_at', { ascending: false })
    .limit(10);
  const approvals = await approvalsFor(service, netsuiteId, auth.user!.id);

  try {
    const stock = await liveLocationStock(netsuiteId, await adjustLocationId());
    return NextResponse.json({ ...stock, history: history || [], ...approvals });
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't read the current count from NetSuite: ${e.message}`, history: history || [], ...approvals }, { status: 502 });
  }
}

/** Whether Adjust asks for approval, or null with why when that can't be told, and the part's last five asked for. */
async function approvalsFor(service: SupabaseClient, netsuiteId: string, me: string) {
  let approvals: boolean | null = null;
  let approvalsError: string | null = null;
  try {
    approvals = await readSwitch(service, 'adjustment_approvals');
  } catch (e: any) {
    approvalsError = `Couldn't tell whether adjustments need approval, so none can be made now: ${e.message}`;
  }
  const { data, error } = await service
    .from('inventory_adjustment_asks')
    .select(ASK_COLUMNS)
    .eq('netsuite_item_id', netsuiteId)
    .order('asked_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(5);
  if (error) {
    approvals = null;
    approvalsError ??= `Couldn't read the adjustments asked for, so none can be made now: ${error.message}`;
  }
  const asks = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({ ...askFromRow(r), mine: r.asked_by === me }));
  return { approvals, approvalsError, asks };
}

/** The part's adjustment asked for and not decided yet, if it has one. Throws when the list can't be read. */
async function openAsk(service: SupabaseClient, netsuiteId: string): Promise<AdjustmentAsk | null> {
  const { data, error } = await service
    .from('inventory_adjustment_asks')
    .select(ASK_COLUMNS)
    .eq('netsuite_item_id', netsuiteId)
    .in('status', [...OPEN_STATUSES])
    .order('asked_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data as unknown as Array<Record<string, unknown>> | null)?.[0];
  return row ? askFromRow(row) : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const service = createServiceClient();
  const netsuiteId = String(body?.netsuiteId ?? '');
  if (!/^\d+$/.test(netsuiteId)) return NextResponse.json({ error: 'This part has no NetSuite id.' }, { status: 400 });
  const note = typeof body?.note === 'string' ? body.note.slice(0, NOTE_MAX) : null;

  // Approving adjustments: switched on, Adjust asks instead of posting; and while one's open for the part, nothing
  // else is posted for it, switched on or off.
  let approvals: boolean;
  let open: AdjustmentAsk | null;
  try {
    approvals = await readSwitch(service, 'adjustment_approvals');
    open = await openAsk(service, netsuiteId);
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't tell whether adjustments need approval, so nothing was posted: ${e.message}` }, { status: 503 });
  }
  if (open) return NextResponse.json({ error: openText(open), open: { ...open, mine: open.askedBy === auth.user!.id } }, { status: 409 });
  if (approvals) {
    return askFor(service, {
      netsuiteId, mode: body?.mode, qty: Number(body?.qty), reason: String(body?.reason ?? ''), note,
      askId: typeof body?.askId === 'string' && UUID.test(body.askId) ? body.askId : randomUUID(),
      userId: auth.user!.id, userName: auth.profile?.full_name || null,
    });
  }

  const result = await adjustInventory(service, {
    netsuiteId,
    mode: body?.mode,
    qty: Number(body?.qty),
    reason: String(body?.reason ?? ''),
    note,
    userId: auth.user!.id,
    userName: auth.profile?.full_name || null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}

/**
 * Asks for an adjustment: Adjust's own checks, the change worked out against NetSuite's live count now, and kept to
 * wait for approval. Nothing goes to NetSuite.
 */
async function askFor(service: SupabaseClient, a: {
  netsuiteId: string;
  mode: unknown;
  qty: number;
  reason: string;
  note: string | null;
  askId: string;
  userId: string;
  userName: string | null;
}): Promise<NextResponse> {
  if (!(ADJUST_REASONS as readonly string[]).includes(a.reason)) return NextResponse.json({ error: 'Pick a reason.' }, { status: 400 });
  if (a.mode !== 'delta' && a.mode !== 'count') return NextResponse.json({ error: 'Unknown entry type.' }, { status: 400 });
  const mode = a.mode;

  const { data: part, error: partError } = await service
    .from('netsuite_parts')
    .select('id, netsuite_id, item_number, item_type')
    .eq('netsuite_id', a.netsuiteId)
    .maybeSingle();
  if (partError) return NextResponse.json({ error: `Couldn't read the parts list: ${partError.message}` }, { status: 500 });
  if (!part) return NextResponse.json({ error: "That part isn't in FleetSuite's parts list." }, { status: 404 });
  if (part.item_type && part.item_type !== 'InvtPart') {
    return NextResponse.json({ error: `${part.item_number} isn't an inventory item in NetSuite, so it has no stock to adjust.` }, { status: 400 });
  }

  let locationId: string;
  let before: { onHand: number; available: number };
  try {
    locationId = await adjustLocationId();
    before = await liveLocationStock(a.netsuiteId, locationId);
  } catch (e: any) {
    return NextResponse.json({ error: `Couldn't read the current count from NetSuite: ${e.message}` }, { status: 502 });
  }
  const calc = workOutAsk(mode, a.qty, before.onHand);
  if ('error' in calc) return NextResponse.json({ error: calc.error }, { status: 400 });

  const note = (a.note || '').trim() || null;
  const { data, error } = await service.rpc('inventory_adjustment_ask', {
    p: askPayload({
      id: a.askId, by: a.userId, byName: a.userName, partId: part.id, netsuiteItemId: a.netsuiteId, itemNumber: part.item_number,
      locationId, mode, qty: a.qty, onHand: before.onHand, reason: a.reason, note,
    }),
  });
  if (error) return NextResponse.json({ error: `Couldn't keep the adjustment asked for: ${error.message}` }, { status: 500 });
  const answer = data as { state: 'asked' | 'same' | 'waiting'; ask: Record<string, unknown> };
  const ask = askFromRow(answer.ask);
  if (answer.state === 'waiting') return NextResponse.json({ error: openText(ask), open: { ...ask, mine: ask.askedBy === a.userId } }, { status: 409 });
  if (answer.state === 'asked') {
    await logAudit(service, {
      actorId: a.userId,
      table: 'inventory_adjustment_asks',
      recordId: ask.id,
      action: 'ask',
      detail: { item_number: ask.itemNumber, mode: ask.mode, change: ask.change, reason: ask.reason },
    });
  }
  return NextResponse.json({ asked: true, ask, onHand: before.onHand, available: before.available });
}
