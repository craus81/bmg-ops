import { centsOf } from './invoice-check';
import { dayText, OWN_CHECK_STATUSES, type OwnCheckStatus } from './own-invoice-check';
import { costAt, eachText, qty, type CopiesThrough, type FulfilEntryLine } from './own-fulfillment-check';

/**
 * FleetSuite's own adjustments next to NetSuite's (migration 457,
 * docs/books.md "FleetSuite's own adjustments"; owner decision 2026-10-30,
 * thread "Replacing NetSuite with FleetSuite", "Own postings", then "Build
 * it", its second piece).
 *
 * Each Inventory Adjust (migration 454, src/lib/inventory-adjust.ts) is
 * FleetSuite's own record of a stock adjustment it made in NetSuite: the
 * item, where, how many more or fewer, and why. Books puts each one next to
 * NetSuite's adjustment as the copy of NetSuite's stock moves has it
 * (migration 401), valued from the copy of its general ledger: its date,
 * where it changed stock, the item and by how many, what that came to, and
 * the account on its other side.
 *
 * FleetSuite values the change itself, as it costs its own fulfillments: at
 * the item's average at that location just before, the value FleetSuite
 * counted of it there over the count (its count and value on December 31,
 * 2024 and every NetSuite document since that comes before the adjustment,
 * by date and then NetSuite's id, as gl_own_adjustment_pairs adds them up),
 * to the cent. NetSuite's value is what its adjustment posted to the
 * inventory accounts. The other side goes to the account Inventory Adjust
 * names, 52000 Inventory Adjustment.
 *
 * A copy:
 *   - is incomplete when NetSuite didn't say which adjustment it made, so
 *     there's none to put it next to;
 *   - waits until the copy of NetSuite's stock moves (every two hours) has
 *     NetSuite's adjustment and the copy of its general ledger has its entry.
 *     Once the stock copy has run since and doesn't have it, it's gone
 *     (status 'voided'), as it is when NetSuite deleted it: an adjustment
 *     always moves stock. Once the ledger copy has run since and has no
 *     entry, NetSuite's booked nothing;
 *   - differs when anything compared differs;
 *   - is incomplete when nothing compared differs but FleetSuite couldn't
 *     work something out, which isn't compared;
 *   - matches otherwise.
 *
 * Pure. Amounts are whole cents, stock in positive.
 */

/** The account Inventory Adjust posts the other side of each adjustment to, by its number (adjustAccountId in src/lib/inventory-adjust.ts). */
export const INVENTORY_ADJUST_ACCOUNT = '52000';

// ── What gl_own_adjustment_pairs returns ───────────────────────────────────

export interface OwnAdjustmentData {
  id: string;
  item_id: string;
  item_number: string;
  location_id: string | null;
  mode: 'delta' | 'count';
  entered_qty: string;
  /** Signed, stock in positive. */
  change: string;
  on_hand_before: string | null;
  reason: string;
  note: string | null;
  /** Null when NetSuite didn't say which adjustment it made. */
  netsuite_id: string | null;
  number: string | null;
  made_by: string | null;
  /** The day it was made, Central time. */
  date: string;
  made_at: string;
}

export interface NetsuiteAdjustLineData {
  line_id: string;
  company: string;
  item_id: string;
  location_id: string | null;
  /** Signed, stock in positive. */
  quantity: string;
  moves_stock: boolean;
  /** What NetSuite posted to an inventory account on the line, debit positive; null when the ledger copy has nothing on it. */
  value: string | null;
}

export interface NetsuiteAdjustmentData {
  number: string | null;
  type: string;
  date: string;
  gone: boolean;
  lines: NetsuiteAdjustLineData[];
}

export interface AdjustPairData {
  own: OwnAdjustmentData;
  /** Null before the copy of NetSuite's stock moves has it, or when NetSuite didn't say which it made. */
  netsuite: NetsuiteAdjustmentData | null;
  /** Null before the copy of NetSuite's general ledger has the adjustment. */
  netsuite_gl: { posting_month: string; entry: Array<{ account_id: string; debit: string; credit: string; inventory: boolean }> } | null;
  /** What FleetSuite counted of the item at the location just before; null when the Inventory Adjust names no location. */
  before: { quantity: string; value: string } | null;
}

