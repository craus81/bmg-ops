import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { createInventoryTransfer, findInventoryTransfer, getLocationOnHand } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { readCompanies } from '@/lib/books/snap-a-bill';
import { isIsoDate } from '@/lib/books/journal';
import { logAudit } from '@/lib/audit';
import { partSearchOrFilter } from '@/lib/loose-search';
import {
  MAX_LINES, MAX_QUANTITY, MEMO_MAX, QUANTITY_PLACES, hasTooManyPlaces, keepsStock, keptLines, linesToKeep, netsuiteTransfer, quantityText,
  transferExternalId, workOutTransfer,
  type KeptLine, type TransferCompany, type TransferItem, type TransferStatus, type WorkedTransfer,
} from '@/lib/inventory-transfers';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Inventory transfers are switched off until ${SWITCH_ON_DATE_TEXT}.`;

/** How long a press can say it's being made before FleetSuite asks NetSuite what became of it. */
const STALE_MS = 5 * 60 * 1000;

type Auth = Awaited<ReturnType<typeof requireAdmin>>;

interface Gate {
  auth: Auth;
  on: boolean;
  superAdmin: boolean;
  error?: NextResponse;
}

/**
 * Admins once inventory transfers are switched on (Books → Switches), as Inventory Adjust; until then only super
 * admins, who can make and save transfers to see what they'd send, and nothing is moved in NetSuite.
 */
async function access(req: NextRequest): Promise<Gate> {
  const auth = await requireAdmin(req);
  if (auth.error) return { auth, on: false, superAdmin: false, error: auth.error };
  const on = await switchIsOn(service, 'inventory_transfers');
  const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
  if (!on && !superAdmin) {
    return { auth, on, superAdmin, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on, superAdmin };
}

async function readCompaniesWithLocations(): Promise<TransferCompany[]> {
  return (await readCompanies(service)).map((c) => ({ code: c.code, name: c.name, subsidiaryId: c.subsidiaryId, locations: c.locations }));
}

const PART_COLUMNS = 'netsuite_id, item_number, display_name, item_type, is_active';
interface PartRow { netsuite_id: string; item_number: string; display_name: string | null; item_type: string | null; is_active: boolean | null }
const itemOf = (p: PartRow): TransferItem => ({
  id: String(p.netsuite_id), number: p.item_number, name: p.display_name, type: p.item_type, active: p.is_active !== false,
});

/** The items FleetSuite's parts list has under these NetSuite ids. */
async function readItems(ids: string[]): Promise<Map<string, TransferItem>> {
  const wanted = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
  const items = new Map<string, TransferItem>();
  if (wanted.length === 0) return items;
  const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS).in('netsuite_id', wanted);
  if (error) throw new Error(`couldn't read the parts list (${error.message})`);
  for (const p of (data ?? []) as PartRow[]) items.set(String(p.netsuite_id), itemOf(p));
  return items;
}

const TRANSFER_COLUMNS = 'id, company, tran_date, from_location_id, to_location_id, memo, lines, status, created_by, created_at, '
  + 'updated_by, updated_at, sent_by, sent_at, netsuite_transfer_id, netsuite_number, error';

interface TransferRow {
  id: string;
  company: string;
  tran_date: string;
  from_location_id: string | null;
  to_location_id: string | null;
  memo: string | null;
  lines: KeptLine[] | null;
  status: TransferStatus;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  sent_by: string | null;
  sent_at: string | null;
  netsuite_transfer_id: string | null;
  netsuite_number: string | null;
  error: string | null;
}

/** The most transfers the page lists that aren't made, and that are. */
const OPEN_LIMIT = 200;
const MADE_LIMIT = 25;
/** The most items a search finds. */
const FOUND_LIMIT = 20;

