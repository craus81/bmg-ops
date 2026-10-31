import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getItemRecord, patchItemRecordFields } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { noteItemAccountsChanged } from '@/lib/books/netsuite-lists';
import { readAccounts, readCompanies } from '@/lib/books/snap-a-bill';
import { logAudit } from '@/lib/audit';
import { readDetailChanges } from '@/lib/detail-changes';
import {
  ACCOUNT_FIELDS, COPY_KEYS, ITEM_ACCOUNT_KINDS, ITEM_COMPANY, ITEM_KINDS, ITEM_TYPES_WITH_ACCOUNTS, REASON_MAX, itemFacts,
  parseAccountsItem, planItemAccounts, recordTypesFor, type AccountsItem, type ChartAccount,
} from '@/lib/item-accounts';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Changing item accounts is switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

/**
 * Anyone with Payments who can see prices, once item accounts are switched on (Books → Switches), as a vendor's
 * details are changed; until then only super admins, to see what a change would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return { auth, on: false, error: NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 }) };
  }
  const on = await switchIsOn(service, 'item_accounts');
  if (!on && !getProfileRoles(auth.profile).includes('super_admin')) {
    return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on };
}

/**
 * The item as NetSuite has it now. The copy of NetSuite's items says what kind it is, so which record types to read
 * it as.
 */
async function readItem(id: string): Promise<{ item: AccountsItem } | { error: string; status: number }> {
  const { data, error } = await service.from('gl_netsuite_lists').select('netsuite_id, name, details')
    .eq('kind', 'item').eq('netsuite_id', id).is('gone_at', null).maybeSingle();
  if (error) throw new Error(`couldn't read the copy of NetSuite's items (${error.message})`);
  const row = data as { name: string; details: { item_type?: string } | null } | null;
  if (!row) {
    return { error: `Item ${id} isn't in the copy of NetSuite's items yet. The copy catches up every two hours.`, status: 404 };
  }
  const types = recordTypesFor(row.details?.item_type);
  if (types.length === 0) {
    return {
      error: `${row.name} is a kind of item whose accounts aren't changed here: only an inventory item, an assembly, a kit, a non-inventory item, a service or an other charge is.`,
      status: 400,
    };
  }
  const rec = await getItemRecord(types, id);
  if (!rec.success) return { error: rec.notFound ? `NetSuite has no item with id ${id}.` : rec.error, status: rec.notFound ? 404 : 502 };
  return { item: parseAccountsItem(rec.recordType, id, rec.record) };
}

/** Every account in the chart, by NetSuite's id, each with the companies whose items can post to it now. */
async function readChart(): Promise<Map<string, ChartAccount>> {
  return readAccounts(service, await readCompanies(service), ITEM_ACCOUNT_KINDS);
}

/** What the change is worked out against, short: anything different means the item changed while the page was open. */
const signatureOf = (item: AccountsItem) => createHash('sha256').update(itemFacts(item)).digest('hex').slice(0, 32);

/** Items in the copy of NetSuite's items with every word typed in their number or display name, active ones first. */
async function findItems(typed: string) {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let q = service.from('gl_netsuite_lists').select('netsuite_id, name, active, details').eq('kind', 'item').is('gone_at', null)
    .in('details->>item_type', [...ITEM_TYPES_WITH_ACCOUNTS]);
  if (words.length > 0) {
    const like = `%${words.slice(0, 6).join('%')}%`;
    q = q.or(`name.ilike.${like},details->>display_name.ilike.${like}`);
  }
  const { data, error } = await q.order('active', { ascending: false }).order('name', { ascending: true }).order('netsuite_id').limit(15);
  if (error) throw new Error(`couldn't search the copy of NetSuite's items (${error.message})`);
  return ((data ?? []) as Array<{ netsuite_id: string; name: string; active: boolean; details: { display_name?: string } | null }>)
    .map((r) => ({ id: r.netsuite_id, number: r.name, displayName: r.details?.display_name ?? null, active: r.active }));
}

