import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, validateSearchParams, z } from '@/lib/validate';
import { generateToken } from '@/lib/magic-link-approval';
import {
  conditionContentHash, canSendForAcknowledgment, SEVERITIES, FUEL_LEVELS,
  type DamageRecord,
} from '@/lib/vehicle-condition';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GetSchema = z.object({ checkinId: z.string().uuid() });

const FindingSchema = z.object({
  location: z.string().trim().max(120).optional().nullable(),
  severity: z.enum(SEVERITIES),
  description: z.string().trim().min(1).max(1000),
  photoPaths: z.array(z.string().max(500)).max(20).optional().default([]),
});

const SaveSchema = z.object({
  checkinId: z.string().uuid(),
  odometerMiles: z.number().int().min(0).max(3_000_000).optional().nullable(),
  fuelLevel: z.enum(FUEL_LEVELS).optional().nullable(),
  findings: z.array(FindingSchema).max(40).optional(),
  /** Mint a fresh acknowledgment token and freeze the content hash. */
  send: z.boolean().optional().default(false),
});

/** GET — the condition record for a check-in. */
export async function GET(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;
  const parsed = validateSearchParams(req, GetSchema);
  if (parsed.error) return parsed.error;

  const { data: checkin } = await supabase
    .from('fleet_checkins')
    .select('id, odometer_miles, fuel_level, damage_note, condition_token, condition_token_expires_at, condition_sent_at, condition_ack_at, condition_ack_name, condition_ack_document_path')
    .eq('id', parsed.data.checkinId)
    .maybeSingle();
  if (!checkin) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });

  const { data: findings } = await supabase
    .from('vehicle_damage_records')
    .select('id, location, severity, description, photo_paths, created_at')
    .eq('checkin_id', parsed.data.checkinId)
    .order('created_at');

  return NextResponse.json({ success: true, checkin, findings: findings || [] });
}

/**
 * POST — save the condition record, and optionally mint the customer's
 * acknowledgment link.
 *
 * Saving REPLACES the finding set, which is why the hash is frozen at
 * send: an edit after that invalidates a live link rather than silently
 * changing what the customer is agreeing to.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, SaveSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { data: existing } = await supabase
    .from('fleet_checkins').select('id, condition_ack_at').eq('id', body.checkinId).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Check-in not found' }, { status: 404 });
  if (existing.condition_ack_at) {
    // Once a customer has signed for a record, it stops being editable —
    // otherwise the signature attaches to something they never saw.
    return NextResponse.json({
      error: 'The customer already acknowledged this condition report, so it can no longer be changed.',
    }, { status: 409 });
  }

  if (body.findings) {
    const { error: delErr } = await supabase
      .from('vehicle_damage_records').delete().eq('checkin_id', body.checkinId);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    if (body.findings.length > 0) {
      const { error: insErr } = await supabase.from('vehicle_damage_records').insert(
        body.findings.map(f => ({
          checkin_id: body.checkinId,
          location: f.location?.trim() || null,
          severity: f.severity,
          description: f.description,
          photo_paths: f.photoPaths || [],
          recorded_by: auth.user.id,
        })),
      );
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  const patch: Record<string, unknown> = {};
  if (body.odometerMiles !== undefined) patch.odometer_miles = body.odometerMiles;
  if (body.fuelLevel !== undefined) patch.fuel_level = body.fuelLevel;

  let token: string | null = null;
  if (body.send) {
    const { data: records } = await supabase
      .from('vehicle_damage_records')
      .select('location, severity, description, photo_paths')
      .eq('checkin_id', body.checkinId);

    const state = {
      odometer_miles: (body.odometerMiles !== undefined ? body.odometerMiles : null),
      fuel_level: (body.fuelLevel !== undefined ? body.fuelLevel : null),
    };
    const gate = canSendForAcknowledgment(state, (records || []) as DamageRecord[]);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 400 });

    const minted = generateToken(30);
    token = minted.token;
    patch.condition_token = minted.token;
    patch.condition_token_expires_at = minted.expiresAt;
    patch.condition_sent_at = new Date().toISOString();
    patch.condition_sent_hash = conditionContentHash(state, (records || []) as DamageRecord[]);
  }

  if (Object.keys(patch).length > 0) {
    const { error } = await supabase.from('fleet_checkins').update(patch).eq('id', body.checkinId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    token,
    url: token ? `/approve/condition/${token}` : null,
  });
}
