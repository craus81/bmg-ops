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
import { customerFacts, parseTermsCustomer, planCustomerTerms, type TermsCustomer, type TermsOption } from '@/lib/customer-terms';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const service = createServiceClient();

const OFF = `Changing customer and vendor details is switched off until ${SWITCH_ON_DATE_TEXT}.`;

type Auth = Awaited<ReturnType<typeof requireFeature>>;

/**
 * Anyone with Credit Applications who can see prices, the people who approve a customer's terms, once customer and
 * vendor details are switched on (Books → Switches); until then only super admins, to see what a change would send.
 */
async function access(req: NextRequest): Promise<{ auth: Auth; on: boolean; error?: NextResponse }> {
  const auth = await requireFeature(req, 'credit_applications');
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

/** The customer as NetSuite has it now. */
async function readCustomer(id: string): Promise<{ customer: TermsCustomer } | { error: string; status: number }> {
  const rec = await getEntityRecord('customer', id);
  if (!rec.success) return { error: rec.notFound ? `NetSuite has no customer with id ${id}.` : rec.error, status: rec.notFound ? 404 : 502 };
  return { customer: parseTermsCustomer(rec.record) };
}

/** What the change is worked out against, short: anything different means the customer changed while the page was open. */
const signatureOf = (c: TermsCustomer) => createHash('sha256').update(customerFacts(c)).digest('hex').slice(0, 32);

const termsMap = (terms: TermsOption[]) => new Map(terms.map((t) => [t.id, t]));

/** Customers in the copy of NetSuite's customer list with every word typed in their name, active ones first. */
async function findCustomers(typed: string) {
  const words = typed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let q = service.from('gl_netsuite_lists').select('netsuite_id, name, active, details').eq('kind', 'customer').is('gone_at', null);
  if (words.length > 0) q = q.ilike('name', `%${words.slice(0, 6).join('%')}%`);
  const { data, error } = await q.order('active', { ascending: false }).order('name', { ascending: true }).order('netsuite_id').limit(15);
  if (error) throw new Error(`couldn't search the copy of NetSuite's customers (${error.message})`);
  return ((data ?? []) as Array<{ netsuite_id: string; name: string; active: boolean; details: { entity_id?: string } | null }>)
    .map((r) => ({ id: r.netsuite_id, name: r.name, entityId: r.details?.entity_id ?? null, active: r.active }));
}

/**
 * GET /api/customer-terms?status=1 — whether customer and vendor details are on, and whether this person can change a
 * customer's terms.
 * GET ?find=<typed> — customers from the copy of NetSuite's customer list by name, active ones first.
 * GET ?customer=<NetSuite id> — the customer's terms and credit limit as NetSuite has them now, NetSuite's terms, what a
 * change is planned against, and the changes FleetSuite made to it.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get('status')) {
    const auth = await requireFeature(req, 'credit_applications');
    if (auth.error) return auth.error;
    const on = await switchIsOn(service, 'customer_vendor_details');
    const money = await profileCanSeeMoney(auth.user.id, auth.profile);
    return NextResponse.json({ on, canUse: money && (on || getProfileRoles(auth.profile).includes('super_admin')) });
  }

  const gate = await access(req);
  if (gate.error) return gate.error;

  try {
    if (params.has('find')) return NextResponse.json({ customers: await findCustomers(params.get('find') || '') });

    const id = (params.get('customer') || '').trim();
    if (!/^\d+$/.test(id)) return NextResponse.json({ error: 'Bad customer id' }, { status: 400 });
    const read = await readCustomer(id);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    const [terms, changes] = await Promise.all([listTerms(service), readDetailChanges(service, 'customer', id)]);
    return NextResponse.json({
      customer: read.customer,
      terms,
      signature: signatureOf(read.customer),
      changes,
      switchedOn: gate.on,
      offText: gate.on ? null : `${OFF} You can see what a change would send; nothing goes to NetSuite.`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }
}

const Schema = z.object({
  // Made by the page when the screen opens: the same form pressed twice is one change.
  requestId: z.string().uuid(),
  customerId: z.string().regex(/^\d{1,20}$/),
  // What the page planned against (GET's signature). The customer can change in NetSuite while the page is open: then
  // nothing is sent.
  signature: z.string().min(1).max(100),
  reason: z.string().max(1000),
  termsId: z.string().regex(/^\d{0,20}$/).optional(),
  creditLimit: z.number().nullable().optional(),
});

/**
 * POST /api/customer-terms — change the customer's terms or credit limit in NetSuite. What changes and what NetSuite is
 * sent are worked out here from the customer as NetSuite has it now, never taken from the page. Refused while customer
 * and vendor details are switched off, for everyone.
 */
export async function POST(req: NextRequest) {
  const gate = await access(req);
  if (gate.error) return gate.error;
  const { auth } = gate;
  if (!gate.on) return NextResponse.json({ error: `${OFF} Nothing was sent to NetSuite.`, switchedOff: true }, { status: 403 });

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  let customer: TermsCustomer;
  let terms: TermsOption[];
  try {
    const read = await readCustomer(body.customerId);
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: read.status });
    customer = read.customer;
    if (signatureOf(customer) !== body.signature) {
      return NextResponse.json({
        error: `${customer.name} changed in NetSuite since this page opened. Nothing was sent. Reload it and make the change again.`,
        stale: true,
      }, { status: 409 });
    }
    terms = await listTerms(service);
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || String(err) }, { status: 500 });
  }

  const plan = planCustomerTerms(customer, body, { terms: termsMap(terms) });
  if (plan.problems.length > 0) return NextResponse.json({ error: plan.problems.join(' '), problems: plan.problems }, { status: 400 });

  // One send per form, and one change of a customer at a time: take the claim, or say what's in the way.
  const claim = await service.rpc('detail_change_claim', {
    p: {
      id: body.requestId,
      record_type: 'customer',
      netsuite_id: customer.id,
      name: customer.name,
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
        ? "This change is being sent now. Don't press again: reload the customer in a minute to see it."
        : `Another change of ${customer.name} is being sent now. Reload it in a minute and check it before changing it again.`,
    }, { status: 409 });
  }

  const finish = (p: Record<string, unknown>) => service.rpc('detail_change_finish', { p: { id: body.requestId, ...p } });

  const result = await patchEntityRecord('customer', customer.id, plan.body);
  if (!result.success) {
    const error = result.error || "NetSuite didn't answer";
    await finish({ status: result.unsure ? 'unsure' : 'refused', error });
    // NetSuite's own words, without the full stop they may end with, so the sentence reads on.
    const said = error.replace(/[.\s]+$/, '');
    return NextResponse.json(result.unsure
      ? {
        error: `${said}, so FleetSuite can't tell whether the change went in. Reload the customer: if the change is there, it went in; if it isn't, make it again.`,
        unsure: true,
      }
      : { error: `NetSuite didn't take the change: ${said}. Nothing changed.` }, { status: 502 });
  }

  const done = await finish({ status: 'changed' });
  // The change is in NetSuite either way; a row left sending shows as unsure after five minutes.
  if (done.error) console.error(`[customer terms] ${body.requestId} went in but wasn't marked changed: ${done.error.message}`);

  // Books' own invoices fall due by the customer's terms in the copy of NetSuite's customer list: it takes them now.
  const termsId = (plan.body.terms as { id?: string } | undefined)?.id;
  if (termsId) {
    try {
      await noteTermsChanged(service, 'customer', customer.id, termsId);
    } catch (err: any) {
      console.error(`[customer terms] couldn't note ${customer.id}'s new terms in the copy of NetSuite's customers: ${err?.message || err}`);
    }
  }

  await logAudit(service, {
    actorId: auth.user.id,
    table: 'detail_changes',
    recordId: body.requestId,
    action: 'change_customer',
    detail: { netsuite_customer_id: customer.id, customer: customer.name, changes: plan.changes, sent: plan.body },
  });

  return NextResponse.json({ success: true, changes: plan.changes });
}