/**
 * GET /api/item-accounts?status=1 — whether item accounts are on, and whether this person can change an item's.
 * GET ?find=<typed> — items from the copy of NetSuite's items by number or display name, active ones first.
 * GET ?item=<NetSuite id> — the item as NetSuite has it now with its accounts, the accounts they can be changed to (and
 * the ones it has), what a change is planned against, and the changes FleetSuite made to it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'vendor_payments');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'item_accounts');
    const money = await profileCanSeeMoney(auth.user.id, auth.profile);
    return NextResponse.json({ on, canUse: money && (on || getProfileRoles(auth.profile).includes('super_admin')) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    if (params.has('find')) return NextResponse.json({ items: await findItems(params.get('find') || '') });

    const id = (params.get('item') || '').trim();
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad item id' }, { status: 400 });
    const read = await readItem(id);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    const [chart, changes] = await Promise.all([readChart(), readDetailChanges(service, 'item', id)]);
    // The page picks from the accounts BMG's items can post to now, and names the ones the item has whatever they are.
    const has = new Set(Object.values(read.item.accounts).map((a) => a?.id).filter((v): v is string => !!v));
    return NextResponse.json({
      item: read.item,
      chart: [...chart.values()].filter((a) => has.has(a.id) || a.companies.includes(ITEM_COMPANY)),
      signature: signatureOf(read.item),
      changes,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what a change would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const accountId = z.string().regex(/^\d{0,20}$/);
const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one change.
  requestId: z.string().uuid(),
  itemId: z.string().regex(/^\d{1,20}$/),
  // What the page planned against (GET's signature). The item can change in NetSuite while the page is open: then
  // nothing is sent.
  signature: z.string().min(1).max(100),
  reason: z.string().max(REASON_MAX + 700),
  accounts: z.object({
    incomeAccount: accountId.optional(),
    cogsAccount: accountId.optional(),
    assetAccount: accountId.optional(),
    expenseAccount: accountId.optional(),
  }).strict().optional(),
});

/**
 * POST /api/item-accounts — change the item's accounts in NetSuite. What changes and what NetSuite is sent are worked
 * out here from the item as NetSuite has it now, never taken from the page. Refused while item accounts are switched
 * off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  let item: AccountsItem;
  let chart: Map<string, ChartAccount>;
  try {
    const read = await readItem(body.itemId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    item = read.item;
    if (signatureOf(item) !== body.signature) {
      return NextResponse.json({
        error: `${item.number} changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.`,
        stale: true,
      }, { status: 409 });
    }
    chart = await readChart();
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }

  const plan = planItemAccounts(item, body, { chart });
  if (plan.problems.length > 0) return NextResponse.json({ error: plan.problems.join(' '), problems: plan.problems }, { status: 400 });

  // One send per form, and one change of an item at a time: take the claim, or say what's in the way.
  const claim = await service.rpc('detail_change_claim', {
    p: {
      id: body.requestId,
      record_type: 'item',
      netsuite_id: item.id,
      name: item.number,
      reason: body.reason.trim(),
      changes: plan.changes,
      patch: plan.body,
      by: auth.user.id,
    },
  });
  if (claim.error) return NextResponse.json({ error: claim.error.message }, { status: 500 });
  const claimed = claim.data as { claimed?: boolean; state?: string } | null;
  if (!claimed?.claimed) {
    if (claimed?.state === 'changed') return NextResponse.json({ success: true, already: true, changes: plan.changes });
    return NextResponse.json({
      error: claimed?.state === 'sending'
        ? "This change is being sent now. Don't press again: reload the item in a minute to see it."
        : `Another change of ${item.number} is being sent now. Reload it in a minute and check it before changing it again.`,
    }, { status: 409 });
  }

  const finish = (p: Record<string, unknown>) => service.rpc('detail_change_finish', { p: { id: body.requestId, ...p } });

  const result = await patchItemRecordFields(item.recordType, item.id, plan.body);
  if (!result.success) {
    const error = result.error || "NetSuite didn't answer";
    await finish({ status: result.unsure ? 'unsure' : 'refused', error });
    // NetSuite's own words, without the full stop they may end with, so the sentence reads on.
    const said = error.replace(/[.\s]+$/, '');
    return NextResponse.json(result.unsure
      ? {
        error: `${said}, so FleetSuite can't tell whether the change went in. Reload the item: if the change is there, it went in; if it isn't, make it again.`,
        unsure: true,
      }
      : { error: `NetSuite didn't take the change: ${said}. Nothing changed.` }, { status: 502 });
  }

  const done = await finish({ status: 'changed' });
  // The change is in NetSuite either way; a row left sending shows as unsure after five minutes.
  if (done.error) console.error(`[item accounts] ${body.requestId} went in but wasn't marked changed: ${done.error.message}`);

  // The posting rules and Stock by item read an item's accounts from the copy of NetSuite's items: it takes them now.
  const noted: Record<string, string> = {};
  for (const field of ACCOUNT_FIELDS) {
    const key = COPY_KEYS[field];
    const sent = plan.body[field] as { id?: string } | undefined;
    if (key && sent?.id) noted[key] = sent.id;
  }
  if (Object.keys(noted).length > 0) {
    try {
      await noteItemAccountsChanged(service, item.id, noted);
    } catch (err: any) {
      console.error(`[item accounts] couldn't note ${item.id}'s new accounts in the copy of NetSuite's items: ${err?.message || err}`);
    }
  }

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'detail_changes',
    recordId: body.requestId,
    action: 'change_item_accounts',
    detail: { netsuite_item_id: item.id, item: item.number, kind: ITEM_KINDS[item.recordType].name, changes: plan.changes, sent: plan.body },
  });

  return NextResponse.json({ success: true, changes: plan.changes });
}
