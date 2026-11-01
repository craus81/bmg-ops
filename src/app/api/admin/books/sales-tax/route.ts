import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireBooks } from '@/lib/api-auth';
import { booksAllows } from '@/lib/books/access';
import { createServiceClient } from '@/lib/supabase-service';
import { validateBody, z } from '@/lib/validate';
import { logAudit } from '@/lib/audit';
import { monthAfter } from '@/lib/books/bank-reconciliation';
import { monthText } from '@/lib/books/differences';
import { centralDate } from '@/lib/books/mistake-checks';
import { COPY_FROM } from '@/lib/books/netsuite-gl';
import { dayText } from '@/lib/books/own-invoice-check';
import { netsuiteCheck } from '@/lib/books/report-detail';
import { SALES_TAX_COMPANY, loadSalesTax } from '@/lib/books/sales-tax-data';
import { locationState } from '@/lib/books/sales-tax-worksheet';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => NextResponse.json({ error: String((err as any)?.message || err) }, { status: 500 });
const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * GET /api/admin/books/sales-tax?month=2026-10 — the month's Missouri sales
 * tax worksheet (src/lib/books/sales-tax-worksheet.ts, migration 496,
 * docs/books.md "Sales tax"): what to file for each location, the documents
 * whose tax NetSuite worked out differently and why, exempt customers'
 * sales, what isn't on the return, the sales tax accounts through the
 * month, each location's rates, and the month's return as filed, held
 * against it all; last month when it's left out. Amounts are whole cents;
 * the Excel download has every document. Each document listed carries
 * `check`, where Invoices vs NetSuite checks it, or null.
 *
 * POST { action: 'return', month: 'YYYY-MM', seen, filedOn, grossCents,
 * adjustmentsCents, taxableCents, taxCents, allowanceCents, paidCents, note }
 * — the month's return as it was filed, typed in or corrected;
 * { action: 'remove_return', month, seen } — removed, typed in for the wrong
 * month say. `seen` is when it was saved, as the page saw it, null for one
 * not typed in yet. { action: 'add_rate', locationId, startsOn, pct, note }
 * and { action: 'remove_rate', locationId, startsOn } — a location's rate
 * from the day it starts, super admins only.
 *
 * Super admins, the bookkeeper and the CPA see it; the bookkeeper and super
 * admins type in returns. Nothing here moves money or is sent to NetSuite.
 */
export async function GET(req: NextRequest) {
  const auth = await requireBooks(req, 'read');
  if (auth.error) return auth.error;

  const loaded = await loadSalesTax(createServiceClient(), new URL(req.url).searchParams);
  if ('error' in loaded) return NextResponse.json({ error: loaded.error }, { status: 500 });
  const { documents, accounts, ...worksheet } = loaded.worksheet;
  // Each opens its check on Invoices vs NetSuite when FleetSuite posts its kind: they're NetSuite's for the month they're read in.
  const checked = <T extends { type: string; date: string }>(rows: T[], month: string) =>
    rows.map((r) => ({ ...r, check: netsuiteCheck(r.type, month, r.date) }));
  return NextResponse.json({
    ...loaded,
    worksheet: {
      ...worksheet,
      // Only the documents whose tax NetSuite worked out differently, without their lines: the download has them all.
      documents: checked(documents.filter((d) => d.note).map(({ lines: _lines, ...d }) => d), loaded.month),
      accounts: accounts && {
        ...accounts,
        others: { ...accounts.others, list: checked(accounts.others.list, loaded.month) },
        next: { ...accounts.next, list: checked(accounts.next.list, monthAfter(loaded.month)) },
      },
    },
    can: { keep: booksAllows(auth.access, 'keep'), owner: booksAllows(auth.access, 'owner') },
  });
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Month must be YYYY-MM');
const stamp = z.string().min(1).max(60);
// What the return's columns hold: up to $100 million either way.
const cents = z.number().int().min(-10_000_000_000).max(10_000_000_000);
const location = z.string().regex(/^\d{1,12}$/, "A location is NetSuite's id for it");

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('return'),
    month,
    seen: stamp.nullable(),
    filedOn: date,
    grossCents: cents,
    adjustmentsCents: cents,
    taxableCents: cents,
    taxCents: cents,
    allowanceCents: cents.min(0, "The timely payment allowance can't be less than nothing"),
    paidCents: cents,
    note: z.string().max(300).nullable().optional(),
  }),
  z.object({ action: z.literal('remove_return'), month, seen: stamp }),
  z.object({
    action: z.literal('add_rate'),
    locationId: location,
    startsOn: date,
    // A percent, as the state's rate table writes it: 8.488 is 8.488%.
    pct: z.string().trim().regex(/^\d{1,2}(\.\d{1,3})?$/, 'Type the rate as a percent with up to three decimals, 8.488 say')
      .refine((v) => Number(v) > 0, 'Type the rate as a percent above 0'),
    note: z.string().max(200).nullable().optional(),
  }),
  z.object({ action: z.literal('remove_rate'), locationId: location, startsOn: date }),
]);
type Body = z.infer<typeof Schema>;

