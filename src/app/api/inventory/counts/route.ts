import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { fetchAllRows } from '@/lib/fetch-all';
import { partSearchOrFilter } from '@/lib/loose-search';
import { switchIsOn } from '@/lib/books/switches';
import { readCompanies } from '@/lib/books/snap-a-bill';
import { isIsoDate } from '@/lib/books/journal';
import { chicagoDate } from '@/lib/books/own-invoices';
import { createCountAdjustment, findCountAdjustment, getInventoryAdjustmentAccountId, getLocationOnHand } from '@/lib/netsuite';
import { QUANTITY_PLACES, hasTooManyPlaces, keepsStock, quantityText, roundQuantity } from '@/lib/inventory-transfers';
import {
  COUNTED_MAX, COUNT_COLUMNS, LINE_COLUMNS, MAX_LINES, NOT_NOW_TEXT, OPEN_STATUSES, WHY_MAX, averageCosts, blockedFromRows, blockedText,
  byItemNumber, countExternalId, countFromRow, countLabel, countMemo, countWhat, defaultLocationId, lineFromRow, needsAsking,
  type CountKind, type CountStatus, type StockCount,
} from '@/lib/stock-counts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

/**
 * Counts (Books part 69, migration 499, src/lib/stock-counts.ts, pages /admin/inventory/counts, docs/books.md
 * "Counts"): a location's stock counted, all of it or a part, and what differs from NetSuite asked for as one, which
 * a super admin who didn't ask approves as one NetSuite Inventory Adjustment.
 *
 * GET ?status=1 — whether counts are on, whether the caller can use them, and how many are open, for the Inventory
 *     page's link.
 * GET ?q=<text> — the items NetSuite keeps stock of whose number or name has it, to pick or add, without counts.
 * GET ?preview=1&location=&kind=all|search&q= — what Start would put on a count, without reading NetSuite.
 * GET — the locations, the open counts with how far each is counted, and the last 30 done or stopped.
 * GET ?id=<count> — one count with its items, the ones held back, and NetSuite's average cost of each for whoever
 *     sees money.
 * POST { action: 'start' | 'add' | 'save' | 'ask' | 'finish' | 'cancel' | 'withdraw' | 'turn_down' | 'approve' | 'check' }.
 *
 * Admins once counts are switched on in Books → Switches; until then only super admins, who can count and ask to see
 * what a count would post, and nothing goes to NetSuite. Nobody is alerted (Craig, 2026-10-30: no alerts for
 * adjustments).
 */

const OFF = 'Counts are switched off until they start in the third quarter of 2027.';

type Auth = Awaited<ReturnType<typeof requireAdmin>>;
type Row = Record<string, unknown>;

interface Gate {
  auth: Auth;
  on: boolean;
  superAdmin: boolean;
  me: string;
  myName: string | null;
  error?: NextResponse;
}

/** Admins once counts are on (Books → Switches), as Inventory Adjust; until then only super admins. */
async function access(req: NextRequest): Promise<Gate> {
  const auth = await requireAdmin(req);
  const me = auth.user?.id ?? '';
  const myName = (auth.profile as { full_name?: string | null } | null)?.full_name || null;
  if (auth.error) return { auth, on: false, superAdmin: false, me, myName, error: auth.error };
  const on = await switchIsOn(service, 'stock_counts');
  const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
  if (!on && !superAdmin) {
    return { auth, on, superAdmin, me, myName, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on, superAdmin, me, myName };
}

/** A location stock is counted at, with the NetSuite subsidiary its company is. */
interface Place { id: string; name: string; subsidiaryId: string | null }

async function readPlaces(): Promise<Place[]> {
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const c of await readCompanies(service)) {
    for (const l of c.locations) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      places.push({ id: l.id, name: l.name, subsidiaryId: c.subsidiaryId });
    }
  }
  return places.sort((a, b) => a.name.localeCompare(b.name));
}

/** An item to count, as FleetSuite's parts list (or, failing that, Books' copy of NetSuite's items) knows it. */
interface Item { netsuiteItemId: string; partId: string | null; itemNumber: string; displayName: string | null; type: string | null }

const PART_COLUMNS = 'id, netsuite_id, item_number, display_name, item_type, is_active';
interface PartRow { id: string; netsuite_id: string | number; item_number: string; display_name: string | null; item_type: string | null; is_active: boolean | null }
const itemOf = (p: PartRow): Item => ({
  netsuiteItemId: String(p.netsuite_id), partId: p.id ?? null, itemNumber: p.item_number, displayName: p.display_name, type: p.item_type,
});

