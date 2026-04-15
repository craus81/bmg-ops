import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const WORKSHEET_PROMPT = `You are reading a handwritten fleet vehicle worksheet/log sheet. Extract the data as fast and accurately as possible.

Focus on:
1. The Part# (Part Number) field in the header — this is the most important header field
2. The Customer field in the header
3. The TABLE rows: each row has a partial VIN and a unit number

IMPORTANT RULES:
- Read the handwriting as carefully as possible
- Extract ALL rows from ALL pages of the document
- VIN digits are alphanumeric (0-9 and A-Z, excluding I, O, Q)
- Common handwriting confusions: 5/S, 0/O, 1/I, 8/B, 6/G, 2/Z
- If a field is empty or illegible, use null
- Only include rows that have data (skip empty numbered rows)
- The Part# field may contain MULTIPLE part numbers separated by "/" or written side by side (e.g., "06T887 / 065646"). Include ALL part numbers exactly as written, separated by "/"
- Part numbers typically start with "06" and are 6+ characters long
- IGNORE the Vendor Name and PO# fields — do not extract them

Return JSON only, no other text, in this exact format:
{
  "header": {
    "part_number": "065058",
    "customer": "DISH"
  },
  "rows": [
    {
      "row_number": 1,
      "partial_vin": "SE539318",
      "unit_number": "41A575"
    }
  ],
  "notes": "Any observations about legibility or ambiguous characters"
}`;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;

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

    const isPDF = mediaType === 'application/pdf';

    // PDFs use document type; images use image type
    const fileContent = isPDF
      ? {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data: imageBase64,
          },
        }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: (mediaType || 'image/jpeg') as 'image/jpeg',
            data: imageBase64,
          },
        };

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
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Read this handwritten vehicle worksheet and extract all the data:',
              },
              fileContent,
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
        { error: `Failed to parse worksheet response. Claude said: ${aiText.substring(0, 300)}`, raw: aiText },
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