const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** NetSuite's own count of these items at each location, as the stock copy last read it (migration 401). */
async function readCounts(itemIds: string[]): Promise<{ counts: Record<string, Record<string, number>>; readAt: string | null }> {
  const counts: Record<string, Record<string, number>> = {};
  if (itemIds.length === 0) return { counts, readAt: null };
  const { data, error } = await service.from('gl_netsuite_stock_counts').select('item_id, location_id, quantity, read_at').in('item_id', itemIds);
  if (error) throw new Error(`couldn't read NetSuite's counts (${error.message})`);
  let readAt: string | null = null;
  for (const r of (data ?? []) as Array<{ item_id: string; location_id: string | null; quantity: number | string; read_at: string }>) {
    if (!r.location_id) continue;
    (counts[r.item_id] ??= {})[r.location_id] = Number(r.quantity);
    if (!readAt || r.read_at > readAt) readAt = r.read_at;
  }
  return { counts, readAt };
}

/**
 * GET /api/inventory-transfers?status=1 — whether inventory transfers are on, and whether this person can use them.
 * GET /api/inventory-transfers?q=<text> — the inventory items whose number or name has it, for a line.
 * GET /api/inventory-transfers[?id=<transfer>] — the companies and their locations, the transfers not made yet, the
 * last made, and the one asked for, with the items on them and NetSuite's count of each at each location.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'inventory_transfers');
    const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
    return NextResponse.json({ on, canUse: on || superAdmin });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const q = params.get('q');
    if (q !== null) return await search(q);

    const id = params.get('id');
    const [companies, openRes, madeRes, oneRes] = await Promise.all([
      readCompaniesWithLocations(),
      service.from('inventory_transfers').select(TRANSFER_COLUMNS).neq('status', 'made')
        .order('updated_at', { ascending: false }).order('id', { ascending: true }).limit(OPEN_LIMIT),
      service.from('inventory_transfers').select(TRANSFER_COLUMNS).eq('status', 'made')
        .order('sent_at', { ascending: false }).order('id', { ascending: true }).limit(MADE_LIMIT),
      isUuid(id)
        ? service.from('inventory_transfers').select(TRANSFER_COLUMNS).eq('id', id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (openRes.error) throw new Error(openRes.error.message);
    if (madeRes.error) throw new Error(madeRes.error.message);
    if (oneRes.error) throw new Error(oneRes.error.message);
    const rows = new Map<string, TransferRow>();
    for (const r of [...(openRes.data ?? []), ...(madeRes.data ?? []), ...(oneRes.data ? [oneRes.data] : [])] as unknown as TransferRow[]) rows.set(r.id, r);

    const itemIds = [...new Set([...rows.values()].flatMap((r) => keptLines(r.lines).map((l) => l.itemId)).filter((i): i is string => !!i))];
    const people = [...new Set([...rows.values()].flatMap((r) => [r.created_by, r.updated_by, r.sent_by]).filter((p): p is string => !!p))];
    const [items, counted, profiles] = await Promise.all([
      readItems(itemIds),
      readCounts(itemIds),
      people.length
        ? service.from('profiles').select('id, full_name').in('id', people)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (profiles.error) throw new Error(profiles.error.message);
    const names = new Map(((profiles.data ?? []) as Array<{ id: string; full_name: string | null }>).map((p) => [p.id, p.full_name]));
    const name = (p: string | null) => (p ? names.get(p) || 'Someone' : null);

    return NextResponse.json({
      companies,
      transfers: [...rows.values()].map((r) => ({
        id: r.id,
        company: r.company,
        date: String(r.tran_date).slice(0, 10),
        fromLocationId: r.from_location_id,
        toLocationId: r.to_location_id,
        memo: r.memo,
        lines: keptLines(r.lines).map((l, i) => ({ ...l, itemNumber: r.lines?.[i]?.item_number ?? null })),
        status: r.status,
        createdBy: name(r.created_by),
        createdById: r.created_by,
        createdAt: r.created_at,
        updatedBy: name(r.updated_by),
        updatedAt: r.updated_at,
        sentBy: name(r.sent_by),
        sentAt: r.sent_at,
        transferId: r.netsuite_transfer_id,
        number: r.netsuite_number,
        error: r.error,
      })),
      items: Object.fromEntries(items),
      counts: counted.counts,
      countsReadAt: counted.readAt,
      me: gate.auth.user!.id,
      superAdmin: gate.superAdmin,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can make and save transfers to see what they'd send; nothing is moved in NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

/**
 * The active parts NetSuite keeps stock of whose number, name or description has the text, by the search rule every
 * search box uses (src/lib/loose-search.ts: part numbers with or without their dashes), with NetSuite's count of each
 * at each location.
 */
