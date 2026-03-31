import { NextRequest, NextResponse } from 'next/server';

// App Router: set max duration for long AI calls (Vercel Pro allows up to 300s)
export const maxDuration = 120;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

interface VehicleDimensions {
  make?: string;
  model?: string;
  year?: string | null;
  overall_length_in?: number | null;
  overall_height_in?: number | null;
  wheelbase_in?: number | null;
  panels?: { name: string; width_in: number; height_in: number; area_sqft: number }[];
}

interface CalibrationRegion {
  panel_name: string;
  width_in: number;
  height_in: number;
  // Where this panel appears on the proof image (percentage of image)
  img_x_pct: number;
  img_y_pct: number;
  img_w_pct: number;
  img_h_pct: number;
  // Derived scale: inches per 1% of image
  in_per_pct_x: number;
  in_per_pct_y: number;
}

function buildCalibrationPrompt(dims: VehicleDimensions): string {
  const panelList = (dims.panels || []).map(p =>
    `- ${p.name}: ${p.width_in}" wide × ${p.height_in}" tall`
  ).join('\n');

  return `You are a vehicle wrap estimation expert analyzing a PROOF/DESIGN image.

KNOWN VEHICLE PANELS:
Vehicle: ${dims.make || ''} ${dims.model || ''} ${dims.year || ''}
${panelList}

YOUR TASK HAS TWO PARTS:

═══ PART 1: CALIBRATION ═══
Find where each known vehicle panel appears on this proof image. For each panel visible in the image, provide a tight bounding box around the FULL paintable surface of that panel (excluding windows, bumpers, wheels).

═══ PART 2: GRAPHIC ELEMENTS ═══
Identify each individual graphic element (logo, stripe, text, decal, large graphic panel, etc.) and provide its bounding box on the proof image. Do NOT calculate inch dimensions — just provide the image position.

For each graphic element:
1. Descriptive name (e.g. "Driver Side Logo", "Rear Door Text")
2. Type: "logo", "stripe", "text_block", "graphic", "full_panel", "decal"
3. Which vehicle panel it sits on (must match a panel name from the calibration)
4. Its bounding box on the proof image as percentages (0-100)

IMPORTANT RULES:
- Identify EACH separate printed piece, not whole panels
- If the same graphic appears on both sides, list as SEPARATE elements
- Measure the BOUNDING BOX of the graphic only, not bare paint
- Be conservative — only include actual vinyl/printed areas
- Panel calibration boxes should cover the entire paintable body panel surface

Return JSON only, no other text:
{
  "calibration_regions": [
    {
      "panel_name": "Driver Side",
      "img_x_pct": 5.0,
      "img_y_pct": 2.0,
      "img_w_pct": 45.0,
      "img_h_pct": 30.0
    }
  ],
  "graphic_elements": [
    {
      "element_name": "Driver Side Company Logo",
      "element_type": "logo",
      "panel": "Driver Side",
      "crop_x_pct": 10.0,
      "crop_y_pct": 5.0,
      "crop_w_pct": 15.0,
      "crop_h_pct": 8.0
    }
  ]
}`;
}

function buildLegacyPrompt(): string {
  return `You are a vehicle wrap estimation expert. Analyze this proof/design image.

Identify each individual graphic element and provide its bounding box position on the image.

For each element:
1. Descriptive name
2. Type: "logo", "stripe", "text_block", "graphic", "full_panel", "decal"
3. Which side/panel it's on
4. Bounding box as percentages of image (0-100)
5. Estimate width and height in inches based on typical vehicle proportions

Return JSON only:
{
  "graphic_elements": [
    {
      "element_name": "Driver Side Logo",
      "element_type": "logo",
      "panel": "Driver Side",
      "width_in": 44.0,
      "height_in": 14.0,
      "crop_x_pct": 10.0,
      "crop_y_pct": 5.0,
      "crop_w_pct": 25.0,
      "crop_h_pct": 12.0
    }
  ],
  "total_vinyl_sqft": 45.0,
  "confidence": "medium",
  "notes": "Estimated without calibration dimensions."
}`;
}

function calculateCalibratedDimensions(
  calibrationRegions: CalibrationRegion[],
  elements: any[]
): any[] {
  // For each element, find which calibration region it belongs to and calculate inches
  return elements.map(el => {
    const panelName = (el.panel || '').toLowerCase();

    // Find matching calibration region
    const region = calibrationRegions.find(r =>
      r.panel_name.toLowerCase() === panelName ||
      panelName.includes(r.panel_name.toLowerCase()) ||
      r.panel_name.toLowerCase().includes(panelName)
    );

    if (region && el.crop_w_pct && el.crop_h_pct) {
      // Calculate inches using calibration scale
      const width_in = Math.round(el.crop_w_pct * region.in_per_pct_x * 10) / 10;
      const height_in = Math.round(el.crop_h_pct * region.in_per_pct_y * 10) / 10;

      return {
        ...el,
        width_in,
        height_in,
        width_pct_of_panel: Math.round((el.crop_w_pct / region.img_w_pct) * 100 * 10) / 10,
        height_pct_of_panel: Math.round((el.crop_h_pct / region.img_h_pct) * 100 * 10) / 10,
        calibrated: true,
        calibration_panel: region.panel_name,
      };
    }

    // No calibration match — return as-is (inches will be 0 if not provided)
    return {
      ...el,
      width_in: el.width_in || 0,
      height_in: el.height_in || 0,
      calibrated: false,
    };
  });
}