const CHUNK = 200;
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));
const isUuid = (s: string | null): s is string => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The items under these NetSuite ids: from the parts list, an active row first, then Books' copy of NetSuite's items. */
async function readItems(ids: string[]): Promise<Map<string, Item>> {
  const wanted = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
  const items = new Map<string, Item>();
  for (const part of chunks(wanted)) {
    const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS).in('netsuite_id', part);
    if (error) throw new Error(`couldn't read the parts list (${error.message})`);
    const rows = ((data ?? []) as PartRow[]).sort((a, b) => Number(b.is_active !== false) - Number(a.is_active !== false));
    for (const p of rows) if (!items.has(String(p.netsuite_id))) items.set(String(p.netsuite_id), itemOf(p));
  }
  const missing = wanted.filter((id) => !items.has(id));
  for (const part of chunks(missing)) {
    const { data, error } = await service.from('gl_netsuite_lists').select('netsuite_id, name, details').eq('kind', 'item').in('netsuite_id', part);
    if (error) throw new Error(`couldn't read NetSuite's items (${error.message})`);
    for (const r of (data ?? []) as Array<{ netsuite_id: string; name: string | null; details: { display_name?: string | null } | null }>) {
      if (!r.name?.trim()) continue;
      items.set(String(r.netsuite_id), {
        netsuiteItemId: String(r.netsuite_id), partId: null, itemNumber: r.name.trim(), displayName: r.details?.display_name ?? null, type: null,
      });
    }
  }
  return items;
}

/** An item on an open count at the location, with that count's number. */
interface Taken { netsuite_item_id: string; item_number: string; count_id?: string; number: number }

/** The items on open counts at a location. */
async function readTaken(locationId: string): Promise<Map<string, Taken>> {
  const { data: lines, error } = await fetchAllRows<{ netsuite_item_id: string; item_number: string; count_id: string }>((from, to) => service
    .from('stock_count_lines')
    .select('netsuite_item_id, item_number, count_id')
    .eq('location_id', locationId)
    .eq('is_open', true)
    .order('count_id', { ascending: true })
    .order('netsuite_item_id', { ascending: true })
    .range(from, to));
  if (error) throw new Error(`couldn't read the open counts (${error.message})`);
  const ids = [...new Set(lines.map((l) => l.count_id))];
  const numbers = new Map<string, number>();
  if (ids.length) {
    const counts = await service.from('stock_counts').select('id, number').in('id', ids);
    if (counts.error) throw new Error(`couldn't read the open counts (${counts.error.message})`);
    for (const c of (counts.data ?? []) as Array<{ id: string; number: number | string }>) numbers.set(c.id, Number(c.number));
  }
  return new Map(lines.map((l) => [l.netsuite_item_id, { ...l, number: numbers.get(l.count_id) ?? 0 }]));
}

/** "HITCH-2 and BALL-2 are on CNT-0002." */
function takenText(taken: Array<Pick<Taken, 'item_number' | 'number'>>): string {
  const byCount = new Map<number, string[]>();
  for (const t of taken) byCount.set(Number(t.number), [...(byCount.get(Number(t.number)) ?? []), t.item_number]);
  return [...byCount].map(([n, items]) => {
    const shown = items.slice(0, 5).join(', ') + (items.length > 5 ? ` and ${items.length - 5} more` : '');
    return `${shown} ${items.length === 1 ? 'is' : 'are'} on ${countLabel(n)}.`;
  }).join(' ');
}

/** What a count would take: its items in shelf order, the ones left off because another count has them, and what it's of. */
interface Chosen { items: Item[]; leftOff: Taken[]; what: string; more: number; matched: number }

const MATCH_LIMIT = 1000;

async function chooseItems(place: Place, kind: CountKind, q: string | null, itemIds: string[] | null): Promise<Chosen | { error: string; status: number }> {
  let items: Item[];
  if (kind === 'all') {
    const { data, error } = await fetchAllRows<{ item_id: string }>((from, to) => service
      .from('gl_netsuite_stock_counts')
      .select('item_id')
      .eq('location_id', place.id)
      .neq('quantity', 0)
      .order('item_id', { ascending: true })
      .range(from, to));
    if (error) throw new Error(`couldn't read NetSuite's counts (${error.message})`);
    const named = await readItems(data.map((r) => r.item_id));
    items = data.map((r) => named.get(r.item_id)).filter((i): i is Item => !!i && keepsStock(i));
    if (items.length === 0) return { error: `NetSuite has nothing on hand at ${place.name}, as Books last read it.`, status: 400 };
  } else if (kind === 'search') {
    const text = (q ?? '').trim();
    const filter = text.length < 2 ? null : partSearchOrFilter(['item_number'], ['display_name', 'description'], text.slice(0, 60));
    if (!filter) return { error: 'Type at least two letters or numbers to search for.', status: 400 };
    const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS)
      .eq('is_active', true)
      .not('netsuite_id', 'is', null)
      .or(filter)
      .order('item_number', { ascending: true })
      .order('netsuite_id', { ascending: true })
      .limit(MATCH_LIMIT);
    if (error) throw new Error(`couldn't search the parts list (${error.message})`);
    const rows = (data ?? []) as PartRow[];
    items = rows.map(itemOf).filter(keepsStock);
    if (rows.length >= MATCH_LIMIT || items.length > MAX_LINES) {
      return { error: `More than ${MAX_LINES} items match “${text}”. Narrow the search, or count everything on hand a part at a time.`, status: 400 };
    }
    if (items.length === 0) return { error: `No item FleetSuite keeps stock of matches “${text}”.`, status: 400 };
  } else {
    const ids = [...new Set(itemIds ?? [])];
    if (ids.length === 0) return { error: 'Pick an item to count.', status: 400 };
    const named = await readItems(ids);
    const unknown = ids.filter((id) => !named.has(id));
    if (unknown.length) return { error: `FleetSuite's parts list has no item ${unknown.join(', ')}.`, status: 400 };
    const noStock = ids.map((id) => named.get(id)!).filter((i) => !keepsStock(i));
    if (noStock.length) return { error: `${noStock.map((i) => i.itemNumber).join(', ')} ${noStock.length === 1 ? "isn't an item" : "aren't items"} NetSuite keeps stock of.`, status: 400 };
    items = ids.map((id) => named.get(id)!);
  }

  const taken = await readTaken(place.id);
  const leftOff = items.filter((i) => taken.has(i.netsuiteItemId)).map((i) => taken.get(i.netsuiteItemId)!);
  const free = items.filter((i) => !taken.has(i.netsuiteItemId)).sort(byItemNumber);
  if (free.length === 0) return { error: `Every one of them is on another open count already. ${takenText(leftOff)}`, status: 409 };
  const kept = free.slice(0, MAX_LINES);
  const more = free.length - kept.length;
  const part = kind === 'all' && (more > 0 || leftOff.length > 0) ? { first: kept[0].itemNumber, last: kept[kept.length - 1].itemNumber } : null;
  return { items: kept, leftOff, more, matched: items.length, what: countWhat(kind, q, kept.length, part) };
}

