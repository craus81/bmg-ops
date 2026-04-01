import { NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/prospects/scan-card
 * Accepts a base64 business card image, uses Claude vision to extract contact info
 */
export async function POST(req: NextRequest) {
  try {
    const { image, mimeType } = await req.json();

    if (!image) {
      return NextResponse.json({ error: 'No image provided' }, { status: 400 });
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType || 'image/jpeg',
                  data: image,
                },
              },
              {
                type: 'text',
                text: `Extract all contact information from this business card image. Return ONLY a JSON object with these fields (use null for any field not found):

{
  "company_name": "company/business name",
  "contact_name": "person's full name",
  "title": "job title/position",
  "email": "email address",
  "phone": "phone number (primary)",
  "address": "street address",
  "city": "city",
  "state": "state/province",
  "zip": "zip/postal code",
  "website": "website URL"
}

Return ONLY the JSON object, no other text.`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Claude API error:', res.status, errText);
      return NextResponse.json({ error: `AI error: ${res.status}` }, { status: 500 });
    }

    const data = await res.json();
    const textBlock = data.content?.find((b: any) => b.type === 'text');
    if (!textBlock?.text) {
      return NextResponse.json({ error: 'No text response from AI' }, { status: 500 });
    }

    // Parse the JSON from Claude's response
    const jsonStr = textBlock.text.trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    const parsed = JSON.parse(jsonStr);

    return NextResponse.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error('Card scan error:', error);
    return NextResponse.json(
      { error: 'Failed to scan business card: ' + (error?.message || 'Unknown error') },
      { status: 500 }
    );
  }
}
