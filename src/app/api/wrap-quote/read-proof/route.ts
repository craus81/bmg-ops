import { NextRequest, NextResponse } from 'next/server';
import { requireStaff } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';
import { callAnthropicWithRetry } from '@/lib/anthropic';
import { sanitizeProofRead } from '@/lib/proof-sizing';

// Reading one page of a customer's proof can take a while on a busy page.
export const maxDuration = 120;

// The proof reader's eyes. Overridable so a better vision model can be tried
// without a deploy.
const MODEL = process.env.PROOF_READER_MODEL || 'claude-opus-5';

const Schema = z.object({
  // Base64 JPEG/PNG of ONE page, downscaled client-side to ~1600 px on the
  // long edge. The cap refuses pathological payloads aimed at the AI bill.
  image: z.string().min(1).max(8_000_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
});

const PROMPT = `You are reading ONE page of a vehicle graphics proof (a customer's decal layout drawing) for a wrap shop's estimator. Return ONLY a JSON object — no prose, no code fences — shaped exactly like this:

{
  "page_title": "short name for this page, e.g. 'Driver side' or 'Side views', or null",
  "views": [
    { "kind": "driver_side", "label": "Driver side", "box": { "x": 0.05, "y": 0.20, "w": 0.60, "h": 0.35 } }
  ],
  "size_table": [
    { "name": "Door logo", "width_in": 24, "height_in": 12.5, "qty": 2 }
  ],
  "decals": [
    { "name": "Door logo", "view": 0, "box": { "x": 0.21, "y": 0.33, "w": 0.08, "h": 0.05 }, "size_table_index": 0 }
  ]
}

Rules:
- Every box is in fractions of the page's full width and height, 0 to 1: x and y are the top-left corner, w and h the size.
- views: one entry per drawing of the vehicle on the page. kind is one of driver_side, passenger_side, front, rear, roof, hood, other. The driver side is the view where the vehicle's FRONT points LEFT (US left-hand drive); the passenger side has the front pointing RIGHT. The view box covers the whole vehicle drawing including its wheels.
- decals: one entry per separate piece of artwork applied to the vehicle — each logo, lettering block, stripe, phone number, web address, graphic. The same logo on two doors is two decals. Box each decal with about 5% margin around its artwork, never including the vehicle outline, dimension arrows, leader lines, callout text or the size table. Treat a continuous graphic (a stripe with text inside it) as one decal. Name decals the way the proof names them when it does; otherwise describe them briefly ("Phone number", "Rear door logo").
- size_table: every size the proof PRINTS for a decal — in a legend, a table, or a callout beside the artwork (24" x 12", 24in x 12in, 24 x 12, 2' x 1', "24 in tall", "36 wide"). Convert feet to inches. width_in is the horizontal size, height_in the vertical. A callout giving one dimension leaves the other null. qty only when the proof states a count, else null. Never invent a size: a decal with no printed size gets no row.
- size_table_index: the index of the row that prints this decal's size, else null. Several decals may share one row (the same logo on both sides).
- Ignore the vehicle outline, grids, title blocks, approval signatures, the proof maker's own logo, revision notes and colour swatches.`;

/**
 * POST /api/wrap-quote/read-proof
 * One page of a customer proof in, what's on it out: the vehicle views, the
 * printed size table, and a rough box round every decal. The browser does
 * the measuring (src/lib/proof-sizing.ts); this is just the reading.
 */
export async function POST(req: NextRequest) {
  const auth = await requireStaff(req);
  if (auth.error) return auth.error;

  const parsed = await validateBody(req, Schema);
  if (parsed.error) return parsed.error;
  const { image, mimeType } = parsed.data;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'AI reading is not configured (no API key).' }, { status: 503 });

  try {
    const res = await callAnthropicWithRetry({
      model: MODEL,
      max_tokens: 6000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: image } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }, apiKey);

    if (!res.ok) {
      const errText = await res.text();
      console.error('read-proof: Claude API error', res.status, errText.slice(0, 500));
      return NextResponse.json({ error: `The proof reader is unavailable right now (AI error ${res.status}).` }, { status: 502 });
    }
    const data = await res.json();
    const text: string = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const json = extractJson(text);
    if (!json) {
      console.error('read-proof: no JSON in response', text.slice(0, 300));
      return NextResponse.json({ error: 'The proof reader did not return a readable answer. Try again.' }, { status: 502 });
    }
    return NextResponse.json({ success: true, data: sanitizeProofRead(json) });
  } catch (error: any) {
    console.error('read-proof error:', error);
    return NextResponse.json({ error: 'Failed to read the proof: ' + (error?.message || 'Unknown error') }, { status: 500 });
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
