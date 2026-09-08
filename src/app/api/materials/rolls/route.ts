import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { fetchAllRows } from '@/lib/fetch-all';
import {
  findLowStock, summarizeStock,
  type StockPolicy, type StockRoll,
} from '@/lib/roll-stock';

export const dynamic = 'force-dynamic';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * Material stock (R6-2): rolls of film and premask, cartridges of ink.
 * Staff-wide — the people who need to know whether a job can print are the
 * same people standing at the printer.
 */

const toRoll = (r: any): StockRoll => ({
  id: r.id,
  substrateId: r.substrate_id,
  materialName: r.material_name,
  kind: r.kind,
  unit: r.unit,
  widthIn: r.width_in != null ? Number(r.width_in) : null,
  remainingQty: Number(r.remaining_qty),
  receivedAt: r.received_at,
  status: r.status,
});

async function loadRolls(): Promise<StockRoll[]> {
  const { data, error } = await fetchAllRows<any>((from, to) => service
    .from('material_rolls')
    .select('id, substrate_id, material_name, kind, unit, width_in, remaining_qty, received_at, status')
    .eq('status', 'open')
    .order('received_at').order('id')
    .range(from, to));
  if (error) throw new Error(error.message);
  return (data || []).map(toRoll);
}

async function loadPolicies(): Promise<StockPolicy[]> {
  const { data } = await service
    .from('material_stock_settings')
    .select('kind, material_key, material_name, unit, reorder_at, order_up_to, vendor_name, item_number');
  return (data || []).map((p: any) => ({
    key: `${p.kind}:${p.material_key}`,
    kind: p.kind,
    materialName: p.material_name,
    unit: p.unit,
    reorderAt: p.reorder_at != null ? Number(p.reorder_at) : null,
    orderUpTo: p.order_up_to != null ? Number(p.order_up_to) : null,
    vendorName: p.vendor_name,
    itemNumber: p.item_number,
  }));
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  try {
    const [rolls, policies] = await Promise.all([loadRolls(), loadPolicies()]);
    const summaries = summarizeStock(rolls);

    // The graphics board asks for shortages alone — a small, cacheable
    // payload it can chip onto scheduled jobs.
    if (req.nextUrl.searchParams.get('shortagesOnly') === '1') {
      return NextResponse.json({ lowStock: findLowStock(summaries, policies) });
    }

    const { data: detail } = await fetchAllRows<any>((from, to) => service
      .from('material_rolls')
      .select('id, substrate_id, material_name, kind, unit, width_in, initial_qty, remaining_qty, cost, vendor_name, received_at, status, notes')
      .order('status').order('received_at', { ascending: false }).order('id')
      .range(from, to));

    return NextResponse.json({
      summaries,
      lowStock: findLowStock(summaries, policies),
      rolls: (detail || []).map((r: any) => ({
        id: r.id,
        substrateId: r.substrate_id,
        materialName: r.material_name,
        kind: r.kind,
        unit: r.unit,
        widthIn: r.width_in != null ? Number(r.width_in) : null,
        initialQty: Number(r.initial_qty),
        remainingQty: Number(r.remaining_qty),
        cost: r.cost != null ? Number(r.cost) : null,
        vendorName: r.vendor_name,
        receivedAt: r.received_at,
        status: r.status,
        notes: r.notes,
      })),
    });
  } catch (e: any) {
    console.error('material stock read failed:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load stock' }, { status: 500 });
  }
}

const ReceiveSchema = z.object({
  materialName: z.string().min(1).max(200),
  kind: z.enum(['film', 'premask', 'ink']),
  substrateId: z.string().uuid().nullable().optional(),
  widthIn: z.number().min(0).max(200).nullable().optional(),
  /** Feet for a roll, cartridge count for ink. */
  quantity: z.number().min(0.1).max(100000),
  /** How many identical rolls arrived — each becomes its own row. */
  rolls: z.number().int().min(1).max(50).optional(),
  cost: z.number().min(0).max(1000000).nullable().optional(),
  vendorName: z.string().max(200).nullable().optional(),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(300).optional(),
});

/** Receive stock. Each physical roll is its own row — that is what makes
 *  "the longest single roll" answerable, and remnants track themselves. */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, ReceiveSchema);
  if (parsed.error) return parsed.error;
  const b = parsed.data;
  const unit = b.kind === 'ink' ? 'cartridge' : 'ft';
  const count = b.rolls || 1;

  const rows = Array.from({ length: count }, () => ({
    substrate_id: b.substrateId ?? null,
    material_name: b.materialName.trim(),
    kind: b.kind,
    unit,
    width_in: b.kind === 'ink' ? null : (b.widthIn ?? null),
    initial_qty: b.quantity,
    remaining_qty: b.quantity,
    cost: b.cost ?? null,
    vendor_name: b.vendorName?.trim() || null,
    received_at: b.receivedAt || new Date().toISOString().slice(0, 10),
    notes: b.notes?.trim() || null,
    created_by: auth.user.id,
  }));

  const { data, error } = await service.from('material_rolls').insert(rows).select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, received: data?.length || 0 });
}

const AdjustSchema = z.object({
  id: z.string().uuid(),
  /** Set the remaining quantity (a physical recount), or scrap the roll. */
  remainingQty: z.number().min(0).max(100000).optional(),
  status: z.enum(['open', 'depleted', 'scrapped']).optional(),
  notes: z.string().max(300).optional(),
});

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, AdjustSchema);
  if (parsed.error) return parsed.error;
  const { id, remainingQty, status, notes } = parsed.data;

  const { data: existing } = await service
    .from('material_rolls').select('initial_qty').eq('id', id).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Roll not found' }, { status: 404 });
  if (remainingQty != null && remainingQty > Number(existing.initial_qty)) {
    return NextResponse.json({ error: 'A recount cannot exceed what the roll started with — receive a new roll instead.' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (remainingQty != null) {
    patch.remaining_qty = remainingQty;
    // A recount to zero closes the roll without a second call.
    if (remainingQty === 0 && !status) patch.status = 'depleted';
  }
  if (status) patch.status = status;
  if (notes !== undefined) patch.notes = notes.trim() || null;

  const { error } = await service.from('material_rolls').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