async function search(q: string) {
  const filter = q.trim().length < 2 ? null : partSearchOrFilter(['item_number'], ['display_name', 'description'], q.slice(0, 60));
  if (!filter) return NextResponse.json({ items: [], counts: {} });
  const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS)
    .eq('is_active', true)
    .not('netsuite_id', 'is', null)
    .or(filter)
    .order('item_number', { ascending: true })
    .order('netsuite_id', { ascending: true })
    .limit(FOUND_LIMIT * 3);
  if (error) throw new Error(`couldn't search the parts list (${error.message})`);
  const items = ((data ?? []) as PartRow[]).map(itemOf).filter(keepsStock).slice(0, FOUND_LIMIT);
  const counted = await readCounts(items.map((i) => i.id));
  return NextResponse.json({ items, counts: counted.counts, countsReadAt: counted.readAt });
}

const locationId = z.string().regex(/^\d{1,20}$/);
const stamp = z.string().min(1).max(60);
const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    // Made by the page when the transfer is started: it's the transfer's External ID in NetSuite.
    id: z.string().uuid(),
    company: z.string().min(1).max(12),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fromLocationId: locationId.nullable(),
    toLocationId: locationId.nullable(),
    memo: z.string().max(MEMO_MAX).nullable().optional(),
    lines: z.array(z.object({
      itemId: z.string().regex(/^\d{1,20}$/).nullable(),
      quantity: z.number().min(0).max(MAX_QUANTITY).refine((q) => !hasTooManyPlaces(q), `A quantity takes ${QUANTITY_PLACES} places at most.`),
    })).max(MAX_LINES),
  }),
  z.object({ action: z.literal('delete'), id: z.string().uuid() }),
  // updatedAt: the draft as the sender saw it.
  z.object({ action: z.literal('move'), id: z.string().uuid(), updatedAt: stamp }),
]);
type Body = z.infer<typeof Schema>;

const WHERE_IT_IS: Record<string, string> = {
  draft: "It's a draft.",
  sending: "It's being made in NetSuite.",
  made: "It's in NetSuite already.",
  gone: "There's no such transfer: it was deleted.",
};
const whereItIs = (status: string) => WHERE_IT_IS[status] ?? `It's ${status}.`;

async function readTransfer(id: string): Promise<TransferRow | null> {
  const { data, error } = await service.from('inventory_transfers').select(TRANSFER_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TransferRow | null) ?? null;
}

