import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const WORKSHEET_PROMPT = `You are reading a handwritten fleet vehicle worksheet/log sheet. Extract ALL data from this document.

The worksheet has:
1. A HEADER section at the top with fields like: Vendor Name, Part# (or Part Number), Date, PO# (or PO Number), Customer
2. A TABLE with numbered rows. Each row typically has:
   - A row number
   - A partial VIN (usually the last 8 digits of the vehicle identification number)
   - A unit number (asset/fleet identifier)
   - Sometimes additional columns

IMPORTANT RULES:
- Read the handwriting as carefully as possible
- VIN digits are alphanumeric (0-9 and A-Z, excluding I, O, Q)
- Common handwriting confusions to watch for: 5/S, 0/O, 1/I, 8/B, 6/G, 2/Z
- The Part# field often contains codes like "065058", "06CS900008", "06T278", etc.
- If a field is empty or illegible, use null
- Only include rows that have data (skip empty numbered rows)
- If there appear to be multiple part numbers (e.g., crossed out and rewritten), include both separated by "/"

Return JSON only, no other text, in this exact format:
{
  "header": {
    "vendor_name": "BMG",
    "part_number": "065058",
    "date": "3/6",
    "po_number": "12345",
    "customer": "DISH"
  },
  "rows": [
    {
      "row_number": 1,
      "partial_vin": "SE539318",
      "unit_number": "41A575"
    },
    {
      "row_number": 2,
      "partial_vin": "SE539326",
      "unit_number": "41A576"
    }
  ],
  "notes": "Any observations about legibility or ambiguous characters"
}`;

export async function POST(request: NextRequest) {
  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not configured.' },
      { status: 500 }
    );
  }

  try {
    const { imageBase64, mediaType } = await request.json();

    if (!imageBase64) {
      return NextResponse.json(
        { error: 'Image is required' },
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
                text: 'Read this handwritten vehicle worksheet and extract all the data:',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: imageBase64,
                },
              },
              {
                type: 'text',
                text: WORKSHEET_PROMPT,
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
        { error: `AI API error: ${response.status}` },
        { status: 500 }
      );
    }

    const result = await response.json();
    const aiText = result.content?.[0]?.text || '';

    let parsed;
    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in AI response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiText);
      return NextResponse.json(
        { error: 'Failed to parse worksheet. Raw response saved.', raw: aiText },
        { status: 500 }
      );
    }

    return NextResponse.json({ data: parsed });
  } catch (error: any) {
    console.error('Worksheet scan error:', error);
    return NextResponse.json(
      { error: error.message || 'Scan failed' },
      { status: 500 }
    );
  }
}