export async function POST(req: NextRequest) {
  const auth = await requireBooks(req, 'keep');
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;
  if ((body.action === 'add_rate' || body.action === 'remove_rate') && !booksAllows(auth.access, 'owner')) {
    return refuse(403, "Only a super admin can change a location's sales tax rate.");
  }
  const service = createServiceClient();
  try {
    switch (body.action) {
      case 'return': return await saveReturn(service, body, auth.user.id);
      case 'remove_return': return await removeReturn(service, body, auth.user.id);
      case 'add_rate': return await addRate(service, body, auth.user.id);
      case 'remove_rate': return await removeRate(service, body, auth.user.id);
    }
  } catch (err) {
    return failed(err);
  }
}

async function saveReturn(service: SupabaseClient, body: Extract<Body, { action: 'return' }>, me: string) {
  const m = `${body.month}-01`;
  const name = monthText(m);
  if (m < COPY_FROM) return refuse(400, `Returns are kept from ${monthText(COPY_FROM)}, when FleetSuite's copy of NetSuite starts.`);
  const over = monthAfter(m);
  if (body.filedOn < over) return refuse(400, `${name}'s return is filed once the month is over: on ${dayText(over)} or after.`);
  const today = centralDate(new Date());
  if (body.filedOn > today) return refuse(400, `${dayText(body.filedOn)} hasn't come yet: type the day the return was filed.`);
  const note = (body.note ?? '').trim() || null;

  const { data, error } = await service.rpc('sales_tax_return_save', {
    p: {
      company: SALES_TAX_COMPANY, month: m, seen: body.seen, filed_on: body.filedOn, gross_cents: body.grossCents,
      adjustments_cents: body.adjustmentsCents, taxable_cents: body.taxableCents, tax_cents: body.taxCents,
      allowance_cents: body.allowanceCents, paid_cents: body.paidCents, note, by: me,
    },
  });
  if (error) throw new Error(`Couldn't save ${name}'s return: ${error.message}`);
  const answer = (data ?? {}) as { state?: string; updated_at?: string; unchanged?: boolean };
  if (answer.state === 'changed') return refuse(409, `${name}'s return was changed by someone else since you opened it: look at it again.`);
  if (answer.state !== 'saved') throw new Error(`Couldn't save ${name}'s return: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  if (!answer.unchanged) {
    // What was filed is on the page; the record says who typed it in and when, never the amounts.
    await logAudit(service, {
      actorId: me, table: 'sales_tax_returns', recordId: `${SALES_TAX_COMPANY} ${body.month}`, action: body.seen === null ? 'typed in' : 'corrected',
      detail: { month: m, filed_on: body.filedOn, note: note !== null },
    });
  }
  return NextResponse.json({ saved: true, updatedAt: answer.updated_at ?? null });
}

async function removeReturn(service: SupabaseClient, body: Extract<Body, { action: 'remove_return' }>, me: string) {
  const m = `${body.month}-01`;
  const name = monthText(m);
  const { data, error } = await service.rpc('sales_tax_return_remove', { p: { company: SALES_TAX_COMPANY, month: m, seen: body.seen } });
  if (error) throw new Error(`Couldn't remove ${name}'s return: ${error.message}`);
  const answer = (data ?? {}) as { state?: string };
  switch (answer.state) {
    case 'removed':
      break;
    case 'changed': return refuse(409, `${name}'s return was changed by someone else since you opened it: look at it again.`);
    case 'gone': return refuse(409, `${name}'s return was removed already: look at it again.`);
    default: throw new Error(`Couldn't remove ${name}'s return: the books answered ${JSON.stringify(answer).slice(0, 200)}`);
  }
  await logAudit(service, {
    actorId: me, table: 'sales_tax_returns', recordId: `${SALES_TAX_COMPANY} ${body.month}`, action: 'removed', detail: { month: m },
  });
  return NextResponse.json({ removed: true });
}

