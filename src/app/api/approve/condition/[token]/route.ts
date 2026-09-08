import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  validateExpiry, captureMetadata, checkRateLimit, uploadSignedDocument, getRequestIp,
} from '@/lib/magic-link-approval';
import { validateBody, z } from '@/lib/validate';
import { notifyMany, getSuperAdminIds } from '@/lib/notify';
import { deepLinks } from '@/lib/deep-links';
import { storageDownloadUrl } from '@/lib/storage';
import {
  CONDITION_AGREEMENT_TEXT, conditionContentHash, summarizeCondition, conditionNote,
  fuelLabel, formatOdometer, severityLabel, type DamageRecord,
} from '@/lib/vehicle-condition';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const AckSchema = z.object({
  action: z.enum(['accept', 'reject']),
  reason: z.string().trim().max(1000).optional(),
  agreementText: z.string().max(2000).optional(),
  signerName: z.string().trim().max(120).optional().nullable(),
  timeOnPageSeconds: z.number().int().nonnegative().max(86_400).optional().nullable(),
  deliveryChannel: z.enum(['sms_link', 'email_link']).optional().nullable(),
  deliveryTarget: z.string().max(254).optional().nullable(),
});

const CHECKIN_COLS = 'id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, '
  + 'odometer_miles, fuel_level, damage_note, created_at, '
  + 'condition_token, condition_token_expires_at, condition_sent_at, condition_sent_hash, '
  + 'condition_ack_at, condition_ack_name, condition_ack_agreement_text';

async function loadByToken(token: string) {
  const { data } = await supabase
    .from('fleet_checkins').select(CHECKIN_COLS).eq('condition_token', token).maybeSingle();
  const checkin = data as any;
  if (!checkin?.id) return { checkin: null, records: [] as DamageRecord[] };
  const { data: records } = await supabase
    .from('vehicle_damage_records')
    .select('id, location, severity, description, photo_paths, created_at')
    .eq('checkin_id', checkin.id)
    .order('created_at');
  return { checkin: checkin as any, records: (records || []) as DamageRecord[] };
}

const vehicleLabel = (c: any) =>
  [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ')
  || `VIN ${String(c.vin || '').slice(-8)}`;

/** What the customer sees. Photos go through the credentialed download
 *  route rather than a public URL — the R3-22 rule for every stored read. */
function publicPayload(checkin: any, records: DamageRecord[]) {
  const withUrls = records.map(r => ({
    id: r.id,
    location: r.location,
    severity: r.severity,
    severityLabel: severityLabel(r.severity),
    description: r.description,
    photos: (r.photo_paths || []).map(path => ({
      url: storageDownloadUrl('photos', path, 'damage.jpg'),
    })),
  }));
  return {
    id: checkin.id,
    vehicle: vehicleLabel(checkin),
    vin: checkin.vin,
    customerName: checkin.customer_name,
    receivedAt: checkin.created_at,
    odometer: formatOdometer(checkin.odometer_miles),
    fuel: fuelLabel(checkin.fuel_level),
    // Kept for check-ins recorded before structured findings existed.
    legacyNote: records.length === 0 ? (checkin.damage_note || null) : null,
    findings: withUrls,
    summary: conditionNote(summarizeCondition(records)),
    acknowledgedAt: checkin.condition_ack_at,
    acknowledgedBy: checkin.condition_ack_name,
  };
}

/** GET — render the condition report behind its token. */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'condition_view'))) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  const { checkin, records } = await loadByToken(params.token);
  if (!checkin) return NextResponse.json({ status: 'invalid' });
  if (checkin.condition_ack_at) {
    return NextResponse.json({ status: 'already_approved', condition: publicPayload(checkin, records) });
  }
  const expiry = validateExpiry(checkin.condition_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ status: 'expired' });

  return NextResponse.json({ status: 'ready', condition: publicPayload(checkin, records) });
}

