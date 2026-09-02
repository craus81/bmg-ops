import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { r2Head } from '@/lib/r2';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Photos are uploaded (presigned PUT to the photos/ prefix) BEFORE this
// route runs, under a client-generated check-in UUID — so the route can
// verify the custody evidence exists before the record does. Paths are
// pinned to that id to stop a caller claiming another record's objects.
const PhotoPath = z.object({
  path: z.string().min(1).max(300),
  kind: z.enum(['before', 'damage']),
});

const numberish = z.union([z.number().finite(), z.string().max(40)]).nullish();

const Schema = z.object({
  id: z.string().uuid(),
  vin: z.string().length(17),
  vehicle_year: z.union([z.string().max(10), z.number()]).nullish(),
  vehicle_make: z.string().max(120).nullish(),
  vehicle_model: z.string().max(160).nullish(),
  vehicle_trim: z.string().max(160).nullish(),
  body_class: z.string().max(160).nullish(),
  netsuite_sales_order_id: z.string().max(40).nullish(),
  sales_order_number: z.string().max(60).nullish(),
  customer_name: z.string().max(240).nullish(),
  customer_id: z.string().uuid().nullish(),
  sales_order_memo: z.string().max(4000).nullish(),
  sales_order_total: numberish,
  proof_file_path: z.string().max(600).nullish(),
  proof_file_name: z.string().max(300).nullish(),
  proof_dropbox_path: z.string().max(800).nullish(),
  proof_url: z.string().max(1200).nullish(),
  proof_filename: z.string().max(300).nullish(),
  notes: z.string().max(8000).nullish(),
  damage_note: z.string().max(2000).nullish(),
  scheduled_upfit_date: z.string().max(30).nullish(),
  promised_back_date: z.string().max(30).nullish(),
  install_instructions: z.string().max(4000).nullish(),
  on_site_contact_name: z.string().max(240).nullish(),
  on_site_contact_phone: z.string().max(60).nullish(),
  delivery_preferences: z.string().max(4000).nullish(),
  source_estimate_id: z.string().uuid().nullish(),
  needs_graphics: z.boolean().nullish(),
  graphics_signal: z.string().max(600).nullish(),
  photoPaths: z.array(PhotoPath).min(1).max(40),
});