async function readCount(id: string): Promise<Row | null> {
  const { data, error } = await service.from('stock_counts').select(COUNT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Row | null) ?? null;
}

async function readLines(id: string): Promise<Row[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) => service
    .from('stock_count_lines')
    .select(LINE_COLUMNS)
    .eq('count_id', id)
    .order('position', { ascending: true })
    .order('netsuite_item_id', { ascending: true })
    .range(from, to));
  if (error) throw new Error(`couldn't read the count's items (${error.message})`);
  return data;
}

/** NetSuite's average cost of these items at the location, from Books' copy of NetSuite's counts and values. */
async function readAverages(locationId: string, ids: string[]): Promise<Record<string, number>> {
  const rows: Array<{ item_id: string; quantity: number | string; value: number | string | null }> = [];
  for (const part of chunks(ids)) {
    const { data, error } = await service.from('gl_netsuite_stock_counts').select('item_id, quantity, value').eq('location_id', locationId).in('item_id', part);
    if (error) throw new Error(`couldn't read NetSuite's values (${error.message})`);
    rows.push(...((data ?? []) as typeof rows));
  }
  return averageCosts(rows);
}

/** When Books last read NetSuite's counts. */
async function stockReadAt(): Promise<string | null> {
  const { data, error } = await service.from('gl_netsuite_stock_counts').select('read_at').order('read_at', { ascending: false }).limit(1);
  if (error) return null;
  return ((data ?? []) as Array<{ read_at: string }>)[0]?.read_at ?? null;
}

