import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// What we ask Claude to return per analysis. Keep the schema tight so the
// UI can rely on every field — the prompt explicitly requires it.
const SYSTEM_PROMPT = `You are a vehicle wrap quoting assistant for a graphics shop. The user will give you a proof image (or PDF rendering) of a vehicle wrap design and the real-world panel dimensions of the target vehicle. Your job is to identify each distinct graphic element on the proof, estimate its real-world dimensions in inches by using the supplied panel dimensions as scale references, and return structured JSON ONLY (no markdown, no prose).

How to think about "elements":
- A logo is one element. A block of body text is one element. A stripe is one element. A photographic illustration is one element. Treat each visually-separable component as one element.
- Do NOT split letters within a word or pieces of a continuous design into separate elements.
- If the proof shows multiple panels of the same vehicle (driver side, passenger side, rear), report elements per panel and label them.
- If a panel is mostly empty / uncovered, do NOT count it as an element.

How to size elements:
- The user is supplying the vehicle's panel measurements in inches. Use them as your ruler. For example, if the driver side panel is 110" wide and a logo occupies roughly one-fifth of that width, the logo is ~22" wide.
- Give your best honest estimate. Slight over/under is expected — the user can adjust.
- Output dimensions in inches with up to one decimal. Output area in square feet with up to two decimals.

Bounding boxes:
- Coordinates are FRACTIONS of the supplied proof image: x and y are top-left of the box, width and height are dimensions of the box, all in 0.0-1.0 range. This lets the client crop a thumbnail from the original image.

Return EXACTLY this JSON shape (no markdown, no \`\`\` fences, nothing else):
{
  "elements": [
    {
      "label": "Logo - left door",
      "panel": "Driver Side",
      "width_in": 22.0,
      "height_in": 14.5,
      "area_sqft": 2.22,
      "bbox": { "x": 0.10, "y": 0.30, "width": 0.18, "height": 0.22 },
      "notes": "Optional 1-line note about the element"
    }
  ],
  "total_sqft": 12.34,
  "notes": "Optional 1-2 sentence summary of how you sized this. Mention any uncertainty."
}`;

interface VehicleContext {
  name: string;
  make?: string;
  model?: string;
  variant?: string;
  overall_length_in?: number | null;
  overall_height_in?: number | null;
  wheelbase_in?: number | null;
  // Panel array: [{ label, name, width_in, height_in, area_sqft }]
  panel_data?: any[] | null;
}

function buildVehicleSummary(v: VehicleContext): string {
  const lines: string[] = [];
  lines.push(`Vehicle: ${v.name}`);
  if (v.overall_length_in) lines.push(`Overall length: ${v.overall_length_in}"`);
  if (v.overall_height_in) lines.push(`Overall height: ${v.overall_height_in}"`);
  if (v.wheelbase_in) lines.push(`Wheelbase: ${v.wheelbase_in}"`);
  if (Array.isArray(v.panel_data) && v.panel_data.length > 0) {
    lines.push('Panels:');
    for (const p of v.panel_data) {
      const w = p.width_in ?? p.width ?? '?';
      const h = p.height_in ?? p.height ?? '?';
      const area = p.area_sqft ?? '?';
      lines.push(`- ${p.label || p.name || 'panel'} (${p.name || ''}): ${w}" × ${h}" = ${area} sqft`);
    }
  }
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth.error) return auth.error;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured.' }, { status: 500 });
  }

  try {
    const { imageBase64, mediaType, vehicle } = await req.json() as {
      imageBase64?: string;
      mediaType?: string;
      vehicle?: VehicleContext;
    };

    if (!imageBase64) {
      return NextResponse.json({ error: 'imageBase64 is required' }, { status: 400 });
    }
    if (!vehicle || !vehicle.name) {
      return NextResponse.json({ error: 'vehicle context (with panel_data) is required' }, { status: 400 });
    }

    const isPDF = mediaType === 'application/pdf';
    const fileContent = isPDF
      ? {
          type: 'document' as const,
          source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: imageBase64 },
        }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: (mediaType || 'image/jpeg') as 'image/jpeg',
            data: imageBase64,
          },
        };

    const vehicleSummary = buildVehicleSummary(vehicle);
    const userText = `Vehicle context — use these dimensions as your scale reference when sizing elements:\n\n${vehicleSummary}\n\nAnalyze the proof below and return the JSON. No preamble.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        ...(isPDF ? { 'anthropic-beta': 'pdfs-2024-09-25' } : {}),
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              fileContent,
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[wrap-estimator] Anthropic API error:', response.status, errBody.slice(0, 500));
      return NextResponse.json({ error: `AI API error: ${response.status}` }, { status: 502 });
    }

    const result = await response.json();
    const aiText: string = result.content?.[0]?.text || '';

    // Strip optional markdown fences then parse.
    const cleaned = aiText.replace(/^\s*```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('[wrap-estimator] no JSON in AI reply:', aiText.slice(0, 500));
      return NextResponse.json({ error: 'AI returned no JSON', raw: aiText.slice(0, 500) }, { status: 502 });
    }

    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e: any) {
      console.error('[wrap-estimator] JSON parse failed:', e?.message);
      return NextResponse.json({ error: 'AI returned malformed JSON', raw: aiText.slice(0, 500) }, { status: 502 });
    }

    // Recompute area/total client-side as a safety net in case the model
    // miscounts. We trust the dimensions it gave us but never the math.
    const elements = (parsed.elements || []).map((e: any) => {
      const w = parseFloat(e.width_in) || 0;
      const h = parseFloat(e.height_in) || 0;
      const area = Math.round((w * h / 144) * 100) / 100;
      return { ...e, width_in: w, height_in: h, area_sqft: area };
    });
    const totalSqft = Math.round(elements.reduce((s: number, e: any) => s + (e.area_sqft || 0), 0) * 100) / 100;

    return NextResponse.json({
      vehicle: vehicle.name,
      elements,
      total_sqft: totalSqft,
      notes: parsed.notes || null,
      model_total_sqft: parsed.total_sqft ?? null,
    });
  } catch (err: any) {
    console.error('[wrap-estimator] unexpected error:', err);
    return NextResponse.json({ error: err?.message || 'Analysis failed' }, { status: 500 });
  }
}
