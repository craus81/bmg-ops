import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { requireStaff } from '@/lib/api-auth';
import { canManageHolds, loadHold, holdAudience } from '@/lib/customer-hold-server';
import { isOnHold } from '@/lib/customer-hold';
import { notifyMany } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/customer-holds — { canManage }: may the caller hold, release and
 *      override (admins and the A/R contacts)?
 * POST /api/customer-holds — { netsuiteId, action: 'hold' | 'release' | 'clear', note? }
 *      'hold' forces a hold, 'release' keeps the customer off hold whatever
 *      the 7 AM sweep finds (payment plan, trusted account), 'clear' hands
 *      it back to the sweep. The rep and the A/R contacts hear about it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const service = createServiceClient();
  return NextResponse.json({ canManage: await canManageHolds(service, auth) });
}

export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const service = createServiceClient();
  if (!(await canManageHolds(service, auth))) {
    return NextResponse.json({ error: 'Only admins and A/R can hold or release a customer' }, { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const netsuiteId = String(body?.netsuiteId || '').trim();
  const action = body?.action;
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : '';
  if (!/^\d{1,15}$/.test(netsuiteId)) return NextResponse.json({ error: 'netsuiteId required' }, { status: 400 });
  if (!['hold', 'release', 'clear'].includes(action)) return NextResponse.json({ error: 'action must be hold, release or clear' }, { status: 400 });
  if (action !== 'clear' && !note) return NextResponse.json({ error: 'Give a reason' }, { status: 400 });

  const before = await loadHold(service, { netsuiteId });
  const { data: cust } = await service.from('customers').select('id, company_name').eq('netsuite_id', netsuiteId).maybeSingle();
  const name = before?.customer_name || (cust as any)?.company_name || body?.customerName || `Customer #${netsuiteId}`;

  const row = {
    netsuite_customer_id: netsuiteId,
    customer_id: before?.customer_id || (cust as any)?.id || null,
    customer_name: name,
    manual: action === 'clear' ? null : action,
    manual_note: action === 'clear' ? null : note,
    manual_by: action === 'clear' ? null : auth.user.id,
    manual_at: action === 'clear' ? null : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data: saved, error } = await service.from('customer_holds').upsert(row, { onConflict: 'netsuite_customer_id' }).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const wasHeld = isOnHold(before);
  const nowHeld = isOnHold(saved as any);
  if (wasHeld !== nowHeld) {
    const audience = (await holdAudience(service, netsuiteId, row.customer_id)).filter(id => id !== auth.user.id);
    if (audience.length > 0) {
      const { data: me } = await service.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
      const who = (me as any)?.full_name || auth.user.email || 'Someone';
      await notifyMany(audience, {
        type: 'customer_hold',
        title: nowHeld ? `⛔ ${name} is on hold` : `✅ ${name} is off hold`,
        body: nowHeld
          ? `${who} put ${name} on hold: ${note}\nNew estimates, quotes and sales orders need an admin or A/R override until it's lifted.`
          : `${who} took ${name} off hold${note ? `: ${note}` : ''}.`,
        url: deepLinks.customerByNetsuiteId(netsuiteId),
        channels: ['in_app', 'push', 'email'],
      });
    }
  }

  return NextResponse.json({ success: true, hold: saved, onHold: nowHeld });
}