/**
 * POST /api/inventory-transfers — { action: 'save' } saves a draft, new or changed; 'delete' deletes a draft; 'move'
 * makes the transfer in NetSuite from its lines as they're kept, once. Moving is refused while inventory transfers
 * are switched off, for everyone. Nothing here alerts anyone, as Inventory Adjust doesn't.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  if (body.action === 'move' && !gate.on) {
    return NextResponse.json({ error: `${OFF} It was saved, and nothing was moved in NetSuite.`, switchedOff: true }, { status: 403 });
  }

  try {
    switch (body.action) {
      case 'save': return await save(body, gate);
      case 'delete': return await remove(body, gate);
      case 'move': return await move(body, gate);
    }
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

async function save(body: Extract<Body, { action: 'save' }>, { auth }: Gate) {
  const companies = await readCompaniesWithLocations();
  const company = companies.find((c) => c.code === body.company);
  if (!company) return NextResponse.json({ error: `There's no company ${body.company} in Books.` }, { status: 400 });
  if (!isIsoDate(body.date)) return NextResponse.json({ error: `${body.date} isn't a day on the calendar.` }, { status: 400 });

  const items = await readItems(body.lines.map((l) => l.itemId ?? ''));
  const { data, error } = await service.rpc('inventory_transfer_save', {
    p: {
      id: body.id, company: company.code, tran_date: body.date, from_location_id: body.fromLocationId ?? '', to_location_id: body.toLocationId ?? '',
      memo: body.memo ?? '', by: auth.user!.id, lines: linesToKeep(body.lines, items),
    },
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const result = data as { saved: boolean; status: string; updated_at?: string };
  if (!result.saved) return NextResponse.json({ error: `It wasn't saved. ${whereItIs(result.status)}`, status: result.status }, { status: 409 });
  return NextResponse.json({ success: true, updatedAt: result.updated_at });
}

async function remove(body: Extract<Body, { action: 'delete' }>, { auth, superAdmin }: Gate) {
  const row = await readTransfer(body.id);
  if (!row) return NextResponse.json({ success: true, already: true });
  if (row.status !== 'draft') return NextResponse.json({ error: `Only a draft can be deleted. ${whereItIs(row.status)}` }, { status: 409 });
  if (!superAdmin && row.created_by !== auth.user!.id) {
    return NextResponse.json({ error: 'Only whoever started a draft, or a super admin, can delete it.' }, { status: 403 });
  }
  const { data, error } = await service.from('inventory_transfers').delete().eq('id', body.id).eq('status', 'draft').select('id');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if ((data ?? []).length === 0) return NextResponse.json({ error: "It wasn't deleted: Move was pressed on it just now." }, { status: 409 });
  await logAudit(service, {
    actorId: auth.user!.id, table: 'inventory_transfers', recordId: body.id, action: 'delete',
    detail: { company: row.company, date: row.tran_date, from: row.from_location_id, to: row.to_location_id, memo: row.memo, lines: (row.lines ?? []).length },
  });
  return NextResponse.json({ success: true });
}

async function letGo(id: string, error: string) {
  await service.rpc('inventory_transfer_let_go', { p: { id, error } });
}

const locationName = (company: TransferCompany | undefined, id: string) => company?.locations.find((l) => l.id === id)?.name ?? `location ${id}`;

async function move(body: Extract<Body, { action: 'move' }>, gate: Gate): Promise<NextResponse> {
  const { auth } = gate;
  const { data, error } = await service.rpc('inventory_transfer_claim', { p: { id: body.id, by: auth.user!.id, updated_at: body.updatedAt } });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const claim = data as {
    state: 'made' | 'moving' | 'claimed' | 'changed' | 'gone';
    netsuite_transfer_id?: string; netsuite_number?: string | null; transfer?: TransferRow;
  };

  if (claim.state === 'made') {
    return NextResponse.json({ success: true, already: true, transferId: claim.netsuite_transfer_id, number: claim.netsuite_number ?? null });
  }
  if (claim.state === 'gone') return NextResponse.json({ error: whereItIs('gone') }, { status: 404 });
  if (claim.state === 'changed') {
    return NextResponse.json({ error: 'It was changed since you opened it. Reload and check it, then press Move again. Nothing was moved.' }, { status: 409 });
  }

  const transfer = claim.transfer!;
  const companies = await readCompaniesWithLocations();
  const company = companies.find((c) => c.code === transfer.company);
  const lines = keptLines(transfer.lines);
  const items = await readItems(lines.map((l) => l.itemId ?? ''));
  const worked = workOutTransfer(
    {
      date: String(transfer.tran_date).slice(0, 10), fromLocationId: transfer.from_location_id, toLocationId: transfer.to_location_id,
      memo: transfer.memo, lines,
    },
    { company: company ?? null, items },
  );
  const externalId = transferExternalId(transfer.id);

  if (claim.state === 'moving') {
    const age = Date.now() - Date.parse(transfer.sent_at ?? '');
    if (!(age > STALE_MS)) {
      return NextResponse.json({ error: "It's being made in NetSuite now. Don't press again: reload in a minute to see it." }, { status: 409 });
    }
    // Being made for a while: NetSuite made it or never will. Ask it.
    let there: Awaited<ReturnType<typeof findInventoryTransfer>>;
    try {
      there = await findInventoryTransfer(externalId);
    } catch (err: any) {
      return NextResponse.json({ error: `Couldn't ask NetSuite what became of this transfer (${err?.message || err}). Try again.` }, { status: 502 });
    }
    if (there) return finish(transfer, worked, company, gate, there.transferId, there.number || null, true);
    const why = "NetSuite has no transfer from this press, so it's a draft again.";
    await letGo(transfer.id, why);
    return NextResponse.json({ error: why }, { status: 409 });
  }

  // Freshly claimed: check it as it's kept, then make it.
  if (worked.problems.length > 0 || !company?.subsidiaryId) {
    const why = worked.problems.join(' ') || 'Its company has no NetSuite subsidiary in Books.';
    await letGo(transfer.id, why);
    return NextResponse.json({ error: `${why} Nothing was moved.`, problems: worked.problems }, { status: 400 });
  }

  // NetSuite never takes two transfers under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findInventoryTransfer(externalId);
    if (there) return finish(transfer, worked, company, gate, there.transferId, there.number || null, true);
  } catch (err: any) {
    const why = `Couldn't check NetSuite for this transfer (${err?.message || err}).`;
    await letGo(transfer.id, why);
    return NextResponse.json({ error: `${why} Nothing was moved. Try again.` }, { status: 502 });
  }

  // Never move more than NetSuite has where it's moving from.
  const from = locationName(company, worked.fromLocationId);
  let onHand: Map<string, number>;
  try {
    onHand = await getLocationOnHand(worked.fromLocationId, worked.lines.map((l) => l.itemId));
  } catch (err: any) {
    const why = `Couldn't read NetSuite's count at ${from} (${err?.message || err}).`;
    await letGo(transfer.id, why);
    return NextResponse.json({ error: `${why} Nothing was moved. Try again.` }, { status: 502 });
  }
  const short = worked.lines.filter((l) => (onHand.get(l.itemId) ?? 0) < l.quantity);
  if (short.length > 0) {
    const why = short.map((l) => `NetSuite has ${quantityText(onHand.get(l.itemId) ?? 0)} of ${l.itemNumber} at ${from} now, fewer than the ${quantityText(l.quantity)} moving.`).join(' ');
    await letGo(transfer.id, why);
    return NextResponse.json({ error: `${why} Nothing was moved.` }, { status: 409 });
  }

  const result = await createInventoryTransfer(netsuiteTransfer(worked, company.subsidiaryId, transfer.id));
  if (!result.success || !result.transferId) {
    const why = result.error || "NetSuite didn't make the transfer.";
    if (result.unsure) {
      // NetSuite may have made it: keep it held until it's asked again.
      await service.from('inventory_transfers').update({ error: why.slice(0, 2000) }).eq('id', transfer.id).eq('status', 'sending');
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite made it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    await letGo(transfer.id, why);
    return NextResponse.json({ error: why }, { status: 502 });
  }

  let number: string | null = null;
  try {
    number = (await findInventoryTransfer(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return finish(transfer, worked, company, gate, result.transferId, number, false);
}

/** The transfer is in NetSuite: keep its id on the transfer, and say so. */
async function finish(
  transfer: TransferRow, worked: WorkedTransfer, company: TransferCompany | undefined, { auth }: Gate,
  transferId: string, number: string | null, already: boolean,
) {
  const { error } = await service.rpc('inventory_transfer_made', { p: { id: transfer.id, netsuite_transfer_id: transferId, netsuite_number: number } });
  if (error) console.error(`[inventory-transfers] transfer ${transfer.id} made as NetSuite transfer ${transferId} but not kept: ${error.message}`);

  await logAudit(service, {
    actorId: auth.user!.id,
    table: 'inventory_transfers',
    recordId: transfer.id,
    action: 'move',
    detail: {
      netsuite_transfer_id: transferId, company: transfer.company, date: worked.date,
      from: locationName(company, worked.fromLocationId), to: locationName(company, worked.toLocationId),
      lines: worked.lines.map((l) => `${quantityText(l.quantity)} × ${l.itemNumber}`), found_in_netsuite: already,
    },
  });

  return NextResponse.json({ success: true, ...(already ? { already: true } : {}), transferId, number });
}