/**
 * POST /api/checkins — the one writer for fleet_checkins rows.
 *
 * The ≥1-photo / damage-note custody gate (audit item 12, #713) lived only
 * in the browser: the wizard inserted fleet_checkins directly and uploaded
 * photos afterwards, so any staff console could still create a photo-less
 * check-in (Round 3 caveat 12 — "no check-in API route and no DB
 * constraint"). Migration 249 removes the table's INSERT policy; this route
 * is now the only path, and it holds the invariant the browser couldn't:
 * a check-in row exists only if its condition photos are already in
 * storage (verified by HEAD, paths pinned to this check-in's id) — plus
 * the damage-note and duplicate-VIN (item 13) rules, server-side.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  // ── The custody gate, server-side ──
  const beforePaths = body.photoPaths.filter(p => p.kind === 'before');
  if (beforePaths.length === 0) {
    return NextResponse.json(
      { error: 'At least one condition photo of the vehicle as it arrived is required.' },
      { status: 400 }
    );
  }
  const damagePaths = body.photoPaths.filter(p => p.kind === 'damage');
  if (damagePaths.length > 0 && !body.damage_note?.trim()) {
    return NextResponse.json(
      { error: 'Damage photos need a one-line damage note (what and where).' },
      { status: 400 }
    );
  }

  // Paths must live under THIS check-in's id with the wizard's naming —
  // no traversal, no claiming objects uploaded for another record.
  const pathRe = new RegExp(`^${body.id}/checkin-[A-Za-z0-9._-]{1,120}$`);
  for (const p of body.photoPaths) {
    if (!pathRe.test(p.path)) {
      return NextResponse.json({ error: `Invalid photo path: ${p.path.slice(0, 80)}` }, { status: 400 });
    }
  }

  // The evidence must already be in storage — a path string is not a photo.
  const exists = await Promise.all(body.photoPaths.map(p => r2Head('photos', p.path)));
  const missing = body.photoPaths.filter((_, i) => !exists[i]);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Photo upload incomplete — ${missing.length} of ${body.photoPaths.length} photos never reached storage. Retry the save.` },
      { status: 400 }
    );
  }

  const vin = body.vin.trim().toUpperCase();

  try {
    // Duplicate-VIN guard (item 13's rule, now enforced where it can't be
    // raced by a second tab): only ACTIVE custody blocks — archived or
    // shipped visits are history, and a returning vehicle starts a new one.
    const { data: active } = await supabase
      .from('fleet_checkins')
      .select('id, customer_name, status, created_at')
      .eq('vin', vin)
      .is('archived_at', null)
      .neq('status', 'shipped')
      .order('created_at', { ascending: false })
      .limit(1);
    if (active && active.length > 0) {
      return NextResponse.json(
        {
          error: `This VIN is already checked in (${new Date(active[0].created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${active[0].customer_name ? `, ${active[0].customer_name}` : ''}). Update that vehicle instead of checking it in twice.`,
          code: 'duplicate_vin',
          existingCheckinId: active[0].id,
        },
        { status: 409 }
      );
    }

    const { data: profileRow } = await supabase
      .from('profiles')
      .select('company_id')
      .eq('id', auth.user.id)
      .maybeSingle();

    // The stored notes compose here so the damage context can't be dropped
    // by a caller that passed damage photos but left it out of free text.
    const notes = [
      body.damage_note?.trim() ? `DAMAGE ON ARRIVAL: ${body.damage_note.trim()}` : null,
      body.notes?.trim() || null,
    ].filter(Boolean).join('\n\n') || null;

    const { data: checkin, error: insertErr } = await supabase
      .from('fleet_checkins')
      .insert({
        id: body.id,
        vin,
        vehicle_year: body.vehicle_year != null ? String(body.vehicle_year) : null,
        vehicle_make: body.vehicle_make || null,
        vehicle_model: body.vehicle_model || null,
        vehicle_trim: body.vehicle_trim || null,
        body_class: body.body_class || null,
        netsuite_sales_order_id: body.netsuite_sales_order_id || null,
        sales_order_number: body.sales_order_number || null,
        customer_name: body.customer_name || null,
        customer_id: body.customer_id || null,
        sales_order_memo: body.sales_order_memo || null,
        sales_order_total: body.sales_order_total ?? null,
        proof_file_path: body.proof_file_path || null,
        proof_file_name: body.proof_file_name || null,
        proof_dropbox_path: body.proof_dropbox_path || null,
        proof_url: body.proof_url || null,
        proof_filename: body.proof_filename || null,
        notes,
        status: 'received',
        checked_in_by: auth.user.id,
        company_id: profileRow?.company_id || null,
        scheduled_upfit_date: body.scheduled_upfit_date || null,
        promised_back_date: body.promised_back_date || null,
        install_instructions: body.install_instructions || null,
        on_site_contact_name: body.on_site_contact_name || null,
        on_site_contact_phone: body.on_site_contact_phone || null,
        delivery_preferences: body.delivery_preferences || null,
        source_estimate_id: body.source_estimate_id || null,
        needs_graphics: !!body.needs_graphics,
        graphics_signal: body.graphics_signal || null,
      })
      .select()
      .single();

    if (insertErr || !checkin) {
      const dup = (insertErr as any)?.code === '23505';
      return NextResponse.json(
        { error: dup ? 'A check-in with this id already exists — retry the save.' : (insertErr?.message || 'Check-in insert failed') },
        { status: dup ? 409 : 500 }
      );
    }

    // Photo rows — the queryable half of the evidence. The invariant is
    // "check-in row ⇒ at least one condition photo row": if every 'before'
    // row fails, roll the check-in back and report, rather than leaving
    // exactly the photo-less record this route exists to prevent.
    let photoRowFailures = 0;
    let beforeRows = 0;
    for (const p of body.photoPaths) {
      const { error: photoErr } = await supabase.from('vehicle_photos').insert({
        vehicle_id: checkin.id,
        storage_path: p.path,
        photo_type: p.kind,
        taken_by: auth.user.id,
      });
      if (photoErr) photoRowFailures++;
      else if (p.kind === 'before') beforeRows++;
    }
    if (beforeRows === 0) {
      await supabase.from('fleet_checkins').delete().eq('id', checkin.id);
      return NextResponse.json(
        { error: 'The check-in could not record its condition photos — nothing was saved. Retry.' },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, checkin, photoRowFailures });
  } catch (e: any) {
    console.error('check-in create failed:', e);
    return NextResponse.json({ error: e.message || 'Check-in failed' }, { status: 500 });
  }
}
