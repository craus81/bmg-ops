import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { fetchAllRows } from '@/lib/fetch-all';
import { normalizeVinRead, vinCheckDigitOk, matchVinRead } from '@/lib/vin-plate';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Overridable so another vision model can be tried without a deploy.
const MODEL = process.env.VIN_READER_MODEL || 'claude-sonnet-5-5';

const service = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const Schema = z.object({
  // Base64 JPEG of one photo, downscaled client-side. The cap refuses
  // pathological payloads aimed at the AI bill.
  image: z.string().min(1).max(8_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
});

const PROMPT = `This photo shows a vehicle's VIN: a stamped or printed VIN plate (dashboard through the windshield, door jamb sticker, or a label). Read the 17-character VIN.

Return ONLY a JSON object, no prose, no code fences:
{ "vin": "the 17 characters as printed, or null if you cannot see a VIN", "alternates": ["other readings if a character is ambiguous"], "partial": "the characters you CAN read if fewer than 17 are legible, else null" }

Rules:
- A VIN never contains I, O or Q. Watch for 0/D, 1/7, 5/S, 8/B, 2/Z, 6/G on worn or angled plates.
- Only list alternates for characters you are genuinely unsure of, at most 3.
- Ignore every other number on the label (tire pressures, weights, dates, part and paint codes).`;

/**
 * POST /api/vin-plate/read
 * A photo of a VIN plate in, the VIN out — checked against the VIN check
 * digit and matched to the vehicles on the lot, so a misread character on a
 * worn plate still finds the right van (only when exactly one is close).
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { image, mimeType } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'VIN photo reading is not configured (no API key).' }, { status: 503 });

  try {
    const res = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }, apiKey);
    if (!res.ok) {
      console.error('vin-plate/read: Claude API error', res.status, (await res.text()).slice(0, 500));
      return NextResponse.json({ error: `The VIN reader is unavailable right now (AI error ${res.status}).` }, { status: 502 });
    }
    const data = await res.json();
    const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const json = extractJson(text) || {};

    const primary = normalizeVinRead(json.vin);
    const reads = [primary, ...(Array.isArray(json.alternates) ? json.alternates : []).map(normalizeVinRead), normalizeVinRead(json.partial)]
      .filter(r => r.length >= 6);
    if (reads.length === 0) {
      return NextResponse.json({ vin: null, checkDigitOk: false, match: null, message: 'No VIN could be read in that photo. Get closer, avoid glare, and try again.' });
    }

    // The lot: vehicles in our custody (same rule as the check-in guard).
    const { data: lot } = await fetchAllRows<{ id: string; vin: string; customer_name: string | null; vehicle_year: string | null; vehicle_make: string | null; vehicle_model: string | null; status: string }>((from, to) =>
      service.from('fleet_checkins')
        .select('id, vin, customer_name, vehicle_year, vehicle_make, vehicle_model, status')
        .is('archived_at', null)
        .neq('status', 'shipped')
        .order('id')
        .range(from, to),
    );
    const strong = reads.find(r => r.length === 17 && vinCheckDigitOk(r)) || null;
    let found = matchVinRead(reads, (lot || []).map(v => String(v.vin || '')).filter(Boolean));
    // Fleet VINs run in sequence, so a van one character away from a read
    // that PASSES the check digit is most likely a different van (one not
    // checked in yet), not a misread. Near matches only rescue failed reads.
    if (found?.kind === 'close' && strong && found.differences > 0) found = null;
    const row = found ? (lot || []).find(v => String(v.vin).toUpperCase() === found!.vin) : null;

    const best = strong || (primary.length === 17 ? primary : null);
    return NextResponse.json({
      vin: best,
      checkDigitOk: !!best && vinCheckDigitOk(best),
      partial: best ? null : reads[0],
      match: found && row ? {
        vin: found.vin,
        kind: found.kind,
        differences: found.differences,
        checkinId: row.id,
        customer: row.customer_name,
        vehicle: [row.vehicle_year, row.vehicle_make, row.vehicle_model].filter(Boolean).join(' ') || null,
        status: row.status,
      } : null,
    });
  } catch (error: any) {
    console.error('vin-plate/read error:', error);
    return NextResponse.json({ error: 'Failed to read the VIN: ' + (error?.message || 'Unknown error') }, { status: 500 });
  }
}

/** The model is asked for bare JSON but sometimes fences it or adds a sentence. */
function extractJson(text: string): any | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const start = stripped.indexOf('{'), end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
}