/** A location's name in NetSuite's lists, and whether it has a rate already; null when NetSuite has no such location. */
async function readLocation(service: SupabaseClient, locationId: string): Promise<{ name: string; rated: boolean } | null> {
  const [listed, rated] = await Promise.all([
    service.from('gl_netsuite_lists').select('name').eq('kind', 'location').eq('netsuite_id', locationId).is('gone_at', null).maybeSingle(),
    service.from('sales_tax_rates').select('starts_on').eq('location_id', locationId).limit(1),
  ]);
  if (listed.error) throw new Error(`Couldn't read NetSuite's locations: ${listed.error.message}`);
  if (rated.error) throw new Error(`Couldn't read the rates: ${rated.error.message}`);
  const row = listed.data as { name: string } | null;
  return row && { name: row.name, rated: (rated.data ?? []).length > 0 };
}

async function addRate(service: SupabaseClient, body: Extract<Body, { action: 'add_rate' }>, me: string) {
  if (body.startsOn < COPY_FROM) return refuse(400, `Rates start from ${dayText(COPY_FROM)}, when FleetSuite's copy of NetSuite starts.`);
  const found = await readLocation(service, body.locationId);
  if (!found) return refuse(400, `Location ${body.locationId} isn't one of NetSuite's locations: Sync now on the NetSuite lists page reads them.`);
  if (locationState(body.locationId, found.name, found.rated) === 'GA') {
    return refuse(400, `${found.name} is in Georgia, where FleetSuite doesn't tax work, so it isn't on Missouri's return.`);
  }
  const note = (body.note ?? '').trim() || null;
  const { error } = await service.from('sales_tax_rates').insert({
    location_id: body.locationId, starts_on: body.startsOn, rate_pct: body.pct, note, entered_by: me,
  });
  if (error?.code === '23505') {
    return refuse(409, `${found.name} has a rate from ${dayText(body.startsOn)} already: remove it first to change it.`);
  }
  if (error) throw new Error(`Couldn't add the rate: ${error.message}`);
  await logAudit(service, {
    actorId: me, table: 'sales_tax_rates', recordId: `${body.locationId} ${body.startsOn}`, action: 'added',
    detail: { location_id: body.locationId, starts_on: body.startsOn, rate_pct: Number(body.pct) },
  });
  return NextResponse.json({ added: true });
}

async function removeRate(service: SupabaseClient, body: Extract<Body, { action: 'remove_rate' }>, me: string) {
  const { data, error } = await service.from('sales_tax_rates').delete()
    .eq('location_id', body.locationId).eq('starts_on', body.startsOn).select('rate_pct');
  if (error) throw new Error(`Couldn't remove the rate: ${error.message}`);
  const gone = (data ?? []) as Array<{ rate_pct: string | number }>;
  if (!gone.length) return refuse(409, 'That rate was removed already: look at it again.');
  await logAudit(service, {
    actorId: me, table: 'sales_tax_rates', recordId: `${body.locationId} ${body.startsOn}`, action: 'removed',
    detail: { location_id: body.locationId, starts_on: body.startsOn, rate_pct: Number(gone[0].rate_pct) },
  });
  return NextResponse.json({ removed: true });
}
