import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createServiceClient } from '@/lib/supabase-service';
import { getProfileRoles, profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { getEntityRecord, patchEntityRecord } from '@/lib/netsuite';
import { SWITCH_ON_DATE_TEXT, switchIsOn } from '@/lib/books/switches';
import { listTerms, noteTermsChanged } from '@/lib/books/netsuite-lists';
import { logAudit } from '@/lib/audit';
import { readDetailChanges } from '@/lib/detail-changes';
import {
  ADDRESS_MAX, EMAIL_MAX, LEGAL_NAME_MAX, PHONE_MAX, REASON_MAX, parseDetailsVendor, planVendorDetails, vendorFacts,
  withoutTaxId, type DetailsVendor, type TermsOption,
} from '@/lib/vendor-details';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Changing customer and vendor details is switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

/**
 * Anyone with Payments who can see prices, once customer and vendor details are switched on (Books → Switches), as
 * card charges are coded; until then only super admins, to see what a change would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'vendor_payments');
  if (auth.error) return { auth, on: false, error: auth.error };
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    return { auth, on: false, error: NextResponse.json({ error: 'Forbidden: this account cannot see billing' }, { status: 403 }) };
  }
  const on = await switchIsOn(service, 'customer_vendor_details');
  if (!on && !getProfileRoles(auth.profile).includes('super_admin')) {
    return { auth, on, error: NextResponse.json({ error: OFF, switchedOff: true }, { status: 403 }) };
  }
  return { auth, on };
}

/** The vendor as NetSuite has it now. */
async function readVendor(id: string): Promise<{ vendor: DetailsVendor } | { error: string; status: number }> {
  const rec = await getEntityRecord('vendor', id);
  if (!rec.success) return { error: rec.notFound ? `NetSuite has no vendor with id ${id}.` : rec.error, status: rec.notFound ? 404 : 502 };
  return { vendor: parseDetailsVendor(rec.record) };
}

/** What the change is worked out against, short: anything different means the vendor changed while the page was open. */
const signatureOf = (v: DetailsVendor) => createHash('sha256').update(vendorFacts(v)).digest('hex').slice(0, 32);

const termsMap = (terms: TermsOption[]) => new Map(terms.map((t) => [t.id, t]));

/** Vendors in the copy of NetSuite's vendor list with every word typed in their name, active ones first. */
async function findVendors(typed: string) {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let q = service.from('gl_netsuite_lists').select('netsuite_id, name, active, details').eq('kind', 'vendor').is('gone_at', null);
  if (words.length > 0) q = q.ilike('name', `%${words.slice(0, 6).join('%')}%`);
  const { data, error } = await q.order('active', { ascending: false }).order('name', { ascending: true }).order('netsuite_id').limit(15);
  if (error) throw new Error(`couldn't search the copy of NetSuite's vendors (${error.message})`);
  return ((data ?? []) as Array<{ netsuite_id: string; name: string; active: boolean; details: { entity_id?: string } | null }>)
    .map((r) => ({ id: r.netsuite_id, name: r.name, entityId: r.details?.entity_id ?? null, active: r.active }));
}

/**
 * GET /api/vendor-details?status=1 — whether customer and vendor details are on, and whether this person can change a
 * vendor's.
 * GET ?find=<typed> — vendors from the copy of NetSuite's vendor list by name, active ones first.
 * GET ?vendor=<NetSuite id> — the vendor as NetSuite has it now (its tax ID only as the four digits it ends with),
 * NetSuite's terms, what a change is planned against, and the changes FleetSuite made to it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'vendor_payments');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'customer_vendor_details');
    const money = await profileCanSeeMoney(auth.user.id, auth.profile);
    return NextResponse.json({ on, canUse: money && (on || getProfileRoles(auth.profile).includes('super_admin')) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    if (params.has('find')) return NextResponse.json({ vendors: await findVendors(params.get('find') || '') });

    const id = (params.get('vendor') || '').trim();
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad vendor id' }, { status: 400 });
    const read = await readVendor(id);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    const [terms, changes] = await Promise.all([listTerms(service), readDetailChanges(service, 'vendor', id)]);
    return NextResponse.json({
      vendor: read.vendor,
      terms,
      signature: signatureOf(read.vendor),
      changes,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what a change would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const netsuiteId = z.string().regex(/^\d{1,20}$/);
const field = (max: number) => z.string().max(max);
const Address = z.object({
  lineId: z.string().regex(/^(\d{1,20}|new)$/),
  addressee: field(ADDRESS_MAX.addressee),
  attention: field(ADDRESS_MAX.attention),
  addr1: field(ADDRESS_MAX.addr1),
  addr2: field(ADDRESS_MAX.addr2),
  city: field(ADDRESS_MAX.city),
  state: field(ADDRESS_MAX.state),
  zip: field(ADDRESS_MAX.zip),
});
const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one change.
  requestId: z.string().uuid(),
  vendorId: netsuiteId,
  // What the page planned against (GET's signature). The vendor can change in NetSuite while the page is open: then
  // nothing is sent.
  signature: z.string().min(1).max(100),
  reason: z.string().max(1000),
  email: field(EMAIL_MAX + 50).optional(),
  phone: field(PHONE_MAX + 50).optional(),
  termsId: z.string().regex(/^\d{0,20}$/).optional(),
  is1099: z.boolean().optional(),
  legalName: field(LEGAL_NAME_MAX + 50).optional(),
  taxId: field(40).optional(),
  addresses: z.array(Address).max(50).optional(),
  billingLineId: z.string().regex(/^(\d{1,20}|new)$/).optional(),
});

/**
 * POST /api/vendor-details — change the vendor in NetSuite. What changes and what NetSuite is sent are worked out here
 * from the vendor as NetSuite has it now, never taken from the page. A tax ID typed goes to NetSuite and nowhere else.
 * Refused while customer and vendor details are switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  let vendor: DetailsVendor;
  let terms: TermsOption[];
  try {
    const read = await readVendor(body.vendorId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    vendor = read.vendor;
    if (signatureOf(vendor) !== body.signature) {
      return NextResponse.json({
        error: `${vendor.name} changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.`,
        stale: true,
      }, { status: 409 });
    }
    terms = await listTerms(service);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }

  const plan = planVendorDetails(vendor, body, { terms: termsMap(terms) });
  if (plan.problems.length > 0) return NextResponse.json({ error: plan.problems.join(' '), problems: plan.problems }, { status: 400 });

  // One send per form, and one change of a vendor at a time: take the claim, or say what's in the way.
  const claim = await service.rpc('detail_change_claim', {
    p: {
      id: body.requestId,
      record_type: 'vendor',
      netsuite_id: vendor.id,
      name: vendor.name,
      reason: body.reason.trim(),
      changes: plan.changes,
      patch: plan.keptBody,
      by: auth.user.id,
    },
  });
  if (claim.error) return NextResponse.json({ error: claim.error.message }, { status: 500 });
  const claimed = claim.data as { claimed?: boolean; state?: string } | null;
  if (!claimed?.claimed) {
    if (claimed?.state === 'changed') return NextResponse.json({ success: true, already: true, changes: plan.changes });
    return NextResponse.json({
      error: claimed?.state === 'sending'
        ? "This change is being sent now. Don't press again: reload the vendor in a minute to see it."
        : `Another change of ${vendor.name} is being sent now. Reload it in a minute and check it before changing it again.`,
    }, { status: 409 });
  }

  const finish = (p: Record<string, unknown>) => service.rpc('detail_change_finish', { p: { id: body.requestId, ...p } });

  const result = await patchEntityRecord('vendor', vendor.id, plan.body);
  if (!result.success) {
    const error = withoutTaxId(result.error || "NetSuite didn't answer", plan.body.taxIdNum);
    await finish({ status: result.unsure ? 'unsure' : 'refused', error });
    // NetSuite's own words, without the full stop they may end with, so the sentence reads on.
    const said = error.replace(/[.\s]+$/, '');
    return NextResponse.json(result.unsure
      ? {
        error: `${said}, so FleetSuite can't tell whether the change went in. Reload the vendor: if the change is there, it went in; if it isn't, make it again.`,
        unsure: true,
      }
      : { error: `NetSuite didn't take the change: ${said}. Nothing changed.` }, { status: 502 });
  }

  const done = await finish({ status: 'changed' });
  // The change is in NetSuite either way; a row left sending shows as unsure after five minutes.
  if (done.error) console.error(`[vendor details] ${body.requestId} went in but wasn't marked changed: ${done.error.message}`);

  // Snap a bill's bills fall due by the vendor's terms in the copy of NetSuite's vendor list: it takes them now.
  const termsId = (plan.body.terms as { id?: string } | undefined)?.id;
  if (termsId) {
    try {
      await noteTermsChanged(service, 'vendor', vendor.id, termsId);
    } catch (err: any) {
      console.error(`[vendor details] couldn't note ${vendor.id}'s new terms in the copy of NetSuite's vendors: ${err?.message || err}`);
    }
  }

  // FleetSuite's own vendor list takes the new email, phone and terms now, not at its next copy of NetSuite's: once
  // FleetSuite's record wins (part 48, src/lib/fleetsuite-records.ts), that copy keeps the email and phone FleetSuite
  // has, and would list the new ones as changed in NetSuite.
  const listed: Record<string, string | null> = {};
  if ('email' in plan.body) listed.email = String(plan.body.email ?? '').trim() || null;
  if ('phone' in plan.body) listed.phone = String(plan.body.phone ?? '').trim() || null;
  const termsName = termsId ? terms.find((t) => t.id === termsId)?.name : undefined;
  if (termsName) listed.terms = termsName;
  if (Object.keys(listed).length) {
    const { error: listError } = await service.from('netsuite_vendors').update(listed).eq('netsuite_id', vendor.id);
    if (listError) console.error(`[vendor details] couldn't note ${vendor.id}'s change in FleetSuite's vendor list: ${listError.message}`);
  }

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'detail_changes',
    recordId: body.requestId,
    action: 'change_vendor',
    detail: { netsuite_vendor_id: vendor.id, vendor: vendor.name, changes: plan.changes, sent: plan.keptBody },
  });

  return NextResponse.json({ success: true, changes: plan.changes });
}