/**
 * POST — acknowledge the record, or say it isn't right.
 *
 * The guard that matters: the condition is re-fingerprinted and compared
 * against the hash frozen at send. Damage edited while the link was live
 * invalidates it rather than being signed for — a customer must never be
 * recorded as having agreed to a record they were never shown.
 */
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const ip = getRequestIp(req);
  if (!(await checkRateLimit(ip, 'condition_ack'))) {
    return NextResponse.json({ error: 'Too many attempts' }, { status: 429 });
  }

  const parsed = await validateBody(req, AckSchema);
  if (parsed.error) return parsed.error;
  const body = parsed.data;

  const { checkin, records } = await loadByToken(params.token);
  if (!checkin) return NextResponse.json({ error: 'This link is not valid.' }, { status: 404 });
  if (checkin.condition_ack_at) {
    return NextResponse.json({ error: 'This condition report was already acknowledged.' }, { status: 409 });
  }
  const expiry = validateExpiry(checkin.condition_token_expires_at);
  if (!expiry.ok) return NextResponse.json({ error: 'This link has expired.' }, { status: 410 });

  const currentHash = conditionContentHash(checkin, records);
  if (checkin.condition_sent_hash && currentHash !== checkin.condition_sent_hash) {
    return NextResponse.json({
      error: 'This condition report changed after the link was sent, so it can’t be acknowledged. '
        + 'BMG has been told and will send a fresh copy.',
    }, { status: 409 });
  }

  const metadata = captureMetadata(req, body);
  const admins = await getSuperAdminIds().catch(() => [] as string[]);

  if (body.action === 'reject') {
    // Disputed at the counter is the best possible time to hear it. The
    // token stays live: the shop fixes the record and re-sends.
    await supabase.from('fleet_checkins').update({
      condition_ack_agreement_text: null,
    }).eq('id', checkin.id);
    if (admins.length > 0) {
      await notifyMany(admins, {
        type: 'condition_disputed',
        title: `⚠ Condition report disputed — ${vehicleLabel(checkin)}`,
        body: (body.reason || 'No reason given.').slice(0, 800),
        url: deepLinks.vehicle(checkin.id),
        channels: ['in_app', 'push'],
      }).catch(() => {});
    }
    return NextResponse.json({ success: true, action: 'reject' });
  }

  // Freeze exactly what they saw, agreement sentence included.
  const agreementText = body.agreementText || CONDITION_AGREEMENT_TEXT;
  const payload = publicPayload(checkin, records);
  const snapshot = renderConditionHtml(payload, agreementText, metadata, body.signerName || null);
  let documentPath: string | null = null;
  let documentHash: string | null = null;
  try {
    const uploaded = await uploadSignedDocument(
      `conditions/${checkin.id}/signed`, snapshot, 'text/html; charset=utf-8',
    );
    documentPath = uploaded.path;
    documentHash = uploaded.hash;
  } catch (err) {
    // The acknowledgment itself still records — losing the snapshot
    // costs the rendered copy, not the fact that they agreed.
    console.error('condition snapshot upload failed:', err);
  }

  const { error } = await supabase.from('fleet_checkins').update({
    condition_ack_at: new Date().toISOString(),
    condition_ack_name: body.signerName || null,
    condition_ack_ip: metadata.ip,
    condition_ack_user_agent: metadata.userAgent,
    condition_ack_agreement_text: agreementText,
    condition_ack_document_path: documentPath,
    condition_ack_document_hash: documentHash,
  }).eq('id', checkin.id).is('condition_ack_at', null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (admins.length > 0) {
    await notifyMany(admins, {
      type: 'condition_acknowledged',
      title: `✓ Condition acknowledged — ${vehicleLabel(checkin)}`,
      body: `${checkin.customer_name || 'The customer'} confirmed the recorded condition. ${payload.summary}`.slice(0, 800),
      url: deepLinks.vehicle(checkin.id),
      channels: ['in_app'],
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, action: 'accept' });
}

const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The frozen record. Plain HTML on purpose — it must still render years
 *  from now with no stylesheet, no fonts and no JavaScript. */
function renderConditionHtml(
  p: any, agreementText: string, metadata: any, signerName: string | null,
): string {
  const findings = p.findings.length === 0
    ? `<p><em>${esc(p.legacyNote || 'No pre-existing damage recorded.')}</em></p>`
    : `<ol>${p.findings.map((f: any) => `<li>
        <strong>${esc(f.severityLabel)}</strong>${f.location ? ` — ${esc(f.location)}` : ''}<br>
        ${esc(f.description)}<br>
        <small>${f.photos.length} photograph${f.photos.length !== 1 ? 's' : ''} on file</small>
      </li>`).join('')}</ol>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Vehicle condition — ${esc(p.vehicle)}</title></head><body>
<h1>Vehicle Condition Report</h1>
<p><strong>${esc(p.vehicle)}</strong><br>VIN ${esc(p.vin)}<br>${esc(p.customerName || '')}</p>
<p>Received: ${esc(p.receivedAt)}</p>
<p>Odometer: ${esc(p.odometer || 'not recorded')} &middot; Fuel: ${esc(p.fuel || 'not recorded')}</p>
<h2>Pre-existing damage</h2>
${findings}
<hr>
<h2>Acknowledgment</h2>
<p>${esc(agreementText)}</p>
<p>Acknowledged by: ${esc(signerName || p.customerName || 'the customer')}<br>
At: ${esc(new Date().toISOString())}<br>
IP: ${esc(metadata.ip)}<br>
User agent: ${esc(metadata.userAgent)}<br>
Time on page: ${esc(metadata.timeOnPageSeconds ?? 'unknown')} seconds<br>
Delivered via: ${esc(metadata.deliveryChannel || 'unknown')}</p>
</body></html>`;
}