const LIST_DONE = 30;
const FOUND_LIMIT = 20;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireAdmin(req);
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'stock_counts');
    const superAdmin = getProfileRoles(auth.profile).includes('super_admin');
    const canUse = on || superAdmin;
    let open = 0;
    if (canUse) {
      const { data, error } = await service.from('stock_counts').select('id').in('status', [...OPEN_STATUSES]).limit(1000);
      if (!error) open = (data ?? []).length;
    }
    return NextResponse.json({ on, canUse, open });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    const q = params.get('q');
    if (q !== null && !params.get('preview')) return await search(q);

    const places = await readPlaces();
    if (params.get('preview')) {
      const place = places.find((p) => p.id === params.get('location'));
      if (!place) return NextResponse.json({ error: "Pick one of Books' locations." }, { status: 400 });
      const kind = params.get('kind') === 'search' ? 'search' : 'all';
      const chosen = await chooseItems(place, kind, q, null);
      if ('error' in chosen) return NextResponse.json({ error: chosen.error }, { status: chosen.status });
      return NextResponse.json({
        items: chosen.items.length, more: chosen.more, matched: chosen.matched, what: chosen.what,
        first: chosen.items[0].itemNumber, last: chosen.items[chosen.items.length - 1].itemNumber,
        leftOff: chosen.leftOff.length, leftOffText: chosen.leftOff.length ? takenText(chosen.leftOff) : null,
        readAt: kind === 'all' ? await stockReadAt() : null,
      });
    }

    const id = params.get('id');
    if (id !== null) {
      if (!isUuid(id)) return NextResponse.json({ error: "There's no such count." }, { status: 404 });
      return await one(id, gate);
    }

    const [open, done] = await Promise.all([
      service.from('stock_counts').select(COUNT_COLUMNS).in('status', [...OPEN_STATUSES])
        .order('started_at', { ascending: false }).order('id', { ascending: true }).limit(200),
      service.from('stock_counts').select(COUNT_COLUMNS).in('status', ['made', 'cancelled'])
        .order('updated_at', { ascending: false }).order('id', { ascending: true }).limit(LIST_DONE),
    ]);
    if (open.error) throw new Error(open.error.message);
    if (done.error) throw new Error(done.error.message);
    const openCounts = ((open.data ?? []) as unknown as Row[]).map(countFromRow);
    // How far each open count is counted.
    const progress: Record<string, { items: number; counted: number }> = {};
    for (const part of chunks(openCounts.map((c) => c.id))) {
      const { data, error } = await fetchAllRows<{ count_id: string; netsuite_item_id: string; counted: number | string | null }>((from, to) => service
        .from('stock_count_lines')
        .select('count_id, netsuite_item_id, counted')
        .in('count_id', part)
        .order('count_id', { ascending: true })
        .order('netsuite_item_id', { ascending: true })
        .range(from, to));
      if (error) throw new Error(`couldn't read the counts' items (${error.message})`);
      for (const l of data) {
        const p = (progress[l.count_id] ??= { items: 0, counted: 0 });
        p.items += 1;
        if (l.counted !== null) p.counted += 1;
      }
    }
    return NextResponse.json({
      locations: places.map(({ id: placeId, name }) => ({ id: placeId, name })),
      defaultLocationId: defaultLocationId(places, process.env.NETSUITE_DEFAULT_LOCATION_ID ?? null),
      open: openCounts.map((c) => ({ ...c, progress: progress[c.id] ?? { items: 0, counted: 0 } })),
      done: ((done.data ?? []) as unknown as Row[]).map(countFromRow),
      today: chicagoDate(),
      me: gate.me,
      superAdmin: gate.superAdmin,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can count and ask for approval to see what a count would post; nothing goes to NetSuite.`,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: message(err) }, { status: 500 });
  }
}

/** One count: its items in the sheet's order, the ones held back, and what each is worth to whoever sees money. */
async function one(id: string, gate: Gate) {
  const row = await readCount(id);
  if (!row) return NextResponse.json({ error: "There's no such count." }, { status: 404 });
  const count = countFromRow(row);
  const lines = (await readLines(id)).map(lineFromRow);
  let blocked: ReturnType<typeof blockedFromRows> = [];
  if (count.status === 'counting' || count.status === 'asked') {
    const { data, error } = await service.rpc('stock_count_blocked', { p_id: id });
    if (error) throw new Error(error.message);
    blocked = blockedFromRows(data);
  }
  const seeMoney = await profileCanSeeMoney(gate.me, gate.auth.profile);
  const averages = seeMoney ? await readAverages(count.locationId, lines.map((l) => l.netsuiteItemId)) : null;
  return NextResponse.json({
    count, lines, blocked, averages, seeMoney,
    today: chicagoDate(),
    me: gate.me,
    superAdmin: gate.superAdmin,
    switchedOn: gate.on,
    offText: gate.on ? null : `${OFF} You can count and ask for approval to see what a count would post; nothing goes to NetSuite.`,
  });
}

/** The active items NetSuite keeps stock of whose number, name or description has the text, by the search rule every search box uses. */
async function search(q: string) {
  const filter = q.trim().length < 2 ? null : partSearchOrFilter(['item_number'], ['display_name', 'description'], q.slice(0, 60));
  if (!filter) return NextResponse.json({ items: [] });
  const { data, error } = await service.from('netsuite_parts').select(PART_COLUMNS)
    .eq('is_active', true)
    .not('netsuite_id', 'is', null)
    .or(filter)
    .order('item_number', { ascending: true })
    .order('netsuite_id', { ascending: true })
    .limit(FOUND_LIMIT * 3);
  if (error) throw new Error(`couldn't search the parts list (${error.message})`);
  const items = ((data ?? []) as PartRow[]).map(itemOf).filter(keepsStock).slice(0, FOUND_LIMIT);
  return NextResponse.json({ items: items.map((i) => ({ netsuiteItemId: i.netsuiteItemId, itemNumber: i.itemNumber, displayName: i.displayName })) });
}

const itemId = z.string().regex(/^\d{1,20}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const countId = z.string().uuid();
const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    // Made by the page when Start is pressed, so a press sent twice starts one count.
    id: countId,
    locationId: itemId,
    kind: z.enum(['all', 'search', 'picked']),
    q: z.string().max(200).nullable().optional(),
    itemIds: z.array(itemId).max(MAX_LINES).nullable().optional(),
    countDate: day.nullable().optional(),
  }),
  z.object({ action: z.literal('add'), id: countId, itemIds: z.array(itemId).min(1).max(MAX_LINES) }),
  z.object({
    action: z.literal('save'),
    id: countId,
    countDate: day.nullable().optional(),
    lines: z.array(z.object({
      itemId,
      counted: z.number().min(0, "A count can't be below 0.").max(COUNTED_MAX)
        .refine((n) => !hasTooManyPlaces(n), `A count takes ${QUANTITY_PLACES} places at most.`).nullable(),
    })).max(MAX_LINES),
  }),
  z.object({ action: z.literal('ask'), id: countId }),
  z.object({ action: z.literal('finish'), id: countId }),
  z.object({ action: z.literal('cancel'), id: countId }),
  z.object({ action: z.literal('withdraw'), id: countId }),
  z.object({ action: z.literal('turn_down'), id: countId, why: z.string().max(2000) }),
  z.object({ action: z.literal('approve'), id: countId }),
  z.object({ action: z.literal('check'), id: countId }),
]);
type Body = z.infer<typeof Schema>;

