import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase-service';
import { profileCanSeeMoney, requireFeature } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { notifyMany } from '@/lib/notify';
import { newAlertWatcherIds } from '@/lib/new-alert-watchers';
import { deepLinks } from '@/lib/deep-links';
import { logAudit } from '@/lib/audit';
import { loadPoForEdit, savePoEdit } from '@/lib/po-edit-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Edit PO on Purchasing → Vendor POs (Craig, 2026-11-06; rules in
 * src/lib/po-edit.ts). [id] is the netsuite_vendor_pos row.
 *
 *   GET   the PO read live from NetSuite: header, lines, what each line is for.
 *   PATCH { lastModified, header?, lines?, adds?, moveTo? } saves it in
 *         NetSuite (refused when NetSuite's copy changed since the GET).
 *
 * Anyone with parts ordering (Craig picked that over admins only); prices
 * only for people with see_prices. Every
 * save tells Craig (bell, push and email) through "Copy me on new alerts",
 * and nobody else; the vendor is never emailed by itself.
 */

const ShipToSchema = z.object({
  name: z.string().max(200),
  attention: z.string().max(200),
  address: z.string().max(300),
  address2: z.string().max(300),
  city: z.string().max(100),
  state: z.string().max(50),
  zip: z.string().max(20),
  phone: z.string().max(50),
});

const Schema = z.object({
  lastModified: z.string().max(100).nullable(),
  header: z.object({
    memo: z.string().max(999).optional(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    shipTo: ShipToSchema.optional(),
  }).optional(),
  lines: z.array(z.object({
    line: z.number().int(),
    quantity: z.number().min(0).max(100000).optional(),
    rate: z.number().min(0).max(1000000).nullable().optional(),
    remove: z.boolean().optional(),
    move: z.boolean().optional(),
  })).max(200).optional(),
  adds: z.array(z.object({
    itemId: z.string().regex(/^\d+$/).max(20),
    itemNumber: z.string().max(100),
    quantity: z.number().positive().max(100000),
    rate: z.number().min(0).max(1000000).nullable(),
    description: z.string().max(500).nullable(),
  })).max(50).optional(),
  moveTo: z.object({
    vendorNetsuiteId: z.string().regex(/^\d+$/, 'Pick a NetSuite vendor').max(20),
    vendorName: z.string().max(200).nullable(),
  }).nullable().optional(),
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  if (!z.string().uuid().safeParse(params.id).success) return NextResponse.json({ error: 'Invalid PO id' }, { status: 400 });
  const loaded = await loadPoForEdit(createServiceClient(), params.id);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: loaded.status });
  // Prices only for people who may see money (see_prices).
  const seeMoney = await profileCanSeeMoney(auth.user.id, auth.profile);
  const lines = seeMoney ? loaded.view.lines : loaded.view.lines.map(l => ({ ...l, rate: null }));
  return NextResponse.json({ success: true, ...loaded.view, lines, canSeeMoney: seeMoney });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireFeature(req, 'parts_ordering');
  if (auth.error) return auth.error;
  if (!z.string().uuid().safeParse(params.id).success) return NextResponse.json({ error: 'Invalid PO id' }, { status: 400 });
  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;

  // Without see_prices, prices stay as they are: none sent, none changed.
  if (!(await profileCanSeeMoney(auth.user.id, auth.profile))) {
    if ((parsed.data.lines || []).some(l => l.rate != null)) {
      return NextResponse.json({ error: 'Only people who can see prices can change them.' }, { status: 403 });
    }
    for (const a of parsed.data.adds || []) a.rate = null;
  }

  const service = createServiceClient();
  const who = auth.profile?.full_name || auth.user.email || 'Someone';
  const res = await savePoEdit(service, params.id, parsed.data, { id: auth.user.id, name: who });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  const po = res.poNumber ? `PO ${res.poNumber}` : 'A PO';
  // Never throws (audit.ts).
  await logAudit(service, {
    actorId: auth.user.id,
    table: 'netsuite_vendor_pos',
    recordId: params.id,
    action: 'vendor_po_edited',
    detail: { purchaseOrder: res.poNumber, changes: res.changes, requeued: res.requeued, movedTo: res.movedTo?.number || null, warning: res.warning || null },
  });

  // Craig hears about every edit (his pick: just him), not the person who made it.
  try {
    const to = (await newAlertWatcherIds(service)).filter(id => id !== auth.user.id);
    if (to.length > 0 && (res.changes.length > 0 || res.warning)) {
      const lines = [
        ...res.changes,
        ...(res.requeued.length ? [`Back in the parts queue for ${res.requeued.join(', ')}`] : []),
        ...(res.warning ? [res.warning] : []),
      ];
      await notifyMany(to, {
        type: 'vendor_po_edited',
        title: `✎ ${po}${res.vendorName ? ` (${res.vendorName})` : ''} edited by ${who}`,
        body: lines.join('\n').slice(0, 900),
        url: deepLinks.vendorPo(res.poNumber || ''),
        channels: ['in_app', 'push', 'email'],
      });
    }
  } catch (err) {
    console.error('vendor po edit: alert failed', err);
  }

  return NextResponse.json({ success: true, ...res });
}
