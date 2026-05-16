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

How to size elements (THIS IS THE IMPORTANT PART — be explicit):
- The user is supplying the vehicle's panel measurements in inches. Pick ONE specific panel as the ruler for each element and state which one.
- Reason proportionally and SHOW THE MATH in measurement_basis: name the reference panel, its known dimension, the fraction of it the element spans, and the resulting size. Example: "Driver side body panel is 110\" wide; the logo spans ~40% of that width → ~44\" wide. Logo is roughly square so ~44\" tall would be too much; it's about 1/3 as tall as wide → ~15\" tall."
- If you are uncertain how big a panel really is, say so in measurement_basis. Honest uncertainty is more useful than a confident wrong number.
- Output dimensions in inches with up to one decimal. Output area in square feet with up to two decimals.

Bounding boxes:
- bbox is a ROUGH locator only (fractions of the proof image, 0.0-1.0). It is NOT used for measurement — the width_in/height_in you give ARE the measurement. Do your best on bbox but spend your effort on the dimensions and the measurement_basis, not on pixel-perfect boxes.

Return EXACTLY this JSON shape (no markdown, no \`\`\` fences, nothing else):
{
  "elements": [
    {
      "label": "Logo - left door",
      "panel": "Driver Side",
      "reference_panel": "Driver Side body panel (110\" wide)",
      "measurement_basis": "Logo spans ~40% of the 110\" driver-side panel width → ~44\" wide; height is ~1/3 of width → ~15\" tall.",
      "width_in": 44.0,
      "height_in": 15.0,
      "area_sqft": 4.58,
      "bbox": { "x": 0.10, "y": 0.30, "width": 0.18, "height": 0.22 },
      "notes": "Optional 1-line note about the element"
    }
  ],
  "total_sqft": 12.34,
  "notes": "Optional 1-2 sentence summary. Mention overall uncertainty and any panel whose real size you had to guess."
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
    const body = await req.json() as {
      imageBase64?: string;
      // Preferred path: client uploads the proof to R2 first (no Vercel
      // 4.5MB body cap), then sends just the URL. We fetch the bytes
      // server-side. imageBase64 is kept for tiny inline payloads.
      fileUrl?: string;
      mediaType?: string;
      vehicle?: VehicleContext;
    };
    const { fileUrl, mediaType, vehicle } = body;
    let { imageBase64 } = body;

    if (!vehicle || !vehicle.name) {
      return NextResponse.json({ error: 'vehicle context (with panel_data) is required' }, { status: 400 });
    }

    if (!imageBase64) {
      if (!fileUrl) {
        return NextResponse.json({ error: 'fileUrl or imageBase64 is required' }, { status: 400 });
      }
      // Pull the proof from storage server-side. This sidesteps the
      // platform request-body limit that 413'd large PDF uploads.
      try {
        const fileRes = await fetch(fileUrl);
        if (!fileRes.ok) {
          return NextResponse.json(
            { error: `Could not fetch proof from storage (HTTP ${fileRes.status})` },
            { status: 502 },
          );
        }
        const buf = Buffer.from(await fileRes.arrayBuffer());
        // Anthropic caps a single document/image at ~32MB base64.
        if (buf.byteLength > 24 * 1024 * 1024) {
          return NextResponse.json(
            { error: 'Proof is too large to analyze (over ~24MB). Flatten or downsize the PDF/image and retry.' },
            { status: 413 },
          );
        }
        imageBase64 = buf.toString('base64');
      } catch (e: any) {
        console.error('[wrap-estimator] storage fetch failed:', e?.message);
        return NextResponse.json({ error: `Failed to load proof: ${e?.message || 'unknown'}` }, { status: 502 });
      }
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