type Answer = {
  state: string; count?: Row; taken?: Taken[]; blocked?: unknown; changes?: Change[];
  added?: number; saved?: number; on_it?: number; missing?: string[];
  /** Where the count is, when it's 'not_now'. */
  status?: string;
};
/** A difference to post (stock_count_changes). */
interface Change { netsuite_item_id: string; item_number: string; change: number | string }

async function rpc<T = Answer>(fn: string, p: Record<string, unknown>): Promise<T> {
  const { data, error } = await service.rpc(fn, { p });
  if (error) throw new Error(error.message);
  return data as T;
}

/** Why it can't be done to the count now: it's gone, or it's somewhere this isn't done. */
function notNow(state: string): NextResponse {
  if (state === 'gone') return NextResponse.json({ error: "There's no such count." }, { status: 404 });
  return NextResponse.json({ error: NOT_NOW_TEXT[state as CountStatus] ?? `It's ${state}.`, status: state }, { status: 409 });
}

/** Why a count function wouldn't do it: the count is gone, or 'not_now' with where it is. */
const refused = (answer: Pick<Answer, 'state' | 'status'>) => notNow(answer.state === 'not_now' ? String(answer.status) : answer.state);

/** A count's day: a real one, and not after today. */
function badDay(countDate: string | null | undefined): string | null {
  if (!countDate) return null;
  if (!isIsoDate(countDate)) return `${countDate} isn't a day on the calendar.`;
  if (countDate > chicagoDate()) return "A count can't be dated after today.";
  return null;
}

/**
 * POST /api/inventory/counts. Approving is refused while counts are switched off, for everyone, and only a super
 * admin who didn't ask approves, turns down or asks NetSuite about a press.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  try {
    switch (body.action) {
      case 'start': return await start(body, gate);
      case 'add': return await add(body, gate);
      case 'save': return await save(body, gate);
      case 'ask': return await ask(body, gate);
      case 'finish': return await finish(body, gate);
      case 'cancel': return await cancel(body, gate);
      case 'withdraw': return await withdraw(body, gate);
      case 'turn_down': return await turnDown(body, gate);
      case 'approve': return await approve(body, gate);
      case 'check': return await check(body, gate);
    }
  } catch (err: unknown) {
    return NextResponse.json({ error: message(err) }, { status: 500 });
  }
}

async function audit(gate: Gate, count: Pick<StockCount, 'id' | 'label' | 'locationName'>, action: string, more: Record<string, unknown> = {}) {
  await logAudit(service, {
    actorId: gate.me, table: 'stock_counts', recordId: count.id, action, detail: { count: count.label, location: count.locationName, ...more },
  });
}

const newLine = (i: Item, onHand: Map<string, number>) => ({
  netsuite_item_id: i.netsuiteItemId, part_id: i.partId, item_number: i.itemNumber, display_name: i.displayName,
  on_hand_start: roundQuantity(onHand.get(i.netsuiteItemId) ?? 0),
});

async function start(body: Extract<Body, { action: 'start' }>, gate: Gate) {
  const already = await readCount(body.id);
  if (already) return NextResponse.json({ count: countFromRow(already), same: true });

  const place = (await readPlaces()).find((p) => p.id === body.locationId);
  if (!place) return NextResponse.json({ error: `There's no location ${body.locationId} in Books.` }, { status: 400 });
  const wrongDay = badDay(body.countDate);
  if (wrongDay) return NextResponse.json({ error: wrongDay }, { status: 400 });

  const chosen = await chooseItems(place, body.kind, body.q ?? null, body.itemIds ?? null);
  if ('error' in chosen) return NextResponse.json({ error: chosen.error }, { status: chosen.status });

  let onHand: Map<string, number>;
  try {
    onHand = await getLocationOnHand(place.id, chosen.items.map((i) => i.netsuiteItemId));
  } catch (err: unknown) {
    return NextResponse.json({ error: `Couldn't read NetSuite's count at ${place.name} (${message(err)}). Nothing was started; try again.` }, { status: 502 });
  }

  const answer = await rpc('stock_count_start', {
    id: body.id, by: gate.me, by_name: gate.myName, location_id: place.id, location_name: place.name, what: chosen.what,
    count_date: body.countDate || chicagoDate(), lines: chosen.items.map((i) => newLine(i, onHand)),
  });
  if (answer.state === 'on_another') {
    return NextResponse.json({
      error: `Some of these went on another count just now. ${takenText(answer.taken ?? [])} Press Start again and they'll be left off.`,
      taken: answer.taken ?? [],
    }, { status: 409 });
  }
  const count = countFromRow(answer.count!);
  if (answer.state === 'started') await audit(gate, count, 'start', { what: count.what, items: chosen.items.length });
  return NextResponse.json({
    count, ...(answer.state === 'same' ? { same: true } : {}),
    more: chosen.more, leftOff: chosen.leftOff.length, leftOffText: chosen.leftOff.length ? takenText(chosen.leftOff) : null,
  });
}

async function add(body: Extract<Body, { action: 'add' }>, gate: Gate) {
  const row = await readCount(body.id);
  if (!row) return notNow('gone');
  const count = countFromRow(row);
  if (count.status !== 'counting') return notNow(count.status);
  const ids = [...new Set(body.itemIds)];
  const named = await readItems(ids);
  const unknown = ids.filter((i) => !named.has(i));
  if (unknown.length) return NextResponse.json({ error: `FleetSuite's parts list has no item ${unknown.join(', ')}.` }, { status: 400 });
  const items = ids.map((i) => named.get(i)!);
  const noStock = items.filter((i) => !keepsStock(i));
  if (noStock.length) {
    return NextResponse.json({ error: `${noStock.map((i) => i.itemNumber).join(', ')} ${noStock.length === 1 ? "isn't an item" : "aren't items"} NetSuite keeps stock of.` }, { status: 400 });
  }
  let onHand: Map<string, number>;
  try {
    onHand = await getLocationOnHand(count.locationId, ids);
  } catch (err: unknown) {
    return NextResponse.json({ error: `Couldn't read NetSuite's count at ${count.locationName} (${message(err)}). Nothing was added; try again.` }, { status: 502 });
  }
  const answer = await rpc('stock_count_add', { id: body.id, by: gate.me, lines: [...items].sort(byItemNumber).map((i) => newLine(i, onHand)) });
  if (answer.state === 'added') return NextResponse.json({ added: answer.added ?? 0 });
  if (answer.state === 'on_another') {
    return NextResponse.json({ error: `${takenText(answer.taken ?? [])} Nothing was added.`, taken: answer.taken ?? [] }, { status: 409 });
  }
  if (answer.state === 'too_many') {
    return NextResponse.json({ error: `A count takes ${MAX_LINES} items at most, and this one has ${answer.on_it}. Start another count for the rest.` }, { status: 409 });
  }
  return refused(answer);
}

/**
 * Saves what was typed: each item counted kept with NetSuite's live count as it's saved, which its difference is
 * from, or cleared back to not counted. The page sends only the items whose box was changed.
 */