export interface AdjustPairsData {
  adjustments: AdjustPairData[];
  items: Record<string, { number: string; type: string | null; display_name: string | null; asset_account: string | null }>;
  locations: Record<string, string>;
  accounts: Record<string, { number: string | null; name: string }>;
  /** The chart's account Inventory Adjust posts to; null when it has none. */
  account: { id: string; number: string | null; name: string } | null;
}

// ── What the check says ────────────────────────────────────────────────────

export type AdjustField = 'date' | 'location' | 'change' | 'value' | 'account';

export interface AdjustFieldCheck {
  field: AdjustField;
  label: string;
  /** What FleetSuite's copy says, in words; null when it couldn't work it out. */
  fleetsuite: string | null;
  /** What NetSuite's adjustment says; null when its copies don't say yet. */
  netsuite: string | null;
  /** Null when it isn't compared. */
  same: boolean | null;
  /** Why it differs, or why it isn't compared. */
  why: string | null;
}

export interface OwnAdjustmentCheck {
  /** FleetSuite's id for the Inventory Adjust, which its page is opened by. */
  id: string;
  /** NetSuite's id for its adjustment; null when NetSuite didn't say. */
  netsuiteId: string | null;
  /** NetSuite's number for it ('ADJ0143'), else its id, else 'Inventory Adjust'. */
  number: string;
  date: string;
  itemId: string;
  item: string;
  description: string | null;
  /** The item's asset account in the copy of NetSuite's items, NetSuite's id for it; null when it has none. */
  assetAccount: string | null;
  locationId: string | null;
  location: string | null;
  /** How many more went into stock, fewer negative. */
  change: number;
  /** In words: '2 fewer', '4 more'. */
  changeText: string;
  /** 'delta': a number added or taken off; 'count': what was on the shelf. */
  mode: 'delta' | 'count';
  entered: number;
  /** What NetSuite had on hand there just before, as Inventory Adjust read it. */
  onHandBefore: number | null;
  reason: string;
  note: string | null;
  madeBy: string | null;
  status: OwnCheckStatus;
  /** One sentence for the list. */
  summary: string;
  /** How many of the things compared differ. */
  differing: number;
  /** What the change came to on FleetSuite's side, stock in positive; null when it couldn't be worked out. */
  fleetsuiteValue: number | null;
  /** What NetSuite's adjustment posted to the inventory accounts, debit positive; null before its copies value it. */
  netsuiteValue: number | null;
  /** What FleetSuite counted of the item there just before; null when it doesn't know where. */
  before: { count: number; valueCents: number } | null;
  /** The item's average there just before, in cents (not rounded); null when it had none there. */
  each: number | null;
  /** The account Inventory Adjust posts the other side to, NetSuite's id for it; null when the chart doesn't have it. */
  accountId: string | null;
  fields: AdjustFieldCheck[];
  /** What NetSuite's adjustment posted, account by account. */
  entry: FulfilEntryLine[];
  /** What FleetSuite couldn't work out, in words. */
  unknowns: string[];
  /** How FleetSuite worked its copy out, a sentence each. */
  workedOut: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollars = (cents: number) => money.format(cents / 100);
const listed = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const DAY_MS = 86_400_000;
/** The ledger copy runs at most five minutes, so one that finished this long after a copy was made began after it. */
const LEDGER_RUN_MS = 10 * 60_000;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sameQuantity = (a: number, b: number) => Math.abs(a - b) < 0.00005;

/** A change to stock in words: '2 fewer', '4 more', 'none'. */
export function changeWords(n: number): string {
  if (sameQuantity(n, 0)) return 'none';
  return n > 0 ? `${qty(n)} more` : `${qty(-n)} fewer`;
}

/** What's compared, in a sentence. */
const FIELD_WORDS: Readonly<Record<AdjustField, string>> = {
  date: 'the date',
  location: 'the location',
  change: 'the change',
  value: 'the value',
  account: 'the account',
};

/** How far NetSuite's value is from FleetSuite's, in a sentence: by how much when both go the same way, else each its way. */
function valuesApart(fleetsuite: number, netsuite: number): string {
  if (fleetsuite !== 0 && netsuite !== 0 && (fleetsuite > 0) !== (netsuite > 0)) {
    const way = (cents: number) => (cents > 0 ? `puts ${dollars(cents)} into stock` : `takes ${dollars(-cents)} out of stock`);
    return `FleetSuite's copy ${way(fleetsuite)}, and NetSuite's adjustment ${way(netsuite)}.`;
  }
  const a = Math.abs(fleetsuite);
  const b = Math.abs(netsuite);
  return `NetSuite's value is ${dollars(Math.abs(b - a))} ${b > a ? 'more' : 'less'}.`;
}

/** The copied lists the check reads names from. */
interface AdjustLists {
  items: Map<string, { number: string; type: string | null; displayName: string | null; assetAccount: string | null }>;
  locations: Map<string, string>;
  accounts: Map<string, { number: string | null; name: string }>;
  account: AdjustPairsData['account'];
}

function adjustLists(data: Pick<AdjustPairsData, 'items' | 'locations' | 'accounts' | 'account'>): AdjustLists {
  return {
    items: new Map(Object.entries(data.items ?? {}).map(([id, i]) => [id, {
      number: i.number, type: i.type, displayName: i.display_name, assetAccount: i.asset_account ?? null,
    }])),
    locations: new Map(Object.entries(data.locations ?? {})),
    accounts: new Map(Object.entries(data.accounts ?? {})),
    account: data.account ?? null,
  };
}

/** The items NetSuite keeps in stock, which have a value (bill-rule.ts STOCK_TYPES). */
const KEPT = new Set(['InvtPart', 'Assembly']);

// ── One adjustment ─────────────────────────────────────────────────────────

interface NetItem {
  itemId: string;
  quantity: number;
  locations: Set<string | null>;
  valueCents: number;
}

/** An Inventory Adjust next to NetSuite's adjustment. */
export function checkOwnAdjustment(pair: AdjustPairData, lists: AdjustLists, copies: CopiesThrough): OwnAdjustmentCheck {
  const own = pair.own;
  const identified = !!own.netsuite_id;
  const gone = !!pair.netsuite?.gone;
  const ns = pair.netsuite && !gone ? pair.netsuite : null;
  const madeAt = Date.parse(own.made_at);
  // The stock copy takes every document that moves stock, as an adjustment does: one that ran since without it means it's gone.
  const stockRanSince = !!copies.stock && Date.parse(copies.stock) > madeAt;
  const ledgerRanSince = !!copies.ledger && Date.parse(copies.ledger) > madeAt + LEDGER_RUN_MS;
  const missing = identified && !pair.netsuite && stockRanSince;
  // NetSuite's value is known once its ledger copy has the adjustment, or has run since without it (nothing booked).
  const nsValued = !!ns && (!!pair.netsuite_gl || ledgerRanSince);

  const change = num(own.change) ?? 0;
  const listedItem = lists.items.get(own.item_id);
  const item = own.item_number || listedItem?.number || `NetSuite item ${own.item_id}`;
  const number = own.number || pair.netsuite?.number || (own.netsuite_id ? `NetSuite ${own.netsuite_id}` : 'Inventory Adjust');
  const locationName = (id: string | null) => (id ? lists.locations.get(id) ?? `Location ${id}` : 'no location');
  const itemName = (id: string) => (id === own.item_id ? item : lists.items.get(id)?.number || `NetSuite item ${id}`);
  const ownLocation = own.location_id;
  const before = ownLocation ? { count: num(pair.before?.quantity) ?? 0, valueCents: centsOf(pair.before?.value) ?? 0 } : null;
  const kept = listedItem ? KEPT.has(listedItem.type ?? '') : null;
  const each = before && before.count > 0 ? before.valueCents / before.count : null;
  // FleetSuite's value: the change at the item's average there just before, to the cent; an item not kept in stock has none.
  const fleetsuiteValue = kept === false ? 0 : kept && before ? costAt(change, before.count, before.valueCents) : null;
  const account = lists.account;
  const accountName = (id: string) => {
    const a = id === account?.id ? account : lists.accounts.get(id);
    return a ? [a.number, a.name].filter(Boolean).join(' ') : `NetSuite account ${id}`;
  };

  // NetSuite's side, item by item: what it changed and where, and what that posted to the inventory accounts.
  const netItems = new Map<string, NetItem>();
  for (const l of ns?.lines ?? []) {
    const it = netItems.get(l.item_id) ?? { itemId: l.item_id, quantity: 0, locations: new Set<string | null>(), valueCents: 0 };
    if (l.moves_stock) {
      it.quantity += num(l.quantity) ?? 0;
      it.locations.add(l.location_id);
    }
    if (l.value !== null && l.value !== undefined) it.valueCents += centsOf(l.value) ?? 0;
    netItems.set(l.item_id, it);
  }
  // A line that moved nothing and posted nothing to stock isn't a change.
  for (const [id, it] of netItems) if (sameQuantity(it.quantity, 0) && it.valueCents === 0) netItems.delete(id);
  const netsuiteValue = nsValued ? [...netItems.values()].reduce((sum, it) => sum + it.valueCents, 0) : null;
  const theirItem = netItems.get(own.item_id);
  const others = [...netItems.values()].filter((it) => it.itemId !== own.item_id);
  // The ledger copy has run since and has nothing for NetSuite's adjustment.
  const bookedNothing = !!ns && !pair.netsuite_gl && ledgerRanSince;
  // What NetSuite's adjustment put on its other side: its accounts outside the inventory accounts.
  const offsets = (pair.netsuite_gl?.entry ?? [])
    .filter((e) => !e.inventory && (centsOf(e.debit) ?? 0) !== (centsOf(e.credit) ?? 0))
    .map((e) => e.account_id);

  const fields: AdjustFieldCheck[] = [];

  // Its date.
  {
    const same = ns ? own.date === ns.date : null;
    const days = ns ? Math.round((Date.parse(ns.date) - Date.parse(own.date)) / DAY_MS) : 0;
    fields.push({
      field: 'date',
      label: 'Date',
      fleetsuite: dayText(own.date),
      netsuite: ns ? dayText(ns.date) : null,
      same,
      why: same === false
        ? `Inventory Adjust made it ${dayText(own.date)}, and NetSuite's adjustment is dated ${plural(Math.abs(days), 'day', 'days')} ${days > 0 ? 'later' : 'earlier'}.`
        : null,
    });
  }

  // Where it changed stock.
  {
    const where = new Set<string | null>();
    for (const it of netItems.values()) for (const l of it.locations) where.add(l);
    const theirs = [...where];
    const same = ownLocation && ns && theirs.length ? theirs.length === 1 && theirs[0] === ownLocation : null;
    fields.push({
      field: 'location',
      label: 'Location',
      fleetsuite: ownLocation ? locationName(ownLocation) : null,
      netsuite: ns ? (theirs.length ? listed(theirs.map(locationName).sort()) : 'None') : null,
      same,
      why: !ownLocation
        ? "Inventory Adjust didn't save where it changed stock."
        : same === false ? `Inventory Adjust changed ${item} at ${locationName(ownLocation)}, and NetSuite's adjustment at ${listed(theirs.map(locationName).sort())}.` : null,
    });
  }

  // The item and by how many.
  {
    const reasons: string[] = [];
    if (ns) {
      if (!theirItem) reasons.push(`Inventory Adjust made it ${changeWords(change)} ${item}, and NetSuite's adjustment didn't change ${item}.`);
      else if (!sameQuantity(theirItem.quantity, change)) reasons.push(`Inventory Adjust made it ${changeWords(change)} ${item}, and NetSuite's adjustment ${changeWords(theirItem.quantity)}.`);
      for (const it of others) reasons.push(`NetSuite's adjustment also made it ${changeWords(it.quantity)} ${itemName(it.itemId)}, which Inventory Adjust didn't.`);
    }
    const same = ns ? !reasons.length : null;
    const theirs = !ns ? null
      : !netItems.size ? 'None'
        : others.length || !theirItem ? listed([...netItems.values()].map((it) => `${changeWords(it.quantity)} ${itemName(it.itemId)}`))
          : changeWords(theirItem.quantity);
    fields.push({
      field: 'change',
      label: 'Change',
      fleetsuite: changeWords(change),
      netsuite: theirs,
      same,
      why: reasons.length ? `${reasons[0]}${reasons.length > 1 ? ` ${reasons.slice(1).join(' ')}` : ''}` : null,
    });
  }

  // What it came to.
  {
    const same = fleetsuiteValue !== null && netsuiteValue !== null ? fleetsuiteValue === netsuiteValue : null;
    let why: string | null = null;
    if (!ownLocation) why = "FleetSuite doesn't know where it changed stock, so not what that came to.";
    else if (kept === null) why = `FleetSuite didn't know whether ${item} is kept in stock (the copy of NetSuite's items doesn't have it yet), so not what the change came to.`;
    else if (fleetsuiteValue === null) why = `FleetSuite counted none of ${item} at ${locationName(ownLocation)} just before, so it can't work out what the change came to.`;
    else if (bookedNothing) why = "NetSuite's adjustment booked nothing: the copy of its general ledger, made since, has no entry for it.";
    else if (same === false) why = valuesApart(fleetsuiteValue, netsuiteValue!);
    fields.push({
      field: 'value',
      label: 'Value',
      fleetsuite: fleetsuiteValue !== null ? dollars(Math.abs(fleetsuiteValue)) : null,
      netsuite: netsuiteValue !== null ? dollars(Math.abs(netsuiteValue)) : null,
      same,
      why,
    });
  }

  // The account on its other side.
  {
    const theirs = [...new Set(offsets)];
    const known = !!account && nsValued && theirs.length > 0;
    const same = known ? theirs.length === 1 && theirs[0] === account!.id : null;
    let why: string | null = null;
    if (!account) why = `The copy of NetSuite's accounts has no ${INVENTORY_ADJUST_ACCOUNT}, the account Inventory Adjust posts to.`;
    else if (same === false) why = `Inventory Adjust posts to ${accountName(account.id)}, and NetSuite's adjustment put its other side in ${listed(theirs.map(accountName))}.`;
    fields.push({
      field: 'account',
      label: 'Account',
      fleetsuite: account ? accountName(account.id) : null,
      netsuite: nsValued ? (theirs.length ? listed(theirs.map(accountName)) : 'None') : null,
      same,
      why,
    });
  }

  const differing = fields.filter((f) => f.same === false).length;
  const unknownWords: string[] = [];
  if (!ownLocation) unknownWords.push('where it changed stock, so what that came to');
  else if (kept === null) unknownWords.push(`whether ${item} is kept in stock (the copy of NetSuite's items doesn't have it yet)`);
  else if (fleetsuiteValue === null) unknownWords.push(`what the change came to: it counted none of ${item} at ${locationName(ownLocation)} just before`);
  if (!account) unknownWords.push(`which account Inventory Adjust posts to: the copy of NetSuite's accounts has no ${INVENTORY_ADJUST_ACCOUNT}`);

  let status: OwnCheckStatus;
  let summary: string;
  if (!identified) {
    status = 'incomplete';
    summary = "NetSuite didn't say which adjustment it made, so there's none to put this next to.";
    unknownWords.unshift('which adjustment NetSuite made: it took the Inventory Adjust without saying');
  } else if (gone || missing) {
    status = 'voided';
    summary = gone ? "NetSuite's adjustment is gone from NetSuite."
      : "NetSuite's adjustment is gone from NetSuite: the copy of its stock moves, made since, doesn't have it.";
  } else if (!ns) {
    status = 'waiting';
    summary = "Waiting for NetSuite's adjustment: the copy of NetSuite's stock moves runs every two hours.";
  } else if (!nsValued) {
    status = 'waiting';
    summary = "Waiting for the copy of NetSuite's general ledger to reach the adjustment.";
  } else if (differing) {
    status = 'differs';
    const first = fields.find((f) => f.same === false)!;
    const what = first.why ?? `FleetSuite ${first.fleetsuite ?? 'nothing'}, NetSuite ${first.netsuite ?? 'nothing'}.`;
    const differs = (f: AdjustField) => fields.some((x) => x.field === f && x.same === false);
    // The value follows from the change and where it was made.
    const follows = (f: AdjustField) => f === 'value' && (differs('change') || differs('location'));
    const rest = fields.filter((f) => f.same === false && f !== first && !follows(f.field)).map((f) => f.field);
    const too = listed(rest.map((f) => FIELD_WORDS[f]));
    summary = `${first.label}: ${what}${rest.length ? ` ${too.charAt(0).toUpperCase()}${too.slice(1)} ${rest.length > 1 ? 'differ' : 'differs'} too.` : ''}`;
  } else if (unknownWords.length) {
    status = 'incomplete';
    summary = `Matches where it can be checked. FleetSuite didn't know ${listed(unknownWords)}.`;
  } else {
    status = 'matches';
    summary = "Matches NetSuite's adjustment.";
  }

  const entry = (pair.netsuite_gl?.entry ?? []).map((e) => ({
    account: accountName(e.account_id),
    debit: centsOf(e.debit) ?? 0,
    credit: centsOf(e.credit) ?? 0,
  }));

  const where = ownLocation ? locationName(ownLocation) : null;
  const made = `${own.made_by ?? 'Someone'} used Inventory Adjust on ${dayText(own.date)}: ${own.reason}${own.note ? `, "${own.note}"` : ''}.`;
  const entered = num(own.entered_qty) ?? 0;
  const onHand = num(own.on_hand_before);
  const how = own.mode === 'count'
    ? `They counted ${qty(entered)} on the shelf${where ? ` at ${where}` : ''}, where NetSuite had ${onHand !== null ? qty(onHand) : 'a count'} on hand, so it's ${changeWords(change)}.`
    : `They ${change > 0 ? 'added' : 'took off'} ${qty(Math.abs(change))}${onHand !== null ? `, from the ${qty(onHand)} NetSuite had on hand${where ? ` at ${where}` : ''}` : ''}.`;
  const valued = kept === false ? `${item} isn't kept in stock, so the change comes to nothing.`
    : each !== null && fleetsuiteValue !== null && where && before
      ? `${qty(Math.abs(change))} ${item} at ${eachText(each)} each, its average at ${where} just before (${dollars(before.valueCents)} for ${qty(before.count)}): ${dollars(Math.abs(fleetsuiteValue))}.`
      : null;
  const workedOut = [
    made,
    how,
    ...(valued ? [valued] : []),
    "An item's average at a location just before is the value FleetSuite counted of it there over the count, from its count and value on "
      + 'December 31, 2024 and every NetSuite document since that comes before the adjustment, as Stock by item counts them. '
      + 'The change is valued at that average, to the cent.',
    `Its other side goes to ${account ? accountName(account.id) : INVENTORY_ADJUST_ACCOUNT}, the account Inventory Adjust posts to.`,
  ];

  return {
    id: own.id,
    netsuiteId: own.netsuite_id,
    number,
    date: own.date,
    itemId: own.item_id,
    item,
    description: listedItem?.displayName ?? null,
    assetAccount: listedItem?.assetAccount ?? null,
    locationId: ownLocation,
    location: where,
    change,
    changeText: changeWords(change),
    mode: own.mode,
    entered,
    onHandBefore: onHand,
    reason: own.reason,
    note: own.note,
    madeBy: own.made_by,
    status,
    summary,
    differing,
    fleetsuiteValue,
    netsuiteValue,
    before,
    each,
    accountId: account?.id ?? null,
    fields,
    entry,
    unknowns: unknownWords,
    workedOut,
  };
}

export interface OwnAdjustmentsChecked {
  adjustments: OwnAdjustmentCheck[];
  counts: Record<OwnCheckStatus, number>;
}

/** Every Inventory Adjust gl_own_adjustment_pairs returned, each checked. */
export function checkOwnAdjustments(data: AdjustPairsData, copies: CopiesThrough): OwnAdjustmentsChecked {
  const lists = adjustLists(data);
  const adjustments = (data.adjustments ?? []).map((pair) => checkOwnAdjustment(pair, lists, copies));
  const counts = Object.fromEntries(OWN_CHECK_STATUSES.map((s) => [s, 0])) as Record<OwnCheckStatus, number>;
  for (const a of adjustments) counts[a.status]++;
  return { adjustments, counts };
}
