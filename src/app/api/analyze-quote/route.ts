import { NextRequest, NextResponse } from 'next/server';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ANALYSIS_PROMPT = `You are a vehicle wrap estimation expert. You are analyzing two images:

1. A VEHICLE TEMPLATE - a 1:20 scale technical line drawing showing the vehicle's body panels from multiple angles (driver side, passenger side, front, rear, top). This template includes real-world dimensions in millimeters and inches.

2. A PROOF/DESIGN FILE - showing the proposed vinyl graphics wrap design on the same vehicle. The colored/designed areas represent vinyl graphics. White/uncolored areas are bare paint. Dark tinted areas are windows. Gray areas at the bottom are bumpers.

Your task:
1. Read the dimensions from the template image (overall length, height, wheelbase)
2. For each major vehicle panel visible in the proof, estimate:
   - The total panel area in square feet (using the template dimensions)
   - What percentage of that panel is covered with vinyl graphics (vs bare paint/windows/bumpers)
   - The resulting vinyl square footage for that panel
   - The type of coverage (full wrap, partial wrap, lettering/decals only)

Analyze these panels:
- Driver Side (full side profile)
- Passenger Side (full side profile)
- Hood/Front
- Rear (back doors/tailgate)
- Roof (if visible in proof)

IMPORTANT: Use the template's labeled dimensions to calculate real square footage. The template is at 1:20 scale with dimensions printed on it. Vehicle panels are not flat rectangles - use reasonable estimates accounting for curves, wheel wells, windows, and trim.

Return your analysis as JSON only, no other text, in this exact format:
{
  "panels": [
    {
      "panel_name": "Driver Side",
      "panel_area_sqft": 85.5,
      "vinyl_coverage_pct": 72,
      "vinyl_sqft": 61.56,
      "vinyl_type": "partial wrap",
      "description": "Blue vinyl covers upper body from behind cab to rear doors. Lower body, bumper, and windows are not wrapped."
    }
  ],
  "total_vinyl_sqft": 180.5,
  "total_vehicle_sqft": 350.0,
  "overall_coverage_pct": 51.6,
  "confidence": "high",
  "notes": "Measurements based on template dimensions of 238.7 inches overall length. Coverage includes solid color vinyl on body panels above the belt line."
}`;

export async function POST(request: NextRequest) {
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.' },
      { status: 500 }
    );
  }

  try {
    const { templateImageBase64, proofImageBase64, templateMediaType, proofMediaType } = await request.json();

    if (!templateImageBase64 || !proofImageBase64) {
      return NextResponse.json(
        { error: 'Both template and proof images are required' },
        { status: 400 }
      );
    }

    // Call Claude Vision API with both images
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250514',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Here is the vehicle TEMPLATE (1:20 scale technical drawing with dimensions):',
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
                text: 'Here is the PROOF/DESIGN showing the proposed vinyl wrap:',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: proofMediaType || 'image/png',
                  data: proofImageBase64,
                },
              },
              {
                type: 'text',
                text: ANALYSIS_PROMPT,
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

    // Parse the JSON from Claude's response
    let analysis;
    try {
      // Try to extract JSON from the response (Claude might wrap it in markdown code blocks)
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

    return NextResponse.json({ analysis });
  } catch (error: any) {
    console.error('Analysis error:', error);
    return NextResponse.json(
      { error: error.message || 'Analysis failed' },
      { status: 500 }
    );
  }
}