export async function POST(request: NextRequest) {
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.' },
      { status: 500 }
    );
  }

  try {
    const { templateImageBase64, proofImageBase64, templateMediaType, proofMediaType, vehicleDimensions } = await request.json();

    if (!proofImageBase64) {
      return NextResponse.json(
        { error: 'Proof image is required' },
        { status: 400 }
      );
    }

    const dims = vehicleDimensions as VehicleDimensions | undefined;
    const hasDimensions = dims?.panels && dims.panels.length > 0;

    if (!hasDimensions && !templateImageBase64) {
      return NextResponse.json(
        { error: 'Either vehicle dimensions or a template image is required' },
        { status: 400 }
      );
    }

    const prompt = hasDimensions ? buildCalibrationPrompt(dims!) : buildLegacyPrompt();

    // Build message content
    const messageContent: any[] = [];

    if (templateImageBase64 && !hasDimensions) {
      messageContent.push(
        { type: 'text', text: 'Here is the vehicle TEMPLATE (technical drawing with panel dimensions):' },
        { type: 'image', source: { type: 'base64', media_type: templateMediaType || 'image/png', data: templateImageBase64 } },
      );
    }

    messageContent.push(
      { type: 'text', text: 'Here is the PROOF/DESIGN showing the proposed vinyl wrap:' },
      { type: 'image', source: { type: 'base64', media_type: proofMediaType || 'image/png', data: proofImageBase64 } },
      { type: 'text', text: prompt },
    );

    // Call Claude Vision API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{ role: 'user', content: messageContent }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API error:', response.status, errorBody);
      return NextResponse.json(
        { error: `AI API error: ${response.status} - ${errorBody}` },
        { status: 500 }
      );
    }

    const result = await response.json();
    const aiText = result.content?.[0]?.text || '';

    // Parse the JSON from Claude's response
    let parsed;
    try {
      let cleanText = aiText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in AI response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiText);
      return NextResponse.json(
        { error: 'Failed to parse AI analysis. Raw response saved.', raw: aiText },
        { status: 500 }
      );
    }

    // Build calibration regions from AI panel detection + known dimensions
    let calibrationRegions: CalibrationRegion[] = [];

    if (hasDimensions && parsed.calibration_regions) {
      const panelMap: Record<string, { width_in: number; height_in: number; area_sqft: number }> = {};
      for (const p of dims!.panels!) {
        panelMap[p.name.toLowerCase()] = p;
      }

      calibrationRegions = parsed.calibration_regions
        .map((cr: any) => {
          const panelKey = (cr.panel_name || '').toLowerCase();
          const panel = panelMap[panelKey] ||
            Object.entries(panelMap).find(([k]) => panelKey.includes(k) || k.includes(panelKey))?.[1];

          if (!panel || !cr.img_w_pct || !cr.img_h_pct) return null;

          return {
            panel_name: cr.panel_name,
            width_in: panel.width_in,
            height_in: panel.height_in,
            img_x_pct: cr.img_x_pct || 0,
            img_y_pct: cr.img_y_pct || 0,
            img_w_pct: cr.img_w_pct,
            img_h_pct: cr.img_h_pct,
            // Key calculation: how many inches per 1% of image
            in_per_pct_x: panel.width_in / cr.img_w_pct,
            in_per_pct_y: panel.height_in / cr.img_h_pct,
          } as CalibrationRegion;
        })
        .filter(Boolean) as CalibrationRegion[];
    }

    // Calculate element dimensions using calibration
    let elements = parsed.graphic_elements || [];
    if (calibrationRegions.length > 0) {
      elements = calculateCalibratedDimensions(calibrationRegions, elements);
    }

    // Calculate totals
    const totalSqIn = elements.reduce(
      (sum: number, el: any) => sum + ((el.width_in || 0) * (el.height_in || 0)), 0
    );
    const totalVinylSqft = Math.round(totalSqIn / 144 * 10) / 10;

    let totalVehicleSqft = 0;
    if (dims?.panels?.length) {
      totalVehicleSqft = dims.panels.reduce((sum, p) => sum + (p.area_sqft || 0), 0);
    }

    const analysis = {
      graphic_elements: elements,
      calibration_regions: calibrationRegions,
      total_vinyl_sqft: totalVinylSqft,
      total_vehicle_sqft: totalVehicleSqft || parsed.total_vehicle_sqft || 0,
      overall_coverage_pct: totalVehicleSqft > 0
        ? Math.round(totalVinylSqft / totalVehicleSqft * 1000) / 10
        : (parsed.overall_coverage_pct || 0),
      confidence: calibrationRegions.length > 0 ? 'calibrated' : (parsed.confidence || 'low'),
      notes: calibrationRegions.length > 0
        ? `Calibrated using ${calibrationRegions.length} panel region(s): ${calibrationRegions.map(r => r.panel_name).join(', ')}.`
        : (parsed.notes || ''),
      analysis_version: 'calibrated_v2',
    };

    return NextResponse.json({ analysis });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: error.message || 'Analysis failed' },
      { status: 500 }
    );
  }
}