async function save(body: Extract<Body, { action: 'save' }>, gate: Gate) {
  const ids = body.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) return NextResponse.json({ error: 'An item is saved twice.' }, { status: 400 });
  const wrongDay = badDay(body.countDate);
  if (wrongDay) return NextResponse.json({ error: wrongDay }, { status: 400 });
  const row = await readCount(body.id);
  if (!row) return notNow('gone');
  const count = countFromRow(row);
  if (count.status !== 'counting') return notNow(count.status);

  const counted = body.lines.filter((l) => l.counted !== null).map((l) => l.itemId);
  let onHand = new Map<string, number>();
  if (counted.length) {
    try {
      onHand = await getLocationOnHand(count.locationId, counted);
    } catch (err: unknown) {
      return NextResponse.json({
        error: `Couldn't read NetSuite's count at ${count.locationName} (${message(err)}), so nothing was saved: each count is kept with NetSuite's count as it's saved. Try again.`,
      }, { status: 502 });
    }
  }
  const answer = await rpc('stock_count_save', {
    id: body.id, by: gate.me, by_name: gate.myName, count_date: body.countDate || null,
    lines: body.lines.map((l) => ({
      netsuite_item_id: l.itemId, counted: l.counted, on_hand_then: l.counted === null ? null : roundQuantity(onHand.get(l.itemId) ?? 0),
    })),
  });
  if (answer.state === 'saved') return NextResponse.json({ saved: answer.saved ?? 0 });
  if (answer.state === 'not_on_count') {
    return NextResponse.json({ error: "Some of these aren't on the count. Reload it, then save again." }, { status: 409 });
  }
  return refused(answer);
}

const heldText = (blocked: unknown) => blockedFromRows(blocked).map(blockedText).join(' ');

async function ask(body: Extract<Body, { action: 'ask' }>, gate: Gate) {
  const answer = await rpc('stock_count_ask', { id: body.id, by: gate.me, by_name: gate.myName });
  if (answer.state === 'asked') {
    const count = countFromRow(answer.count!);
    await audit(gate, count, 'ask');
    return NextResponse.json({ count });
  }
  if (answer.state === 'none_counted') return NextResponse.json({ error: 'Nothing on it is counted yet.' }, { status: 400 });
  if (answer.state === 'no_differences') {
    return NextResponse.json({ error: "Every item counted matches NetSuite, so there's nothing to approve. Press Finish instead." }, { status: 409 });
  }
  if (answer.state === 'blocked') {
    return NextResponse.json({ error: heldText(answer.blocked), blocked: blockedFromRows(answer.blocked) }, { status: 409 });
  }
  return refused(answer);
}

async function finish(body: Extract<Body, { action: 'finish' }>, gate: Gate) {
  const answer = await rpc('stock_count_finish', { id: body.id, by: gate.me, by_name: gate.myName });
  if (answer.state === 'finished') {
    const count = countFromRow(answer.count!);
    await audit(gate, count, 'finish');
    return NextResponse.json({ count });
  }
  if (answer.state === 'none_counted') return NextResponse.json({ error: 'Nothing on it is counted yet.' }, { status: 400 });
  if (answer.state === 'differences') {
    return NextResponse.json({ error: 'Some items counted differ from NetSuite, so ask for approval instead.' }, { status: 409 });
  }
  return refused(answer);
}

