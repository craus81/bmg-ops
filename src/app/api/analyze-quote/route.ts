import { NextRequest, NextResponse } from 'next/server';

// App Router: set max duration for long AI calls (Vercel Pro allows up to 300s)
export const maxDuration = 60;

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

function buildPrompt(dims?: VehicleDimensions): string {
  // Build the calibration section from known dimensions
  let calibrationSection = '';

  if (dims && dims.panels && dims.panels.length > 0) {
    calibrationSection = `
═══════════════════════════════════════════
KNOWN VEHICLE DIMENSIONS — USE THESE AS YOUR GROUND TRUTH
═══════════════════════════════════════════

Vehicle: ${dims.make || ''} ${dims.model || ''} ${dims.year || ''}
Overall Length: ${dims.overall_length_in ? dims.overall_length_in + '"' : 'unknown'}
Overall Height: ${dims.overall_height_in ? dims.overall_height_in + '"' : 'unknown'}
Wheelbase: ${dims.wheelbase_in ? dims.wheelbase_in + '"' : 'unknown'}

PANEL DIMENSIONS (exact measurements):
${dims.panels.map(p => `- ${p.name}: ${p.width_in}" wide × ${p.height_in}" tall (${p.area_sqft} sq ft)`).join('\n')}

CRITICAL: You MUST use these panel dimensions as your reference to calculate graphic element sizes.
For example, if the driver side panel is 222" wide and a graphic spans 25% of that panel width, the graphic is 55.5" wide.

MEASUREMENT METHOD:
1. Identify which panel each graphic element is on (driver side, passenger side, rear, etc.)
2. Estimate what PERCENTAGE of that panel's width and height the graphic covers
3. MULTIPLY: element_width = panel_width × (percentage / 100)
4. MULTIPLY: element_height = panel_height × (percentage / 100)
5. Show your math in the description field

DO NOT eyeball dimensions. DO NOT guess. Calculate from the known panel sizes.
`;
  } else {
    calibrationSection = `
NOTE: No exact vehicle dimensions were provided. Use the template drawing's labeled dimensions (if visible) to estimate scale. If no dimensions are labeled, use the 1:20 scale convention and estimate based on typical vehicle proportions.
`;
  }

  return `You are a vehicle wrap estimation expert. You are analyzing two images:

1. A VEHICLE TEMPLATE - a technical line drawing showing the vehicle's body panels from multiple angles (driver side, passenger side, front, rear, top).

2. A PROOF/DESIGN FILE - showing the proposed vinyl graphics wrap design on the same vehicle. The colored/designed areas represent vinyl graphics. White/uncolored areas are bare paint. Dark tinted areas are windows. Gray areas at the bottom are bumpers.
${calibrationSection}
Your task: Identify each INDIVIDUAL GRAPHIC ELEMENT in the proof and calculate its bounding box dimensions in inches.

For each distinct graphic piece (logo, stripe, text block, side graphic panel, door graphic, etc.):
1. Give it a descriptive name (e.g. "Driver Side Logo", "Rear Door Text", "Side Body Stripe")
2. Classify the type: "logo", "stripe", "text_block", "graphic", "full_panel", "decal"
3. Identify which vehicle panel it's on (e.g. "Driver Side", "Passenger Side", "Rear Doors")
4. Estimate what percentage of that panel's width and height the element covers
5. Calculate WIDTH and HEIGHT in INCHES using: element_size = panel_size × (percentage / 100)
6. Show your calculation in the description
7. Estimate where this element appears on the PROOF image as a percentage bounding box:
   - crop_x_pct: left edge as % of image width (0-100)
   - crop_y_pct: top edge as % of image height (0-100)
   - crop_w_pct: width as % of image width (0-100)
   - crop_h_pct: height as % of image height (0-100)

IMPORTANT RULES:
- Identify EACH separate printed piece, not panels
- If the same graphic appears on both sides (driver + passenger), list them as SEPARATE elements
- Measure the BOUNDING BOX (smallest rectangle enclosing the graphic), not the total panel
- Be conservative — measure only actual vinyl, not bare paint or windows
- ALWAYS show your math: "Logo spans ~20% of driver side width (222"), so 222 × 0.20 = 44.4 inches"

Return JSON only, no other text, in this exact format:
{
  "graphic_elements": [
    {
      "element_name": "Driver Side Company Logo",
      "element_type": "logo",
      "panel": "Driver Side",
      "width_in": 44.4,
      "height_in": 14.4,
      "width_pct_of_panel": 20.0,
      "height_pct_of_panel": 20.0,
      "description": "KinderCare logo on driver side upper body. Spans ~20% of driver side width (222 × 0.20 = 44.4in) and ~20% of height (72 × 0.20 = 14.4in).",
      "crop_x_pct": 10.0,
      "crop_y_pct": 5.0,
      "crop_w_pct": 25.0,
      "crop_h_pct": 12.0
    }
  ],
  "total_vinyl_sqft": 45.2,
  "total_vehicle_sqft": 350.0,
  "overall_coverage_pct": 12.9,
  "confidence": "high",
  "notes": "Measurements calculated from known panel dimensions.",
  "analysis_version": "dimension_calibrated"
}`;
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

    const prompt = buildPrompt(dims);

    // Build message content — only include template image if no dimensions
    const messageContent: any[] = [];

    if (templateImageBase64 && !hasDimensions) {
      // Legacy flow: template image + proof
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
        max_tokens: 4096,
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
    let analysis;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
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

    // Post-process: validate dimensions against known panels if available
    if (vehicleDimensions?.panels?.length && analysis?.graphic_elements) {
      const panelMap: Record<string, { width_in: number; height_in: number }> = {};
      for (const p of vehicleDimensions.panels) {
        panelMap[p.name.toLowerCase()] = { width_in: p.width_in, height_in: p.height_in };
      }

      for (const el of analysis.graphic_elements) {
        // If the AI provided panel percentages, recalculate dimensions as a sanity check
        if (el.width_pct_of_panel && el.height_pct_of_panel && el.panel) {
          const panelKey = el.panel.toLowerCase();
          // Try exact match first, then partial match
          const panel = panelMap[panelKey] ||
            Object.entries(panelMap).find(([k]) => panelKey.includes(k) || k.includes(panelKey))?.[1];

          if (panel) {
            const calcWidth = Math.round(panel.width_in * (el.width_pct_of_panel / 100) * 10) / 10;
            const calcHeight = Math.round(panel.height_in * (el.height_pct_of_panel / 100) * 10) / 10;

            // If AI's inch values deviate >20% from the calculated values, override
            if (Math.abs(el.width_in - calcWidth) / calcWidth > 0.2) {
              el.width_in_original = el.width_in;
              el.width_in = calcWidth;
              el.corrected = true;
            }
            if (Math.abs(el.height_in - calcHeight) / calcHeight > 0.2) {
              el.height_in_original = el.height_in;
              el.height_in = calcHeight;
              el.corrected = true;
            }
          }
        }
      }

      // Recalculate total vinyl sqft from corrected element dimensions
      const totalSqIn = analysis.graphic_elements.reduce(
        (sum: number, el: any) => sum + (el.width_in * el.height_in), 0
      );
      analysis.total_vinyl_sqft = Math.round(totalSqIn / 144 * 10) / 10;

      const totalVehicleSqft = vehicleDimensions.panels.reduce(
        (sum: number, p: any) => sum + (p.area_sqft || 0), 0
      );
      if (totalVehicleSqft > 0) {
        analysis.total_vehicle_sqft = totalVehicleSqft;
        analysis.overall_coverage_pct = Math.round(analysis.total_vinyl_sqft / totalVehicleSqft * 1000) / 10;
      }
    }

    return NextResponse.json({ analysis });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: error.message || 'Analysis failed' },
      { status: 500 }
    );
  }
}
