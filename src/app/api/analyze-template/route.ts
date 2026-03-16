import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const TEMPLATE_PANEL_PROMPT = `You are a vehicle wrap estimation expert. You are analyzing a VEHICLE TEMPLATE — a 1:20 scale technical line drawing showing the vehicle's body panels from multiple angles (driver side, passenger side, front, rear, top). The template includes real-world dimensions in millimeters and inches.

Your task: Identify the major WRAPPABLE PANELS of this vehicle and estimate their bounding box dimensions and positions on the template image.

For each panel, provide:
1. A descriptive name (e.g. "Driver Side", "Passenger Side", "Hood", "Roof", "Rear", "Front Bumper")
2. Type: "full_panel"
3. Estimate WIDTH and HEIGHT in INCHES using the template's labeled 1:20 scale dimensions
4. Estimate where this panel appears on the TEMPLATE image as a percentage bounding box:
   - crop_x_pct: left edge as % of image width (0-100)
   - crop_y_pct: top edge as % of image height (0-100)
   - crop_w_pct: width as % of image width (0-100)
   - crop_h_pct: height as % of image height (0-100)

IMPORTANT RULES:
- Identify the major body panels that would be wrapped in a full vehicle wrap
- Include BOTH sides (driver AND passenger) as separate panels
- Include: hood, roof, rear/tailgate, front and rear bumpers if visible
- For cargo vans/box trucks: include the box/cargo area sides and rear as separate panels
- Use the template dimensions to calculate real inches from the scale drawing
- Be generous with panel sizes — these represent full coverage areas
- The bounding boxes should cover the entire paintable surface of each panel

Return JSON only, no other text, in this exact format:
{
  "graphic_elements": [
    {
      "element_name": "Driver Side",
      "element_type": "full_panel",
      "width_in": 240.0,
      "height_in": 72.0,
      "description": "Full driver side panel from front fender to rear, based on template overall length.",
      "crop_x_pct": 5.0,
      "crop_y_pct": 2.0,
      "crop_w_pct": 90.0,
      "crop_h_pct": 22.0
    },
    {
      "element_name": "Passenger Side",
      "element_type": "full_panel",
      "width_in": 240.0,
      "height_in": 72.0,
      "description": "Full passenger side panel, matching driver side dimensions.",
      "crop_x_pct": 5.0,
      "crop_y_pct": 28.0,
      "crop_w_pct": 90.0,
      "crop_h_pct": 22.0
    },
    {
      "element_name": "Hood",
      "element_type": "full_panel",
      "width_in": 60.0,
      "height_in": 48.0,
      "description": "Hood panel, approximately 60 x 48 inches.",
      "crop_x_pct": 70.0,
      "crop_y_pct": 55.0,
      "crop_w_pct": 15.0,
      "crop_h_pct": 18.0
    }
  ],
  "total_vinyl_sqft": 180.0,
  "total_vehicle_sqft": 350.0,
  "overall_coverage_pct": 100.0,
  "confidence": "high",
  "notes": "Full wrap panel breakdown based on template dimensions.",
  "analysis_version": "individual_elements"
}`;

export async function POST(request: NextRequest) {
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured.' },
      { status: 500 }
    );
  }

  try {
    const { templateImageBase64, templateMediaType } = await request.json();

    if (!templateImageBase64) {
      return NextResponse.json(
        { error: 'Template image is required' },
        { status: 400 }
      );
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Here is a vehicle TEMPLATE (1:20 scale technical drawing with dimensions). Identify all major wrappable body panels:',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: templateMediaType || 'image/png',
                  data: templateImageBase64,
                },
              },
              {
                type: 'text',
                text: TEMPLATE_PANEL_PROMPT,
              },
            ],
          },
        ],
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
        { error: 'Failed to parse AI analysis.', raw: aiText },
        { status: 500 }
      );
    }

    return NextResponse.json({ analysis });
  } catch (error: any) {
    console.error('Template analysis error:', error);
    return NextResponse.json(
      { error: error.message || 'Analysis failed' },
      { status: 500 }
    );
  }
}