async function cancel(body: Extract<Body, { action: 'cancel' }>, gate: Gate) {
  const row = await readCount(body.id);
  if (!row) return notNow('gone');
  const was = countFromRow(row);
  if (!gate.superAdmin && was.startedBy !== gate.me) {
    return NextResponse.json({ error: 'Only whoever started a count, or a super admin, can stop it.' }, { status: 403 });
  }
  const answer = await rpc('stock_count_cancel', { id: body.id, by: gate.me, by_name: gate.myName });
  if (answer.state !== 'cancelled') return refused(answer);
  const count = countFromRow(answer.count!);
  await audit(gate, count, 'cancel');
  return NextResponse.json({ count });
}

async function withdraw(body: Extract<Body, { action: 'withdraw' }>, gate: Gate) {
  const answer = await rpc('stock_count_withdraw', { id: body.id, by: gate.me });
  if (answer.state === 'not_yours') {
    return NextResponse.json({ error: 'Only whoever asked withdraws it. A super admin turns it down instead.' }, { status: 403 });
  }
  if (answer.state !== 'withdrawn') return refused(answer);
  const count = countFromRow(answer.count!);
  await audit(gate, count, 'withdraw');
  return NextResponse.json({ count });
}

async function turnDown(body: Extract<Body, { action: 'turn_down' }>, gate: Gate) {
  if (!gate.superAdmin) return NextResponse.json({ error: 'Only a super admin turns down a count.' }, { status: 403 });
  const why = body.why.trim();
  if (!why) return NextResponse.json({ error: 'Say why it is turned down.' }, { status: 400 });
  if (why.length > WHY_MAX) return NextResponse.json({ error: `Keep why to ${WHY_MAX} characters.` }, { status: 400 });
  const answer = await rpc('stock_count_turn_down', { id: body.id, by: gate.me, by_name: gate.myName, why });
  if (answer.state === 'own') return NextResponse.json({ error: 'You asked for this one, so withdraw it instead.' }, { status: 403 });
  if (answer.state !== 'turned_down') return refused(answer);
  const count = countFromRow(answer.count!);
  await audit(gate, count, 'turn_down', { why });
  return NextResponse.json({ count });
}

/**
 * Approves a count: claims it for this press, then posts its differences in NetSuite as one Inventory Adjustment at
 * its location to 52000 Inventory Adjustment, under the count's External ID so it's never posted twice, and keeps
 * what NetSuite said: made, refused (back to wait, with why), or not known (held for Ask NetSuite).
 */
