import { NextRequest, NextResponse } from 'next/server';

// App Router: set max duration for long AI calls (Vercel Pro allows up to 300s)
export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ANALYSIS_PROMPT = `You are a vehicle wrap estimation expert. You are analyzing two images:

1. A VEHICLE TEMPLATE - a 1:20 scale technical line drawing showing the vehicle's body panels from multiple angles (driver side, passenger side, front, rear, top). This template includes real-world dimensions in millimeters and inches.

2. A PROOF/DESIGN FILE - showing the proposed vinyl graphics wrap design on the same vehicle. The colored/designed areas represent vinyl graphics. White/uncolored areas are bare paint. Dark tinted areas are windows. Gray areas at the bottom are bumpers.

Your task: Identify each INDIVIDUAL GRAPHIC ELEMENT in the proof and estimate its bounding box dimensions in inches.

For each distinct graphic piece (logo, stripe, text block, side graphic panel, door graphic, etc.):
1. Give it a descriptive name (e.g. "Driver Side Body Stripe", "Rear Door Logo", "Phone Number Text")
2. Classify the type: "logo", "stripe", "text_block", "graphic", "full_panel", "decal"
3. Estimate the WIDTH and HEIGHT in INCHES of the smallest rectangle that contains that element
4. Use the template's labeled 1:20 scale dimensions to calculate real-world sizes
5. Explain your reasoning for the measurements

IMPORTANT RULES:
- Identify EACH separate printed piece, not panels
- If the same graphic appears on both sides (driver + passenger), list them as SEPARATE elements (e.g. "Driver Side Stripe" and "Passenger Side Stripe")
- Measure the BOUNDING BOX (smallest rectangle enclosing the graphic), not the total panel
- Use the template dimensions to convert from the visual scale to real inches
- Be conservative with measurements - measure only actual vinyl, not bare paint or windows

Return JSON only, no other text, in this exact format:
{
  "graphic_elements": [
    {
      "element_name": "Driver Side Body Stripe",
      "element_type": "stripe",
      "width_in": 120.0,
      "height_in": 18.5,
      "description": "Blue diagonal stripe running from behind cab to rear wheel well on driver side. Approximately 120 inches long by 18.5 inches tall based on template overall length of 235 inches."
    },
    {
      "element_name": "Passenger Side Body Stripe",
      "element_type": "stripe",
      "width_in": 120.0,
      "height_in": 18.5,
      "description": "Matching stripe on passenger side, same dimensions as driver side."
    },
    {
      "element_name": "Rear Door Company Logo",
      "element_type": "logo",
      "width_in": 24.0,
      "height_in": 16.0,
      "description": "Company logo centered on rear doors, approximately 24 x 16 inches."
    }
  ],
  "total_vinyl_sqft": 45.2,
  "total_vehicle_sqft": 350.0,
  "overall_coverage_pct": 12.9,
  "confidence": "high",
  "notes": "Measurements based on template dimensions. Total vinyl is sum of all element bounding boxes.",
  "analysis_version": "individual_elements"
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
        model: 'claude-sonnet-4-5-20250929',
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
