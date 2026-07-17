import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/api-auth';
import { validateBody, z } from '@/lib/validate';

export const maxDuration = 60;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const Schema = z.object({
  fileBase64: z.string().min(1).max(15_000_000),
  mediaType: z.string().max(100).optional(),
});

const INVOICE_PROMPT = `You are reading an invoice a subcontract vehicle installer (a "CNI installer") sent us for installation work they performed on our vehicles. Extract the billing details and every vehicle (VIN) listed.

IMPORTANT RULES:
- VINs are alphanumeric (0-9 and A-Z, excluding I, O, Q). They may appear as full 17-character VINs or as the last 6-8 characters only — capture exactly what is written.
- Common OCR/handwriting confusions: 5/S, 0/O, 1/I, 8/B, 6/G, 2/Z.
- "amount" per line = what the installer charged for THAT vehicle. If the invoice shows one flat per-vehicle rate, apply it to every vehicle line. If only a grand total is shown with no per-vehicle price, leave every line amount null.
- Part numbers typically start with "06" and are 6+ characters; use null if none is shown for a line.
- vendor_name = the installer/company who SENT the invoice (the payee), not our company (BMG).
- invoice_date in YYYY-MM-DD format; null if not shown.
- total_amount = the invoice grand total as a number, null if not shown.
- If the document is not an installer invoice at all, return {"not_an_invoice": true, "document_type": "<what it looks like>"}.

Return ONLY valid JSON, no markdown, no backticks, no explanation, in this exact shape:
{
  "not_an_invoice": false,
  "vendor_name": "Precision Installs LLC",
  "invoice_number": "1042",
  "invoice_date": "2026-07-01",
  "total_amount": 1250.00,
  "lines": [
    { "vin": "1FTBW2CM5HKA12345", "part_number": "06N5TR", "description": "Graphics install", "amount": 125.00 }
  ],
  "notes": "Any observations about legibility or ambiguity"
}`;

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured.' }, { status: 500 });
  }

  const parsed = await validateBody(request, Schema);
  if (parsed.error) return parsed.error;
  const { fileBase64, mediaType } = parsed.data;

  const isPDF = mediaType === 'application/pdf';
  const fileContent = isPDF
    ? {
        type: 'document' as const,
        source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: fileBase64 },
      }
    : {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: (mediaType || 'image/jpeg') as 'image/jpeg', data: fileBase64 },
      };

  try {
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
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this installer invoice and extract the billing data:' },
              fileContent,
              { type: 'text', text: INVOICE_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Anthropic API error:', response.status, errorBody);
      return NextResponse.json({ error: `AI API error: ${response.status}` }, { status: 500 });
    }

    const result = await response.json();
    const aiText = result.content?.[0]?.text || '';

    let data: any;
    try {
      const cleanText = aiText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in AI response');
      data = JSON.parse(jsonMatch[0]);
    } catch {
      console.error('Failed to parse AI response:', aiText);
      return NextResponse.json(
        { error: `Failed to parse invoice response. Claude said: ${aiText.substring(0, 300)}` },
        { status: 500 },
      );
    }

    if (data.not_an_invoice) {
      return NextResponse.json(
        { error: `This doesn't look like an installer invoice${data.document_type ? ` (looks like: ${data.document_type})` : ''}. Enter the details manually if it is one.` },
        { status: 422 },
      );
    }

    return NextResponse.json({
      data: {
        vendor_name: data.vendor_name || null,
        invoice_number: data.invoice_number != null ? String(data.invoice_number) : null,
        invoice_date: data.invoice_date || null,
        total_amount: typeof data.total_amount === 'number' ? data.total_amount : null,
        lines: (Array.isArray(data.lines) ? data.lines : [])
          .filter((l: any) => l && l.vin)
          .map((l: any) => ({
            vin: String(l.vin).toUpperCase().replace(/[^A-Z0-9]/g, ''),
            part_number: l.part_number ? String(l.part_number) : null,
            description: l.description ? String(l.description) : null,
            amount: typeof l.amount === 'number' ? l.amount : null,
          })),
        notes: data.notes || null,
      },
    });
  } catch (error: any) {
    console.error('Vendor invoice extract error:', error);
    return NextResponse.json({ error: error.message || 'Extraction failed' }, { status: 500 });
  }
}