async function approve(body: Extract<Body, { action: 'approve' }>, gate: Gate): Promise<NextResponse> {
  if (!gate.superAdmin) return NextResponse.json({ error: "Only a super admin who didn't ask approves a count." }, { status: 403 });
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was posted in NetSuite.`, switchedOff: true }, { status: 403 });

  const claim = await rpc('stock_count_claim', { id: body.id, by: gate.me, by_name: gate.myName });
  if (claim.state === 'own') {
    return NextResponse.json({ error: "You asked for this one, so a super admin who didn't ask approves it." }, { status: 403 });
  }
  if (claim.state === 'blocked') {
    return NextResponse.json({
      error: `${heldText(claim.blocked)} Turn it down so they're counted again.`, blocked: blockedFromRows(claim.blocked),
    }, { status: 409 });
  }
  const sending = claim.state === 'not_now' && claim.status === 'sending';
  if (sending && claim.count && needsAsking(countFromRow(claim.count))) {
    return NextResponse.json({ error: "A press of Approve hasn't heard back from NetSuite for a while. Press Ask NetSuite to find out what became of it." }, { status: 409 });
  }
  if (sending) {
    return NextResponse.json({ error: "It's being posted to NetSuite now. Don't press again: reload in a minute to see it." }, { status: 409 });
  }
  if (claim.state !== 'claimed') return refused(claim);

  const count = countFromRow(claim.count!);
  const changes = (claim.changes ?? []).map((c) => ({ ...c, change: Number(c.change) }));
  const externalId = countExternalId(count.id);
  const letGo = async (why: string, status: number) => {
    try {
      await rpc('stock_count_let_go', { id: count.id, error: why });
    } catch (err: unknown) {
      return NextResponse.json({
        error: `${why} Nothing was posted, but FleetSuite couldn't put it back to wait for approval (${message(err)}). Five minutes after it was approved, press Ask NetSuite.`,
      }, { status });
    }
    return NextResponse.json({ error: `${why} Nothing was posted, and it's waiting for approval again.` }, { status });
  };

  // NetSuite never takes two adjustments under one External ID; ask first anyway, and refuse when it can't say.
  try {
    const there = await findCountAdjustment(externalId);
    if (there) return made(gate, count, there.adjustmentId, there.number || null, true, changes.length);
  } catch (err: unknown) {
    return letGo(`Couldn't check NetSuite for this count's adjustment (${message(err)}).`, 502);
  }
  if (changes.length === 0) return letGo('Nothing on it differs from NetSuite.', 409);

  const place = (await readPlaces()).find((p) => p.id === count.locationId);
  if (!place) return letGo(`${count.locationName} isn't one of Books' locations any more.`, 409);
  let accountId: string;
  try {
    accountId = await getInventoryAdjustmentAccountId();
  } catch (err: unknown) {
    return letGo(`Couldn't find 52000 Inventory Adjustment in NetSuite (${message(err)}).`, 502);
  }

  // Never take NetSuite's count of an item below 0.
  let onHand: Map<string, number>;
  try {
    onHand = await getLocationOnHand(count.locationId, changes.map((c) => c.netsuite_item_id));
  } catch (err: unknown) {
    return letGo(`Couldn't read NetSuite's count at ${count.locationName} (${message(err)}).`, 502);
  }
  const below = changes.filter((c) => c.change < 0 && roundQuantity((onHand.get(c.netsuite_item_id) ?? 0) + c.change) < 0);
  if (below.length) {
    const why = below.map((c) => `NetSuite has ${quantityText(onHand.get(c.netsuite_item_id) ?? 0)} of ${c.item_number} at ${count.locationName} now, `
      + `so taking off ${quantityText(-c.change)} would leave it below 0.`).join(' ');
    return letGo(`${why} Turn it down so ${below.length === 1 ? "it's" : "they're"} counted again.`, 409);
  }

  const result = await createCountAdjustment({
    externalId, subsidiaryId: place.subsidiaryId, accountId, locationId: count.locationId, tranDate: count.countDate,
    memo: countMemo(count, count.askedByName, gate.myName),
    lines: changes.map((c) => ({ itemId: c.netsuite_item_id, adjustQtyBy: c.change })),
  });
  if (!result.success || !result.adjustmentId) {
    const why = result.error || "NetSuite didn't post the adjustment.";
    if (result.unsure) {
      // NetSuite may have posted it: hold it until it's asked.
      try {
        await rpc('stock_count_unsure', { id: count.id, error: why });
      } catch {
        // Still sending; Ask NetSuite settles it once five minutes have passed.
      }
      await audit(gate, count, 'approve_unsure', { items: changes.length });
      return NextResponse.json({
        error: `${why} FleetSuite can't tell whether NetSuite posted it, so it's held. Press Ask NetSuite in a few minutes and FleetSuite will find out.`,
        unsure: true,
      }, { status: 502 });
    }
    return letGo(why, 502);
  }

  let number: string | null = null;
  try {
    number = (await findCountAdjustment(externalId))?.number || null;
  } catch {
    // The number is for showing; NetSuite's id is what's kept.
  }
  return made(gate, count, result.adjustmentId, number, false, changes.length);
}

/** The count's adjustment is in NetSuite: keep it on the count, close its items, and say so. */
async function made(gate: Gate, count: StockCount, adjustmentId: string, number: string | null, found: boolean, items: number | null) {
  let warning: string | null = null;
  try {
    const kept = await rpc<{ made: boolean }>('stock_count_made', { id: count.id, netsuite_adjustment_id: adjustmentId, netsuite_number: number });
    if (!kept.made) warning = 'NetSuite has it, but the count had moved on meanwhile. Reload it.';
  } catch (err: unknown) {
    warning = `NetSuite has it as adjustment ${number || adjustmentId}, but FleetSuite couldn't keep that (${message(err)}). Press Ask NetSuite on the count to keep it.`;
  }
  await audit(gate, count, found ? 'approve_found' : 'approve', { netsuite_adjustment_id: adjustmentId, ...(items !== null ? { items } : {}) });
  return NextResponse.json({ made: true, adjustmentId, number, ...(found ? { already: true } : {}), ...(warning ? { warning } : {}) });
}

/** Asks NetSuite what became of a press that didn't hear back, or that's been posting longer than one takes. */
async function check(body: Extract<Body, { action: 'check' }>, gate: Gate) {
  if (!gate.superAdmin) return NextResponse.json({ error: 'Only a super admin asks NetSuite about a count.' }, { status: 403 });
  const row = await readCount(body.id);
  if (!row) return notNow('gone');
  const count = countFromRow(row);
  if (!needsAsking(count)) {
    if (count.status === 'sending') {
      return NextResponse.json({ error: "It's being posted to NetSuite now. Ask NetSuite once five minutes have passed." }, { status: 409 });
    }
    return notNow(count.status);
  }
  let there: Awaited<ReturnType<typeof findCountAdjustment>>;
  try {
    there = await findCountAdjustment(countExternalId(count.id));
  } catch (err: unknown) {
    return NextResponse.json({ error: `Couldn't ask NetSuite what became of this count (${message(err)}). Try again.` }, { status: 502 });
  }
  if (there) return made(gate, count, there.adjustmentId, there.number || null, true, null);
  const why = "NetSuite has no adjustment from this press, so it's waiting for approval again.";
  const answer = await rpc<{ let_go: boolean }>('stock_count_let_go', { id: count.id, error: why });
  if (!answer.let_go) return NextResponse.json({ error: 'It moved on meanwhile. Reload it.' }, { status: 409 });
  await audit(gate, count, 'check_none');
  return NextResponse.json({ letGo: true, message: why });
}
